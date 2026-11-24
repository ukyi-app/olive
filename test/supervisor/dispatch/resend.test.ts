import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, getRandomValues } from "node:crypto";
import { type Envelope, sealEnvelope } from "../../../src/contract/v1/index.ts";
import type { Ledger, StartDispatchInput, UnansweredInstructions } from "../../../src/ledger/index.ts";
import { type Drafted, type DraftAction, finalizeDraft, sealDraft, startDraft, stopDraft } from "../../../src/supervisor/dispatch/envelopes.ts";
import type { Random, SendOutcome, Signer } from "../../../src/supervisor/dispatch/ports.ts";
import { type ResendOutcome, type ResendPorts, type ResendTickResult, resendTick, START_LAST_SEAL_MS, type Withheld } from "../../../src/supervisor/dispatch/resend.ts";
import { digest, from, id, must, NOW, open, ready, startedWorker, tempPath, WORKER_EXECUTOR, worker } from "../../ledger/helpers.ts";

// 간격·키·digest는 이 시험이 지어 넣는 자료다. 운영값이 아니다.
const EVERY = 5_000;
const keys = generateKeyPairSync("ed25519");
const RESULT = digest("result bytes");

interface World {
  ledger: Ledger;
  ports: ResendPorts;
  // 서명·내보내기의 차례.
  log: string[];
  sent: Envelope[];
  setClock(at: number): void;
  setIntake(open: boolean): void;
  setLink(next: (executorId: string, action: string) => unknown): void;
  setSend(next: (envelope: Envelope) => Promise<SendOutcome>): void;
  setSigner(next: (() => void) | null): void;
  wrapRead(next: ((real: () => unknown) => unknown) | null): void;
  // 송신 표식 포트를 감싼다(real은 실제 장부의 markStartDispatch). 기본은 그대로 부른다.
  wrapMark(next: ((input: StartDispatchInput, real: () => unknown) => unknown) | null): void;
  // 장부 파일. 송신 표식(start_dispatches)을 원 SQL로 읽는다.
  path: string;
  // 장부의 끊김 지점(Faults.at)에 거는 고리.
  setLedgerFault(next: ((point: string) => void) | null): void;
}

function world(): World {
  let clockAt = NOW;
  let ledgerFault: ((point: string) => void) | null = null;
  const path = tempPath();
  // 장부 시계는 시작 지시의 발행 시각을 정한다. 시험의 박자 시계와 같은 값을 쓴다.
  const ledger = ready(open(path, { clock: () => clockAt, faults: { at: (point) => ledgerFault?.(point) } }));
  const log: string[] = [];
  const sent: Envelope[] = [];
  let intake = true;
  let link: (executorId: string, action: string) => unknown = () => ({ ok: true });
  let send: (envelope: Envelope) => Promise<SendOutcome> = async () => "sent";
  let signerHook: (() => void) | null = null;
  let readHook: ((real: () => unknown) => unknown) | null = null;
  let markHook: ((input: StartDispatchInput, real: () => unknown) => unknown) | null = null;
  const random: Random = { bytes: (length) => getRandomValues(new Uint8Array(length)) };
  const signer: Signer = {
    seal(input) {
      log.push("seal");
      signerHook?.();
      return sealEnvelope(input, keys.privateKey);
    },
  };
  const ports: ResendPorts = {
    ledger: {
      unansweredInstructions: (() => {
        const real = () => ledger.unansweredInstructions();
        return readHook === null ? real() : readHook(real);
      }) as never,
      markStartDispatch: ((input: StartDispatchInput) => {
        const real = () => ledger.markStartDispatch(input);
        return markHook === null ? real() : markHook(input, real);
      }) as never,
    },
    intake: { intakeOpen: () => intake },
    links: { mayIssue: (executorId, action) => link(executorId, action) as never },
    clock: { now: () => clockAt },
    random,
    signer,
    sink: {
      send: async (envelope) => {
        log.push("send");
        const outcome = await send(envelope);
        if (outcome === "sent") sent.push(envelope);
        return outcome;
      },
    },
  };
  return {
    ledger,
    ports,
    log,
    sent,
    setClock: (at) => {
      clockAt = at;
    },
    setIntake: (value) => {
      intake = value;
    },
    setLink: (next) => {
      link = next;
    },
    setSend: (next) => {
      send = next;
    },
    setSigner: (next) => {
      signerHook = next;
    },
    wrapRead: (next) => {
      readHook = next;
    },
    wrapMark: (next) => {
      markHook = next;
    },
    path,
    setLedgerFault: (next) => {
      ledgerFault = next;
    },
  };
}

const tick = (w: World, lastResends: { requestId: string; at: number }[] = [], every = EVERY) => resendTick(w.ports, { resendEveryMs: every }, { lastResends });

function ran(result: ResendTickResult): Extract<ResendTickResult, { kind: "ran" }> {
  if (result.kind !== "ran") throw new Error(`박자가 돌지 않음: ${JSON.stringify(result)}`);
  return result;
}

const outcomes = (result: ResendTickResult): readonly ResendOutcome[] => ran(result).instructions;

function unanswered(w: World): UnansweredInstructions {
  const read = w.ledger.unansweredInstructions();
  if (!read.known) throw new Error("답 없는 지시를 읽지 못함");
  return read.value;
}

// 실행 줄과 답을 기다리는 지시 줄. 송신 표식(start_dispatches)은 담지 않는다: 표식은 marks로 따로 센다.
function snapshot(w: World): unknown {
  const runs = w.ledger.listRuns();
  if (!runs.known) throw new Error("실행 목록을 읽지 못함");
  return { runs: runs.value, unanswered: unanswered(w) };
}

// 작업자 실행 하나를 NOW에 시작한다(시작 지시의 발행 시각 NOW). 배정·시작 박자처럼 그 답으로 처음 봉투를 NOW에 봉한다.
function started(w: World) {
  w.setClock(NOW);
  const run = must(w.ledger.admitRun(worker())).run;
  const requestId = id();
  const answer = must(w.ledger.startRun({ runId: run.runId, requestId, stopGeneration: 0, now: NOW }));
  const first = seal(startDraft({ run: answer.run, requestId, stopGeneration: 0, issuedAt: answer.issuedAt }), NOW);
  return { runId: run.runId, requestId, run: answer.run, from: from(run), first };
}
type Started = ReturnType<typeof started>;

function seal(drafted: Drafted<DraftAction>, at: number): Envelope {
  if (!drafted.ok) throw new Error(`초안 거절: ${JSON.stringify(drafted)}`);
  const result = sealDraft(drafted.draft, at, { random: { bytes: (n) => getRandomValues(new Uint8Array(n)) }, signer: { seal: (input) => sealEnvelope(input, keys.privateKey) } });
  if (!result.ok) throw new Error(`봉하기 거절: ${JSON.stringify(result)}`);
  return result.envelope;
}

function acceptStart(w: World, s: Started): void {
  must(
    w.ledger.applyReceipt(
      { action: "receipt_accepted", receiptId: id(), runId: s.runId, instructionRequestId: s.requestId, instruction: "task_start", bodyDigest: digest(`accepted:${s.runId}`), now: NOW },
      s.from,
    ),
  );
}

