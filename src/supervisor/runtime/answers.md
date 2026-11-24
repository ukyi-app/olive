# 답 줄과 조회 등록부 (`answers.ts`, `query-book.ts`)

연결 서버(`transport/server.ts`)가 넘긴 출력(`deliver`)을 받아, 실행기마다 답(인사의 `full` 점유, 대조할 상태 보고, 저장되지 않은 밀린 사본)을 받은 차례로 줄 세우고 그 차례로 영수증 처리기(`dispatch/receipts.ts`의 `handleForward`·`replayBacklog`)와 인사 처리기(`dispatch/hello-answers.ts`의 `passHelloAnswer`·`retryHelloAnswer`)에 넘긴다. 영수증·보고는 줄에 넣지 않고 곧바로 영수증 처리기에 넘기고, 장부가 받은 것의 ack 초안만 봉해 내보내기 포트의 `writeAck`로 그 영수증이 온 연결에 쓴다. 조회 등록부는 내보내기 포트(`sink.ts`)의 `QueryBook` 꼴의 구현이고 처리기의 `pendingQueries`를 낸다.

처리기의 판단을 다시 만들지 않는다. 처리기 결과의 정해진 칸(`backlog`, `retry`, `withhold`, `held`)을 줄의 상태로 옮기기만 한다. 시계·난수·소켓·타이머를 직접 쓰지 않고, 모든 흐름이 동기다. 이 둘을 부르는 곳(감독 진입점)은 아직 없다.

## 공개 면

| 이름 | 꼴 |
|---|---|
| `createQueryBook()` | → `QueryRegistry`. `add`·`remove`(내보내기 포트가 부름), `pending()`(처리기의 `pendingQueries`, 등록 차례의 사본), `settle(requestId, connection)`, `dropConnection(connection, keep?)` |
| `createAnswerLines(ports)` | `AnswerLinePorts` → `AnswerLines` |
| `AnswerLines.deliver(output)` | 연결 서버 옵션의 `deliver`. 던지지 않는다 |
| `AnswerLines.pump()` | 쥔 답(복원 관측 대기, 접수 대기의 인사, 실패한 인사, 밀린 사본)을 다시 넘겨 본다. 박자마다 부른다 |
| `AnswerLines.withheld` | `WithheldSource`(`dispatch/assign-loop.ts`). 배정 박자와 내보내기 포트가 읽는 맡기지 않을 실행기 집합 |
| `AnswerLines.backlog(executorId)` | 그 실행기의 밀린 사본(받은 차례의 사본) |
| `AnswerLines.takeRequery()` | 같은 실행 ID로 다시 물어야 할 실행. 꺼내면 비운다 |
| `AnswerNote` | 기록: `receipt`, `status`, `backlog`, `hello`(처리기의 결과 그대로), `ack`(`writeAck`의 결과 또는 `seal_refused`·`seal_threw`), `fault` |

받는 포트(`AnswerLinePorts`): `table`(연결 서버의 `table`), `restorer`(서버·내보내기 포트와 같은 복원기 게시 함수), `ledger`(`applyReceipt`·`recordReport`·`applyExecutorAnswer`), `results`(결과 보고의 보관과 장부 읽기, 필수), `random`, `signer`, `clock`(공유 시계), `wire`(내보내기 포트의 `answers`·`writeAck`), `queries`(위 등록부), `cycle`(순서기의 `noteCandidate`), `observationsSettled`(복원 2단계가 붙든 관측을 적었는가), `observe`(선택).

## 출력마다 하는 일 (`answers.ts`의 `take`)

| 연결 서버의 출력 | 하는 일 |
|---|---|
| `occupancy`(`full`) | 그 실행기의 줄 끝에 인사로 넣고 맡기지 않음을 세운다 |
| `occupancy`(`partial`) | 버린다. 같은 상태 보고가 `forward`로도 오므로 그쪽에서 한 번만 센다 |
| `forward`(`status_report`) | 낸 쪽 실행기의 줄 끝에 넣는다 |
| `forward`(그 밖: 영수증·보고·결과 보고) | 곧바로 `handleForward`. 결과가 `ack`일 때만 초안을 봉해 `writeAck(forward.connection, …)` |
| `candidate` | 순서기의 `noteCandidate(작업자 실행기 이름)` |
| `withdrawn` | 등록부의 그 연결 항목을 끝낸다. 철회 전에 받아 줄에 선 그 연결의 답이 가리키는 조회만 남긴다 |

