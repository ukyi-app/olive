// 복원 2단계의 PeersPort·OccupancyPort(ledger/restore.ts). 현관·관측 중계의 행은 현관 포트에서, 실행기의 행과 점유는 연결 표에서 만든다. 설명 문서는 boot.md다.
//
// 실행기 행은 연결 표의 candidates(지금의 복원기)만 쓴다. 그 행은 TLS로 확인한 배포 신원에 등록된 키로 서명이 맞은 인사의 낸 쪽이고
// (connections.ts), 같은 복원기로 맞춘 뒤 받은 인사다. 그래서 "인증 연결의 신원과 검증한 인사의 낸 쪽을 맞춘 것만" 이웃으로 센다.
// 같은 실행기의 연결이 둘이면 행도 둘이다: 겹침은 복원기가 duplicatePeers로 닫는다(여기서 하나로 줄이지 않는다).
// 계약 판은 그 연결이 실제로 쓰는 v1이다. v2 대조를 통과했다는 것이 v2로 연결을 켜도 된다는 뜻은 아니다(현관 행은 현관 포트의 몫).
//
// 필수 이웃 기다림(D-141): 감독이 다시 뜨면 실행기는 끊겼다가 재접속 간격(1초부터 두 배씩)에 맞춰 다시 붙으므로, 2단계를 부른 순간의
// 표만 세면 곧 붙을 실행기를 빠진 이웃으로 닫고 그 프로세스 동안 접수가 닫힌 채 남는다. 그래서 이 포트가 필수 이웃이 모두 모일 때까지
// 다시 읽는다. 복원기는 이 포트의 두 읽기(contracts, occupancy)를 한 번씩 불러 한 번 판정한다.
// - 끝 시각은 기다림 전체에 하나다: 끝 시각에 진행 중인 현관 답이나 다시 읽기 타이머를 기다리지 않고, 마지막으로 끝난 현관 답과 그때의
//   연결 표로 판정에 넘긴다. 끝 시각 뒤에 온 현관 답은 버린다. 첫 현관 답만은 끝 시각에도 기다린다(넘길 앞선 답이 없다).
// - 모였는지는 그때의 연결 표로 센다. 다만 이 복원기의 2단계에서 표로 본 실행은 연결이 끊기거나 빈 full로 다시 붙어도 기억했다가 점유
//   읽기에 partial 행으로 더한다: 답 줄은 끊긴 연결의 인사로 장부 밖 실행·점유 차단을 적지 않는다(recordAnswerSightings).
// - 끝 차례가 시작되면 진행 중인 현관 답·잠을 깨워, 판정에 넘기지 않고 던진다(복원기는 장부를 건드리기 전에 모름으로 실패한다).
import { CONTRACT, executorName, parsePrincipal, type RunStatus } from "../../contract/v1/index.ts";
import type { OccupancyAnswer, OccupancyPort, PeerContractAnswer, PeerPolicy, PeersPort } from "../../ledger/index.ts";
import type { Connections, StopGenerationSource } from "../transport/connections.ts";

// 단계 기한보다 이만큼 앞이 기다림의 끝 시각이다. 끝 시각 뒤에 남는 일은 끝 타이머가 늦게 깬 만큼, 연결 표 읽기, 복원기의 판정과 장부
// 쓰기(점유 차단·양성 관측)뿐이고, 이것들이 합쳐 이 값 미만이어야 단계 기한 안이다. 이벤트 루프가 이만큼 멈추거나 장부 쓰기가 이만큼
// 걸리면 지금처럼 restore_lapsed(96)다. 첫 현관 답이 끝 시각 뒤에 오면 남는 시간은 이보다 짧다.
export const PEER_WAIT_MARGIN_MS = 5_000;
// 단계 기한을 늘려도 이보다 오래 기다리지 않는다. 기다리는 동안은 5단계 전이라 박자가 돌지 않아 기존 실행의 정지·상태 조회도 그만큼 늦다.
// 지금의 단계 기한(30초)에서 여유를 뺀 값과 같다.
export const PEER_WAIT_MAX_MS = 25_000;
// 현관 답을 받은 뒤 다시 묻기까지의 간격. 필수 이웃이 붙은 뒤 판정까지 더 걸리는 시간은 이 값과 현관 답 하나의 시간이다.
// 한 번 읽기는 현관 포트 한 번과 메모리의 연결 표라 이 간격으로 되풀이해도 무겁지 않다.
export const PEER_POLL_MS = 250;

