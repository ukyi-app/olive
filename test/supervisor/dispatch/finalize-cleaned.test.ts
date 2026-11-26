import { expect, test } from "bun:test";
import { type Envelope, resultDigest, sealEnvelope, verifyEnvelope } from "../../../src/contract/v1/index.ts";
import { lifeTick } from "../../../src/supervisor/dispatch/life-loop.ts";
import { resendTick } from "../../../src/supervisor/dispatch/resend.ts";
import { createAnswerEvidenceBook, createAnswerLines } from "../../../src/supervisor/runtime/answers.ts";
import { executorKeys, fromSupervisor, reconnect, rig, start, supervisorKeys } from "../../executor/support.ts";
import { from, id, must, NOW, open, ready, tempPath, worker } from "../../ledger/helpers.ts";

// 정지 세대를 건너 확정을 다시 낸 실행. 세대를 적용하기 전의 실행기가 옛 세대 확정으로 정리를 예약해 두었으면(정리 실패로 cleanup_pending),
// 실행기는 세대를 맞춘 뒤 받은 새 세대 확정으로 정리를 마치고 두 확정 요청에 각자의 정리 영수증을 낸다(같은 cleaned_at).
// 실제 실행기와 감독의 답 처리(장부 반영·ack·실행기 증거 표시)를 잇는다. 감독이 둘째 영수증을 거절하면 ack가 없어 실행기가 끝없이
// 다시 보내고, 감독은 그 실행기의 증거를 tainted로 표시해 뒤 미접수 작업이 D-90 자동 해제에서 빠진다.
for (const mode of ["complete", "fail"] as const) {
  for (const order of ["current-only", "old-first", "current-first"] as const) {
    const title = order === "current-only" ? "새 확정의 영수증 하나(대조군)" : order === "old-first" ? "옛 요청의 영수증 먼저" : "새 요청의 영수증 먼저";
    test(`${mode === "complete" ? "성공" : "실패"} 실행, ${title}: 정리 영수증마다 ack하고 첫 정리 증거와 실행 상태는 다시 쓰지 않는다`, async () => {
      const r = await rig({ mode });
      const runId = id();
      const now = r.clock.now;
      const w = ready(open(tempPath(), { clock: now }));
      const run = must(w.admitRun(worker({ runId, executorId: r.worker.name }))).run;
      const firstStart = await start(r, { runId });
      must(w.startRun({ runId, requestId: firstStart.envelope.header.request_id, stopGeneration: 0, now: now() }));
      await r.worker.idle();
      let generation = 0;
      const sent: Envelope[] = [];
      const random = { bytes: (length: number) => crypto.getRandomValues(new Uint8Array(length)) };
      const signer = { seal: (input: Parameters<typeof sealEnvelope>[0]) => sealEnvelope(input, supervisorKeys.privateKey) };
      const ports = {
        ledger: w,
        intake: { intakeOpen: () => w.intakeOpen(), stopGeneration: () => generation },
        links: { mayIssue: () => ({ ok: true }) as const },
        clock: r.clock,
        random,
        signer,
        sink: {
          send: async (e: Envelope) => {
            sent.push(e);
            return "sent" as const;
          },
        },
      };
      const verified = async (e: Envelope) => {
        const v = await verifyEnvelope(e, {
          now: now(),
          expectedRecipient: "supervisor",
          publicKeyFor: (n) => (n === r.worker.name ? executorKeys.publicKey : undefined),
          stopGeneration: generation,
          runGeneration: (rid) => w.runGeneration(rid),
          nonces: { consume: () => true },
        });
        if (!v.ok) throw new Error(v.reason);
        return v;
      };
      let last: unknown;
      const acks: Envelope[] = [];
      const lines = createAnswerLines({
        restorer: () => ports.intake,
        ledger: w,
        random,
        signer,
        clock: r.clock,
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
      // 감독 처리기의 답을 "ack:new"·"ack:duplicate" 또는 거절 사유로 읽고, 낸 ack를 실행기에 전한다.
      const forward = async (e: Envelope): Promise<string> => {
        const v = await verified(e);
        last = undefined;
        lines.deliver({ kind: "forward", verified: v, connection: generation + 1 } as never);
        const answer = last as { outcome: string; delivery?: string; reason?: string } | undefined;
        if (answer === undefined) throw new Error("감독 영수증 처리가 끝나지 않음");
        for (const ack of acks.splice(0)) await r.connection.receive(ack);
        return answer.outcome === "ack" ? `ack:${answer.delivery}` : (answer.reason ?? answer.outcome);
      };
      for (const e of r.transport.sent.filter((e) => ["receipt_accepted", "receipt_started", "receipt_stopped"].includes(e.header.action))) {
        expect(await forward(e)).toBe("ack:new");
      }
      if (mode === "complete") {
        const report = r.transport.of("report_result")[0] as Envelope;
        const value = resultDigest((report.body as { result: never }).result);
        const reportId = (report.body as { report_id: string }).report_id;
        must(w.recordReport({ reportId, action: "report_result", runId, bodyDigest: report.header.body_digest, resultDigest: value, storedRef: `results/${id()}`, now: now(), signal: null }, from(run)));
        must(w.markResult({ runId, reportId, resultDigest: value, now: now() }));
      }
      const tick = async () => {
        const l = await lifeTick(ports as never, { renewEveryMs: 10_000, answerTimeoutMs: 20_000 }, { lastQueries: [], unsentRenews: [] });
        if (l.kind !== "ran") throw new Error(JSON.stringify(l));
        return l.runs.find((x) => x.runId === runId) as { outcome: string; reason?: string };
      };
      r.clock.t = NOW + 10_000;
      expect((await tick()).outcome).toBe("finalize_sent");
      const old = sent[0] as Envelope;
      expect((old.body as { outcome: string }).outcome).toBe(mode === "complete" ? "succeeded" : "failed");
      if (order !== "current-only") {
        // 세대 0을 적용한 실행기가 옛 확정을 받았지만 지우기에 실패해 정리 의도(cleanup_pending)만 남았다.
        r.space.cleanResult = false;
        await r.connection.receive(old);
        expect(r.store.run(runId)?.state).toBe("cleanup_pending");
      }
      expect(r.transport.of("receipt_cleaned")).toHaveLength(0);
      r.clock.t = NOW + 12_000;
      generation = 1;
      must(w.mergeStop({ generation, stopped: false }, now()));
      ready(w);
      await reconnect(r, generation);
      r.space.cleanResult = true;
      const cleanCount = r.space.cleaned.length;
      // 세대 1을 적용한 실행기는 옛 세대 확정의 재전송으로 정리하지 않는다.
      await r.connection.receive(
        fromSupervisor(r.clock, r.worker.name, "result_finalize", old.body as never, { stop_generation: 0, run_generation: old.header.run_generation, request_id: old.header.request_id }),
      );
      expect(r.space.cleaned.length).toBe(cleanCount);
      expect(r.transport.of("receipt_cleaned")).toHaveLength(0);
      await reconnect(r, generation);
      const fresh: Envelope[] = [];
      for (const delta of [40_000, 70_000, 100_000]) {
        r.clock.t = NOW + delta;
        const before = sent.length;
        await tick();
        const rs = await resendTick(ports as never, { resendEveryMs: 5_000 }, { lastResends: [] });
        if (rs.kind !== "ran") throw new Error(JSON.stringify(rs));
        const envelopes = sent.slice(before);
        expect(envelopes).toHaveLength(1);
        expect(envelopes[0]?.header.stop_generation).toBe(1);
        expect(envelopes[0]?.body).toEqual(old.body);
        fresh.push(envelopes[0] as Envelope);
      }
      expect(new Set(fresh.map((e) => e.header.request_id)).size).toBe(1);
      const currentId = fresh[0]?.header.request_id as string;
      expect(currentId).not.toBe(old.header.request_id);
      expect(w.slotFree("worker")).toEqual({ known: true, value: false });
      await r.connection.receive(fresh[2] as Envelope);
      expect(r.store.run(runId)?.state).toBe("finalized");
      expect(r.space.cleaned.length).toBe(cleanCount + 1);
      const receipts = r.transport.of("receipt_cleaned");
      const bodies = receipts.map((e) => e.body as { receipt_id: string; instruction_request_id: string; cleaned_at: number });
      expect(bodies.map((b) => b.instruction_request_id)).toEqual(order === "current-only" ? [currentId] : [old.header.request_id, currentId]);
      expect(new Set(bodies.map((b) => b.cleaned_at)).size).toBe(1);
      expect(new Set(bodies.map((b) => b.receipt_id)).size).toBe(receipts.length);
      if (order === "current-first") receipts.reverse();
      const runRow = () => {
        const runs = w.listRuns();
        if (!runs.known) throw new Error("실행 목록을 읽지 못함");
        return runs.value.find((x) => x.runId === runId);
      };
      const answers: string[] = [];
      let firstEvidence: unknown;
      for (const e of receipts) {
        answers.push(await forward(e));
        firstEvidence ??= runRow();
      }
      // 두 순서 모두 영수증마다 새 받은 기록과 ack다. 실행 줄(상태·첫 정리 증거·갱신 시각)은 첫 영수증이 적은 그대로다.
      expect(answers).toEqual(receipts.map(() => "ack:new"));
      const firstId = (receipts[0]?.body as { receipt_id: string }).receipt_id;
      expect(firstEvidence).toMatchObject({ state: "finalized", cleanedReceiptId: firstId });
      expect(runRow()).toEqual(firstEvidence as never);
      expect(w.slotFree("worker")).toEqual({ known: true, value: true });
      expect(r.store.unacked().filter((e) => e.action === "receipt_cleaned")).toEqual([]);
      expect(lines.evidence.read(r.worker.name)).toMatchObject({ tainted: false });
      // 둘째 영수증의 받은 기록이 남아 같은 영수증의 재전송은 같은 id로 다시 ack한다(duplicate).
      expect(await forward(receipts.at(-1) as Envelope)).toBe("ack:duplicate");
      // ack를 받았으니 실행기가 정리 영수증을 다시 보내지 않는다.
      const sentBefore = r.transport.of("receipt_cleaned").length;
      r.clock.advance(10_000);
      r.worker.tick();
      expect(r.transport.of("receipt_cleaned")).toHaveLength(sentBefore);
      expect(lines.evidence.read(r.worker.name)).toMatchObject({ tainted: false });
    });
  }
}
