// 시험 작업 넣기(D-98·D-101)의 감독 쪽 처리기. 시험 클러스터에서만 켜는 관리 명령이다. 켜져 있으면 장부의 공개 쓰기 recordToolRequest
// 한 번으로 배정 대기 부탁 한 줄을 적는다: 본체의 start_worker가 도구 어댑터(runtime/tools-adapter.ts의 recordStart)로 적는 것과 같은
// 장부 연산, 같은 줄이다. 꺼져 있으면 조립이 이 처리기의 포트를 만들지 않고 commands.ts가 고정 거절(disabled)을 둔다.
//
// 도구 경로와의 관계: 도구 처리기(scheduler/tools.ts)와 그 포트(RunningSupervisor.tools)를 거치지 않는다. 그래서 처리기가 장부 전에 보는
// 세션(liveSession)·입력 고정(inputPinned)·정책(judge)을 보지 않는다. 장부의 검사는 그대로 지난다: 소유자는 장부가 이미 접수한 입력이어야
// 하고(외래 키, 아니면 invariant_violation), 같은 트랜잭션에서 정지·접수 허가를 다시 본다(쓰기 모드 start). 소유자 입력을 이 명령이 만들지 않는다.
//
// 배정될 수 있는가: 소유자 입력이 취소·만료된 부탁은 배정이 늘 거절하고(input_cancelled·input_expired) 지우는 관리 명령이 없다. 그래서 쓰기
// 전에 장부 읽기 listInputs로 소유자 입력을 보고 취소·만료면 owner_inactive로 거절한다. 장부에 없는 소유자는 여기서 거절하지 않고 장부의
// 외래 키가 막게 둔다(invariant_violation). 대기 한도는 배정될 수 있는 대기만 센다: 이미 막힌 대기 부탁(listWaitingToolRequests가 낸 소유자
// 입력이 취소·만료)이 새 부탁을 영구히 막지 않게. 막힌 줄은 그대로 남는다(정리는 이 명령의 일이 아니다).
// 함정: 이 두 읽기는 peekStatus와 달리 실패하면 장부를 고장으로 표시하고 접수 허가를 버린다(쓰기 recordToolRequest의 실패와 같다).
// 그래서 켜진 감독에서만 있고, 대기 목록은 상태의 대기 수가 한도에 닿았을 때만 읽는다.
//
// 차례: 칸 검사 → 상태 읽기(status.ts의 readStatus: 복원·살아 있음·정지·접수·대기 수) → 시각 → 소유자 입력 → 대기 한도 → 참조 후보·호출 ID →
// 쓰기 함수 얻기 → 문 → 호출 하나. 얻기와 호출 사이에는 문 한 번의 호출만 있다(dispatch/send-gate.ts의 callAfterGate와 같은 차례). 문은 조립 상태와 요청 기한을
// 한 호출에서 보고 시각을 맨 끝에 읽는다: 둘을 따로 부르면 앞 문을 지난 뒤 둘째 읽기 사이의 일을 앞 문이 보지 못한다. 한 동기 구간이라 박자의
// 쓰기가 사이에 끼지 않는다.
// 함정: 상태 읽기와 문은 장부를 고장으로 표시하지 않고 끝낼 사유의 래치를 움직이지 않는다. 장부의 진짜 판정(허가·정지)은 쓰기 트랜잭션 안의 것이다.
import { ROLES } from "../../contract/v1/index.ts";
import type { Ledger } from "../../ledger/index.ts";
import { REF, SHA256, SOURCE_REF, UUID } from "../../ledger/input.ts";
import { newUuid } from "../dispatch/envelopes.ts";
import type { Random } from "../dispatch/ports.ts";
import { type AdminArgs, type AdminReply, type RefusedReason, TEST_JOB_FIELDS, type TestJobRequest, type UnknownReason } from "./protocol.ts";
import { type AdminSources, readStatus } from "./status.ts";