const STOPPED = "peer_wait_stopped";

// 현관이 아는 이웃(현관 자신, 관측 중계)의 행. 현관 조각(O08)이 만든다. 던지면 2단계가 모름으로 실패한다.
// 함정: 기다리는 동안 답을 받을 때마다 PEER_POLL_MS 뒤에 다시 불린다. 끝 시각에 진행 중인 답은 버려진다(취소하지 않는다).
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
  // ms 뒤에 fire를 한 번 부른다. 돌려준 함수는 취소다. 걸지 못하면 던진다.
  readonly setTimer: (ms: number, fire: () => void) => () => void;
  // 끝 차례가 시작됐는가.
  readonly stopping: () => boolean;
  // 끝 차례가 시작되면 wake를 부르게 건다. 돌려준 함수는 떼기다.
  readonly onStop: (wake: () => void) => () => void;
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

// 실행기·실행 ID·세대. 장부의 점유 차단·양성 관측이 한 실행을 가르는 열쇠와 같다.
const runKey = (executorId: string, status: RunStatus): string => JSON.stringify([executorId, status.run_id, status.run_generation]);

const quietly = (fn: () => void): void => {
  try {
    fn();
  } catch {
    // 떼기·취소가 던져도 판정은 바뀌지 않는다(늦게 깬 콜백은 이미 끝난 기다림을 바꾸지 못한다).
  }
};

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown } | null;

