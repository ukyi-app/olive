// 조립(boot.ts)이 D-90 박자의 증거 포트를 같은 답 줄의 evidence에 잇는지. 실제 임시 장부·실제 답 줄·실제 박자 다섯을 순서기로 돌리고
// 연결 서버만 가짜다(boot-world.ts). 시한 뒤의 빈 full 인사가 반영되면 박자가 그 실행을 닫고, 오염·대기·번호 변경·연결 바뀜이면 닫지 않는다.
import { describe, expect, test } from "bun:test";
import type { RunStatus } from "../../../src/contract/v1/index.ts";
import type { UnreceivedClosureInput } from "../../../src/ledger/index.ts";
import { lifeTick } from "../../../src/supervisor/dispatch/life-loop.ts";
import { linkLossTick } from "../../../src/supervisor/dispatch/link-loss.ts";
import { resendTick } from "../../../src/supervisor/dispatch/resend.ts";
import { resultCheckTick } from "../../../src/supervisor/dispatch/result-check.ts";
import { assignAndStartTick } from "../../../src/supervisor/dispatch/assign-loop.ts";
import { type UnreceivedPorts, unreceivedTick } from "../../../src/supervisor/dispatch/unreceived.ts";
import type { BootResult, RunningSupervisor } from "../../../src/supervisor/runtime/boot.ts";
import type { Delivered } from "../../../src/supervisor/transport/server.ts";
import { id, must, worker } from "../../ledger/helpers.ts";
import { EXECUTOR, WALL, type World, world } from "./boot-world.ts";

// 시작 지시의 발행은 WALL이다. 인사의 서명 시각은 정각 경계(발행 + 30,000), 답 줄이 넘기는 때와 박자의 장부 시각은 그 뒤다.
const SIGNED = WALL + 30_000;
const PASSED = WALL + 30_005;
const PRINCIPAL = { kind: "worker_executor", role: "diagnosis", instance: "0", storage: "store-a" } as const;

interface Prepared {
  readonly w: World;
  readonly run: RunningSupervisor;
  readonly runId: string;
  readonly closes: UnreceivedClosureInput[];
  // 연결 표에 인사한 연결(실행기의 지금 인정된 연결)을 두고 그 연결의 full 인사를 답 줄에 넘긴다.
  hello(connection: number, runs?: RunStatus[]): void;
  // 연결 서버가 넘긴 검증된 출력 하나.
  deliver(output: Delivered): void;
  // 내보내기 포트의 연결 확인이 보는 그 실행기의 지금 연결.
  recognize(connection: number | null): void;
  // 박자 하나(순서기 → 박자 다섯 → 답 줄 pump).
  beat(): Promise<void>;
  // 장부의 실행 상태와 마지막 박자 보고의 D-90 칸.
  state(): string;
  unreceived(): unknown;
}

