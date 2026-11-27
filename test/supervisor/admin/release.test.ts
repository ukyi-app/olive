// 감독 관리 통로의 자리 풀기(D-149 ④, D-156): 읽기 holds와 장부 쓰기마다 명령 하나(close-unconfirmed·abandon-result·close-store-reset·
// release-hold). 처리기는 실제 임시 장부에 붙이고, 결과 포기 뒤의 확정은 지금 수명 박자(lifeTick)로, 정리 영수증은 장부의 applyReceipt로 본다.
// 실제 감독 조립의 포트·문·기록은 끝의 묶음이 본다. 파드 이름·ID·시각은 이 시험이 지어낸 값이다. 운영값이 아니다.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, getRandomValues } from "node:crypto";
import { type Envelope, sealEnvelope } from "../../../src/contract/v1/index.ts";
import { type Ledger, LEDGER_RUN_STATES, openLedger, REFUSALS } from "../../../src/ledger/index.ts";
import { REF } from "../../../src/ledger/input.ts";
import { RESTORE_KEY } from "../../../src/ledger/ledger.ts";
import { type LifeLoopPorts, lifeTick, type RunOutcome } from "../../../src/supervisor/dispatch/life-loop.ts";
import { exitFor, requestOf, USAGE } from "../../../src/supervisor/admin/client.ts";
import { answerLine, createAdminHandlers } from "../../../src/supervisor/admin/commands.ts";
import {
  ADMIN_COMMANDS,
  ADMIN_LIMITS,
  type AdminReply,
  encodeReply,
  encodeRequest,
  HOLDS_SCHEMA,
  LEDGER_REFUSALS,
  type LedgerRefusal,
  parseReply,
  parseRequest,
  RELEASE_COMMANDS,
  RELEASE_FIELDS,
  RELEASE_SCHEMA,
  RUN_STATES,
} from "../../../src/supervisor/admin/protocol.ts";
import { fitHolds, nextFor, type ReleaseNote, type ReleasePorts, RELEASE_LIMITS } from "../../../src/supervisor/admin/release.ts";
import type { AdminClockReading, AdminProgress, AdminSources } from "../../../src/supervisor/admin/status.ts";
import type { RunningSupervisor } from "../../../src/supervisor/runtime/boot.ts";
import { digest, id, must, NOW, open, ready, startedWorker, tempPath, WORKER_EXECUTOR } from "../../ledger/helpers.ts";
import { type World, world } from "../runtime/boot-world.ts";

const POD = "worker-diagnosis-9a1b-z7qp";
// 시작 지시를 NOW에 낸 실행은 NOW + 31000부터 관리자가 닫을 수 있다.
const CLOSABLE_AT = NOW + 31_000;
const LATER = NOW + 60_000;
const keys = generateKeyPairSync("ed25519");
const bytes = (text: string) => new TextEncoder().encode(text).length;

type Started = ReturnType<typeof startedWorker>;

function state(ledger: Ledger, runId: string): string {
  const read = ledger.getRun(runId);
  if (!read.known || read.value === null) throw new Error("실행 없음");
  return read.value.state;
}

function runningRun(ledger: Ledger): Started {
  const s = startedWorker(ledger);
  must(ledger.applyReceipt({ action: "receipt_accepted", receiptId: id(), runId: s.runId, instructionRequestId: s.requestId, instruction: "task_start", bodyDigest: digest("accepted"), now: NOW }, s.from));
  must(ledger.applyReceipt({ action: "receipt_started", receiptId: id(), runId: s.runId, instructionRequestId: s.requestId, bodyDigest: digest("started"), now: NOW }, s.from));
  return s;
}

function stopped(ledger: Ledger, s: Started, exit: "completed" | "failed"): string {
  const receiptId = id();
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId, runId: s.runId, exit, bodyDigest: digest(`stopped:${exit}`), now: NOW + 1 }, s.from));
  return receiptId;
}

