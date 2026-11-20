// 연결 상실 반영의 한 박자. 장부에 종료가 확인되지 않은 실행을 쥔 작업자 실행기마다, 그 실행기의 인정된 연결이 없는 채로 끊김 판정
// 시간을 넘겼을 때만 끊겼다고 보고 장부의 markLostFor를 그 실행기의 이름으로 한 번 부른다. 자리를 풀거나 실행을 끝내지 않는다.
// 장부·연결 표·정지 세대·시계는 포트로, 판정 시간은 정책으로, 앞 박자들이 본 연결의 기억은 인자로 받는다. 소켓·타이머·시계를 직접
// 부르지 않는다. 쥐는 것은 같은 장부 포트로 박자가 진행 중이라는 표시 하나다(돌아오면 지운다).
//
// 지키는 것:
// 1. 판정은 시간으로 한다. 인정된 연결은 연결 표의 occupancy(지금의 복원기)에 그 주체 이름이 있는 것이다. 없음을 센 시작은 이 프로세스가
//    그 실행기의 연결을 본 뒤 처음으로 없음을 확인한 박자의 시각이다(실제로 사라진 순간보다 이르지 않아 판정이 늦을 수는 있어도 이르지 않다).
//    그 시각부터 판정 시간을 넘겨야(정각은 아직) 끊겼다고 본다. 본 적 없는 실행기와 시계가 그 시각보다 뒤로 간 실행기는 모름이다.
// 2. 끊겼다고 본 실행기마다 markLostFor를 그 주체 이름으로 한 번 부른다. 다른 실행기의 실행은 건드리지 않는다.
// 3. 장부의 거절·예외·정의 밖의 답은 옮김으로 세지 않고 구별된 결과로 낸다. 기억의 없음 시각은 그대로 남아 다음 박자가 다시 부른다.
// 4. 읽기가 모름이거나 꼴이 틀린 실행기는 판정하지 않는다. 한 실행기의 실패는 그 실행기의 결과이고 다음 실행기를 본다.
//
// 박자 안에 await가 없다. 연결 표를 읽은 뒤 장부에 쓰기까지 소켓 사건이 끼어들 수 없다.
import { limits, parsePrincipal } from "../../contract/v1/index.ts";
import { LEDGER_RUN_STATES, type Ledger, REFUSALS as LEDGER_REFUSALS, type Refusal as LedgerRefusal, type LostRun } from "../../ledger/index.ts";
import type { Connections, StopGenerationSource } from "../transport/connections.ts";
import type { Clock } from "./ports.ts";

// 장부 포트. 실제 장부(openLedger가 연 Ledger)가 그대로 맞는 꼴이다. 쓰기는 markLostFor 하나다.
export type LinkLossLedger = Pick<Ledger, "listRuns" | "markLostFor">;

export interface LinkLossPorts {
  readonly ledger: LinkLossLedger;
  // 부르는 쪽이 쥔 지금의 연결 표. occupancy(restorer)의 행이 인정된 연결이다(맞춤·인사를 마치고 지금의 복원기로 열린 연결).
  readonly connections: Pick<Connections, "occupancy">;
  // 연결 표의 step에 넘기는 바로 그 복원기 객체여야 한다. 연결 표는 객체 동일성으로 이번 복원의 인사를 가르므로, 다른 객체를 넘기면
  // 모든 실행기가 연결이 없는 것으로 보인다. 세대를 모르면(null) 연결 표가 아무도 인정하지 않으므로 이 박자는 판정하지 않는다.
  readonly restorer: StopGenerationSource;
  // 장부에 주입한 시계와 같은 시계. 박자 처음에 한 번 읽는다.
  readonly clock: Clock;
}

export interface LinkLossPolicy {
  // 없음을 센 시각부터 이만큼을 넘기면(정각은 아직) 끊겼다고 본다. 계약 v1의 DISCONNECT_JUDGE_MS가 기본값(관리자 미확정)이다.
  // RUN_LEASE_MAX_MS 이상이어야 한다: 판정할 때 실행기는 갱신 없이 임대가 끝나 이미 닫혀 있다(limits.ts).
  readonly judgeMs: number;
}

// 실행기 하나의 연결 기억. absentSince가 null이면 마지막 박자에 인정된 연결이 있었다. 시각이면 그 박자에 처음으로 없음을 확인했다.
// 기억에 없는 실행기는 이 프로세스가 연결을 본 적이 없는 것이다(모름).
export interface WatchEntry {
  readonly executorId: string;
  readonly absentSince: number | null;
}

