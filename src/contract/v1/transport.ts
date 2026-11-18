// 전송 계약(D-55). 실행기가 감독에 인증된 연결 하나를 먼저 열어 유지하고, 감독은 그 위로 지시를 바로 보낸다.
// 실행기는 듣지 않고 주기 조회도 없다. 여기는 메시지의 종류와 모양, 연결 상태의 규칙까지다. 바이트 틀과 소켓은 뒤 작업이다.
//
// 지키는 규칙:
// 1. 연결 없음(또는 끊김 판정 뒤)에는 감독이 지시를 만들지 않는다. 특히 새 실행(task_start, session_start)과
//    새 자격을 싣는 지시를 쌓아 두었다가 다시 붙은 뒤 보내는 길이 없다.
// 2. 끊긴 동안 진행 중이던 실행은 감독 쪽에서 unknown_running이고 슬롯을 놓지 않는다.
// 3. 다시 붙으면 실행기가 hello로 자기가 쥔 실행의 상태와 아직 받음 확인을 못 받은 영수증 ID를 알린다.
//    감독은 같은 실행 ID로 status_query만 보낸다. 끊김을 이유로 새 실행 ID를 만드는 재전송 모양은 없다(§3의 4).
// 4. 영수증·보고는 감독의 ack가 올 때까지 같은 본문을 새 봉투에 담아 다시 보낸다. 감독은 id와 digest로 한 번만 반영한다.
// 5. 시한이 지난 지시는 연결이 살아 있어도 거절된다(봉투 검증의 expired). 보내는 쪽은 남은 시한이 전달 지연 상한보다
//    짧은 봉투를 싣지 않는다(too_late_to_send). 그때는 같은 실행의 상태를 묻는다.
import type { RejectReason } from "./errors.ts";
import { type Action, BodyReject } from "./header.ts";
import { INSTRUCTIONS } from "./instruction.ts";
import { ACK_MAX_IDS, DELIVERY_MAX_MS, DISCONNECT_JUDGE_MS, STATUS_MAX_RUNS } from "./limits.ts";
import { int, list, nullable, object, oneOf, revision, uuid } from "./schema.ts";

// 실행기가 아는 실행 상태(supervisor.md §3의 이름). queued는 감독에만 있다.
// not_known은 "실행기에 기록이 없음"이다. 감독은 이것을 "없음"이나 "끝남"으로 바꾸지 않는다.
export const RUN_STATES = [
  "preparing",
  "running",
  "stopping",
  "checking",
  "ready_result",
  "finalized",
  "not_started",
  "failed_stopped",
  "unknown_running",
  "cleanup_pending",
  "not_known",
] as const;
export type RunState = (typeof RUN_STATES)[number];

// run_generation은 실행기 장부에 적힌 그 실행의 세대다(서명된 본문 안). 받는 쪽(감독)은
// - 아는 실행이면 지금 세대와 대조한다. 다르면 그 상태는 옛(또는 다른) 세대의 것이라 봉투째 run_generation_mismatch다.
// - 모르는 실행(장부 밖)이면 이 세대를 재개·결과 반영의 권한으로 쓰지 않는다. 그 실행을 닫는 지시(task_cancel·session_stop)와
//   status_query의 대조에만 쓴다(supervisor.md §8의 2: 장부에 없는 실행은 종료 대상).
// not_known(실행기에 기록이 없음)이면 세대도 영수증도 없으므로 run_generation과 last_receipt_id는 null이다.
const runStatusShape = object({ run_id: uuid, state: oneOf(RUN_STATES), run_generation: nullable(int(1)), last_receipt_id: nullable(uuid) });
function runStatus(value: unknown, path: string) {
  const status = runStatusShape(value, path);
  const unknown = status.state === "not_known";
  if (unknown !== (status.run_generation === null) || (unknown && status.last_receipt_id !== null)) throw new BodyReject("body_malformed");
  return status;
}
export type RunStatus = ReturnType<typeof runStatus>;
// 한 메시지 안에서 같은 실행 ID는 한 번만 온다. 두 세대가 함께 오면 어느 쪽이 지금 것인지 가를 수 없다.
function runList(min: number) {
  const inner = list(runStatus, min, STATUS_MAX_RUNS);
  return (value: unknown, path: string) => {
    const runs = inner(value, path);
    if (new Set(runs.map((run) => run.run_id)).size !== runs.length) throw new BodyReject("body_malformed");
    return runs;
  };
}

// 연결 뒤 실행기의 첫 메시지. 계약 판은 봉투 머리가, 정책·프로필 revision은 여기서 맞춘다(§9.1 "서로").
export const parseHello = object({
  profile_revision: revision,
  policy_revision: revision,
  runs: runList(0),
  unacked_ids: list(uuid, 0, ACK_MAX_IDS, true),
});

// 감독 → 실행기. 효과가 없는 읽기다. 이미 있는 실행 ID만 묻는다. 지시 여섯에 들지 않는다.
export const parseStatusQuery = object({
  run_ids: list(uuid, 1, STATUS_MAX_RUNS, true),
});

