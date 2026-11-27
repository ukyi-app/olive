// 관리자가 파드 교체로 닫은 실행의 버림 확정(D-159의 C-2). 감독은 그 실행(not_started + 근거)에도 outcome failed의 확정을 한 번 적어
// 보내고, 답이 없으면 같은 요청 ID로 다시 보내며, 정리 영수증을 받으면 다시 적지도 보내지도 않는다. 실행기는 그 확정으로 저장소에 남은
// 기록을 정리해 finalized로 맺고, 감독 장부는 닫힌 실행의 늦은 정리 영수증을 ack로 마친다.
// 장부는 실제 파일, 수명·재전송 박자는 실제 부품, 내보내기는 기록만 하는 가짜다. 끝의 시험은 실제 실행기와 감독의 답 처리를 잇는다.
// 파드 이름·ID·digest·시각은 이 시험이 지어낸 값이다.
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type Envelope, sealEnvelope, verifyEnvelope } from "../../../src/contract/v1/index.ts";
import type { Ledger } from "../../../src/ledger/index.ts";
import { lifeTick } from "../../../src/supervisor/dispatch/life-loop.ts";
import { resendTick } from "../../../src/supervisor/dispatch/resend.ts";
import { createAnswerEvidenceBook, createAnswerLines } from "../../../src/supervisor/runtime/answers.ts";
import { barrier, executorKeys, fromSupervisor, pause, type Rig, reconnect, rig, start, supervisorKeys, sync } from "../../executor/support.ts";
import { digest, id, must, NOW, open, ready, startedWorker, tempPath, WORKER_EXECUTOR, worker } from "../../ledger/helpers.ts";

const POD = "worker-diagnosis-4c2d-q8mv";
// 시작 지시를 NOW에 낸 실행은 NOW + 31000부터 관리자가 닫을 수 있다.
const LATER = NOW + 60_000;
const POLICY = { renewEveryMs: 10_000, answerTimeoutMs: 20_000 };
const RESEND = { resendEveryMs: 5_000 };

type Started = ReturnType<typeof startedWorker>;

const random = { bytes: (length: number) => crypto.getRandomValues(new Uint8Array(length)) };
const signer = { seal: (input: Parameters<typeof sealEnvelope>[0]) => sealEnvelope(input, supervisorKeys.privateKey) };

// 수명·재전송 박자의 포트. 시계와 정지 세대는 시험이 옮긴다.
function harness(ledger: Ledger) {
  const sent: Envelope[] = [];
  const at = { t: LATER + 1_000, generation: 0 };
  const ports = {
    ledger,
    intake: { intakeOpen: () => ledger.intakeOpen(), stopGeneration: () => at.generation },
    links: { mayIssue: () => ({ ok: true }) as const },
    clock: { now: () => at.t },
    random,
    signer,
    sink: {
      send: async (e: Envelope) => {
        sent.push(e);
        return "sent" as const;
      },
    },
  };
  const life = async () => {
    const l = await lifeTick(ports as never, POLICY, { lastQueries: [], unsentRenews: [] });
    if (l.kind !== "ran") throw new Error(JSON.stringify(l));
    return l.runs;
  };
  const resend = async () => {
    const r = await resendTick(ports as never, RESEND, { lastResends: [] });
    if (r.kind !== "ran") throw new Error(JSON.stringify(r));
    return r.instructions;
  };
  return { sent, at, life, resend };
}

const accepted = (s: Started, at = NOW) =>
  ({ action: "receipt_accepted" as const, receiptId: id(), runId: s.runId, instructionRequestId: s.requestId, instruction: "task_start" as const, bodyDigest: digest(`accepted:${s.runId}`), now: at });
const cleaned = (s: Started, requestId: string, at: number) =>
  ({ action: "receipt_cleaned" as const, receiptId: id(), runId: s.runId, instructionRequestId: requestId, bodyDigest: digest(`cleaned:${requestId}`), now: at });

// 접수 영수증을 받은 뒤 끊겨 unknown_running이 되고 관리자가 파드 교체로 닫은 실행(D-91의 본래 대상).
function closedAfterAccept(ledger: Ledger): Started {
  const s = startedWorker(ledger);
  must(ledger.applyReceipt(accepted(s), s.from));
  must(ledger.markLostFor({ executorId: WORKER_EXECUTOR, now: NOW + 1 }));
  must(ledger.closeRunByOperator({ runId: s.runId, checkedBy: "pod_replaced", podName: POD, podStartedAt: LATER, now: LATER }));
  return s;
}