줄에 넣은 뒤 그 실행기의 줄을 곧바로 돌린다(같은 동기 구간). 처리 중에 다시 들어온 출력은 줄에 넣기만 하고 바깥 처리가 이어서 돈다.

## 한 줄의 차례 (`pumpLine`)

1. `observationsSettled()`가 참이 아니면(던짐 포함) 아무것도 넘기지 않는다.
2. 실패한 인사의 원본 `retry`가 있으면 `retryHelloAnswer`로 먼저 다시 넘긴다. 또 실패하면 멈춘다.
3. 맨 앞이 인사면: 밀린 사본을 먼저 `replayBacklog`로 넘기고 남으면 멈춘다. 그때의 연결 표(`table()`)와 그때 게시된 복원기로 `passHelloAnswer`. `held`면 맨 앞에 둔 채 멈춘다. 실패(`retry` 있음)면 `retry`를 쥐고 멈춘다. 반영·`not_current`·`refused`·`input_rejected`는 줄에서 뺀다.
4. 맨 앞이 상태 보고면: `handleForward`에 그 실행기의 밀린 사본(`backlog`)과 등록부의 `pending()`, `links: wire.answers`를 넘긴다. 처리기가 밀린 사본을 이번 답보다 먼저 넘긴다. `status_matched`면 결과의 `backlog`로 바꾸고, `status_not_current`면 "안다"는 항목이 있을 때 그 사본을 밀린 목록 끝에 둔다. 어느 결과든 그 연결의 그 조회 항목을 끝낸다.
5. 줄이 비었고 이번 처리에서 아무 답도 넘기지 않았으면 밀린 사본을 `replayBacklog`로 다시 넘긴다.

시계(`clock.now()`), 연결 표, 복원기를 읽지 못하면 그 답을 버리지 않고 쥔 채 멈춘다. 방금 실패한 답은 같은 처리 안에서 되풀이하지 않고 다음 `pump()`나 그 실행기의 다음 답에서 다시 넘긴다.

## 맡기지 않을 실행기

실행기는 인사가 줄에 들어온 때 집합에 들고, 그 실행기의 **현재 연결** 인사가 반영되고(`applied`의 연결이 그 순간 `wire.answers.current`로 인정된 연결) 줄에 붙든 인사(`retry`, 줄의 인사)가 더 없을 때 빠진다. `input_rejected`·`not_current`로 버린 인사는 내리지 않는다. 처리 중 뜻밖의 예외가 나면 그 뒤로 `executors()`는 `{ known: false }`다(줄의 상태를 모른다. 배정은 멈추고 내보내기 포트는 시작을 싣지 않는다).

## 지킨 조건

번호는 설계 조사의 조건 번호다. 줄 번호는 이 PR의 `answers.ts`·`query-book.ts`다.