// 접수·시작 영수증 뒤 끊겨 unknown_running이 된 실행(D-91의 본래 대상).
function lostRun(ledger: Ledger): Started {
  const s = runningRun(ledger);
  must(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
  expect(state(ledger, s.runId)).toBe("unknown_running");
  return s;
}

function checkingRun(ledger: Ledger): Started & { stopReceiptId: string } {
  const s = runningRun(ledger);
  const stopReceiptId = stopped(ledger, s, "completed");
  expect(state(ledger, s.runId)).toBe("checking");
  return { ...s, stopReceiptId };
}

function holdOutside(ledger: Ledger, at = NOW + 100) {
  const held = must(ledger.holdSlots(RESTORE_KEY, [{ executorId: WORKER_EXECUTOR, runId: id(), kind: "worker", runGeneration: 1, holdsSlot: true, why: "outside_ledger" }], at));
  return held.holds[0]!;
}

// 관리 통로의 읽기 포트(조립의 admin과 같은 꼴). 복원·살아 있음은 progress로, 장부의 상태 읽기는 실제 장부의 peekStatus로 준다.
function sourcesOf(ledger: Ledger, over: { progress?: Partial<AdminProgress>; at?: number; clock?: () => AdminClockReading } = {}): AdminSources {
  return {
    progress: () => ({ restored: true, alive: true, granted: false, ...over.progress }),
    view: (cap) => ledger.peekStatus(cap, null),
    now: over.clock ?? (() => ({ state: "ok", at: over.at ?? LATER })),
  };
}

// 자리 풀기 포트. calls는 처리기가 부른 장부 멤버, notes는 기록 한 줄씩이다.
function portsOf(ledger: Ledger, gate: ReturnType<ReleasePorts["gate"]> = "open") {
  const calls: string[] = [];
  const notes: ReleaseNote[] = [];
  const track =
    <K extends "closeRunByOperator" | "abandonResult" | "releaseSlotHold" | "peekHolds" | "peekRunState">(key: K) =>
    (...args: Parameters<Ledger[K]>) => {
      calls.push(key);
      return (ledger[key] as (...a: unknown[]) => unknown).apply(ledger, args);
    };
  const ports: ReleasePorts = {
    ledger: {
      closeRunByOperator: track("closeRunByOperator"),
      abandonResult: track("abandonResult"),
      releaseSlotHold: track("releaseSlotHold"),
      peekHolds: track("peekHolds"),
      peekRunState: track("peekRunState"),
    } as never,
    gate: () => gate,
    note: (fields) => notes.push(fields),
  };
  return { ports, calls, notes };
}

function ask(sources: AdminSources, ports: ReleasePorts | null, request: Record<string, unknown>, limit = Number.MAX_SAFE_INTEGER): AdminReply | null {
  const line = answerLine(JSON.stringify(request), createAdminHandlers(sources, null, ports), limit);
  expect(line.endsWith("\n")).toBe(true);
  expect(bytes(line)).toBeLessThanOrEqual(ADMIN_LIMITS.replyMaxBytes);
  return parseReply(line.slice(0, -1));
}

// fromState는 CLI가 holds로 본 앞 상태다. 두 닫기는 쓰기 직전에 지금 줄과 견준다(다르면 state_changed).
const closeUnconfirmed = (runId: string, podStartedAt = NOW + 40_000, fromState = "unknown_running") => ({ command: "close-unconfirmed", runId, fromState, podName: POD, podStartedAt: String(podStartedAt) });
const storeReset = (runId: string, fromState: string, podStartedAt = NOW + 40_000) => ({ command: "close-store-reset", runId, fromState, podName: POD, podStartedAt: String(podStartedAt) });
const abandon = (runId: string, stopReceiptId: string, reason = "no_answer") => ({ command: "abandon-result", runId, reason, stopReceiptId });
const releaseHold = (hold: { executorId: string; runId: string; runGeneration: number; observation: number }, podStartedAt = NOW + 1_000) => ({
  command: "release-hold",
  executorId: hold.executorId,
  runId: hold.runId,
  runGeneration: String(hold.runGeneration),
  observation: String(hold.observation),
  podName: POD,
  podStartedAt: String(podStartedAt),
});
const holdsOf = (sources: AdminSources, ports: ReleasePorts) => {
  const reply = ask(sources, ports, { command: "holds" });
  if (reply?.kind !== "holds") throw new Error(`holds가 아님: ${JSON.stringify(reply)}`);
  return reply.holds;
};
const ledgerRefused = (refusal: LedgerRefusal): AdminReply => ({ kind: "refused", reason: "ledger_refused", refusal });

describe("말의 꼴", () => {
  test("명령 표는 자리 풀기 다섯을 더하고, 칸 이름은 장부 연산의 입력 이름이며, 장부의 거절 이름·실행 상태와 같은 목록을 쓴다", () => {
    expect(ADMIN_COMMANDS).toEqual(["status", "test-job", "holds", "close-unconfirmed", "abandon-result", "close-store-reset", "release-hold"]);
    expect(RELEASE_FIELDS).toEqual({
      "close-unconfirmed": ["runId", "fromState", "podName", "podStartedAt"],
      "abandon-result": ["runId", "reason", "stopReceiptId"],
      "close-store-reset": ["runId", "fromState", "podName", "podStartedAt"],
      "release-hold": ["executorId", "runId", "runGeneration", "observation", "podName", "podStartedAt"],
    });
    expect([...LEDGER_REFUSALS]).toEqual([...REFUSALS]);
    expect([...RUN_STATES]).toEqual([...LEDGER_RUN_STATES]);
  });

  test("요청: argv 차례의 값을 문자열 칸으로 싣고 감독이 같은 칸으로 읽는다. 수가 다르거나 빈 값·상한 넘는 줄은 사용법(64)이다", () => {
    const runId = id();
    const call = requestOf(["close-unconfirmed", runId, "unknown_running", POD, "1800000040000"]);
    expect(call).toEqual({ command: "close-unconfirmed", fields: { runId, fromState: "unknown_running", podName: POD, podStartedAt: "1800000040000" } });
    expect(encodeRequest(call!)).toBe(`${JSON.stringify({ command: "close-unconfirmed", runId, fromState: "unknown_running", podName: POD, podStartedAt: "1800000040000" })}\n`);
    expect(parseRequest(encodeRequest(call!).slice(0, -1))).toEqual({ ok: true, command: "close-unconfirmed", args: { runId, fromState: "unknown_running", podName: POD, podStartedAt: "1800000040000" } });
    for (const command of RELEASE_COMMANDS) {
      const values = RELEASE_FIELDS[command].map((field) => `v-${field}`);
      expect(requestOf([command, ...values])?.command, command).toBe(command);
      expect(requestOf([command, ...values.slice(1)]), command).toBeNull();
      expect(requestOf([command, ...values, "extra"]), command).toBeNull();
      expect(requestOf([command, "", ...values.slice(1)]), command).toBeNull();
    }
    expect(requestOf(["holds"])).toEqual({ command: "holds" });
    expect(encodeRequest({ command: "holds" })).toBe('{"command":"holds"}\n');
    expect(requestOf(["holds", "x"])).toBeNull();
    expect(requestOf(["close-unconfirmed", runId, "unknown_running", "p".repeat(1_000), "1"])).toBeNull();
    expect(USAGE.code).toBe(64);
    for (const command of ["holds", ...RELEASE_COMMANDS]) expect(USAGE.stderr).toContain(command);
  });

  test("답: holds·자리 풀기·장부 거절의 꼴이 하나라도 다르면 받지 않는다", () => {
    const runId = id();
    const release = { outcome: "closed", runId, released: true, slotFree: false } as const;
    expect(encodeReply({ kind: "release", release })).toBe(`{"reply":"release","release":{"schema":"${RELEASE_SCHEMA}","outcome":"closed","runId":"${runId}","released":true,"slotFree":false}}\n`);
    expect(parseReply(encodeReply({ kind: "release", release }).slice(0, -1))).toEqual({ kind: "release", release });
    expect(parseReply(encodeReply({ kind: "release", release: { ...release, slotFree: null } }).slice(0, -1))).toEqual({ kind: "release", release: { ...release, slotFree: null } });
    const refused = encodeReply({ kind: "refused", reason: "ledger_refused", refusal: "start_may_launch" });
    expect(refused).toBe('{"reply":"refused","reason":"ledger_refused","refusal":"start_may_launch"}\n');
    expect(parseReply(refused.slice(0, -1))).toEqual(ledgerRefused("start_may_launch"));
    // 시험 작업의 ledger_refused는 칸 없이 그대로다.
    expect(parseReply('{"reply":"refused","reason":"ledger_refused"}')).toEqual({ kind: "refused", reason: "ledger_refused" });
    const run = { runId, kind: "worker", state: "checking", executorId: WORKER_EXECUTOR, runGeneration: 1, accepted: true, finalizeSent: false, closableAt: CLOSABLE_AT, stopReceiptId: id(), next: "abandon_result" } as const;
    const hold = { observation: 3, executorId: WORKER_EXECUTOR, runId: id(), kind: "worker", runGeneration: 1, why: "outside_ledger", heldAt: NOW, next: "release_hold" } as const;
    const holds = { slotFree: false, runs: [run], slotHolds: [hold], truncated: false };
    const line = encodeReply({ kind: "holds", holds }).slice(0, -1);
    expect(JSON.parse(line).holds.schema).toBe(HOLDS_SCHEMA);
    expect(parseReply(line)).toEqual({ kind: "holds", holds });
    for (const bad of [
      '{"reply":"refused","reason":"ledger_refused","refusal":"made_up"}',
      '{"reply":"refused","reason":"busy","refusal":"unknown_run"}',
      `{"reply":"release","release":{"schema":"olive-release/v2","outcome":"closed","runId":"${runId}","released":true,"slotFree":true}}`,
      `{"reply":"release","release":{"schema":"${RELEASE_SCHEMA}","outcome":"opened","runId":"${runId}","released":true,"slotFree":true}}`,
      `{"reply":"release","release":{"schema":"${RELEASE_SCHEMA}","outcome":"closed","runId":"${runId}","released":true,"slotFree":true,"podName":"x"}}`,
      line.replace('"next":"abandon_result"', '"next":"wait"'),
      line.replace('"state":"checking"', '"state":"lost"'),
      line.replace(`"executorId":"${WORKER_EXECUTOR}"`, '"executorId":"-bad"'),
      line.replace('"truncated":false', '"truncated":false,"more":1'),
      line.replace('"closableAt":1800000031000', '"closableAt":"1800000031000"'),
    ]) {
      expect(parseReply(bad), bad).toBeNull();
    }
    // 실행기 ID의 꼴은 장부의 REF와 같다.
    expect(REF.test(WORKER_EXECUTOR) && !REF.test("-bad")).toBe(true);
  });

  test("종료 코드: 자리 풀기·holds는 0이면 stdout 한 줄뿐, 장부 거절은 1이고 stderr에 ledger_refused:<이름>, 복원 전 3, 적혔는지 모름 1", () => {
    const runId = id();
    const release = { outcome: "abandoned", runId, released: false, slotFree: false } as const;
    const abandonCall = requestOf(["abandon-result", runId, "no_answer", id()])!;
    expect(exitFor({ kind: "reply", reply: { kind: "release", release } }, abandonCall)).toEqual({ code: 0, stdout: `${JSON.stringify({ schema: RELEASE_SCHEMA, ...release })}\n`, stderr: "" });
    const holds = { slotFree: true, runs: [], slotHolds: [], truncated: false };
    expect(exitFor({ kind: "reply", reply: { kind: "holds", holds } }, "holds")).toEqual({ code: 0, stdout: `${JSON.stringify({ schema: HOLDS_SCHEMA, ...holds })}\n`, stderr: "" });
    const refusedExit = exitFor({ kind: "reply", reply: { kind: "refused", reason: "ledger_refused", refusal: "pod_started_too_early" } }, "close-unconfirmed");
    expect(refusedExit).toEqual({ code: 1, stdout: "", stderr: "olive admin: 감독이 요청을 거절했다(ledger_refused:pod_started_too_early)\n" });
    expect(exitFor({ kind: "reply", reply: { kind: "unknown", reason: "restore_not_done" } }, "holds").code).toBe(3);
    expect(exitFor({ kind: "reply", reply: { kind: "unknown", reason: "restore_not_done" } }, "release-hold").code).toBe(3);
    expect(exitFor({ kind: "reply", reply: { kind: "unknown", reason: "write_unknown" } }, "close-store-reset")).toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("write_unknown") });
    // 다른 명령의 답은 꼴이 틀린 답이다.
    expect(exitFor({ kind: "reply", reply: { kind: "holds", holds } }, "close-unconfirmed")).toMatchObject({ code: 1, stdout: "" });
    expect(exitFor({ kind: "reply", reply: { kind: "release", release } }, "holds")).toMatchObject({ code: 1, stdout: "" });
    expect(exitFor({ kind: "reply", reply: { kind: "release", release } }, "status")).toMatchObject({ code: 1, stdout: "" });
  });
});

