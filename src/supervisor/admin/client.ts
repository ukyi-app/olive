// 관리 진입점(src/main/admin.ts)의 붙는 쪽. 감독의 관리 소켓에 붙어 요청 한 줄을 쓰고 답 한 줄을 읽어 종료 코드와 출력을 정한다.
// 소켓 API는 진입점이 connect 포트로 넘긴다. 듣지 않는다. 장부·박자·연결 서버를 import하지 않는다(protocol.ts만 쓴다).
// 기한은 붙기 전에 정한 절대 기한 하나이고(ADMIN_LIMITS.clientWaitMs), 연결 성공·답 한 줄·끊김·연결 실패를 받는 순간의
// 단조 시각으로 판정한다. 타이머가 늦게 와도 정각 이후에 받은 연결에는 요청을 쓰지 않고, 정각 이후에 받은 답은 쓰지 않는다.
import {
  ADMIN_LIMITS,
  ADMIN_SOCKET_PATH,
  type AdminCall,
  type AdminCommand,
  type AdminReply,
  encodeRequest,
  holdsLine,
  isReleaseCommand,
  parseReply,
  RELEASE_COMMANDS,
  RELEASE_FIELDS,
  releaseLine,
  statusLine,
  TEST_JOB_FIELDS,
  type TestJobRequest,
  testJobLine,
} from "./protocol.ts";

export interface ClientSocket {
  write(bytes: Uint8Array): number;
  end(): void;
}

export interface ClientHandlers {
  data(chunk: Uint8Array): void;
  close(): void;
}

export interface ClientDeps {
  // 붙으면 소켓을 준다. 못 붙으면 code를 실은 오류로 거절한다(ENOENT: 소켓 파일 없음, ECONNREFUSED: 듣는 프로세스 없음).
  connect(path: string, handlers: ClientHandlers): Promise<ClientSocket>;
  monoNow(): number;
  setTimer(ms: number, fire: () => void): () => void;
}

export type AskOutcome =
  | { readonly kind: "reply"; readonly reply: AdminReply }
  // 감독에 닿지 못했다: 소켓 파일이 없다(감독이 없거나 아직 듣기 전), 파일은 있으나 듣는 프로세스가 없다, 그 밖의 연결 실패.
  | { readonly kind: "unreachable"; readonly reason: "no_socket" | "not_listening" | "connect_failed" }
  // 붙었지만 답 한 줄을 받지 못했다.
  | { readonly kind: "failed"; readonly reason: "timeout" | "closed" | "too_long" | "malformed" | "write_failed" | "clock" };

const NEWLINE = 0x0a;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function unreachable(error: unknown): AskOutcome {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === "ENOENT") return { kind: "unreachable", reason: "no_socket" };
  if (code === "ECONNREFUSED") return { kind: "unreachable", reason: "not_listening" };
  return { kind: "unreachable", reason: "connect_failed" };
}

