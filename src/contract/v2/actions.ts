// 동작 표의 꼴과 공통부의 동작 넷(인사 둘, 조회 둘). 현관의 업무 동작은 묶음(Bundle)으로 index.ts에서 더한다.
import type { RejectReason } from "./errors.ts";
import type { Header, Party } from "./header.ts";
import { ACTION_NAME, isPlainObject, literal, object, type Parser, pattern, revision, SchemaError, sha256, uuid } from "./schema.ts";

// handshake: 판·정책 대조. query: 효과 없음(묻기와 그 답). effect: 바깥이나 장부에 무언가를 바꾼다.
export type ActionClass = "handshake" | "query" | "effect";

// 답이 가리키는 작업. request_digest는 그 효과 요청 봉투의 body_digest다.
export interface JobRef {
  job_id: string;
  action: string;
  request_digest: string;
}

// 이 연결에서 보내고 아직 답을 기다리는 요청 하나. action은 그 요청의 동작, job은 그 요청이 가리키는 작업(효과 요청이면 그 작업,
// job_lookup이면 묻는 작업, 그 밖은 null).
export interface Awaited {
  action: string;
  job: JobRef | null;
}

export interface BodyContext {
  header: Header;
  // 받는 쪽의 지금 시각. 봉투를 만들 때(seal)는 null이다.
  receivedAt: number | null;
  // 이 계약의 동작 표. 조회 본문의 action이 효과 동작인지, 확정 결과의 꼴이 무엇인지를 여기서 찾는다.
  table: ActionTable;
}

export interface ActionSpec {
  class: ActionClass;
  // 이 동작을 보낼 수 있는 쪽. 받는 쪽은 늘 보낸 쪽의 상대다.
  from: readonly Party[];
  // 받는 쪽의 접수가 닫혀도 받는가. 인사와 조회는 늘 true다(defineContract가 확인한다).
  duringClosedIntake: boolean;
  parse(body: unknown, ctx: BodyContext): unknown;
  // 효과 동작만: job_status의 확정 결과(result)의 꼴.
  parseResult?: Parser<unknown>;
  // 답 동작만: 본문 맨 위의 in_reply_to가 가리키는 요청(기다리는 요청)의 동작으로 받을 수 있는 것인가.
  answers?(awaitedAction: string, table: ActionTable): boolean;
  // 답 동작만: 기다리는 요청과 같은 것을 가리키는가. 없으면 answers만 본다.
  matches?(body: unknown, awaited: Awaited): boolean;
}

export type ActionTable = Readonly<Record<string, ActionSpec>>;

export interface Bundle {
  name: string;
  actions: Readonly<Record<string, ActionSpec>>;
}

// 묶음의 본문 해석기가 모양 밖의 관계(칸끼리, 본문과 머리)로 거절할 때 던진다. 사유는 errors.ts의 것이다.
export class BodyReject extends Error {
  constructor(readonly reason: RejectReason) {
    super(reason);
  }
}

const BOTH = ["front-door", "supervisor"] as const;

export const isEffect = (table: ActionTable, action: string) => Object.hasOwn(table, action) && table[action]!.class === "effect";

const effectAction =
  (table: ActionTable): Parser<string> =>
  (value, path) => {
    const name = pattern(ACTION_NAME)(value, path);
    if (!isEffect(table, name)) throw new SchemaError("malformed", path);
    return name;
  };

// ---- 인사 ----

export const parseHandshake = object({ policy_revision: revision });
export type Handshake = ReturnType<typeof parseHandshake>;
export const parseHandshakeReply = object({ in_reply_to: uuid, policy_revision: revision });
export type HandshakeReply = ReturnType<typeof parseHandshakeReply>;

// ---- 작업 조회 ----

export type JobLookup = JobRef;

// 확정·대기·모름은 서로 다른 값이다. "효과 없음"이라는 상태는 없다: 효과가 없었다는 것은 확정 결과(result)로만 온다.
export type JobStatus = { state: "confirmed"; result: unknown } | { state: "pending" } | { state: "unknown" };

