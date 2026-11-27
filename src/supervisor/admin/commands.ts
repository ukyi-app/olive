// 관리 명령의 디스패치. 요청 한 줄을 받아 명령 이름으로 처리기를 고르고 답 한 줄을 낸다. 소켓은 모른다(listener.ts가 바이트를 맡는다).
// 새 명령은 protocol.ts의 ADMIN_COMMANDS와 이 파일의 처리기 표에 함께 더한다. 처리기 표의 타입이 명령마다 처리기 하나를 요구한다.
// 함정: 처리기는 도구 처리기의 포트(RunningSupervisor.tools)를 받지 않는다. 그 포트는 본체의 부탁을 소유자로 가르는 길이고, 관리 통로는
// 소유자를 가리지 않는 읽기를 쓴다. 둘을 섞으면 본체가 남의 부탁을 알게 된다(tools-adapter.md "관리 통로").
// status·holds는 감독의 어떤 상태도 바꾸지 않는다. 장부에 쓰는 명령은 test-job과 자리 풀기 쓰기 넷이다. test-job의 포트(TestJobPorts)는 조립이
// 설정이 켜졌을 때만 주고, 자리 풀기의 포트(ReleasePorts)는 조립이 늘 준다(release.ts). 자리 풀기 포트가 없으면(조립 밖의 시험) 다섯 명령은 disabled다.
import { type AdminArgs, type AdminCommand, type AdminReply, encodeReply, parseRequest, type ReleaseCommand } from "./protocol.ts";
import { holdsHandler, type ReleasePorts, releaseHandler } from "./release.ts";
import { type AdminSources, readStatus } from "./status.ts";
import { type TestJobPorts, testJobHandler } from "./test-job.ts";

// limit은 관리 소켓이 그 요청 한 줄에 정한 단조 시각 기한이다. 효과를 내는 처리기만 본다.
export type AdminHandler = (args: AdminArgs, limit: number) => AdminReply;
export type AdminHandlers = { readonly [Command in AdminCommand]: AdminHandler };

// 시험 작업 넣기가 꺼진 감독의 답. 칸을 보지 않고 늘 같다: 꺼진 감독에는 장부 쓰기가 닿는 길이 없다.
const DISABLED: AdminReply = Object.freeze({ kind: "refused", reason: "disabled" });

export function createAdminHandlers(sources: AdminSources, testJob: TestJobPorts | null = null, release: ReleasePorts | null = null): AdminHandlers {
  const write = (command: ReleaseCommand): AdminHandler => (release === null ? (): AdminReply => DISABLED : releaseHandler(command, sources, release));
  return Object.freeze({
    status: (args: AdminArgs): AdminReply => {
      if (Object.keys(args).length !== 0) return { kind: "refused", reason: "malformed" };
      const answer = readStatus(sources);
      return answer.known ? { kind: "status", status: answer.status } : { kind: "unknown", reason: answer.reason };
    },
    "test-job": testJob === null ? (): AdminReply => DISABLED : testJobHandler(sources, testJob),
    holds: release === null ? (): AdminReply => DISABLED : holdsHandler(sources, release),
    "close-unconfirmed": write("close-unconfirmed"),
    "abandon-result": write("abandon-result"),
    "close-store-reset": write("close-store-reset"),
    "release-hold": write("release-hold"),
  });
}

// 요청 한 줄(줄바꿈 뺀 것) → 답 한 줄(줄바꿈 포함). 처리기가 던지면 모름(read_threw)이다. limit을 주지 않으면 기한을 모르는 것이라
// 효과를 내는 처리기는 쓰지 않는다(test-job·자리 풀기 쓰기는 late).
export function answerLine(line: string, handlers: AdminHandlers, limit: number = Number.NaN): string {
  const request = parseRequest(line);
  if (!request.ok) return encodeReply({ kind: "refused", reason: request.reason });
  let reply: AdminReply;
  try {
    reply = handlers[request.command](request.args, limit);
  } catch {
    reply = { kind: "unknown", reason: "read_threw" };
  }
  return encodeReply(reply);
}
