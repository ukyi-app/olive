// 재시작 복원에 쓸 현관의 답을 복원기의 두 포트(StopAuthorityPort, PublicationPort)의 뜻으로 옮긴다.
// 선로·인증·판 대조는 이 밖의 일이다. 여기는 이미 인증되고 해석된 응답(또는 응답 실패)을 주입받는다.
//
// 가장 큰 함정: 현관이 답하지 않은 것을 "정지 기록 없음"(null)으로 바꾸면 복원기가 첫 설치로 보고 정지 세대 0을 적는다.
// 그래서 null은 "현관이 원장을 읽고 기록이 없다고 확인함" 한 가지에서만 나오고, 나머지는 모두 던진다(포트의 "모름").
// 주입받은 값도 런타임에 다시 본다: 타입만 믿으면 선로 쪽의 실수가 그대로 "없음"이나 "게시 안 됨"이 된다.
//
// 어댑터는 다시 묻지 않고, 타이머를 만들지 않고, 작업 ID를 바꾸지 않는다. 시간 초과도 주입받은 함수의 결과로 온다.
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

export type FrontDoorUnknownReason = FrontDoorFailure["kind"] | "invalid_reply" | "query_failed";

// 포트가 "모름"을 전하는 방식은 예외다. 복원기는 이것을 1단계 실패나 게시 unknown으로 적는다.
export class FrontDoorUnknownError extends Error {
  constructor(
    readonly query: "stop_ledger" | "publication",
    readonly reason: FrontDoorUnknownReason,
    options?: { cause?: unknown },
  ) {
    super(`현관의 ${query === "stop_ledger" ? "정지 원장" : "게시 상태"}을 모름(${reason})`, options);
    this.name = "FrontDoorUnknownError";
  }
}

const FAILURE_KINDS: readonly string[] = ["no_response", "timeout", "disconnected", "malformed"] satisfies FrontDoorFailure["kind"][];

// 일반 객체이고 칸 이름이 정확히 keys일 때만 칸 값을 한 번씩 읽어 돌려준다(같은 값을 두 번 읽지 않는다).
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every((key) => own.includes(key))) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = (value as Record<string, unknown>)[key];
  return out;
}

function kindOf(value: unknown): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as { kind?: unknown }).kind : undefined;
}

// 실패 응답이면 그 이유로, 아는 꼴이 아니면 invalid_reply로 던진다.
function rejectReply(query: FrontDoorUnknownError["query"], reply: unknown): never {
  const kind = kindOf(reply);
  if (typeof kind === "string" && FAILURE_KINDS.includes(kind) && fields(reply, ["kind"]) !== undefined) {
    throw new FrontDoorUnknownError(query, kind as FrontDoorFailure["kind"]);
  }
  throw new FrontDoorUnknownError(query, "invalid_reply");
}

async function ask<T>(query: FrontDoorUnknownError["query"], call: () => Promise<T>): Promise<unknown> {
  try {
    return await call();
  } catch (error) {
    throw new FrontDoorUnknownError(query, "query_failed", { cause: error });
  }
}

export function recoveryPorts(queries: FrontDoorRecoveryQueries): { stopAuthority: StopAuthorityPort; publications: PublicationPort } {
  return {
    stopAuthority: {
      async latestStop() {
        const reply = await ask("stop_ledger", () => queries.readStopLedger());
        const kind = kindOf(reply);
        if (kind === "confirmed_absent" && fields(reply, ["kind"]) !== undefined) return null;
        const record = kind === "recorded" ? fields(reply, ["kind", "generation", "stopped"]) : undefined;
        if (record !== undefined) {
          const { generation, stopped } = record;
          if (Number.isSafeInteger(generation) && (generation as number) >= 0 && typeof stopped === "boolean") return { generation: generation as number, stopped };
        }
        return rejectReply("stop_ledger", reply);
      },
    },
    publications: {
      async lookup(frontJobId: string) {
        const reply = await ask("publication", () => queries.lookupPublication(frontJobId));
        const kind = kindOf(reply);
        if (kind === "pending" && fields(reply, ["kind"]) !== undefined) return { kind: "pending" as const };
        const confirmed = kind === "confirmed" ? fields(reply, ["kind", "outcome"]) : undefined;
        if (confirmed !== undefined && (confirmed.outcome === "posted" || confirmed.outcome === "not_posted")) {
          return { kind: "confirmed" as const, outcome: confirmed.outcome };
        }
        return rejectReply("publication", reply);
      },
    },
  };
}