function acceptCancel(w: World, s: Started, requestId: string): void {
  must(
    w.ledger.applyReceipt({ action: "receipt_accepted", receiptId: id(), runId: s.runId, instructionRequestId: requestId, instruction: "task_cancel", bodyDigest: digest(`accepted:${requestId}`), now: NOW }, s.from),
  );
}

// 접수된 실행에 취소를 at에 적고, 수명 박자처럼 그 시각으로 처음 봉투를 봉한다.
function cancel(w: World, s: Started, at: number, reason: "deadline" | "requested" | null = "deadline") {
  const requestId = id();
  const body = reason === null ? {} : { reason };
  must(w.ledger.recordStopInstruction({ runId: s.runId, requestId, action: "task_cancel", stopGeneration: 0, now: at, ...body }));
  const first = reason === null ? null : seal(stopDraft({ action: "task_cancel", run: s.run, requestId, stopGeneration: 0, reason }), at);
  return { requestId, first };
}

// 같은 요청: 받는 쪽·동작·요청 ID·두 세대·본문 digest·본문이 같고 nonce는 새것이다.
function expectSameRequest(first: Envelope, again: Envelope): void {
  for (const field of ["recipient", "action", "request_id", "stop_generation", "run_generation", "body_digest"] as const) {
    expect(again.header[field], field).toBe(first.header[field]);
  }
  expect(again.body).toEqual(first.body);
  expect(again.header.nonce).not.toBe(first.header.nonce);
}

describe("보장 1: 같은 요청으로만 다시 낸다", () => {
  test("시작은 요청 ID·본문·세대·발행 시각·시한이 처음과 같고, 실행 줄과 답을 기다리는 지시 줄을 바꾸지 않는다(송신 표식 한 줄은 쓴다)", async () => {
    const w = world();
    const s = started(w);
    const before = snapshot(w);
    w.setClock(NOW + 6_000);
    expect(outcomes(await tick(w))).toEqual([{ requestId: s.requestId, runId: s.runId, action: "task_start", outcome: "resent", executorId: s.run.executorId, sealedAt: NOW + 6_000, at: NOW + 6_000 }]);
    expect(w.sent).toHaveLength(1);
    const again = w.sent[0] as Envelope;
    expectSameRequest(s.first, again);
    expect(again.header.issued_at).toBe(NOW);
    expect(again.header.expires_at).toBe(s.first.header.expires_at);
    expect(snapshot(w)).toEqual(before);
    expect(marks(w)).toEqual([{ run_id: s.runId, request_id: s.requestId, marked_at: NOW + 6_000 }]);
  });

  test("취소·확정은 같은 요청 ID·본문으로, 머리 시각만 봉한 때로 다시 낸다", async () => {
    const w = world();
    const s = started(w);
    acceptStart(w, s);
    const c = cancel(w, s, NOW + 3_000);
    w.setClock(NOW + 60_000);
    expect(outcomes(await tick(w))).toEqual([{ requestId: c.requestId, runId: s.runId, action: "task_cancel", outcome: "resent", executorId: s.run.executorId, sealedAt: NOW + 60_000, at: NOW + 60_000 }]);
    const resentCancel = w.sent[0] as Envelope;
    expectSameRequest(c.first as Envelope, resentCancel);
    expect(resentCancel.header.issued_at).toBe(NOW + 60_000);

    must(w.ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: s.runId, exit: "completed", bodyDigest: digest(`stopped:${s.runId}`), now: NOW }, s.from));
    must(w.ledger.markResult({ runId: s.runId, resultDigest: RESULT, now: NOW + 61_000 }));
    const finalize = id();
    const body = { outcome: "succeeded" as const, resultDigest: RESULT, storedAt: NOW + 60_900 };
    must(w.ledger.recordFinalizeInstruction({ runId: s.runId, requestId: finalize, stopGeneration: 0, now: NOW + 61_000, ...body }));
    const firstFinalize = seal(finalizeDraft({ run: s.run, requestId: finalize, stopGeneration: 0, ...body }), NOW + 61_000);
    const before = snapshot(w);
    w.setClock(NOW + 120_000);
    expect(outcomes(await tick(w))).toEqual([{ requestId: finalize, runId: s.runId, action: "result_finalize", outcome: "resent", executorId: s.run.executorId, sealedAt: NOW + 120_000, at: NOW + 120_000 }]);
    expectSameRequest(firstFinalize, w.sent[1] as Envelope);
    expect((w.sent[1] as Envelope).header.issued_at).toBe(NOW + 120_000);
    expect(snapshot(w)).toEqual(before);
  });

  test("본문을 다시 만들 수 없는 지시는 내보내지 않고 구별된 결과를 낸다", async () => {
    const w = world();
    const s = started(w);
    acceptStart(w, s);
    const c = cancel(w, s, NOW + 1_000, null);
    w.setClock(NOW + 60_000);
    expect(outcomes(await tick(w))).toEqual([{ requestId: c.requestId, runId: s.runId, action: "task_cancel", outcome: "not_rebuildable" }]);
    expect(w.log).toEqual([]);
  });

  test("싣기 직전에 다시 읽은 항목의 본문 칸이 처음과 다르면 내보내지 않는다", async () => {
    const w = world();
    const s = started(w);
    w.setClock(NOW + 6_000);
    type StartRebuild = { budgetLeft: number; credential: Record<string, string> };
    const changes: ((rebuild: StartRebuild) => StartRebuild)[] = [
      (rebuild) => ({ ...rebuild, budgetLeft: rebuild.budgetLeft - 1 }),
      (rebuild) => ({ ...rebuild, credential: { ...rebuild.credential, revision: `${rebuild.credential.revision}-other` } }),
    ];
    for (const change of changes) {
      let calls = 0;
      w.wrapRead((real) => {
        const answer = real() as { known: true; value: UnansweredInstructions };
        if (++calls === 1) return answer;
        const instructions = answer.value.instructions.map((item) => ({ ...item, rebuild: change(item.rebuild as unknown as StartRebuild) }));
        return { known: true, value: { ...answer.value, instructions } };
      });
      expect(outcomes(await tick(w))).toEqual([{ requestId: s.requestId, runId: s.runId, action: "task_start", outcome: "withheld", reason: "read_unknown" }]);
    }
    expect(w.log).toEqual([]);
  });
});

