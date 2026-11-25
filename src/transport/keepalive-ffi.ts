// TCP 소켓 옵션을 libc의 setsockopt·getsockopt로 넣고 읽는다. Bun의 소켓 API는 keepalive 간격·횟수와 TCP_USER_TIMEOUT을
// 정하지 못해 keepalive.ts가 이 모듈로 넣고 되읽는다. 이미지의 기반(distroless, glibc)에 libc.so.6이 있어야 한다.
// 옵션 번호는 Linux의 값이다. 값은 int 하나(4바이트)만 다룬다.
// 실패(열기 실패, 음수 반환, 되읽은 길이가 4가 아님, int32 밖의 인자, 던짐)는 get이 null, set이 false로 돌려준다. 이 모듈은 던지지 않는다.
import { dlopen, FFIType, ptr } from "bun:ffi";

export type SocketOptionName = "SO_KEEPALIVE" | "TCP_KEEPIDLE" | "TCP_KEEPINTVL" | "TCP_KEEPCNT" | "TCP_USER_TIMEOUT";

export interface SocketOptionPort {
  get(fd: number, option: SocketOptionName): number | null;
  set(fd: number, option: SocketOptionName, value: number): boolean;
}

const SOL_SOCKET = 1;
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
});

function open() {
  return dlopen("libc.so.6", {
    getsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    setsockopt: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  });
}