// 관리자 닫기 근거(closedByOperator)는 실행 목록(listRuns)에만 실린다.
function listed(ledger: Ledger, runId: string) {
  const runs = ledger.listRuns();
  if (!runs.known) throw new Error("실행 목록을 읽지 못함");
  return runs.value.find((run) => run.runId === runId);
}

const finalizesOf = (sent: Envelope[], runId: string) => sent.filter((e) => e.header.action === "result_finalize" && (e.body as { run_id: string }).run_id === runId);
const forRun = <T,>(items: readonly T[], runId: string) => items.filter((item) => (item as { runId?: unknown }).runId === runId);

test("파드 교체로 닫은 실행: 수명 박자가 outcome failed·stored_at = 닫은 시각의 확정을 한 번 적어 내보내고 다음 박자는 다시 적지 않는다", async () => {
  const ledger = ready(open(tempPath()));
  const s = closedAfterAccept(ledger);
  const h = harness(ledger);
  expect(forRun(await h.life(), s.runId)).toEqual([{ runId: s.runId, outcome: "finalize_sent", requestId: expect.any(String), issuedAt: LATER + 1_000, executorId: WORKER_EXECUTOR }]);
  const [first] = finalizesOf(h.sent, s.runId);
  expect(first?.header).toMatchObject({ recipient: WORKER_EXECUTOR, stop_generation: 0, run_generation: 1 });
  expect(first?.body).toEqual({ run_id: s.runId, outcome: "failed", result_digest: null, stored_at: LATER });
  const read = ledger.closedRunFinalizes();
  expect(read.known && read.value.instructions.map((i) => i.requestId)).toEqual([first?.header.request_id]);
  expect(ledger.getRun(s.runId)).toMatchObject({ known: true, value: { state: "not_started" } });

  h.at.t += 1_000;
  expect(forRun(await h.life(), s.runId)).toEqual([{ runId: s.runId, outcome: "finalize_withheld", reason: "already_recorded" }]);
  expect(finalizesOf(h.sent, s.runId)).toHaveLength(1);
  const times = ledger.instructionTimes(s.runId);
  expect(times.known && times.value?.lastFinalizeAt).toBe(LATER + 1_000);
});

test("재전송 박자가 답 없는 닫힌 실행의 확정을 같은 요청 ID·같은 본문으로 다시 내고, 정리 영수증을 ack한 뒤에는 다시 내지도 새로 적지도 않는다", async () => {
  const ledger = ready(open(tempPath()));
  const s = closedAfterAccept(ledger);
  const h = harness(ledger);
  await h.life();
  const [first] = finalizesOf(h.sent, s.runId) as [Envelope];
  const requestId = first.header.request_id;
  // 간격(5초) 안이면 기다리고, 지나면 다시 낸다. 두 번 다시 낸다.
  expect(forRun(await h.resend(), s.runId)).toMatchObject([{ requestId, outcome: "held" }]);
  for (const step of [5_000, 5_000]) {
    h.at.t += step;
    expect(forRun(await h.resend(), s.runId)).toMatchObject([{ requestId, outcome: "resent", executorId: WORKER_EXECUTOR }]);
  }
  const all = finalizesOf(h.sent, s.runId);
  expect(all).toHaveLength(3);
  expect(new Set(all.map((e) => e.header.request_id))).toEqual(new Set([requestId]));
  for (const e of all) expect(e.body).toEqual(first.body);

  const receipt = cleaned(s, requestId, h.at.t);
  expect(ledger.applyReceipt(receipt, s.from)).toEqual({ ok: true, delivery: "new", ack: receipt.receiptId });
  expect(ledger.applyReceipt(receipt, s.from)).toEqual({ ok: true, delivery: "duplicate", ack: receipt.receiptId });
  expect(ledger.closedRunFinalizes()).toEqual({ known: true, value: { stopGeneration: 0, runs: [], instructions: [] } });
  h.at.t += 60_000;
  expect(forRun(await h.resend(), s.runId)).toEqual([]);
  expect(forRun(await h.life(), s.runId)).toEqual([]);
  expect(finalizesOf(h.sent, s.runId)).toHaveLength(3);
  expect(ledger.getRun(s.runId)).toMatchObject({ known: true, value: { state: "not_started", cleanedReceiptId: null } });
});

