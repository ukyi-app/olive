// 작업 부탁(start_worker)의 장부 기록. 실제 장부 파일에 적고, 처리기(src/supervisor/scheduler/tools.ts)의 장부 포트 넷을
// 이 시험 안의 얇은 어댑터로 채워 실제 장부 + 실제 처리기로 돌린다. 나머지 포트 셋(세션 증거, 입력 고정, 결과 보관)은 다른 조각의
// 일이라 대역을 둔다.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { type Ledger, LedgerInputError, loadMigrations, openLedger, TOOL_REQUEST_PHASES, type ToolRequest, type ToolRequestInput } from "../../src/ledger/index.ts";
import { REF } from "../../src/ledger/input.ts";
import { PURPOSE } from "../../src/ledger/ledger.ts";
import {
  type Answer,
  handleToolCall,
  PATTERNS,
  PHASES,
  type ToolAnswer,
  type ToolCallContext,
  type ToolLedgerPort,
  type ToolPorts,
  type WorkRecord,
} from "../../src/supervisor/scheduler/tools.ts";
import { clock, digest, id, must, NOW, open, ready, tempPath, worker } from "./helpers.ts";

// ID와 digest는 이 시험이 고른 값이다. 운영값이 아니다.
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const SRC_A = "inbox/aaaaaaaa-1111-4000-8000-000000000001";
const SRC_B = "inbox/bbbbbbbb-1111-4000-8000-000000000002";
const D1 = digest("input one");
const D2 = digest("input two");
const SESSION = { id: "session-1", generation: 1 };
const MISSING = "eeeeeeee-0000-4000-8000-00000000000e";
const PINNED = [
  { owner: A, sourceRef: SRC_A, inputDigest: D1 },
  { owner: A, sourceRef: SRC_A, inputDigest: D2 },
  { owner: B, sourceRef: SRC_B, inputDigest: D1 },
];
const TOOL_REQUEST_VERSION = loadMigrations().findIndex((m) => m.name === "0003-tool-requests.sql") + 1;

// 처리기가 만드는 재시도 키와 같은 꼴(tools.ts의 retryKeyOf). 장부는 이 키를 해석하지 않는다.
const keyOf = (owner: string, purpose = "diagnose") => `start_worker:${owner}:${purpose}`;

