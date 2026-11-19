// 재시작 복원(supervisor.md §8의 순서 1~5 가운데 장부 쪽). 순서를 강제한다: 앞 단계가 끝나지 않았는데 뒤 단계를 부르면 던진다.
// 복원기는 지시를 보내지 않는다. 무엇을 해야 하는지의 목록을 돌려주고, 보내는 일은 뒤 작업(실제 연결)이 한다.
// 실행기·현관·관측 중계는 아직 없으므로 포트로 받는다. 포트가 던지면(시간 초과 포함) "모름"이다.
//
// 1단계를 시작할 때마다 장부에 새 복원 시도를 연다. 앞 시도의 접수 허가는 그때 끝나고, 앞 시도의 늦은 응답은 장부를 바꾸지 못한다.
// 5단계는 지금의 시도와 정지 상태를 확인한 같은 동기 구간에서 완료 표시, 장부의 허가, 반환값을 정한다.
// 반환값은 그 순간의 판정이다. 그 뒤의 판단(stopGeneration, intakeOpen)은 단계 결과가 아니라 지금의 장부에서 읽는다.
import { CONTRACT, parsePrincipal, queriesAfterReconnect, type RunStatus } from "../contract/v1/index.ts";
import { type Ledger, type PendingInputs, type PendingReport, RESTORE_KEY, type RestoreAttempt, type Run, type SlotHold, type SlotHoldObservation, type SnapshotOrigin } from "./ledger.ts";
import { SLOT_FREE, TERMINAL } from "./states.ts";

// ---- 포트(뒤 작업이 채운다) ----

// 권위 있는 정지 기록(현관의 정지 기록, §7.6). null은 "기록 없음", 던지면 모름. 꼴이 맞지 않는 답도 모름이다.
export interface StopAuthorityPort {
  latestStop(): Promise<{ generation: number; stopped: boolean } | null>;
}

// 이웃(현관, 관측 중계, 실행기)이 쓰는 계약 판. 던지면 모름. 설정된 필수 이웃이 정확히 한 번씩 답해야 맞은 것으로 센다.
export interface PeersPort {
  contracts(): Promise<{ peer: string; contract: string }[]>;
}

// 실행기 하나의 점유 응답. 검증을 통과한 hello·status_report의 낸 쪽 주체 이름과 runs만 넘긴다.
// full: 그 실행기가 쥔 실행 전부를 이번 복원에서 답했다(hello). 빈 runs는 "쥔 것이 없다"는 뜻이다.
// partial: 특정 실행만 물은 답이다(status_report). 그 밖의 점유는 말해 주지 않는다.
// 응답 행이 없으면 모름이다. 필수 실행기는 full 응답이 정확히 하나 있어야 확인된 것으로 센다.
export interface OccupancyAnswer {
  executorId: string;
  coverage: "full" | "partial";
  runs: RunStatus[];
}

