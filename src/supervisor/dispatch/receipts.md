# 영수증·보고 처리기 (`receipts.ts`)

연결 판단(`src/supervisor/transport/connections.ts`)이 낸 `forward` 하나를 받아 장부 연산을 부르고, 그 결과로 ack 초안을 만들거나 만들지 않거나 구별된 거절을 낸다. 순수 판단이다: 소켓·타이머·시계·난수를 직접 쓰지 않는다. 장부와 난수는 포트로, 지금 시각과 감독의 정지 세대는 인자로 받는다. ack는 초안(`envelopes.ts`의 `ackDraft`)까지만 만들고, 봉하기(`sealDraft`)와 싣기는 부르는 순환이 한다. 입력 객체를 바꾸지 않는다.

## 보장 넷

이 모듈이 주장하는 것은 아래 넷뿐이다.

1. **낸 쪽과 세대는 검증 결과에서만 온다.** 장부에 넘기는 `from`은 검증된 봉투 머리의 `sender`와 `run_generation`이다. 본문의 값(본문이 주장하는 실행기 이름이나 세대)으로 대신하지 않는다. 낸 쪽이 받아들여지는지, 세대가 맞는지는 장부가 본다(`sender_mismatch`, `run_generation_mismatch`). 장부의 규칙은 이렇다: 일반 영수증·보고는 그 실행의 지정 실행기만 낼 수 있다. 세션 인수 영수증(`receipt_session_takeover`)은 앞 세션의 지정 실행기이거나 대기 중인 세션 실행의 지정 실행기가 낼 수 있고, 같은 인수의 재전송은 처음 낸 쪽만 ack를 받는다(`src/ledger/ledger.md` "세션 증거"). 인수의 ack는 인수 증거를 저장했다는 확인일 뿐이고, 앞 세션의 종료나 다음 세션의 시작을 허가하지 않는다. 이 모듈은 그 검사를 복사하지 않는다. ack의 받는 쪽도 같은 머리의 `sender`다.
2. **장부가 받은 것에만 ack.** 장부가 `ok`를 돌려준 영수증·보고에만, 장부가 돌려준 그 id로 ack 초안을 만든다. 장부가 거절했거나, 던졌거나, 답이 꼴에 맞지 않으면(`ok`인데 `delivery`가 `new`·`duplicate`가 아니거나 `ack`가 넘긴 id와 다름, 거절 사유가 장부의 `REFUSALS` 밖) ack가 없어 실행기가 다시 보낸다. 재전송은 장부가 `delivery: "duplicate"`(이미 반영함)로 받고, 그때 부르는 쪽이 감독의 정지 세대를 알고(`null`이 아님) `ackDraft`가 초안을 만들면 ack를 다시 만든다: 앞의 ack가 유실됐을 수 있다. 정지 세대가 계속 `null`이면 재전송에도 계속 ack가 없다. 한 `forward` 안에서 장부 호출이 먼저이고, `ackDraft`(난수 포트를 쓰는 유일한 자리)는 장부가 `ok`를 돌려준 뒤에만 불린다.
3. **`status_report`는 감독이 그 연결에 낸 조회의 답이고 지금 인정된 연결에서 왔을 때만 장부에 넘긴다.** 부르는 쪽이 넘긴 "답을 기다리는 조회" 목록에서 `in_reply_to`가 그 요청 ID인 것을 찾고, 그 조회를 받은 실행기(초안의 `recipient`)가 서명한 보고만 받는다. 답의 실행 ID 집합이 물은 실행 ID 집합과 같아야 하고, 답이 온 연결(`forward.connection`)이 그 조회를 실제로 실은 연결(항목의 `connection`)과 같아야 한다. 아니면 `status_unmatched`이고 장부를 부르지 않는다. 대조된 답은 **장부를 부를 때마다 그 직전에** 그 답이 온 연결이 지금도 낸 쪽의 인정된 연결인지 포트(`links`)에 묻고, 맞을 때만 장부의 `applyExecutorAnswer`에 `partial`로 넘긴다. 그 실행기의 밀린 답이 있으면 받은 순서대로 먼저 넘기고, 밀린 답마다 그 답이 온 연결을 같은 방식으로 본다(아래 "운영 중 상태 보고의 장부 반영").
4. **결과 보고는 아직 받지 않는다.** `report_result`는 결과 보관(S6) 뒤에만 장부의 `storedRef`·`resultDigest`를 채울 수 있다. 그래서 장부에 넘기지 않고 ack도 만들지 않으며 `result_not_supported_yet`을 낸다. 실행기는 ack가 없으니 같은 보고를 계속 다시 보낸다.

## 동작별 처리

