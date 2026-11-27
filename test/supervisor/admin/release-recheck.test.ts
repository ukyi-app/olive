// 리뷰 F1~F4의 자리 풀기 경계: 재조회와 쓰기 사이에 바뀐 앞 상태(F1), 쓰기 요청을 다 보낸 뒤 답을 잃음(F2), 다른 실행·명령의 답(F3),
// 확정 outcome을 정할 수 없는 failed_stopped의 다음 행동(F4). 처리기는 실제 임시 장부에 붙인다. 파드 이름·ID·시각은 이 시험이 지어낸 값이다.
import { expect, test } from "bun:test";
import { type Ledger } from "../../../src/ledger/index.ts";
import { failedOutcome } from "../../../src/supervisor/dispatch/life-loop.ts";
import { type AskOutcome, ask, type ClientHandlers, exitFor, requestOf } from "../../../src/supervisor/admin/client.ts";
import { answerLine, createAdminHandlers } from "../../../src/supervisor/admin/commands.ts";
import { ADMIN_LIMITS, type AdminCall, encodeReply, encodeRequest, parseReply, RUN_STATES } from "../../../src/supervisor/admin/protocol.ts";
import { type ReleasePorts, releaseHandler } from "../../../src/supervisor/admin/release.ts";
import { readText } from "../../files.ts";
import { digest, id, must, NOW, open, startedWorker, tempPath } from "../../ledger/helpers.ts";

const POD = "worker-recheck-4c2d-x9kq";
const LATER = NOW + 60_000;
const bytes = (text: string) => new TextEncoder().encode(text).length;
const val = <T,>(read: { known: true; value: T } | { known: false; reason: string }): T => {
  if (!read.known) throw new Error(`읽기 실패: ${read.reason}`);
  return read.value;
};

// 접수·시작 뒤 completed로 종료가 확인된 checking 작업자. cancel이면 사유 없는 취소 지시를 먼저 적는다(확정 outcome 모름).
function checking(ledger: Ledger, cancel = false) {
  const s = startedWorker(ledger);
  const stopReceiptId = id();
  must(ledger.applyReceipt({ action: "receipt_accepted", receiptId: id(), runId: s.runId, instructionRequestId: s.requestId, instruction: "task_start", bodyDigest: digest("accepted"), now: NOW }, s.from));
  must(ledger.applyReceipt({ action: "receipt_started", receiptId: id(), runId: s.runId, instructionRequestId: s.requestId, bodyDigest: digest("started"), now: NOW }, s.from));
  if (cancel) must(ledger.recordStopInstruction({ runId: s.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW }));
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: stopReceiptId, runId: s.runId, exit: "completed", bodyDigest: digest("stop"), now: NOW + 1 }, s.from));
  return { ...s, stopReceiptId };
}

function lost(ledger: Ledger) {
  const s = startedWorker(ledger);
  must(ledger.applyReceipt({ action: "receipt_accepted", receiptId: id(), runId: s.runId, instructionRequestId: s.requestId, instruction: "task_start", bodyDigest: digest("accepted"), now: NOW }, s.from));
  must(ledger.applyReceipt({ action: "receipt_started", receiptId: id(), runId: s.runId, instructionRequestId: s.requestId, bodyDigest: digest("started"), now: NOW }, s.from));
  must(ledger.markLostFor({ executorId: s.from.sender, now: NOW + 1 }));
  return s;
}

const sourcesOf = (ledger: Ledger) => ({
  progress: () => ({ restored: true, alive: true, granted: false }),
  view: (cap: number) => ledger.peekStatus(cap, null),
  now: () => ({ state: "ok" as const, at: LATER }),
});

