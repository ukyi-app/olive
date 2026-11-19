// 장부의 사본 만들기와, 사본에서 뜬 장부의 보류.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Ledger, openLedger, type OpenResult, type RestorePorts, Restorer, RestoreStepError, SNAPSHOT_STALE_RECORDS, type SnapshotResult } from "../../src/ledger/index.ts";
import { clock, digest, grant, id, must, NOW, open, ready, session, startedWorker, tempDir, tempPath, worker } from "./helpers.ts";

const MAX = 10_000_000;
const PEERS = ["front-door"];

const ports: RestorePorts = {
  stopAuthority: { latestStop: async () => null },
  // PEERS는 현관 하나다. 현관은 v2와 맞은 정책으로 답해야 맞은 응답이다.
  peers: { contracts: async () => PEERS.map((peer) => ({ peer, contract: "olive-control/v2", policy: "match" as const })) },
  occupancy: { occupancy: async () => [] },
  publications: { lookup: async () => ({ kind: "pending" as const }) },
};

async function restore(ledger: Ledger) {
  const restorer = new Restorer(ledger, ports, clock, { requiredPeers: PEERS });
  await restorer.step1();
  await restorer.step2();
  await restorer.step3();
  await restorer.step4();
  return { restorer, s5: await restorer.step5() };
}

function taken(result: SnapshotResult): Extract<SnapshotResult, { ok: true }> {
  if (!result.ok) throw new Error(`사본 실패: ${result.reason} ${result.detail}`);
  return result;
}

function opened(result: OpenResult): Ledger {
  if (!result.ok) throw new Error(`열지 못함: ${result.reason} ${result.detail}`);
  return result.ledger;
}

// 원본을 닫고 사본 파일을 장부로 연다.
function fromSnapshot(prepare: (ledger: Ledger) => void = () => {}) {
  const dir = tempDir();
  const original = join(dir, "ledger.db");
  const copy = join(dir, "copy.db");
  const ledger = ready(open(original));
  prepare(ledger);
  const snapshot = taken(ledger.createSnapshot({ path: copy, maxBytes: MAX }));
  ledger.close();
  return { copy, snapshot, ledger: opened(openLedger(copy, { clock, mode: "reopen" })) };
}

function writeFromChild(path: string): string {
  const script = `
    import { Database } from "bun:sqlite";
    try {
      const db = new Database(${JSON.stringify(path)});
      db.run("PRAGMA busy_timeout = 0");
      db.run("BEGIN IMMEDIATE");
      db.run("CREATE TABLE intruder (x INTEGER)");
      db.run("COMMIT");
      console.log("WROTE");
    } catch (error) {
      console.log(error.code);
    }
  `;
  return Bun.spawnSync([process.execPath, "-e", script]).stdout.toString().trim();
}