// 조립(runtime/boot.ts)이 설정이 켜졌을 때만 만드는 포트.
export interface TestJobPorts {
  // 장부의 쓰기 하나와 읽기 둘만 담은 객체. 처리기는 문을 보기 직전에 쓰기 칸을 꺼낸다.
  readonly ledger: Pick<Ledger, "recordToolRequest" | "listInputs" | "listWaitingToolRequests">;
  // 조립의 문 하나: 끝 차례·끝낼 사유·복원 5단계·받아들인 허가·박자 기한을 보고(closed), 맨 끝에 단조 시각을 읽어 요청 기한 limit 정각
  // 전인지 본다(late, 시각을 읽지 못해도 late). 장부를 읽지 않고 래치를 움직이지 않는다. limit은 관리 소켓의 기한과 같은 단조 시계의 값이다.
  readonly gate: (limit: number) => "open" | "closed" | "late";
  // 참조 후보와 호출 ID. 암호학적 난수여야 한다(장부 줄의 참조는 표 전체에서 유일하다).
  readonly random: Random;
}

export const TEST_JOB_LIMITS = {
  // 배정될 수 있는 대기(상태 한 줄의 queued: 배정 전 부탁과 자리를 받기 전 실행에서, 소유자 입력이 취소·만료된 대기 부탁을 뺀 수)가 이 수
  // 이상이면 받지 않는다. 작업 자리는 통틀어 하나라 대기를 쌓아도 차례만 길어지고, 한 바퀴를 보는 시험에는 하나면 된다. 다른 출처의 부탁도 같이 센다.
  maxQueued: 1,
} as const;

// 시험 작업 줄의 세션 칸. 장부에서 시험 작업 줄을 가를 수 있는 고정 값이다(본체 세션의 ID는 이 값을 쓰지 않는다).
export const TEST_JOB_SESSION = "admin-test-job";
// 목적 분류 코드의 꼴. 장부의 PURPOSE(ledger.ts)와 같다(시험이 대조한다).
export const TEST_JOB_PURPOSE = /^[a-z][a-z0-9_]{0,63}$/;

const refused = (reason: RefusedReason): AdminReply => ({ kind: "refused", reason });
const unknown = (reason: UnknownReason): AdminReply => ({ kind: "unknown", reason });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const fits = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.test(value);

// 요청의 칸을 장부의 꼴로 본다. 칸이 정확히 여섯이 아니거나 하나라도 꼴이 틀리면 null이다(장부를 부르지 않는다).
function jobOf(args: AdminArgs): TestJobRequest | null {
  const keys = Object.keys(args);
  if (keys.length !== TEST_JOB_FIELDS.length || !TEST_JOB_FIELDS.every((field) => Object.hasOwn(args, field))) return null;
  const { owner, key, role, purpose, sourceRef, inputDigest } = args;
  if (!fits(owner, UUID) || !fits(key, REF) || !(ROLES as readonly unknown[]).includes(role) || !fits(purpose, TEST_JOB_PURPOSE)) return null;
  if (!fits(sourceRef, SOURCE_REF) || !fits(inputDigest, SHA256)) return null;
  return { owner, key, role: role as string, purpose, sourceRef, inputDigest };
}

