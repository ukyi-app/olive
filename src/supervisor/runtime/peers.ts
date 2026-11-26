// 복원 2단계의 PeersPort(ledger/restore.ts). 현관·관측 중계의 행은 현관 포트에서, 실행기의 행은 연결 표에서 만든다. 설명 문서는 boot.md다.
//
// 실행기 행은 연결 표의 candidates(지금의 복원기)만 쓴다. 그 행은 TLS로 확인한 배포 신원에 등록된 키로 서명이 맞은 인사의 낸 쪽이고
// (connections.ts), 같은 복원기로 맞춘 뒤 받은 인사다. 그래서 "인증 연결의 신원과 검증한 인사의 낸 쪽을 맞춘 것만" 이웃으로 센다.
// 같은 실행기의 연결이 둘이면 행도 둘이다: 겹침은 복원기가 duplicatePeers로 닫는다(여기서 하나로 줄이지 않는다).
// 계약 판은 그 연결이 실제로 쓰는 v1이다. v2 대조를 통과했다는 것이 v2로 연결을 켜도 된다는 뜻은 아니다(현관 행은 현관 포트의 몫).
//
// 필수 이웃 기다림(D-141): 감독이 다시 뜨면 실행기는 끊겼다가 재접속 간격(1초부터 두 배씩)에 맞춰 다시 붙으므로, 2단계를 부른 순간의
// 표만 세면 곧 붙을 실행기를 빠진 이웃으로 닫고 그 프로세스 동안 접수가 닫힌 채 남는다. 그래서 이 포트가 필수 이웃이 모두 모일 때까지
// 다시 읽고, 모였거나 기다림의 끝에 이르면 마지막 읽기를 낸다. 복원기는 이 포트와 점유 포트를 한 번씩 읽어 한 번 판정한다: 기다리는 동안
// 읽은 행은 모였는지 보는 데만 쓰고 복원기에 넘기지 않는다(그동안 받은 인사의 관측은 답 줄이 2단계 뒤에 반영한다, boot.md 정한 것 4).
import { CONTRACT, executorName, parsePrincipal } from "../../contract/v1/index.ts";
import type { OccupancyAnswer, PeerContractAnswer, PeerPolicy, PeersPort } from "../../ledger/index.ts";
import type { Connections, StopGenerationSource } from "../transport/connections.ts";

// 단계 기한보다 이만큼 앞에서 기다림을 끝낸다. 기다림 뒤에도 마지막 읽기(현관 답 하나), 복원기의 판정과 장부 쓰기(점유 차단·양성 관측),
// 늦게 깨는 타이머가 남는다. 이것들이 단계 기한을 넘기면 감독이 restore_lapsed(96)로 끝난다.
export const PEER_WAIT_MARGIN_MS = 5_000;
// 단계 기한을 늘려도 이보다 오래 기다리지 않는다. 기다리는 동안은 5단계 전이라 박자가 돌지 않아 기존 실행의 정지·상태 조회도 그만큼 늦다.
// 지금의 단계 기한(30초)에서 여유를 뺀 값과 같다.
export const PEER_WAIT_MAX_MS = 25_000;
// 다시 읽는 간격. 필수 이웃이 붙은 뒤 판정까지 더 걸리는 시간과 멈춤을 알아채는 데 걸리는 시간의 상한이다.
// 한 번 읽기는 현관 포트 한 번과 메모리의 연결 표라 이 간격으로 되풀이해도 무겁지 않다.
export const PEER_POLL_MS = 250;

// 현관이 아는 이웃(현관 자신, 관측 중계)의 행. 현관 조각(O08)이 만든다. 던지면 2단계가 모름으로 실패한다.
// 함정: 기다리는 동안 PEER_POLL_MS마다 다시 불린다.
export interface FrontPeers {
  contracts(): Promise<PeerContractAnswer[]>;
}

// 기다림에 쓰는 것. 시각은 모두 단조 ms다.
export interface PeerWait {
  // 복원기의 requiredPeers와 같은 목록.
  readonly required: readonly string[];
  // 기다림을 끝낼 시각. 포트를 부를 때 한 번 읽는다. null이면 기다리지 않는다.
  readonly until: () => number | null;
  readonly now: () => number;
  // ms 뒤에 이행한다. 타이머를 걸지 못하면 거부한다.
  readonly sleep: (ms: number) => Promise<void>;
  // 끝 차례가 시작됐는가.
  readonly stopping: () => boolean;
}

