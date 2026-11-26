// TCP 소켓 옵션을 libc의 setsockopt·getsockopt로 넣고 읽고, getsockname·getpeername으로 fd의 양 끝 주소를 읽는다.
// Bun의 소켓 API는 keepalive 간격·횟수와 TCP_USER_TIMEOUT을 정하지 못해 keepalive.ts가 이 모듈로 넣고 되읽는다.
// 이미지의 기반(distroless, glibc)에 libc.so.6이 있어야 한다. 옵션 번호·주소 꼴은 Linux의 값이다. 옵션 값은 int 하나(4바이트)만 다룬다.
// 실패(열기 실패, 음수 반환, 되읽은 길이가 4가 아님, int32 밖의 인자, 던짐)는 get·address가 null, set이 false로 돌려준다.
// 이 모듈은 던지지 않는다.
import { dlopen, FFIType, ptr } from "bun:ffi";

export type SocketOptionName = "SO_KEEPALIVE" | "TCP_KEEPIDLE" | "TCP_KEEPINTVL" | "TCP_KEEPCNT" | "TCP_USER_TIMEOUT";

// address는 16바이트 IPv6 꼴(IPv4는 ::ffff: 매핑)을 32자리 소문자 16진수로 편 것이다. keepalive.ts가 런타임의 주소 글을 같은 꼴로 바꿔 댄다.
export interface SocketAddress {
  readonly address: string;
  readonly port: number;
}

export type SocketSide = "local" | "peer";

export interface SocketOptionPort {
  get(fd: number, option: SocketOptionName): number | null;
  set(fd: number, option: SocketOptionName, value: number): boolean;
  // fd의 로컬(getsockname)·상대(getpeername) 주소. IPv4·IPv6 밖의 꼴과 영역(scope id)이 붙은 IPv6은 null이다.
  address(fd: number, side: SocketSide): SocketAddress | null;
}

const SOL_SOCKET = 1;
const AF_INET = 2;
const AF_INET6 = 10;
// struct sockaddr_storage의 크기. 커널은 주소 길이를 이 안에서 돌려준다.
const SOCKADDR_STORAGE_BYTES = 128;
const IPPROTO_TCP = 6;
const OPTIONS: Readonly<Record<SocketOptionName, readonly [level: number, name: number]>> = {
  SO_KEEPALIVE: [SOL_SOCKET, 9],
  TCP_KEEPIDLE: [IPPROTO_TCP, 4],
  TCP_KEEPINTVL: [IPPROTO_TCP, 5],
  TCP_KEEPCNT: [IPPROTO_TCP, 6],
  TCP_USER_TIMEOUT: [IPPROTO_TCP, 18],
};

const isInt32 = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= -0x8000_0000 && (value as number) <= 0x7fff_ffff;

// 처음 쓸 때 한 번 열고 프로세스가 끝날 때까지 쥔다(연결마다 부른다). 열기가 던지면 쥐지 않고 다음 호출에서 다시 연다.
let libc: ReturnType<typeof open> | null = null;

export const libcSocketOptions: SocketOptionPort = Object.freeze({
  get(fd: number, option: SocketOptionName): number | null {
    try {
      const [level, name] = OPTIONS[option];
      if (!isInt32(fd)) return null;
      libc ??= open();
      // 두 버퍼는 호출이 끝날 때까지 이 지역 이름이 쥔다(ptr은 주소만 넘긴다).
      const value = new Int32Array(1);
      const length = new Uint32Array([4]);
      if (libc.symbols.getsockopt(fd, level, name, ptr(value), ptr(length)) !== 0 || length[0] !== 4) return null;
      return value[0]!;
    } catch {
      return null;
    }
  },
  set(fd: number, option: SocketOptionName, value: number): boolean {
    try {
      const [level, name] = OPTIONS[option];
      if (!isInt32(fd) || !isInt32(value)) return false;
      libc ??= open();
      const buffer = new Int32Array([value]);
      return libc.symbols.setsockopt(fd, level, name, ptr(buffer), 4) === 0;
    } catch {
      return false;
    }
  },
  address(fd: number, side: SocketSide): SocketAddress | null {
    try {
      if (!isInt32(fd) || (side !== "local" && side !== "peer")) return null;
      libc ??= open();
      const storage = new Uint8Array(SOCKADDR_STORAGE_BYTES);
      const length = new Uint32Array([SOCKADDR_STORAGE_BYTES]);
      const read = side === "local" ? libc.symbols.getsockname : libc.symbols.getpeername;
      if (read(fd, ptr(storage), ptr(length)) !== 0) return null;
      return decodeSockaddr(storage, length[0]!);
    } catch {
      return null;
    }
  },
});

// sa_family는 호스트 바이트 순서(u16), 포트는 망 바이트 순서다. IPv6의 scope id가 0이 아니면(링크 로컬 영역) 주소와 포트만으로
// 연결을 가르지 못하므로 null이다.
function decodeSockaddr(storage: Uint8Array, length: number): SocketAddress | null {
  const view = new DataView(storage.buffer, storage.byteOffset, storage.byteLength);
  const family = new Uint16Array(storage.buffer, storage.byteOffset, 1)[0];
  let bytes: Uint8Array;
  if (family === AF_INET && length >= 16 && length <= SOCKADDR_STORAGE_BYTES) {
    bytes = Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...storage.subarray(4, 8));
  } else if (family === AF_INET6 && length >= 28 && length <= SOCKADDR_STORAGE_BYTES) {
    if (view.getUint32(24, true) !== 0) return null;
    bytes = storage.slice(8, 24);
  } else {
    return null;
  }
  return { address: addressHex(bytes), port: view.getUint16(2, false) };
}

export const addressHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

function open() {
  return dlopen("libc.so.6", {
    getpeername: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    getsockname: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    setsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  });
}