계약 v1(`src/contract/v1.md` "영수증·보고", "전송")에서 받는 쪽이 감독인 동작 전부다. 시험이 `ACTION_SPECS`와 대조해 빠진 것도 남는 것도 없음을 지킨다(`EXECUTOR_ACTION_HANDLING`).

| 동작 | 내는 쪽 | 결과 본문 | 처리 | 장부 연산 | ack |
|---|---|---|---|---|---|
| `receipt_accepted` | 둘 다 | 없음 | `ledger_receipt` | `applyReceipt` | 장부가 `ok`일 때 |
| `receipt_started` | 둘 다 | 없음 | `ledger_receipt` | `applyReceipt` | 장부가 `ok`일 때 |
| `receipt_stopped` | 작업자 | 없음 | `ledger_receipt` | `applyReceipt` | 장부가 `ok`일 때 |
| `receipt_cleaned` | 작업자 | 없음 | `ledger_receipt` | `applyReceipt` | 장부가 `ok`일 때 |
| `receipt_session_takeover` | 세션(앞 세션 또는 대기 세션 실행의 지정 실행기, 재전송은 처음 낸 쪽) | 없음 | `ledger_receipt` | `applyReceipt` | 장부가 `ok`일 때. 인수 증거의 저장만 확인한다 |
| `report_session_broken` | 세션 | 없음 | `ledger_report` | `recordReport`(`signal`: 원인, 표식 digest, 관측 시각) | 장부가 `ok`일 때 |
| `report_hook_event` | 세션 | 없음 | `ledger_report` | `recordReport`(`signal`: 사건, `session_id`, 턴 ID = `prompt_id`, 오류 종류, 관측 시각) | 장부가 `ok`일 때 |
| `report_result` | 작업자 | **있음** | `result_not_supported_yet` | 부르지 않음 | 없음 |
| `report_rule_check` | 세션 | 없음 | 거절 `rule_check_not_supported` | 부르지 않음(`recordReport`가 받는 꼴이 아니다. 장부의 `applyRuleCheck`, 세션 계약의 몫) | 없음 |
| `status_report` | 둘 다 | 없음 | `status_reply` | 대조되고 연결이 맞을 때만 `applyExecutorAnswer`(`partial`) | 없음(상태 보고에는 id가 없고 실행기가 다시 보내지 않는다) |
| `hello`, `stop_sync_request` | 둘 다 | 없음 | 거절 `connection_layer` | 부르지 않음 | 없음 |
| 감독이 내는 동작(지시 여섯, `status_query`, `ack`, `stop_sync_reply`) | 감독 | | 거절 `not_executor_action` | 부르지 않음 | 없음 |
| 계약에 없는 이름 | | | 거절 `unknown_action` | 부르지 않음 | 없음 |

본문에서 읽는 칸의 타입이 틀리면 `rejected`·`body_malformed`(`field`에 칸 이름), `forward`·머리가 틀리면 `rejected`·`input_malformed`다. `now`는 장부에 쓸 동작(영수증 다섯, 훅·세션 깨짐 보고)과, `status_report`에서는 대조되고 연결이 맞아 장부를 부르기 직전에만 검사하고 틀리면 `input_malformed`다. 그래서 `now`가 틀려도 맞지 않은 상태 보고는 `status_unmatched`, 결과 보고는 `result_not_supported_yet`이다. `status_report`의 `forward.connection`은 요청 ID·실행기·실행 집합이 맞은 뒤 조회의 연결과 견주기 직전에 보고(안전 정수가 아니면 `input_malformed`·`forward.connection`), `backlog`(아래 "밀린 답". 틀리면 `input_malformed`·`backlog`)는 대조되고 연결이 맞은 뒤에만 본다. 어느 거절도 장부를 부르지 않는다. 본문 전체의 v1 형식 검사는 연결 판단이 이미 끝냈고, 이 모듈은 분기마다 필요한 칸만 읽는다. 예외를 던지지 않는다. 값의 꼴(UUID, digest 등)은 계약 검증과 장부가 다시 본다. 장부가 입력을 거부하며 던진 것(`LedgerInputError`)은 `ledger_failed`·`threw`다.

장부 입력으로 옮기지 않는 본문 칸: `started_at`, `stopped_at`, `remaining_processes`(계약이 0만 받는다), `cleaned_at`. 장부의 `ReceiptInput`에 그 칸이 없다. `bodyDigest`는 머리의 `body_digest`이고 `now`는 부르는 쪽이 넘긴 값이다.

## 공개 면