test("대상이 아닌 닫힌 실행: 저장소 비움 닫기와 영수증을 받은 적 없는 파드 교체 닫기에는 확정을 적지 않고, 늦은 영수증을 받으면 그때 적는다", async () => {
  const ledger = ready(open(tempPath()));
  // 저장소 비움 닫기(D-158): 종료가 확인된 checking 실행. 실행기 저장소가 비어 정리할 기록이 없다.
  const reset = startedWorker(ledger);
  must(ledger.applyReceipt(accepted(reset), reset.from));
  must(ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: reset.runId, exit: "completed", bodyDigest: digest("stopped"), now: NOW + 1 }, reset.from));
  must(ledger.closeRunByOperator({ runId: reset.runId, checkedBy: "store_reset", podName: POD, podStartedAt: LATER, now: LATER }));
  // 접수 전에 닫은 실행(D-94): 종료 지시만 적힌 stopping에서 영수증 없이 닫았다.
  const silent = startedWorker(ledger);
  must(ledger.recordStopInstruction({ runId: silent.runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW + 1, reason: "requested" }));
  must(ledger.closeRunByOperator({ runId: silent.runId, checkedBy: "pod_replaced", podName: POD, podStartedAt: LATER, now: LATER }));
  for (const s of [reset, silent]) expect(listed(ledger, s.runId)).toMatchObject({ state: "not_started", closedByOperator: true });

  const h = harness(ledger);
  const runs = await h.life();
  expect(forRun(runs, reset.runId)).toEqual([]);
  expect(forRun(runs, silent.runId)).toEqual([]);
  expect(h.sent).toEqual([]);
  expect(ledger.closedRunFinalizes()).toEqual({ known: true, value: { stopGeneration: 0, runs: [], instructions: [] } });

  // 실행기가 그 실행을 알았다는 늦은 영수증을 받으면(닫힌 실행이라 ack만) 다음 박자가 확정을 적는다.
  const late = accepted(silent, LATER + 500);
  expect(ledger.applyReceipt(late, silent.from)).toEqual({ ok: true, delivery: "new", ack: late.receiptId });
  expect(forRun(await h.life(), silent.runId)).toMatchObject([{ outcome: "finalize_sent" }]);
  expect(finalizesOf(h.sent, silent.runId)[0]?.body).toEqual({ run_id: silent.runId, outcome: "failed", result_digest: null, stored_at: LATER });
  expect(finalizesOf(h.sent, reset.runId)).toEqual([]);
});

test("정지 세대를 건너면 지금 세대로 한 건을 앞 본문 그대로 적고, 옛 세대의 확정은 다시 내지 않는다. 한 확정에 답이 오면 끝난다", async () => {
  const ledger = ready(open(tempPath()));
  const s = closedAfterAccept(ledger);
  const h = harness(ledger);
  await h.life();
  const [old] = finalizesOf(h.sent, s.runId) as [Envelope];
  h.at.t = LATER + 10_000;
  h.at.generation = 1;
  must(ledger.mergeStop({ generation: 1, stopped: false }, h.at.t));
  ready(ledger);
  expect(forRun(await h.life(), s.runId)).toMatchObject([{ outcome: "finalize_sent" }]);
  const fresh = finalizesOf(h.sent, s.runId).at(-1) as Envelope;
  expect(fresh.header.request_id).not.toBe(old.header.request_id);
  expect(fresh.header.stop_generation).toBe(1);
  expect(fresh.body).toEqual(old.body);
  h.at.t += 1_000;
  expect(forRun(await h.life(), s.runId)).toEqual([{ runId: s.runId, outcome: "finalize_withheld", reason: "already_recorded" }]);
  h.at.t += 10_000;
  const resent = forRun(await h.resend(), s.runId);
  expect(resent).toMatchObject([
    { requestId: old.header.request_id, outcome: "stop_generation_mismatch", stopGeneration: 0, currentStopGeneration: 1 },
    { requestId: fresh.header.request_id, outcome: "resent" },
  ]);
  // 새 세대 확정의 정리 영수증이 오면 옛 확정은 답이 없어도 대상에서 빠진다.
  must(ledger.applyReceipt(cleaned(s, fresh.header.request_id, h.at.t), s.from));
  h.at.t += 10_000;
  expect(forRun(await h.life(), s.runId)).toEqual([]);
  expect(forRun(await h.resend(), s.runId)).toEqual([]);
  expect(finalizesOf(h.sent, s.runId)).toHaveLength(3);
});