describe("쓰기 처리기: 실제 장부", () => {
  test("close-unconfirmed: unknown_running을 파드 교체 근거로 닫고, 실행이 놓은 자리와 작업자 자리를 따로 싣는다. 기록 한 줄에 파드 이름이 없다", () => {
    const ledger = open(tempPath());
    const lost = lostRun(ledger);
    const { ports, calls, notes } = portsOf(ledger);
    const reply = ask(sourcesOf(ledger), ports, closeUnconfirmed(lost.runId));
    expect(reply).toEqual({ kind: "release", release: { outcome: "closed", runId: lost.runId, released: true, slotFree: true } });
    expect(state(ledger, lost.runId)).toBe("not_started");
    expect(ledger.operatorClosure(lost.runId)).toEqual({
      known: true,
      value: { runId: lost.runId, fromState: "unknown_running", checkedBy: "pod_replaced", podName: POD, podStartedAt: NOW + 40_000, stopGeneration: 0, closedAt: LATER },
    });
    expect(calls).toEqual(["peekRunState", "closeRunByOperator", "peekHolds"]);
    expect(notes).toEqual([{ command: "close-unconfirmed", runId: lost.runId, result: "closed", reason: null, slotFree: true }]);
    expect(JSON.stringify(notes)).not.toContain(POD);
  });

  test("close-unconfirmed: 닫아도 같은 종류의 점유 관측이 있으면 released는 true, slotFree는 false다", () => {
    const ledger = open(tempPath());
    const lost = lostRun(ledger);
    holdOutside(ledger);
    const { ports } = portsOf(ledger);
    expect(ask(sourcesOf(ledger), ports, closeUnconfirmed(lost.runId))).toEqual({ kind: "release", release: { outcome: "closed", runId: lost.runId, released: true, slotFree: false } });
  });

  test("close-unconfirmed의 거절: 장부의 거절 이름을 그대로 싣고 상태는 그대로다", () => {
    const ledger = open(tempPath());
    const lost = lostRun(ledger);
    const { ports, notes } = portsOf(ledger);
    const sources = sourcesOf(ledger);
    // 파드가 한도 전에 떴다.
    expect(ask(sources, ports, closeUnconfirmed(lost.runId, NOW + 1_000))).toEqual(ledgerRefused("pod_started_too_early"));
    // 감독 시계가 아직 한도 전이다.
    expect(ask(sourcesOf(ledger, { at: NOW + 20_000 }), ports, closeUnconfirmed(lost.runId, NOW + 10_000))).toEqual(ledgerRefused("start_may_launch"));
    expect(ask(sources, ports, closeUnconfirmed(id()))).toEqual(ledgerRefused("unknown_run"));
    expect(state(ledger, lost.runId)).toBe("unknown_running");
    // 종료가 확인된 실행(checking)은 stop_confirmed다.
    const ledger2 = open(tempPath());
    const checking = checkingRun(ledger2);
    expect(ask(sourcesOf(ledger2), portsOf(ledger2).ports, closeUnconfirmed(checking.runId, undefined, "checking"))).toEqual(ledgerRefused("stop_confirmed"));
    expect(notes.map((note) => [note.result, note.reason])).toEqual([
      ["refused", "pod_started_too_early"],
      ["refused", "start_may_launch"],
      ["refused", "unknown_run"],
    ]);
  });

  test("파드 시각이 감독 시계보다 늦으면 장부를 부르지 않고 pod_started_later, 파드 이름이 규칙 밖이면 장부의 입력 검사로 malformed다", () => {
    const ledger = open(tempPath());
    const lost = lostRun(ledger);
    const { ports, calls } = portsOf(ledger);
    expect(ask(sourcesOf(ledger), ports, closeUnconfirmed(lost.runId, LATER + 1))).toEqual({ kind: "refused", reason: "pod_started_later" });
    expect(calls).toEqual([]);
    expect(ask(sourcesOf(ledger), ports, { ...closeUnconfirmed(lost.runId), podName: "Bad_Pod" })).toEqual({ kind: "refused", reason: "malformed" });
    expect(calls).toEqual(["peekRunState", "closeRunByOperator"]);
    expect(state(ledger, lost.runId)).toBe("unknown_running");
  });

  test("칸 검사: 모르는 칸·빠진 칸·빈 값·꼴이 틀린 ID·정수·사유는 malformed이고 장부를 부르지 않는다", () => {
    const ledger = open(tempPath());
    const lost = lostRun(ledger);
    const { ports, calls, notes } = portsOf(ledger);
    const sources = sourcesOf(ledger);
    const hold = { executorId: WORKER_EXECUTOR, runId: id(), runGeneration: 1, observation: 1 };
    for (const bad of [
      { ...closeUnconfirmed(lost.runId), extra: "x" },
      { command: "close-unconfirmed", runId: lost.runId, podName: POD },
      { ...closeUnconfirmed(lost.runId), podName: "" },
      { ...closeUnconfirmed(lost.runId), runId: lost.runId.toUpperCase() },
      { ...closeUnconfirmed(lost.runId), podStartedAt: "01" },
      { ...closeUnconfirmed(lost.runId), podStartedAt: "-1" },
      { ...closeUnconfirmed(lost.runId), podStartedAt: "1.5" },
      { ...closeUnconfirmed(lost.runId), podStartedAt: 1800000040000 },
      { ...closeUnconfirmed(lost.runId), podStartedAt: "99999999999999999" },
      abandon(lost.runId, id(), "gave_up"),
      abandon(lost.runId, "not-a-uuid"),
      { ...releaseHold(hold), runGeneration: "x" },
      { ...releaseHold(hold), executorId: "-bad" },
      { command: "holds", extra: "x" },
    ]) {
      expect(ask(sources, ports, bad), JSON.stringify(bad)).toEqual({ kind: "refused", reason: "malformed" });
    }
    // 모르는 명령은 처리기 전에 거절한다.
    expect(ask(sources, ports, { command: "release", runId: lost.runId })).toEqual({ kind: "refused", reason: "unknown_command" });
    expect(calls).toEqual([]);
    expect(notes.every((note) => note.result === "unknown" || note.result === "refused")).toBe(true);
    expect(state(ledger, lost.runId)).toBe("unknown_running");
  });

  test("close-store-reset: 실패 시각이 있는 failed_stopped를 저장소 비움 근거로 닫는다. 종료가 확인되지 않은 실행은 stop_unconfirmed", () => {
    const ledger = open(tempPath());
    const s = runningRun(ledger);
    stopped(ledger, s, "failed");
    expect(state(ledger, s.runId)).toBe("failed_stopped");
    const { ports } = portsOf(ledger);
    expect(ask(sourcesOf(ledger), ports, storeReset(s.runId, "failed_stopped"))).toEqual({ kind: "release", release: { outcome: "closed", runId: s.runId, released: true, slotFree: true } });
    expect(ledger.operatorClosure(s.runId)).toMatchObject({ known: true, value: { checkedBy: "store_reset", fromState: "failed_stopped" } });
    const ledger2 = open(tempPath());
    const lost = lostRun(ledger2);
    expect(ask(sourcesOf(ledger2), portsOf(ledger2).ports, storeReset(lost.runId, "unknown_running"))).toEqual(ledgerRefused("stop_unconfirmed"));
  });

  test("release-hold: 관측 번호·세대를 그대로 넘겨 자리 막기를 내리고, 이미 푼 관측과 관측 전에 뜬 파드는 장부의 이름으로 거절한다", () => {
    const ledger = ready(open(tempPath()));
    const hold = holdOutside(ledger);
    const { ports } = portsOf(ledger);
    const sources = sourcesOf(ledger);
    expect(ask(sources, ports, releaseHold(hold, NOW + 99))).toEqual(ledgerRefused("pod_started_too_early"));
    expect(ask(sources, ports, { ...releaseHold(hold), observation: String(hold.observation + 1) })).toEqual(ledgerRefused("reference_mismatch"));
    expect(ask(sources, ports, releaseHold(hold))).toEqual({ kind: "release", release: { outcome: "hold_released", runId: hold.runId, released: true, slotFree: true } });
    expect(ledger.slotHoldRelease(hold.observation)).toMatchObject({ known: true, value: { podName: POD, podStartedAt: NOW + 1_000, releasedAt: LATER } });
    expect(ask(sources, ports, releaseHold(hold))).toEqual(ledgerRefused("slot_not_held"));
  });

  test("결과 포기 → 수명 박자의 실패 확정 → 실행기의 정리 영수증 → 자리 풀림. holds는 단계마다 다음 행동을 바꿔 싣는다", async () => {
    const ledger = open(tempPath());
    const c = checkingRun(ledger);
    const { ports, notes } = portsOf(ledger);
    const sources = sourcesOf(ledger, { at: NOW + 5_000 });
    const before = holdsOf(sources, ports);
    expect(before).toEqual({
      slotFree: false,
      runs: [{ runId: c.runId, kind: "worker", state: "checking", executorId: WORKER_EXECUTOR, runGeneration: 1, accepted: true, finalizeSent: false, closableAt: CLOSABLE_AT, stopReceiptId: c.stopReceiptId, next: "abandon_result" }],
      slotHolds: [],
      truncated: false,
    });
    // 다른 종료 영수증을 넘기면 버리지 않는다.
    expect(ask(sources, ports, abandon(c.runId, id()))).toEqual(ledgerRefused("reference_mismatch"));
    // holds가 실은 종료 영수증 ID를 그대로 넘긴다.
    expect(ask(sources, ports, abandon(c.runId, before.runs[0]!.stopReceiptId!))).toEqual({ kind: "release", release: { outcome: "abandoned", runId: c.runId, released: false, slotFree: false } });
    expect(ledger.resultAbandon(c.runId)).toEqual({ known: true, value: { runId: c.runId, reason: "no_answer", stopReceiptId: c.stopReceiptId, stopGeneration: 0, abandonedAt: NOW + 5_000 } });
    expect(holdsOf(sources, ports).runs.map((run) => [run.state, run.next, run.finalizeSent, run.stopReceiptId])).toEqual([["failed_stopped", "wait_cleanup", false, null]]);
    // 같은 포기를 다시 부르면 not_checking이다.
    expect(ask(sources, ports, abandon(c.runId, c.stopReceiptId))).toEqual(ledgerRefused("not_checking"));
    const sent: Envelope[] = [];
    const life = await lifeOutcome(ledger, c.runId, NOW + 10_000, sent);
    expect(life).toMatchObject({ outcome: "finalize_sent", executorId: WORKER_EXECUTOR });
    expect(sent.map((e) => e.body)).toEqual([{ run_id: c.runId, outcome: "failed", result_digest: null, stored_at: NOW + 5_000 }]);
    expect(holdsOf(sources, ports).runs.map((run) => [run.state, run.next, run.finalizeSent])).toEqual([["failed_stopped", "wait_cleanup", true]]);
    const requestId = (life as { requestId: string }).requestId;
    must(ledger.applyReceipt({ action: "receipt_cleaned", receiptId: id(), runId: c.runId, instructionRequestId: requestId, bodyDigest: digest(`cleaned:${requestId}`), now: NOW + 10_001 }, c.from));
    expect(state(ledger, c.runId)).toBe("finalized");
    expect(holdsOf(sources, ports)).toEqual({ slotFree: true, runs: [], slotHolds: [], truncated: false });
    expect(notes.map((note) => [note.command, note.result, note.reason])).toEqual([
      ["abandon-result", "refused", "reference_mismatch"],
      ["abandon-result", "abandoned", null],
      ["abandon-result", "refused", "not_checking"],
    ]);
  });

  test("답 대조: 장부의 답이 넘긴 값과 어긋나거나 호출이 던지면 write_unknown, 모르는 거절 이름도 write_unknown이다", () => {
    const ledger = open(tempPath());
    const lost = lostRun(ledger);
    const sources = sourcesOf(ledger);
    const stub = (result: () => unknown): ReleasePorts => ({ ...portsOf(ledger).ports, ledger: { ...portsOf(ledger).ports.ledger, closeRunByOperator: result as never } });
    const real = ledger.closeRunByOperator.bind(ledger);
    expect(ask(sources, stub(() => ({ ok: false, reason: "made_up" })), closeUnconfirmed(lost.runId))).toEqual({ kind: "unknown", reason: "write_unknown" });
    expect(ask(sources, stub(() => ({ ok: true, run: { runId: lost.runId, state: "unknown_running" }, closure: {} })), closeUnconfirmed(lost.runId))).toEqual({ kind: "unknown", reason: "write_unknown" });
    expect(
      ask(
        sources,
        stub(() => {
          throw new Error("io");
        }),
        closeUnconfirmed(lost.runId),
      ),
    ).toEqual({ kind: "unknown", reason: "write_unknown" });
    // 대조군: 실제 장부의 답은 대조를 지난다.
    expect(ask(sources, stub((input?: unknown) => real(input as never)), closeUnconfirmed(lost.runId))).toMatchObject({ kind: "release" });
  });
});

