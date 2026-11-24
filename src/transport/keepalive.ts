// 감독·실행기 연결의 TCP keepalive. 상대가 FIN·RST 없이 사라진(반쯤 열린) 연결을 운영체제가 끊어 소켓의 close로 오게 한다.
// 계약 v1 메시지(살아 있음 확인)를 더하지 않으므로 상대의 애플리케이션이 멈춘 것은 알아채지 못한다. 커널이 탐침에 답하면 산 것이다.
// 감독(supervisor/transport/server.ts)과 실행기(executor/socket.ts)가 이 한 자리의 값을 쓴다.

// 마지막 송수신 뒤 첫 탐침까지의 기다림. T1 실측 뒤 조정한다(server.md "반쯤 열린 연결").
// 런타임이 초 단위로 내림해 커널(TCP_KEEPIDLE)에 넘기므로 1,000의 배수로 둔다.
// 탐침 간격과 횟수는 이 API로 정하지 못한다. Bun 1.4.4는 소켓마다 TCP_KEEPINTVL 1초·TCP_KEEPCNT 10을 직접 넣어(노드 sysctl을 이긴다)
// 조용해진 뒤 약 40초에 끊는다. 그래서 30초 넘게 조용한 연결에서 망이 약 10초 넘게 끊기면 살아 있는 상대와의 연결도 끊긴다:
// 감독은 closed·withdrawn을 내고 연결 상실 박자가 없음을 세기 시작하며, 실행기는 다시 붙는다(server.md "반쯤 열린 연결").
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
