// 한 프로세스가 함께 쓰는 비후퇴 장부 시계. 진입점은 이 객체 하나를 장부(openLedger의 clock)·내보내기 포트·연결 서버·순서기
// (ledgerClock)에 모두 넘긴다. 누가 읽든 그 값이 하한이 되므로, 송신 직전 확인이 읽은 시각으로 닫은 창(시작 지시의 송신 시한 등)이
// 원천 시계가 뒤로 가도 다시 열리지 않는다. 원천 시계는 주입받고 이 파일은 시계를 직접 부르지 않는다.
// 하한은 메모리에만 있다. 감독이 다시 뜨면 새 객체가 하한 0으로 시작한다.
import type { Clock } from "../dispatch/ports.ts";

export type ClockReading = { readonly state: "ok"; readonly at: number } | { readonly state: "regressed" | "unavailable" };

export interface SharedClock extends Clock {
  // 원천 값이 하한보다 이르면 하한을 낸다(유효한 값으로는 내는 값이 줄지 않는다). 원천 값이 양의 안전 정수가 아니면 하한을 바꾸지
  // 않고 그 값을 그대로 낸다: 던지면 장부는 읽기 실패로 실패 표시를 남기고 TLS 수락 콜백에서는 예외가 밖으로 나간다. 무효 값은
  // 각 소비자의 무효 시각 처리를 따른다(장부는 모든 기한이 지난 것으로 본다). 함정: 싱크는 안전 정수면 0·음수도 시각으로 받으므로
  // 원천이 그런 값을 내면 그 읽기는 하한을 지키지 못한다. 원천이 던지면 던진다.
  now(): number;
  // 순서기의 읽기. 원천 값이 하한 이상이면 ok(하한을 올린다), 이르면 regressed, 읽지 못하거나 무효 값이면 unavailable이다. regressed와
  // unavailable은 하한을 바꾸지 않는다. 다른 소비자가 now()로 올린 하한도 여기서 보이므로 순서기가 그 후퇴를 안다.
  read(): ClockReading;
}

const made = new WeakSet<object>();

export function createSharedClock(source: Clock): SharedClock {
  let floor = 0;
  // 원천 값 하나를 하한과 견준다. ok일 때만 하한을 올린다.
  const judge = (at: unknown): ClockReading => {
    if (!Number.isSafeInteger(at) || (at as number) <= 0) return { state: "unavailable" };
    if ((at as number) < floor) return { state: "regressed" };
    floor = at as number;
    return { state: "ok", at: floor };
  };
  const read = (): ClockReading => {
    let at: unknown;
    try {
      at = source.now();
    } catch {
      return { state: "unavailable" };
    }
    return judge(at);
  };
  const clock: SharedClock = Object.freeze({
    now(): number {
      let at: unknown;
      try {
        at = source.now();
      } catch {
        throw new RangeError("clock_unavailable");
      }
      const reading = judge(at);
      if (reading.state === "ok") return reading.at;
      if (reading.state === "regressed") return floor;
      return at as number;
    },
    read,
  });
  made.add(clock);
  return clock;
}

// createSharedClock이 만든 객체인가. 꼴만 같은 시계는 하한을 나누지 않으므로 순서기가 받지 않는다.
export function isSharedClock(value: unknown): value is SharedClock {
  return typeof value === "object" && value !== null && made.has(value);
}
