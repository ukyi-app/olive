// 감독·실행기 연결의 TCP keepalive. 상대가 FIN·RST 없이 사라진(반쯤 열린) 연결을 운영체제가 끊어 소켓의 close로 오게 한다.
// 계약 v1 메시지(살아 있음 확인)를 더하지 않으므로 상대의 애플리케이션이 멈춘 것은 알아채지 못한다. 커널이 탐침에 답하면 산 것이다.
// 감독(supervisor/transport/server.ts)과 실행기(executor/socket.ts)가 이 한 자리의 값과 차례를 쓴다(server.md "반쯤 열린 연결").
//
// 값은 모두 T1 실측 뒤 조정한다.
// 조용한 연결: 마지막 수신 뒤 첫 탐침 지연 + 간격 × 횟수 = 30초 + 10초 × 4 = 약 70초에 끊긴다.
// 약 40초는 첫 무응답 탐침(30초)부터 만료 검사(70초)까지이고, 견디는 망 단절의 고정 길이가 아니다. 견디는 길이는 단절이 탐침 시점과
// 어떻게 겹치는지와 그 사이 새 수신에 달렸다. 마지막 수신 0초, 다른 트래픽 없음이면 29.5~60.5초의 31초 단절은 탐침 넷(30·40·50·60초)을
// 모두 잃어 70초에 끊기고, 1~46초의 45초 단절은 50초 탐침에 답해 산다.
// TCP_USER_TIMEOUT은 보낸 바이트가 ACK를 못 받는 연결과 상대가 읽지 않아 창이 0인 연결도 그 시간 뒤 끊는다.
// 함정: TCP_USER_TIMEOUT이 0이 아니면 커널은 탐침 수 대신 "마지막 수신 뒤 경과 ≥ TCP_USER_TIMEOUT이고 답 없는 탐침 ≥ 1"로 끊는다.
// 첫 탐침 지연 + 간격 이하로 두면 첫 탐침 뒤 곧 끊겨 허용 끊김이 사라진다. 그래서 첫 탐침 지연 + 간격 × 횟수와 같게 둔다.
import { addressHex, libcSocketOptions, type SocketAddress, type SocketOptionName, type SocketOptionPort } from "./keepalive-ffi.ts";

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

// 양 끝 주소·포트는 런타임이 자기 핸들에서 읽은 값이다(_handle.fd와 따로 온다). fd가 이 연결의 것인지 대는 데 쓴다.
export interface KeepAliveSocket {
  readonly destroyed: boolean;
  readonly localAddress?: string | undefined;
  readonly localPort?: number | undefined;
  readonly remoteAddress?: string | undefined;
  readonly remotePort?: number | undefined;
  setKeepAlive(enable: boolean, initialDelay: number): unknown;
}

// false면 부르는 쪽은 그 연결을 쓰지 않고 닫는다: 끊김을 알 길이 없는 연결을 남기지 않는다.
// true는 다섯 값을 넣고 되읽어 맞았거나, 이미 끊긴 소켓이라 켤 것이 없다는 뜻이다. 끊긴 소켓은 부르는 쪽의 destroyed 확인이
// 기존 사유로 닫는다(런타임은 파기한 소켓의 _handle을 바로 비워 fd를 얻지 못하므로, 여기서 실패로 세면 사유가 바뀐다).
// 차례: setKeepAlive → fd → fd의 양 끝 주소 대조 → 런타임 값 되읽기 → 넣기 → 다섯 값 되읽기.
// 어느 단계든 던지거나 다르면 그 자리에서 false이고 뒤 단계는 없다. 대조가 맞지 않으면 다른 fd를 찾아 계속하지 않는다.
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
    if (!sameConnection(socket, fd, options)) return false;
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

// fd가 이 소켓의 연결인지 커널에 묻는다. 한 망 이름공간에서 맺어진 TCP 연결은 로컬·상대 주소·포트 넷으로 하나다(같은 연결의 반대쪽
// 소켓은 넷이 뒤집혀 다르다). 런타임 값 둘(SO_KEEPALIVE·TCP_KEEPIDLE)은 같은 옵션을 켠 다른 연결과 가르지 못해 이것이 먼저다.
// 런타임 주소 글이나 커널 주소를 꼴로 읽지 못하면(영역이 붙은 IPv6 등) 모호한 것으로 보고 false다.
function sameConnection(socket: KeepAliveSocket, fd: number, options: SocketOptionPort): boolean {
  const local = runtimeAddress(socket.localAddress, socket.localPort);
  const remote = runtimeAddress(socket.remoteAddress, socket.remotePort);
  if (local === null || remote === null) return false;
  return sameAddress(options.address(fd, "local"), local) && sameAddress(options.address(fd, "peer"), remote);
}

const sameAddress = (kernel: SocketAddress | null, runtime: SocketAddress): boolean =>
  typeof kernel === "object" && kernel !== null && kernel.address === runtime.address && kernel.port === runtime.port;

function runtimeAddress(text: unknown, port: unknown): SocketAddress | null {
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 0xffff || typeof text !== "string") return null;
  const v4 = ipv4(text);
  const bytes = v4 === null ? ipv6(text) : Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...v4);
  return bytes === null ? null : { address: addressHex(bytes), port: port as number };
}

function ipv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part))) return null;
  const bytes = parts.map(Number);
  return bytes.every((byte) => byte <= 255) ? bytes : null;
}

// "::" 줄임과 끝의 IPv4 점 표기(::ffff:127.0.0.1)를 읽는다. 영역(%)과 그 밖의 꼴은 null이다.
function ipv6(text: string): Uint8Array | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string, last: boolean): number[] | null => {
    if (part === "") return [];
    const pieces = part.split(":");
    const out: number[] = [];
    for (const [i, piece] of pieces.entries()) {
      if (last && i === pieces.length - 1 && piece.includes(".")) {
        const v4 = ipv4(piece);
        if (v4 === null) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(piece)) {
        out.push(Number.parseInt(piece, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const head = groups(halves[0]!, halves.length === 1);
  const tail = halves.length === 2 ? groups(halves[1]!, true) : [];
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const words = [...head, ...new Array<number>(missing).fill(0), ...tail];
  return Uint8Array.from(words.flatMap((word) => [word >> 8, word & 0xff]));
}