| 이름 | 꼴 |
|---|---|
| `handleForward(input, ports)` | `ForwardInput` → `ReceiptOutcome` |
| `replayBacklog(input, ports)` | `{ backlog, now, links }`, `{ ledger: Pick<ReceiptLedger, "applyExecutorAnswer"> }` → `backlog_settled`(`settled`, `backlog`) 또는 `rejected`(`input_malformed`, `field`: `backlog`·`now`). 새 답 없이 한 실행기의 밀린 답을 다시 넘긴다. 사본마다 장부 호출 직전에 `links`에 그 답의 연결을 묻는다 |
| `ForwardInput` | `forward`(연결의 `forward` 출력, `verified`와 `connection`을 읽음), `now`(장부 시계와 같은 시계), `stopGeneration`(감독의 지금 정지 세대, 모르면 `null`), `pendingQueries: SentQuery[]`, `links: AnswerLinks`, `backlog`(그 실행기의 밀린 답, 받은 순서) |
| `PendingQuery` | `requestId`, `recipient`, `runIds`. `statusQueryDraft`의 초안에서 그대로 옮긴다. 수명 박자(`life-loop.ts`)가 돌려주는 꼴이다 |
| `SentQuery` | `PendingQuery`와 `connection`(그 조회를 실제로 실은 연결). `pendingQueries`의 항목이다 |
| `AnswerLinks` | `current(connection, executorId): boolean`. 그 연결이 지금도 그 실행기의 인정된 연결인가. 동기. 장부 호출마다 그 직전에 불린다 |
| `ExecutorAnswerCopy` | `sender`, `connection`(그 답이 온 연결), `coverage: "partial"`, `runs`, `answeredAt`. `connection` 밖은 `applyExecutorAnswer`에 넘기는 값 그대로 |
| `AnswerSettlement` | 답 하나를 넘긴 결과: `applied`(`moved`, `deferred`, `outsideLedger`), `unsaved`(`reason`, `unsavedSightings`), `ledger_failed`(`threw`·`malformed_answer`), `not_current`(`link`: `not_current`·`unknown`. 넘기기 직전에 본 그 답의 연결이 인정된 연결이 아니거나 모름, 장부를 부르지 않음), `held`(앞의 밀린 답 때문에 넘기지 않음). 모두 `answer`(그 사본)를 싣는다 |
| `ReceiptPorts` | `ledger: ReceiptLedger`, `random: Random`(`ports.ts`) |
| `ReceiptLedger` | `Pick<Ledger, "applyReceipt" \| "recordReport" \| "applyExecutorAnswer">`. 실제 장부가 그대로 맞는다 |
| `EXECUTOR_ACTION_HANDLING` | 위 표의 동작 → 처리 |
| `REJECT_REASONS`, `STATUS_UNMATCHED_REASONS` | 구별된 거절의 이름 |

`ReceiptOutcome`:

| `outcome` | 뜻 | ack 초안 |
|---|---|---|
| `ack` | 장부가 받았다(`delivery`: `new` 이번에 반영, `duplicate` 이미 반영) | 있음(`ack`) |
| `applied_without_ack` | 장부는 받았지만 ack 초안을 만들지 못했다(`stop_generation_unknown`, `ackDraft`의 거절 사유, `draft_threw`). 실행기가 다시 보내면 장부가 `duplicate`로 받고, 그때 정지 세대를 알고 초안 생성에 성공하면 ack한다 | 없음 |
| `ledger_refused` | 장부의 거절 사유 그대로 | 없음 |
| `ledger_failed` | 장부가 던졌다(`threw`) 또는 답이 꼴에 맞지 않는다(`malformed_answer`) | 없음 |
| `status_matched` | 기다리는 조회의 답이고 지금 인정된 연결에서 왔다. `queryRequestId`, `executor`, `connection`, `settled`(밀린 답 → 이번 답, 받은 순서. 마지막이 이번 답. 넘기는 동안 연결의 인정이 끝난 답은 `not_current`), `backlog`(다음에 그 실행기의 어떤 답보다 먼저 넘길 답) | 없음 |
| `status_not_current` | 기다리는 조회의 답이지만 그 연결이 지금 인정된 연결이 아니거나(`link: "not_current"`) 그것을 모른다(`unknown`: 포트가 던지거나 `true`·`false` 밖의 답). 장부에 넘기지 않았다. `answer`에 그 답의 사본을 싣는다 | 없음 |
| `status_unmatched` | `unknown_query`, `other_executor`, `runs_mismatch`, `other_connection`(그 조회를 실은 연결이 아닌 연결에서 옴. 항목의 연결 번호가 없거나 꼴이 틀려도 이것). 장부를 부르지 않았다 | 없음 |
| `result_not_supported_yet` | 결과 보고. 장부에 넘기지 않았다 | 없음 |
| `rejected` | 위 표의 거절과 꼴 거절 | 없음 |

## 운영 중 상태 보고의 장부 반영