describe("보장 2: 보낼 수 없는 것은 보내지 않는다", () => {
  test("시작은 발행 + 19000ms까지만 봉하고, 그 뒤는 시한이 지난 시작이다", async () => {
    expect(START_LAST_SEAL_MS).toBe(19_000);
    const w = world();
    const s = started(w);
    w.setClock(NOW + START_LAST_SEAL_MS);
    expect(outcomes(await tick(w))[0]).toMatchObject({ outcome: "resent", sealedAt: NOW + 19_000 });
    expect((w.sent[0] as Envelope).header.issued_at).toBe(NOW);
    w.log.length = 0;
    w.setClock(NOW + START_LAST_SEAL_MS + 1);
    expect(outcomes(await tick(w, [], 1))).toEqual([{ requestId: s.requestId, runId: s.runId, action: "task_start", outcome: "start_expired", issuedAt: NOW, expiresAt: NOW + 30_000 }]);
    expect(w.log).toEqual([]);
  });

  test("시작은 연결 확인 중이나 서명 중에 한도가 지나면 내보내기 포트에 닿지 않는다", async () => {
    const w = world();
    const s = started(w);
    const expired: ResendOutcome[] = [{ requestId: s.requestId, runId: s.runId, action: "task_start", outcome: "start_expired", issuedAt: NOW, expiresAt: NOW + 30_000 }];
    const last = NOW + START_LAST_SEAL_MS;
    // 정각에 판단하고 연결 포트 안에서 1ms가 지난다.
    w.setClock(last);
    w.setLink(() => {
      w.setClock(last + 1);
      return { ok: true };
    });
    expect(outcomes(await tick(w))).toEqual(expired);
    expect(w.log).toEqual([]);
    // 정각에 판단하고 서명 포트 안에서 1ms가 지난다.
    w.setLink(() => ({ ok: true }));
    w.setClock(last);
    w.setSigner(() => w.setClock(last + 1));
    expect(outcomes(await tick(w))).toEqual(expired);
    expect(w.log).toEqual(["seal"]);
    // 다시 읽은 시각이 정각이면 나가고, 그 시각으로 봉한다.
    w.setSigner(null);
    w.log.length = 0;
    w.setClock(last - 1);
    w.setLink(() => {
      w.setClock(last);
      return { ok: true };
    });
    expect(outcomes(await tick(w))).toEqual([{ requestId: s.requestId, runId: s.runId, action: "task_start", outcome: "resent", executorId: s.run.executorId, sealedAt: last, at: last }]);
    expect(w.log).toEqual(["seal", "send"]);
    expect((w.sent[0] as Envelope).header.issued_at).toBe(NOW);
  });

  test("시작은 내보내기 포트의 send를 얻는 동안 한도가 지나도 포트에 닿지 않는다", async () => {
    const w = world();
    const s = started(w);
    const last = NOW + START_LAST_SEAL_MS;
    const real = w.ports.sink;
    // 정각에 판단·봉하고, 송신 함수를 돌려주는 접근자 안에서 1ms가 지난다.
    const ports = {
      ...w.ports,
      sink: {
        get send() {
          w.setClock(last + 1);
          return real.send;
        },
      },
    } as ResendPorts;
    w.setClock(last);
    expect(outcomes(await resendTick(ports, { resendEveryMs: EVERY }, { lastResends: [] }))).toEqual([
      { requestId: s.requestId, runId: s.runId, action: "task_start", outcome: "start_expired", issuedAt: NOW, expiresAt: NOW + 30_000 },
    ]);
    expect(w.log).toEqual(["seal"]);
    expect(w.sent).toEqual([]);
  });

  test("시작의 다시 읽은 시계를 읽지 못하면 내보내지 않는다", async () => {
    const w = world();
    const s = started(w);
    const lost: ResendOutcome[] = [{ requestId: s.requestId, runId: s.runId, action: "task_start", outcome: "withheld", reason: "clock_unavailable" }];
    w.setClock(NOW + 6_000);
    w.setLink(() => {
      w.setClock(NOW + 5_999);
      return { ok: true };
    });
    expect(outcomes(await tick(w))).toEqual(lost);
    expect(w.log).toEqual([]);
    w.setLink(() => ({ ok: true }));
    w.setClock(NOW + 6_000);
    w.setSigner(() => w.setClock(NOW + 5_999));
    expect(outcomes(await tick(w))).toEqual(lost);
    expect(w.log).toEqual(["seal"]);
  });

  test("항목의 정지 세대가 장부의 지금 세대와 다르면 봉하지 않는다", async () => {
    const w = world();
    const s = started(w);
    acceptStart(w, s);
    const c = cancel(w, s, NOW + 1_000);
    must(w.ledger.applyStop({ generation: 1, stopped: true, now: NOW + 2_000 }));
    w.setClock(NOW + 60_000);
    expect(outcomes(await tick(w))).toEqual([{ requestId: c.requestId, runId: s.runId, action: "task_cancel", outcome: "stop_generation_mismatch", stopGeneration: 0, currentStopGeneration: 1 }]);
    expect(w.log).toEqual([]);
  });

  test("지정 실행기의 연결이 지시를 낼 수 없으면 봉하지 않는다", async () => {
    const w = world();
    const s = started(w);
    w.setClock(NOW + 6_000);
    const asked: unknown[] = [];
    const cases: [unknown, Withheld][] = [
      [{ ok: false, reason: "no_connection" }, "no_connection"],
      [{ ok: false }, "link_unknown"],
      ["yes", "link_unknown"],
    ];
    for (const [answer, reason] of cases) {
      w.setLink((executorId, action) => {
        asked.push([executorId, action]);
        return answer;
      });
      expect(outcomes(await tick(w))).toEqual([{ requestId: s.requestId, runId: s.runId, action: "task_start", outcome: "withheld", reason }]);
    }
    w.setLink(() => {
      throw new Error("연결 포트 실패");
    });
    expect(outcomes(await tick(w))[0]).toMatchObject({ outcome: "withheld", reason: "link_unknown" });
    expect(asked[0]).toEqual([s.run.executorId, "task_start"]);
    expect(w.log).toEqual([]);
  });

  test("읽기가 모름이면 아무것도 내보내지 않는다", async () => {
    const w = world();
    started(w);
    w.setClock(NOW + 6_000);
    const reads: ((real: () => unknown) => unknown)[] = [
      () => ({ known: false, reason: "ledger_unreadable" }),
      (real) => ({ ...(real() as object), known: "true" }),
      (real) => ({ known: true, value: { ...(real() as { value: object }).value, instructions: "x" } }),
      () => {
        throw new Error("읽기 실패");
      },
    ];
    for (const read of reads) {
      w.wrapRead(read);
      expect(await tick(w)).toEqual({ kind: "not_run", reason: "read_unknown" });
    }
    // 정지 기록이 없다고 읽히면 대조할 세대를 모른다.
    w.wrapRead((real) => {
      const value = (real() as { value: UnansweredInstructions }).value;
      return { known: true, value: { ...value, stopGeneration: null } };
    });
    expect(await tick(w)).toEqual({ kind: "not_run", reason: "stop_generation_unknown" });
    expect(w.log).toEqual([]);
  });

  test("싣기 직전의 다시 읽기가 모름이면 그 항목을 내지 않는다", async () => {
    const w = world();
    const s = started(w);
    w.setClock(NOW + 6_000);
    let calls = 0;
    w.wrapRead((real) => (++calls === 1 ? real() : { known: false, reason: "ledger_unreadable" }));
    expect(outcomes(await tick(w))).toEqual([{ requestId: s.requestId, runId: s.runId, action: "task_start", outcome: "withheld", reason: "read_unknown" }]);
    expect(w.log).toEqual([]);
  });

  test("같은 실행에 종료가 적힌 시작은 다시 내지 않고 종료만 다시 낸다", async () => {
    const w = world();
    const s = started(w);
    const c = cancel(w, s, NOW + 1_000, "requested");
    w.setClock(NOW + 7_000);
    expect(outcomes(await tick(w))).toEqual([
      { requestId: s.requestId, runId: s.runId, action: "task_start", outcome: "withheld", reason: "stop_recorded" },
      { requestId: c.requestId, runId: s.runId, action: "task_cancel", outcome: "resent", executorId: s.run.executorId, sealedAt: NOW + 7_000, at: NOW + 7_000 },
    ]);
    expect(w.sent.map((e) => e.header.action)).toEqual(["task_cancel"]);
  });

  test("접수가 닫히면 시작만 막고 종료는 다시 낸다", async () => {
    const w = world();
    const s = started(w);
    w.setIntake(false);
    w.setClock(NOW + 6_000);
    expect(outcomes(await tick(w))).toEqual([{ requestId: s.requestId, runId: s.runId, action: "task_start", outcome: "withheld", reason: "intake_closed" }]);
    expect(w.log).toEqual([]);
    acceptStart(w, s);
    const c = cancel(w, s, NOW + 6_000);
    w.setClock(NOW + 12_000);
    expect(outcomes(await tick(w))).toEqual([{ requestId: c.requestId, runId: s.runId, action: "task_cancel", outcome: "resent", executorId: s.run.executorId, sealedAt: NOW + 12_000, at: NOW + 12_000 }]);
  });
});