export interface PeersSource {
  readonly front: FrontPeers;
  // 부르는 순간의 연결 표(연결 서버의 table).
  readonly table: () => Pick<Connections, "candidates" | "occupancy">;
  // 연결 서버에 넘긴 그 복원기. 객체 동일성으로 이번 복원의 인사를 가른다.
  readonly restorer: StopGenerationSource;
  // 감독이 기대하는 정책 revision. null이면 모든 실행기 행의 정책이 unknown이다(맞다고 지어내지 않는다).
  readonly expectedPolicy: string | null;
  // 없으면 기다리지 않고 그 순간의 행을 낸다.
  readonly wait?: PeerWait;
}

// 단계 기한(limit)과 그 단계의 기한 길이(stepWaitMs)로 기다림을 끝낼 시각을 정한다. 기한이 여유보다 짧으면 단계를 시작한 때보다 앞이라
// 기다리지 않는다.
export function peerWaitUntil(limit: number, stepWaitMs: number): number {
  return Math.min(limit - stepWaitMs + PEER_WAIT_MAX_MS, limit - PEER_WAIT_MARGIN_MS);
}

function isExecutor(peer: string): boolean {
  const kind = parsePrincipal(peer)?.kind;
  return kind === "worker_executor" || kind === "session_executor";
}

// 2단계가 이웃 때문에 닫지 않을 만큼 모였는가: 필수 이웃마다 판 행이 정확히 하나, 필수 실행기마다 full 점유가 정확히 하나.
// 복원기 2단계의 missingPeers·duplicatePeers·occupancyUnconfirmed와 같은 셈이다(겹침도 기다린다: 밀려난 연결이 곧 빠질 수 있다).
// 판·정책 불일치는 기다려도 그 연결이 바뀌지 않아 보지 않는다. 판정은 복원기가 한다.
export function peersGathered(required: readonly string[], rows: readonly PeerContractAnswer[], occupancy: readonly OccupancyAnswer[]): boolean {
  for (const peer of required) {
    if (rows.filter((row) => row.peer === peer).length !== 1) return false;
    if (isExecutor(peer) && occupancy.filter((answer) => answer.coverage === "full" && answer.executorId === peer).length !== 1) return false;
  }
  return true;
}

export function createPeers(source: PeersSource): PeersPort {
  const read = async () => {
    const front = await source.front.contracts();
    if (!Array.isArray(front)) throw new TypeError("현관 이웃 행의 꼴이 틀렸다");
    // 연결 표는 현관의 답을 받은 뒤에 읽는다. 기다리는 동안 붙은 실행기도, 그동안 끊긴 실행기의 빠짐도 그 순간의 표로 센다.
    // 행과 점유를 같은 표 값 하나에서 읽는다(표는 불변 값이다).
    const table = source.table();
    const rows: PeerContractAnswer[] = [];
    for (const candidate of table.candidates(source.restorer)) {
      const principal = candidate.principal;
      if (principal.kind !== "worker_executor") continue;
      const policy: PeerPolicy = source.expectedPolicy === null ? "unknown" : candidate.hello.policy_revision === source.expectedPolicy ? "match" : "mismatch";
      rows.push({ peer: executorName(principal.role, principal.instance, principal.storage), contract: CONTRACT, policy });
    }
    return { rows: [...front, ...rows], table };
  };
  return {
    async contracts(): Promise<PeerContractAnswer[]> {
      const wait = source.wait;
      const until = wait === undefined ? null : wait.until();
      for (;;) {
        const { rows, table } = await read();
        if (wait === undefined || until === null || peersGathered(wait.required, rows, table.occupancy(source.restorer))) return rows;
        // 시각을 읽지 못하거나 타이머를 걸지 못하면 더 기다리지 않고 지금 읽은 행으로 판정하게 한다.
        let left: number;
        try {
          left = until - wait.now();
        } catch {
          left = Number.NaN;
        }
        if (!(left > 0)) return rows;
        try {
          await wait.sleep(Math.min(PEER_POLL_MS, left));
        } catch {
          return rows;
        }
        // 멈춤이면 판정하지 않는다: 던지면 복원기는 모름으로 실패하고(장부를 건드리기 전), 조립은 멈춤 중이라 그 단계를 다시 부르지 않는다.
        if (wait.stopping()) throw new Error("peer_wait_stopped");
      }
    },
  };
}