// 5단계를 받아들인 감독과, 시작 지시까지 적고 송신 표식을 남긴 작업자 실행 하나(발행 = WALL). 박자 다섯은 실제 것이고 D-90 박자만
// 장부의 닫기 호출을 세려고 그 포트 묶음을 감싼다(묶음 자체는 조립이 넘긴 그대로). during은 D-90 박자가 장부를 읽은 뒤 부르는 전역
// 포트(복원 대기)의 몇 번째 호출에서 부를 것이다: 항목의 재조회(둘째)는 증거를 읽은 뒤다.
async function prepared(during?: { call: number; act: () => void }): Promise<Prepared> {
  const closes: UnreceivedClosureInput[] = [];
  let settledCalls = 0;
  const w = world({
    makers: {
      ticks: {
        linkLoss: linkLossTick,
        resultCheck: resultCheckTick,
        life: lifeTick,
        resend: resendTick,
        assign: assignAndStartTick,
        unreceived: (ports: UnreceivedPorts, now: number) => {
          const ledger = ports.ledger;
          settledCalls = 0;
          const watched: UnreceivedPorts = {
            ...ports,
            ledger: {
              unansweredInstructions: () => ledger.unansweredInstructions(),
              closeUnreceivedRun: (input, from) => {
                closes.push(input);
                return ledger.closeUnreceivedRun(input, from);
              },
            },
            observationsSettled: () => {
              settledCalls += 1;
              if (during !== undefined && settledCalls === during.call) during.act();
              return ports.observationsSettled();
            },
          };
          return unreceivedTick(watched, now);
        },
      },
    },
  });
  const result: BootResult = await w.boot();
  if (!result.ok) throw new Error(`기동하지 못했다: ${result.step} ${result.reason}`);
  await w.time.flush();
  for (let i = 0; i < 20 && !w.events.some((e) => e.event === "restore_step" && e.fields.step === 5); i += 1) await w.time.advance(w.settings.timing.beatEveryMs);
  const ledger = w.opened!;
  const runId = must(ledger.admitRun(worker({ now: WALL, deadlineAt: WALL + 600_000 }))).run.runId;
  const requestId = id();
  must(ledger.startRun({ runId, requestId, stopGeneration: 0, now: WALL }));
  must(ledger.markStartDispatch({ runId, requestId, now: WALL }));

  const rows = new Map<number, { issuedAt: number; runs: RunStatus[] }>();
  let current: number | null = null;
  const server = w.fake.server as unknown as { table: () => unknown; recognized: (executorId: string) => number | null };
  server.recognized = (executorId) => (executorId === EXECUTOR ? current : null);
  server.table = () => {
    const view = new Map(rows);
    return {
      occupancy: () => [],
      candidates: () => [...view.keys()].map((connection) => ({ connection, target: "reader", principal: PRINCIPAL, keyId: "key-1", hello: { profile_revision: "", policy_revision: "policy-1" } })),
      get: (key: number) => {
        const row = view.get(key);
        return row === undefined ? undefined : { id: key, phase: "greeted", sync: { principal: EXECUTOR, generation: 0 }, greeting: { issued_at: row.issuedAt, runs: row.runs } };
      },
    };
  };
  const deliver = (output: Delivered) => w.fake.options!.deliver(output);
  w.wall = PASSED;
  return {
    w,
    run: result.running,
    runId,
    closes,
    hello(connection, runs = []) {
      rows.clear();
      rows.set(connection, { issuedAt: SIGNED, runs });
      current = connection;
      deliver({ kind: "occupancy", connection, answer: { executorId: EXECUTOR, coverage: "full", runs }, issuedAt: SIGNED } as Delivered);
    },
    deliver,
    recognize(connection) {
      current = connection;
    },
    beat: () => w.time.advance(w.settings.timing.beatEveryMs),
    state() {
      const read = ledger.getRun(runId);
      return read.known && read.value !== null ? read.value.state : "unknown";
    },
    unreceived() {
      const beats = w.events.filter((e) => e.event === "beat" && e.fields.kind === "ran");
      const last = beats.at(-1)?.fields;
      return last === undefined ? null : { unreceived: last.unreceived, outcomes: last.unreceivedOutcomes, halted: last.unreceivedHalted };
    },
  };
}