describe("보장 3: 두드리지 않는다", () => {
  test("간격은 발행 시각과 넘겨받은 마지막 송신 시각 가운데 늦은 것부터 센다", async () => {
    const w = world();
    const s = started(w);
    acceptStart(w, s);
    const c = cancel(w, s, NOW + 3_000);
    const held = (lastAt: number): ResendOutcome[] => [{ requestId: c.requestId, runId: s.runId, action: "task_cancel", outcome: "held", lastAt }];
    w.setClock(NOW + 3_000 + EVERY - 1);
    expect(outcomes(await tick(w))).toEqual(held(NOW + 3_000));
    w.setClock(NOW + 3_000 + EVERY);
    expect(outcomes(await tick(w))[0]).toMatchObject({ outcome: "resent", sealedAt: NOW + 8_000 });
    const memory = [{ requestId: c.requestId, at: NOW + 8_000 }];
    w.setClock(NOW + 8_000 + EVERY - 1);
    expect(outcomes(await tick(w, memory))).toEqual(held(NOW + 8_000));
    w.setClock(NOW + 8_000 + EVERY);
    expect(outcomes(await tick(w, memory))[0]).toMatchObject({ outcome: "resent", sealedAt: NOW + 13_000 });
    expect(w.sent).toHaveLength(2);
  });

  test("다음 박자에 넘길 시각은 내보내기 포트가 돌아온 뒤에 읽은 시각이다", async () => {
    const w = world();
    const s = started(w);
    acceptStart(w, s);
    const c = cancel(w, s, NOW + 3_000);
    const head = { requestId: c.requestId, runId: s.runId, action: "task_cancel" as const, executorId: s.run.executorId };
    const remember = (result: ResendTickResult) => outcomes(result).flatMap((o) => ("at" in o ? [{ requestId: o.requestId as string, at: o.at }] : []));
    // 포트 안에서 5000ms가 지나 실린다. 결과의 at을 넘겨 곧바로 다음 박자를 부르면 다시 내지 않는다.
    w.setClock(NOW + 10_000);
    w.setSend(async () => {
      w.setClock(NOW + 15_000);
      return "sent";
    });
    const first = await tick(w);
    expect(outcomes(first)).toEqual([{ ...head, outcome: "resent", sealedAt: NOW + 10_000, at: NOW + 15_000 }]);
    w.setSend(async () => "sent");
    expect(outcomes(await tick(w, remember(first)))).toEqual([{ requestId: c.requestId, runId: s.runId, action: "task_cancel", outcome: "held", lastAt: NOW + 15_000 }]);
    expect(w.sent).toHaveLength(1);
    // 실렸는지 모르는 결과도 같은 규칙이다.
    w.setClock(NOW + 20_000);
    w.setSend(async () => {
      w.setClock(NOW + 25_000);
      throw new Error("내보내기 실패");
    });
    const unknown = await tick(w, remember(first));
    expect(outcomes(unknown)).toEqual([{ ...head, outcome: "not_sent", reason: "send_threw", delivery: "unknown", sealedAt: NOW + 20_000, at: NOW + 25_000 }]);
    // 돌아온 뒤 시계를 읽지 못하면(뒤로 감) 그 봉투의 시한이 상한이다.
    w.setClock(NOW + 30_000);
    w.setSend(async () => {
      w.setClock(NOW + 29_000);
      return "sent";
    });
    const regressed = outcomes(await tick(w, remember(unknown)));
    expect(regressed).toEqual([{ ...head, outcome: "resent", sealedAt: NOW + 30_000, at: (w.sent[1] as Envelope).header.expires_at }]);
    expect((w.sent[1] as Envelope).header.expires_at).toBe(NOW + 60_000);
  });

  test("실행기가 답하면 읽기에서 사라져 더 내지 않는다", async () => {
    const w = world();
    const s = started(w);
    acceptStart(w, s);
    const c = cancel(w, s, NOW + 1_000);
    acceptCancel(w, s, c.requestId);
    w.setClock(NOW + 60_000);
    expect(outcomes(await tick(w))).toEqual([]);
    expect(w.log).toEqual([]);
  });

  test("앞 항목을 내보내는 동안 답이 온 지시는 다시 읽기가 막는다", async () => {
    const w = world();
    const s = started(w);
    acceptStart(w, s);
    const a = cancel(w, s, NOW + 1_000);
    const b = cancel(w, s, NOW + 2_000, "requested");
    w.setSend(async () => {
      acceptCancel(w, s, b.requestId);
      return "sent";
    });
    w.setClock(NOW + 60_000);
    expect(outcomes(await tick(w))).toEqual([
      { requestId: a.requestId, runId: s.runId, action: "task_cancel", outcome: "resent", executorId: s.run.executorId, sealedAt: NOW + 60_000, at: NOW + 60_000 },
      { requestId: b.requestId, runId: s.runId, action: "task_cancel", outcome: "answered" },
    ]);
    expect(w.sent).toHaveLength(1);
  });

  test("같은 장부 포트로 겹쳐 부르면 읽지 않고 돌려보낸다", async () => {
    const w = world();
    started(w);
    w.setClock(NOW + 6_000);
    let release: (value: SendOutcome) => void = () => {};
    w.setSend(() => new Promise((resolve) => (release = resolve)));
    const first = tick(w);
    await Promise.resolve();
    expect(await tick(w)).toEqual({ kind: "not_run", reason: "tick_in_progress" });
    release("sent");
    expect(outcomes(await first)[0]).toMatchObject({ outcome: "resent" });
  });

  test("정책과 기억의 꼴이 틀리면 돌지 않는다", async () => {
    const w = world();
    started(w);
    w.setClock(NOW + 6_000);
    for (const every of [0, -1, 1.5, Number.NaN]) expect(await tick(w, [], every)).toEqual({ kind: "not_run", reason: "policy_rejected" });
    expect(await resendTick(w.ports, { resendEveryMs: EVERY }, {} as never)).toEqual({ kind: "not_run", reason: "input_malformed" });
    expect(await tick(w, [{ requestId: id(), at: 0 }])).toEqual({ kind: "not_run", reason: "input_malformed" });
    expect(w.log).toEqual([]);
  });
});

