// 답을 기다리는 상태 조회의 등록부. sink.ts의 QueryBook(add, remove) 꼴에 영수증 처리기가 읽는 목록과 항목을 끝내는 두 길을 더한다.
// 설명 문서는 answers.md다.
//
// 이 파일이 지키는 것:
// - 항목은 그 조회를 실제로 실은 연결의 번호와 함께 등록된 값만 있다(더하는 쪽은 내보내기 포트 하나다). 등록 차례를 지킨다.
// - remove는 더할 때 받은 그 객체로 찾고, 없는 항목에도 던지지 않는다(내보내기 포트가 쓰지 못한 조회를 거둔다).
// - 연결이 철회되면(withdrawn) 그 연결의 항목을 끝낸다. 철회 전에 받아 줄에 선 답이 가리키는 항목만 그 답을 처리할 때까지 남긴다.
//   답을 처리한 항목은 답 줄이 끝낸다.
// - 등록부는 연결 서버 객체 하나와 수명을 같이한다. 서버를 새로 시작하면 연결 번호가 1부터이므로 새 등록부를 만든다(조립의 일).
// 시계·난수·타이머를 쓰지 않는다. 동기다.
import type { SentQuery } from "../dispatch/receipts.ts";
import type { QueryBook } from "./sink.ts";

export interface QueryRegistry extends QueryBook {
  // 영수증 처리기의 pendingQueries. 지금 등록된 항목의 사본을 등록 차례로 낸다. 부를 때마다 새 배열이다.
  pending(): readonly SentQuery[];
  // 그 연결에서 대조된 답을 처리한 조회 하나를 끝낸다. 같은 요청 ID라도 다른 연결의 항목은 남긴다. 끝낸 항목 수를 돌려준다.
  settle(requestId: string, connection: number): number;
  // 철회된 연결의 항목을 끝낸다. keep의 요청 ID는 남긴다: 철회 전에 받아 아직 넘기지 않은 답이 가리키는 조회다(그 답을 처리할 때
  // settle로 끝낸다). 연결 번호는 다시 쓰이지 않으므로 남긴 항목에 맞는 답은 그 받은 답뿐이다. 끝낸 항목 수를 돌려준다.
  dropConnection(connection: number, keep?: ReadonlySet<string>): number;
}

export function createQueryBook(): QueryRegistry {
  // 더할 때 받은 객체 → 동결한 사본. 사본을 쥐어 더한 쪽이 나중에 객체를 고쳐도 대조 값이 바뀌지 않게 한다.
  const entries = new Map<SentQuery, SentQuery>();

  const dropWhere = (match: (entry: SentQuery) => boolean): number => {
    let dropped = 0;
    for (const [key, entry] of [...entries]) {
      if (!match(entry)) continue;
      entries.delete(key);
      dropped += 1;
    }
    return dropped;
  };

  return {
    add(query: SentQuery): void {
      const runIds: readonly string[] = Object.freeze([...query.runIds]);
      entries.set(query, Object.freeze({ requestId: query.requestId, recipient: query.recipient, runIds, connection: query.connection }));
    },
    remove(query: SentQuery): void {
      entries.delete(query);
    },
    pending(): readonly SentQuery[] {
      return [...entries.values()];
    },
    settle(requestId: string, connection: number): number {
      return dropWhere((entry) => entry.requestId === requestId && entry.connection === connection);
    },
    dropConnection(connection: number, keep?: ReadonlySet<string>): number {
      return dropWhere((entry) => entry.connection === connection && keep?.has(entry.requestId) !== true);
    },
  };
}