export function ask(command: AdminCommand | AdminCall, deps: ClientDeps, path: string = ADMIN_SOCKET_PATH): Promise<AskOutcome> {
  return new Promise((resolve) => {
    let ended = false;
    let cancel: () => void = () => {};
    let socket: ClientSocket | null = null;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const end = (outcome: AskOutcome) => {
      if (ended) return;
      ended = true;
      try {
        cancel();
      } catch {
        // 취소하지 못한 타이머가 늦게 불려도 정해진 결과는 바뀌지 않는다.
      }
      try {
        socket?.end();
      } catch {
        // 이미 닫힌 소켓
      }
      resolve(outcome);
    };
    let limit: number;
    try {
      limit = deps.monoNow() + ADMIN_LIMITS.clientWaitMs;
      if (!Number.isFinite(limit)) throw new RangeError("clock");
    } catch {
      return end({ kind: "failed", reason: "clock" });
    }
    // 시각을 읽지 못하면 기한이 지난 것으로 본다.
    const pastLimit = (): boolean => {
      try {
        const at = deps.monoNow();
        return !(Number.isFinite(at) && at < limit);
      } catch {
        return true;
      }
    };
    const accept = (outcome: AskOutcome) => end(pastLimit() ? { kind: "failed", reason: "timeout" } : outcome);
    const arm = () => {
      try {
        const left = Math.max(1, Math.ceil(limit - deps.monoNow()));
        if (!Number.isFinite(left)) throw new RangeError("clock");
        cancel = deps.setTimer(left, () => (pastLimit() ? end({ kind: "failed", reason: "timeout" }) : arm()));
      } catch {
        end({ kind: "failed", reason: "clock" });
      }
    };
    const handlers: ClientHandlers = {
      data: (chunk) => {
        if (ended) return;
        chunks.push(new Uint8Array(chunk));
        bytes += chunk.length;
        const all = new Uint8Array(bytes);
        let at = 0;
        for (const piece of chunks) {
          all.set(piece, at);
          at += piece.length;
        }
        const stop = all.indexOf(NEWLINE);
        if (stop < 0) {
          if (bytes >= ADMIN_LIMITS.replyMaxBytes) accept({ kind: "failed", reason: "too_long" });
          return;
        }
        if (stop + 1 > ADMIN_LIMITS.replyMaxBytes) return accept({ kind: "failed", reason: "too_long" });
        if (stop + 1 !== bytes) return accept({ kind: "failed", reason: "malformed" });
        let reply: AdminReply | null = null;
        try {
          reply = parseReply(UTF8.decode(all.subarray(0, stop)));
        } catch {
          reply = null;
        }
        accept(reply === null ? { kind: "failed", reason: "malformed" } : { kind: "reply", reply });
      },
      close: () => accept({ kind: "failed", reason: "closed" }),
    };
    arm();
    if (ended) return;
    let connecting: Promise<ClientSocket>;
    try {
      connecting = deps.connect(path, handlers);
    } catch (error) {
      return accept(unreachable(error));
    }
    connecting.then(
      (opened) => {
        if (ended) {
          try {
            opened.end();
          } catch {
            // 이미 닫힌 소켓
          }
          return;
        }
        socket = opened;
        // 연결을 받은 순간이 기한 정각 이후면 요청을 쓰지 않고 닫는다(타이머가 아직 불리지 않았어도). 쓰면 호출자는 실패를 받는데
        // 감독에는 처리할 요청이 남는다.
        if (pastLimit()) return end({ kind: "failed", reason: "timeout" });
        const request = new TextEncoder().encode(encodeRequest(command));
        let wrote: number;
        try {
          wrote = opened.write(request);
        } catch {
          wrote = -1;
        }
        // 요청은 수십 바이트라 한 번에 써진다. 다 못 쓰면 이어 쓰지 않고 실패로 본다.
        if (wrote !== request.length) accept({ kind: "failed", reason: "write_failed" });
      },
      (error: unknown) => accept(unreachable(error)),
    );
  });
}

// 종료 코드. homelab CLI의 공통 규칙(D-61)을 따른다: 0 완료, 1 실패, 3 대기, 64 사용법.
// 복원 전(감독은 답했지만 상태를 알려진 값으로 낼 수 없음)은 3이다: 감독이 복원을 마치면 풀릴 수 있는 기다림이다.
// 감독에 닿지 못함·감독이 읽지 못함·답 꼴이 틀림은 1이다. 0이 아니면 stdout에 아무것도 쓰지 않는다(상태로 읽힐 줄이 없다).
export const ADMIN_EXIT = { ok: 0, failed: 1, waiting: 3, usage: 64 } as const;

export interface EntryResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const PREFIX = "olive admin";

const form = (command: string, fields: readonly string[]) => [command, ...fields.map((field) => `<${field}>`)].join(" ");

export const USAGE: EntryResult = {
  code: ADMIN_EXIT.usage,
  stdout: "",
  stderr: `${PREFIX}: 사용법: bun src/main/admin.ts ${["status", "holds", form("test-job", TEST_JOB_FIELDS), ...RELEASE_COMMANDS.map((command) => form(command, RELEASE_FIELDS[command]))].join(" | ")}\n`,
};

const BYTES = new TextEncoder();