describe("보장 4: 실패는 결과를 지우지 않는다", () => {
  function twoCancels(w: World) {
    const s = started(w);
    acceptStart(w, s);
    return { s, a: cancel(w, s, NOW + 1_000), b: cancel(w, s, NOW + 2_000, "requested") };
  }

  test("한 항목의 내보내기 예외·거절은 그 항목의 결과이고 다음 항목을 본다", async () => {
    const w = world();
    const { s, a, b } = twoCancels(w);
    w.setClock(NOW + 60_000);
    const answers: (() => Promise<SendOutcome>)[] = [
      async () => {
        throw new Error("내보내기 실패");
      },
      async () => "sent",
    ];
    w.setSend(() => (answers.shift() as () => Promise<SendOutcome>)());
    const result = ran(await tick(w));
    expect(result.instructions).toEqual([
      { requestId: a.requestId, runId: s.runId, action: "task_cancel", outcome: "not_sent", reason: "send_threw", delivery: "unknown", executorId: s.run.executorId, sealedAt: NOW + 60_000, at: NOW + 60_000 },
      { requestId: b.requestId, runId: s.runId, action: "task_cancel", outcome: "resent", executorId: s.run.executorId, sealedAt: NOW + 60_000, at: NOW + 60_000 },
    ]);
    expect(result.halted).toBeNull();

    const more: SendOutcome[] = ["no_connection", "bogus" as SendOutcome];
    w.setSend(async () => more.shift() as SendOutcome);
    expect(outcomes(await tick(w)).map((o) => [o.outcome, "reason" in o ? o.reason : null, "delivery" in o ? o.delivery : null])).toEqual([
      ["not_sent", "no_connection", "not_sent"],
      ["not_sent", "send_answer_malformed", "unknown"],
    ]);
  });

  test("봉하기 실패도 그 항목의 결과이고 다음 항목을 본다", async () => {
    const w = world();
    const { s, a, b } = twoCancels(w);
    w.setClock(NOW + 60_000);
    let seals = 0;
    w.setSigner(() => {
      if (++seals === 1) throw new Error("서명 포트 실패");
    });
    expect(outcomes(await tick(w))).toEqual([
      { requestId: a.requestId, runId: s.runId, action: "task_cancel", outcome: "not_sealed", reason: "seal_threw" },
      { requestId: b.requestId, runId: s.runId, action: "task_cancel", outcome: "resent", executorId: s.run.executorId, sealedAt: NOW + 60_000, at: NOW + 60_000 },
    ]);
  });

  test("항목 안에서 포트 묶음의 속성을 읽다 던지면 그때까지의 결과와 함께 멈춘다", async () => {
    const w = world();
    const { s, a, b } = twoCancels(w);
    w.setClock(NOW + 60_000);
    let linkReads = 0;
    const ports = {
      ...w.ports,
      get links() {
        if (++linkReads === 2) throw new Error("포트 묶음 실패");
        return w.ports.links;
      },
    } as ResendPorts;
    expect(await resendTick(ports, { resendEveryMs: EVERY }, { lastResends: [] })).toEqual({
      kind: "ran",
      instructions: [{ requestId: a.requestId, runId: s.runId, action: "task_cancel", outcome: "resent", executorId: s.run.executorId, sealedAt: NOW + 60_000, at: NOW + 60_000 }],
      halted: "threw",
      haltedAt: b.requestId,
    });
    expect(w.sent.map((e) => e.header.request_id)).toEqual([a.requestId]);
  });

  test("내보내기 포트의 send를 얻지 못하면 포트를 부르지 않은 그 항목의 실패이고, 얻은 함수는 수신 객체를 this로 부른다", async () => {
    const w = world();
    const { s, a, b } = twoCancels(w);
    w.setClock(NOW + 60_000);
    let sinkReads = 0;
    const real = w.ports.sink;
    const ports = {
      ...w.ports,
      get sink() {
        if (++sinkReads === 1) throw new Error("포트 묶음 실패");
        // 메서드가 this로 자기 상태를 본다. 수신 객체 없이 부르면 던져 send_threw가 된다.
        return {
          real,
          send(this: { real: typeof real }, envelope: Envelope) {
            return this.real.send(envelope);
          },
        };
      },
    } as ResendPorts;
    const result = ran(await resendTick(ports, { resendEveryMs: EVERY }, { lastResends: [] }));
    expect(result.instructions).toEqual([
      { requestId: a.requestId, runId: s.runId, action: "task_cancel", outcome: "not_sent", reason: "sink_unavailable", delivery: "not_sent", executorId: s.run.executorId, sealedAt: NOW + 60_000 },
      { requestId: b.requestId, runId: s.runId, action: "task_cancel", outcome: "resent", executorId: s.run.executorId, sealedAt: NOW + 60_000, at: NOW + 60_000 },
    ]);
    expect(result.halted).toBeNull();
    expect(w.log).toEqual(["seal", "seal", "send"]);
    expect(w.sent.map((e) => e.header.request_id)).toEqual([b.requestId]);
  });

  test("읽기 메서드를 붙인 함수도 장부 포트로 받는다", async () => {
    const w = world();
    const s = started(w);
    w.setClock(NOW + 6_000);
    const ledger = Object.assign(() => undefined, { unansweredInstructions: w.ports.ledger.unansweredInstructions, markStartDispatch: w.ports.ledger.markStartDispatch });
    expect(outcomes(await resendTick({ ...w.ports, ledger }, { resendEveryMs: EVERY }, { lastResends: [] }))).toEqual([
      { requestId: s.requestId, runId: s.runId, action: "task_start", outcome: "resent", executorId: s.run.executorId, sealedAt: NOW + 6_000, at: NOW + 6_000 },
    ]);
    expect(w.log).toEqual(["seal", "send"]);
  });

  test("박자 처음에 장부 포트를 얻지 못하면 예외 대신 읽지 못한 것이다", async () => {
    const w = world();
    started(w);
    w.setClock(NOW + 6_000);
    const throwing = {
      ...w.ports,
      get ledger(): never {
        throw new Error("포트 묶음 실패");
      },
    } as ResendPorts;
    const policy = { resendEveryMs: EVERY };
    expect(await resendTick(throwing, policy, { lastResends: [] })).toEqual({ kind: "not_run", reason: "read_unknown" });
    expect(await resendTick({ ...w.ports, ledger: undefined } as never, policy, { lastResends: [] })).toEqual({ kind: "not_run", reason: "read_unknown" });
    expect(w.log).toEqual([]);
  });

  test("꼴이 틀린 항목은 그 항목의 결과이고 다음 항목을 본다", async () => {
    const w = world();
    const s = started(w);
    w.setClock(NOW + 6_000);
    const bad = [{ requestId: "not-a-uuid" }, { ...unanswered(w).instructions[0], requestId: id(), runGeneration: 0 }];
    w.wrapRead((real) => {
      const value = (real() as { value: UnansweredInstructions }).value;
      return { known: true, value: { ...value, instructions: [...bad, ...value.instructions] } };
    });
    const result = outcomes(await tick(w));
    expect(result.slice(0, 2)).toEqual([
      { requestId: null, outcome: "malformed", field: "requestId" },
      { requestId: bad[1]?.requestId, outcome: "malformed", field: "runGeneration" },
    ]);
    expect(result[2]).toMatchObject({ requestId: s.requestId, outcome: "resent" });
  });

  test("결과에는 자격 참조·서명·nonce가 없다", async () => {
    const w = world();
    const s = started(w);
    w.setClock(NOW + 6_000);
    const json = JSON.stringify(await tick(w));
    const envelope = w.sent[0] as Envelope;
    for (const secret of [s.run.credential.digest, envelope.signature, envelope.header.nonce]) expect(json).not.toContain(secret);
  });
});

