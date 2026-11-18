// 재시작 복원(supervisor.md §8의 순서 1~5 가운데 장부 쪽). 순서를 강제한다: 앞 단계가 끝나지 않았는데 뒤 단계를 부르면 던진다.
// 복원기는 지시를 보내지 않는다. 무엇을 해야 하는지의 목록을 돌려주고, 보내는 일은 뒤 작업(실제 연결)이 한다.
// 실행기·현관·관측 중계는 아직 없으므로 포트로 받는다. 포트가 던지면(시간 초과 포함) "모름"이다.
//
// 열린 장부(openLedger의 결과)를 받으므로 단일 작성자 잠금은 이미 잡혀 있다. 그 전까지 접수는 닫혀 있다(이 객체가 아직 없다).
import { CONTRACT, queriesAfterReconnect, type RunStatus, runsOutsideLedger } from "../contract/v1/index.ts";
import type { Ledger, Run, StopRecord } from "./ledger.ts";
import { SLOT_FREE } from "./states.ts";

// ---- 포트(뒤 작업이 채운다) ----

// 권위 있는 정지 기록(현관의 정지 기록, §7.6). null은 "기록 없음", 던지면 모름.
export interface StopAuthorityPort {
  latestStop(): Promise<{ generation: number; stopped: boolean } | null>;
}

// 이웃(현관, 관측 중계, 실행기)이 쓰는 계약 판. 던지면 모름.
export interface PeersPort {
  contracts(): Promise<{ peer: string; contract: string }[]>;
}

// 실행기가 알려 준 점유. 검증을 통과한 hello·status_report의 runs만 넘긴다. 던지면 모름.
export interface OccupancyPort {
  occupancy(): Promise<{ executorId: string; runs: RunStatus[] }[]>;
}

// 현관에 작업 ID로 게시 결과를 묻는다. 던지면(시간 초과 포함) 모름이다. "게시 안 됨"으로 바꾸지 않는다.
export interface PublicationPort {
  lookup(frontJobId: string): Promise<{ kind: "confirmed"; outcome: "posted" | "not_posted" } | { kind: "pending" }>;
}

export interface RestorePorts {
  stopAuthority: StopAuthorityPort;
  peers: PeersPort;
  occupancy: OccupancyPort;
  publications: PublicationPort;
}

// ---- 단계의 결과 ----

export interface Step1 {
  stopGeneration: number;
  stopped: boolean;
  // 장부보다 새로운 기록을 포트에서 받아 먼저 적용했는가. 장부·포트 모두 기록이 없어 0을 적었으면 "initialized".
  source: "ledger" | "authority" | "initialized";
}

export interface Step2 {
  // 장부 밖 실행: 종료 대상. 세대는 그 실행을 닫는 지시(task_cancel·session_stop)의 run_generation으로만 쓴다.
  terminate: { executorId: string; runId: string; runGeneration: number; why: "outside_ledger" | "ended_in_ledger" }[];
  contractMismatches: { peer: string; contract: string }[];
}

export interface Step3 {
  // 같은 실행 ID로 상태만 묻는다(새 실행 ID로 다시 보내지 않는다).
  statusQueries: { executorId: string; runIds: string[] }[];
  // 이번 복원이 unknown_running으로 옮긴 실행. 끝났다고 증명될 때까지 슬롯을 막는다.
  markedUnknown: string[];
  // 자리를 쥔 채 남은 실행(상태 그대로).
  blocking: { runId: string; state: Run["state"] }[];
}

export interface Step4 {
  confirmed: string[];
  pending: string[];
  unknown: string[];
}

export interface Step5 {
  intakeMayOpen: boolean;
  closedBecause: ("stopped" | "contract_mismatch" | "ledger_unwritable")[];
  diagnosisPausedUntil: number | null;
  queued: string[];
  budgets: { runId: string; budgetLeft: number }[];
}

export class RestoreOrderError extends Error {
  constructor(step: number, done: number) {
    super(`복원 ${step}단계는 ${step - 1}단계 뒤에만 부른다(끝난 단계: ${done})`);
    this.name = "RestoreOrderError";
  }
}

export class RestoreStepError extends Error {
  constructor(
    readonly step: number,
    readonly cause_: string,
  ) {
    super(`복원 ${step}단계 실패: ${cause_}`);
    this.name = "RestoreStepError";
  }
}

