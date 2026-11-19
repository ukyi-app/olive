// 재시작 복원에 쓸 현관의 답을 복원기의 두 포트(StopAuthorityPort, PublicationPort)의 뜻으로 옮긴다.
// 선로·인증·판 대조는 이 밖의 일이다. 여기는 이미 인증되고 해석된 응답(또는 응답 실패)을 주입받는다.
//
// 가장 큰 함정: 현관이 답하지 않은 것을 "정지 기록 없음"(null)으로 바꾸면 복원기가 첫 설치로 보고 정지 세대 0을 적는다.
// 그래서 null은 "현관이 원장을 읽고 기록이 없다고 확인함" 한 가지에서만 나오고, 나머지는 모두 던진다(포트의 "모름").
// 주입받은 값도 런타임에 다시 본다: 타입만 믿으면 선로 쪽의 실수가 그대로 "없음"이나 "게시 안 됨"이 된다.
//
// 어댑터는 다시 묻지 않고, 타이머를 만들지 않고, 작업 ID를 바꾸지 않는다. 시간 초과도 주입받은 함수의 결과로 온다.
//
// 응답은 주입 경계에서 일반 데이터 객체(객체 리터럴·JSON.parse의 결과처럼 프로토타입이 Object.prototype이나 null이고
// 칸이 모두 열거 가능한 문자열 키의 데이터 속성인 것)로 만들어 넘긴다는 전제다. 임의 Proxy는 런타임에 믿을 만하게
// 가려낼 수 없으므로 가리지 않는다: trap이 던지면 모름이 되지만, 일관되게 거짓을 말하는 Proxy는 이 어댑터가 막지 못한다.
import type { PublicationPort, StopAuthorityPort } from "../../ledger/index.ts";

// 현관에서 확인된 답을 받지 못한 경우. 모두 "모름"이며 서로 구별만 한다.
// malformed: 응답은 왔지만 해석 단계가 꼴이 틀렸다고 판정한 것이다.
export type FrontDoorFailure = { kind: "no_response" } | { kind: "timeout" } | { kind: "disconnected" } | { kind: "malformed" };

// 정지 원장 조회의 답. confirmed_absent는 현관이 원장을 읽고 기록이 없다고 확인해 준 것이다(빈 응답과 다르다).
export type StopLedgerReply = { kind: "recorded"; generation: number; stopped: boolean } | { kind: "confirmed_absent" } | FrontDoorFailure;

// 게시 상태 조회의 답(작업 ID로 묻는다). 확정과 대기만 현관의 사실이다.
export type PublicationReply = { kind: "confirmed"; outcome: "posted" | "not_posted" } | { kind: "pending" } | FrontDoorFailure;

// 현관에 묻는 함수. 인증·선로·시간 제한은 이 함수를 만드는 쪽이 맡는다.
export interface FrontDoorRecoveryQueries {
  readStopLedger(): Promise<StopLedgerReply>;
  lookupPublication(frontJobId: string): Promise<PublicationReply>;
}

// 사유는 이 목록뿐이다. 바깥 오류의 글이나 객체는 싣지 않는다: 복원기가 메시지를 장부·로그로 옮길 수 있다.
// invalid_reply: 응답을 읽다가 예외가 났거나 아는 꼴이 아님. query_failed: 주입받은 함수가 던지거나 거절함.
export type FrontDoorUnknownReason = FrontDoorFailure["kind"] | "invalid_reply" | "query_failed";

// 포트가 "모름"을 전하는 방식은 예외다. 복원기는 이것을 1단계 실패나 게시 unknown으로 적는다.
export class FrontDoorUnknownError extends Error {
  constructor(
    readonly query: "stop_ledger" | "publication",
    readonly reason: FrontDoorUnknownReason,
  ) {
    super(`현관의 ${query === "stop_ledger" ? "정지 원장" : "게시 상태"}을 모름(${reason})`);
    this.name = "FrontDoorUnknownError";
  }
}

