// 대리 자신을 non-dumpable로 만든다(prctl(PR_SET_DUMPABLE, 0)). 같은 uid의 자식도 /proc/1/environ·root·mem을 읽지 못하게 된다.
// 이 속성은 exec마다 dumpable로 돌아가므로 대리가 뜬 뒤 무엇보다 먼저 스스로 부른다. capability는 필요 없다.
// Bun에는 prctl이 없어 bun:ffi로 libc를 연다. 이미지의 기반(distroless, glibc)에 libc.so.6이 있어야 한다.
// 설정한 뒤 PR_GET_DUMPABLE로 다시 읽어 0일 때만 true다. 어느 단계든 실패하면 false이고 대리는 뜨지 않는다.
import { dlopen, FFIType } from "bun:ffi";

const PR_GET_DUMPABLE = 3;
const PR_SET_DUMPABLE = 4;

export function makeNonDumpable(): boolean {
  let libc: ReturnType<typeof open>;
  try {
    libc = open();
  } catch {
    return false;
  }
  try {
    if (libc.symbols.prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n) !== 0) return false;
    return libc.symbols.prctl(PR_GET_DUMPABLE, 0n, 0n, 0n, 0n) === 0;
  } catch {
    return false;
  } finally {
    libc.close();
  }
}

function open() {
  return dlopen("libc.so.6", {
    prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  });
}