대조된 답은 장부의 `applyExecutorAnswer({ coverage: "partial", runs, answeredAt, now }, { sender })`로 넘긴다(`src/ledger/ledger.md` "쓰기 규칙"의 "실행기의 답"). 장부는 끝났다·모른다는 답이면 `preparing`·`running`을 `unknown_running`으로 옮겨 믿던 임대를 거두고(D-89), "안다"는 답은 첫 양성 관측으로 남기며, 시작이 아직 닿을 수 있는 동안의 `not_known`은 보류(`deferred`)한다. 자리는 어떤 답으로도 풀지 않고 `unknown_running`을 되살리지 않는다(D-92). 이 처리기도 자리를 풀거나 조회를 내지 않는다. 다시 물을 실행은 결과로 알릴 뿐이다.

- **넘기는 값은 검증된 봉투의 것이다.** `sender`는 머리의 낸 쪽, `runs`는 검증된 본문의 `runs`(사본), `answeredAt`은 머리의 `issued_at`(실행기 시계)이다. `issued_at`이 안전 정수 1 이상이 아닐 때만 `null`이고 감독이 받은 시각으로 대신하지 않는다(장부는 `null`이면 `not_known`으로 임대를 거두지 않는다). `coverage`는 늘 `partial`이다. `full`로 넘기는 길이 이 모듈에 없다(뒤 조각이 `full`을 "그 실행기가 쥔 전부"로 읽는다). `now`는 부르는 쪽이 넘긴 장부 시계의 값이다.
- **장부의 답은 그대로 싣는다.** `applied`는 `moved`(옮긴 실행), `deferred`(보류: 같은 실행 ID를 다시 조회한다), `outsideLedger`(장부 밖: 닫을 대상, 세대는 닫는 지시에만 쓴다)를 따로 싣는다. `unsaved`는 장부의 `reason`과 `unsavedSightings`를 그대로 싣고 반영된 것으로 세지 않는다. 장부가 던지면 `ledger_failed`·`threw`, 답이 약속한 꼴(배열과 항목의 `runId`·`runGeneration` 등, 거절 사유는 장부의 `REFUSALS`)이 아니면 `malformed_answer`다. 보류 항목은 끝까지 본다: 사유가 장부가 정한 두 값(`start_may_arrive`, `answer_time_unknown`), 상태가 장부의 실행 상태(`LEDGER_RUN_STATES`), 세대가 1 이상일 때만 성공으로 센다. 아니면 `malformed_answer`이고 "안다"는 항목이 있으면 그 답은 밀린 답으로 남는다(꼴이 틀린 보류를 성공으로 세면 사본을 버리고도 반영된 것으로 보인다). 예외를 밖으로 내지 않는다.
- **`not_known`은 종료의 증거가 아니고, 상태 보고에는 실행기의 임대 끝이 없다.** 그래서 이 답으로 자리를 풀거나 갱신의 근거로 쓰지 않는다.

### 옛 연결의 답

연결 판단은 인정된(`greeted`) 연결의 `status_report`만 `forward`로 낸다. 그러나 장부 인자에는 연결이 없어서, 두 가지를 이 처리기가 막는다.

- **조회를 실은 연결.** 같은 주체의 새 연결이 옛 연결에 낸 조회의 요청 ID로 답하면, 답이 온 연결은 지금 인정된 연결이어도 그 조회의 답이 아니다(그 답으로 임대를 거두면 D-92에 따라 되살리지 못한다). 그래서 기다리는 조회의 항목(`SentQuery`)은 그 조회를 실제로 실은 연결의 번호를 갖고, 처리기는 그 번호와 `forward.connection`을 직접 견준다. 다르면 `status_unmatched`(`other_connection`)이고 장부를 부르지 않는다. 연결 번호가 없거나 꼴이 틀린 항목은 어느 연결과도 맞지 않는다. 같은 초안을 다른 연결로 다시 실어 같은 요청 ID의 항목이 여럿이면 답이 온 연결의 항목과 대조한다.
- **장부를 부르는 순간의 연결.** `forward`가 처리기에 닿기 전에 같은 주체의 새 연결이 앞 연결을 밀어내거나 연결이 닫힐 수 있고, 같은 동기 구간의 앞선 장부 쓰기가 실패하며 복원기의 세대를 지워 그 연결의 인정을 끝낼 수도 있다(await가 없어도 바뀐다). 그래서 **장부를 부를 때마다 그 직전에** `links.current(그 답의 connection, sender)`에 묻는다. 이번 답은 밀린 답을 넘기기 전에 한 번 더 본다: `false`면 `status_not_current`(`not_current`), 던지거나 그 밖의 답이면 `status_not_current`(`unknown`)이고 밀린 답도 넘기지 않는다. 넘기는 루프 안에서 `true`가 아니게 된 답은 `not_current` 결과(`link`)이고 장부를 부르지 않는다(아래 "밀린 답").

