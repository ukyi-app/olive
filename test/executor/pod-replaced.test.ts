// 파드 교체로 맺는 정리(O13-b, D-146·D-155): 정리 의도에 그 의도를 처음 적은 파드의 UID를 남기고, 지금 파드의 UID와 다르면
// 대리에 묻지 않고 정리 영수증을 낸다. 영수증은 감독의 확정(재전송)이 부르는 정리 자리에서만 나고, 처음 적기 직전의 권한 재확인을 지난다.
// 같은 폴더를 새 저장소·다른 파드 UID로 다시 여는 것으로 파드 교체를, 같은 UID로 다시 여는 것으로 같은 파드의 재시작을 흉내 낸다.
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentMessage, ControlDecoder, encodeAgent, type ReceivedControl } from "../../src/agent/link.ts";
import type { AgentLinkSession, RemoteAgent } from "../../src/executor/remote-agent.ts";
import { type CleanupIntent, ExecutorStore, type StoreError } from "../../src/executor/store.ts";
import { FakeTransport, fromSupervisor, pause, POD_UID, type Rig, reconnect, rig, start, until } from "./support.ts";

// 교체 뒤 새 파드의 UID. rig의 기본(POD_UID)이 교체 전 파드다.
const POD_B = "7d1e4c2a-5b3f-4e8d-9a6c-2f0b8e4d1c57";

// 대리 자리(remote-clean.test.ts와 같은 꼴). 끝내기·세기에는 같은 호출 안에서 남은 0으로, clean에는 left로 답한다.
class CleanAgent {
  session: AgentLinkSession | null = null;
  readonly got: ReceivedControl[] = [];
  left: number | null = 0;
  private readonly decoder = new ControlDecoder();

  attach(remote: RemoteAgent): void {
    this.session = remote.connect({
      write: (bytes) => {
        for (const message of this.decoder.push(new Uint8Array(bytes))) this.handle(message);
      },
      close: () => {},
    });
    this.say({ type: "hello" });
  }

  private handle(message: ReceivedControl): void {
    if (message.type === "start") message.credential.discard();
    this.got.push(message);
    if (message.type === "terminate") this.say({ type: "terminated", seq: message.seq });
    if (message.type === "count") this.say({ type: "counted", seq: message.seq, survivors: 0 });
    if (message.type === "clean") this.say({ type: "cleaned", seq: message.seq, left: this.left });
  }

  say(message: AgentMessage): void {
    this.session?.receive(encodeAgent(message));
  }

  cleans(): ReceivedControl[] {
    return this.got.filter((message) => message.type === "clean");
  }
}

const rigs: Rig[] = [];
async function make(agent: CleanAgent, options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = await rig({ exitWaitMs: 100, ...options, remote: { ...options.remote, attach: (remote) => agent.attach(remote) } });
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) await Promise.race([r.worker.idle(), pause(1_000)]);
});

const result = new TextEncoder().encode(JSON.stringify({ role: "diagnosis", outcome: "completed", summary: "끝", items: [], refs: [] }));

// 감독의 확정. 같은 요청 ID·같은 본문을 새 봉투(새 nonce)에 담는다. 다시 연 rig에도 같은 실행기 이름으로 보낸다.
function finalizer(r: Rig, runId: string) {
  const requestId = crypto.randomUUID();
  const storedAt = r.clock.now();
  return (to: Rig = r, stopGeneration = 0) =>
    fromSupervisor(to.clock, to.worker.name, "result_finalize", { run_id: runId, outcome: "failed", result_digest: null, stored_at: storedAt }, {
      stop_generation: stopGeneration,
      run_generation: 1,
      request_id: requestId,
    });
}

const onDiskIntent = (dir: string, runId: string) => (JSON.parse(readFileSync(join(dir, "runs", `${runId}.json`), "utf8")) as { cleanup: CleanupIntent }).cleanup;

// 교체 전 파드(POD_UID)에서 띄우고 끝낸 실행이 확정을 받았지만, 대리가 남은 항목을 답해 영수증 없이 cleanup_pending으로 남았다.
async function pendingRun() {
  const agent = new CleanAgent();
  const r = await make(agent);
  const { runId } = await start(r);
  await until(() => agent.got.some((message) => message.type === "start"));
  agent.say({ type: "spawned", run_id: runId });
  agent.say({ type: "output", run_id: runId, data: Buffer.from(result).toString("base64") });
  agent.say({ type: "exited", run_id: runId, code: 0, signal: null, overflow: false, stdout_bytes: result.length });
  await r.worker.idle();
  expect(r.store.run(runId)?.state).toBe("ready_result");
  const finalize = finalizer(r, runId);
  agent.left = 2;
  await r.connection.receive(finalize());
  expect(agent.cleans()).toHaveLength(1);
  expect(r.store.run(runId)?.state).toBe("cleanup_pending");
  const intent = r.store.run(runId)!.cleanup!;
  return { r, runId, finalize, intent };
}