test("이 모듈은 시계·난수·소켓·타이머를 직접 부르지 않고, 실행 줄·지시 줄의 장부 쓰기를 부르지 않는다", async () => {
  const source = (await Bun.file(new URL("../../../src/supervisor/dispatch/resend.ts", import.meta.url)).text()).replace(/\/\/.*$/gm, "");
  for (const banned of ["Date.now", "new Date", "performance.now", "Math.random", "randomUUID", "getRandomValues", "setTimeout", "setInterval", "node:", "bun:", "Bun.", "process.", "newUuid"]) {
    expect(source).not.toContain(banned);
  }
  // 실행 줄·지시 줄을 쓰는 장부 연산의 이름. 장부 포트는 읽기와 송신 표식이고, 표식은 공유 함수(send-gate.ts)가 부른다
  // (start-send.test.ts가 본다). 포트 타입 밖의 쓰기도 이름으로 막는다.
  for (const write of [/\brecord[A-Z]\w*Instruction\b/, /\bstartRun\b/, /\bassignToolRequest\b/, /\bcancelToolRequest\b/, /\bapplyReceipt\b/, /\bmarkLost\w*\b/, /\bmarkResult\b/]) {
    expect(source).not.toMatch(write);
  }
});

// 장부 파일의 송신 표식. 공개 읽기가 없어 원 SQL로 읽는다. 열린 장부 객체가 파일을 잠그므로 먼저 닫는다(그 뒤로 그 객체는 쓰지 않는다).
function marks(w: { ledger: Ledger; path: string }): { run_id: string; request_id: string; marked_at: number }[] {
  w.ledger.close();
  const raw = new Database(w.path, { readonly: true });
  try {
    return raw.query("SELECT run_id, request_id, marked_at FROM start_dispatches ORDER BY marked_at").all() as { run_id: string; request_id: string; marked_at: number }[];
  } finally {
    raw.close();
  }
}

// 표식 포트의 답. 칸을 읽을 때마다 그 칸의 다음 값을 내고(끝 값에서 멈춘다, Error면 던진다) 읽은 횟수를 reads에 센다.
function answerOf(fields: Record<string, unknown[]>, reads: Record<string, number>): object {
  const answer = {};
  for (const [name, values] of Object.entries(fields)) {
    reads[name] = 0;
    Object.defineProperty(answer, name, {
      enumerable: true,
      get: () => {
        const count = reads[name] ?? 0;
        reads[name] = count + 1;
        const value = values[Math.min(count, values.length - 1)];
        if (value instanceof Error) throw value;
        return value;
      },
    });
  }
  return answer;
}

// 표식 포트를 부를 때 기록에 남긴다.
function logMarks(w: World, during: (() => void) | null = null): void {
  w.wrapMark((_input, real) => {
    w.log.push("mark");
    const answer = real();
    during?.();
    return answer;
  });
}