// 장부의 답을 넘긴 값과 대조한다. ok:false는 트랜잭션이 되돌려진 거절이라 적힌 것이 없다. 답이 넘긴 값과 어긋나면 무엇이 적혔는지 모른다.
function replyOf(written: unknown, sent: { readonly ref: string; readonly job: TestJobRequest }): AdminReply {
  if (!isRecord(written)) return unknown("write_unknown");
  const ok: unknown = written.ok;
  if (ok === false) {
    const reason: unknown = written.reason;
    if (reason === "stopped") return refused("stopped");
    if (reason === "intake_closed" || reason === "snapshot_hold") return refused("intake_closed");
    if (reason === "invariant_violation") return refused("invariant_violation");
    return refused("ledger_refused");
  }
  if (ok !== true) return unknown("write_unknown");
  const outcome: unknown = written.outcome;
  const request: unknown = written.request;
  if (!isRecord(request)) return unknown("write_unknown");
  const { ref, owner, dedupeKey, role, purpose, sourceRef, inputDigest } = request;
  const { job } = sent;
  if (!fits(ref, UUID) || owner !== job.owner || dedupeKey !== job.key) return unknown("write_unknown");
  const same = role === job.role && purpose === job.purpose && sourceRef === job.sourceRef && inputDigest === job.inputDigest;
  if (outcome === "created" && same && ref === sent.ref) return { kind: "test_job", outcome: "created", ref };
  if (outcome === "existing" && same) return { kind: "test_job", outcome: "existing", ref };
  // 같은 키에 내용이 다른 줄이 있다. 새로 적지 않았다.
  if (outcome === "conflict" && !same) return refused("conflict");
  return unknown("write_unknown");
}

// limit은 관리 소켓이 이 요청 한 줄에 정한 기한(listener.ts의 serverWaitMs)이다. 쓰기는 그 기한 정각 전에만 부른다.
export function testJobHandler(sources: AdminSources, ports: TestJobPorts): (args: AdminArgs, limit: number) => AdminReply {
  return (args, limit) => {
    const job = jobOf(args);
    if (job === null) return refused("malformed");
    let calling = false;
    try {
      const answer = readStatus(sources);
      if (!answer.known) return unknown(answer.reason);
      const status = answer.status;
      if (!status.alive) return refused("not_alive");
      if (status.stop !== "none") return refused("stopped");
      if (!status.intakeOpen) return refused("intake_closed");
      // 줄의 기록 시각이자 만료 판정의 시각. 공유 시계의 peek라 하한을 올리지 않는다. 만료 경계는 배정과 같다(만료 시각 정각부터 만료).
      const clock = sources.now();
      if (clock.state !== "ok" || !Number.isSafeInteger(clock.at) || clock.at <= 0) return unknown("clock_unavailable");
      const now = clock.at;
      const inactive = (input: { readonly cancelled: boolean; readonly expiresAt: number }) => input.cancelled || input.expiresAt <= now;
      const inputs = ports.ledger.listInputs();
      if (!inputs.known) return unknown("ledger_unreadable");
      const owner = inputs.value.find((entry) => entry.requestId === job.owner);
      if (owner !== undefined && inactive(owner)) return refused("owner_inactive");
      if (status.queued >= TEST_JOB_LIMITS.maxQueued) {
        const waiting = ports.ledger.listWaitingToolRequests();
        if (!waiting.known) return unknown("ledger_unreadable");
        // 상태의 대기 수와 같은 줄(대기이고 실행에 잇지 않은 부탁)을 같은 동기 구간에서 읽었다. 더 많으면 두 읽기가 어긋난 것이다.
        if (waiting.value.length > status.queued) return unknown("out_of_range");
        const blocked = waiting.value.filter((request) => inactive(request.input)).length;
        if (status.queued - blocked >= TEST_JOB_LIMITS.maxQueued) return refused("limit");
      }
      const ref = newUuid(ports.random);
      const callId = newUuid(ports.random);
      if (ref === null || callId === null) return unknown("random_unavailable");
      const input = {
        ref,
        owner: job.owner,
        dedupeKey: job.key,
        role: job.role,
        purpose: job.purpose,
        sourceRef: job.sourceRef,
        inputDigest: job.inputDigest,
        sessionId: TEST_JOB_SESSION,
        callId,
        now,
      };
      const ledger = ports.ledger;
      const record = ledger.recordToolRequest;
      if (typeof record !== "function") return unknown("read_threw");
      const gate = ports.gate(limit);
      if (gate !== "open") return refused(gate === "late" ? "late" : "not_alive");
      calling = true;
      return replyOf(record.call(ledger, input), { ref, job });
    } catch {
      return unknown(calling ? "write_unknown" : "read_threw");
    }
  };
}