describe("문과 켜는 조건", () => {
  test("복원 5단계 전에는 holds·쓰기 모두 restore_not_done(3)이고 장부를 부르지 않는다. 접수가 닫혀 있어도(허가 없음) 받는다", () => {
    const ledger = open(tempPath());
    const lost = lostRun(ledger);
    const { ports, calls } = portsOf(ledger);
    const early = sourcesOf(ledger, { progress: { restored: false } });
    expect(ask(early, ports, { command: "holds" })).toEqual({ kind: "unknown", reason: "restore_not_done" });
    expect(ask(early, ports, closeUnconfirmed(lost.runId))).toEqual({ kind: "unknown", reason: "restore_not_done" });
    expect(calls).toEqual([]);
    // 조립의 문이 5단계 전이라고 답해도 같다(상태 읽기와 문 사이에 단계가 바뀌지 않는 것을 문이 다시 본다).
    expect(ask(sourcesOf(ledger), portsOf(ledger, "restore_not_done").ports, closeUnconfirmed(lost.runId))).toEqual({ kind: "unknown", reason: "restore_not_done" });
    expect(state(ledger, lost.runId)).toBe("unknown_running");
    // 허가 없음(granted false)·장부 접수 닫힘에서도 받는다.
    expect(ask(sourcesOf(ledger), ports, closeUnconfirmed(lost.runId))).toMatchObject({ kind: "release", release: { outcome: "closed" } });
  });

  test("문: 끝 차례·끝낼 사유는 not_alive, 요청 기한 정각 이후는 late이고 쓰지 않는다. 포트가 없는 처리기 표는 disabled다", () => {
    const ledger = open(tempPath());
    const lost = lostRun(ledger);
    expect(ask(sourcesOf(ledger), portsOf(ledger, "closed").ports, closeUnconfirmed(lost.runId))).toEqual({ kind: "refused", reason: "not_alive" });
    expect(ask(sourcesOf(ledger), portsOf(ledger, "late").ports, closeUnconfirmed(lost.runId))).toEqual({ kind: "refused", reason: "late" });
    expect(ask(sourcesOf(ledger, { progress: { alive: false } }), portsOf(ledger).ports, closeUnconfirmed(lost.runId))).toEqual({ kind: "refused", reason: "not_alive" });
    expect(ask(sourcesOf(ledger, { clock: () => ({ state: "regressed" }) }), portsOf(ledger).ports, closeUnconfirmed(lost.runId))).toEqual({ kind: "unknown", reason: "clock_unavailable" });
    expect(state(ledger, lost.runId)).toBe("unknown_running");
    for (const command of ["holds", ...RELEASE_COMMANDS]) expect(ask(sourcesOf(ledger), null, { command }), command).toEqual({ kind: "refused", reason: "disabled" });
  });
});