// 던지면 모름.
export interface OccupancyPort {
  occupancy(): Promise<OccupancyAnswer[]>;
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

export interface RestoreOptions {
  // 응답을 반드시 받아야 하는 이웃의 이름(설정). 빠지거나 겹치면 접수를 열지 않는다.
  // 계약의 실행기 주체 이름인 항목은 필수 실행기다: 판 응답에 더해 이번 복원의 전체 점유 응답도 있어야 한다.
  requiredPeers: readonly string[];
}

// ---- 단계의 결과(호출자가 바꿔도 복원기의 판단은 바뀌지 않는 복사본) ----

export interface Step1 {
  stopGeneration: number;
  stopped: boolean;
  // 장부보다 새로운 기록을 포트에서 받아 적용했는가. 첫 설치 장부에서 둘 다 기록이 없어 0을 적었으면 "initialized".
  source: "ledger" | "authority" | "initialized";
}

export interface OccupancyMismatch {
  executorId: string;
  runId: string;
  // state: 양쪽 상태가 맞지 않는다. executor: 지정 실행기가 아닌 실행기가 보고했다. generation: 세대가 다르다.
  why: "state" | "executor" | "generation";
}

export interface Step2 {
  // 장부 밖 실행: 종료 대상. 세대는 그 실행을 닫는 지시(task_cancel·session_stop)의 run_generation으로만 쓴다.
  terminate: { executorId: string; runId: string; runGeneration: number; why: "outside_ledger" | "ended_in_ledger" }[];
  occupancyMismatches: OccupancyMismatch[];
  // 장부에 남긴 관측(slot_holds). 줄이 있는 실행 ID는 시작하지 않고, holdsSlot이면 그 종류의 슬롯도 막는다.
  holds: SlotHold[];
  // 주체 이름이 실행기 꼴이 아니라 어느 슬롯인지 모르는 실행기. 접수를 보류한다.
  unresolvedExecutors: string[];
  // 전체 점유 응답을 정확히 하나 받지 못한 필수 실행기(응답 없음, 부분 조회만, 겹침). 접수를 보류한다.
  occupancyUnconfirmed: string[];
  // 장부에는 종료 확인이 있는데 실행기는 아직 돌고 있다고 답한 실행. 3단계가 상태를 다시 묻는다.
  recheck: string[];
  contractMismatches: { peer: string; contract: string }[];
  missingPeers: string[];
  duplicatePeers: string[];
}

export interface Step3 {
  // 같은 실행 ID로 상태만 묻는다(새 실행 ID로 다시 보내지 않는다). 종료가 이미 증명된 실행은 2단계에서 어긋나지 않았다면 묻지 않는다.
  statusQueries: { executorId: string; runIds: string[] }[];
  // 이번 복원이 unknown_running으로 옮긴 실행. 끝났다고 증명될 때까지 슬롯을 막는다.
  markedUnknown: string[];
  // 종료 확인이 장부에 있어 결과 검사를 이어 갈 실행(checking).
  resumeChecks: string[];
  // ack를 냈지만 아직 업무에 반영하지 않은 보고(결과 보고는 저장 자리와 digest, 훅·세션 깨짐 보고는 signal이 있다).
  pendingReports: PendingReport[];
  // 자리를 쥔 채 남은 실행(상태 그대로).
  blocking: { runId: string; state: Run["state"] }[];
}

export interface Step4 {
  confirmed: string[];
  pending: string[];
  unknown: string[];
}

export type ClosedBecause = "snapshot_hold" | "stopped" | "stop_unknown" | "stop_changed" | "contract_mismatch" | "peer_unconfirmed" | "occupancy_unresolved" | "occupancy_unconfirmed" | "ledger_unwritable";

export interface Step5 {
  // 이 단계가 끝난 순간의 판정이다. 그 뒤의 판단은 intakeOpen()으로 읽는다.
  intakeMayOpen: boolean;
  closedBecause: ClosedBecause[];
  // 이 장부가 사본에서 떴으면 그 사실과 사본 시각. held면 관리자 대조 전이라 새 실행이 0건이다. 원본이면 null.
  snapshotOrigin: SnapshotOrigin | null;
  diagnosisPausedUntil: number | null;
  // 시작 후보: 이 실행 자체를 막는 사유(옛 세대, 점유 관측, 입력 취소·만료, 기한)가 없는 대기 실행이다.
  // 시작을 보장하지 않는다. 접수 허가, 슬롯, 예산·입력 digest(not_startable)는 시작 트랜잭션이 다시 본다.
  queued: string[];
  // 옛 실행 세대의 대기 실행. 시작하지 않는다(닫는 기록만).
  staleQueued: string[];
  // 입력이 취소된 대기 실행. 시작하지 않는다.
  cancelledQueued: string[];
  // 원문이나 실행 기한이 지난 대기 실행. 시작하지 않는다.
  expiredQueued: string[];
  // 점유 관측이 남아 있어 다시 시작하면 안 되는 대기 실행.
  blockedQueued: string[];
  inputs: PendingInputs;
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

function isAuthorityStop(value: unknown): value is { generation: number; stopped: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const v = value as { generation?: unknown; stopped?: unknown };
  return keys.length === 2 && Number.isSafeInteger(v.generation) && (v.generation as number) >= 0 && typeof v.stopped === "boolean";
}

function slotKind(executorId: string): "worker" | "session" | undefined {
  const principal = parsePrincipal(executorId);
  if (principal?.kind === "worker_executor") return "worker";
  if (principal?.kind === "session_executor") return "session";
  return undefined;
}

const ACTIVE_REPORTED = (state: RunStatus["state"]) => !["finalized", "not_started", "not_known"].includes(state);
// 실행기가 아직 끝내지 않았다고 답한 상태. 장부에 종료 확인이 있는데 이 상태면 양쪽이 어긋난 것이다.
const RUNNING_REPORTED = (state: RunStatus["state"]) => ["preparing", "running", "stopping", "unknown_running"].includes(state);

export class Restorer {
  #done = 0;
  #running = false;
  // 이 복원기가 1단계에서 연 복원 시도.
  #attempt: RestoreAttempt | null = null;
  // 5단계가 쓰는 2단계의 판정. 돌려준 값과 따로 둔다.
  #step2: Step2 | null = null;
  readonly #requiredPeers: readonly string[];
  readonly #requiredExecutors: readonly string[];

