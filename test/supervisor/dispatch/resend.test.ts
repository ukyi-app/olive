import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, getRandomValues } from "node:crypto";
import { type Envelope, sealEnvelope } from "../../../src/contract/v1/index.ts";
import type { Ledger, UnansweredInstructions } from "../../../src/ledger/index.ts";
import { type Drafted, type DraftAction, finalizeDraft, sealDraft, startDraft, stopDraft } from "../../../src/supervisor/dispatch/envelopes.ts";
import type { Random, SendOutcome, Signer } from "../../../src/supervisor/dispatch/ports.ts";
import { type ResendOutcome, type ResendPorts, type ResendTickResult, resendTick, START_LAST_SEAL_MS, type Withheld } from "../../../src/supervisor/dispatch/resend.ts";
import { digest, from, id, must, NOW, open, ready, tempPath, worker } from "../../ledger/helpers.ts";

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
}

function world(): World {
  let clockAt = NOW;
  // 장부 시계는 시작 지시의 발행 시각을 정한다. 시험의 박자 시계와 같은 값을 쓴다.
  const ledger = ready(open(tempPath(), { clock: () => clockAt }));
  const log: string[] = [];
  const sent: Envelope[] = [];
  let intake = true;
  let link: (executorId: string, action: string) => unknown = () => ({ ok: true });
  let send: (envelope: Envelope) => Promise<SendOutcome> = async () => "sent";
  let signerHook: (() => void) | null = null;
  let readHook: ((real: () => unknown) => unknown) | null = null;
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
  test("시작은 요청 ID·본문·세대·발행 시각·시한이 처음과 같고 장부에 쓰지 않는다", async () => {
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

test("이 모듈은 시계·난수·소켓·타이머를 직접 부르지 않고 장부에 쓰지 않는다", async () => {
  const source = (await Bun.file(new URL("../../../src/supervisor/dispatch/resend.ts", import.meta.url)).text()).replace(/\/\/.*$/gm, "");
  for (const banned of ["Date.now", "new Date", "performance.now", "Math.random", "randomUUID", "getRandomValues", "setTimeout", "setInterval", "node:", "bun:", "Bun.", "process.", "newUuid"]) {
    expect(source).not.toContain(banned);
  }
  // 장부 쓰기 연산의 이름. 포트 타입이 읽기 하나뿐이지만 이름으로도 막는다.
  for (const write of [/\brecord[A-Z]\w*Instruction\b/, /\bstartRun\b/, /\bassignToolRequest\b/, /\bcancelToolRequest\b/, /\bapplyReceipt\b/, /\bmarkLost\w*\b/, /\bmarkResult\b/]) {
    expect(source).not.toMatch(write);
  }
});
