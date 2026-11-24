// 관리 통로의 상태 읽기. 조립(runtime/boot.ts)이 넘긴 읽기 포트만 쓴다: 조립 상태, 복원기의 상태 읽기(장부), 공유 시계의 peek.
// 감독의 어떤 상태도 바꾸지 않는다: 장부에 쓰지 않고 연결에 싣지 않으며, 읽기가 실패해도 장부를 고장으로 표시하지 않고(접수 허가·끝 차례가
// 그대로다), 시계를 읽어도 공유 하한을 올리지 않는다(test/supervisor/admin/static.test.ts가 글로, admin.test.ts가 실제 조립으로 본다).
// 복원 5단계를 받아들이기 전에는 장부를 읽지 않고 모름(restore_not_done)이다: 복원 전 장부의 정지·대기 행은 아직 현관 기록과
// 합치지 않은 값이라 알려진 상태로 내지 않는다.
import type { Read, StatusPeek, StopRecord } from "../../ledger/index.ts";
import { STATUS_MAX_COUNT, type SupervisorStatus, type UnknownReason } from "./protocol.ts";

// 조립 상태. restored: 복원 5단계를 받아들였다. alive: 끝 차례에 들지 않았고 끝낼 사유도 없다. granted: 5단계가 낸 접수 허가를 받아들였다.
export interface AdminProgress {
  readonly restored: boolean;
  readonly alive: boolean;
  readonly granted: boolean;
}

// 시계 읽기(공유 시계의 peek와 같은 꼴). ok만 시각이다.
export type AdminClockReading = { readonly state: "ok"; readonly at: number } | { readonly state: "regressed" | "unavailable" };

export interface AdminSources {
  readonly progress: () => AdminProgress;
  // 장부의 상태 읽기 하나(복원기의 statusView → Ledger.peekStatus). 개수는 cap에서 멈춘다. 접수 판정(허가가 살아 있고 장부가 건강하고
  // 정지가 아닌가)도 같은 읽기의 정지 기록으로 낸다. 실패하면 모름이고 장부를 고장으로 표시하지 않는다.
  readonly view: (cap: number) => Read<StatusPeek>;
  // 장부 시계(공유 비후퇴 시계)의 peek. 진단 일시 중지의 끝과 견줄 때만 읽는다. 하한을 올리지 않는다.
  readonly now: () => AdminClockReading;
}

export type StatusAnswer = { readonly known: true; readonly status: SupervisorStatus } | { readonly known: false; readonly reason: UnknownReason };

const unknown = (reason: UnknownReason): StatusAnswer => ({ known: false, reason });

// 정지 기록을 CLI의 세 값으로. 정지 완료(stopped)는 실행 쪽 소멸까지 확인한 단계(runtime_verified)뿐이다: 접수만 된 정지를 완료로 내지 않는다.
// 풀린 정지(stopped false)는 남은 확인 단계와 상관없이 none이다.
function stopOf(record: StopRecord): SupervisorStatus["stop"] {
  if (!record.stopped) return "none";
  return record.phase === "runtime_verified" ? "stopped" : "stopping";
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

// 한 동기 구간에서 읽는다(await 없음). 장부를 쓰는 쪽은 같은 프로세스의 같은 이벤트 루프뿐이라 읽는 사이에 장부가 바뀌지 않는다.
// 던지면 모름(read_threw)이다.
export function readStatus(sources: AdminSources): StatusAnswer {
  try {
    return judge(sources);
  } catch {
    return unknown("read_threw");
  }
}

function judge(sources: AdminSources): StatusAnswer {
  const progress = sources.progress();
  if (progress.restored !== true) return unknown("restore_not_done");
  const view = sources.view(STATUS_MAX_COUNT);
  if (view.known !== true) return unknown("ledger_unreadable");
  const { stop, pauseUntil, waitingRequests, queuedRuns, slotRuns } = view.value;
  if (stop === null) return unknown("stop_unrecorded");
  let paused = false;
  if (pauseUntil !== null) {
    const now = sources.now();
    if (now.state !== "ok" || !Number.isSafeInteger(now.at) || now.at <= 0) return unknown("clock_unavailable");
    paused = pauseUntil > now.at;
  }
  if (!isCount(waitingRequests) || !isCount(queuedRuns) || !isCount(slotRuns)) return unknown("out_of_range");
  // 대기: 배정을 기다리는 부탁과 자리를 아직 받지 않은 실행. 작업: 자리를 쥔 실행(모름·정리 대기, 장부 밖 실행의 점유 관측 포함).
  const queued = waitingRequests + queuedRuns;
  const running = slotRuns;
  if (queued >= STATUS_MAX_COUNT || running >= STATUS_MAX_COUNT || !Number.isSafeInteger(stop.generation) || stop.generation < 0) return unknown("out_of_range");
  // 받아들인 허가와 장부의 지금 허가가 어긋나면(새 정지 기록이 허가를 버림, 받아들이지 않은 허가가 열림) 조립의 다음 박자가
  // intake_discarded·intake_unaccepted로 끝낸다. 사유는 이미 생겼으므로 살아 있음으로 내지 않는다. 처음부터 허가가 없는 감독은 살아 있을 수 있다.
  // 박자의 래치(look)를 부르지 않고 이 읽기의 값만 견준다.
  const alive = progress.alive === true && progress.granted === (view.value.intakeOpen === true);
  // 접수 열림은 셋이 모두 참일 때다: 조립이 살아 있고, 5단계의 허가를 받아들였고, 장부가 이 읽기에서 열림으로 판정한다.
  const intakeOpen = alive && progress.granted === true && view.value.intakeOpen === true;
  return {
    known: true,
    status: { alive, queued, running, diagnosis: paused ? "paused" : "active", stop: stopOf(stop), stopGeneration: stop.generation, intakeOpen },
  };
}