test("새 정리 의도는 그 의도를 적은 파드의 UID를 디스크에 남긴다", async () => {
  const { r, runId, intent } = await pendingRun();
  expect(intent.pod_uid).toBe(POD_UID);
  expect(onDiskIntent(r.dir, runId)).toEqual(intent);
});

test("파드 교체(O13-b): 다른 파드에서 적힌 의도의 확정 재전송은 대리에 묻지 않고 처음 의도의 영수증 ID로 receipt_cleaned를 내고 finalized다. 근거를 한 줄 남긴다", async () => {
  const { r, runId, finalize, intent } = await pendingRun();
  const agent = new CleanAgent();
  const logs: string[] = [];
  const again = await make(agent, { dir: r.dir, clock: r.clock, podUid: POD_B, log: (line) => logs.push(line) });
  await again.worker.recover();
  expect(again.store.run(runId)?.state).toBe("cleanup_pending");
  // 기동 때는 내지 않는다. 확정 재전송이 부르는 정리 자리에서만 낸다.
  expect(again.store.outboxFor(runId).filter((entry) => entry.action === "receipt_cleaned")).toHaveLength(0);
  await again.connection.receive(finalize(again));
  expect(again.store.run(runId)?.state).toBe("finalized");
  expect(agent.cleans()).toHaveLength(0);
  expect(again.space.cleaned).toEqual([]);
  expect(again.transport.of("receipt_cleaned").map((envelope) => envelope.body)).toMatchObject([
    { receipt_id: intent.receipt_id, run_id: runId, instruction_request_id: intent.request_id },
  ]);
  // 우편함은 영수증 전에 그 실행의 값을 비운다(D-153 셋째).
  expect(again.credentials.forgotten).toContain(runId);
  // 이어 쓴 의도는 바꾸지 않는다: 디스크의 파드 UID는 처음 적은 파드의 값이다.
  expect(onDiskIntent(again.dir, runId)).toEqual(intent);
  expect(logs).toHaveLength(1);
  for (const part of [runId, POD_UID, POD_B]) expect(logs[0]).toContain(part);
});

test("같은 파드에서 다시 뜬 기동(제어 재시작·전체 재시작은 UID가 같다)은 파드 교체가 아니다: 확정 재전송이 대리에게 clean을 묻고 그 답으로만 정한다", async () => {
  const { r, runId, finalize, intent } = await pendingRun();
  const agent = new CleanAgent();
  const logs: string[] = [];
  const again = await make(agent, { dir: r.dir, clock: r.clock, log: (line) => logs.push(line) });
  await again.worker.recover();
  agent.left = 1;
  await again.connection.receive(finalize(again));
  expect(agent.cleans()).toHaveLength(1);
  expect(again.store.run(runId)?.state).toBe("cleanup_pending");
  expect(again.transport.of("receipt_cleaned")).toHaveLength(0);
  agent.left = 0;
  await again.connection.receive(finalize(again));
  expect(agent.cleans()).toHaveLength(2);
  expect(again.store.run(runId)?.state).toBe("finalized");
  expect(again.transport.of("receipt_cleaned").map((envelope) => envelope.body)).toMatchObject([{ receipt_id: intent.receipt_id, run_id: runId }]);
  expect(logs).toEqual([]);
});

test("pod_uid가 없는 옛 판의 의도: 저장소는 그대로 읽고, 다른 파드에서 떠도 대리에 묻는다. 이어 쓰는 의도에 지금 UID를 더하지 않는다", async () => {
  const { r, runId, finalize, intent } = await pendingRun();
  // 이 칸을 쓰기 전의 판이 적은 실행 기록이다(정리 의도의 칸 셋).
  const path = join(r.dir, "runs", `${runId}.json`);
  const record = JSON.parse(readFileSync(path, "utf8")) as { cleanup: CleanupIntent };
  const old = { request_id: intent.request_id, instruction_digest: intent.instruction_digest, receipt_id: intent.receipt_id };
  writeFileSync(path, JSON.stringify({ ...record, cleanup: old }));
  const agent = new CleanAgent();
  const logs: string[] = [];
  const again = await make(agent, { dir: r.dir, clock: r.clock, podUid: POD_B, log: (line) => logs.push(line) });
  await again.worker.recover();
  expect(again.store.inconsistency()).toBeNull();
  expect(again.store.run(runId)?.cleanup).toEqual(old);
  agent.left = 1;
  await again.connection.receive(finalize(again));
  expect(agent.cleans()).toHaveLength(1);
  expect(again.store.run(runId)?.state).toBe("cleanup_pending");
  agent.left = 0;
  await again.connection.receive(finalize(again));
  expect(agent.cleans()).toHaveLength(2);
  expect(again.store.run(runId)?.state).toBe("finalized");
  expect(again.transport.of("receipt_cleaned").map((envelope) => envelope.body)).toMatchObject([{ receipt_id: intent.receipt_id, run_id: runId }]);
  expect(Object.keys(onDiskIntent(again.dir, runId)).sort()).toEqual(["instruction_digest", "receipt_id", "request_id"]);
  expect(logs).toEqual([]);
});