이 모듈은 연결 표를 직접 보지 않는다. 포트를 고른 이유: 값 칸(예: "지금 연결 번호")은 입력을 만든 때의 사실이라 장부를 부르는 순간의 사실이 아니다. 동기 포트는 장부 호출과 같은 동기 구간에서 답한다.

`status_not_current`는 그 답의 사본(`answer`)을 싣는다. 그 답의 양성 항목은 받을 때 유효했지만, 장부에는 임대를 건드리지 않고 관측만 적는 운영 중 연산이 없어(`recordRunSightings`는 복원 열쇠가 있어야 한다) 이 처리기는 적지 않는다. 부르는 쪽은 같은 실행을 지금의 연결로 다시 조회한다(다시 조회로 얻는 것은 아래 "다시 조회로 얻는 것").

### 밀린 답

상태 보고는 실행기가 다시 보내지 않으므로, 장부가 저장을 확인하지 않은 답(`unsaved`, `ledger_failed`)이나 넘기기 직전에 연결의 인정이 끝난 답(`not_current`)에 `not_known` 밖 항목이 있으면 그 답의 사본(`ExecutorAnswerCopy`)이 유일한 사본이다. 처리기는 그 답부터 뒤의 답 전부를 결과의 `backlog`(받은 순서)로 돌려준다. 사본은 그 답이 온 연결의 번호(`connection`)를 갖는다. 부르는 쪽은 그 목록을 그 실행기의 다음 `status_report`의 `backlog`로 넘기거나, 새 답 없이 `replayBacklog`로 다시 넘긴다.

- **받은 순서대로 넘긴다.** `backlog`를 이번 답보다 먼저 같은 값(`coverage`·`runs`·`answeredAt`·`sender`)으로 넘긴다. 앞 답이 또 저장되지 않으면 뒤 답은 장부에 넘기지 않고(`held`) 그 뒤에 줄 세운다. 그래서 "안다"는 앞 답이 그 실행을 빼먹은 뒤 답에 묻히지 않는다.
- **다시 넘겨도 해가 없다.** 장부는 (실행, 실행기, 세대)의 첫 관측만 적고, 이미 옮긴 실행은 다시 옮기지 않는다. `ledger_failed`의 답은 적혔는지 모르지만 같은 이유로 다시 넘긴다.
- **`not_known`만 실은 답의 실패는 남기지 않는다.** 붙들 관측이 없다. 그 답으로 거두려던 임대는 그대로 남는다(아래 "다시 조회로 얻는 것").
- **장부 호출마다 그 직전에 그 답의 연결을 다시 본다.** `handleForward`가 밀린 목록을 넘기는 루프와 `replayBacklog` 양쪽에서, 사본 하나를 넘기기 직전마다 `links.current(사본의 connection, sender)`에 묻는다. 받을 때 맞았던 연결도 그 뒤 닫혔을 수 있고, 같은 루프의 앞선 장부 쓰기가 실패하며 그 연결의 인정을 끝낼 수 있다. `true`가 아니면 그 답으로 장부를 부르지 않고 `not_current`(`link`)이며, "안다"는 항목이 든 사본은 버리지 않고 `backlog`에 그대로 남긴다(뒤 답은 `held`). `not_known`만 실은 사본은 남기지 않는다.
- **인정이 끝난 연결의 "안다"는 사본은 그 실행기의 뒤 답을 막는다.** 그 사본은 다시 넘겨도 늘 `not_current`다(연결은 다시 인정되지 않는다). 관측만 적는 운영 중 장부 연산이 생길 때까지 부르는 쪽이 쥐고, 그동안 그 실행기의 뒤 답은 모두 그 뒤에 줄 선다. 막힌 쪽은 닫는 쪽이다: 뒤 답이 끝났다·모른다고 해도 임대를 거두지 못하고 장부는 갱신을 계속 믿으며, 자리는 풀리지 않는다.
- **`backlog`의 꼴은 다시 본다.** 그 실행기(`sender`)의 사본이고 `connection`이 안전 정수, `coverage`가 `partial`이며 `runs`가 배열(항목마다 `run_id`)이고 `answeredAt`이 시각 또는 `null`이어야 한다. 아니면 장부를 부르지 않고 `input_malformed`·`backlog`다. 항목의 나머지 꼴은 장부가 본다.

### 다시 조회로 얻는 것

`deferred`, 실패, `status_not_current`, `not_current`의 실행은 같은 실행 ID로 다시 조회한다. 다시 조회로 얻는 것은 **새 답의 내용**이다. 앞서 들은 답을 되살리지 않는다.