// 새 참조의 후보. 같은 접두사의 생성기는 같은 순서의 값을 낸다(두 장부의 응답을 그대로 비교하려고).
function refs(prefix = "cccccccc"): () => string {
  let n = 0;
  return () => `${prefix}-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

// ---- 어댑터: 처리기의 장부 포트 넷을 장부 함수 넷으로 채운다 ----

// 이름만 옮긴다. 장부의 입력 칸은 정적 시험(test/ledger/static.test.ts)이 막는 조각을 쓰지 않으므로 retryKey는 dedupeKey,
// content는 네 칸으로 펼친다. 새 참조는 장부가 난수를 부르지 않아 주입한 생성기의 후보를 넘긴다. 같은 키의 줄이 이미 있으면
// 장부가 그 줄의 참조를 돌려주고 후보는 쓰이지 않는다.
const work = (r: ToolRequest): WorkRecord => ({
  ref: r.ref,
  owner: r.owner,
  retryKey: r.dedupeKey,
  content: { role: r.role, purpose: r.purpose, sourceRef: r.sourceRef, inputDigest: r.inputDigest },
  phase: r.phase,
});

type LedgerPort = Pick<ToolLedgerPort, "findByRetryKey" | "readOwnedWork" | "recordStart" | "requestCancel">;

function ledgerPort(ledger: Ledger, nextRef: () => string): LedgerPort {
  const read = (answer: ReturnType<Ledger["readToolRequest"]>): Answer<WorkRecord | null> =>
    answer.known ? { known: true, value: answer.value === null ? null : work(answer.value) } : { known: false };
  return {
    findByRetryKey: (q) => read(ledger.findToolRequest({ owner: q.owner, dedupeKey: q.retryKey })),
    readOwnedWork: (q) => read(ledger.readToolRequest({ owner: q.owner, ref: q.ref })),
    recordStart: (input) => {
      const c = input.content;
      const written = ledger.recordToolRequest({
        ref: nextRef(),
        owner: input.owner,
        dedupeKey: input.retryKey,
        role: c.role,
        purpose: c.purpose,
        sourceRef: c.sourceRef,
        inputDigest: c.inputDigest,
        sessionId: input.sessionId,
        callId: input.callId,
        now: input.now,
      });
      // 내용이 다른 같은 키(conflict)도 그 줄을 넘긴다. 충돌의 판정은 처리기가 돌려받은 줄의 내용을 대조해 한다.
      if (written.ok) return { known: true, value: { ok: true, record: work(written.request) } };
      if (written.reason === "stopped") return { known: true, value: { ok: false, reason: "stopped" } };
      if (written.reason === "intake_closed" || written.reason === "snapshot_hold") return { known: true, value: { ok: false, reason: "intake_closed" } };
      return { known: false };
    },
    requestCancel: (input) => {
      const written = ledger.cancelToolRequest({ owner: input.owner, ref: input.ref, sessionId: input.sessionId, callId: input.callId, now: input.now });
      if (written.ok) return { known: true, value: { ok: true, phase: written.phase } };
      if (written.reason === "transition_denied") return { known: true, value: { ok: false, reason: "already_ended" } };
      return { known: false };
    },
  };
}

function ports(ledger: Ledger, nextRef: () => string, live = SESSION): ToolPorts {
  return {
    config: { purposeBriefMaxChars: 200 },
    policy: { judge: (role, purpose) => (role === "diagnosis" && purpose === "diagnose" ? "allowed" : "purpose_not_allowed") },
    ledger: {
      ...ledgerPort(ledger, nextRef),
      // 다른 조각의 일(세션 증거, 입력 고정, 결과 보관)의 대역.
      liveSession: () => ({ known: true, value: live }),
      inputPinned: (q) => ({ known: true, value: PINNED.some((p) => p.owner === q.owner && p.sourceRef === q.sourceRef && p.inputDigest === q.inputDigest) }),
      readResult: () => ({ known: true, value: { state: "none" } }),
    },
  };
}

function ctx(owner: string, over: Partial<ToolCallContext> = {}): ToolCallContext {
  return { session: SESSION, requestId: owner, callId: id(), now: NOW, stop: { known: true, stopped: false }, ...over };
}

const startArgs = (over: { source_ref?: string; input_digest?: string; brief?: string } = {}) => ({
  role: "diagnosis",
  task: { purpose: "diagnose", brief: over.brief ?? "파드가 재시작을 반복하는 원인을 찾는다", source_ref: over.source_ref ?? SRC_A, input_digest: over.input_digest ?? D1 },
});

const refused = (tool: string, reason: string): ToolAnswer => ({ outcome: "refused", tool, reason: reason as never, field: null });

// ---- 장부 도우미 ----

// 부탁의 소유자는 접수한 입력이다(외래 키). 두 소유자를 같은 순서로 접수한다.
function owners(ledger: Ledger): void {
  must(ledger.enqueueInput({ requestId: A, source: "admin-dm", sourceRef: { ref: SRC_A, expiresAt: NOW + 3_600_000 }, receivedAt: NOW }));
  must(ledger.enqueueInput({ requestId: B, source: "admin-dm", sourceRef: { ref: SRC_B, expiresAt: NOW + 3_600_000 }, receivedAt: NOW }));
}

function request(owner: string, dedupeKey: string, over: Partial<ToolRequestInput> = {}): ToolRequestInput {
  return {
    ref: id(),
    owner,
    dedupeKey,
    role: "diagnosis",
    purpose: "diagnose",
    sourceRef: owner === A ? SRC_A : SRC_B,
    inputDigest: D1,
    sessionId: SESSION.id,
    callId: id(),
    now: NOW,
    ...over,
  };
}

const requestOf = (owner: string) => request(owner, keyOf(owner), { sourceRef: owner === A ? SRC_A : SRC_B });

// 닫은 장부 파일을 읽기 전용으로 읽는다.
function rows(path: string, sql: string): unknown[] {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.query(sql).all();
  } finally {
    raw.close();
  }
}

// ---- 인수 시험 ----

test("다른 소유자의 중복 키 거절: 같은 재시도 키를 써도 각자 자기 줄을 만들고, 남의 줄은 없는 것과 같은 답이다", () => {
  const FOREIGN = "ffffffff-0000-4000-8000-00000000000f";
  // 두 장부를 같은 순서로 만든다. 하나에만 B가 A의 키(start_worker:<A>:diagnose)로 적은 줄이 있다.
  const world = (foreign: boolean) => {
    const ledger = ready(open(tempPath()));
    owners(ledger);
    if (foreign) expect(must(ledger.recordToolRequest(request(B, keyOf(A), { ref: FOREIGN }))).outcome).toBe("created");
    const p = ports(ledger, refs());
    const answers = {
      started: handleToolCall("start_worker", startArgs(), ctx(A), p),
      again: handleToolCall("start_worker", startArgs(), ctx(A), p),
      foreignStatus: handleToolCall("worker_status", { ref: FOREIGN }, ctx(A), p),
      foreignCancel: handleToolCall("cancel_worker", { ref: FOREIGN }, ctx(A), p),
      found: ledger.findToolRequest({ owner: A, dedupeKey: keyOf(A) }),
      foreignRead: ledger.readToolRequest({ owner: A, ref: FOREIGN }),
      foreignCancelWrite: ledger.cancelToolRequest({ owner: A, ref: FOREIGN, sessionId: SESSION.id, callId: id(), now: NOW }),
    };
    return { ledger, answers };
  };
  const clean = world(false);
  const crowded = world(true);

  // B의 줄이 있든 없든 A가 받는 답(참조·단계·거절·읽기 실패의 꼴)이 같다.
  expect(crowded.answers).toEqual(clean.answers);
  expect(clean.answers.started).toEqual({ outcome: "ok", tool: "start_worker", ref: "cccccccc-0000-4000-8000-000000000001", phase: "waiting_assignment" });
  expect(clean.answers.again).toEqual(clean.answers.started);
  expect(clean.answers.foreignStatus).toEqual(refused("worker_status", "not_found"));
  expect(clean.answers.foreignRead).toEqual({ known: true, value: null });
  expect(clean.answers.foreignCancelWrite).toEqual({ ok: false, reason: "unknown_run" });

  // 같은 키의 두 줄이 소유자마다 따로 있다. B의 줄은 A의 호출에 닿지 않았다.
  const mine = crowded.ledger.findToolRequest({ owner: A, dedupeKey: keyOf(A) });
  const theirs = crowded.ledger.findToolRequest({ owner: B, dedupeKey: keyOf(A) });
  expect(mine).toMatchObject({ known: true, value: { ref: "cccccccc-0000-4000-8000-000000000001", owner: A, dedupeKey: keyOf(A), phase: "waiting_assignment" } });
  expect(theirs).toEqual({
    known: true,
    value: { ref: FOREIGN, owner: B, dedupeKey: keyOf(A), role: "diagnosis", purpose: "diagnose", sourceRef: SRC_B, inputDigest: D1, phase: "waiting_assignment" },
  });
  // B는 자기 키로도 정상으로 접수한다.
  const p = ports(crowded.ledger, refs("dddddddd"));
  expect(handleToolCall("start_worker", startArgs({ source_ref: SRC_B }), ctx(B), p)).toEqual({
    outcome: "ok",
    tool: "start_worker",
    ref: "dddddddd-0000-4000-8000-000000000001",
    phase: "waiting_assignment",
  });
  expect(handleToolCall("worker_status", { ref: FOREIGN }, ctx(B), p)).toEqual({ outcome: "ok", tool: "worker_status", ref: FOREIGN, phase: "waiting_assignment" });
});

test("같은 부탁은 재개방 뒤에도 같은 참조: 세션과 호출이 바뀌어도 같은 줄이고, 내용이 다르면 새 줄 없이 충돌이다", () => {
  const path = tempPath();
  const first = ready(open(path));
  owners(first);
  const started = handleToolCall("start_worker", startArgs(), ctx(A), ports(first, refs()));
  expect(started).toEqual({ outcome: "ok", tool: "start_worker", ref: "cccccccc-0000-4000-8000-000000000001", phase: "waiting_assignment" });
  first.close();

  const second = ready(open(path));
  // 다른 후보 생성기, 다른 세션, 다른 호출 ID, 다른 자유 글. 재시도 키의 내용(역할·목적·원본·digest)은 같다.
  const later = { id: "session-2", generation: 2 };
  const p = ports(second, refs("eeeeeeee"), later);
  expect(handleToolCall("start_worker", startArgs({ brief: "다시 묻는다" }), ctx(A, { session: later }), p)).toEqual(started);
  expect(handleToolCall("worker_status", { ref: "cccccccc-0000-4000-8000-000000000001" }, ctx(A, { session: later }), p)).toEqual({
    outcome: "ok",
    tool: "worker_status",
    ref: "cccccccc-0000-4000-8000-000000000001",
    phase: "waiting_assignment",
  });
  // 같은 키에 다른 digest: 처리기는 충돌로 거절하고, 장부는 새 줄을 만들지 않고 기존 줄을 conflict로 돌려준다.
  expect(handleToolCall("start_worker", startArgs({ input_digest: D2 }), ctx(A, { session: later }), p)).toEqual(refused("start_worker", "retry_conflict"));
  const direct = must(second.recordToolRequest(request(A, keyOf(A), { inputDigest: D2 })));
  expect(direct.outcome).toBe("conflict");
  expect(direct.request).toMatchObject({ ref: "cccccccc-0000-4000-8000-000000000001", inputDigest: D1 });
  second.close();
  expect(rows(path, "SELECT ref, owner, dedupe_key, input_digest, session_id FROM tool_requests")).toEqual([
    { ref: "cccccccc-0000-4000-8000-000000000001", owner: A, dedupe_key: keyOf(A), input_digest: D1, session_id: "session-1" },
  ]);
});

test("정지 중에는 부탁이 기록되지 않음: 처리기가 들어올 때 본 정지와 별개로 기록 트랜잭션이 정지를 다시 본다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  owners(ledger);
  must(ledger.applyStop({ generation: 1, stopped: true, now: NOW }));
  const p = ports(ledger, refs());
  // 문맥의 정지는 처리기가 들어올 때의 값(정지 아님)이다. 그 뒤에 걸린 정지를 장부가 거절한다.
  expect(handleToolCall("start_worker", startArgs(), ctx(A), p)).toEqual(refused("start_worker", "stopped"));
  expect(ledger.recordToolRequest(request(A, keyOf(A)))).toEqual({ ok: false, reason: "stopped" });
  // 풀어도 복원을 다시 마치기 전에는 접수가 닫혀 있다.
  must(ledger.releaseStop({ generation: 1, now: NOW }));
  expect(handleToolCall("start_worker", startArgs(), ctx(A), p)).toEqual(refused("start_worker", "intake_closed"));
  expect(ledger.findToolRequest({ owner: A, dedupeKey: keyOf(A) })).toEqual({ known: true, value: null });
  ledger.close();
  expect(rows(path, "SELECT count(*) AS n FROM tool_requests")).toEqual([{ n: 0 }]);
});

test("배정 전 대기는 실행 줄을 만들지 않음: runs·슬롯·실행기 없이 기록되고 재개방 뒤에도 같은 참조와 단계다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  owners(ledger);
  const started = handleToolCall("start_worker", startArgs(), ctx(A), ports(ledger, refs()));
  expect(started).toEqual({ outcome: "ok", tool: "start_worker", ref: "cccccccc-0000-4000-8000-000000000001", phase: "waiting_assignment" });
  expect(ledger.listRuns()).toEqual({ known: true, value: [] });
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: true });
  expect(ledger.slotHolds()).toEqual({ known: true, value: [] });
  ledger.close();
  expect(rows(path, "SELECT count(*) AS n FROM runs")).toEqual([{ n: 0 }]);
  expect(rows(path, "SELECT ref, phase, run_id FROM tool_requests")).toEqual([{ ref: "cccccccc-0000-4000-8000-000000000001", phase: "waiting_assignment", run_id: null }]);

  const reopened = ready(open(path));
  expect(handleToolCall("worker_status", { ref: "cccccccc-0000-4000-8000-000000000001" }, ctx(A), ports(reopened, refs("eeeeeeee")))).toEqual({
    outcome: "ok",
    tool: "worker_status",
    ref: "cccccccc-0000-4000-8000-000000000001",
    phase: "waiting_assignment",
  });
  // 자리를 쥐지 않았으므로 다른 작업자 실행이 그대로 자리를 잡는다.
  const admitted = must(reopened.admitRun(worker()));
  expect(must(reopened.startRun({ runId: admitted.run.runId, requestId: id(), stopGeneration: 0, now: NOW })).run.state).toBe("preparing");
});

// ---- 기록·읽기·취소의 세부 ----

test("조회와 기록 사이에 같은 키의 기록이 끼어들어도 한 줄이다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  owners(ledger);
  const base = ports(ledger, refs());
  const answers: ToolAnswer[] = [];
  // 처리기의 조회가 빈 답을 받은 뒤, 기록 전에 같은 부탁의 다른 호출이 먼저 기록한다.
  const racing: ToolPorts = {
    ...base,
    ledger: {
      ...base.ledger,
      findByRetryKey: (q) => {
        const seen = base.ledger.findByRetryKey(q);
        if (answers.length === 0) answers.push(handleToolCall("start_worker", startArgs(), ctx(A), base));
        return seen;
      },
    },
  };
  const late = handleToolCall("start_worker", startArgs(), ctx(A), racing);
  expect(answers).toEqual([{ outcome: "ok", tool: "start_worker", ref: "cccccccc-0000-4000-8000-000000000001", phase: "waiting_assignment" }]);
  expect(late).toEqual(answers[0] as ToolAnswer);
  // 앞서 읽은 빈 답으로 내용이 다른 같은 부탁을 기록하려 해도 새 줄 없이 충돌이다.
  const blind: ToolPorts = { ...base, ledger: { ...base.ledger, findByRetryKey: () => ({ known: true, value: null }) } };
  expect(handleToolCall("start_worker", startArgs({ input_digest: D2 }), ctx(A), blind)).toEqual(refused("start_worker", "retry_conflict"));
  ledger.close();
  expect(rows(path, "SELECT count(*) AS n FROM tool_requests")).toEqual([{ n: 1 }]);
});

test("유일 제약: 같은 (소유자, 재시도 키)의 두 번째 줄은 장부 밖의 SQL로도 들어가지 않고, 줄은 지우거나 바꿔 넣지 못한다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  owners(ledger);
  const first = must(ledger.recordToolRequest(request(A, keyOf(A)))).request;
  ledger.close();
  const raw = new Database(path);
  try {
    const indexes = raw.query("PRAGMA index_list(tool_requests)").all() as { name: string; unique: number }[];
    const keyed = indexes.filter((index) => index.unique === 1).map((index) => (raw.query(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as { name: string }[]).map((c) => c.name));
    expect(keyed).toContainEqual(["owner", "dedupe_key"]);
    const insert = (verb: string, ref: string) =>
      raw.run(
        `${verb} INTO tool_requests (ref, owner, dedupe_key, role, purpose, source_ref, input_digest, session_id, call_id, phase, created_at)
         VALUES ('${ref}', '${A}', '${keyOf(A)}', 'diagnosis', 'diagnose', '${SRC_A}', '${D2}', 'session-9', '${id()}', 'waiting_assignment', ${NOW})`,
      );
    // 같은 참조로 바꿔 넣기와 다른 참조로 같은 키 넣기 모두 막힌다. REPLACE가 옛 줄을 지우고 새 참조를 들이는 길도 없다.
    for (const verb of ["INSERT", "INSERT OR REPLACE", "INSERT OR IGNORE"]) {
      expect(() => insert(verb, id()), verb).toThrow();
      expect(() => insert(verb, first.ref), verb).toThrow();
    }
    expect(() => raw.run(`DELETE FROM tool_requests WHERE ref = '${first.ref}'`)).toThrow();
    expect(() => raw.run(`UPDATE tool_requests SET owner = '${B}' WHERE ref = '${first.ref}'`)).toThrow();
    expect(() => raw.run(`UPDATE tool_requests SET dedupe_key = 'other' WHERE ref = '${first.ref}'`)).toThrow();
    expect(raw.query("SELECT ref, input_digest FROM tool_requests").all()).toEqual([{ ref: first.ref, input_digest: D1 }]);
  } finally {
    raw.close();
  }
});

test("취소 접수: 자기 대기 부탁만 not_started가 되고, 남의 줄과 없는 줄은 같은 거절이며, 끝난 부탁은 already_ended다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  owners(ledger);
  const p = ports(ledger, refs());
  const ref = (handleToolCall("start_worker", startArgs(), ctx(A), p) as { ref: string }).ref;
  const theirs = must(ledger.recordToolRequest(request(B, keyOf(B)))).request;
  // 소유는 취소 트랜잭션 안에서 다시 본다: 처리기를 거치지 않은 남의 취소도 없는 줄과 같은 거절이다.
  const foreign = ledger.cancelToolRequest({ owner: A, ref: theirs.ref, sessionId: SESSION.id, callId: id(), now: NOW });
  expect(foreign).toEqual(ledger.cancelToolRequest({ owner: A, ref: MISSING, sessionId: SESSION.id, callId: id(), now: NOW }));
  expect(foreign).toEqual({ ok: false, reason: "unknown_run" });
  expect(ledger.readToolRequest({ owner: B, ref: theirs.ref })).toMatchObject({ known: true, value: { phase: "waiting_assignment" } });

  expect(handleToolCall("cancel_worker", { ref }, ctx(A), p)).toEqual({ outcome: "ok", tool: "cancel_worker", ref, cancel: "accepted", phase: "not_started" });
  expect(handleToolCall("cancel_worker", { ref }, ctx(A), p)).toEqual(refused("cancel_worker", "already_ended"));
  expect(handleToolCall("worker_status", { ref }, ctx(A), p)).toEqual({ outcome: "ok", tool: "worker_status", ref, phase: "not_started" });
  // 같은 부탁을 다시 내면 새 줄이 아니라 취소된 그 줄이다(재시도 키는 논리 요청과 목적으로만 만든다).
  expect(handleToolCall("start_worker", startArgs(), ctx(A), p)).toEqual({ outcome: "ok", tool: "start_worker", ref, phase: "not_started" });
  // 취소는 닫는 기록이라 정지 중에도 적힌다(처리기는 정지 중 호출을 문맥에서 먼저 거절한다).
  must(ledger.applyStop({ generation: 1, stopped: true, now: NOW }));
  expect(ledger.cancelToolRequest({ owner: B, ref: theirs.ref, sessionId: SESSION.id, callId: id(), now: NOW + 1 })).toEqual({ ok: true, phase: "not_started" });
  ledger.close();
  expect(rows(path, "SELECT owner, phase, cancelled_at, cancel_session_id FROM tool_requests ORDER BY owner")).toEqual([
    { owner: A, phase: "not_started", cancelled_at: NOW, cancel_session_id: SESSION.id },
    { owner: B, phase: "not_started", cancelled_at: NOW + 1, cancel_session_id: SESSION.id },
  ]);
});

test("기록의 입력: 소유자는 접수한 입력이어야 하고, 칸마다 좁은 꼴만 받으며, 처리기의 꼴과 같다", () => {
  const ledger = ready(open(tempPath()));
  owners(ledger);
  // 접수하지 않은 논리 요청은 소유자가 될 수 없다(외래 키).
  expect(ledger.recordToolRequest(request(MISSING, keyOf(MISSING)))).toEqual({ ok: false, reason: "invariant_violation" });
  expect(ledger.findToolRequest({ owner: MISSING, dedupeKey: keyOf(MISSING) })).toEqual({ known: true, value: null });
  for (const bad of [
    { ref: "short" },
    { owner: "not-a-uuid" },
    { role: "operator" },
    { purpose: "Diagnose" },
    { sourceRef: "https://example.invalid/x" },
    { inputDigest: "abc" },
    { sessionId: "has space" },
    { callId: "x" },
    { now: 0 },
  ] as Partial<ToolRequestInput>[]) {
    expect(() => ledger.recordToolRequest(request(A, keyOf(A), bad)), JSON.stringify(bad)).toThrow(LedgerInputError);
  }
  expect(() => ledger.recordToolRequest({ ...request(A, keyOf(A)), brief: "자유 글" } as ToolRequestInput)).toThrow(LedgerInputError);
  expect(() => ledger.recordToolRequest({ ...request(A, keyOf(A)), executorId: "executor/diagnosis/0/store-a" } as ToolRequestInput)).toThrow(LedgerInputError);
  expect(() => ledger.readToolRequest({ owner: A, ref: "short" })).toThrow(LedgerInputError);
  expect(ledger.findToolRequest({ owner: A, dedupeKey: keyOf(A) })).toEqual({ known: true, value: null });
  // 장부가 받는 목적·세션 꼴은 처리기가 인자와 문맥에서 받는 꼴과 같다.
  expect([PURPOSE.source, PURPOSE.flags]).toEqual([PATTERNS.purpose.source, PATTERNS.purpose.flags]);
  expect([REF.source, REF.flags]).toEqual([PATTERNS.sessionId.source, PATTERNS.sessionId.flags]);
  // 배정 전 부탁의 단계는 처리기의 단계 이름 안에 있다.
  for (const phase of TOOL_REQUEST_PHASES) expect(PHASES as readonly string[]).toContain(phase);
});

test("실행에 이은 부탁: 취소된 부탁과 두 번째 잇기는 제약이 막고, 이어진 줄의 단계는 이은 실행 줄의 상태다", () => {
  const path = tempPath();
  const ledger = ready(open(path));
  owners(ledger);
  const request = must(ledger.recordToolRequest(requestOf(A))).request;
  const cancelled = must(ledger.recordToolRequest(requestOf(B))).request;
  must(ledger.cancelToolRequest({ owner: B, ref: cancelled.ref, sessionId: SESSION.id, callId: id(), now: NOW }));
  const runId = must(ledger.admitRun(worker())).run.runId;
  ledger.close();
  // 잇기를 장부 밖의 SQL로 해도 제약은 같다: 취소된 부탁은 잇지 못하고, 이은 부탁을 다른 실행으로 바꿔 잇지 못한다.
  // 잇는 연산(assignToolRequest)은 test/ledger/tool-request-assign.test.ts가 본다.
  const raw = new Database(path);
  try {
    expect(() => raw.run(`UPDATE tool_requests SET run_id = '${runId}' WHERE ref = '${cancelled.ref}'`)).toThrow();
    raw.run(`UPDATE tool_requests SET run_id = '${runId}' WHERE ref = '${request.ref}'`);
    expect(() => raw.run(`UPDATE tool_requests SET run_id = '${id()}' WHERE ref = '${request.ref}'`)).toThrow();
  } finally {
    raw.close();
  }
  const reopened = ready(open(path));
  expect(reopened.readToolRequest({ owner: A, ref: request.ref })).toEqual({ known: true, value: { ...request, phase: "queued" } });
  expect(reopened.health()).toEqual({ writable: true });
});

test("표: 원문·자격·모델 이름·실행기 ID·경로 칸이 없고, 실행에 잇는 자리는 비어 있는 칸 하나다", () => {
  const path = tempPath();
  open(path).close();
  const columns = (rows(path, "PRAGMA table_info(tool_requests)") as { name: string }[]).map((c) => c.name);
  expect(columns).toEqual([
    "ref",
    "owner",
    "dedupe_key",
    "role",
    "purpose",
    "source_ref",
    "input_digest",
    "session_id",
    "call_id",
    "phase",
    "run_id",
    "created_at",
    "cancelled_at",
    "cancel_session_id",
    "cancel_call_id",
  ]);
  expect(columns.filter((c) => /executor|account|credential|model|path|brief|auth|deadline|budget/.test(c))).toEqual([]);
});

test("이관 전 판(지금 main)으로 만든 장부를 열면 판이 올라가고 기존 기록은 그대로다", () => {
  expect(TOOL_REQUEST_VERSION).toBeGreaterThan(1);
  const before = loadMigrations().slice(0, TOOL_REQUEST_VERSION - 1);
  const path = tempPath();
  const old = ready(open(path, { migrations: before }));
  owners(old);
  const run = must(old.admitRun(worker({ inputRequestId: A }))).run;
  old.close();
  expect(rows(path, "SELECT name FROM sqlite_master WHERE name = 'tool_requests'")).toEqual([]);

  const upgraded = openLedger(path, { clock, mode: "reopen" });
  expect(upgraded).toMatchObject({ ok: true, migrated: { from: TOOL_REQUEST_VERSION - 1, to: loadMigrations().length } });
  if (!upgraded.ok) return;
  const ledger = ready(upgraded.ledger);
  try {
    expect(ledger.getRun(run.runId)).toMatchObject({ known: true, value: { runId: run.runId, state: "queued" } });
    expect(ledger.listInputs()).toMatchObject({ known: true, value: [{ requestId: A }, { requestId: B }] });
    expect(handleToolCall("start_worker", startArgs(), ctx(A), ports(ledger, refs()))).toEqual({
      outcome: "ok",
      tool: "start_worker",
      ref: "cccccccc-0000-4000-8000-000000000001",
      phase: "waiting_assignment",
    });
  } finally {
    ledger.close();
  }

  // 판 목록을 이 판 앞에서 끊어 연 장부(시험용 길)는 틀린 값을 내지 않고 쓸 수 없음으로 닫힌다.
  const truncated = ready(open(tempPath(), { migrations: before }));
  owners(truncated);
  expect(truncated.recordToolRequest(request(A, keyOf(A)))).toEqual({ ok: false, reason: "ledger_unwritable" });
  expect(truncated.findToolRequest({ owner: A, dedupeKey: keyOf(A) })).toMatchObject({ known: false });
});
