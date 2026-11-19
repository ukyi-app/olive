// 작업자 파드의 전용 PID 공간에서 남은 프로세스를 끝내고 세는 일의 제품 입구.
// 전제: 실행기 컨테이너는 자기 PID namespace를 가지고 실행은 한 번에 하나다. 그 공간에서 실행기 자신과 PID 1 말고는 모두 그 실행의 것이다.
//
// 끝내는 수단은 kill(-1)이다. 커널이 호출자와 그 namespace의 init을 뺀 모든 프로세스(아래 namespace 포함)에 한 번에 신호를 보내므로
// fork가 끼어들 틈이 없고, 번호로 하나씩 보내지 않아 PID 재사용 경쟁도 없다.
// 함정: 호스트(또는 다른 프로세스와 함께 쓰는 공간)에서 kill(-1)이 나가면 그 사용자의 모든 프로세스가 끝난다.
//
// 실제 전체 신호 능력은 아래 PidSpace.record 한 자리에서만 만들어진다. 자기 번호·/proc·신호 함수를 함께 실제 값으로 묶고 다른 값을 받지 않는다.
// dedicated: true는 "이 공간을 전용으로 만들고 독점한다"는 호출자의 보증이다. 코어는 이것을 증명하지 못한다(containment-core.ts 머리말).
import { ContainmentUnavailable, type PidSpaceTiming, PidSweep, procFsReader } from "./containment-core.ts";

export { ContainmentUnavailable, type PidScan, type PidSpaceTiming, type ProcessCleanup, type ProcReader, procFsReader, type Signal } from "./containment-core.ts";

// 실제 정리의 옵션. 자기 번호·/proc·신호 함수는 받지 않는다.
export interface PidSpaceOptions extends PidSpaceTiming {
  // 명시 옵션. 전용 공간을 보증하는 조립만 true를 넘긴다.
  dedicated: true;
}

// 제품 옵션의 필수 조건. 실제 신호 능력을 만들기 전에 따로 본다.
export function checkRecordOptions(options: PidSpaceOptions): void {
  if (options.dedicated !== true) throw new ContainmentUnavailable("not_dedicated");
  // 시험 경로의 칸이 섞이면 실제 신호와 가짜 관측이 짝지어질 수 있다.
  if (["self", "reader", "kill"].some((key) => key in options)) throw new ContainmentUnavailable("not_dedicated");
}

export type PidSpace = PidSweep;

export const PidSpace = {
  // 실행기가 뜰 때, 자식을 띄우기 전에 한 번 부른다.
  async record(options: PidSpaceOptions): Promise<PidSweep> {
    checkRecordOptions(options);
    return PidSweep.establish({ self: process.pid, reader: procFsReader(), kill: (pid, signal) => void process.kill(pid, signal) }, options);
  },
};