export const parseStatusReport = object({
  in_reply_to: uuid,
  runs: runList(1),
});

// 감독 → 실행기. 영수증·보고를 반영했다는 확인. 실행기는 이것을 받은 id만 다시 보내기를 멈춘다.
export const parseAck = object({
  ids: list(uuid, 1, ACK_MAX_IDS, true),
});

// 검증을 통과한 hello·status_report에서 감독 장부에 없는 실행(종료 대상)을 고른다. 돌려준 세대는 그 실행을 닫는
// 지시의 run_generation으로만 쓴다. 장부에 실행으로 올리거나 결과를 받아들이는 근거가 아니다.
export function runsOutsideLedger(
  runs: readonly RunStatus[],
  runGeneration: (runId: string) => number | undefined,
): { run_id: string; run_generation: number }[] {
  const out: { run_id: string; run_generation: number }[] = [];
  for (const run of runs) {
    if (run.run_generation !== null && runGeneration(run.run_id) === undefined) out.push({ run_id: run.run_id, run_generation: run.run_generation });
  }
  return out;
}

export type Hello = ReturnType<typeof parseHello>;
export type StatusQuery = ReturnType<typeof parseStatusQuery>;
export type StatusReport = ReturnType<typeof parseStatusReport>;
export type Ack = ReturnType<typeof parseAck>;

// ---- 연결 상태 ----

// 감독이 실행기 하나를 보는 상태. connected는 그 연결에서 서명이 맞는 hello를 받은 뒤부터다.
export type Link =
  | { state: "connected"; since: number; last_seen_at: number }
  | { state: "disconnected"; since: number };

export type LinkView = "connected" | "disconnected" | "lost";

// lost: 끊긴 지(또는 연결은 있는데 아무것도 받지 못한 지) DISCONNECT_JUDGE_MS가 지났다. 진행 중 실행은 unknown_running이 된다.
export function viewLink(link: Link, now: number): LinkView {
  if (link.state === "connected") return now - link.last_seen_at >= DISCONNECT_JUDGE_MS ? "lost" : "connected";
  return now - link.since >= DISCONNECT_JUDGE_MS ? "lost" : "disconnected";
}

export type Verdict = { ok: true } | { ok: false; reason: RejectReason };

// 감독이 지시를 만들어도 되는가. 연결이 살아 있지 않으면 어떤 지시도 만들지 않는다(쌓아 두는 큐가 없다).
export function mayIssue(action: Action, link: Link, now: number): Verdict {
  if (!isInstruction(action)) return { ok: true };
  return viewLink(link, now) === "connected" ? { ok: true } : { ok: false, reason: "no_connection" };
}

// 보내는 순간의 확인. 남은 시한이 전달 지연 상한보다 짧으면 싣지 않는다.
export function maySend(header: { expires_at: number }, now: number): Verdict {
  return header.expires_at - now >= DELIVERY_MAX_MS ? { ok: true } : { ok: false, reason: "too_late_to_send" };
}

// 끊김 판정 뒤 감독 장부의 실행 상태. 끝났다고 증명되지 않은 실행은 unknown_running으로 두고 슬롯을 놓지 않는다.
const SETTLED: readonly RunState[] = ["finalized", "not_started", "failed_stopped", "ready_result", "cleanup_pending"];
export function stateAfterLoss(state: RunState): RunState {
  return SETTLED.includes(state) ? state : "unknown_running";
}

// 다시 붙은 뒤 감독이 보낼 것: 진행 중이던 실행 ID의 상태 조회뿐이다. 새 실행을 만들지 않는다.
export function queriesAfterReconnect(inflightRunIds: readonly string[]): StatusQuery[] {
  const unique = [...new Set(inflightRunIds)];
  const out: StatusQuery[] = [];
  for (let i = 0; i < unique.length; i += STATUS_MAX_RUNS) out.push({ run_ids: unique.slice(i, i + STATUS_MAX_RUNS) });
  return out;
}

// 같은 영수증·보고를 두 번 받았는지. seen은 id → 본문 digest다(감독 장부가 가진다).
export type Delivery = "new" | "duplicate";
export function classifyDelivery(
  seen: ReadonlyMap<string, string>,
  id: string,
  bodyDigest: string,
): { ok: true; delivery: Delivery } | { ok: false; reason: RejectReason } {
  const before = seen.get(id);
  if (before === undefined) return { ok: true, delivery: "new" };
  return before === bodyDigest ? { ok: true, delivery: "duplicate" } : { ok: false, reason: "receipt_conflict" };
}

// 새 실행이나 새 자격을 낳는 지시. 연결 규칙 1의 대상이다.
export const STARTS_RUN: readonly Action[] = ["session_start", "task_start"];
function isInstruction(action: Action): boolean {
  return (INSTRUCTIONS as readonly Action[]).includes(action);
}