// 감독의 수명·재전송 박자 포트와 답 처리(장부 반영·ack, 실제 부품). forward는 실행기 봉투를 감독 처리기에 넘기고 그 답을
// "ack:new"·"ack:duplicate" 또는 거절 사유로 읽는다. deliverAcks가 참이면 낸 ack를 지금 실행기(current)에 전한다.
function supervisorSide(ledger: Ledger, current: () => Rig) {
  const clock = current().clock;
  const sent: Envelope[] = [];
  const ports = {
    ledger,
    intake: { intakeOpen: () => ledger.intakeOpen(), stopGeneration: () => 0 },
    links: { mayIssue: () => ({ ok: true }) as const },
    clock,
    random,
    signer,
    sink: {
      send: async (e: Envelope) => {
        sent.push(e);
        return "sent" as const;
      },
    },
  };
  let last: unknown;
  const acks: Envelope[] = [];
  const lines = createAnswerLines({
    restorer: () => ports.intake,
    ledger,
    random,
    signer,
    clock,
    wire: {
      answers: { current: () => true },
      writeAck: (_connection: unknown, e: Envelope) => {
        acks.push(e);
        return "sent";
      },
    },
    queries: { pending: () => [], settle: () => {}, dropConnection: () => {} },
    cycle: { noteCandidate: () => {} },
    observationsSettled: () => true,
    observe: (note: { kind: string; outcome?: unknown }) => {
      if (note.kind === "receipt") last = note.outcome;
    },
    evidenceBook: createAnswerEvidenceBook(),
  } as never);
  const forward = async (e: Envelope, deliverAcks = true): Promise<string> => {
    const r = current();
    const v = await verifyEnvelope(e, {
      now: clock.now(),
      expectedRecipient: "supervisor",
      publicKeyFor: (n) => (n === r.worker.name ? executorKeys.publicKey : undefined),
      stopGeneration: 0,
      runGeneration: (rid) => ledger.runGeneration(rid),
      nonces: { consume: () => true },
    });
    if (!v.ok) throw new Error(v.reason);
    last = undefined;
    lines.deliver({ kind: "forward", verified: v, connection: 1 } as never);
    const answer = last as { outcome: string; delivery?: string; reason?: string } | undefined;
    if (answer === undefined) throw new Error("감독 영수증 처리가 끝나지 않음");
    const out = acks.splice(0);
    if (deliverAcks) for (const ack of out) await r.connection.receive(ack);
    return answer.outcome === "ack" ? `ack:${answer.delivery}` : (answer.reason ?? answer.outcome);
  };
  return { sent, ports, forward };
}

const runEvents = (r: Rig, action: string, runId: string) => r.transport.sent.filter((e) => e.header.action === action && (e.body as { run_id: string }).run_id === runId);