// 처리기가 부른 장부 멤버를 차례대로 센다.
function portsOf(ledger: Ledger) {
  const calls: string[] = [];
  const track = (key: "closeRunByOperator" | "abandonResult" | "releaseSlotHold" | "peekHolds" | "peekRunState") => (input: never) => {
    calls.push(key);
    return (ledger[key] as (value: unknown) => unknown).call(ledger, input);
  };
  const ports: ReleasePorts = {
    ledger: { closeRunByOperator: track("closeRunByOperator"), abandonResult: track("abandonResult"), releaseSlotHold: track("releaseSlotHold"), peekHolds: track("peekHolds"), peekRunState: track("peekRunState") } as never,
    gate: () => "open",
    note: () => {},
  };
  return { ports, calls };
}

function sendOf(ledger: Ledger) {
  const { ports, calls } = portsOf(ledger);
  const handlers = createAdminHandlers(sourcesOf(ledger), null, ports);
  const send = (request: Record<string, unknown>) => parseReply(answerLine(JSON.stringify(request), handlers, Number.MAX_SAFE_INTEGER).slice(0, -1));
  return { send, handlers, calls };
}

const holdsRun = (send: ReturnType<typeof sendOf>["send"], runId: string) => {
  const reply = send({ command: "holds" });
  if (reply?.kind !== "holds") throw new Error(`holds가 아님: ${JSON.stringify(reply)}`);
  const run = reply.holds.runs.find((row) => row.runId === runId);
  if (run === undefined) throw new Error("holds에 실행 없음");
  return run;
};

test("F1: holds로 checking을 읽은 뒤 결과 검사가 ready_result로 판정하면, 그때 준비한 저장소 비움 닫기는 근거를 쓰지 않고 state_changed다. 다시 읽은 앞 상태로는 닫힌다", () => {
  const ledger = open(tempPath());
  const c = checking(ledger);
  const { send } = sendOf(ledger);
  const report = { reportId: id(), action: "report_result" as const, runId: c.runId, bodyDigest: digest("report"), storedRef: `results/${id()}`, resultDigest: digest("result"), signal: null, now: NOW + 40_000 };
  must(ledger.recordReport(report, c.from));
  const snapshot = holdsRun(send, c.runId);
  expect(snapshot.state).toBe("checking");
  const prepared = { command: "close-store-reset", runId: snapshot.runId, fromState: snapshot.state, podName: POD, podStartedAt: String(NOW + 40_000) };
  must(ledger.markResult({ runId: c.runId, resultDigest: report.resultDigest, reportId: report.reportId, now: NOW + 40_002 }));
  expect(send(prepared)).toEqual({ kind: "refused", reason: "state_changed" });
  expect(ledger.operatorClosure(c.runId)).toEqual({ known: true, value: null });
  expect(val(ledger.getRun(c.runId))?.state).toBe("ready_result");
  expect(val(ledger.settledResult(c.runId))?.storedRef).toBe(report.storedRef);
  // 같은 상태의 명시적 store_reset은 그대로 받는다.
  const again = holdsRun(send, c.runId);
  expect(send({ ...prepared, fromState: again.state })).toEqual({ kind: "release", release: { outcome: "closed", runId: c.runId, released: true, slotFree: true } });
  expect(val(ledger.operatorClosure(c.runId))?.fromState).toBe("ready_result");
});

test("F1: 관리자 닫기도 CLI가 본 앞 상태를 대조한다. 다르면 state_changed이고 근거가 없다. 없는 실행은 장부의 이름(unknown_run)이다", () => {
  const ledger = open(tempPath());
  const l = lost(ledger);
  const { send, calls } = sendOf(ledger);
  const request = { command: "close-unconfirmed", runId: l.runId, fromState: "stopping", podName: POD, podStartedAt: String(NOW + 40_000) };
  expect(send(request)).toEqual({ kind: "refused", reason: "state_changed" });
  expect(calls).toEqual(["peekRunState"]);
  expect(ledger.operatorClosure(l.runId)).toEqual({ known: true, value: null });
  expect(send({ ...request, runId: id(), fromState: "unknown_running" })).toEqual({ kind: "refused", reason: "ledger_refused", refusal: "unknown_run" });
  expect(send({ ...request, fromState: "unknown_running" })).toEqual({ kind: "release", release: { outcome: "closed", runId: l.runId, released: true, slotFree: true } });
  // 앞 상태 읽기와 쓰기는 이웃한다(사이에 다른 장부 호출이 없다). 앞 상태 칸이 꼴 밖이면 장부를 부르지 않는다.
  expect(calls.slice(-3)).toEqual(["peekRunState", "closeRunByOperator", "peekHolds"]);
  const before = calls.length;
  expect(send({ ...request, fromState: "lost" })).toEqual({ kind: "refused", reason: "malformed" });
  expect(calls.length).toBe(before);
});

