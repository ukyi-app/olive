// 복원 2단계의 PeersPort(ledger/restore.ts). 현관·관측 중계의 행은 현관 포트에서, 실행기의 행은 연결 표에서 만든다. 설명 문서는 boot.md다.
//
// 실행기 행은 연결 표의 candidates(지금의 복원기)만 쓴다. 그 행은 TLS로 확인한 배포 신원에 등록된 키로 서명이 맞은 인사의 낸 쪽이고
// (connections.ts), 같은 복원기로 맞춘 뒤 받은 인사다. 그래서 "인증 연결의 신원과 검증한 인사의 낸 쪽을 맞춘 것만" 이웃으로 센다.
// 같은 실행기의 연결이 둘이면 행도 둘이다: 겹침은 복원기가 duplicatePeers로 닫는다(여기서 하나로 줄이지 않는다).
// 계약 판은 그 연결이 실제로 쓰는 v1이다. v2 대조를 통과했다는 것이 v2로 연결을 켜도 된다는 뜻은 아니다(현관 행은 현관 포트의 몫).
import { CONTRACT, executorName } from "../../contract/v1/index.ts";
import type { PeerContractAnswer, PeerPolicy, PeersPort } from "../../ledger/index.ts";
import type { Connections, StopGenerationSource } from "../transport/connections.ts";

// 현관이 아는 이웃(현관 자신, 관측 중계)의 행. 현관 조각(O08)이 만든다. 던지면 2단계가 모름으로 실패한다.
export interface FrontPeers {
  contracts(): Promise<PeerContractAnswer[]>;
}

export interface PeersSource {
  readonly front: FrontPeers;
  // 부르는 순간의 연결 표(연결 서버의 table).
  readonly table: () => Pick<Connections, "candidates">;
  // 연결 서버에 넘긴 그 복원기. 객체 동일성으로 이번 복원의 인사를 가른다.
  readonly restorer: StopGenerationSource;
  // 감독이 기대하는 정책 revision. null이면 모든 실행기 행의 정책이 unknown이다(맞다고 지어내지 않는다).
  readonly expectedPolicy: string | null;
}

export function createPeers(source: PeersSource): PeersPort {
  return {
    async contracts(): Promise<PeerContractAnswer[]> {
      const front = await source.front.contracts();
      if (!Array.isArray(front)) throw new TypeError("현관 이웃 행의 꼴이 틀렸다");
      // 연결 표는 현관의 답을 받은 뒤에 읽는다. 기다리는 동안 붙은 실행기도, 그동안 끊긴 실행기의 빠짐도 그 순간의 표로 센다.
      const rows: PeerContractAnswer[] = [];
      for (const candidate of source.table().candidates(source.restorer)) {
        const principal = candidate.principal;
        if (principal.kind !== "worker_executor") continue;
        const policy: PeerPolicy = source.expectedPolicy === null ? "unknown" : candidate.hello.policy_revision === source.expectedPolicy ? "match" : "mismatch";
        rows.push({ peer: executorName(principal.role, principal.instance, principal.storage), contract: CONTRACT, policy });
      }
      return [...front, ...rows];
    },
  };
}