// 실제 실행기. 실행이 실패로 끝나(failed_stopped) 종료 영수증이 감독에 닿기 전에 끊기고, 관리자가 파드 교체로 닫았다.
// 실행기 저장소에는 확정되지 않은 기록이 8개(그 실행 + 다른 닫힌 실행 일곱)라 새 시작을 받지 않는다(worker.ts의 refusesStart).
// 감독의 버림 확정으로 그 기록을 정리하면 새 시작을 받는다. 정리 영수증의 ack를 잃고 다시 붙어도 정리는 한 번이다.
test("실제 실행기: 닫힌 실행의 버림 확정으로 정리해 finalized로 맺고, 늦은 정리 영수증은 ack로 끝나며, 다시 붙어도 한 번만 정리하고 새 시작을 받는다", async () => {
  const r = await rig({ mode: "fail" });
  const now = r.clock.now;
  const runId = id();
  // 같은 실행기의 다른 실행 일곱. 감독 쪽에서 닫혀 확정이 오지 않는 기록이다(이 시험의 장부에는 없다).
  for (let i = 0; i < 7; i++) {
    await start(r, { runId: randomUUID() });
    await r.worker.idle();
  }
  const ledger = ready(open(tempPath(), { clock: now }));
  const run = must(ledger.admitRun(worker({ runId, executorId: r.worker.name }))).run;
  const first = await start(r, { runId });
  must(ledger.startRun({ runId, requestId: first.envelope.header.request_id, stopGeneration: 0, now: now() }));
  await r.worker.idle();
  expect(r.store.run(runId)?.state).toBe("failed_stopped");
  expect(r.store.runs().filter((x) => x.state !== "finalized")).toHaveLength(8);

  const { sent, ports, forward } = supervisorSide(ledger, () => r);
  const ofRun = (rig: Rig, action: string) => runEvents(rig, action, runId);

  // 종료 영수증이 닿기 전에 끊겼다: 감독은 접수·시작만 받고 unknown_running으로 옮긴 뒤 관리자가 닫는다.
  for (const action of ["receipt_accepted", "receipt_started"]) expect(await forward(ofRun(r, action)[0] as Envelope)).toBe("ack:new");
  must(ledger.markLostFor({ executorId: r.worker.name, now: now() }));
  r.clock.t = now() + 60_000;
  must(ledger.closeRunByOperator({ runId, checkedBy: "pod_replaced", podName: POD, podStartedAt: now(), now: now() }));
  expect(listed(ledger, runId)).toMatchObject({ state: "not_started", closedByOperator: true });
  // 늦은 종료 영수증(받음 확인이 없어 실행기가 다시 보낸 것)은 닫힌 실행이라 ack만 받는다.
  r.worker.resendUnacked();
  expect(await forward(ofRun(r, "receipt_stopped").at(-1) as Envelope)).toBe("ack:new");
  // 확정되지 않은 기록이 8개라 새 시작을 받지 않는다.
  const refused = await start(r, { runId: randomUUID() });
  expect(r.transport.sent.filter((e) => e.header.action === "receipt_accepted" && (e.body as { run_id: string }).run_id === refused.runId)).toEqual([]);

  const l = await lifeTick(ports as never, POLICY, { lastQueries: [], unsentRenews: [] });
  expect(l.kind === "ran" && forRun(l.runs, runId)).toMatchObject([{ outcome: "finalize_sent", executorId: r.worker.name }]);
  const finalize = sent.find((e) => e.header.action === "result_finalize") as Envelope;
  await r.connection.receive(finalize);
  await r.worker.idle();
  expect(r.store.run(runId)?.state).toBe("finalized");
  expect(r.space.cleaned.filter((x) => x === runId)).toHaveLength(1);
  const [receipt] = ofRun(r, "receipt_cleaned") as [Envelope];
  expect((receipt.body as { instruction_request_id: string }).instruction_request_id).toBe(finalize.header.request_id);

  // 정리 영수증의 ack를 잃었다. 다시 붙으면 실행기는 같은 영수증을 다시 보내고, 감독이 다시 낸 확정에도 다시 지우지 않고 같은 영수증으로 답한다.
  expect(await forward(receipt, false)).toBe("ack:new");
  await reconnect(r, 0);
  r.clock.t = now() + 10_000;
  const rs = await resendTick(ports as never, RESEND, { lastResends: [] });
  // 장부는 그 정리 영수증을 받았으므로 확정을 다시 내지 않는다. 실행기에 같은 확정이 다시 닿아도(감독이 ack 전에 다시 보낸 경우) 다시 지우지 않는다.
  expect(rs.kind === "ran" && forRun(rs.instructions, runId)).toEqual([]);
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "result_finalize", finalize.body as never, { stop_generation: 0, run_generation: run.runGeneration, request_id: finalize.header.request_id }));
  r.worker.resendUnacked();
  const again = ofRun(r, "receipt_cleaned");
  expect(again.length).toBeGreaterThan(0);
  expect(new Set(again.map((e) => (e.body as { receipt_id: string }).receipt_id))).toEqual(new Set([(receipt.body as { receipt_id: string }).receipt_id]));
  for (const e of again) expect(await forward(e)).toBe("ack:duplicate");
  expect(r.space.cleaned.filter((x) => x === runId)).toHaveLength(1);
  expect(r.store.unacked().filter((e) => e.run_id === runId)).toEqual([]);
  expect(ledger.getRun(runId)).toMatchObject({ known: true, value: { state: "not_started", cleanedReceiptId: null } });
  const after = await lifeTick(ports as never, POLICY, { lastQueries: [], unsentRenews: [] });
  expect(after.kind === "ran" && forRun(after.runs, runId)).toEqual([]);

  // 확정되지 않은 기록이 7개가 되어 새 시작을 받는다.
  const next = await start(r, { runId: randomUUID() });
  expect(r.transport.sent.filter((e) => e.header.action === "receipt_accepted" && (e.body as { run_id: string }).run_id === next.runId)).toHaveLength(1);
  await r.worker.idle();
});