export class Restorer {
  #done = 0;
  #running = false;
  #step1: Step1 | null = null;
  #step2: Step2 | null = null;
  #step5: Step5 | null = null;

  constructor(
    private readonly ledger: Ledger,
    private readonly ports: RestorePorts,
    private readonly clock: () => number,
  ) {}

  // 감독이 VerifyContext.stopGeneration으로 쓰는 값. 1단계가 끝나기 전에는 null이라 맞춤 답과 모든 발급이 닫힌다.
  stopGeneration(): number | null {
    return this.#step1?.stopGeneration ?? null;
  }

  // 새 접수·새 실행·자격 발급을 열어도 되는가. 5단계가 연 뒤에만 true다.
  intakeOpen(): boolean {
    return this.#step5?.intakeMayOpen === true;
  }

  async #step<T>(step: number, fn: () => Promise<T> | T): Promise<T> {
    if (this.#running || this.#done !== step - 1) throw new RestoreOrderError(step, this.#done);
    this.#running = true;
    try {
      const result = await fn();
      this.#done = step;
      return result;
    } finally {
      this.#running = false;
    }
  }

  // 1. 장부의 정지 세대를 읽고, 권위 기록이 더 새로우면 먼저 적용한다. 둘 중 하나라도 모르면 실패하고 null을 유지한다.
  step1(): Promise<Step1> {
    return this.#step(1, async () => {
      const read = this.ledger.readStop();
      if (!read.known) throw new RestoreStepError(1, `장부의 정지 기록을 읽지 못함(${read.reason})`);
      let authority: { generation: number; stopped: boolean } | null;
      try {
        authority = await this.ports.stopAuthority.latestStop();
      } catch (error) {
        throw new RestoreStepError(1, `권위 정지 기록을 모름(${String(error)})`);
      }
      const ledgerStop: StopRecord | null = read.value;
      let source: Step1["source"] = "ledger";
      let target: { generation: number; stopped: boolean } | null = null;
      if (ledgerStop === null && authority === null) {
        target = { generation: 0, stopped: false };
        source = "initialized";
      } else if (authority !== null && (ledgerStop === null || authority.generation > ledgerStop.generation)) {
        target = authority;
        source = "authority";
      } else if (authority !== null && ledgerStop !== null && authority.generation === ledgerStop.generation && authority.stopped && !ledgerStop.stopped) {
        // 같은 세대에서 한쪽이라도 정지면 정지로 둔다. 풀기는 CLI의 순서(§7.6)로만 한다.
        target = authority;
        source = "authority";
      }
      if (target !== null) {
        const written = this.ledger.applyStop({ generation: target.generation, stopped: target.stopped, now: this.clock() });
        if (!written.ok) throw new RestoreStepError(1, `정지 세대를 적지 못함(${written.reason})`);
      }
      const after = this.ledger.readStop();
      if (!after.known || after.value === null) throw new RestoreStepError(1, "적은 정지 기록을 다시 읽지 못함");
      this.#step1 = { stopGeneration: after.value.generation, stopped: after.value.stopped, source };
      return this.#step1;
    });
  }

  // 2. 계약 판을 맞추고 장부의 실행과 실행기의 점유를 대조한다. 장부 밖 실행은 종료 대상이고 장부에 올리지 않는다.
  step2(): Promise<Step2> {
    return this.#step(2, async () => {
      let contracts: { peer: string; contract: string }[];
      let occupancy: { executorId: string; runs: RunStatus[] }[];
      try {
        contracts = await this.ports.peers.contracts();
        occupancy = await this.ports.occupancy.occupancy();
      } catch (error) {
        throw new RestoreStepError(2, `이웃의 판이나 점유를 모름(${String(error)})`);
      }
      const runs = this.ledger.listRuns();
      if (!runs.known) throw new RestoreStepError(2, `장부의 실행을 읽지 못함(${runs.reason})`);
      const byId = new Map(runs.value.map((run) => [run.runId, run]));
      const terminate: Step2["terminate"] = [];
      for (const { executorId, runs: reported } of occupancy) {
        for (const outside of runsOutsideLedger(reported, (runId) => byId.get(runId)?.runGeneration)) {
          terminate.push({ executorId, runId: outside.run_id, runGeneration: outside.run_generation, why: "outside_ledger" });
        }
        // 장부에서는 끝났는데 실행기가 아직 쥐고 있다고 하는 실행도 닫는다. 장부의 상태는 바꾸지 않는다.
        for (const status of reported) {
          const known = byId.get(status.run_id);
          if (known && (known.state === "finalized" || known.state === "not_started") && !["finalized", "not_started", "not_known"].includes(status.state)) {
            terminate.push({ executorId, runId: known.runId, runGeneration: known.runGeneration, why: "ended_in_ledger" });
          }
        }
      }
      this.#step2 = { terminate, contractMismatches: contracts.filter((c) => c.contract !== CONTRACT) };
      return this.#step2;
    });
  }

  // 3. 진행 중이던 실행은 상태를 묻는 대상이다. 다시 실행하지 않는다. 증명되지 않으면 unknown_running으로 슬롯을 막는다.
  step3(): Promise<Step3> {
    return this.#step(3, () => {
      const lost = this.ledger.markLost(this.clock());
      if (!lost.ok) throw new RestoreStepError(3, `진행 중 실행을 unknown_running으로 적지 못함(${lost.reason})`);
      const open = this.ledger.openRuns();
      if (!open.known) throw new RestoreStepError(3, `장부의 실행을 읽지 못함(${open.reason})`);
      const holding = open.value.filter((run) => !SLOT_FREE.includes(run.state));
      const byExecutor = new Map<string, string[]>();
      for (const run of holding) byExecutor.set(run.executorId, [...(byExecutor.get(run.executorId) ?? []), run.runId]);
      const statusQueries: Step3["statusQueries"] = [];
      for (const [executorId, runIds] of byExecutor) {
        for (const query of queriesAfterReconnect(runIds)) statusQueries.push({ executorId, runIds: query.run_ids });
      }
      return { statusQueries, markedUnknown: lost.runIds, blocking: holding.map((run) => ({ runId: run.runId, state: run.state })) };
    });
  }

  // 4. 확정되지 않은 게시는 현관에 작업 ID로 묻는다. 시간 초과·모름은 unknown으로 남는다.
  step4(): Promise<Step4> {
    return this.#step(4, async () => {
      const all = this.ledger.publications();
      if (!all.known) throw new RestoreStepError(4, `게시 연결을 읽지 못함(${all.reason})`);
      const out: Step4 = { confirmed: [], pending: [], unknown: [] };
      for (const publication of all.value.filter((p) => p.state !== "confirmed")) {
        let answer: { kind: "confirmed"; outcome: "posted" | "not_posted" } | { kind: "pending" } | { kind: "unknown" };
        try {
          answer = await this.ports.publications.lookup(publication.frontJobId);
        } catch {
          answer = { kind: "unknown" };
        }
        // 이미 unknown인 것을 현관이 "대기"라고 답해도 pending으로 적는다(현관이 그 작업을 안다는 뜻이다).
        const written = this.ledger.settlePublication(publication.frontJobId, answer, this.clock());
        if (!written.ok) throw new RestoreStepError(4, `게시 결과를 적지 못함(${written.reason})`);
        out[answer.kind].push(publication.frontJobId);
      }
      return out;
    });
  }

  // 5. 예산·일시 중지·대기열을 복원하고, 정지 상태가 아니고 앞 단계가 모두 맞을 때만 접수를 열어도 된다고 낸다.
  step5(): Promise<Step5> {
    return this.#step(5, () => {
      const stop = this.ledger.readStop();
      const pause = this.ledger.readPause();
      const open = this.ledger.openRuns();
      if (!stop.known || stop.value === null || !pause.known || !open.known) throw new RestoreStepError(5, "장부를 읽지 못함");
      const closedBecause: Step5["closedBecause"] = [];
      if (stop.value.stopped) closedBecause.push("stopped");
      if ((this.#step2?.contractMismatches.length ?? 1) > 0) closedBecause.push("contract_mismatch");
      if (!this.ledger.health().writable) closedBecause.push("ledger_unwritable");
      this.#step5 = {
        intakeMayOpen: closedBecause.length === 0,
        closedBecause,
        diagnosisPausedUntil: pause.value,
        queued: open.value.filter((run) => run.state === "queued").map((run) => run.runId),
        budgets: open.value.map((run) => ({ runId: run.runId, budgetLeft: run.budgetLeft })),
      };
      return this.#step5;
    });
  }
}
