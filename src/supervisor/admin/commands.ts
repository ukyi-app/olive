// 관리 명령의 디스패치. 요청 한 줄을 받아 명령 이름으로 처리기를 고르고 답 한 줄을 낸다. 소켓은 모른다(listener.ts가 바이트를 맡는다).
// 새 명령은 protocol.ts의 ADMIN_COMMANDS와 이 파일의 처리기 표에 함께 더한다. 처리기 표의 타입이 명령마다 처리기 하나를 요구한다.
// 함정: 처리기는 도구 처리기의 포트(RunningSupervisor.tools)를 받지 않는다. 그 포트는 본체의 부탁을 소유자로 가르는 길이고, 관리 통로는
// 소유자를 가리지 않는 읽기를 쓴다. 둘을 섞으면 본체가 남의 부탁을 알게 된다(tools-adapter.md "관리 통로").
import { type AdminArgs, type AdminCommand, type AdminReply, encodeReply, parseRequest } from "./protocol.ts";
import { type AdminSources, readStatus } from "./status.ts";

export type AdminHandler = (args: AdminArgs) => AdminReply;
export type AdminHandlers = { readonly [Command in AdminCommand]: AdminHandler };

export function createAdminHandlers(sources: AdminSources): AdminHandlers {
  return Object.freeze({
    status: (args: AdminArgs): AdminReply => {
      if (Object.keys(args).length !== 0) return { kind: "refused", reason: "malformed" };
      const answer = readStatus(sources);
      return answer.known ? { kind: "status", status: answer.status } : { kind: "unknown", reason: answer.reason };
    },
  });
}

// 요청 한 줄(줄바꿈 뺀 것) → 답 한 줄(줄바꿈 포함). 처리기가 던지면 모름(read_threw)이다.
export function answerLine(line: string, handlers: AdminHandlers): string {
  const request = parseRequest(line);
  if (!request.ok) return encodeReply({ kind: "refused", reason: request.reason });
  let reply: AdminReply;
  try {
    reply = handlers[request.command](request.args);
  } catch {
    reply = { kind: "unknown", reason: "read_threw" };
  }
  return encodeReply(reply);
}
