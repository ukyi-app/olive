// 시험 현관 대역(D-109). 현관(O08)이 없는 시험 클러스터에서 감독이 복원 5단계를 마치고 접수를 열게 하는 현관 포트다.
// 진입점(src/main/supervisor.ts)이 시험 값(OLIVE_TEST_FRONTDOOR=on, 그리고 OLIVE_TEST_JOBS=on)에서만 고르고, 운영 값에서는 만들지 않는다.
//
// 대역이 스스로 만드는 것(D-76 "기록 없음을 지어내지 않는다"의 시험 값 한정 예외):
// - 권위 정지 기록: 정지 아님, 세대 0. 장부에 같은 세대의 정지나 더 높은 세대가 있으면 장부가 이긴다(Ledger.mergeStop). 그래서 대역은
//   정지를 풀거나 세대를 올리지 못한다. 대역이 정지를 내는 길은 없다: 시험 클러스터의 정지는 CLI의 자물쇠·replicas 0과 장부 정지 기록이 건다.
// - 이웃 행: 현관(계약 v2)·관측 중계(계약 v1), 정책은 맞음. 계약 판은 복원기가 이웃 이름으로 기대하는 판(ledger/restore.ts의 isFrontDoor)과
//   같은 상수를 쓴다. 이름은 진입점의 필수 이웃(OTHER_PEERS)과 같아야 한다(test/supervisor/frontdoor/test-double.test.ts가 대조한다).
// - 시험 소유자 입력 하나: 고정 요청 ID·고정 출처. 같은 요청 ID라 감독이 다시 떠도 장부의 줄은 하나다(Ledger.enqueueInput). 배정은 이
//   출처만 admin으로 본다(testOriginOf). 장부에 넣는 일은 조립(runtime/boot.ts)이 접수 허가를 받아들인 뒤 접수 문을 지나 한다.
// 만들지 않는 것: 게시 결과. 대역은 게시를 받지 않으므로 늘 모름(던짐)이다(복원 4단계는 그 게시를 unknown으로 남긴다).
//
// 함정: 대역이 만든 정지 아님 기록과 입력은 그 장부에 남는다. 같은 장부를 나중에 실제 현관과 쓰지 않는다(README "시험 현관 대역").
// 함정: 소유자 입력의 원문 만료는 처음 넣은 시각 + 168시간이다. 지나면 시험 작업 넣기가 owner_inactive로 거절하고, 같은 요청 ID라 다시
// 넣어도 만료가 바뀌지 않는다. 새 장부(장부 초기화)로 다시 시작한다.
import { CONTRACT as CONTRACT_V1 } from "../../contract/v1/index.ts";
import { CONTRACT as CONTRACT_V2 } from "../../contract/v2/index.ts";
import type { InputRecord, PeerContractAnswer } from "../../ledger/index.ts";
import type { FrontDoorPorts } from "../runtime/boot.ts";
import type { Origin } from "../scheduler/queue.ts";

// 시험 소유자 입력의 출처 이름. 실제 현관이 쓰는 출처 이름과 겹치지 않는 값이라 장부에서 대역의 입력을 가를 수 있다.
export const TEST_FRONT_DOOR_SOURCE = "test-front-door";
// 시험 소유자 입력의 요청 ID. 시험 작업 넣기(test-job)의 owner 칸에 이 값을 넣는다(README "시험 현관 대역").
export const TEST_FRONT_DOOR_OWNER = "00000000-0000-4000-8000-000000000109";
// 대역이 내는 권위 정지 기록의 세대. 가장 낮은 세대라 장부의 어떤 정지 기록도 덮지 않는다.
export const TEST_FRONT_DOOR_STOP_GENERATION = 0;
// 원문 만료까지의 시간. 실제 원문의 보관 상한(D-22, 168시간)과 같게 둔다.
export const TEST_FRONT_DOOR_SOURCE_TTL_MS = 168 * 3_600_000;
// 대역이 답하는 이웃 행. 진입점의 필수 이웃과 같은 이름·차례다.
export const TEST_FRONT_DOOR_PEERS = ["front-door", "observation-relay"] as const;

// 배정이 보는 접수 출처. 대역의 출처만 관리자 요청이고 그 밖은 모름(그 입력의 일은 배정이 보류한다)이다.
export function testOriginOf(source: string): Origin | undefined {
  return source === TEST_FRONT_DOOR_SOURCE ? "admin" : undefined;
}

// 시험 소유자 입력. receivedAt은 조립이 장부 시계로 넘긴다(이 파일은 시계를 읽지 않는다).
function testInput(receivedAt: number): InputRecord {
  return {
    requestId: TEST_FRONT_DOOR_OWNER,
    source: TEST_FRONT_DOOR_SOURCE,
    sourceRef: { ref: `${TEST_FRONT_DOOR_SOURCE}/${TEST_FRONT_DOOR_OWNER}`, expiresAt: receivedAt + TEST_FRONT_DOOR_SOURCE_TTL_MS },
    receivedAt,
  };
}

// 부를 때마다 새 객체를 낸다: 복원기·조립이 받은 값을 바꿔도 다음 답에 번지지 않는다.
export function testFrontDoorPorts(): FrontDoorPorts {
  return {
    stopAuthority: { latestStop: async () => ({ generation: TEST_FRONT_DOOR_STOP_GENERATION, stopped: false }) },
    publications: { lookup: () => Promise.reject(new Error("front_door_test_double")) },
    peers: {
      contracts: async (): Promise<PeerContractAnswer[]> => [
        { peer: TEST_FRONT_DOOR_PEERS[0], contract: CONTRACT_V2, policy: "match" },
        { peer: TEST_FRONT_DOOR_PEERS[1], contract: CONTRACT_V1, policy: "match" },
      ],
    },
    testInput,
  };
}