| 번호 | 조건 | 지킨 자리 | 시험 | 원문 |
|---|---|---|---|---|
| C11 | 기다리는 조회 목록의 수명은 순환이 정하고, 복원이 낸 조회도 넣는다 | 등록부는 서버 객체 하나와 수명을 같이한다(`query-book.ts` 머리). 항목은 내보내기 포트가 쓰기 전에 더하고(`add`), 쓰지 못하면 거두고(`remove`), 답을 처리하면 줄이 끝내고(`answers.ts:295`), 연결이 철회되면 끝낸다(`:348`). `status_query`는 어느 박자가 내든 내보내기 포트를 지나므로 모두 등록된다 | 조회 등록부 넷, 루프백 | `dispatch/receipts.md` "조회는 싣는 연결에 등록한다", `sink.md` "조회 등록부는 서버 객체와 수명을 같이한다" |
| C15 | 포트는 읽기 실패를 빈 목록으로 바꾸지 않는다. 모르면 `known: false` | 연결 표·복원기·시계를 읽지 못하면 쥐고 멈춤(`:270`, `readNow`), 예외 뒤 `executors()`가 `known: false`(`:395`) | "연결 표를 읽지 못하면", "deliver는 던지지 않고" | `link-loss.md`·`assign-loop.md` "모르면 known: false" |
| C16 | `status_report`는 `forward`로만, 두 번 세지 않음 | `occupancy`(`partial`)는 버림(`:353`), 줄의 답은 넘길 때 한 번 뺀다 | "인사 → 상태 보고가 받은 차례로" | `receipts.md` "`status_report`의 `forward`를 이 처리기로 넘긴다" |
| C17 | ack는 장부가 받은 것만, `writeAck(forward.connection, …)` | `passReceipt`의 `ack` 갈래만(`:201`), 그때의 시각으로 봉함(`:184`) | ack 둘 | `receipts.md` "ack는 장부가 받은 것만 싣는다", `sink.md` "ack는 `writeAck`로" |
| C18 | 실행기별 받은 차례, 실패한 답은 원본 `retry`로 먼저, `held`는 넘기는 순간의 가장 새 표 | `pumpLine`(`:240`~): `retry` 먼저(`:244`), 인사마다 `table()`·`restorer()`를 새로 읽음(`:270`), `held`는 맨 앞에 둠(`:277`) | 차례 셋 | `hello-answers.md` "실행기별로 받은 순서를 지킨다", `receipts.md` "한 실행기의 답은 받은 순서대로" |
| C19 | 각 full 출력은 한 번만 | 반영된 인사는 줄에서 빠지고 다시 넘기는 것은 `held`와 실패의 `retry`뿐 | "반영된 full은 다시 넘기지 않는다" | `hello-answers.md` "각 full 출력은 한 번만 넘긴다" |
| C20 | `status_not_current`의 "안다" 사본은 그 실행기의 밀린 목록 끝에 | `:302` | "넘기는 순간 연결이 바뀌었으면", "not_known만 실은", 루프백 | `receipts.md` "`status_not_current`의 답은 버리지 않고" |
| C21 | 소비하는 때에도 연결 대조: `sink.answers.current`를 처리기의 `links`로 | `links: ports.wire.answers`(`:197`, `:207`, `:290`). 줄에 선 답도 넘기는 순간에 묻는다 | "넘기는 순간 연결이 바뀌었으면", 루프백 | `sink.ts`의 `answers`, `receipts.md` "`links`를 지금의 연결 표로 잇는다" |
| C23 | `deferred`·실패·`status_not_current`·`not_current`면 같은 실행 ID를 다시 조회 | **일부**: 그 실행을 `takeRequery()`로 낸다(`takeSettlements` `:172`, `:300`). 조회를 내는 것은 수명 박자의 판단과 간격이다(아래 "남는 한계") | "장부가 보류한 실행은", "넘기는 순간 연결이 바뀌었으면" | `receipts.md` "같은 실행 ID로 다시 묻는다" |
| C29 | `withhold` 실행기는 새 배정·대기 실행의 시작 양쪽에서: 같은 `WithheldSource`를 배정 박자와 내보내기 포트에 | `withheld` 하나를 낸다(`:394`). 넘기는 것은 진입점의 일(아래 "뒤 조각이 지켜야 할 것") | "실패한 인사는 원본 retry로", "접수 대기(held)", 복원 대기 | `assign-loop.md`·`sink.md` "맡기지 않을 실행기는 배정 박자와 같은 원천을" |
| C37 | 같은 복원기 게시 함수 | `restorer()`를 부를 때마다 읽고 쥐지 않는다(인사의 접수, ack의 정지 세대) | (조립 조건) | `server.md`·`sink.md`·`hello-answers.md` |
| C43 | 등록부의 구현: 서버와 수명을 같이, 철회된 연결의 항목을 끝냄, `remove`는 없는 항목에 던지지 않음 | `query-book.ts` 전체 | 조회 등록부 셋 | `sink.ts`의 `QueryBook`, `sink.md`, `server.md` "서버를 새로 시작하면 연결 번호가 1부터다" |
| C44 | `deliver`는 던지지 않는다. `forward`는 `handleForward`로, `occupancy(full)`은 `passHelloAnswer`로 | `deliver`의 `try`(`:376`), `drain`의 `catch` | "deliver는 던지지 않고" | `server.md` "`deliver`는 던지지 않는다" |
| C45 | 밀린 사본이 사는 동안 연결 번호가 유효 | 줄과 등록부는 `wire`(그 서버 위의 내보내기 포트)에 묶여 그 서버의 연결 번호로만 묻는다. 서버를 새로 만들면 새로 만든다(아래) | (조립 조건) | `receipts.md` "연결 번호는 밀린 사본이 살아 있는 동안 유효해야 한다" |
| C46 | 결과 포트를 늘 넘기고, 처리기를 부르는 흐름에 `await` 없음 | `results`는 필수 칸. 파일에 `await`·`async`가 없다 | 정적(C46) | `receipts.md` "결과 포트를 늘 넘긴다" |
| C47 | 복원이 붙든 관측이 운영 답보다 먼저 | `observationsSettled()`가 참일 때만 줄을 돌린다(`:241`) | 복원 대기 | `receipts.md` "복원이 붙든 관측이 운영의 답보다 먼저다" |
| C48 | `retryHelloAnswer`는 복원 2단계 전에 부르지 않는다 | 같은 자리. 다시 넘기기도 줄 안에서만 한다 | 복원 대기 | `hello-answers.md` "복원과의 순서는 처음 넘기기에서만 저절로 선다" |

