// 동작마다 누가 누구에게 보내는지, 본문의 모양, 세대를 대조할 실행 ID 칸. 이 표에 없는 동작은 unknown_action이다.
// 현관(front-door)이 낼 수 있는 동작은 v1에 없다. 감독과 현관의 동작(§9.1)을 더하면 표가 바뀌므로 판을 올린다.
import { type Action, type BodyContext, BodyReject } from "./header.ts";
import {
  advancesStopGeneration,
  parseResultFinalize,
  parseRunRenew,
  parseSessionStart,
  parseSessionStop,
  parseTaskCancel,
  parseTaskStart,
} from "./instruction.ts";
import type { PartyKind } from "./principal.ts";
import {
  parseReceiptAccepted,
  parseReceiptCleaned,
  parseReceiptSessionTakeover,
  parseReceiptStarted,
  parseReceiptStopped,
} from "./receipt.ts";
import { parseHookEvent, parseResultReport, parseRuleCheck, parseSessionBroken } from "./report.ts";
import { STOP_SYNC_TTL_MAX_MS, STOP_SYNC_TTL_MS } from "./limits.ts";
import { parseAck, parseHello, parseStatusQuery, parseStatusReport, parseStopSyncReply, parseStopSyncRequest } from "./transport.ts";

export type ActionClass = "instruction" | "receipt" | "report" | "transport";

export interface ActionSpec {
  class: ActionClass;
  from: readonly PartyKind[];
  to: readonly PartyKind[];
  // 세대를 대조할 실행 ID가 든 본문 칸. null이면 실행에 묶이지 않고 머리의 run_generation은 0이어야 한다.
  runField: string | null;
  // true면 받는 쪽이 아직 모르는 실행 ID를 받는다(새 실행을 여는 지시). 그때 run_generation은 1 이상이다.
  opensRun: boolean;
  // 실행별 세대를 담은 상태 목록의 본문 칸(hello, status_report). 받는 쪽이 아는 실행은 그 세대와 대조한다.
  runList?: "runs";
  // 받는 쪽보다 높은 정지 세대를 받아들여도 되는 본문인가(instruction.ts의 advancesStopGeneration). 없으면 정확히 같아야 한다.
  advancesStop?: (body: unknown) => boolean;
  // 정지 세대 맞춤의 두 메시지(transport.ts). 이 둘은 정확 일치 대신 envelope.ts의 맞춤 규칙으로 세대를 본다.
  stopSync?: "request" | "reply";
  // 봉투 수명의 받는 쪽 상한(v1에 고정). 없으면 MESSAGE_TTL_MAX_MS다. verifyEnvelope가 넘는 봉투를 lifetime_invalid로 거절한다.
  maxLifetimeMs?: number;
  // 내는 쪽 기본 수명. 없으면 MESSAGE_TTL_MS다. sealEnvelope가 이 값으로 expires_at을 정한다. maxLifetimeMs 이하다(시험이 지킨다).
  lifetimeMs?: number;
  parse(body: unknown, ctx: BodyContext): unknown;
}

const SUP = ["supervisor"] as const;
const SESSION = ["session_executor"] as const;
const WORKER = ["worker_executor"] as const;
const EXECUTORS = ["session_executor", "worker_executor"] as const;

const plain = (parse: (value: unknown, path: string) => unknown) => (body: unknown) => parse(body, "body");

