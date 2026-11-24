// 관리 통로의 상태 읽기. 조립(runtime/boot.ts)이 넘긴 읽기 포트만 쓴다: 장부의 읽기 넷, 조립 상태, 복원기의 접수 판정, 공유 시계.
// 장부에 쓰지 않고 연결에 싣지 않는다(test/supervisor/admin/static.test.ts가 글로, admin.test.ts가 실제 조립으로 본다).
// 복원 5단계를 받아들이기 전에는 장부를 읽지 않고 모름(restore_not_done)이다: 복원 전 장부의 정지·대기 행은 아직 현관 기록과
// 합치지 않은 값이라 알려진 상태로 내지 않는다.
import { type Read, type Run, SLOT_FREE, type StopRecord, type WaitingToolRequest } from "../../ledger/index.ts";
import { STATUS_MAX_COUNT, type SupervisorStatus, type UnknownReason } from "./protocol.ts";

// 관리 통로가 쓰는 장부의 면. 읽기만 있다. 조립은 이 넷만 묶은 객체를 넘긴다(장부 객체를 넘기지 않는다).
// 함정: 장부의 읽기도 실패하면 장부가 스스로 고장으로 표시한다(ledger.ts의 #read). 그 뒤 감독은 끝 차례로 간다. 박자의 읽기와 같은 규칙이다.
export interface AdminLedger {
  readStop(): Read<StopRecord | null>;
  readPause(): Read<number | null>;
  listRuns(): Read<Run[]>;
  listWaitingToolRequests(): Read<WaitingToolRequest[]>;
}

// 조립 상태. restored: 복원 5단계를 받아들였다. alive: 끝 차례에 들지 않았고 끝낼 사유도 없다. granted: 5단계가 낸 접수 허가를 받아들였다.
export interface AdminProgress {
  readonly restored: boolean;
  readonly alive: boolean;
  readonly granted: boolean;
}

export interface AdminSources {
  readonly progress: () => AdminProgress;
  // 복원기의 접수 판정(허가가 살아 있고 장부가 건강하고 정지가 아닌가). 읽기만 한다.
  readonly intakeOpen: () => boolean;
  // 장부 시계(공유 비후퇴 시계). 진단 일시 중지의 끝과 견줄 때만 읽는다.
  readonly now: () => number;
  readonly ledger: AdminLedger;
}

export type StatusAnswer = { readonly known: true; readonly status: SupervisorStatus } | { readonly known: false; readonly reason: UnknownReason };

const unknown = (reason: UnknownReason): StatusAnswer => ({ known: false, reason });

// 정지 기록을 CLI의 세 값으로. 정지 완료(stopped)는 실행 쪽 소멸까지 확인한 단계(runtime_verified)뿐이다: 접수만 된 정지를 완료로 내지 않는다.
// 풀린 정지(stopped false)는 남은 확인 단계와 상관없이 none이다.
function stopOf(record: StopRecord): SupervisorStatus["stop"] {
  if (!record.stopped) return "none";
  return record.phase === "runtime_verified" ? "stopped" : "stopping";
}

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
  const stop = sources.ledger.readStop();
  if (!stop.known) return unknown("ledger_unreadable");
  if (stop.value === null) return unknown("stop_unrecorded");
  const pause = sources.ledger.readPause();
  const runs = sources.ledger.listRuns();
  const waiting = sources.ledger.listWaitingToolRequests();
  if (!pause.known || !runs.known || !waiting.known) return unknown("ledger_unreadable");
  let paused = false;
  if (pause.value !== null) {
    const now = sources.now();
    if (!Number.isSafeInteger(now) || now <= 0) return unknown("clock_unavailable");
    paused = pause.value > now;
  }
  // 대기: 배정을 기다리는 부탁과 자리를 아직 받지 않은 실행. 작업: 자리를 쥔 실행(모름·정리 대기 포함).
  const queued = waiting.value.length + runs.value.filter((run) => run.state === "queued").length;
  const running = runs.value.filter((run) => !SLOT_FREE.includes(run.state)).length;
  if (queued >= STATUS_MAX_COUNT || running >= STATUS_MAX_COUNT || !Number.isSafeInteger(stop.value.generation) || stop.value.generation < 0) return unknown("out_of_range");
  const alive = progress.alive === true;
  // 접수 열림은 셋이 모두 참일 때다: 조립이 살아 있고, 5단계의 허가를 받아들였고, 복원기가 지금도 열림으로 판정한다.
  const intakeOpen = alive && progress.granted === true && sources.intakeOpen() === true;
  return {
    known: true,
    status: { alive, queued, running, diagnosis: paused ? "paused" : "active", stop: stopOf(stop.value), stopGeneration: stop.value.generation, intakeOpen },
  };
}