test("저장소: 정리 의도는 칸 셋(옛 판) 또는 pod_uid를 더한 넷만 읽는다. pod_uid가 소문자 UUID가 아니거나 칸이 더 있으면 store_corrupt다", async () => {
  const { r, runId, intent } = await pendingRun();
  const path = join(r.dir, "runs", `${runId}.json`);
  const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const opened = () => ExecutorStore.open(r.dir).then(
    () => "opened",
    (error: StoreError) => error.code,
  );
  const { pod_uid: _written, ...three } = intent;
  for (const cleanup of [
    { ...intent, pod_uid: POD_B.toUpperCase() },
    { ...intent, pod_uid: "executor-diagnosis-6d4f9c7b8-x2k9p" },
    { ...intent, pod_uid: null },
    { ...intent, extra: 1 },
    { ...three, extra: 1 },
  ]) {
    writeFileSync(path, JSON.stringify({ ...record, cleanup }));
    expect(await opened(), JSON.stringify(cleanup)).toBe("store_corrupt");
  }
  for (const cleanup of [three, { ...three, pod_uid: POD_B }]) {
    writeFileSync(path, JSON.stringify({ ...record, cleanup }));
    expect(await opened(), JSON.stringify(cleanup)).toBe("opened");
  }
});

test("파드 교체 길도 정리 영수증을 처음 적기 직전에 지금 연결·정지 세대를 다시 본다: 그 사이 바뀌면 적지 않고 의도·cleanup_pending을 두며, 지금 연결·세대의 재전송이 같은 ID로 낸다", async () => {
  const { r, runId, finalize, intent } = await pendingRun();
  const agent = new CleanAgent();
  const again = await make(agent, { dir: r.dir, clock: r.clock, podUid: POD_B });
  await again.worker.recover();
  const receipts = () => again.store.outboxFor(runId).filter((entry) => entry.action === "receipt_cleaned");
  const forget = again.credentials.forget.bind(again.credentials);
  // 연결: 판정 뒤 우편함을 비우는 자리(영수증 직전)에서 감독 연결이 바뀐다.
  again.credentials.forget = (id: string) => {
    forget(id);
    again.link.open(new FakeTransport());
  };
  await again.connection.receive(finalize(again));
  expect(again.credentials.forgotten).toContain(runId);
  expect(again.store.run(runId)?.state).toBe("cleanup_pending");
  expect(again.store.run(runId)?.cleanup).toEqual(intent);
  expect(receipts()).toHaveLength(0);
  // 정지 세대: 같은 자리에서 더 높은 세대를 받아들인다(메모리 울타리는 곧바로 올라간다).
  await reconnect(again, 0);
  again.credentials.forget = (id: string) => {
    forget(id);
    void again.store.adoptStopGeneration(1);
  };
  await again.connection.receive(finalize(again));
  expect(again.store.run(runId)?.state).toBe("cleanup_pending");
  expect(again.store.run(runId)?.cleanup).toEqual(intent);
  expect(receipts()).toHaveLength(0);
  // 지금 연결·세대의 확정 재전송이 같은 예약 ID로 낸다. 대리에는 끝내 묻지 않는다.
  again.credentials.forget = forget;
  await reconnect(again, 1);
  await again.connection.receive(finalize(again, 1));
  expect(again.store.run(runId)?.state).toBe("finalized");
  expect(receipts().map((entry) => entry.id)).toEqual([intent.receipt_id]);
  expect(agent.cleans()).toHaveLength(0);
});

test("물려받은 실행으로 원격을 처음부터 잠근 기동에서도 다른 파드에서 적힌 cleanup_pending은 풀린다. 같은 파드의 의도는 잠긴 원격에 묻지 못해 남는다", async () => {
  const replaced = await pendingRun();
  const lockedAgent = new CleanAgent();
  const other = await make(lockedAgent, { dir: replaced.r.dir, clock: replaced.r.clock, podUid: POD_B, remote: { inheritedUnverified: true } });
  expect(other.remote!.state().distrusted).toBe("inherited_unverified");
  await other.connection.receive(replaced.finalize(other));
  expect(other.store.run(replaced.runId)?.state).toBe("finalized");
  expect(other.transport.of("receipt_cleaned").map((envelope) => envelope.body)).toMatchObject([{ receipt_id: replaced.intent.receipt_id }]);
  expect(lockedAgent.got).toEqual([]);

  const kept = await pendingRun();
  const sameAgent = new CleanAgent();
  const same = await make(sameAgent, { dir: kept.r.dir, clock: kept.r.clock, remote: { inheritedUnverified: true } });
  await same.connection.receive(kept.finalize(same));
  expect(same.store.run(kept.runId)?.state).toBe("cleanup_pending");
  expect(same.transport.of("receipt_cleaned")).toHaveLength(0);
  expect(sameAgent.got).toEqual([]);
});