export function createPeers(source: PeersSource): PeersPort & OccupancyPort {
  // 이 복원기의 2단계에서 연결 표로 본 실행. 열쇠마다 마지막으로 본 상태다. 끊김·빈 full로 지우지 않는다: 그래야 그사이 끝난 연결이
  // 답한 장부 밖 실행·정리 중 실행의 차단이 판정에 남는다. 2단계를 다시 불러도(모름 뒤) 같은 기억을 쓴다.
  const seen = new Map<string, { readonly executorId: string; readonly status: RunStatus }>();
  const remember = (answers: readonly OccupancyAnswer[]) => {
    for (const answer of answers) for (const status of answer.runs) seen.set(runKey(answer.executorId, status), { executorId: answer.executorId, status: { ...status } });
  };
  const askFront = async (): Promise<PeerContractAnswer[]> => {
    const front = await source.front.contracts();
    if (!Array.isArray(front)) throw new TypeError("현관 이웃 행의 꼴이 틀렸다");
    return front;
  };
  // 현관 행에 그 순간의 연결 표로 실행기 행을 더한다. 행과 점유를 같은 표 값 하나에서 읽는다(표는 불변 값이다). 본 점유는 기억한다.
  const look = (front: readonly PeerContractAnswer[]) => {
    const table = source.table();
    const occupancy = table.occupancy(source.restorer);
    remember(occupancy);
    const rows: PeerContractAnswer[] = [...front];
    for (const candidate of table.candidates(source.restorer)) {
      const principal = candidate.principal;
      if (principal.kind !== "worker_executor") continue;
      const policy: PeerPolicy = source.expectedPolicy === null ? "unknown" : candidate.hello.policy_revision === source.expectedPolicy ? "match" : "mismatch";
      rows.push({ peer: executorName(principal.role, principal.instance, principal.storage), contract: CONTRACT, policy });
    }
    return { rows, occupancy };
  };

  const contracts = async (): Promise<PeerContractAnswer[]> => {
    const wait = source.wait;
    if (wait === undefined) return look(await askFront()).rows;
    if (wait.stopping()) throw new Error(STOPPED);
    const until = wait.until();
    let halted = false;
    let ended = false;
    let wake: () => void = () => {};
    let off: () => void = () => {};
    let cancelEnd: () => void = () => {};
    try {
      off = wait.onStop(() => {
        halted = true;
        wake();
      });
    } catch {
      // 걸지 못하면 깨우지 못할 뿐이다: 답·잠 뒤마다 stopping()을 다시 본다.
    }
    const stopped = () => halted || wait.stopping();
    // work가 끝나거나 멈춤·끝 시각이 깨우면 이행한다(깨우면 null). 깨운 뒤에 끝난 work의 결과는 버린다.
    const settle = <T>(work: Promise<T>) =>
      new Promise<Settled<T>>((resolve) => {
        wake = () => resolve(null);
        if (halted || ended) resolve(null);
        work.then(
          (value) => resolve({ ok: true, value }),
          (error: unknown) => resolve({ ok: false, error }),
        );
      });
    // 끝 시각이 지났는가. 시각을 읽지 못하면 지난 것으로 본다(모름을 시간이 남은 것으로 읽지 않는다).
    const past = (end: number): boolean => {
      try {
        const at = wait.now();
        return !(Number.isFinite(at) && at < end);
      } catch {
        return true;
      }
    };
    try {
      const first = await settle(askFront());
      if (first === null || stopped()) throw new Error(STOPPED);
      if (!first.ok) throw first.error;
      let last = first.value;
      let read = look(last);
      if (until === null || peersGathered(wait.required, read.rows, read.occupancy)) return read.rows;
      // 시각을 읽지 못하거나 끝 타이머를 걸지 못하면 더 기다리지 않고 이 읽기로 판정하게 한다.
      let left: number;
      try {
        left = until - wait.now();
      } catch {
        left = Number.NaN;
      }
      if (!(left > 0)) return read.rows;
      try {
        cancelEnd = wait.setTimer(Math.ceil(left), () => {
          ended = true;
          wake();
        });
      } catch {
        return read.rows;
      }
      for (;;) {
        let cancelPoll: () => void = () => {};
        const slept = await settle(
          new Promise<void>((resolve, reject) => {
            try {
              cancelPoll = wait.setTimer(PEER_POLL_MS, () => resolve());
            } catch (error) {
              reject(error);
            }
          }),
        );
        quietly(cancelPoll);
        if (stopped()) throw new Error(STOPPED);
        // 끝 시각이 깨웠거나, 다시 읽기 타이머를 걸지 못했거나, 끝 시각이 지났으면 새로 묻지 않는다.
        if (slept === null || !slept.ok || past(until)) return look(last).rows;
        const next = await settle(askFront());
        if (stopped()) throw new Error(STOPPED);
        // 끝 시각에 진행 중이던 답과 끝 시각 뒤에 온 답은 판정에 넘기지 않는다.
        if (next === null || past(until)) return look(last).rows;
        if (!next.ok) throw next.error;
        last = next.value;
        read = look(last);
        if (peersGathered(wait.required, read.rows, read.occupancy)) return read.rows;
      }
    } finally {
      quietly(off);
      quietly(cancelEnd);
    }
  };

  return {
    contracts,
    // 그때의 연결 표의 full 행에, 이번 2단계에서 본 실행 가운데 그 표에 같은 열쇠가 없는 것을 실행기마다 partial 행 하나로 더한다.
    // partial이라 필수 실행기의 전체 점유로 세지 않는다(옛 full을 지금 연결 수에 더하지 않는다). 복원기는 이 행도 같은 규칙으로 대조해
    // 장부 밖·불일치 실행을 막고, 지정 실행기·같은 세대의 항목은 양성 관측으로 적는다.
    async occupancy(): Promise<OccupancyAnswer[]> {
      // 판정에 넘기기 전 마지막 확인. 이 뒤의 판정과 장부 쓰기는 복원기의 동기 구간이다.
      if (source.wait?.stopping() === true) throw new Error(STOPPED);
      const current = source.table().occupancy(source.restorer);
      remember(current);
      const now = new Set(current.flatMap((answer) => answer.runs.map((status) => runKey(answer.executorId, status))));
      const kept = new Map<string, RunStatus[]>();
      for (const [key, { executorId, status }] of seen) {
        if (now.has(key)) continue;
        kept.set(executorId, [...(kept.get(executorId) ?? []), { ...status }]);
      }
      return [...current, ...[...kept].map(([executorId, runs]): OccupancyAnswer => ({ executorId, coverage: "partial", runs }))];
    },
  };
}