describe("송신 표식: 재전송의 시작도 표식이 ok인 뒤에만 내보내기 포트에 닿는다", () => {
  test("다시 낸 시작은 그 실행·그 요청 ID의 표식을 봉한 뒤, 송신 직전에 커밋한다", async () => {
    const w = world();
    const s = started(w);
    logMarks(w);
    w.setClock(NOW + 6_000);
    expect(outcomes(await tick(w))).toEqual([{ requestId: s.requestId, runId: s.runId, action: "task_start", outcome: "resent", executorId: s.run.executorId, sealedAt: NOW + 6_000, at: NOW + 6_000 }]);
    expect(w.log).toEqual(["seal", "mark", "send"]);
    expect(marks(w)).toEqual([{ run_id: s.runId, request_id: s.requestId, marked_at: NOW + 6_000 }]);
  });

  test("표식을 적지 못하는 장부(못 씀)에서는 송신이 0이고 구별된 이유를 낸다", async () => {
    const w = world();
    const s = started(w);
    logMarks(w);
    w.setLedgerFault((point) => {
      if (point === "start_dispatch:before_commit") throw new Error("디스크 실패");
    });
    w.setClock(NOW + 6_000);
    expect(outcomes(await tick(w))).toEqual([
      { requestId: s.requestId, runId: s.runId, action: "task_start", outcome: "not_sent", reason: "start_unmarked", delivery: "not_sent", executorId: s.run.executorId, sealedAt: NOW + 6_000, markReason: "ledger_unwritable" },
    ]);
    expect(w.log).toEqual(["seal", "mark"]);
    expect(w.sent).toEqual([]);
    expect(marks(w)).toEqual([]);
    // 표식 포트가 던지거나 꼴이 틀린 답을 내도 싣지 않는다.
    for (const [markReason, answer] of [
      ["threw", () => { throw new Error("표식 포트 실패"); }],
      ["malformed_answer", () => ({ ok: true })],
    ] as const) {
      const v = world();
      const t = started(v);
      v.wrapMark(answer);
      v.setClock(NOW + 6_000);
      expect([markReason, outcomes(await tick(v))]).toEqual([markReason, [expect.objectContaining({ requestId: t.requestId, outcome: "not_sent", reason: "start_unmarked", markReason })]]);
      expect(v.sent).toEqual([]);
    }
  });

  test("표식의 답은 칸마다 한 번만 읽고 그 값으로 판정한다. 읽을 때마다 바뀌거나 읽다 던지는 답은 싣지 않고, 박자는 뒤 항목을 잇는다", async () => {
    // 표식 포트는 장부에 쓰지 않고(표식 0줄) 이 답을 낸다. 둘째 읽기에서 거절 사유가 null(성공 표시)이 되어도 첫 값으로 판정한다.
    const cases: ["intake_closed" | "threw", Record<string, unknown[]>][] = [
      ["intake_closed", { ok: [false], reason: ["intake_closed", null] }],
      ["intake_closed", { ok: [false, true], created: [true], reason: ["intake_closed"] }],
      ["threw", { ok: [new Error("ok 접근자 실패")] }],
      ["threw", { ok: [false], reason: [new Error("사유 접근자 실패")] }],
    ];
    for (const [markReason, fields] of cases) {
      const w = world();
      // 장부는 작업자 실행을 한 번에 하나만 둔다(slot_busy). 그래서 시작 항목은 하나이고, 박자가 멈추지 않았음은 halted로 본다.
      const s = started(w);
      const reads: Record<string, number> = {};
      w.wrapMark(() => answerOf(fields, reads));
      w.setClock(NOW + 6_000);
      const result = ran(await tick(w));
      const label = JSON.stringify(fields, (_key, value) => (value instanceof Error ? "Error" : value));
      expect([label, result.instructions]).toEqual([
        label,
        [{ requestId: s.requestId, runId: s.runId, action: "task_start", outcome: "not_sent", reason: "start_unmarked", delivery: "not_sent", executorId: s.run.executorId, sealedAt: NOW + 6_000, markReason }],
      ]);
      expect([label, result.halted, result.haltedAt]).toEqual([label, null, null]);
      expect([label, w.log, w.sent.length]).toEqual([label, ["seal"], 0]);
      expect([label, Object.values(reads).every((n) => n <= 1)]).toEqual([label, true]);
      expect([label, marks(w)]).toEqual([label, []]);
      // 같은 답을 내는 세계에서 시작 뒤에 구별되는 다음 항목(꼴이 틀린 실행 세대)을 붙인다. 작업자 자리를 더 쓰지 않고
      // 박자가 첫 항목 뒤에도 이어 가는지를 결과 둘과 그 순서로 본다.
      const v = world();
      const t = started(v);
      const tail = id();
      v.wrapRead((real) => {
        const value = (real() as { value: UnansweredInstructions }).value;
        return { known: true, value: { ...value, instructions: [...value.instructions, { ...value.instructions[0], requestId: tail, runGeneration: 0 }] } };
      });
      v.wrapMark(() => answerOf(fields, {}));
      v.setClock(NOW + 6_000);
      const next = ran(await tick(v));
      expect([label, next.instructions]).toEqual([
        label,
        [
          { requestId: t.requestId, runId: t.runId, action: "task_start", outcome: "not_sent", reason: "start_unmarked", delivery: "not_sent", executorId: t.run.executorId, sealedAt: NOW + 6_000, markReason },
          { requestId: tail, outcome: "malformed", field: "runGeneration" },
        ],
      ]);
      expect([label, next.halted, next.haltedAt, v.sent.length]).toEqual([label, null, null, 0]);
    }
  });

  test("ok가 첫 읽기에 true이면(실제 장부가 커밋한 뒤) 둘째 읽기의 값과 상관없이 싣는다. ok는 한 번만 읽는다", async () => {
    const w = world();
    const s = started(w);
    const reads: Record<string, number> = {};
    w.wrapMark((_input, real) => {
      const answer = real() as { ok: boolean; created?: boolean };
      if (answer.ok !== true) throw new Error("표식 거절");
      return answerOf({ ok: [true, false], created: [answer.created] }, reads);
    });
    w.setClock(NOW + 6_000);
    expect(outcomes(await tick(w))).toEqual([expect.objectContaining({ requestId: s.requestId, outcome: "resent" })]);
    expect([reads.ok, w.sent.length]).toEqual([1, 1]);
    expect(marks(w)).toEqual([{ run_id: s.runId, request_id: s.requestId, marked_at: NOW + 6_000 }]);
  });

  test("표식의 커밋은 마지막 시계 읽기보다 앞이다: 커밋 중에 한도가 지나면 싣지 않는다(표식은 남는다)", async () => {
    const w = world();
    const s = started(w);
    const last = NOW + START_LAST_SEAL_MS;
    // 정각에 판단·봉하고, 표식을 커밋하는 동안 1ms가 지난다.
    logMarks(w, () => w.setClock(last + 1));
    w.setClock(last);
    expect(outcomes(await tick(w))).toEqual([{ requestId: s.requestId, runId: s.runId, action: "task_start", outcome: "start_expired", issuedAt: NOW, expiresAt: NOW + 30_000 }]);
    expect(w.log).toEqual(["seal", "mark"]);
    expect(w.sent).toEqual([]);
    // 표식만 남고 실리지 않은 것은 자동 닫기를 덜 하는 쪽이다(다른 열기에서는 sent_by_other_open).
    expect(marks(w)).toEqual([{ run_id: s.runId, request_id: s.requestId, marked_at: last }]);
  });

  test("취소·확정의 재전송은 표식을 부르지 않는다", async () => {
    const w = world();
    const s = started(w);
    acceptStart(w, s);
    const c = cancel(w, s, NOW + 3_000);
    logMarks(w);
    w.setClock(NOW + 60_000);
    expect(outcomes(await tick(w))).toEqual([{ requestId: c.requestId, runId: s.runId, action: "task_cancel", outcome: "resent", executorId: s.run.executorId, sealedAt: NOW + 60_000, at: NOW + 60_000 }]);
    must(w.ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: s.runId, exit: "completed", bodyDigest: digest(`stopped:${s.runId}`), now: NOW }, s.from));
    must(w.ledger.markResult({ runId: s.runId, resultDigest: RESULT, now: NOW + 61_000 }));
    must(w.ledger.recordFinalizeInstruction({ runId: s.runId, requestId: id(), stopGeneration: 0, now: NOW + 61_000, outcome: "succeeded", resultDigest: RESULT, storedAt: NOW + 60_900 }));
    w.setClock(NOW + 120_000);
    expect(outcomes(await tick(w))).toEqual([expect.objectContaining({ action: "result_finalize", outcome: "resent" })]);
    expect(w.log).toEqual(["seal", "send", "seal", "send"]);
    expect(marks(w)).toEqual([]);
  });

  test("감독이 다시 뜬 뒤의 재전송은 새 열기의 표식을 남기고, 그 뒤 다시 연 장부의 자동 닫기는 그 실행을 닫지 않는다", async () => {
    const portsFor = (ledger: Ledger, at: number, sent: Envelope[]): ResendPorts => ({
      ledger,
      intake: { intakeOpen: () => true },
      links: { mayIssue: () => ({ ok: true }) },
      clock: { now: () => at },
      random: { bytes: (n) => getRandomValues(new Uint8Array(n)) },
      signer: { seal: (input) => sealEnvelope(input, keys.privateKey) },
      sink: {
        send: async (envelope) => {
          sent.push(envelope);
          return "sent";
        },
      },
    });
    // 실행기가 시작 발행 + 30000ms 뒤에 낸 전체 답에 그 실행이 없다(D-90의 닫는 입력).
    const unreceived = (runId: string) => ({ runId, runs: [], answeredAt: NOW + 30_000, receivedAt: NOW + 30_005, now: NOW + 30_010 });
    // 대조군(재전송 없음)은 같은 입력으로 닫힌다: 표식이 없으면 장부는 실린 적 없는 실행으로 읽는다.
    for (const resend of [true, false]) {
      const path = tempPath();
      // 첫 열기: 시작을 적었지만 싣지 못했다(표식 없음. 예: 배정·시작 박자의 표식이 실패했다).
      const first = ready(open(path));
      const live = startedWorker(first);
      first.close();
      // 감독이 다시 떴다: 새 열기에서 재전송 박자가 그 시작을 싣는다.
      const second = ready(open(path));
      const sent: Envelope[] = [];
      if (resend) {
        expect(outcomes(await resendTick(portsFor(second, NOW + 6_000, sent), { resendEveryMs: EVERY }, { lastResends: [] }))).toEqual([
          expect.objectContaining({ requestId: live.requestId, runId: live.runId, outcome: "resent" }),
        ]);
      }
      expect([resend, sent.length, marks({ ledger: second, path })]).toEqual(resend ? [true, 1, [{ run_id: live.runId, request_id: live.requestId, marked_at: NOW + 6_000 }]] : [false, 0, []]);
      // 다시 연 장부: 다른 열기의 표식이 있는 실행은 자동으로 닫지 않는다.
      const third = ready(open(path));
      const closed = third.closeUnreceivedRun(unreceived(live.runId), { sender: WORKER_EXECUTOR });
      expect([resend, closed]).toEqual(resend ? [true, { ok: false, reason: "sent_by_other_open" }] : [false, expect.objectContaining({ ok: true })]);
      third.close();
    }
  });
});