export interface JobStatusReply extends JobRef {
  in_reply_to: string;
  status: JobStatus;
}

function parseJobLookup(body: unknown, ctx: BodyContext): JobLookup {
  return object({ job_id: uuid, action: effectAction(ctx.table), request_digest: sha256 })(body, "body");
}

function parseJobStatus(body: unknown, ctx: BodyContext): JobStatusReply {
  const parsed = object({
    in_reply_to: uuid,
    job_id: uuid,
    action: effectAction(ctx.table),
    request_digest: sha256,
    status: (value: unknown) => value,
  })(body, "body");
  const raw = parsed.status;
  if (!isPlainObject(raw)) throw new SchemaError("malformed", "body.status");
  let status: JobStatus;
  switch (raw.state) {
    case "confirmed": {
      const shape = object({ state: literal("confirmed"), result: (value: unknown) => value })(raw, "body.status");
      // effectAction이 이미 효과 동작임을 확인했고, defineContract가 효과 동작마다 parseResult를 요구한다.
      status = { state: "confirmed", result: ctx.table[parsed.action]!.parseResult!(shape.result, "body.status.result") };
      break;
    }
    case "pending":
      status = object({ state: literal("pending") })(raw, "body.status");
      break;
    case "unknown":
      status = object({ state: literal("unknown") })(raw, "body.status");
      break;
    default:
      throw new SchemaError("malformed", "body.status.state");
  }
  return { ...parsed, status };
}

const sameJob = (body: unknown, awaited: Awaited): boolean => {
  const reply = body as JobStatusReply;
  const job = awaited.job;
  return job !== null && job.job_id === reply.job_id && job.action === reply.action && job.request_digest === reply.request_digest;
};

// ---- 공통부의 동작 표 ----

export const COMMON_BUNDLE: Bundle = {
  name: "common",
  actions: {
    handshake: {
      class: "handshake",
      from: ["front-door"],
      duringClosedIntake: true,
      parse: (body) => parseHandshake(body, "body"),
    },
    handshake_reply: {
      class: "handshake",
      from: ["supervisor"],
      duringClosedIntake: true,
      parse: (body) => parseHandshakeReply(body, "body"),
      answers: (awaitedAction) => awaitedAction === "handshake",
    },
    job_lookup: {
      class: "query",
      from: BOTH,
      duringClosedIntake: true,
      parse: parseJobLookup,
    },
    job_status: {
      class: "query",
      from: BOTH,
      duringClosedIntake: true,
      parse: parseJobStatus,
      // 효과 요청의 바로 답이자 job_lookup의 답이다.
      answers: (awaitedAction, table) => awaitedAction === "job_lookup" || isEffect(table, awaitedAction),
      matches: sameJob,
    },
  },
};

// ---- 묻는 쪽이 아는 것 ----

// 한 번의 물음(효과 요청이나 job_lookup)에서 묻는 쪽이 얻은 것. 답을 받지 못했으면(시간 초과, 연결 끊김, 받은 답이 거절됨) 모름이다.
// 시간 초과는 효과가 없었다는 증거가 아니라서 "효과 없음"으로 바꾸는 길을 타입에 두지 않는다. 같은 job_id로 다시 묻는다.
export type NoAnswerCause = "timeout" | "disconnected" | "reply_rejected";
export type LookupOutcome = { answered: true; status: JobStatus } | { answered: false; cause: NoAnswerCause };

export function isSettled(outcome: LookupOutcome): outcome is { answered: true; status: { state: "confirmed"; result: unknown } } {
  return outcome.answered && outcome.status.state === "confirmed";
}

// 인사 상태. none에서 agreed나 policy_mismatch로 한 번만 바뀐다. 상태는 연결을 가진 쪽이 들고, 검증기는 문맥으로 받는다.
export type HandshakeState = "none" | "agreed" | "policy_mismatch";
