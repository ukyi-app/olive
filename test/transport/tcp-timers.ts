// 루프백 연결 한쪽의 커널 TCP 타이머를 /proc/net/tcp(·tcp6)에서 읽는다(Linux 전용).
// Bun·Node에는 소켓 옵션을 되읽는 API가 없어, keepalive가 실제로 켜졌는지는 커널이 그 소켓에 건 타이머로 본다:
// 보낼 것이 없는 ESTABLISHED 소켓에 SO_KEEPALIVE가 켜져 있으면 타이머 종류가 2(keepalive)이고 남은 시간이 TCP_KEEPIDLE 이하다.
// 꺼져 있으면 타이머가 없다(0).
import { readFileSync } from "node:fs";

export interface TcpTimer {
  // 0 없음, 1 재전송, 2 keepalive, 3 TIME_WAIT, 4 zero window probe.
  readonly kind: number;
  // 남은 시간(ms). 커널은 USER_HZ(100) 단위로 적는다.
  readonly remainingMs: number;
}

const ESTABLISHED = "01";
const USER_HZ = 100;

const portOf = (address: string) => Number.parseInt(address.split(":")[1]!, 16);

// ipv6.disable=1로 띄운 커널에는 /proc/net/tcp6가 없다. 시험의 루프백은 127.0.0.1이라 없는 파일은 빈 목록으로 본다.
function procLines(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").slice(1);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
}

// 로컬 포트와 상대 포트가 맞는 ESTABLISHED 줄 하나의 타이머. 없거나 둘 이상이면 던진다.
export function tcpTimer(localPort: number, remotePort: number): TcpTimer {
  const found: TcpTimer[] = [];
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of procLines(file)) {
      const cells = line.trim().split(/\s+/);
      if (cells.length < 6 || cells[3] !== ESTABLISHED) continue;
      if (portOf(cells[1]!) !== localPort || portOf(cells[2]!) !== remotePort) continue;
      const [kind, when] = cells[5]!.split(":");
      found.push({ kind: Number.parseInt(kind!, 16), remainingMs: (Number.parseInt(when!, 16) * 1000) / USER_HZ });
    }
  }
  if (found.length !== 1) throw new Error(`시험: ${localPort}→${remotePort} 연결이 ${found.length}개다`);
  return found[0]!;
}