describe("holds", () => {
  test("다음 행동은 장부의 앞 상태로 정한다", () => {
    type Facts = { requestedCancel: boolean | null; exit: "completed" | "failed" | "deadline" | "cancelled" | null };
    const row = (state: string, over: Partial<{ kind: string; stopReceiptId: string | null; failedStoppedAt: number | null; failedFacts: Facts | null }> = {}) => ({
      kind: "worker",
      state,
      stopReceiptId: null,
      failedStoppedAt: null,
      failedFacts: null,
      ...over,
    });
    expect(nextFor(row("unknown_running"))).toBe("close_unconfirmed");
    expect(nextFor(row("stopping"))).toBe("close_unconfirmed");
    expect(nextFor(row("stopping", { stopReceiptId: id() }))).toBe("none");
    expect(nextFor(row("checking", { stopReceiptId: id() }))).toBe("abandon_result");
    expect(nextFor(row("ready_result", { stopReceiptId: id() }))).toBe("wait_cleanup");
    expect(nextFor(row("cleanup_pending", { stopReceiptId: id() }))).toBe("wait_cleanup");
    expect(nextFor(row("failed_stopped", { stopReceiptId: id(), failedStoppedAt: NOW, failedFacts: { requestedCancel: false, exit: "failed" } }))).toBe("wait_cleanup");
    // 확정 outcome을 정할 수 없으면(사유 없는 취소·exit 모름) 기다려도 풀리지 않는다: 저장소 비움 닫기로 간다.
    expect(nextFor(row("failed_stopped", { stopReceiptId: id(), failedStoppedAt: NOW, failedFacts: { requestedCancel: null, exit: "completed" } }))).toBe("close_store_reset");
    expect(nextFor(row("failed_stopped", { stopReceiptId: id(), failedStoppedAt: NOW, failedFacts: { requestedCancel: false, exit: null } }))).toBe("close_store_reset");
    expect(nextFor(row("failed_stopped", { stopReceiptId: id(), failedStoppedAt: NOW }))).toBe("close_store_reset");
    // 판 8 전에 실패한 줄(실패 시각 없음)은 장부 초기화로 넘긴다(D-162).
    expect(nextFor(row("failed_stopped", { stopReceiptId: id() }))).toBe("none");
    expect(nextFor(row("preparing"))).toBe("none");
    expect(nextFor(row("running"))).toBe("none");
    expect(nextFor(row("unknown_running", { kind: "session" }))).toBe("none");
  });

  test("실제 장부: unknown_running은 close_unconfirmed와 닫을 수 있는 시각을, 점유 관측은 release_hold와 관측 번호·적은 시각을 싣는다", () => {
    const ledger = open(tempPath());
    const lost = lostRun(ledger);
    const hold = holdOutside(ledger, NOW + 100);
    const holds = holdsOf(sourcesOf(ledger), portsOf(ledger).ports);
    expect(holds).toEqual({
      slotFree: false,
      runs: [{ runId: lost.runId, kind: "worker", state: "unknown_running", executorId: WORKER_EXECUTOR, runGeneration: 1, accepted: true, finalizeSent: false, closableAt: CLOSABLE_AT, stopReceiptId: null, next: "close_unconfirmed" }],
      slotHolds: [{ observation: hold.observation, executorId: WORKER_EXECUTOR, runId: hold.runId, kind: "worker", runGeneration: 1, why: "outside_ledger", heldAt: NOW + 100, next: "release_hold" }],
      truncated: false,
    });
  });

  test("4,096바이트를 넘으면 뒤의 줄부터 빼고 truncated다. 장부 읽기가 상한에서 멈춰도 truncated다", () => {
    const ledger = ready(open(tempPath()));
    const observed = must(
      ledger.holdSlots(
        RESTORE_KEY,
        Array.from({ length: RELEASE_LIMITS.holdsReadCap + 6 }, (_, index) => ({ executorId: `${WORKER_EXECUTOR}-${"x".repeat(150)}`, runId: id(), kind: "worker" as const, runGeneration: index + 1, holdsSlot: true, why: "outside_ledger" as const })),
        NOW,
      ),
    );
    expect(observed.holds.length).toBe(RELEASE_LIMITS.holdsReadCap + 6);
    const holds = holdsOf(sourcesOf(ledger), portsOf(ledger).ports);
    expect(holds.truncated).toBe(true);
    expect(holds.slotHolds.length).toBeGreaterThan(0);
    expect(holds.slotHolds.length).toBeLessThan(RELEASE_LIMITS.holdsReadCap);
    // 앞에서부터 차례대로 남는다(관측 번호 차례).
    expect(holds.slotHolds.map((h) => h.observation)).toEqual(observed.holds.slice(0, holds.slotHolds.length).map((h) => h.observation));
    // 한 줄 더 실으면 상한을 넘는다(뺀 수가 최소다).
    const next = observed.holds[holds.slotHolds.length]!;
    const one = { observation: next.observation, executorId: next.executorId, runId: next.runId, kind: "worker", runGeneration: next.runGeneration, why: "outside_ledger", heldAt: NOW, next: "release_hold" } as const;
    expect(bytes(encodeReply({ kind: "holds", holds: { ...holds, slotHolds: [...holds.slotHolds, one] } }))).toBeGreaterThan(ADMIN_LIMITS.replyMaxBytes);
    // 장부 읽기가 상한에서 멈춘 것만으로도 truncated다.
    expect(fitHolds(true, [], [], true).truncated).toBe(true);
    expect(fitHolds(true, [], [], false).truncated).toBe(false);
    // 장부 읽기는 상한 안(more false)이어도 답 한 줄을 넘겨 뺐으면 truncated다.
    const many = holds.slotHolds.concat(holds.slotHolds);
    const fitted = fitHolds(false, [], many, false);
    expect(fitted.truncated).toBe(true);
    expect(fitted.slotHolds.length).toBeLessThan(many.length);
    expect(bytes(encodeReply({ kind: "holds", holds: fitted }))).toBeLessThanOrEqual(ADMIN_LIMITS.replyMaxBytes);
    // 다 들어가면 빼지 않는다.
    expect(fitHolds(false, [], holds.slotHolds, false)).toEqual({ slotFree: false, runs: [], slotHolds: holds.slotHolds, truncated: false });
  });

  test("읽기 실패는 그 조회만 모름(ledger_unreadable)이고 장부를 고장으로 표시하지 않으며 접수 허가를 버리지 않는다. 같은 고장을 다른 읽기가 만나면 표시한다(대조군)", () => {
    let armed = false;
    const path = tempPath();
    open(path).close();
    const result = openLedger(path, { clock: () => NOW, mode: "reopen", faults: { at: (point: string) => {
      if (armed && point === "read") throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
    } } });
    if (!result.ok) throw new Error(result.reason);
    const ledger = result.ledger;
    try {
      lostRun(ledger);
      expect(ledger.intakeOpen()).toBe(true);
      const { ports } = portsOf(ledger);
      armed = true;
      expect(ask(sourcesOf(ledger), ports, { command: "holds" })).toEqual({ kind: "unknown", reason: "ledger_unreadable" });
      armed = false;
      expect(ledger.health()).toEqual({ writable: true });
      expect(ledger.intakeOpen()).toBe(true);
      expect(holdsOf(sourcesOf(ledger), ports).runs.length).toBe(1);
      // 쓰기 뒤의 자리 읽기가 실패해도 쓰기의 답은 그대로이고 slotFree만 모름이다.
      const failing: ReleasePorts = { ...ports, ledger: { ...ports.ledger, peekHolds: () => ({ known: false, reason: "io" }) as never } };
      const lost = holdsOf(sourcesOf(ledger), ports).runs[0]!;
      expect(ask(sourcesOf(ledger), failing, closeUnconfirmed(lost.runId))).toEqual({ kind: "release", release: { outcome: "closed", runId: lost.runId, released: true, slotFree: null } });
      // 대조군: 같은 고장을 고장 표시하는 읽기가 만나면 장부가 고장이 된다.
      armed = true;
      expect(ledger.listRuns().known).toBe(false);
      armed = false;
      expect(ledger.health().writable).toBe(false);
    } finally {
      ledger.close();
    }
  });
});