// 살아 있는 장부의 본체만 다른 프로세스에서 읽는다(이 프로세스가 그 파일의 FD를 닫으면 잠금이 풀린다).
function mainFileStopRows(path: string): number {
  const script = `
    import { constants, Database } from "bun:sqlite";
    const view = new Database(${JSON.stringify(`file:${path}?immutable=1`)}, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
    console.log(view.query("SELECT COUNT(*) AS n FROM stop_state").get().n);
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script]);
  if (child.exitCode !== 0) throw new Error(`본체를 읽지 못함: ${child.stderr.toString()}`);
  return Number(child.stdout.toString().trim());
}

function quickCheck(path: string): unknown {
  const raw = new Database(path, { readonly: true });
  const rows = raw.query("PRAGMA quick_check").all();
  raw.close();
  return rows;
}

test("snapshot: 쓰기 도중 만든 사본이 열리고 무결성 검사를 통과한다", async () => {
  const dir = tempDir();
  let inFlight: SnapshotResult | undefined;
  const midTarget = join(dir, "mid.db");
  let ledger: Ledger;
  const faults = {
    at(point: string) {
      // 고정 장벽: 3세대를 적는 트랜잭션이 커밋되기 직전이다.
      if (point === "stop:before_commit" && inFlight === undefined && generation === 3) inFlight = ledger.createSnapshot({ path: midTarget, maxBytes: MAX });
    },
  };
  let generation = 0;
  ledger = open(join(dir, "ledger.db"), { faults });

  // 쓰는 쪽은 정해진 커밋 뒤의 장벽에서 멈춘다. 시험이 그 사이에 사본을 만든다.
  const barrier = () => {
    let open: () => void = () => {};
    const wait = new Promise<void>((resolve) => (open = resolve));
    return { wait, open };
  };
  const [atTwo, resumeTwo, atFour, resumeFour] = [barrier(), barrier(), barrier(), barrier()];
  const writer = (async () => {
    for (generation = 1; generation <= 5; generation++) {
      must(ledger.applyStop({ generation, stopped: false, now: NOW }));
      if (generation === 2) {
        atTwo.open();
        await resumeTwo.wait;
      }
      if (generation === 4) {
        atFour.open();
        await resumeFour.wait;
      }
    }
  })();

  const snapshots = [
    { path: join(dir, "first.db"), generation: 2 },
    { path: join(dir, "second.db"), generation: 4 },
  ];
  await atTwo.wait;
  taken(ledger.createSnapshot({ path: (snapshots[0] as { path: string }).path, maxBytes: MAX }));
  resumeTwo.open();
  await atFour.wait;
  taken(ledger.createSnapshot({ path: (snapshots[1] as { path: string }).path, maxBytes: MAX }));
  resumeFour.open();
  await writer;

  // 커밋 직전의 트랜잭션 안에서는 만들지 않고 파일도 남기지 않는다.
  expect(inFlight).toMatchObject({ ok: false, reason: "in_transaction" });
  expect(existsSync(midTarget)).toBe(false);
  expect(ledger.readStop()).toMatchObject({ value: { generation: 5 } });
  for (const snapshot of snapshots) {
    expect(quickCheck(snapshot.path), snapshot.path).toEqual([{ quick_check: "ok" }]);
    const copy = opened(openLedger(snapshot.path, { clock, mode: "reopen" }));
    expect(copy.readStop(), snapshot.path).toMatchObject({ known: true, value: { generation: snapshot.generation } });
    copy.close();
  }
});

test("snapshot: 사본에는 커밋된 것만 있고 WAL에만 있던 커밋도 들어 있다", () => {
  const dir = tempDir();
  const path = join(dir, "ledger.db");
  let conn: Database | undefined;
  const ledger = open(path, { faults: { at() {}, onOpen: (db) => (conn = db) } });
  must(ledger.applyStop({ generation: 7, stopped: true, now: NOW }));
  // 이 커밋은 아직 WAL에만 있다.
  expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
  expect(mainFileStopRows(path)).toBe(0);

  const raw = conn as unknown as Database;
  raw.run("BEGIN IMMEDIATE");
  raw.run("INSERT INTO diagnosis_pause (id, until_at) VALUES (1, 123)");
  expect(ledger.createSnapshot({ path: join(dir, "open.db"), maxBytes: MAX })).toMatchObject({ ok: false, reason: "in_transaction" });
  raw.run("ROLLBACK");

  const target = join(dir, "copy.db");
  const snapshot = taken(ledger.createSnapshot({ path: target, maxBytes: MAX }));
  expect(snapshot.bytes).toBe(statSync(target).size);
  expect(snapshot.sha256).toBe(new Bun.CryptoHasher("sha256").update(readFileSync(target)).digest("hex"));
  expect(snapshot.blockedMs).toBeGreaterThanOrEqual(0);
  const copy = new Database(target, { readonly: true });
  expect(copy.query("SELECT generation, stopped FROM stop_state").all()).toEqual([{ generation: 7, stopped: 1 }]);
  expect(copy.query("SELECT COUNT(*) AS n FROM diagnosis_pause").get()).toEqual({ n: 0 });
  expect(copy.query("SELECT snapshot_id, ledger_id, taken_at, reconciled_at FROM ledger_snapshots").all()).toEqual([
    { snapshot_id: snapshot.snapshotId, ledger_id: snapshot.ledgerId, taken_at: NOW, reconciled_at: null },
  ]);
  copy.close();
});

test("snapshot: 사본을 만드는 동안과 만든 뒤에도 둘째 작성자는 거절된다", () => {
  const dir = tempDir();
  const path = join(dir, "ledger.db");
  const during: Record<string, string> = {};
  const faults = {
    at(point: string) {
      if (point === "snapshot:serialized" || point === "snapshot:written") during[point] = writeFromChild(path);
    },
  };
  const ledger = open(path, { faults });
  must(ledger.applyStop({ generation: 1, stopped: false, now: NOW }));
  taken(ledger.createSnapshot({ path: join(dir, "copy.db"), maxBytes: MAX }));
  expect(during).toEqual({ "snapshot:serialized": "SQLITE_BUSY", "snapshot:written": "SQLITE_BUSY" });
  expect(writeFromChild(path)).toBe("SQLITE_BUSY");
  expect(ledger.health()).toEqual({ writable: true });
  must(ledger.applyStop({ generation: 2, stopped: false, now: NOW }));
});

test("snapshot: 이미 있는 파일·링크·장부 자신의 경로에는 쓰지 않는다", () => {
  const dir = tempDir();
  const path = join(dir, "ledger.db");
  const ledger = open(path);
  must(ledger.applyStop({ generation: 1, stopped: false, now: NOW }));

  const existing = join(dir, "existing.db");
  writeFileSync(existing, "keep");
  const empty = join(dir, "empty.db");
  writeFileSync(empty, "");
  const dangling = join(dir, "dangling.db");
  const danglingTarget = join(dir, "dangling-target.db");
  symlinkSync(danglingTarget, dangling);
  const linkToFile = join(dir, "link.db");
  symlinkSync(existing, linkToFile);
  const sidecarTaken = join(dir, "sidecar.db");
  writeFileSync(`${sidecarTaken}-journal`, "old");
  const realDir = join(dir, "real");
  mkdirSync(realDir);
  const linkedDir = join(dir, "linked");
  symlinkSync(realDir, linkedDir);

  for (const [target, reason] of [
    [existing, "target_exists"],
    [empty, "target_exists"],
    [dangling, "target_exists"],
    [linkToFile, "target_exists"],
    [sidecarTaken, "target_exists"],
    [path, "target_refused"],
    [`${path}-wal`, "target_refused"],
    [`${path}-shm`, "target_refused"],
    [`${path}-journal`, "target_refused"],
    [join(dir, "..", dir.split("/").at(-1) as string, "ledger.db"), "target_refused"],
    [join(linkedDir, "copy.db"), "target_refused"],
    [join(dir, "missing", "copy.db"), "target_refused"],
  ] as const) {
    expect(ledger.createSnapshot({ path: target, maxBytes: MAX }), target).toMatchObject({ ok: false, reason });
  }
  expect(readFileSync(existing, "utf8")).toBe("keep");
  expect(readFileSync(empty, "utf8")).toBe("");
  expect(existsSync(danglingTarget)).toBe(false);
  expect(readdirSync(realDir)).toEqual([]);
  expect(existsSync(`${path}-shm`)).toBe(false);
  expect(existsSync(`${path}-journal`)).toBe(false);
  expect(readdirSync(dir).filter((name) => name.includes(".partial-"))).toEqual([]);

  // 상한을 넘는 장부는 만들지 않는다.
  const large = join(dir, "large.db");
  expect(ledger.createSnapshot({ path: large, maxBytes: 4096 })).toMatchObject({ ok: false, reason: "too_large" });
  expect(existsSync(large)).toBe(false);
  expect(ledger.health()).toEqual({ writable: true });
  must(ledger.applyStop({ generation: 2, stopped: false, now: NOW }));
});

test("snapshot: 끊긴 사본은 열리지 않는다", async () => {
  const dir = tempDir();
  const ledger = open(join(dir, "ledger.db"));
  const whole = join(dir, "whole.db");
  taken(ledger.createSnapshot({ path: whole, maxBytes: MAX }));
  ledger.close();
  const bytes = readFileSync(whole);
  const page = 4096;
  expect(bytes.length).toBeGreaterThan(page * 4);
  for (const size of [bytes.length - 1, bytes.length - page, bytes.length - page + 1, Math.floor(bytes.length / 2), page, 512, 100, 99]) {
    const cut = join(dir, `cut-${size}.db`);
    writeFileSync(cut, bytes.subarray(0, size));
    expect(openLedger(cut, { clock, mode: "reopen" }), String(size)).toMatchObject({ ok: false, reason: "corrupt" });
  }

  // 쓰는 도중에 프로세스가 끊기면 최종 이름은 생기지 않고 임시 이름의 끊긴 파일만 남는다.
  const crashDir = tempDir();
  const target = join(crashDir, "copy.db");
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "snapshot-child.ts"), join(crashDir, "ledger.db"), target, "snapshot:writing"], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  if (!text.startsWith("READY")) {
    child.kill("SIGKILL");
    throw new Error(`자식이 멈춘 지점에 닿지 않음: ${text} ${await new Response(child.stderr).text()}`);
  }
  child.kill("SIGKILL");
  await child.exited;
  expect(existsSync(target)).toBe(false);
  const partials = readdirSync(crashDir).filter((name) => name.includes(".partial-"));
  expect(partials).toHaveLength(1);
  const moved = join(crashDir, "moved.db");
  renameSync(join(crashDir, partials[0] as string), moved);
  expect(statSync(moved).size).toBe(64 * 1024);
  expect(openLedger(moved, { clock, mode: "reopen" })).toMatchObject({ ok: false, reason: "corrupt" });
});

test("snapshot: 쓰다 실패하면 최종 이름도 임시 파일도 남기지 않고 장부는 계속 쓴다", () => {
  const dir = tempDir();
  const target = join(dir, "copy.db");
  let fail = true;
  const faults = {
    at(point: string) {
      if (fail && point === "snapshot:written") throw new Error("주입한 쓰기 실패");
    },
  };
  const ledger = open(join(dir, "ledger.db"), { faults });
  expect(ledger.createSnapshot({ path: target, maxBytes: MAX })).toMatchObject({ ok: false, reason: "io" });
  expect(existsSync(target)).toBe(false);
  expect(readdirSync(dir).filter((name) => name.includes(".partial-"))).toEqual([]);
  expect(ledger.health()).toEqual({ writable: true });
  fail = false;
  taken(ledger.createSnapshot({ path: target, maxBytes: MAX }));
});

test("restore: 사본 기록이 깨졌거나 다른 장부를 가리키면 열지 않는다", () => {
  const otherLedger = () => {
    const { copy, ledger } = fromSnapshot();
    ledger.close();
    const raw = new Database(copy);
    raw.run("UPDATE ledger_identity SET ledger_id = '22222222-2222-4222-8222-222222222222'");
    raw.close();
    return copy;
  };
  expect(openLedger(otherLedger(), { clock, mode: "reopen" })).toMatchObject({ ok: false, reason: "corrupt", detail: expect.stringContaining("다른 장부") });

  const brokenRecord = () => {
    const { copy, ledger } = fromSnapshot();
    ledger.close();
    const raw = new Database(copy);
    const trigger = (raw.query("SELECT sql FROM sqlite_master WHERE name = 'ledger_snapshots_reconcile_only'").get() as { sql: string }).sql;
    raw.run("DROP TRIGGER ledger_snapshots_reconcile_only");
    raw.run("UPDATE ledger_snapshots SET snapshot_id = 'broken'");
    raw.run(trigger);
    raw.close();
    return copy;
  };
  expect(openLedger(brokenRecord(), { clock, mode: "reopen" })).toMatchObject({ ok: false, reason: "corrupt", detail: expect.stringContaining("깨졌다") });

  // 트리거나 표를 지운 파일은 스키마가 달라 열지 않는다.
  for (const change of ["DROP TRIGGER ledger_snapshots_permanent", "DROP TABLE ledger_snapshots"]) {
    const { copy, ledger } = fromSnapshot();
    ledger.close();
    const raw = new Database(copy);
    raw.run(change);
    raw.close();
    expect(openLedger(copy, { clock, mode: "reopen" }), change).toMatchObject({ ok: false, reason: "not_initialized" });
  }
});

test("restore: 처음 여는 사본 곁에 다른 시점의 곁 파일이 남아 있으면 열지 않는다", () => {
  const dir = tempDir();
  const ledger = open(join(dir, "ledger.db"));
  const target = join(dir, "copy.db");
  taken(ledger.createSnapshot({ path: target, maxBytes: MAX }));
  ledger.close();
  const before = readFileSync(target);
  // 저널 하나만 남은 경우는 이 사본의 첫 열기가 끊겼을 수 있어 사유를 가른다. 받지 않는 것은 같다.
  for (const [suffix, reason] of [
    ["-wal", "not_initialized"],
    ["-journal", "interrupted_install"],
  ] as const) {
    writeFileSync(`${target}${suffix}`, "stale");
    expect(openLedger(target, { clock, mode: "reopen" }), suffix).toMatchObject({ ok: false, reason, detail: expect.stringContaining("다른 시점") });
    expect(readFileSync(target).equals(before), suffix).toBe(true);
    expect(readFileSync(`${target}${suffix}`, "utf8"), suffix).toBe("stale");
    rmSync(`${target}${suffix}`);
  }
  const copy = opened(openLedger(target, { clock, mode: "reopen" }));
  expect(copy.snapshotOrigin()).toMatchObject({ known: true, value: { held: true } });
  copy.close();
  // 한 번 연 뒤에는 표식이 없어 평소의 재시작이다.
  opened(openLedger(target, { clock, mode: "reopen" })).close();
});

test("restore: 사본에서 뜬 장부는 새 실행 0건, 관리자 대조 전 보류 상태를 낸다", async () => {
  let queuedRun = "";
  let liveRun = "";
  const { ledger, snapshot } = fromSnapshot((source) => {
    liveRun = startedWorker(source).runId;
    must(source.markLost(NOW));
    queuedRun = must(source.admitRun(worker())).run.runId;
  });
  const hold = { ok: false, reason: "snapshot_hold" } as const;
  expect(ledger.enqueueInput({ requestId: id(), source: "discord", sourceRef: { ref: `inputs/${id()}`, expiresAt: NOW + 1_000 }, receivedAt: NOW })).toEqual(hold);
  expect(ledger.admitRun(worker())).toEqual(hold);
  expect(ledger.startRun({ runId: queuedRun, requestId: id(), stopGeneration: 0, now: NOW })).toEqual(hold);
  expect(
    ledger.startSession({
      runId: queuedRun,
      requestId: id(),
      stopGeneration: 0,
      now: NOW,
      sessionId: id(),
      generationMarkerDigest: digest("marker"),
      takeoverReceiptId: null,
      ruleCheckId: id(),
      handoffRef: null,
      handoffDigest: null,
    }),
  ).toEqual(hold);
  expect(ledger.recordPublication({ frontJobId: "job-1", candidateDigest: digest("candidate"), runId: null, now: NOW })).toEqual(hold);
  expect(ledger.recordRenewInstruction({ runId: liveRun, requestId: id(), stopGeneration: 0, now: NOW })).toEqual(hold);

  const { restorer, s5 } = await restore(ledger);
  expect(s5.intakeMayOpen).toBe(false);
  expect(s5.closedBecause).toEqual(["snapshot_hold"]);
  expect(s5.snapshotOrigin).toMatchObject({ snapshotId: snapshot.snapshotId, held: true, takenAt: NOW, reconciledAt: null });
  expect(restorer.intakeOpen()).toBe(false);
  expect(ledger.intakeOpen()).toBe(false);
  // 복원을 건너뛴 허가도 나지 않는다.
  expect(grant(ledger)).toBe(false);
  expect(ledger.getRun(queuedRun)).toMatchObject({ value: { state: "queued" } });
  expect((ledger.listRuns() as { value: unknown[] }).value).toHaveLength(2);
});

test("restore: 계정 잠금·영수증이 옛 시점임을 표시한다", async () => {
  const { ledger, snapshot } = fromSnapshot();
  const expected = { snapshotId: snapshot.snapshotId, ledgerId: snapshot.ledgerId, takenAt: NOW, reconciledAt: null, held: true, mayBeStale: SNAPSHOT_STALE_RECORDS };
  expect(SNAPSHOT_STALE_RECORDS).toEqual(["account_locks", "receipts"]);
  expect(ledger.snapshotOrigin()).toEqual({ known: true, value: expected });
  expect((await restore(ledger)).s5.snapshotOrigin).toEqual(expected);
});

test("restore: 보류는 재시작·새 복원 시도·정지 풀기로 풀리지 않는다", async () => {
  const fixture = fromSnapshot();
  let ledger = fixture.ledger;
  const stillHeld = async () => {
    expect((await restore(ledger)).s5).toMatchObject({ intakeMayOpen: false, closedBecause: ["snapshot_hold"] });
    expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "snapshot_hold" });
    expect(ledger.snapshotOrigin()).toMatchObject({ value: { held: true } });
  };
  await stillHeld();
  // 새 복원 시도
  await stillHeld();
  // 정지와 풀기
  must(ledger.applyStop({ generation: 1, stopped: true, now: NOW }));
  must(ledger.releaseStop({ generation: 1, now: NOW }));
  await stillHeld();
  // 접수를 닫고 다시 열려는 시도: 복원을 건너뛴 허가도 나지 않는다.
  must(ledger.setPause(NOW + 1_000));
  must(ledger.setPause(null));
  expect(grant(ledger)).toBe(false);
  expect(ledger.intakeOpen()).toBe(false);
  await stillHeld();
  // 재시작
  ledger.close();
  ledger = opened(openLedger(fixture.copy, { clock, mode: "reopen" }));
  await stillHeld();
  ledger.close();
});

test("restore: 사본에서도 정지는 걸린다", () => {
  let run = "";
  let request = "";
  let sender = { sender: "", runGeneration: 0 };
  const { ledger } = fromSnapshot((source) => {
    const started = startedWorker(source);
    run = started.runId;
    request = started.requestId;
    sender = started.from;
  });
  expect(ledger.applyStop({ generation: 3, stopped: true, phase: "accepted", now: NOW })).toMatchObject({ ok: true, record: { generation: 3, stopped: true } });
  expect(ledger.readStop()).toMatchObject({ value: { generation: 3, stopped: true } });
  // 진행 중인 것을 닫는 기록도 막지 않는다.
  expect(ledger.recordStopInstruction({ runId: run, requestId: id(), action: "task_cancel", stopGeneration: 3, now: NOW })).toMatchObject({ ok: true, run: { state: "stopping" } });
  expect(ledger.applyReceipt({ action: "receipt_accepted", receiptId: id(), runId: run, instructionRequestId: request, instruction: "task_start", bodyDigest: digest("accepted"), now: NOW }, sender)).toMatchObject({ ok: true, delivery: "new" });
  expect(ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: run, exit: "cancelled", bodyDigest: digest("stopped"), now: NOW }, sender)).toMatchObject({ ok: true, delivery: "new" });
  expect(ledger.getRun(run)).toMatchObject({ value: { state: "failed_stopped" } });
  expect(ledger.markLost(NOW)).toMatchObject({ ok: true });
  expect(ledger.snapshotOrigin()).toMatchObject({ value: { held: true } });
});

test("restore: 대조 끝 연산 하나만 보류를 풀고, 풀어도 새 복원이 끝나야 접수가 열린다", async () => {
  const { copy, ledger, snapshot } = fromSnapshot();
  // 앞서 시작한 복원 시도는 대조 끝 뒤에도 허가를 내지 못한다.
  const earlier = new Restorer(ledger, ports, clock, { requiredPeers: PEERS });
  await earlier.step1();
  await earlier.step2();
  await earlier.step3();
  await earlier.step4();

  expect(ledger.confirmSnapshotReconciled({ snapshotId: id(), now: NOW + 1 })).toEqual({ ok: false, reason: "reference_mismatch" });
  expect(ledger.snapshotOrigin()).toMatchObject({ value: { held: true } });

  const done = must(ledger.confirmSnapshotReconciled({ snapshotId: snapshot.snapshotId, now: NOW + 5 }));
  expect(done.origin).toMatchObject({ snapshotId: snapshot.snapshotId, held: false, takenAt: NOW, reconciledAt: NOW + 5 });
  expect(ledger.confirmSnapshotReconciled({ snapshotId: snapshot.snapshotId, now: NOW + 6 })).toEqual({ ok: false, reason: "reference_mismatch" });

  // 풀렸어도 허가가 없으면 닫혀 있다.
  expect(ledger.intakeOpen()).toBe(false);
  expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "intake_closed" });
  await expect(earlier.step5()).rejects.toBeInstanceOf(RestoreStepError);
  expect(earlier.intakeOpen()).toBe(false);
  expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "intake_closed" });

  const fresh = await restore(ledger);
  expect(fresh.s5).toMatchObject({ intakeMayOpen: true, closedBecause: [], snapshotOrigin: { held: false, reconciledAt: NOW + 5 } });
  expect(fresh.restorer.intakeOpen()).toBe(true);
  must(ledger.admitRun(worker()));
  ledger.close();

  // 재시작해도 풀린 채이고, 사본에서 떴다는 사실은 남는다.
  const again = opened(openLedger(copy, { clock, mode: "reopen" }));
  expect(again.snapshotOrigin()).toMatchObject({ value: { snapshotId: snapshot.snapshotId, held: false, reconciledAt: NOW + 5 } });
  expect((await restore(again)).s5.intakeMayOpen).toBe(true);
  again.close();
});

test("restore: 사본 기록을 다른 쓰기로 지우거나 바꿀 수 없다", () => {
  const { copy, ledger, snapshot } = fromSnapshot();
  ledger.close();
  const raw = new Database(copy);
  const fixed = "ledger_snapshot_fixed";
  const insert = "INSERT INTO ledger_snapshots (seq, snapshot_id, ledger_id, taken_at) VALUES (?, ?, ?, ?)";
  const row = () => raw.query("SELECT * FROM ledger_snapshots").all();
  const before = row();
  expect(before).toHaveLength(1);
  for (const write of [
    () => raw.run("DELETE FROM ledger_snapshots"),
    () => raw.run("UPDATE ledger_snapshots SET reconciled_at = 5"),
    () => raw.run("UPDATE ledger_snapshots SET reconciled_snapshot_id = snapshot_id"),
    () => raw.run("UPDATE ledger_snapshots SET taken_at = 5"),
    () => raw.run("UPDATE ledger_snapshots SET ledger_id = 'other'"),
    () => raw.run("UPDATE ledger_snapshots SET snapshot_id = 'other'"),
    () => raw.run("UPDATE ledger_snapshots SET seq = 9"),
    () => raw.run("UPDATE OR REPLACE ledger_snapshots SET taken_at = 5"),
    () => raw.query(insert).run(2, id(), snapshot.ledgerId, NOW),
    () => raw.query(`INSERT OR REPLACE ${insert.slice("INSERT ".length)}`).run(1, id(), snapshot.ledgerId, NOW),
    () => raw.query(`INSERT OR REPLACE ${insert.slice("INSERT ".length)}`).run(2, snapshot.snapshotId, snapshot.ledgerId, NOW),
    () => raw.query("INSERT INTO ledger_snapshots (seq, snapshot_id, ledger_id, taken_at, reconciled_at, reconciled_snapshot_id) VALUES (2, ?, ?, 1, 1, ?)").run("x", snapshot.ledgerId, "x"),
  ]) {
    expect(write).toThrow(fixed);
  }
  expect(row()).toEqual(before);
  raw.close();

  // 대조가 끝난 기록은 되돌리거나 다시 바꿀 수 없다.
  const reopened = opened(openLedger(copy, { clock, mode: "reopen" }));
  must(reopened.confirmSnapshotReconciled({ snapshotId: snapshot.snapshotId, now: NOW + 1 }));
  reopened.close();
  const after = new Database(copy);
  for (const write of [
    () => after.run("UPDATE ledger_snapshots SET reconciled_at = NULL, reconciled_snapshot_id = NULL"),
    () => after.run("UPDATE ledger_snapshots SET reconciled_at = 9"),
    () => after.run("DELETE FROM ledger_snapshots"),
  ]) {
    expect(write).toThrow(fixed);
  }
  after.close();
});

test("restore: 원본 장부는 사본을 만든 뒤에도 보류가 아니다", async () => {
  const dir = tempDir();
  const path = join(dir, "ledger.db");
  let ledger = ready(open(path));
  taken(ledger.createSnapshot({ path: join(dir, "copy.db"), maxBytes: MAX }));
  expect(ledger.snapshotOrigin()).toEqual({ known: true, value: null });
  must(ledger.admitRun(worker()));
  ledger.close();

  const raw = new Database(path, { readonly: true });
  expect(raw.query("SELECT COUNT(*) AS n FROM ledger_snapshots").get()).toEqual({ n: 0 });
  raw.close();
  ledger = opened(openLedger(path, { clock, mode: "reopen" }));
  expect(ledger.snapshotOrigin()).toEqual({ known: true, value: null });
  const { s5 } = await restore(ledger);
  expect(s5).toMatchObject({ intakeMayOpen: true, closedBecause: [], snapshotOrigin: null });
  must(ledger.admitRun(session()));
  ledger.close();
});

test("snapshot: 대조가 끝나지 않은 장부의 사본은 만들지 않고, 대조가 끝난 장부의 사본은 새로 보류된다", () => {
  const dir = tempDir();
  const { ledger, snapshot } = fromSnapshot();
  const blocked = join(dir, "blocked.db");
  expect(ledger.createSnapshot({ path: blocked, maxBytes: MAX })).toMatchObject({ ok: false, reason: "snapshot_hold" });
  expect(existsSync(blocked)).toBe(false);
  must(ledger.confirmSnapshotReconciled({ snapshotId: snapshot.snapshotId, now: NOW + 1 }));
  const next = join(dir, "next.db");
  const second = taken(ledger.createSnapshot({ path: next, maxBytes: MAX }));
  ledger.close();
  const copy = opened(openLedger(next, { clock, mode: "reopen" }));
  expect(copy.snapshotOrigin()).toMatchObject({ value: { snapshotId: second.snapshotId, held: true, reconciledAt: null } });
  expect(copy.admitRun(worker())).toEqual({ ok: false, reason: "snapshot_hold" });
  copy.close();
});