  constructor(
    private readonly ledger: Ledger,
    private readonly ports: RestorePorts,
    private readonly clock: () => number,
    options: RestoreOptions,
  ) {
    const peers = options.requiredPeers;
    if (!Array.isArray(peers) || peers.length === 0 || new Set(peers).size !== peers.length || peers.some((p) => typeof p !== "string" || p === "")) {
      throw new TypeError("requiredPeers: 겹치지 않는 이웃 이름이 하나 이상 있어야 한다");
    }
    this.#requiredPeers = [...peers];
    this.#requiredExecutors = peers.filter((peer) => slotKind(peer) !== undefined);
  }

  // 감독이 VerifyContext.stopGeneration으로 쓰는 값. 이 복원기의 시도가 지금의 시도이고 1단계를 마쳤을 때만 세대를 낸다.
  // 장부가 한 번 실패했으면(더 새로운 정지를 저장하지 못했을 수 있다) 다시 열어 복원할 때까지 null이라 맞춤 답과 모든 발급이 닫힌다.
  stopGeneration(): number | null {
    return this.#done < 1 ? null : this.ledger.syncStopGeneration(this.#attempt);
  }

  // 새 접수·새 실행·자격 발급을 지금 열어도 되는가. 이 복원기가 낸 허가가 살아 있고 지금의 장부가 건강하고 정지가 아닐 때만 true다.
  intakeOpen(): boolean {
    return this.#done === 5 && this.#attempt !== null && this.ledger.intakeOpen(this.#attempt);
  }

  // 단계 완료를 확정하는 곳은 여기 하나다. 결과는 fn이 끝난 뒤 같은 동기 구간에서 #done과 함께 게시하고, 호출자에게는 복사본을 준다.
  // fn이 값을 바로 돌려주면 기다리지 않으므로 완료 표시까지 호출한 그 동기 구간 안에서 끝난다.
  async #step<T>(step: number, fn: () => Promise<T> | T, publish: (result: T) => void = () => {}): Promise<T> {
    if (this.#running || this.#done !== step - 1) throw new RestoreOrderError(step, this.#done);
    this.#running = true;
    try {
      const pending = fn();
      const result = pending instanceof Promise ? await pending : pending;
      publish(structuredClone(result));
      this.#done = step;
      return structuredClone(result);
    } finally {
      this.#running = false;
    }
  }

  // 더 새로운 복원 시도가 시작됐으면 이 시도의 늦은 응답으로 장부를 바꾸지 않는다.
  #requireCurrent(step: number): RestoreAttempt {
    const attempt = this.#attempt;
    if (attempt === null || !this.ledger.isCurrentRestore(attempt)) throw new RestoreStepError(step, "더 새로운 복원 시도가 시작됨");
    return attempt;
  }