- **앞서 들은 "안다"는 사실은 되살아나지 않는다.** 앞 답이 `running`이었어도 새 답이 `not_known`이면 관측은 0행이다. 앞 답의 관측은 그 사본을 넘겨 저장해야만 남는다.
- **앞서 실패한 임대 거두기가 다시 조회로 일어나는 것이 아니다.** 저장하지 못한 늦은 `not_known`이나 종료 답 뒤에 다시 물어 새 답이 `running`이면 임대는 거둬지지 않는다. 새 답이 늦은 `not_known`이거나 종료 답일 때만 거둬진다. 답을 받지 못하면 언제 거둬질지 상한이 없다(자리는 풀리지 않는 쪽이다).

## 정한 것

- **ack의 정지 세대는 감독의 값이다.** 머리의 `stop_generation`이 아니라 부르는 쪽이 넘긴 감독의 지금 정지 세대(복원기의 `stopGeneration()`)를 싣는다. 모르면(`null`) 장부는 반영하고 ack는 만들지 않는다(종료·영수증의 기록은 막지 않는다, `ledger.md` "못 씀"). 실행기가 다시 보내면 장부가 `duplicate`로 받고, 그때 정지 세대를 알고 초안 생성에 성공하면 ack한다.
- **장부의 ack id가 넘긴 id와 다르면 꼴이 틀린 답이다.** 다른 id의 ack는 다른 영수증의 재전송을 멈추게 한다.
- **영수증 하나에 ack 초안 하나.** 여러 id를 한 ack에 모으는 일은 하지 않는다.
- **옛 연결의 답은 조회 항목의 연결 번호와 포트로 막는다.** 위 "옛 연결의 답". 조회를 실은 연결은 항목의 값으로 견주고(그 사실은 싣는 순간에 정해지고 바뀌지 않는다), 연결이 지금 인정됐는지는 장부 호출마다 포트에 묻는다. 포트가 모르면 넘기지 않는다.
- **`PendingQuery`는 그대로 두고 연결 번호를 가진 `SentQuery`를 따로 둔다.** 수명 박자(`life-loop.ts`)는 내보내기 포트가 어느 연결에 실었는지 모르므로 `PendingQuery`를 돌려준다. `pendingQueries`가 `SentQuery`만 받아, 연결 번호를 더하지 않은 목록은 타입 검사에서 걸린다.
- **인정이 끝난 연결의 "안다"는 사본은 버리지 않는다.** 버리면 장부에 흔적이 없어 뒤 조각(D-90)이 "안다고 한 적 없음"으로 잘못 읽을 수 있다. 그 대가로 그 실행기의 뒤 답이 막힌다(위 "밀린 답").
- **밀린 답은 입력으로 받고, 새 답 없는 재시도는 `replayBacklog` 하나로 한다.** 순서를 부르는 쪽의 규율에만 맡기지 않으려고 `handleForward`가 밀린 답을 이번 답 앞에 넘긴다.
- **상태 보고는 실행 ID 집합까지 대조한다.** 실행기는 물은 실행 ID마다 하나씩 답한다(`src/executor/worker.ts`의 `onStatus`). 다른 집합이면 그 조회의 답으로 보지 않는다.
- **`report_rule_check`는 받지 않는다.** 장부의 `recordReport`가 받는 꼴이 아니고(`applyRuleCheck`, `from`도 낸 쪽 이름 하나뿐), 그 증거를 쓰는 세션 계약 작업이 아직 없다. 지금 연결 판단은 작업자 실행기의 맞춤 요청만 받는다(`connections.ts`의 `syncRequest`).
- **본문의 남는 칸은 읽지 않는다.** v1의 본문 해석이 모르는 칸을 이미 거절한다. 이 모듈은 읽는 칸의 타입만 본다.

## 이 모듈에 없는 것

순환(언제 부르고 결과를 어디로 보내는가), 소켓과 ack의 봉하기·싣기, 기다리는 조회 목록의 보관과 만료, 조회 항목에 실은 연결의 번호를 붙이는 일, 밀린 답의 보관, 다시 조회하기(이 처리기는 조회를 내지 않는다), `links` 포트의 구현, 운영 중 `hello`의 `full` 답, 자리를 푸는 판단(D-90), 옛 연결 답의 양성 관측 기록, 결과 보관(S6)과 결과 보고의 반영, 규칙 확인의 반영.

## 남는 한계