export const ACTION_SPECS: Readonly<Record<Action, ActionSpec>> = Object.freeze({
  session_start: { class: "instruction", from: SUP, to: SESSION, runField: "run_id", opensRun: true, parse: plain(parseSessionStart) },
  session_stop: {
    class: "instruction",
    from: SUP,
    to: SESSION,
    runField: "run_id",
    opensRun: false,
    advancesStop: (body) => advancesStopGeneration("session_stop", body),
    parse: plain(parseSessionStop),
  },
  task_start: {
    class: "instruction",
    from: SUP,
    to: WORKER,
    runField: "run_id",
    opensRun: true,
    parse: (body, ctx) => parseTaskStart(body, "body", ctx),
  },
  task_cancel: {
    class: "instruction",
    from: SUP,
    to: WORKER,
    runField: "run_id",
    opensRun: false,
    advancesStop: (body) => advancesStopGeneration("task_cancel", body),
    parse: plain(parseTaskCancel),
  },
  run_renew: {
    class: "instruction",
    from: SUP,
    to: EXECUTORS,
    runField: "run_id",
    opensRun: false,
    parse: (body, ctx) => parseRunRenew(body, "body", ctx),
  },
  result_finalize: { class: "instruction", from: SUP, to: WORKER, runField: "run_id", opensRun: false, parse: plain(parseResultFinalize) },

  receipt_accepted: { class: "receipt", from: EXECUTORS, to: SUP, runField: "run_id", opensRun: false, parse: plain(parseReceiptAccepted) },
  receipt_started: { class: "receipt", from: EXECUTORS, to: SUP, runField: "run_id", opensRun: false, parse: plain(parseReceiptStarted) },
  receipt_stopped: { class: "receipt", from: WORKER, to: SUP, runField: "run_id", opensRun: false, parse: plain(parseReceiptStopped) },
  receipt_cleaned: { class: "receipt", from: WORKER, to: SUP, runField: "run_id", opensRun: false, parse: plain(parseReceiptCleaned) },
  receipt_session_takeover: {
    class: "receipt",
    from: SESSION,
    to: SUP,
    runField: "previous_run_id",
    opensRun: false,
    parse: plain(parseReceiptSessionTakeover),
  },

  report_session_broken: { class: "report", from: SESSION, to: SUP, runField: "run_id", opensRun: false, parse: plain(parseSessionBroken) },
  report_rule_check: { class: "report", from: SESSION, to: SUP, runField: null, opensRun: false, parse: plain(parseRuleCheck) },
  report_hook_event: { class: "report", from: SESSION, to: SUP, runField: "run_id", opensRun: false, parse: plain(parseHookEvent) },
  report_result: {
    class: "report",
    from: WORKER,
    to: SUP,
    runField: "run_id",
    opensRun: false,
    parse: (body, ctx) => {
      const report = parseResultReport(body, "body");
      // 결과의 역할은 보낸 실행기의 고정 역할과 같아야 한다.
      if (ctx.sender.kind !== "worker_executor" || ctx.sender.role !== report.result.role) throw new BodyReject("role_mismatch");
      return report;
    },
  },

  hello: { class: "transport", from: EXECUTORS, to: SUP, runField: null, opensRun: false, runList: "runs", parse: plain(parseHello) },
  status_query: { class: "transport", from: SUP, to: EXECUTORS, runField: null, opensRun: false, parse: plain(parseStatusQuery) },
  status_report: { class: "transport", from: EXECUTORS, to: SUP, runField: null, opensRun: false, runList: "runs", parse: plain(parseStatusReport) },
  ack: { class: "transport", from: SUP, to: EXECUTORS, runField: null, opensRun: false, parse: plain(parseAck) },
  stop_sync_request: {
    class: "transport",
    from: EXECUTORS,
    to: SUP,
    runField: null,
    opensRun: false,
    stopSync: "request",
    maxLifetimeMs: STOP_SYNC_TTL_MAX_MS,
    lifetimeMs: STOP_SYNC_TTL_MS,
    parse: plain(parseStopSyncRequest),
  },
  stop_sync_reply: {
    class: "transport",
    from: SUP,
    to: EXECUTORS,
    runField: null,
    opensRun: false,
    stopSync: "reply",
    maxLifetimeMs: STOP_SYNC_TTL_MAX_MS,
    lifetimeMs: STOP_SYNC_TTL_MS,
    parse: plain(parseStopSyncReply),
  },
} satisfies Record<Action, ActionSpec>);

export function isAction(value: unknown): value is Action {
  return typeof value === "string" && Object.hasOwn(ACTION_SPECS, value);
}