// 수명 박자의 포트(test/ledger/operator-release.test.ts와 같은 꼴). 장부는 실제 장부이고 서명·내보내기는 이 시험의 키와 목록이다.
function lifePorts(ledger: Ledger, at: number, sent: Envelope[]): LifeLoopPorts {
  return {
    ledger,
    intake: { intakeOpen: () => ledger.intakeOpen(), stopGeneration: () => 0 },
    links: { mayIssue: () => ({ ok: true }) as never },
    clock: { now: () => at },
    random: { bytes: (length: number) => getRandomValues(new Uint8Array(length)) },
    signer: { seal: (input: Parameters<typeof sealEnvelope>[0]) => sealEnvelope(input, keys.privateKey) },
    sink: {
      send: async (envelope: Envelope) => {
        sent.push(envelope);
        return "sent" as const;
      },
    },
  } as never;
}

async function lifeOutcome(ledger: Ledger, runId: string, at: number, sent: Envelope[]): Promise<RunOutcome> {
  const result = await lifeTick(lifePorts(ledger, at, sent), { renewEveryMs: 10_000, answerTimeoutMs: 20_000 }, { lastQueries: [], unsentRenews: [] });
  if (result.kind !== "ran") throw new Error(`박자가 돌지 않음: ${JSON.stringify(result)}`);
  const outcome = result.runs.find((r) => r.runId === runId);
  if (outcome === undefined) throw new Error(`결과 없음: ${JSON.stringify(result)}`);
  return outcome;
}