// argv(실행 파일·진입점 뒤)에서 요청 하나. status·holds는 인자가 없고, test-job은 TEST_JOB_FIELDS 차례의 값 여섯, 자리 풀기 쓰기는
// RELEASE_FIELDS 차례의 값이다. 수가 다르거나, 빈 값이 있거나, 요청 한 줄이 감독의 상한(requestMaxBytes)을 넘으면 null이다(넘는 줄은
// 감독이 답하지 않고 닫는다). 값의 꼴은 감독이 본다.
export function requestOf(argv: readonly string[]): AdminCall | null {
  const [word, ...rest] = argv;
  if (word === "status" || word === "holds") return rest.length === 0 ? { command: word } : null;
  let call: AdminCall;
  if (word === "test-job") {
    if (rest.length !== TEST_JOB_FIELDS.length || rest.some((value) => value === "")) return null;
    const job = Object.fromEntries(TEST_JOB_FIELDS.map((field, index) => [field, rest[index]!])) as TestJobRequest;
    call = { command: "test-job", job };
  } else if (isReleaseCommand(word)) {
    const names = RELEASE_FIELDS[word];
    if (rest.length !== names.length || rest.some((value) => value === "")) return null;
    call = { command: word, fields: Object.fromEntries(names.map((field, index) => [field, rest[index]!])) };
  } else return null;
  return BYTES.encode(encodeRequest(call)).length > ADMIN_LIMITS.requestMaxBytes ? null : call;
}

// 인자 없는 명령 하나(status). 인자가 필요한 명령·틀린 argv는 null이다.
export function commandOf(argv: readonly string[]): AdminCommand | null {
  const call = requestOf(argv);
  return call?.command === "status" ? "status" : null;
}

// 명령마다 받을 수 있는 답이 다르다: status는 상태, test-job은 시험 작업, holds는 자리 목록, 자리 풀기 쓰기는 자리 풀기. 다른 명령의 답이
// 오면 꼴이 틀린 답이다. 장부가 자리 풀기를 거절하면 stderr의 사유는 ledger_refused:<장부의 거절 이름>이다.
export function exitFor(outcome: AskOutcome, command: AdminCommand = "status"): EntryResult {
  const subject = command === "status" ? "상태" : command === "test-job" ? "시험 작업" : command === "holds" ? "자리 목록" : "자리 풀기";
  const fail = (code: number, message: string): EntryResult => ({ code, stdout: "", stderr: `${PREFIX}: ${message}\n` });
  if (outcome.kind === "unreachable") return fail(ADMIN_EXIT.failed, `${subject} 모름: 감독에 닿지 못했다(${outcome.reason})`);
  if (outcome.kind === "failed") return fail(ADMIN_EXIT.failed, `${subject} 모름: 감독의 답을 받지 못했다(${outcome.reason})`);
  const reply = outcome.reply;
  if (reply.kind === "status" || reply.kind === "test_job" || reply.kind === "holds" || reply.kind === "release") {
    const ok = (line: string): EntryResult => ({ code: ADMIN_EXIT.ok, stdout: `${line}\n`, stderr: "" });
    if (command === "status" && reply.kind === "status") return ok(statusLine(reply.status));
    if (command === "test-job" && reply.kind === "test_job") return ok(testJobLine(reply));
    if (command === "holds" && reply.kind === "holds") return ok(holdsLine(reply.holds));
    if (isReleaseCommand(command) && reply.kind === "release") return ok(releaseLine(reply.release));
    return fail(ADMIN_EXIT.failed, `${subject} 모름: 감독의 답을 받지 못했다(malformed)`);
  }
  if (reply.kind === "refused") return fail(ADMIN_EXIT.failed, `감독이 요청을 거절했다(${reply.refusal === undefined ? reply.reason : `${reply.reason}:${reply.refusal}`})`);
  if (reply.reason === "restore_not_done") return fail(ADMIN_EXIT.waiting, `${subject} 모름: 감독이 복원을 마치지 않았다(restore_not_done)`);
  // 시험 작업·자리 풀기의 write_unknown만 장부에 적혔을 수 있다(다시 부르는 법은 README "감독 관리 통로").
  if (reply.reason === "write_unknown") return fail(ADMIN_EXIT.failed, `${subject} 모름: 장부에 적혔는지 모른다(write_unknown)`);
  return fail(ADMIN_EXIT.failed, `${subject} 모름: 감독이 상태를 읽지 못했다(${reply.reason})`);
}