## 정한 것

1. **철회된 연결의 조회 중 이미 받아 줄에 선 답이 가리키는 것은 남긴다.** 철회와 함께 모두 지우면, 받을 때 그 연결로 유효했던 답(복원 관측 대기나 앞 답에 막혀 줄에 선 답)이 넘기는 순간 `unknown_query`로 버려져 그 답의 "안다"는 관측이 밀린 목록에도 남지 않는다. 남긴 항목은 그 받은 답을 처리할 때 끝낸다. 연결 번호는 다시 쓰이지 않으므로 남긴 항목에 맞는 답은 그 답뿐이다. 넘기는 순간의 연결 대조(`links`)가 그대로 걸리므로 그 답은 `status_not_current`가 되고 장부에 닿지 않는다.
2. **영수증·보고는 답 줄에 넣지 않는다.** 실행기가 ack를 받을 때까지 다시 보내므로 순서에 기대지 않고, 막힌 줄(인정이 끝난 연결의 "안다" 사본은 계속 막는다) 뒤에 두면 종료 영수증이 무기한 막힌다. 영수증 처리기 문서가 정한 줄도 답(인사·상태 보고·밀린 사본)의 줄이다.
3. **복원 대기는 포트(`observationsSettled`)로 받는다.** 복원기에는 2단계를 마쳤는지 읽는 공개 면이 없다(`#step2`는 내부). 붙든 관측이 어느 실행기의 것인지도 밖에서 알 수 없으므로 실행기를 가리지 않고 모든 줄을 멈춘다(더 닫는 쪽).
4. **맡기지 않음은 인사가 줄에 들어온 때 세운다.** 처리기 결과의 `withhold`만 모으면 줄에서 기다리는 동안(복원 대기, 밀린 사본 뒤)에는 그 실행기가 빠지지 않아 장부가 그 점유를 모르는 채 시작이 적힐 수 있다.
5. **수명 박자 결과의 `pendingQueries`는 쓰지 않는다.** 내보내기 포트가 쓰기 전에 연결 번호와 함께 등록하므로(빠른 답보다 먼저) 결과를 받은 뒤 다시 더할 것이 없다. 연결 번호가 없는 그 목록을 더하면 어느 연결과도 맞지 않는 항목만 는다.
6. **답한 조회는 결과와 상관없이 끝낸다.** 실행기는 조회 하나에 한 번 답한다(`src/executor/worker.ts`의 `onStatus`). 대조되지 않은 답(`runs_mismatch` 등)도 그 조회의 답은 더 오지 않는다.
7. **실패한 답은 같은 처리 안에서 되풀이하지 않는다.** 다음 `pump()`나 그 실행기의 다음 답이 다시 넘긴다. 장부가 계속 실패해도 처리 하나가 끝난다.

## 이 모듈에 없는 것

자격 값 보내기의 잇기(`onReceipt`·`forgetConnection`), 종료 순서(발급 닫기 뒤 `server.close()`), 도구 어댑터, 감독 진입점(이 둘을 만들고 `deliver`·`pump`를 부르는 곳), 조회를 내는 일(수명 박자), 관측만 적는 운영 중 장부 연산, D-90의 닫기.

## 뒤 조각이 지켜야 할 것

