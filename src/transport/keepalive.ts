// 감독·실행기 연결의 TCP keepalive. 상대가 FIN·RST 없이 사라진(반쯤 열린) 연결을 운영체제가 끊어 소켓의 close로 오게 한다.
// 계약 v1 메시지(살아 있음 확인)를 더하지 않으므로 상대의 애플리케이션이 멈춘 것은 알아채지 못한다. 커널이 탐침에 답하면 산 것이다.
// 감독(supervisor/transport/server.ts)과 실행기(executor/socket.ts)가 이 한 자리의 값을 쓴다.

// 마지막 송수신 뒤 첫 탐침까지의 기다림. T1 실측 뒤 조정한다(server.md "반쯤 열린 연결").
// 런타임이 초 단위로 내림해 커널(TCP_KEEPIDLE)에 넘기므로 1,000의 배수로 둔다.
// 탐침 간격과 횟수(TCP_KEEPINTVL·TCP_KEEPCNT)는 이 API로 정하지 못한다. 운영체제(또는 런타임)의 값이 끊기까지의 나머지를 정한다.
export const KEEPALIVE_INITIAL_DELAY_MS = 30_000;

export interface KeepAliveSocket {
  setKeepAlive(enable: boolean, initialDelay: number): unknown;
}

// 켜지 못하면(메서드 읽기·호출이 던짐) false. 부르는 쪽은 그 연결을 쓰지 않고 닫는다: 감독이 끊김을 알 길이 없는 연결을 남기지 않는다.
export function enableKeepAlive(socket: KeepAliveSocket): boolean {
  try {
    socket.setKeepAlive(true, KEEPALIVE_INITIAL_DELAY_MS);
    return true;
  } catch {
    return false;
  }
}
