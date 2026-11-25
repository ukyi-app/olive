// 감독·실행기 연결의 TCP keepalive. 상대가 FIN·RST 없이 사라진(반쯤 열린) 연결을 운영체제가 끊어 소켓의 close로 오게 한다.
// 계약 v1 메시지(살아 있음 확인)를 더하지 않으므로 상대의 애플리케이션이 멈춘 것은 알아채지 못한다. 커널이 탐침에 답하면 산 것이다.
// 감독(supervisor/transport/server.ts)과 실행기(executor/socket.ts)가 이 한 자리의 값과 차례를 쓴다(server.md "반쯤 열린 연결").
//
// 값은 모두 T1 실측 뒤 조정한다.
// 조용한 연결: 마지막 수신 뒤 첫 탐침 지연 + 간격 × 횟수 = 30초 + 10초 × 4 = 약 70초에 끊긴다. 허용 끊김은 약 40초다
// (30초 넘게 조용한 연결에서 망이 그보다 오래 끊기면 살아 있는 상대와의 연결도 끊긴다).
// TCP_USER_TIMEOUT은 보낸 바이트가 ACK를 못 받는 연결과 상대가 읽지 않아 창이 0인 연결도 그 시간 뒤 끊는다.
// 함정: TCP_USER_TIMEOUT이 0이 아니면 커널은 탐침 수 대신 "마지막 수신 뒤 경과 ≥ TCP_USER_TIMEOUT이고 답 없는 탐침 ≥ 1"로 끊는다.
// 첫 탐침 지연 + 간격 이하로 두면 첫 탐침 뒤 곧 끊겨 허용 끊김이 사라진다. 그래서 첫 탐침 지연 + 간격 × 횟수와 같게 둔다.
import { libcSocketOptions, type SocketOptionName, type SocketOptionPort } from "./keepalive-ffi.ts";

// 마지막 송수신 뒤 첫 탐침까지. 런타임이 초 단위로 내림해 TCP_KEEPIDLE로 넘기므로 1,000의 배수로 둔다.
export const KEEPALIVE_INITIAL_DELAY_MS = 30_000;
// 탐침 간격(TCP_KEEPINTVL, 초로 넣는다)과 답 없는 탐침의 수(TCP_KEEPCNT).
export const KEEPALIVE_INTERVAL_MS = 10_000;
export const KEEPALIVE_PROBES = 4;
// TCP_USER_TIMEOUT(ms).
export const KEEPALIVE_USER_TIMEOUT_MS = KEEPALIVE_INITIAL_DELAY_MS + KEEPALIVE_INTERVAL_MS * KEEPALIVE_PROBES;

// setKeepAlive가 넣는 값. 넣기 전에 되읽어, fd가 방금 런타임이 켠 그 소켓인지 본다.
const RUNTIME_SET: readonly (readonly [SocketOptionName, number])[] = [
  ["SO_KEEPALIVE", 1],
  ["TCP_KEEPIDLE", KEEPALIVE_INITIAL_DELAY_MS / 1_000],
];
// 이 모듈이 넣는 값. Bun 1.4.4의 setKeepAlive는 TCP_KEEPINTVL 1초·TCP_KEEPCNT 10을 넣고 TCP_USER_TIMEOUT은 넣지 않는다.
const TUNED: readonly (readonly [SocketOptionName, number])[] = [
  ["TCP_KEEPINTVL", KEEPALIVE_INTERVAL_MS / 1_000],
  ["TCP_KEEPCNT", KEEPALIVE_PROBES],
  ["TCP_USER_TIMEOUT", KEEPALIVE_USER_TIMEOUT_MS],
];
// 다 넣은 뒤 되읽어 맞아야 하는 값(시험도 이 표로 본다).
export const KEEPALIVE_OPTIONS: Readonly<Record<SocketOptionName, number>> = Object.freeze(Object.fromEntries([...RUNTIME_SET, ...TUNED]) as Record<SocketOptionName, number>);

export interface KeepAliveSocket {
  readonly destroyed: boolean;
  setKeepAlive(enable: boolean, initialDelay: number): unknown;
}

// false면 부르는 쪽은 그 연결을 쓰지 않고 닫는다: 끊김을 알 길이 없는 연결을 남기지 않는다.
// true는 다섯 값을 넣고 되읽어 맞았거나, 이미 끊긴 소켓이라 켤 것이 없다는 뜻이다. 끊긴 소켓은 부르는 쪽의 destroyed 확인이
// 기존 사유로 닫는다(런타임은 파기한 소켓의 _handle을 바로 비워 fd를 얻지 못하므로, 여기서 실패로 세면 사유가 바뀐다).
// 차례: setKeepAlive → fd → 런타임 값 되읽기 → 넣기 → 다섯 값 되읽기. 어느 단계든 던지거나 다르면 그 자리에서 false이고 뒤 단계는 없다.
// 함정: 이 뒤 같은 소켓에 setKeepAlive를 다른 지연으로 다시 부르면 런타임이 간격 1초·10회를 다시 넣는다. 다시 부르는 곳을 두지 않는다
// (test/transport/keepalive.test.ts의 정적 확인). options는 시험만 바꾼다.
export function enableKeepAlive(socket: KeepAliveSocket, options: SocketOptionPort = libcSocketOptions): boolean {
  try {
    const destroyed = socket.destroyed;
    if (destroyed === true) return true;
    if (destroyed !== false) return false;
    socket.setKeepAlive(true, KEEPALIVE_INITIAL_DELAY_MS);
    const fd = handleFd(socket);
    if (fd === null) return false;
    for (const [name, value] of RUNTIME_SET) if (options.get(fd, name) !== value) return false;
    for (const [name, value] of TUNED) if (options.set(fd, name, value) !== true) return false;
    for (const [name, value] of [...RUNTIME_SET, ...TUNED]) if (options.get(fd, name) !== value) return false;
    return true;
  } catch {
    return false;
  }
}

// node:net·node:tls 소켓의 _handle.fd. 문서와 bun-types에 없는 런타임 내부 값이라 판이 바뀌면 사라질 수 있다:
// 그때는 null이고 연결은 keepalive_failed로 닫힌다(런타임 판 올림 때 시험이 잡는다). 한 번만 읽는다.
function handleFd(socket: KeepAliveSocket): number | null {
  const handle = (socket as { readonly _handle?: unknown })._handle;
  if (typeof handle !== "object" || handle === null) return null;
  const fd = (handle as { readonly fd?: unknown }).fd;
  return Number.isSafeInteger(fd) && (fd as number) >= 0 ? (fd as number) : null;
}