export interface LinkLossTickInput {
  // 앞 박자의 결과 watch를 그대로 넘긴다. 감독이 다시 뜨면 비어 있다(재시작 뒤의 대조는 복원의 몫이다).
  readonly watch: readonly WatchEntry[];
}

export type LinkLossUnknown = "never_seen" | "clock_regressed" | "read_unknown";

// 장부가 옮겼는지 모른다: markLostFor가 던졌거나(threw) 답이 정의 밖이다(malformed_answer). 다시 불러도 이미 옮긴 실행은 세지 않는다.
export type LinkLossFailure = LedgerRefusal | "threw" | "malformed_answer";

export type ExecutorOutcome =
  // 인정된 연결이 있다.
  | { readonly executorId: string; readonly outcome: "linked" }
  // 연결이 없지만 판정 시간 안이다.
  | { readonly executorId: string; readonly outcome: "within_judge"; readonly absentSince: number }
  | { readonly executorId: string; readonly outcome: "unknown"; readonly reason: LinkLossUnknown }
  // 세션 실행기. 연결 표가 세션 실행기의 연결을 아직 인정하지 않는다(맞춤은 작업자 주체만 받는다).
  | { readonly executorId: string; readonly outcome: "not_worker" }
  // markLostFor가 옮겼다. runs는 장부의 답 그대로(빈 목록이면 부르는 사이 옮길 실행이 없었다). at은 장부에 넘긴 시각이다.
  | { readonly executorId: string; readonly outcome: "moved"; readonly absentSince: number; readonly at: number; readonly runs: readonly LostRun[] }
  // 옮기지 못했거나 옮겼는지 모른다. 옮김으로 세지 않는다.
  | { readonly executorId: string; readonly outcome: "ledger_failed"; readonly absentSince: number; readonly reason: LinkLossFailure };