test("F1: 앞 상태를 읽지 못하면 쓰기를 부르지 않는다. 처리기는 동기 함수라 읽기와 쓰기 사이에 다른 차례가 끼지 않는다", () => {
  const ledger = open(tempPath());
  const l = lost(ledger);
  const { ports } = portsOf(ledger);
  let wrote = 0;
  const failing: ReleasePorts = {
    ...ports,
    ledger: { ...ports.ledger, peekRunState: () => ({ known: false, reason: "io" }) as never, closeRunByOperator: ((input: never) => ((wrote += 1), ledger.closeRunByOperator(input))) as never },
  };
  const handler = releaseHandler("close-unconfirmed", sourcesOf(ledger), failing);
  const reply = handler({ runId: l.runId, fromState: "unknown_running", podName: POD, podStartedAt: String(NOW + 40_000) }, Number.MAX_SAFE_INTEGER);
  expect(reply instanceof Promise).toBe(false);
  expect(reply).toEqual({ kind: "unknown", reason: "ledger_unreadable" });
  expect(wrote).toBe(0);
  expect(ledger.health()).toEqual({ writable: true });
});

test("F1 정적: release.ts에는 await·async·then·마이크로태스크가 없고, 앞 상태 읽기 뒤 쓰기 호출까지 다른 장부 멤버가 없다", async () => {
  const source = (await readText("src/supervisor/admin/release.ts"))
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  expect(/\bawait\b|\basync\b|\.then\s*\(|queueMicrotask|setTimeout|\bPromise\b/.exec(source)).toBeNull();
  const read = source.indexOf("ledger.peekRunState(");
  const call = source.indexOf(".call(ledger, input)");
  expect(read).toBeGreaterThan(0);
  expect(call).toBeGreaterThan(read);
  // 사이에 있는 장부 멤버는 쓰기 함수를 꺼내는 한 줄의 셋뿐이다.
  expect([...source.slice(read + 1, call).matchAll(/\bledger\.([\w$]+)/g)].map((m) => m[1])).toEqual(["abandonResult", "releaseSlotHold", "closeRunByOperator"]);
});

test("F1: 앞 상태 칸을 더한 요청 한 줄은 가장 긴 값에서도 1,024바이트 안이다", () => {
  const longest = RUN_STATES.reduce((a, b) => (b.length > a.length ? b : a));
  const pod = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
  expect(pod.length).toBe(253);
  for (const command of ["close-unconfirmed", "close-store-reset"]) {
    const call = requestOf([command, id(), longest, pod, "9007199254740991"]);
    expect(call, command).not.toBeNull();
    expect(bytes(encodeRequest(call!))).toBeLessThanOrEqual(ADMIN_LIMITS.requestMaxBytes);
  }
  const hold = requestOf(["release-hold", `e${"x".repeat(199)}`, id(), "9007199254740991", "9007199254740991", pod, "9007199254740991"]);
  expect(hold).not.toBeNull();
  expect(bytes(encodeRequest(hold!))).toBeLessThanOrEqual(ADMIN_LIMITS.requestMaxBytes);
});

// 요청 한 줄을 실제 처리기에 넘긴 뒤 답 전달만 바꾸는 대역(리뷰 재현). mode가 답을 정한다.
type Delivery = "closed" | "too_long" | "malformed" | "timeout" | { readonly reply: string };
function deliver(handlers: ReturnType<typeof createAdminHandlers>, mode: Delivery, over: { readonly write?: (bytes: Uint8Array) => number } = {}) {
  let at = 0;
  let fire: (() => void) | null = null;
  return {
    monoNow: () => at,
    setTimer: (_ms: number, run: () => void) => {
      fire = run;
      return () => {};
    },
    connect: async (_path: string, h: ClientHandlers) => ({
      end: () => {},
      write(chunk: Uint8Array) {
        if (over.write !== undefined) return over.write(chunk);
        answerLine(new TextDecoder().decode(chunk).trimEnd(), handlers, Number.MAX_SAFE_INTEGER);
        queueMicrotask(() => {
          if (mode === "closed") h.close();
          else if (mode === "too_long") h.data(new Uint8Array(ADMIN_LIMITS.replyMaxBytes + 1).fill(32));
          else if (mode === "malformed") h.data(new TextEncoder().encode('{"reply":"release"}\n'));
          else if (mode === "timeout") {
            at = ADMIN_LIMITS.clientWaitMs + 1;
            fire?.();
          } else h.data(new TextEncoder().encode(mode.reply));
        });
        return chunk.length;
      },
    }),
  };
}

const abandonCall = (c: { runId: string; stopReceiptId: string }): AdminCall => requestOf(["abandon-result", c.runId, "no_answer", c.stopReceiptId])!;

for (const mode of ["closed", "too_long", "malformed", "timeout"] as const) {
  test(`F2: 결과 포기 요청을 다 보낸 뒤 답을 잃으면(${mode}) 포기는 적혔고 진입점은 write_unknown·1·빈 stdout이다`, async () => {
    const ledger = open(tempPath());
    const c = checking(ledger);
    const { handlers } = sendOf(ledger);
    const call = abandonCall(c);
    const result = exitFor(await ask(call, deliver(handlers, mode)), call);
    expect(val(ledger.resultAbandon(c.runId))?.reason).toBe("no_answer");
    expect(result).toEqual({ code: 1, stdout: "", stderr: `olive admin: 자리 풀기 모름: 장부에 적혔는지 모른다(write_unknown:${mode})\n` });
  });
}

test("F2 대조: 연결 전 실패·다 보내지 못한 요청·읽기 명령의 답 소실·서버의 명시 거절은 지금 사유 그대로다", async () => {
  const ledger = open(tempPath());
  const c = checking(ledger);
  const { handlers } = sendOf(ledger);
  const call = abandonCall(c);
  const noSocket = { ...deliver(handlers, "closed"), connect: async () => Promise.reject(Object.assign(new Error("x"), { code: "ENOENT" })) };
  expect(exitFor(await ask(call, noSocket), call).stderr).toBe("olive admin: 자리 풀기 모름: 감독에 닿지 못했다(no_socket)\n");
  const partial = deliver(handlers, "closed", { write: (chunk) => chunk.length - 1 });
  expect(exitFor(await ask(call, partial), call).stderr).toBe("olive admin: 자리 풀기 모름: 감독의 답을 받지 못했다(write_failed)\n");
  expect(val(ledger.resultAbandon(c.runId))).toBeNull();
  const holds: AdminCall = { command: "holds" };
  expect(exitFor(await ask(holds, deliver(handlers, "closed")), holds).stderr).toBe("olive admin: 자리 목록 모름: 감독의 답을 받지 못했다(closed)\n");
  const refused = deliver(handlers, { reply: encodeReply({ kind: "refused", reason: "ledger_refused", refusal: "report_pending" }) });
  expect(exitFor(await ask(call, refused), call)).toEqual({ code: 1, stdout: "", stderr: "olive admin: 감독이 요청을 거절했다(ledger_refused:report_pending)\n" });
});

test("F3: 쓰기 뒤 다른 실행·다른 명령의 성공 답은 빈 stdout·1·write_unknown이다. 요청과 맞는 답만 0이다", async () => {
  const ledger = open(tempPath());
  const c = checking(ledger);
  const { handlers } = sendOf(ledger);
  const call = abandonCall(c);
  const release = (over: Record<string, unknown>) => ({ reply: encodeReply({ kind: "release", release: { outcome: "abandoned", runId: c.runId, released: false, slotFree: false, ...over } as never }) });
  const mismatched = "olive admin: 자리 풀기 모름: 장부에 적혔는지 모른다(write_unknown:mismatched)\n";
  for (const over of [{ runId: id() }, { outcome: "closed", released: true }, { released: true }, { outcome: "hold_released" }]) {
    const result = exitFor(await ask(call, deliver(handlers, release(over))), call);
    expect(result, JSON.stringify(over)).toEqual({ code: 1, stdout: "", stderr: mismatched });
  }
  // 다른 명령의 답 꼴(holds)도 쓰기 뒤면 적혔는지 모른다.
  const holdsReply = { reply: encodeReply({ kind: "holds", holds: { slotFree: true, runs: [], slotHolds: [], truncated: false } }) };
  expect(exitFor(await ask(call, deliver(handlers, holdsReply)), call)).toEqual({ code: 1, stdout: "", stderr: mismatched });
  expect(exitFor(await ask(call, deliver(handlers, release({}))), call).code).toBe(0);
  // 명령마다 정한 outcome·released: 닫기 closed/true, 점유 풀기 hold_released/true.
  const answer = (outcome: string, runId: string, released: boolean): AskOutcome => ({ kind: "reply", reply: { kind: "release", release: { outcome, runId, released, slotFree: true } as never } });
  const close = requestOf(["close-store-reset", c.runId, "ready_result", POD, "1"])!;
  expect(exitFor(answer("closed", c.runId, true), close).code).toBe(0);
  expect(exitFor(answer("closed", c.runId, false), close).code).toBe(1);
  const hold = requestOf(["release-hold", "executor-1", c.runId, "1", "2", POD, "1"])!;
  expect(exitFor(answer("hold_released", c.runId, true), hold).code).toBe(0);
  expect(exitFor(answer("closed", c.runId, true), hold).code).toBe(1);
  // 요청을 모르면(명령 이름만) 자리 풀기 답을 대조할 수 없어 0을 내지 않는다.
  expect(exitFor(answer("closed", c.runId, true), "close-store-reset")).toMatchObject({ code: 1, stdout: "" });
});

test("F4: 사유 없는 취소와 completed로 확정 outcome을 정할 수 없는 failed_stopped는 wait_cleanup이 아니라 close_store_reset이고, 그 저장소 비움 닫기는 받는다", () => {
  const ledger = open(tempPath());
  const c = checking(ledger, true);
  must(ledger.markResult({ runId: c.runId, resultDigest: null, now: NOW + 3 }));
  const facts = val(ledger.failedStop(c.runId))!;
  expect(facts.stoppedAt).toBe(NOW + 3);
  expect(failedOutcome(facts)).toBeNull();
  const { send } = sendOf(ledger);
  const row = holdsRun(send, c.runId);
  expect([row.state, row.next, row.finalizeSent]).toEqual(["failed_stopped", "close_store_reset", false]);
  expect(send({ command: "close-store-reset", runId: c.runId, fromState: row.state, podName: POD, podStartedAt: String(NOW + 40_000) })).toMatchObject({ kind: "release", release: { outcome: "closed", released: true } });
});

test("F4 대조: 취소가 없어 실패로 확정할 수 있는 failed_stopped는 wait_cleanup이다", () => {
  const ledger = open(tempPath());
  const c = checking(ledger);
  must(ledger.markResult({ runId: c.runId, resultDigest: null, now: NOW + 3 }));
  expect(failedOutcome(val(ledger.failedStop(c.runId))!)).toBe("failed");
  const { send } = sendOf(ledger);
  expect(holdsRun(send, c.runId).next).toBe("wait_cleanup");
});

const MISMATCHED = "olive admin: 자리 풀기 모름: 장부에 적혔는지 모른다(write_unknown:mismatched)\n";

for (const variant of ["slot_free", "test_job_refusal"] as const) {
  test(`G2·G3: 결과 포기가 적힌 뒤 명령별 계약 밖의 답(${variant})은 빈 stdout·1·write_unknown:mismatched다`, async () => {
    const ledger = open(tempPath());
    const c = checking(ledger);
    const { handlers } = sendOf(ledger);
    const call = abandonCall(c);
    // slot_free: 포기한 실행은 failed_stopped로 자리를 쥐므로 slotFree:true는 장부와 어긋난다. test_job_refusal: 자리 풀기의 장부 거절은 refusal이 필수다.
    const reply = variant === "slot_free"
      ? encodeReply({ kind: "release", release: { runId: c.runId, outcome: "abandoned", released: false, slotFree: true } })
      : encodeReply({ kind: "refused", reason: "ledger_refused" });
    const result = exitFor(await ask(call, deliver(handlers, { reply })), call);
    expect(val(ledger.resultAbandon(c.runId))?.reason).toBe("no_answer");
    expect(val(ledger.peekHolds(1)).workerSlotFree).toBe(false);
    expect(result).toEqual({ code: 1, stdout: "", stderr: MISMATCHED });
  });
}

test("G2·G3 대조: 포기의 slotFree false·null, 닫기·점유 풀기의 slotFree 세 값, 이름 있는 장부 거절, test-job의 두 칸 거절은 그대로다", () => {
  const runId = id();
  const abandon = requestOf(["abandon-result", runId, "no_answer", id()])!;
  const close = requestOf(["close-store-reset", runId, "ready_result", POD, "1"])!;
  const unconfirmed = requestOf(["close-unconfirmed", runId, "unknown_running", POD, "1"])!;
  const hold = requestOf(["release-hold", "executor-1", runId, "1", "2", POD, "1"])!;
  const answer = (outcome: string, released: boolean, slotFree: boolean | null): AskOutcome => ({ kind: "reply", reply: { kind: "release", release: { outcome, runId, released, slotFree } as never } });
  for (const slotFree of [false, null]) {
    expect(exitFor(answer("abandoned", false, slotFree), abandon), String(slotFree)).toEqual({ code: 0, stdout: `${JSON.stringify({ schema: "olive-release/v1", outcome: "abandoned", runId, released: false, slotFree })}\n`, stderr: "" });
  }
  expect(exitFor(answer("abandoned", false, true), abandon)).toEqual({ code: 1, stdout: "", stderr: MISMATCHED });
  for (const slotFree of [true, false, null]) {
    expect(exitFor(answer("closed", true, slotFree), close).code, `close ${slotFree}`).toBe(0);
    expect(exitFor(answer("closed", true, slotFree), unconfirmed).code, `unconfirmed ${slotFree}`).toBe(0);
    expect(exitFor(answer("hold_released", true, slotFree), hold).code, `hold ${slotFree}`).toBe(0);
  }
  const bare: AskOutcome = { kind: "reply", reply: { kind: "refused", reason: "ledger_refused" } as never };
  for (const call of [abandon, close, unconfirmed, hold]) expect(exitFor(bare, call), call.command).toEqual({ code: 1, stdout: "", stderr: MISMATCHED });
  const named: AskOutcome = { kind: "reply", reply: { kind: "refused", reason: "ledger_refused", refusal: "report_pending" } };
  expect(exitFor(named, abandon)).toEqual({ code: 1, stdout: "", stderr: "olive admin: 감독이 요청을 거절했다(ledger_refused:report_pending)\n" });
  expect(exitFor(bare, "test-job")).toEqual({ code: 1, stdout: "", stderr: "olive admin: 감독이 요청을 거절했다(ledger_refused)\n" });
  // 자리 풀기의 다른 명시 거절(장부 이름이 없는 사유)은 그대로 거절이다.
  expect(exitFor({ kind: "reply", reply: { kind: "refused", reason: "state_changed" } }, close).stderr).toBe("olive admin: 감독이 요청을 거절했다(state_changed)\n");
});