- **인정이 끝난 연결에서 받은 "안다"는 항목은 장부에 적지 못한다.** 장부에 임대를 건드리지 않고 관측만 적는 운영 중 연산이 없다. `status_not_current`의 답과 `not_current`로 남은 사본이 그렇다. 사본을 쥐는 동안 그 실행기의 뒤 답은 막히고(임대를 거두지 못한다), 프로세스가 다시 뜨거나 부르는 쪽이 사본을 놓으면 그 관측은 장부에 흔적이 없다. 그러면 뒤 조각(D-90)이 그 실행을 "안다고 한 적 없음"으로 잘못 읽을 수 있다. 관측만 적는 연산이 생기거나, D-90이 이 공백을 걸친 실행을 자동 해제에서 빼야 닫힌다.
- **밀린 답은 그 프로세스의 메모리에만 있다.** 재시작하면 사라지고 장부에 흔적이 없다(`ledger.md`의 "0행의 뜻(함정)").
- **막힘에 상한이 없다.** 앞 답이 계속 저장되지 않거나 인정이 끝난 연결의 "안다"는 사본이 남아 있으면 그 실행기의 뒤 답은 무기한 `held`다. 상한과 경보는 정하지 않았다.
- **`not_known`만 실은 답을 저장하지 못하면 그 임대 거두기는 다시 조회의 새 답에 달린다.** 위 "다시 조회로 얻는 것".

## 뒤 조각이 지킬 것