describe("실제 감독 조립의 자리 풀기 포트", () => {
  async function boot(): Promise<{ w: World; running: RunningSupervisor }> {
    const w = world();
    const result = await w.boot();
    if (!result.ok) throw new Error(`기동하지 못했다: ${result.step} ${result.reason}`);
    return { w, running: result.running };
  }
  const restoreSteps = (w: World) => w.events.filter((e) => e.event === "restore_step").map((e) => e.fields.step);
  async function untilStep(w: World, step: number): Promise<void> {
    for (let i = 0; i < 20 && !restoreSteps(w).includes(step); i += 1) await w.time.advance(w.settings.timing.beatEveryMs);
    expect(restoreSteps(w)).toContain(step);
  }
  const askRunning = (running: RunningSupervisor, request: Record<string, unknown>) =>
    parseReply(answerLine(JSON.stringify(request), createAdminHandlers(running.admin, running.testJob, running.release), Number.MAX_SAFE_INTEGER).slice(0, -1));

  test("설정 없이(시험 작업 꺼짐) 늘 있고, 5단계 전에는 restore_not_done, 뒤에는 장부의 답이다. 기록 admin_release 한 줄에 파드 이름이 없다", async () => {
    const { w, running } = await boot();
    expect(running.testJob).toBeNull();
    expect(running.release).not.toBeNull();
    await untilStep(w, 4);
    expect(restoreSteps(w)).toEqual([1, 2, 3, 4]);
    // 문은 처리기의 상태 읽기와 따로 5단계를 다시 본다.
    expect(running.release.gate(Number.MAX_SAFE_INTEGER)).toBe("restore_not_done");
    expect(askRunning(running, { command: "holds" })).toEqual({ kind: "unknown", reason: "restore_not_done" });
    const runId = id();
    expect(askRunning(running, closeUnconfirmed(runId))).toEqual({ kind: "unknown", reason: "restore_not_done" });
    await untilStep(w, 5);
    expect(running.release.gate(Number.MAX_SAFE_INTEGER)).toBe("open");
    // 요청 기한 정각 이후는 late다(단조 시각이 0 뒤다).
    expect(running.release.gate(0)).toBe("late");
    expect(askRunning(running, { command: "holds" })).toEqual({ kind: "holds", holds: { slotFree: true, runs: [], slotHolds: [], truncated: false } });
    // 기동 시계(boot-world의 WALL) 뒤의 파드 시각이면 파드 시각 대조를 지나 장부가 판정한다.
    const reply = askRunning(running, { ...closeUnconfirmed(runId), podStartedAt: "1" });
    expect(reply).toEqual(ledgerRefused("unknown_run"));
    const lines = w.events.filter((e) => e.event === "admin_release");
    expect(lines.map((e) => e.fields)).toEqual([
      { command: "close-unconfirmed", runId, result: "unknown", reason: "restore_not_done", slotFree: null },
      { command: "close-unconfirmed", runId, result: "refused", reason: "unknown_run", slotFree: null },
    ]);
    expect(JSON.stringify(lines)).not.toContain(POD);
    await running.stop();
    expect(running.release.gate(Number.MAX_SAFE_INTEGER)).toBe("closed");
  });
});