// 1번 재현(D-159)이 C-1과 C-2로 닫히는가. 실행기가 남은 수를 모른 채 끝나(unknown_running) 감독도 끊김으로 unknown_running이 되고,
// 관리자가 파드를 바꿔 닫았다. 새 파드의 실행기는 접수한 파드가 다른 그 기록을 다시 세어 failed_stopped로 맺고(C-1), 감독의 버림 확정으로
// 정리해 finalized로 맺는다(C-2). 정리 영수증의 ack 뒤 재전송이 멈추고 새 시작을 받는다.
test("실제 실행기: 다른 파드에서 물려받은 unknown_running을 다시 세어 맺고 버림 확정으로 finalized가 되며, 재전송이 멈추고 새 시작을 받는다", async () => {
  const a = await rig();
  a.cleanup.remaining = null;
  const now = a.clock.now;
  const runId = id();
  const ledger = ready(open(tempPath(), { clock: now }));
  must(ledger.admitRun(worker({ runId, executorId: a.worker.name })));
  const first = await start(a, { runId });
  must(ledger.startRun({ runId, requestId: first.envelope.header.request_id, stopGeneration: 0, now: now() }));
  await a.worker.idle();
  expect(a.store.run(runId)?.state).toBe("unknown_running");
  let current = a;
  const { sent, ports, forward } = supervisorSide(ledger, () => current);
  for (const action of ["receipt_accepted", "receipt_started"]) expect(await forward(runEvents(a, action, runId)[0] as Envelope)).toBe("ack:new");
  must(ledger.markLostFor({ executorId: a.worker.name, now: now() }));
  a.clock.t = now() + 60_000;
  must(ledger.closeRunByOperator({ runId, checkedBy: "pod_replaced", podName: POD, podStartedAt: now(), now: now() }));

  // 새 파드의 실행기: 같은 저장소, 다른 파드 UID. 감독에 붙기 전에 recover가 그 기록을 다시 센다.
  const b = await rig({ dir: a.dir, clock: a.clock, podUid: "6c1d9e2a-4b3f-4a7c-8e5d-0f9a1b2c3d4e", syncTo: null });
  await b.worker.recover();
  await sync(b, 0);
  current = b;
  expect(b.store.run(runId)?.state).toBe("failed_stopped");
  b.worker.resendUnacked();
  const stopped = runEvents(b, "receipt_stopped", runId).at(-1) as Envelope;
  expect(stopped.body).toMatchObject({ remaining_processes: 0, exit: "failed" });
  expect(await forward(stopped)).toBe("ack:new");
  expect(listed(ledger, runId)).toMatchObject({ state: "not_started", stopReceiptId: null });

  const l = await lifeTick(ports as never, POLICY, { lastQueries: [], unsentRenews: [] });
  expect(l.kind === "ran" && forRun(l.runs, runId)).toMatchObject([{ outcome: "finalize_sent", executorId: b.worker.name }]);
  const finalize = sent.find((e) => e.header.action === "result_finalize") as Envelope;
  await b.connection.receive(finalize);
  await b.worker.idle();
  expect(b.store.run(runId)?.state).toBe("finalized");
  const [cleanedReceipt] = runEvents(b, "receipt_cleaned", runId) as [Envelope];
  expect(await forward(cleanedReceipt)).toBe("ack:new");
  expect(b.store.unacked().filter((e) => e.run_id === runId)).toEqual([]);
  a.clock.t = now() + 60_000;
  const rs = await resendTick(ports as never, RESEND, { lastResends: [] });
  expect(rs.kind === "ran" && forRun(rs.instructions, runId)).toEqual([]);
  const after = await lifeTick(ports as never, POLICY, { lastQueries: [], unsentRenews: [] });
  expect(after.kind === "ran" && forRun(after.runs, runId)).toEqual([]);
  expect(sent.filter((e) => e.header.action === "result_finalize")).toHaveLength(1);

  const next = await start(b, { runId: randomUUID() });
  expect(runEvents(b, "receipt_accepted", next.runId)).toHaveLength(1);
  await b.worker.idle();
});