describe("D-90 박자 + 조립이 이은 실제 답 줄", () => {
  test("정상: 시한 뒤의 빈 full 인사가 반영되면 순서기의 박자가 장부를 한 번 불러 그 실행을 닫는다", async () => {
    const p = await prepared();
    p.hello(1);
    expect(p.w.captured.lines!.value.evidence.read(EXECUTOR)).toMatchObject({ known: true, tainted: false, pending: false, lastFull: { connection: 1, principal: EXECUTOR, stopGeneration: 0, runs: [], answeredAt: SIGNED, receivedAt: PASSED } });
    await p.beat();
    expect({ closes: p.closes.length, state: p.state(), beat: p.unreceived() }).toEqual({ closes: 1, state: "not_started", beat: { unreceived: "ran", outcomes: "closed=1", halted: null } });
    expect(p.closes[0]).toEqual({ runId: p.runId, runs: [], answeredAt: SIGNED, receivedAt: PASSED, now: PASSED });
    expect(await p.run.stop()).toBe(0);
  });

  test("오염: 같은 실행기의 영수증을 장부가 받지 않았으면(모르는 실행) 그 뒤 빈 full이 있어도 닫지 않는다", async () => {
    const p = await prepared();
    p.hello(1);
    const header = { sender: EXECUTOR, action: "receipt_accepted", run_generation: 1, stop_generation: 0, body_digest: "e".repeat(64), issued_at: PASSED };
    p.deliver({ kind: "forward", connection: 1, verified: { ok: true, action: "receipt_accepted", header, body: { receipt_id: id(), run_id: id(), instruction: "task_start", instruction_request_id: id() } } } as never);
    expect(p.w.captured.lines!.value.evidence.read(EXECUTOR)).toMatchObject({ known: true, tainted: true });
    await p.beat();
    expect({ closes: p.closes.length, state: p.state(), beat: p.unreceived() }).toEqual({ closes: 0, state: "preparing", beat: { unreceived: "ran", outcomes: "skipped:tainted=1", halted: null } });
    expect(await p.run.stop()).toBe(0);
  });

  test("대기: 같은 연결의 running 보고가 저장되지 않아 밀린 사본으로 남아 있으면 닫지 않는다", async () => {
    const p = await prepared();
    p.hello(1);
    const ledger = p.w.opened!;
    const apply = ledger.applyExecutorAnswer.bind(ledger);
    let fail = 1;
    ledger.applyExecutorAnswer = (input, from) => {
      if (input.coverage === "partial" && fail > 0) {
        fail -= 1;
        throw new Error("답 저장 실패");
      }
      return apply(input, from);
    };
    const read = ledger.getRun(p.runId);
    if (!read.known || read.value === null) throw new Error("실행 없음");
    const runs: RunStatus[] = [{ run_id: p.runId, state: "running", run_generation: read.value.runGeneration, last_receipt_id: null }];
    const query = { requestId: id(), recipient: EXECUTOR, runIds: [p.runId], connection: 1 };
    p.w.captured.queries!.add(query as never);
    const header = { sender: EXECUTOR, action: "status_report", run_generation: 0, body_digest: "d".repeat(64), issued_at: PASSED };
    p.deliver({ kind: "forward", connection: 1, verified: { ok: true, action: "status_report", header, body: { in_reply_to: query.requestId, runs } } } as never);
    expect(p.w.captured.lines!.value.backlog(EXECUTOR).length).toBe(1);
    await p.beat();
    expect({ closes: p.closes.length, state: p.state(), beat: p.unreceived() }).toEqual({ closes: 0, state: "preparing", beat: { unreceived: "ran", outcomes: "skipped:pending=1", halted: null } });
    expect(await p.run.stop()).toBe(0);
  });

  test("번호 변경: 증거를 읽은 뒤 같은 실행기의 새 인사가 줄에 들어오면 그 박자는 닫지 않는다", async () => {
    let inject: (() => void) | null = null;
    const p = await prepared({ call: 2, act: () => inject?.() });
    p.hello(1);
    inject = () => {
      inject = null;
      p.hello(1);
    };
    await p.beat();
    expect({ closes: p.closes.length, state: p.state(), beat: p.unreceived() }).toEqual({ closes: 0, state: "preparing", beat: { unreceived: "ran", outcomes: "skipped:evidence_changed=1", halted: null } });
    expect(await p.run.stop()).toBe(0);
  });

  test("연결 바뀜: 인사한 연결이 그 실행기의 지금 연결이 아니면(새 연결이 밀어냄) 닫지 않는다", async () => {
    const p = await prepared();
    p.hello(1);
    p.recognize(2);
    await p.beat();
    expect({ closes: p.closes.length, state: p.state(), beat: p.unreceived() }).toEqual({ closes: 0, state: "preparing", beat: { unreceived: "ran", outcomes: "skipped:link_not_current=1", halted: null } });
    expect(await p.run.stop()).toBe(0);
  });
});