- **N4a3(자격 값과 종료 순서): 영수증 결과 뒤에 `onReceipt(forward, outcome)`, `withdrawn`과 서버의 닫힘에 `forgetConnection(connection)`.** `passReceipt`가 `handleForward`의 결과를 얻은 그 자리에서 같은 `forward`와 결과를 그대로 넘긴다(`dispatch/credential-send.md` "뒤 조각이 지켜야 할 것"). `take`의 `withdrawn` 갈래에서 등록부 정리와 함께 부른다. 발급 닫기(`closeIssuance()`) 뒤에 `server.close()`를 부르고, 내보내기 포트와 자격 값 보내기의 `lastCheck`가 `issuanceOpen()`을 보게 한다(ack도 발급이다).
- **N5(진입점): 같은 객체를 넘긴다.** `ledger`·`results.ledger`는 박자들과 같은 장부 객체, `clock`은 공유 시계, `restorer`는 서버·내보내기 포트에 넘긴 그 게시 함수, `table`은 같은 서버의 `table`, `wire`는 같은 서버 위의 내보내기 포트, `queries`는 그 내보내기 포트에 넘긴 등록부다.
- **N5: 맡기지 않을 실행기 집합을 배정 박자와 내보내기 포트 양쪽에.** 내보내기 포트를 먼저 만들어야 답 줄이 `wire`를 받으므로, 내보내기 포트의 `withheld`에는 `{ executors: () => lines.withheld.executors() }`처럼 같은 답 줄에 위임하는 객체를 넘기고 배정 박자에는 `lines.withheld`를 넘긴다. 두 쪽이 같은 줄의 상태를 읽어야 한다.
- **N5: 서버의 `deliver`에 `lines.deliver`를, 박자마다 `lines.pump()`를.** 순서기에는 이 자리가 없다. 박자 직후(또는 서버 tick 뒤)에 부른다. 부르지 않으면 접수가 열린 뒤의 `held` 인사와 실패한 답이 그 실행기의 다음 답이 올 때까지 남는다.
- **N5: `observationsSettled`는 지금 복원기의 2단계가 성공한 뒤에만 참.** 장부를 다시 열고 다시 복원하면 새 복원기의 2단계가 끝날 때까지 거짓이다.
- **N5: 서버를 새로 시작하면 등록부·내보내기 포트·답 줄을 함께 새로 만든다.** 연결 번호가 1부터라 옛 줄의 밀린 사본을 새 서버의 연결로 물으면 다른 연결을 그 사본의 연결로 볼 수 있다. 옛 줄의 밀린 사본(`backlog`)은 새 줄로 옮기지 않는다. 그 "안다" 관측을 장부에 남기는 연산이 생길 때까지 그 실행은 D-90 자동 해제에서 빼야 한다(`dispatch/receipts.md` "남는 한계").
- **N5: `takeRequery()`의 실행을 다시 묻게 잇는다.** 지금은 수명 박자가 자기 간격(`answerTimeoutMs`)과 판단으로만 묻는다. 순서기의 `lastQueries`를 비우는 면은 없다.
- **N5: `observe`의 `fault`, 오래 막힌 밀린 사본을 관리자 경보로 잇는다.** 상한과 기준은 정하지 않았다.

## 남는 한계

- **인정이 끝난 연결의 "안다" 사본은 그 실행기의 뒤 답을 모두 막는다.** 새 연결의 인사도 그 뒤에 줄 서고(밀린 사본이 남은 동안 인사를 넘기지 않는다) 그 실행기는 맡기지 않을 실행기로 남는다. 관측만 적는 운영 중 장부 연산이 생길 때까지 남는다(루프백 시험이 이 상태를 단언한다). 처리기 문서의 "남는 한계"와 같은 뿌리다.
- **다시 조회(C23)는 일부만이다.** 답 줄은 다시 물을 실행을 낼 뿐이고, 실제 조회는 수명 박자가 그 실행을 조회 대상으로 판단하고 마지막 조회부터 `answerTimeoutMs`가 지났을 때 나간다.
- **답이 오지 않은 조회 항목은 그 연결이 철회될 때까지 남는다.** 실행기가 세대를 확정하기 전이면 답하지 않는다(`worker.ts`의 `onStatus`). 오래 사는 연결에서는 수명 박자의 조회 수만큼 는다.
- **뜻밖의 예외 뒤에는 그 객체가 끝날 때까지 맡기지 않을 실행기 집합이 `known: false`다.** 배정과 시작이 모두 멈춘다. 되살리는 길은 두지 않았다.
- **줄은 메모리에만 있다.** 감독이 다시 뜨면 쥔 답·밀린 사본·`retry`가 사라진다.
- **기록(`observe`)은 처리기의 결과 객체를 그대로 싣는다.** 실행 ID·상태가 들어 있다. 비밀은 없지만 기록하는 쪽이 밖으로 내보낼 때 거른다.