export type LinkLossTickResult =
  | { readonly kind: "not_run"; readonly reason: "clock_unavailable" | "input_malformed" | "policy_rejected" | "tick_in_progress" | "links_unknown" | "read_unknown" }
  | {
      readonly kind: "ran";
      // 종료가 확인되지 않은 실행을 쥔 실행기마다 한 항목(주체 이름 순). 멈췄으면 멈춘 실행기의 항목까지 있고 그 뒤는 없다.
      readonly executors: readonly ExecutorOutcome[];
      // 다음 박자에 넘길 기억(주체 이름 순). 멈춰도 온전하다(쓰기와 무관하게 박자 처음에 만든다).
      readonly watch: readonly WatchEntry[];
      readonly halted: "threw" | null;
      readonly haltedAt: string | null;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isRefusal = (value: unknown): value is LedgerRefusal => (LEDGER_REFUSALS as readonly unknown[]).includes(value);
const isState = (value: unknown): value is LostRun["before"] => (LEDGER_RUN_STATES as readonly unknown[]).includes(value);
// markLostFor가 옮기는 상태(종료 확인이 없을 때). 장부의 #moveLost와 같은 집합이다.
const IN_FLIGHT: readonly string[] = ["preparing", "running", "stopping"];

// 같은 장부 포트로 진행 중인 박자. 박자 안에 await가 없으므로 겹치는 길은 포트 안에서 다시 부르는 것뿐이다.
const RUNNING = new WeakSet<object>();

interface Holder {
  kind: "worker" | "session" | "unknown";
}

export function linkLossTick(ports: LinkLossPorts, policy: LinkLossPolicy, input: LinkLossTickInput): LinkLossTickResult {
  const key = ports.ledger;
  if (RUNNING.has(key)) return { kind: "not_run", reason: "tick_in_progress" };
  RUNNING.add(key);
  try {
    return tickOnce(ports, policy, input);
  } finally {
    RUNNING.delete(key);
  }
}

function readPolicy(policy: unknown): number | null {
  try {
    if (!isObject(policy)) return null;
    const judgeMs: unknown = policy.judgeMs;
    return Number.isSafeInteger(judgeMs) && (judgeMs as number) >= limits.RUN_LEASE_MAX_MS ? (judgeMs as number) : null;
  } catch {
    return null;
  }
}

// 같은 실행기의 항목이 둘 이상이면 판정이 늦어지는 쪽으로 합친다: 연결을 본 기록(null)이 이기고, 아니면 더 늦은 시각이다.
function readWatch(input: unknown): Map<string, number | null> | null {
  try {
    if (!isObject(input) || !Array.isArray(input.watch)) return null;
    const watch = new Map<string, number | null>();
    for (const entry of input.watch as unknown[]) {
      if (!isObject(entry)) return null;
      const { executorId, absentSince } = entry;
      if (typeof executorId !== "string" || executorId === "" || !(absentSince === null || isTime(absentSince))) return null;
      const before = watch.get(executorId);
      watch.set(executorId, before === null || absentSince === null ? null : Math.max(before ?? 0, absentSince));
    }
    return watch;
  } catch {
    return null;
  }
}

function readClock(ports: LinkLossPorts): number | null {
  try {
    const at: unknown = ports.clock.now();
    return isTime(at) ? at : null;
  } catch {
    return null;
  }
}

// 인정된 연결의 주체 이름. 세대를 모르거나 행의 꼴이 틀리면 null(모름): 그때 연결 표는 아무도 인정하지 않으므로 없음으로 읽으면 안 된다.
function readLinked(ports: LinkLossPorts): Set<string> | null {
  try {
    const generation: unknown = ports.restorer.stopGeneration();
    if (!Number.isSafeInteger(generation) || (generation as number) < 0) return null;
    const rows: unknown = ports.connections.occupancy(ports.restorer);
    if (!Array.isArray(rows)) return null;
    const linked = new Set<string>();
    for (const row of rows as unknown[]) {
      if (!isObject(row)) return null;
      const executorId: unknown = row.executorId;
      if (typeof executorId !== "string" || executorId === "") return null;
      linked.add(executorId);
    }
    return linked;
  } catch {
    return null;
  }
}

// 종료가 확인되지 않은 실행을 쥔 실행기. 어느 실행기의 줄인지 모르는 줄이 하나라도 있으면 전체가 모름(null)이다.
// 실행기는 알지만 다른 칸의 꼴이 틀린 줄은 그 실행기를 모름으로 둔다(그 줄이 진행 중인지 모른다).
function readHolders(ledger: LinkLossLedger): Map<string, Holder> | null {
  let rows: unknown[];
  try {
    const answer: unknown = ledger.listRuns();
    if (!isObject(answer) || answer.known !== true || !Array.isArray(answer.value)) return null;
    rows = answer.value as unknown[];
  } catch {
    return null;
  }
  const holders = new Map<string, Holder>();
  for (const raw of rows) {
    let executorId: unknown;
    try {
      executorId = isObject(raw) ? raw.executorId : undefined;
    } catch {
      return null;
    }
    if (typeof executorId !== "string" || executorId === "") return null;
    const held = holders.get(executorId);
    try {
      const { kind, state, stopReceiptId } = raw as Record<string, unknown>;
      const party = parsePrincipal(executorId)?.kind;
      const fits = (kind === "worker" && party === "worker_executor") || (kind === "session" && party === "session_executor");
      if (!fits || !isState(state) || !(stopReceiptId === null || typeof stopReceiptId === "string")) {
        holders.set(executorId, { kind: "unknown" });
        continue;
      }
      if (!IN_FLIGHT.includes(state) || stopReceiptId !== null) continue;
      if (held === undefined) holders.set(executorId, { kind });
    } catch {
      holders.set(executorId, { kind: "unknown" });
    }
  }
  return holders;
}

function tickOnce(ports: LinkLossPorts, policy: LinkLossPolicy, input: LinkLossTickInput): LinkLossTickResult {
  const judgeMs = readPolicy(policy);
  if (judgeMs === null) return { kind: "not_run", reason: "policy_rejected" };
  const remembered = readWatch(input);
  if (remembered === null) return { kind: "not_run", reason: "input_malformed" };
  const now = readClock(ports);
  if (now === null) return { kind: "not_run", reason: "clock_unavailable" };
  const linked = readLinked(ports);
  if (linked === null) return { kind: "not_run", reason: "links_unknown" };
  const holders = readHolders(ports.ledger);
  if (holders === null) return { kind: "not_run", reason: "read_unknown" };

  // 다음 박자의 기억. 지금 인정된 실행기는 null, 기억에 있는데 지금 없는 실행기는 처음 없음을 확인한 시각(이번이 처음이면 지금)이다.
  // 기억에 없고 지금도 없는 실행기는 넣지 않는다(본 적이 없다). 실행을 쥐지 않은 실행기도 담는다: 박자 사이에 배정돼 시작한 뒤 끊긴
  // 실행기를 "본 적 없음"으로 놓치지 않기 위해서다.
  const next = new Map<string, number | null>();
  for (const name of linked) next.set(name, null);
  for (const [name, since] of remembered) if (!linked.has(name)) next.set(name, since ?? now);
  const watch: WatchEntry[] = [...next.keys()].sort().map((executorId) => ({ executorId, absentSince: next.get(executorId) ?? null }));

  const outcomes: ExecutorOutcome[] = [];
  for (const executorId of [...holders.keys()].sort()) {
    const holder = holders.get(executorId) as Holder;
    const trace: { fallback: (() => ExecutorOutcome) | null } = { fallback: null };
    try {
      outcomes.push(judge(ports, judgeMs, now, executorId, holder, linked, remembered, trace));
    } catch {
      if (trace.fallback !== null) outcomes.push(trace.fallback());
      return { kind: "ran", executors: outcomes, watch, halted: "threw", haltedAt: executorId };
    }
  }
  return { kind: "ran", executors: outcomes, watch, halted: null, haltedAt: null };
}

function judge(
  ports: LinkLossPorts,
  judgeMs: number,
  now: number,
  executorId: string,
  holder: Holder,
  linked: ReadonlySet<string>,
  remembered: ReadonlyMap<string, number | null>,
  trace: { fallback: (() => ExecutorOutcome) | null },
): ExecutorOutcome {
  if (holder.kind === "unknown") return { executorId, outcome: "unknown", reason: "read_unknown" };
  if (holder.kind === "session") return { executorId, outcome: "not_worker" };
  if (linked.has(executorId)) return { executorId, outcome: "linked" };
  // 감독이 막 떴거나 이 프로세스가 그 연결을 본 적이 없다. 언제부터 없었는지 모르므로 판정하지 않는다.
  if (!remembered.has(executorId)) return { executorId, outcome: "unknown", reason: "never_seen" };
  const absentSince = remembered.get(executorId) ?? now;
  // 시계가 없음을 센 시각보다 뒤로 갔다. 경과를 모르므로 판정하지 않는다(기억의 시각은 그대로 넘어간다).
  if (now < absentSince) return { executorId, outcome: "unknown", reason: "clock_regressed" };
  // 경계는 "넘김"이다. 정각은 아직 판정 시간 안이다.
  if (now - absentSince <= judgeMs) return { executorId, outcome: "within_judge", absentSince };

  const failed = (reason: LinkLossFailure): ExecutorOutcome => ({ executorId, outcome: "ledger_failed", absentSince, reason });
  let answer: unknown;
  try {
    answer = ports.ledger.markLostFor({ executorId, now });
  } catch {
    return failed("threw");
  }
  // 여기부터 장부는 옮겼을 수 있다. 답을 읽다 던지면 박자는 멈추고 이 항목은 "옮겼는지 모름"으로 남는다.
  trace.fallback = () => failed("malformed_answer");
  if (!isObject(answer)) return failed("malformed_answer");
  const ok: unknown = answer.ok;
  if (ok === false) {
    const reason: unknown = answer.reason;
    return isRefusal(reason) ? failed(reason) : failed("malformed_answer");
  }
  if (ok !== true) return failed("malformed_answer");
  const runs = lostRuns(answer.runs);
  if (runs === null) return failed("malformed_answer");
  return { executorId, outcome: "moved", absentSince, at: now, runs };
}

// 답의 옮긴 실행 목록을 칸마다 한 번 읽어 옮겨 적는다. 하나라도 꼴이 틀리면 null.
function lostRuns(value: unknown): LostRun[] | null {
  if (!Array.isArray(value)) return null;
  const runs: LostRun[] = [];
  for (const item of value as unknown[]) {
    if (!isObject(item)) return null;
    const { runId, runGeneration, before, after } = item;
    if (typeof runId !== "string" || !UUID.test(runId)) return null;
    if (!Number.isSafeInteger(runGeneration) || (runGeneration as number) < 0) return null;
    if (!isState(before) || !isState(after)) return null;
    runs.push({ runId, runGeneration: runGeneration as number, before, after });
  }
  return runs;
}
