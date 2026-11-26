// 답을 기다리는 상태 조회의 등록부. sink.ts의 QueryBook(add, remove) 꼴에 영수증 처리기가 읽는 목록과 항목을 끝내는 두 길을 더한다.
// 설명 문서는 answers.md다.
//
// 이 파일이 지키는 것:
// - 항목은 그 조회를 실제로 실은 연결의 번호와 함께 등록된 값만 있다(더하는 쪽은 내보내기 포트 하나다). 등록 차례를 지킨다.
// - 실은 횟수만큼 항목이 있다. 같은 초안을 다시 봉해 같은 연결에 다시 실으면 같은 요청 ID의 항목이 둘이고, 실행기는 실을 때마다
//   그때의 상태로 답하므로 두 답이 서로 다른 관측일 수 있다. 그래서 항목은 하나씩만 끝낸다(settle은 항목 하나).
// - remove는 더할 때 받은 그 객체로 찾고, 없는 항목에도 던지지 않는다(내보내기 포트가 쓰지 못한 조회를 거둔다).
// - 연결이 철회되면(withdrawn) 그 연결의 항목을 끝낸다. 처리 중인 답과 철회 전에 받아 줄에 선 답이 쓸 항목만 그 답을 처리할 때까지
//   남긴다. 답을 처리한 항목과 답이 쓰지 않고 지나간 항목은 답 줄이 끝낸다(같은 연결로 dropConnection을 다시 부른다).
// - 등록부는 연결 서버 객체 하나와 수명을 같이한다. 서버를 새로 시작하면 연결 번호가 1부터이므로 새 등록부를 만든다(조립의 일).
// 시계·난수·타이머를 쓰지 않는다. 동기다.
import type { SentQuery } from "../dispatch/receipts.ts";
import type { QueryBook } from "./sink.ts";

export interface QueryRegistry extends QueryBook {
  // 영수증 처리기의 pendingQueries. 지금 등록된 항목을 등록 차례로 낸다. 배열은 부를 때마다 새것이고 원소는 등록부가 쥔 동결한 항목
  // 그 자체다: 같은 항목은 부를 때마다 같은 객체라, 받은 때의 목록과 지금 목록을 객체로 맞대 볼 수 있고 settle·dropConnection에
  // 그대로 넘긴다.
  pending(): readonly SentQuery[];
  // pending()이 낸 항목 하나를 끝낸다. 같은 요청 ID·같은 연결의 다른 항목(다시 실은 것)은 남긴다. 끝냈으면 true, 이미 없으면 false.
  settle(entry: SentQuery): boolean;
  // 철회된 연결의 항목을 끝낸다. keep(pending()이 낸 항목)은 남긴다: 철회 전에 받아 아직 처리를 마치지 않은 답이 쓸 항목이다(그 답을
  // 처리할 때 settle로 끝내거나, 쓰이지 않으면 더 좁은 keep으로 다시 불러 끝낸다). 연결 번호는 다시 쓰이지 않으므로 남긴 항목에 맞는
  // 답은 그 받은 답뿐이다. 끝낸 항목 수를 돌려준다.
  dropConnection(connection: number, keep?: ReadonlySet<SentQuery>): number;
}

// 결과 기다림 조회(life-loop.ts의 cause "result_wait")의 항목을 실행마다 몇 개로 줄이고, 그 실행이 checking을 떠나면 모두 끝내도록 고른다.
// 수명 박자는 답이 없으면 answerTimeoutMs마다 새 요청 ID로 다시 묻고 등록부는 실은 횟수만큼 항목을 쥐므로, 답하지 않는 실행기 하나에
// 항목이 끝없이 쌓인다. 고르기만 한다: 끝내기는 답 줄(answers.ts의 releaseQueries)이 받은 답이 쥔 항목을 빼고 한다.
// 남기는 수: 기본 간격 20초·조회 수명 30초에서 답이 아직 맞을 수 있는 조회는 많아야 둘이고 하나를 여유로 둔다. 함정: 간격을 답의 왕복
// 시간보다 훨씬 짧게 잡으면 늦은 답의 항목이 먼저 끝나 unknown_query로 버려진다(판정이 늦어질 뿐, 다음 조회로 다시 묻는다).
export const RESULT_WAIT_QUERIES_KEPT = 3;

export interface ResultWaitQueries {
  // sent: 이번 박자에 실은 result_wait 조회(실은 차례). checking: 박자 뒤에 읽은 checking 실행 ID이고 null이면 모름이다(떠난 실행을 고르지
  // 않고 수만 줄인다). 끝낼 요청 ID를 낸다: 앞에서 끝내지 못한 것, 실행마다 최근 kept개 밖의 것, checking을 떠난 실행의 것 전부.
  due(sent: readonly { readonly runId: string; readonly requestId: string }[], checking: ReadonlySet<string> | null): ReadonlySet<string>;
  // due가 낸 것 가운데 끝내지 못하고 남은 요청 ID(받은 답이 쥔 항목). 다음 due가 다시 낸다.
  unreleased(requestIds: ReadonlySet<string>): void;
}

export function createResultWaitQueries(kept: number = RESULT_WAIT_QUERIES_KEPT): ResultWaitQueries {
  if (!Number.isSafeInteger(kept) || kept < 1) throw new RangeError("남기는 결과 기다림 조회 수는 1 이상의 정수여야 한다");
  const byRun = new Map<string, string[]>();
  let retry = new Set<string>();
  return {
    due(sent, checking) {
      for (const { runId, requestId } of sent) {
        const ids = byRun.get(runId) ?? [];
        if (!ids.includes(requestId)) ids.push(requestId);
        byRun.set(runId, ids);
      }
      const out = new Set(retry);
      retry = new Set();
      for (const [runId, ids] of [...byRun]) {
        if (checking !== null && !checking.has(runId)) {
          for (const requestId of ids) out.add(requestId);
          byRun.delete(runId);
        } else if (ids.length > kept) {
          for (const requestId of ids.splice(0, ids.length - kept)) out.add(requestId);
        }
      }
      return out;
    },
    unreleased(requestIds) {
      for (const requestId of requestIds) retry.add(requestId);
    },
  };
}

export function createQueryBook(): QueryRegistry {
  // 더할 때 받은 객체 → 동결한 사본. 사본을 쥐어 더한 쪽이 나중에 객체를 고쳐도 대조 값이 바뀌지 않게 한다.
  const entries = new Map<SentQuery, SentQuery>();

  const dropWhere = (match: (entry: SentQuery) => boolean, limit = Number.POSITIVE_INFINITY): number => {
    let dropped = 0;
    for (const [key, entry] of [...entries]) {
      if (dropped >= limit) break;
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
    settle(entry: SentQuery): boolean {
      return dropWhere((held) => held === entry, 1) === 1;
    },
    dropConnection(connection: number, keep?: ReadonlySet<SentQuery>): number {
      return dropWhere((entry) => entry.connection === connection && keep?.has(entry) !== true);
    },
  };
}