describe("모른다고 옮긴 실행: 시작은 다시 내지 않고 조회만 한다(D-92)", () => {
  // 끊김 박자처럼 지정 실행기의 끊김을 at에 적는다. 시험의 연결 포트는 기본이 ok라 실행기가 다시 붙은 것과 같다.
  function lost(w: World, s: Started, at: number): void {
    expect(must(w.ledger.markLostFor({ executorId: s.run.executorId, now: at })).runs).toEqual([expect.objectContaining({ runId: s.runId, before: "preparing", after: "unknown_running" })]);
    expect(unanswered(w).instructions).toEqual([expect.objectContaining({ requestId: s.requestId, action: "task_start", runState: "unknown_running" })]);
  }

  test("다시 붙은 실행기에도 시작을 봉하지 않고 run_unknown으로 끝난다(표식·봉투 0)", async () => {
    const w = world();
    const s = started(w);
    lost(w, s, NOW + 1_000);
    const before = snapshot(w);
    for (const at of [NOW + 6_000, NOW + START_LAST_SEAL_MS]) {
      w.setClock(at);
      expect(outcomes(await tick(w))).toEqual([{ requestId: s.requestId, runId: s.runId, action: "task_start", outcome: "withheld", reason: "run_unknown" }]);
    }
    expect([w.log, w.sent.length]).toEqual([[], 0]);
    expect(snapshot(w)).toEqual(before);
    expect(marks(w)).toEqual([]);
  });

  test("발행 + 19000ms가 지난 시작은 run_unknown이 아니라 start_expired다(D-90의 재료)", async () => {
    const w = world();
    const s = started(w);
    lost(w, s, NOW + 1_000);
    w.setClock(NOW + START_LAST_SEAL_MS + 1);
    expect(outcomes(await tick(w))).toEqual([{ requestId: s.requestId, runId: s.runId, action: "task_start", outcome: "start_expired", issuedAt: NOW, expiresAt: NOW + 30_000 }]);
    expect(w.log).toEqual([]);
  });

  test("같은 실행의 취소는 그대로 다시 낸다", async () => {
    const w = world();
    const s = started(w);
    // 취소를 적은 뒤(stopping) 끊겨 옮겨졌다: 시작과 취소 항목이 모두 unknown_running이다.
    const c = cancel(w, s, NOW + 1_000, "requested");
    expect(must(w.ledger.markLostFor({ executorId: s.run.executorId, now: NOW + 2_000 })).runs).toEqual([expect.objectContaining({ runId: s.runId, before: "stopping", after: "unknown_running" })]);
    expect(unanswered(w).instructions.map((i) => [i.action, i.runState])).toEqual([
      ["task_start", "unknown_running"],
      ["task_cancel", "unknown_running"],
    ]);
    w.setClock(NOW + 8_000);
    expect(outcomes(await tick(w))).toEqual([
      { requestId: s.requestId, runId: s.runId, action: "task_start", outcome: "withheld", reason: "run_unknown" },
      { requestId: c.requestId, runId: s.runId, action: "task_cancel", outcome: "resent", executorId: s.run.executorId, sealedAt: NOW + 8_000, at: NOW + 8_000 },
    ]);
    expect(w.sent.map((e) => e.header.action)).toEqual(["task_cancel"]);
    expectSameRequest(c.first as Envelope, w.sent[0] as Envelope);
  });

  test("감독이 다시 떠 복원이 옮긴 실행의 시작도 새 연결로 다시 내지 않고, 다시 연 장부의 자동 닫기는 그 실행을 닫을 수 있다", async () => {
    const path = tempPath();
    const first = ready(open(path));
    const live = startedWorker(first);
    first.close();
    // 감독이 다시 떴다: 복원 3단계처럼 진행 중 실행을 모른다고 옮긴다.
    const second = ready(open(path));
    expect(must(second.markLost(NOW + 1_000)).runIds).toEqual([live.runId]);
    const sent: Envelope[] = [];
    const ports: ResendPorts = {
      ledger: second,
      intake: { intakeOpen: () => true },
      links: { mayIssue: () => ({ ok: true }) },
      clock: { now: () => NOW + 6_000 },
      random: { bytes: (n) => getRandomValues(new Uint8Array(n)) },
      signer: { seal: (input) => sealEnvelope(input, keys.privateKey) },
      sink: {
        send: async (envelope) => {
          sent.push(envelope);
          return "sent";
        },
      },
    };
    expect(outcomes(await resendTick(ports, { resendEveryMs: EVERY }, { lastResends: [] }))).toEqual([
      { requestId: live.requestId, runId: live.runId, action: "task_start", outcome: "withheld", reason: "run_unknown" },
    ]);
    expect([sent.length, marks({ ledger: second, path })]).toEqual([0, []]);
    // 새 열기의 표식이 없으므로 D-90의 닫기 입력(시작 발행 + 30000ms 뒤의 전체 답에 그 실행이 없음)이 그 실행을 닫는다.
    const third = ready(open(path));
    expect(third.closeUnreceivedRun({ runId: live.runId, runs: [], answeredAt: NOW + 30_000, receivedAt: NOW + 30_005, now: NOW + 30_010 }, { sender: WORKER_EXECUTOR })).toEqual(
      expect.objectContaining({ ok: true }),
    );
    third.close();
  });
});