test("실제 실행기: 닫힌 실행의 확정이 새로 접수한 다른 실행의 자격 대기 중에 와도 그 실행은 결과를 내고, 재전송 박자의 같은 요청으로 닫힌 실행을 한 번 정리한다", async () => {
  const r = await rig({ remote: {} });
  const first = await start(r);
  await r.worker.idle();
  const ledger = ready(open(tempPath(), { clock: r.clock.now }));
  const saved = must(ledger.admitRun(worker({ runId: first.runId, executorId: r.worker.name }))).run;
  must(ledger.startRun({ runId: first.runId, requestId: first.envelope.header.request_id, stopGeneration: 0, now: r.clock.now() }));
  must(
    ledger.applyReceipt(
      { action: "receipt_accepted", receiptId: id(), runId: first.runId, instructionRequestId: first.envelope.header.request_id, instruction: "task_start", bodyDigest: digest("accept"), now: r.clock.now() },
      { sender: r.worker.name, runGeneration: saved.runGeneration },
    ),
  );
  must(ledger.markLostFor({ executorId: r.worker.name, now: r.clock.now() + 1 }));
  r.clock.t += 60_000;
  must(ledger.closeRunByOperator({ runId: first.runId, checkedBy: "pod_replaced", podName: POD, podStartedAt: r.clock.now(), now: r.clock.now() }));
  // 감독은 그 실행기에 다른 실행을 이미 접수시켰고, 그 실행은 자격을 기다린다. 그때 닫힌 실행의 확정이 닿는다.
  const take = barrier();
  const sweep = barrier();
  r.credentials.before = take.pass;
  r.space.cleanGate = sweep.pass();
  const next = await start(r);
  await take.entered;
  const h = harness(ledger);
  h.at.t = r.clock.now();
  await h.life();
  const [finalize] = finalizesOf(h.sent, first.runId);
  expect(finalize).toBeDefined();
  // 정리를 예약했다면 지우기가 cleanGate에서 멈춰 있다. 예약하지 않았으면 곧바로 돌아온다.
  const delivered = r.connection.receive(finalize!);
  await Promise.race([delivered, pause(50)]);
  take.open();
  await r.worker.idle();
  const nextState = r.store.run(next.runId)?.state;
  const nextActions = r.store.validEvents(next.runId).map((e) => e.action);
  const cleanedMeanwhile = r.space.cleaned.includes(first.runId);
  sweep.open();
  await delivered;
  expect(cleanedMeanwhile).toBe(false);
  expect(nextState).toBe("ready_result");
  expect(nextActions).toEqual(["receipt_accepted", "receipt_started", "receipt_stopped", "report_result"]);
  // 실행기가 미룬 확정은 답이 없어 재전송 박자가 같은 요청 ID로 다시 낸다. 그 재전송이 한 번 정리한다.
  r.clock.t += RESEND.resendEveryMs;
  h.at.t = r.clock.now();
  expect(forRun(await h.resend(), first.runId)[0]?.outcome).toBe("resent");
  const sentAgain = finalizesOf(h.sent, first.runId);
  expect(sentAgain.map((e) => e.header.request_id)).toEqual([finalize!.header.request_id, finalize!.header.request_id]);
  await r.connection.receive(sentAgain[1]!);
  await r.worker.idle();
  expect(r.store.run(first.runId)?.state).toBe("finalized");
  expect(r.space.cleaned.filter((runId) => runId === first.runId)).toHaveLength(1);
  expect(r.store.validEvents(first.runId).filter((e) => e.action === "receipt_cleaned").map((e) => e.body.instruction_request_id)).toEqual([finalize!.header.request_id]);
});