- **`status_report`의 `forward`를 이 처리기로 넘긴다.** 연결 판단은 인정된 연결의 검증된 `status_report`를 점유 응답(`occupancy`, `partial`, `in_reply_to` 없음)과 `forward`(검증된 봉투 그대로, 연결 번호 함께)로 함께 낸다(`connections.ts`의 `envelope`). 대조와 장부 반영은 `forward`로만 한다. 점유 응답의 `partial` 행을 따로 `applyExecutorAnswer`에 넘기지 않는다(같은 답을 두 번 넘기게 되고, 그 행에는 대조할 `in_reply_to`도 서명 시각도 없다).
- **조회는 싣는 연결에 등록한다.** 기다리는 조회(`SentQuery`)는 `statusQueryDraft`의 초안에서 `requestId`·`recipient`·`body.run_ids`를 그대로 옮기고, 그 봉투를 **실제로 실은 연결의 번호**를 `connection`에 넣는다. 수명 박자가 돌려주는 `pendingQueries`(`PendingQuery`)에는 연결 번호가 없으므로, 어느 연결에 실었는지 아는 내보내기 포트(조립)가 붙인다. 조회의 답은 박자가 결과를 돌려주기 전에 올 수 있으므로 빠른 답보다 먼저(싣기 직전에) 등록하거나, 등록될 때까지 그 답을 보관한다(`life-loop.md` "뒤 조각이 지켜야 할 것"). 같은 초안을 다른 연결로 다시 실으면 그 연결의 항목을 따로 더한다. 연결이 철회·교체되면 그 연결의 대기 항목을 끝낸다. 같은 초안을 다시 봉해 보내면 실행기가 매번 답하므로 같은 `in_reply_to`의 답이 여럿 올 수 있다. 목록에서 언제 지울지는 순환이 정한다.
- **`links`를 지금의 연결 표로 잇는다.** 부르는 순간에 쥔 `Connections`와 지금의 복원기로, 그 연결이 `candidates(복원기)`에 있고 그 연결의 맞춤 주체(`sync.principal`)가 그 실행기 이름일 때만 `true`를 답한다. 동기로 답한다. 처리기는 상태를 바꿀 수 있는 장부 호출마다 그 직전에 묻으므로, 그 답은 묻는 순간의 사실이어야 한다(앞선 장부 쓰기가 복원기의 세대를 바꿨으면 그것까지 반영한다). 값을 미리 읽어 캐시하지 않는다.
- **한 실행기의 답은 받은 순서대로 처리한다.** 같은 실행기의 `forward`를 받은 순서대로 이 처리기에 넘기고, 그 사이에 같은 실행기의 다른 답(운영 중 `hello`의 `full` 포함)을 장부에 먼저 넘기지 않는다. `partial`과 인사의 `full`이 서로 추월하지 않게 한다. `partial`은 검증된 `forward`에서 한 번만 넘긴다. 결과의 `backlog`는 그 실행기의 이름에 묶어 쥐고, 다음 `status_report`의 `backlog`로 넘기거나 `replayBacklog`로 다시 넘긴다. `status_matched`·`backlog_settled`의 `backlog`만 쥔 목록을 대신한다(넘겨서 끝난 앞부분만 빠진다). `status_not_current`·`status_unmatched`·`rejected`에는 `backlog`가 없으므로 쥐고 있던 목록을 그대로 둔다(빈 목록으로 덮지 않는다). `backlog`가 비어 있지 않은 동안 그 실행기의 다른 답(인사의 `full` 답 등)을 장부에 넘기는 쪽도 그 뒤에 넘긴다.
- **밀린 "안다"는 사본은 저장될 때까지 쥔다.** 밀린 답은 그 프로세스의 메모리에만 있다. 연결이 철회되거나 실행이 끝났다는 이유만으로 버리지 않는다. 철회된 연결의 사본은 처리기가 임대 변경에 쓰지 않으므로(`not_current`), 그 관측을 임대와 따로 남기는 연산은 장부 작업의 몫이다. 그 전까지 그 실행기의 새 답은 뒤에 줄 서므로(`held`) 임대를 거두지 못하고 장부는 갱신을 계속 믿는다(자리는 풀리지 않는 쪽이다). 오래 막히면 경보한다(상한과 경보 기준은 뒤 결정이다). 재시작·복원 실패 등으로 사본을 잃어 증거가 끊긴 실행은 D-90에서 자동 해제하지 않는다(`ledger.md`의 "0행의 뜻(함정)").
- **`deferred`·실패·`status_not_current`·`not_current`면 같은 실행 ID로 다시 묻는다.** 실패(`unsaved`, `ledger_failed`)로 넘기지 못한 답의 실행도 같다. 새 답의 서명된 `issued_at`으로 다시 판단한다(위 "다시 조회로 얻는 것": 앞 답을 되살리지 않는다). 부정 답, `outsideLedger`, 부분 목록만으로 자리를 풀지 않는다. 조회는 수명 순환(`life-loop.ts`)이 내고, 이 처리기는 내지 않는다.
- **복원이 붙든 관측이 운영의 답보다 먼저다.** 재시작 복원 2단계가 적지 못한 관측을 복원기가 붙들고 있는 동안(2단계 재시도 전) 그 실행기의 운영 중 답을 이 처리기로 장부에 넘기지 않는다. 복원의 재시도가 같은 실행기의 운영의 더 새 답보다 먼저 적혀야 앞 관측이 뒤 답에 묻히지 않는다.
- **D-90은 닫는 트랜잭션에서 증거를 다시 본다.** 지정 실행기·세대, 영수증·보고, 빠짐없는 양성 관측 이력(위 공백을 걸친 실행은 빼고), 시작 재전송 중단, 마지막 시작 봉투의 시한이 지난 뒤의 지금 전체 점유 답에서 빠졌음을 함께 확인한다(`ledger.md` "D-90의 닫기"). D-91의 관리자 판단 대상과 D-92의 갱신 금지(옮긴 실행을 되살리지 않는다)를 지킨다.
- **`src/ledger/ledger.md`의 "부르는 코드가 없다"는 두 문장(상태 조회 줄의 **미확인**, "실행기의 답을 넘기는 쪽"의 첫 문장)은 이제 낡았다.** 이 처리기가 대조된 조회의 답을 넘긴다. 장부 문서를 고치는 쪽이 맞춘다.
- **`status_not_current`의 답은 버리지 않는다.** 그 답의 양성 항목을 장부에 적는 연산(임대를 건드리지 않는 운영 중 관측 기록)은 장부 작업의 몫이다. 그 전까지 같은 실행을 지금의 연결로 다시 물으면 새 답의 내용만 남는다(새 답이 `not_known`이면 관측은 0행이다). 앞 답의 "안다"는 사실은 위 "남는 한계"의 공백으로 남는다.
- **ack는 장부가 받은 것만 싣는다.** `ack` 결과의 초안만 봉해서 보낸다. `applied_without_ack`·`ledger_refused`·`ledger_failed`에 대해 ack를 따로 만들지 않는다. ack는 재전송을 멈추라는 뜻일 뿐이고 종료·정리·실행 허가가 아니다.
- **`now`와 정지 세대는 장부와 같은 시계·같은 복원기에서 읽는다.** 정지 세대는 이 처리기를 부르는 순간의 값이다. 연결 판단이 봉투를 받아들인 때의 값을 다시 쓰지 않는다.
- **결과 보고(S6):** 보관 → `recordReport`(`storedRef`·`resultDigest`) → ack 순서이고 그 사이에 await가 없어야 한다. 그때 이 표의 `report_result` 줄이 바뀐다.
- **장부 반영의 결과로 생기는 일(갱신 발급, 결과 검사, 세션 교체, 훅 사건의 처리)은 이 처리기가 하지 않는다.** 시작의 접수 영수증을 장부가 받은 뒤에만 갱신을 발급하는 조건(`ledger.md` "스케줄러")은 순환이 장부를 다시 읽어 지킨다. D-89에 따라 감독은 갱신한 임대를 반대 증거가 없으면 믿으므로, 종료 영수증이 이 처리기를 거쳐 장부에 닿아야 그 믿음이 끝난다.