  // 1. 복원 시도를 열고(앞 시도의 허가가 끝난다) 권위 기록을 받아 장부와 한 트랜잭션에서 합친다(같은 세대는 정지가 이긴다).
  // 장부를 읽지 못하거나 권위 기록을 모르면 실패하고 null을 유지한다.
  step1(): Promise<Step1> {
    return this.#step(1, async () => {
      this.#attempt = this.ledger.beginRestore(RESTORE_KEY);
      const read = this.ledger.readStop();
      if (!read.known) throw new RestoreStepError(1, `장부의 정지 기록을 읽지 못함(${read.reason})`);
      let authority: unknown;
      try {
        authority = await this.ports.stopAuthority.latestStop();
      } catch (error) {
        throw new RestoreStepError(1, `권위 정지 기록을 모름(${String(error)})`);
      }
      const attempt = this.#requireCurrent(1);
      if (authority !== null && !isAuthorityStop(authority)) throw new RestoreStepError(1, "권위 정지 기록의 꼴이 맞지 않음(모름으로 본다)");
      const merged = this.ledger.mergeStop(authority, this.clock());
      if (!merged.ok) throw new RestoreStepError(1, `정지 세대를 적지 못함(${merged.reason})`);
      this.ledger.pinRestore(RESTORE_KEY, attempt);
      return { stopGeneration: merged.record.generation, stopped: merged.record.stopped, source: merged.source };
    });
  }

  // 2. 계약 판을 맞추고 장부의 실행과 실행기의 점유를 실행 ID·세대·지정 실행기·양쪽 상태로 대조한다.
  // 장부 밖 실행은 종료 대상이고 장부에 실행으로 올리지 않는다. 남긴 관측은 그 실행 ID의 시작을 영영 막고, 활동 중이면 그 종류의 슬롯도 막는다.
  // 관측으로 남기지 않는 불일치: 이미 시작한 실행 줄이 슬롯을 쥔 채 끝났다고 답한 경우와 끝난 상태끼리 이름만 다른 경우다(장부의 줄이 이미 막는다).
  step2(): Promise<Step2> {
    return this.#step(
      2,
      async () => {
        let contracts: { peer: string; contract: string }[];
        let occupancy: OccupancyAnswer[];
        try {
          contracts = await this.ports.peers.contracts();
          occupancy = await this.ports.occupancy.occupancy();
        } catch (error) {
          throw new RestoreStepError(2, `이웃의 판이나 점유를 모름(${String(error)})`);
        }
        this.#requireCurrent(2);
        const runs = this.ledger.listRuns();
        if (!runs.known) throw new RestoreStepError(2, `장부의 실행을 읽지 못함(${runs.reason})`);
        const byId = new Map(runs.value.map((run) => [run.runId, run]));
        const out: Step2 = {
          terminate: [],
          occupancyMismatches: [],
          holds: [],
          unresolvedExecutors: [],
          occupancyUnconfirmed: [],
          recheck: [],
          contractMismatches: [],
          missingPeers: [],
          duplicatePeers: [],
        };

        const seen = new Map<string, number>();
        for (const answer of contracts) {
          seen.set(answer.peer, (seen.get(answer.peer) ?? 0) + 1);
          if (answer.contract !== CONTRACT) out.contractMismatches.push({ peer: answer.peer, contract: answer.contract });
        }
        for (const peer of this.#requiredPeers) {
          const n = seen.get(peer) ?? 0;
          if (n === 0) out.missingPeers.push(peer);
          if (n > 1) out.duplicatePeers.push(peer);
        }

        const fullAnswers = new Map<string, number>();
        for (const answer of occupancy) if (answer.coverage === "full") fullAnswers.set(answer.executorId, (fullAnswers.get(answer.executorId) ?? 0) + 1);
        for (const executor of this.#requiredExecutors) if (fullAnswers.get(executor) !== 1) out.occupancyUnconfirmed.push(executor);

        const observations: SlotHoldObservation[] = [];
        for (const { executorId, runs: reported } of occupancy) {
          const kind = slotKind(executorId);
          for (const status of reported) {
            if (status.state === "not_known") continue;
            const active = ACTIVE_REPORTED(status.state);
            if (kind === undefined && active && !out.unresolvedExecutors.includes(executorId)) out.unresolvedExecutors.push(executorId);
            const generation = status.run_generation;
            // 계약은 not_known 밖의 상태에 세대를 요구한다. 세대가 없으면 어느 관측인지 가를 수 없어 접수를 보류한다.
            if (generation === null) {
              if (!out.unresolvedExecutors.includes(executorId)) out.unresolvedExecutors.push(executorId);
              continue;
            }
            const known = byId.get(status.run_id);
            const observe = (why: SlotHoldObservation["why"]) => {
              const slot = kind ?? known?.kind;
              if (slot !== undefined) observations.push({ executorId, runId: status.run_id, kind: slot, runGeneration: generation, holdsSlot: active && kind !== undefined, why });
            };
            if (known === undefined) {
              out.terminate.push({ executorId, runId: status.run_id, runGeneration: generation, why: "outside_ledger" });
              // 끝났다는 답도 이 ID가 이미 쓰였다는 사실이다. 어느 슬롯인지 몰라 적지 못하면 접수를 보류한다.
              if (kind === undefined && !out.unresolvedExecutors.includes(executorId)) out.unresolvedExecutors.push(executorId);
              observe("outside_ledger");
              continue;
            }
            // 대기 줄은 아직 지시를 내지 않은 실행이다. 어느 실행기든 이 ID를 안다고 답하면 끝났다는 답이어도 다시 시작 후보가 되지 않는다.
            const queued = known.state === "queued";
            if (known.executorId !== executorId) {
              out.occupancyMismatches.push({ executorId, runId: known.runId, why: "executor" });
              if (active || queued) observe("executor");
              continue;
            }
            if (known.runGeneration !== generation) {
              out.occupancyMismatches.push({ executorId, runId: known.runId, why: "generation" });
              if (active || queued) observe("generation");
              continue;
            }
            if (queued) {
              out.occupancyMismatches.push({ executorId, runId: known.runId, why: "state" });
              observe("state");
            } else if (TERMINAL.includes(known.state)) {
              // 장부에서는 끝났는데 실행기가 아직 쥐고 있다고 하는 실행도 닫는다. 장부의 상태는 바꾸지 않는다.
              if (active) {
                out.terminate.push({ executorId, runId: known.runId, runGeneration: known.runGeneration, why: "ended_in_ledger" });
                observe("ended_in_ledger");
              } else if (known.state !== status.state) {
                out.occupancyMismatches.push({ executorId, runId: known.runId, why: "state" });
              }
            } else if (known.stopReceiptId !== null && RUNNING_REPORTED(status.state)) {
              // 종료 확인이 있는데 실행기는 돌고 있다고 답한다. 슬롯을 막고 3단계에서 다시 묻는다.
              out.occupancyMismatches.push({ executorId, runId: known.runId, why: "state" });
              out.recheck.push(known.runId);
              observe("state");
            } else if (known.stopReceiptId === null && !active) {
              // 장부는 진행 중인데 실행기는 끝났다고 답한다. 종료 증명이 아니므로 3단계가 unknown_running으로 슬롯을 쥔 채 묻는다.
              out.occupancyMismatches.push({ executorId, runId: known.runId, why: "state" });
            }
          }
        }
        if (observations.length > 0) {
          const written = this.ledger.holdSlots(RESTORE_KEY, observations, this.clock());
          if (!written.ok) throw new RestoreStepError(2, `점유 차단을 적지 못함(${written.reason})`);
          out.holds = written.holds;
        }
        return out;
      },
      (result) => {
        this.#step2 = result;
      },
    );
  }

  // 3. 진행 중이던 실행은 상태를 묻는 대상이다. 다시 실행하지 않는다. 증명되지 않으면 unknown_running으로 슬롯을 막는다.
  // 종료 확인이 이미 장부에 있는 실행(checking)은 결과 검사를 이어 간다.
  step3(): Promise<Step3> {
    return this.#step(3, () => {
      this.#requireCurrent(3);
      const lost = this.ledger.markLost(this.clock());
      if (!lost.ok) throw new RestoreStepError(3, `진행 중 실행을 unknown_running으로 적지 못함(${lost.reason})`);
      const open = this.ledger.openRuns();
      const reports = this.ledger.pendingReports();
      if (!open.known || !reports.known) throw new RestoreStepError(3, "장부의 실행이나 보고를 읽지 못함");
      const holding = open.value.filter((run) => !SLOT_FREE.includes(run.state));
      const recheck = new Set(this.#step2?.recheck ?? []);
      const byExecutor = new Map<string, string[]>();
      for (const run of holding) {
        if (run.stopReceiptId !== null && !recheck.has(run.runId)) continue;
        byExecutor.set(run.executorId, [...(byExecutor.get(run.executorId) ?? []), run.runId]);
      }
      const statusQueries: Step3["statusQueries"] = [];
      for (const [executorId, runIds] of byExecutor) {
        for (const query of queriesAfterReconnect(runIds)) statusQueries.push({ executorId, runIds: query.run_ids });
      }
      return {
        statusQueries,
        markedUnknown: lost.runIds,
        resumeChecks: holding.filter((run) => run.state === "checking").map((run) => run.runId),
        pendingReports: reports.value,
        blocking: holding.map((run) => ({ runId: run.runId, state: run.state })),
      };
    });
  }

  // 4. 확정되지 않은 게시는 현관에 작업 ID로 묻는다. 시간 초과·모름은 unknown으로 남는다.
  step4(): Promise<Step4> {
    return this.#step(4, async () => {
      this.#requireCurrent(4);
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
        this.#requireCurrent(4);
        // 이미 unknown인 것을 현관이 "대기"라고 답해도 pending으로 적는다(현관이 그 작업을 안다는 뜻이다).
        const written = this.ledger.settlePublication(publication.frontJobId, answer, this.clock());
        if (!written.ok) throw new RestoreStepError(4, `게시 결과를 적지 못함(${written.reason})`);
        out[answer.kind].push(publication.frontJobId);
      }
      return out;
    });
  }

  // 5. 예산·일시 중지·대기열·입력을 복원하고, 정지 상태가 아니고 앞 단계가 모두 맞을 때만 장부의 접수 허가를 낸다.
  // 이 본문에는 await가 없다: 판정, 허가, 완료 표시, 반환값이 한 동기 구간에서 정해진다.
  // 예외(ledger.md): 장부 안의 unknown_running·cleanup_pending, 점유 차단, 게시 모름은 접수를 닫지 않고 그 자리만 막는다.
  step5(): Promise<Step5> {
    return this.#step(5, () => {
      const attempt = this.#requireCurrent(5);
      const stop = this.ledger.readStop();
      const pause = this.ledger.readPause();
      const view = this.ledger.queueView();
      const origin = this.ledger.snapshotOrigin();
      if (!stop.known || !pause.known || !view.known || !origin.known) throw new RestoreStepError(5, "장부를 읽지 못함");
      const step2 = this.#step2;
      if (step2 === null) throw new RestoreStepError(5, "2단계의 판정이 없음");
      const closedBecause: ClosedBecause[] = [];
      if (origin.value?.held === true) closedBecause.push("snapshot_hold");
      if (stop.value === null) closedBecause.push("stop_unknown");
      else if (stop.value.stopped) closedBecause.push("stopped");
      if (step2.contractMismatches.length > 0) closedBecause.push("contract_mismatch");
      if (step2.missingPeers.length > 0 || step2.duplicatePeers.length > 0) closedBecause.push("peer_unconfirmed");
      if (step2.unresolvedExecutors.length > 0) closedBecause.push("occupancy_unresolved");
      if (step2.occupancyUnconfirmed.length > 0) closedBecause.push("occupancy_unconfirmed");
      if (!this.ledger.health().writable) closedBecause.push("ledger_unwritable");
      // 1단계 뒤에 정지가 바뀌었다 풀렸으면 앞서 모은 대조로는 열지 않는다. 새 시도가 처음부터 다시 대조한다.
      const granted = closedBecause.length === 0 && this.ledger.grantIntake(RESTORE_KEY, attempt);
      if (closedBecause.length === 0 && !granted) closedBecause.push(this.ledger.health().writable ? "stop_changed" : "ledger_unwritable");
      const queued = view.value.runs.filter((run) => run.state === "queued");
      const barred = (...bars: (typeof queued)[number]["startBar"][]) => queued.filter((run) => bars.includes(run.startBar)).map((run) => run.runId);
      return {
        intakeMayOpen: granted,
        closedBecause,
        snapshotOrigin: origin.value,
        diagnosisPausedUntil: pause.value,
        queued: barred(null),
        staleQueued: barred("run_generation_stale"),
        cancelledQueued: barred("input_cancelled"),
        expiredQueued: barred("input_expired", "deadline_passed"),
        blockedQueued: barred("run_blocked"),
        inputs: view.value.inputs,
        budgets: view.value.runs.map((run) => ({ runId: run.runId, budgetLeft: run.budgetLeft })),
      };
    });
  }
}
