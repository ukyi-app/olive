import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { openLedger } from "../../src/ledger/index.ts";
import { clock, digest, id, must, NOW, open, ready, startedWorker, tempPath, worker } from "./helpers.ts";

test("못 씀: DB 오류(주입)면 새 실행 0건이고 읽기 실패는 모름으로 돌아온다", () => {
  let fail: string | null = null;
  const ledger = open(tempPath(), {
    faults: {
      at(point) {
        if (point === fail) throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
      },
    },
  });
  const { runId, from } = startedWorker(ledger);
  const queued = must(ledger.admitRun(worker())).run;
  fail = "read";
  expect(ledger.getRun(runId)).toEqual({ known: false, reason: "io" });
  expect(ledger.readStop()).toEqual({ known: false, reason: "io" });
  expect(() => ledger.runGeneration(runId)).toThrow("ledger unavailable");
  fail = null;
  expect(ledger.health()).toEqual({ writable: false, reason: "io" });
  expect(ledger.slotFree("worker")).toEqual({ known: false, reason: "io" });
  expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "ledger_unwritable" });
  expect(ledger.startRun({ runId: queued.runId, requestId: id(), stopGeneration: 0, now: NOW })).toEqual({ ok: false, reason: "ledger_unwritable" });
  expect(ledger.enqueueInput({ requestId: id(), source: "discord", sourceRef: { ref: `inputs/${id()}`, expiresAt: NOW + 1 }, receivedAt: NOW })).toEqual({ ok: false, reason: "ledger_unwritable" });
  expect(ledger.intakeOpen()).toBe(false);
  // 진행 중인 종료의 기록은 계속한다.
  expect(ledger.recordStopInstruction({ runId, requestId: id(), action: "task_cancel", stopGeneration: 0, now: NOW })).toMatchObject({ ok: true, run: { state: "stopping" } });
  expect(ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId, exit: "cancelled", bodyDigest: digest("s"), now: NOW }, from)).toMatchObject({ ok: true });
});

test("못 씀: 디스크 가득(max_page_count로 주입)이면 새 실행 0건", () => {
  const ledger = open(tempPath(), {
    faults: {
      at() {},
      onOpen(db: Database) {
        const pages = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
        db.run(`PRAGMA max_page_count = ${pages}`);
      },
    },
  });
  ready(ledger);
  let reason: string | undefined;
  for (let i = 0; i < 200 && reason === undefined; i++) {
    const result = ledger.admitRun(worker({ dedupeKey: `k-${i}-${"x".repeat(150)}` }));
    if (!result.ok) reason = result.reason;
  }
  expect(reason).toBe("ledger_unwritable");
  expect(ledger.health()).toEqual({ writable: false, reason: "full" });
  expect(ledger.admitRun(worker())).toEqual({ ok: false, reason: "ledger_unwritable" });
  expect(ledger.slotFree("worker")).toEqual({ known: false, reason: "full" });
});

test("못 씀: 깨진 파일이면 열지 않는다(장부 객체가 없으니 새 실행 0건)", () => {
  const path = tempPath();
  writeFileSync(path, Buffer.alloc(4096, 0x41));
  expect(openLedger(path, { clock, mode: "reopen" })).toMatchObject({ ok: false, reason: "corrupt" });
});

test("못 씀: 닫은 장부는 읽기가 모름이고 쓰기는 거절한다", () => {
  const ledger = open(tempPath());
  ledger.close();
  expect(ledger.readStop()).toEqual({ known: false, reason: "closed" });
  expect(ledger.applyStop({ generation: 1, stopped: true, now: NOW })).toEqual({ ok: false, reason: "ledger_unwritable" });
});