const FAILURE_KINDS: readonly string[] = ["no_response", "timeout", "disconnected", "malformed"] satisfies FrontDoorFailure["kind"][];

// 응답의 자체 칸을 한 번만 읽어 칸 이름 → 값의 스냅샷을 만든다. 종류를 가르는 것도 값을 꺼내는 것도 이 스냅샷에서만 한다.
// 일반 데이터 객체가 아니면(원시값, 함수, 배열·클래스 인스턴스처럼 다른 프로토타입, 심벌 키, 열거 불가 칸, 접근자 칸)
// 또는 읽다가 던지면 undefined다. 접근자는 부르지 않고 설명자로만 본다.
function readReply(value: unknown): Map<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return undefined;
    // 키 목록과 설명자를 한 번에 새 일반 객체로 받는다. 이후로는 응답 객체를 다시 건드리지 않는다.
    const descriptors = Object.getOwnPropertyDescriptors(value);
    // Map에 담는다: 자체 "__proto__" 칸이 일반 객체에 대입되면 칸이 아니라 프로토타입이 바뀐다.
    const snapshot = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as keyof typeof descriptors];
      if (typeof key !== "string" || descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return undefined;
      snapshot.set(key, descriptor.value);
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

// 스냅샷의 칸 이름이 정확히 keys인가.
function hasExactly(reply: Map<string, unknown> | undefined, keys: readonly string[]): reply is Map<string, unknown> {
  return reply !== undefined && reply.size === keys.length && keys.every((key) => reply.has(key));
}

// 실패 응답이면 그 이유로, 아는 꼴이 아니면 invalid_reply로 던진다.
function rejectReply(query: FrontDoorUnknownError["query"], reply: Map<string, unknown> | undefined): never {
  const kind = reply?.get("kind");
  if (typeof kind === "string" && FAILURE_KINDS.includes(kind) && hasExactly(reply, ["kind"])) {
    throw new FrontDoorUnknownError(query, kind as FrontDoorFailure["kind"]);
  }
  throw new FrontDoorUnknownError(query, "invalid_reply");
}

async function ask<T>(query: FrontDoorUnknownError["query"], call: () => Promise<T>): Promise<Map<string, unknown> | undefined> {
  let raw: unknown;
  try {
    raw = await call();
  } catch {
    // 원래 오류는 버린다(cause에도 두지 않는다). 바깥 응답의 글이 메시지를 타고 장부·로그로 가지 않게.
    throw new FrontDoorUnknownError(query, "query_failed");
  }
  return readReply(raw);
}

export function recoveryPorts(queries: FrontDoorRecoveryQueries): { stopAuthority: StopAuthorityPort; publications: PublicationPort } {
  return {
    stopAuthority: {
      async latestStop() {
        const reply = await ask("stop_ledger", () => queries.readStopLedger());
        const kind = reply?.get("kind");
        if (kind === "confirmed_absent" && hasExactly(reply, ["kind"])) return null;
        if (kind === "recorded" && hasExactly(reply, ["kind", "generation", "stopped"])) {
          const generation = reply.get("generation");
          const stopped = reply.get("stopped");
          // -0도 0 이상 안전 정수로 통과하지만 장부에서 +0이 되어 권위 세대 0으로 적힌다. 현관이 낼 값이 아니므로 모름이다.
          if (typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0 && !Object.is(generation, -0) && typeof stopped === "boolean") {
            return { generation, stopped };
          }
        }
        return rejectReply("stop_ledger", reply);
      },
    },
    publications: {
      async lookup(frontJobId: string) {
        const reply = await ask("publication", () => queries.lookupPublication(frontJobId));
        const kind = reply?.get("kind");
        if (kind === "pending" && hasExactly(reply, ["kind"])) return { kind: "pending" as const };
        if (kind === "confirmed" && hasExactly(reply, ["kind", "outcome"])) {
          const outcome = reply.get("outcome");
          if (outcome === "posted" || outcome === "not_posted") return { kind: "confirmed" as const, outcome };
        }
        return rejectReply("publication", reply);
      },
    },
  };
}
