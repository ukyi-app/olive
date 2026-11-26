# 영수증·보고 처리기 (`receipts.ts`)

연결 판단(`src/supervisor/transport/connections.ts`)이 낸 `forward` 하나를 받아 장부 연산을 부르고, 그 결과로 ack 초안을 만들거나 만들지 않거나 구별된 거절을 낸다. 순수 판단이다: 소켓·타이머·시계·난수를 직접 쓰지 않는다. 장부·결과 보관소의 백엔드·난수는 포트로, 지금 시각과 감독의 정지 세대는 인자로 받는다. ack는 초안(`envelopes.ts`의 `ackDraft`)까지만 만들고, 봉하기(`sealDraft`)와 싣기는 부르는 순환이 한다. 입력 객체를 바꾸지 않는다.

## 보장 넷

이 모듈이 주장하는 것은 아래 넷뿐이다.

1. **낸 쪽과 세대는 검증 결과에서만 온다.** 장부에 넘기는 `from`은 검증된 봉투 머리의 `sender`와 `run_generation`이다. 본문의 값(본문이 주장하는 실행기 이름이나 세대)으로 대신하지 않는다. 낸 쪽이 받아들여지는지, 세대가 맞는지는 장부가 본다(`sender_mismatch`, `run_generation_mismatch`). 장부의 규칙은 이렇다: 일반 영수증·보고는 그 실행의 지정 실행기만 낼 수 있다. 세션 인수 영수증(`receipt_session_takeover`)은 앞 세션의 지정 실행기이거나 대기 중인 세션 실행의 지정 실행기가 낼 수 있고, 같은 인수의 재전송은 처음 낸 쪽만 ack를 받는다(`src/ledger/ledger.md` "세션 증거"). 인수의 ack는 인수 증거를 저장했다는 확인일 뿐이고, 앞 세션의 종료나 다음 세션의 시작을 허가하지 않는다. 영수증과 다른 보고에서 이 모듈은 그 검사를 복사하지 않는다. 결과 보고만 보관 전에 장부의 읽기로 같은 것을 먼저 보고(본문을 맡지 않으려고), 장부가 기록할 때 다시 본다. ack의 받는 쪽도 같은 머리의 `sender`다.
2. **장부가 받은 것에만 ack.** 장부가 `ok`를 돌려준 영수증·보고에만, 장부가 돌려준 그 id로 ack 초안을 만든다. 장부가 거절했거나, 던졌거나, 답이 꼴에 맞지 않으면(`ok`인데 `delivery`가 `new`·`duplicate`가 아니거나 `ack`가 넘긴 id와 다름, 거절 사유가 장부의 `REFUSALS` 밖, 답의 칸을 읽다 던짐) ack가 없어 실행기가 다시 보낸다. 답의 칸(`ok`·`delivery`·`ack`·`reason`)은 예외 경계 안에서 한 번씩만 읽어 그 지역 값으로만 판단하고, 읽다 던진 예외의 문구는 결과에 싣지 않는다(고정 사유 `malformed_answer`). 판정은 첫 읽기의 값으로 한다. 장부의 답이 읽을 때마다 같으면, 칸을 한 번씩 읽어도 칸을 다시 읽는 구현과 ack가 만들어지는 경우가 같다. 읽을 때마다 다른 값을 내는 답(접근자. 첫 읽기가 `duplicate`이고 다음 읽기가 다른 값이거나 던짐)에서는 첫 읽기의 값을 따르므로, 칸을 다시 읽는 구현에서는 없을 `duplicate` ack가 만들어질 수 있다. 그때도 장부의 줄은 그대로다. 실제 장부의 답은 평범한 값 객체라 읽을 때마다 같다. 이 경계는 영수증·보고·결과 보고가 함께 지나는 `settle`에 있다. 재전송은 장부가 `delivery: "duplicate"`(이미 반영함)로 받고, 그때 부르는 쪽이 감독의 정지 세대를 알고(`null`이 아님) `ackDraft`가 초안을 만들면 ack를 다시 만든다: 앞의 ack가 유실됐을 수 있다. 정지 세대가 계속 `null`이면 재전송에도 계속 ack가 없다. 한 `forward` 안에서 장부 호출이 먼저이고, `ackDraft`(난수 포트를 쓰는 유일한 자리)는 장부가 `ok`를 돌려준 뒤에만 불린다.
3. **`status_report`는 감독이 그 연결에 낸 조회의 답이고 지금 인정된 연결에서 왔을 때만 장부의 `applyExecutorAnswer`에 넘긴다.** 부르는 쪽이 넘긴 "답을 기다리는 조회" 목록에서 `in_reply_to`가 그 요청 ID인 것을 찾고, 그 조회를 받은 실행기(초안의 `recipient`)가 서명한 보고만 받는다. 답의 실행 ID 집합이 물은 실행 ID 집합과 같아야 하고, 답이 온 연결(`forward.connection`)이 그 조회를 실제로 실은 연결(항목의 `connection`)과 같아야 한다. 아니면 `status_unmatched`이고 장부를 부르지 않는다. 대조된 답은 **장부를 부를 때마다 그 직전에** 그 답이 온 연결이 지금도 낸 쪽의 인정된 연결인지 포트(`links`)에 묻고, 맞을 때만 장부의 `applyExecutorAnswer`에 `partial`로 넘긴다. 그 실행기의 밀린 답이 있으면 받은 순서대로 먼저 넘기고, 밀린 답마다 그 답이 온 연결을 같은 방식으로 본다(아래 "운영 중 상태 보고의 장부 반영"). 대조됐지만 인정이 끝난 연결의 답은 임대를 바꾸지 않고 "안다"는 항목만 관측으로 적는다(아래 "인정이 끝난 연결의 답: 관측만 적기").
4. **결과 보고는 보관 → 장부 → ack이고 그 사이에 `await`가 없다.** `report_result`는 장부의 읽기로 먼저 거르고, 결과 보관소의 판단(`src/supervisor/scheduler/result-store.ts`의 `storeResult`)이 참조를 낸 뒤에만 그 참조와 결과 digest로 `recordReport`를 부르고, 장부가 받은 뒤에만 ack 초안을 만든다. 처리기 전체가 동기 함수다(아래 "결과 보고"). 보관이 모름이거나 거절이거나 장부가 받지 않으면 ack가 없다.

## 동작별 처리

계약 v1(`src/contract/v1.md` "영수증·보고", "전송")에서 받는 쪽이 감독인 동작 전부다. 시험이 `ACTION_SPECS`와 대조해 빠진 것도 남는 것도 없음을 지킨다(`EXECUTOR_ACTION_HANDLING`).

| 동작 | 내는 쪽 | 결과 본문 | 처리 | 장부 연산 | ack |
|---|---|---|---|---|---|
| `receipt_accepted` | 둘 다 | 없음 | `ledger_receipt` | `applyReceipt` | 장부가 `ok`일 때 |
| `receipt_started` | 둘 다 | 없음 | `ledger_receipt` | `applyReceipt` | 장부가 `ok`일 때 |
| `receipt_stopped` | 작업자 | 없음 | `ledger_receipt` | `applyReceipt` | 장부가 `ok`일 때 |
| `receipt_cleaned` | 작업자 | 없음 | `ledger_receipt` | `applyReceipt` | 장부가 `ok`일 때. 이미 정리가 확정된 실행에 온 다른 id의 유효한 정리 영수증(정지 세대를 건너 확정을 다시 낸 실행에서 확정 요청마다 하나)도 장부가 받은 기록만 남기고 `new`로 답해 ack한다(`src/ledger/ledger.md` "증거") |
| `receipt_session_takeover` | 세션(앞 세션 또는 대기 세션 실행의 지정 실행기, 재전송은 처음 낸 쪽) | 없음 | `ledger_receipt` | `applyReceipt` | 장부가 `ok`일 때. 인수 증거의 저장만 확인한다 |
| `report_session_broken` | 세션 | 없음 | `ledger_report` | `recordReport`(`signal`: 원인, 표식 digest, 관측 시각) | 장부가 `ok`일 때 |
| `report_hook_event` | 세션 | 없음 | `ledger_report` | `recordReport`(`signal`: 사건, `session_id`, 턴 ID = `prompt_id`, 오류 종류, 관측 시각) | 장부가 `ok`일 때 |
| `report_result` | 작업자 | **있음** | `ledger_result` | `getRun`(실행이 `not_started`면 `instructionTimes`도)으로 거른 뒤, 보관소가 참조를 낸 때만 `recordReport`(`storedRef`: 보관 참조, `resultDigest`: 결과 digest, `signal`: `null`) | 장부가 `ok`일 때 |
| `report_rule_check` | 세션 | 없음 | 거절 `rule_check_not_supported` | 부르지 않음(`recordReport`가 받는 꼴이 아니다. 장부의 `applyRuleCheck`, 세션 계약의 몫) | 없음 |
| `status_report` | 둘 다 | 없음 | `status_reply` | 대조되고 연결이 맞을 때만 `applyExecutorAnswer`(`partial`) | 없음(상태 보고에는 id가 없고 실행기가 다시 보내지 않는다) |
| `hello`, `stop_sync_request` | 둘 다 | 없음 | 거절 `connection_layer` | 부르지 않음 | 없음 |
| 감독이 내는 동작(지시 여섯, `status_query`, `ack`, `stop_sync_reply`) | 감독 | | 거절 `not_executor_action` | 부르지 않음 | 없음 |
| 계약에 없는 이름 | | | 거절 `unknown_action` | 부르지 않음 | 없음 |

본문에서 읽는 칸의 타입이 틀리면 `rejected`·`body_malformed`(`field`에 칸 이름), `forward`·머리가 틀리면 `rejected`·`input_malformed`다. `now`는 장부에 쓸 동작(영수증 다섯, 훅·세션 깨짐 보고, 결과 보고)과, `status_report`에서는 대조되고 연결이 맞아 장부를 부르기 직전에만 검사하고 틀리면 `input_malformed`다. 그래서 `now`가 틀려도 맞지 않은 상태 보고는 `status_unmatched`다. 결과 보고는 `report_id`·`run_id`·`result`(객체) 다음에 `now`를 보고, 그 뒤에 결과 포트를 본다. `status_report`의 `forward.connection`은 요청 ID·실행기·실행 집합이 맞은 뒤 조회의 연결과 견주기 직전에 보고(안전 정수가 아니면 `input_malformed`·`forward.connection`), `backlog`(아래 "밀린 답". 틀리면 `input_malformed`·`backlog`)는 대조되고 연결이 맞은 뒤에만 본다. 어느 거절도 장부를 부르지 않는다. 본문 전체의 v1 형식 검사는 연결 판단이 이미 끝냈고, 이 모듈은 분기마다 필요한 칸만 읽는다. 예외를 던지지 않는다. 값의 꼴(UUID, digest 등)은 계약 검증과 장부가 다시 본다. 장부가 입력을 거부하며 던진 것(`LedgerInputError`)은 `ledger_failed`·`threw`다.

장부 입력으로 옮기지 않는 본문 칸: `started_at`, `stopped_at`, `remaining_processes`(계약이 0만 받는다), `cleaned_at`. 장부의 `ReceiptInput`에 그 칸이 없다. `bodyDigest`는 머리의 `body_digest`이고 `now`는 부르는 쪽이 넘긴 값이다.

## 공개 면

| 이름 | 꼴 |
|---|---|
| `handleForward(input, ports)` | `ForwardInput` → `ReceiptOutcome` |
| `replayBacklog(input, ports)` | `{ backlog, now, links }`, `{ ledger: Pick<ReceiptLedger, "applyExecutorAnswer" \| "recordAnswerSightings"> }` → `backlog_settled`(`settled`, `backlog`) 또는 `rejected`(`input_malformed`, `field`: `backlog`·`now`). 새 답 없이 한 실행기의 밀린 답을 다시 넘긴다. 사본마다 장부 호출 직전에 `links`에 그 답의 연결을 묻는다 |
| `ForwardInput` | `forward`(연결의 `forward` 출력, `verified`와 `connection`을 읽음), `now`(장부 시계와 같은 시계), `stopGeneration`(감독의 지금 정지 세대, 모르면 `null`), `pendingQueries: SentQuery[]`, `links: AnswerLinks`, `backlog`(그 실행기의 밀린 답, 받은 순서) |
| `PendingQuery` | `requestId`, `recipient`, `runIds`. `statusQueryDraft`의 초안에서 그대로 옮긴다. 수명 박자(`life-loop.ts`)가 돌려주는 꼴이다 |
| `SentQuery` | `PendingQuery`와 `connection`(그 조회를 실제로 실은 연결). `pendingQueries`의 항목이다 |
| `AnswerLinks` | `current(connection, executorId): boolean`. 그 연결이 지금도 그 실행기의 인정된 연결인가. 동기. 장부 호출마다 그 직전에 불린다 |
| `ExecutorAnswerCopy` | `sender`, `connection`(그 답이 온 연결), `coverage: "partial"`, `runs`, `answeredAt`. `connection` 밖은 `applyExecutorAnswer`에 넘기는 값 그대로 |
| `AnswerSettlement` | 답 하나를 넘긴 결과: `applied`(`moved`, `deferred`, `outsideLedger`, 경보가 있으면 `alarms`: 아래 "장부의 경보"), `unsaved`(`reason`, `unsavedSightings`), `ledger_failed`(`threw`·`malformed_answer`), `not_current`(`link`: `not_current`·`unknown`. 넘기기 직전에 본 그 답의 연결이 인정된 연결이 아니거나 모름, `applyExecutorAnswer`를 부르지 않음. `sighting`: 관측만 적기의 결과), `held`(앞의 밀린 답 때문에 넘기지 않음). 모두 `answer`(그 사본)를 싣는다 |
| `recordSighting(answer, ledger, links, now)` | `SightingAnswer`(`sender`, `connection`, `coverage`, `runs`, `answeredAt`) → `SightingOutcome`. 인정이 끝난 연결의 답에서 양성 관측만 적는다. 인사 처리기도 같은 함수를 쓴다 |
| `LedgerAlarm` | 장부 답에 실린 닫힌 실행의 경보 하나: `{ alarm: "closed_run_started" \| "closed_run_running", runId }` 또는 `{ alarm: "unreadable", runId }`(경보 칸을 읽지 못함. 답의 경보면 `runId: null`) |
| `readAnswerAlarms(answer)` | `applyExecutorAnswer`의 성공 답 → `{ alarms? }`. 인사 처리기도 같은 함수로 읽는다 |
| `SightingOutcome` | `saved`, `unsaved`(장부의 `reason`·`unsavedSightings` 그대로), `ledger_failed`(`threw`·`malformed_answer`), `skipped`(`why`: `SIGHTING_SKIPS`) |
| `ReceiptPorts` | `ledger: ReceiptLedger`, `random: Random`(`ports.ts`), `results?: ResultPorts`(결과 보고에만 쓴다. 없으면 결과 보고는 `result_unknown`·`ports`) |
| `ReceiptLedger` | `Pick<Ledger, "applyReceipt" \| "recordReport" \| "applyExecutorAnswer" \| "recordAnswerSightings">`. 실제 장부가 그대로 맞는다 |
| `ResultPorts` | `backend: ResultBackend`(`result-store.ts`의 포트, 동기), `ledger: Pick<Ledger, "getRun" \| "instructionTimes" \| "recordReport">`(`instructionTimes`는 실행이 `not_started`일 때만 부른다). 결과 보고의 거르기와 기록을 같은 장부 객체로 한다 |
| `EXECUTOR_ACTION_HANDLING` | 위 표의 동작 → 처리 |
| `REJECT_REASONS`, `STATUS_UNMATCHED_REASONS`, `RESULT_REFUSALS`, `SIGHTING_SKIPS` | 구별된 거절·건너뜀의 이름 |

`ReceiptOutcome`:

| `outcome` | 뜻 | ack 초안 |
|---|---|---|
| `ack` | 장부가 받았다(`delivery`: `new` 이번에 반영, `duplicate` 이미 반영). 장부가 그 영수증의 답에 경보를 실었으면 `alarm`(아래 "장부의 경보") | 있음(`ack`) |
| `applied_without_ack` | 장부는 받았지만 ack 초안을 만들지 못했다(`stop_generation_unknown`, `ackDraft`의 거절 사유, `draft_threw`). 실행기가 다시 보내면 장부가 `duplicate`로 받고, 그때 정지 세대를 알고 초안 생성에 성공하면 ack한다. 경보는 `ack`과 같이 `alarm` | 없음 |
| `ledger_refused` | 장부의 거절 사유 그대로 | 없음 |
| `ledger_failed` | 장부가 던졌다(`threw`) 또는 답이 꼴에 맞지 않는다(`malformed_answer`, 답의 칸을 읽다 던진 것 포함) | 없음 |
| `status_matched` | 기다리는 조회의 답이고 지금 인정된 연결에서 왔다. `queryRequestId`, `executor`, `connection`, `settled`(밀린 답 → 이번 답, 받은 순서. 마지막이 이번 답. 넘기는 동안 연결의 인정이 끝난 답은 `not_current`), `backlog`(다음에 그 실행기의 어떤 답보다 먼저 넘길 답) | 없음 |
| `status_not_current` | 기다리는 조회의 답이지만 그 연결이 지금 인정된 연결이 아니거나(`link: "not_current"`) 그것을 모른다(`unknown`: 포트가 던지거나 `true`·`false` 밖의 답). `applyExecutorAnswer`에 넘기지 않았다. `answer`에 그 답의 사본을, `sighting`에 관측만 적기의 결과를 싣는다 | 없음 |
| `status_unmatched` | `unknown_query`, `other_executor`, `runs_mismatch`, `other_connection`(그 조회를 실은 연결이 아닌 연결에서 옴. 항목의 연결 번호가 없거나 꼴이 틀려도 이것). 장부를 부르지 않았다 | 없음 |
| `result_refused` | 결과 보고를 장부에 넘기지 않았다. 확정된 이유(`reason`): 장부의 읽기로 본 `unknown_run`·`sender_mismatch`·`run_generation_mismatch`·`not_receivable`·`no_owner`, 보관소의 판단이 거절한 `conflict`·`too_large`·`digest_mismatch`·`invalid_input` | 없음 |
| `result_unknown` | 결과 보고를 장부에 넘기지 않았다. 모름(`at`): `ports`(결과 포트가 없음), `ledger_read`(장부를 읽지 못함·꼴이 틀린 답·장부가 아는 목록과 꼴 밖의 값), `store`(보관이 `unknown`이거나 던짐) | 없음 |

**장부의 경보(D-127·D-128).** 장부는 닫힌 실행(D-90·관리자 닫기)의 늦은 시작 영수증에 `alarm: "closed_run_started"`를, 같은 세대의 `running` 답에 `alarms`(`closed_run_running`)를 싣는다(`src/ledger/ledger.md` "경보를 밖으로 낸다"). 처리기는 그것을 결과에 옮기기만 한다: 영수증은 `ack`·`applied_without_ack`의 `alarm`(`runId`는 그 영수증의 실행), 답은 `applied`의 `alarms`다. 경보가 없으면 칸이 없다. 조립이 이 칸을 감독 로그 `ledger_alert` 한 줄씩으로 낸다(같은 경보는 프로세스에서 한 줄, `src/supervisor/runtime/boot.md` S43).

- **경보 칸은 ack·반영을 가르지 않는다.** 경보 칸은 다른 칸과 따로 한 번만 읽고, 던지거나 약속 밖의 값(모르는 이름, 배열이 아님, 항목의 실행 ID·세대가 꼴 밖)이면 `unreadable`로 싣는다(답의 경보는 어느 실행인지 몰라 `runId: null` 하나). ack 초안·`delivery`, `applied`·밀린 사본·다시 물을 실행은 경보 칸이 없을 때와 같다: 경보 때문에 ack를 막으면 실행기가 같은 영수증을 끝없이 다시 보내고, 반영을 실패로 세면 같은 답을 다시 넘기며 그 실행기의 뒤 답을 막는다. 경보가 빠지는 쪽보다 남는 쪽이라 버리지 않는다.
- **보고(`recordReport`)의 답에서는 경보 칸을 읽지 않는다.** 장부가 보고에 경보를 싣지 않는다.
- **인정이 끝난 연결의 답(`recordSighting`)에는 경보가 없다.** `recordAnswerSightings`는 관측만 적고 경보를 싣지 않는다(장부의 계약). 그 실행은 지금 연결의 다음 답(조회·인사)에서 경보가 난다.
| `rejected` | 위 표의 거절과 꼴 거절 | 없음 |

## 결과 보고

한 동기 함수 안에서 순서대로 한다. 보장하는 것은 거르기·보관·장부 기록·ack 사이에 **지연 실행과 이벤트 루프의 양보가 없다**는 것이다: 처리기는 `await`·콜백 예약을 두지 않고, `settle`은 넘겨받은 콜백을 그 자리에서 부르며, 비동기로 답하는 백엔드는 모름이다. 그래서 다른 작업(같은 프로세스의 다른 타이머에서 부르는 고아 정리 `sweepStored` 등)이 그 사이에 돌 수 없다. 전제는 **넘겨받은 포트(백엔드·장부)가 동기이고, 그 안에서 장부 변경이나 정리로 다시 들어오지 않는 것**이다. 기본 파일 포트와 실제 장부는 그렇다. 포트 자신이 동기 호출 안에서 장부를 바꾸거나 정리를 부르면 이 처리기는 막지 못한다(거르기에서 읽은 실행 줄이 기록 전에 바뀌면 장부가 기록 때 다시 가른다).

시험은 두 가지를 본다. 실제 장부·파일 백엔드에서 부르는 순서(`getRun` → `putNew` → `read` → `recordReport` → ack 난수)를 정확히 대조하고, `receipts.ts`의 줄마다 첫 `//` 뒤를 지운 소스에서 `await`·`async`·`Promise`·`.then(`·`queueMicrotask`·`setTimeout`·`setImmediate`·`nextTick` 여덟 토큰을 찾는다. 이 토큰 검사는 그 파일의 글자만 본다: 목록 밖의 예약(`setInterval` 등. 예약 직후 해제하는 사본은 두 시험을 모두 통과한다), 다른 모듈이 하는 비동기 동작, 포트 안의 재진입은 찾지 못한다.

1. **거르기(장부의 읽기).** `results.ledger.getRun(run_id)`, 실행이 `not_started`면 `results.ledger.instructionTimes(run_id)`도. 판단에 쓰는 칸(실행 ID, 지정 실행기, 세대, 종류, 상태, 소유자)은 칸마다 한 번 읽어 도메인을 본다: 상태는 장부의 `LEDGER_RUN_STATES`, 종류는 장부의 전이 표(`TRANSITIONS`)의 열쇠, 지정 실행기는 계약의 실행기 이름, 세대는 0 이상의 안전 정수, 소유자는 `null`이거나 UUID. 읽지 못하거나 답의 꼴이 틀리거나 이 목록·꼴 밖이면 `result_unknown`(`ledger_read`). 없는 실행은 `unknown_run`, 지정 실행기가 머리의 낸 쪽이 아니면 `sender_mismatch`, 실행 세대가 머리와 다르면 `run_generation_mismatch`, 세션 실행이거나 `queued`이거나 시작 지시가 한 번도 없던 `not_started`(`instructionTimes`의 `lease`가 `null`)면 `not_receivable`(`lease`가 `null`도 장부의 꼴, 곧 발행 시각과 시각이나 `"unknown"`인 끝을 가진 객체도 아니면 `ledger_read`. 칸은 한 번씩 읽는다), 소유자(`inputRequestId`)가 없으면 `no_owner`. 모두 보관소에 닿지 않는다(본문을 맡지 않는다). 시작 지시가 없던 `not_started`는 `queued`에서 취소된 실행이다: `queued` 밖에서 `not_started`로 가려면 닫기 근거가 있어야 하고(`src/ledger/states.ts`의 전이 주석), 닫기(`closeUnreceivedRun`)는 시작 지시가 정확히 하나인 실행만 닫으며, 장부는 `queued`와 닫기 근거 없는 `not_started`의 결과 보고를 늘 거절한다(`recordReport`의 결과 판정). 그래서 그 실행에는 적힌 보고가 없고 받을 수도 없다.
2. **보관.** `storeResult(backend, { runId, owner: inputRequestId, digest, body, now })`. 본문 바이트는 결과의 정규 직렬화(`resultBody`), digest는 계약의 `resultDigest`다. `stored`일 때만 다음으로 간다. `unknown`(백엔드 장애, 폴더를 내리지 못함, 비동기로 답한 백엔드 등)은 `result_unknown`(`store`), `conflict`·`rejected`는 `result_refused`.
3. **장부 → ack.** 그 참조와 digest로 `recordReport`를 부르고 나머지는 다른 보고와 같다(`settle`: 장부가 `ok`일 때만 ack 초안).

- **같은 보고의 재전송:** 거르기를 다시 지나고, 보관소는 같은 자리에 같은 본문이 있으므로 같은 참조(`created: false`)를 낸다. 장부는 `duplicate`로 받고 ack를 다시 만든다. 두 번 보관하거나 두 번 반영하지 않는다.
- **보관은 됐는데 장부가 거절하거나 모를 때(`ledger_refused`·`ledger_failed`):** ack가 없고 **본문은 보관소에 남는다.** 처리기는 지우지 않는다: `ledger_failed`는 적혔는지 모르고, 적혔으면 지운 본문은 되살릴 수 없다. 같은 보고가 다시 오면 같은 참조로 이어지고 장부가 다시 가른다(일시 장애였으면 그때 적힌다). 본문은 **그 저장 참조를 가리키는 커밋된 보고가 장부에 하나도 없을 때만** 고아다. 이번 호출의 거절이나 `created: false`만으로는 고아가 아니다: 같은 실행의 자리는 하나라, 끝내 거절된 보고가 가리키는 자리를 앞서 받은 다른 보고가 이미 참조하고 있을 수 있다(먼저 받은 보고를 두고 결과 없음으로 판정한 실행에 다른 id로 같은 결과가 오면 보관소는 `exists`, 장부는 `transition_denied`다. 그 보고의 digest로 판정한 뒤라면 장부는 다른 id의 같은 결과를 `new`로 적는다: `src/ledger/ledger.ts`의 `#resultDisposition`). 고아는 머리가 온전한 기록이라 `listStored`가 `stored`와 보관 시각으로 보이고, `sweepStored`가 장부의 참조 목록(`keep`) 밖이면서 기한 전의 것으로 지울 수 있다. 이 처리기는 고아 정리를 부르지 않는다.
- **정지 세대를 모를 때(`applied_without_ack`):** 장부는 받았고 참조가 적혔다. 다시 오면 같은 참조·`duplicate`로 ack한다.
- **같은 실행에 다른 결과(같은 id든 다른 id든):** 보관소의 자리는 실행마다 하나라 `conflict`로 장부 전에 거절된다. 새 본문을 남기지 않고 앞의 본문과 장부 줄은 그대로다. ack가 없어 실행기는 계속 다시 보낸다.
- **거르기가 거르지 않는 상태:** 판정이 끝난 상태(`ready_result`·`failed_stopped`·`cleanup_pending`·`finalized`)와 시작 지시가 있던 `not_started`는 장부에 맡긴다(본문부터 보관한다). 그 실행에는 앞서 적힌 보고가 있을 수 있어, 그 재전송이면 장부가 `duplicate`로 ack해야 하는데 그 id가 적혔는지 읽는 공개 읽기가 없다. 시작 지시가 있던 `not_started`는 닫기 근거가 있으면 늦은 첫 보고도 받는데(`new` ack), 닫기 근거는 장부만 읽는다. 판정과 다른 결과가 먼저 온 `ready_result`처럼 장부가 끝내 받지 않는 보고도 이 읽기만으로는 재전송과 가를 수 없어 보관된다(아래 "남는 한계").
- **본문을 싣지 않는다.** 거절·모름·ack·결과에는 보고 id·실행 ID·이유만 있다. 본문은 보관소에만 간다.

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

`status_not_current`는 그 답의 사본(`answer`)과 관측만 적기의 결과(`sighting`)를 싣는다. 그 답의 양성 항목은 받을 때 유효했으므로 임대를 건드리지 않고 관측만 장부에 남긴다(아래 "인정이 끝난 연결의 답: 관측만 적기"). 부르는 쪽은 같은 실행을 지금의 연결로 다시 조회한다(다시 조회로 얻는 것은 아래 "다시 조회로 얻는 것").

### 인정이 끝난 연결의 답: 관측만 적기

대조됐지만 넘기는 순간 연결의 인정이 끝난 답(`status_not_current`, 밀린 사본의 `not_current`)과 인사 처리기의 `not_current` 인사는 `recordSighting` 하나로 장부의 `recordAnswerSightings`에 넘긴다(`src/ledger/ledger.md` "관측만 적는 연산을 부르는 쪽"). 그 연산은 첫 양성 관측만 적고 실행 상태·임대·영수증·자리를 바꾸지 않는다.

- **부르는 때.** 갈래를 고를 때 본 연결이 `false`(인정이 끝남)였을 때만 부른다. 모름(`unknown`)이면 부르지 않는다(`link_unknown`). 안다는 항목이 없으면 붙들 관측이 없어 부르지 않는다(`no_positive`). `status_not_current`는 그 실행기의 밀린 사본이 남아 있으면 부르지 않는다(`backlog_first`): 부르는 쪽이 이 답을 밀린 목록 끝에 두고 앞 사본 다음 차례에 적는다(받은 차례). 밀린 목록을 읽지 못해도 남은 것으로 본다. 장부 시각이 꼴에 맞지 않으면 부르지 않는다(`now_malformed`).
- **효과 직전의 차례.** 연산을 얻어 장부에 묶고(`ledger.recordAnswerSightings`를 한 번 읽음) 넘길 값(동결한 사본의 사본)을 만든 뒤, 부르기 직전에 `links.current(그 답의 connection, sender)`를 한 번 더 묻고, 그 사이에 외부 코드 없이 부른다. 장부는 연결을 보지 않고 `sender`를 그대로 믿으므로, 그 순간 연결이 인정된 연결이면(`link_current`: 그 답은 `applyExecutorAnswer`의 몫) 또는 모르면(`link_unknown`) 부르지 않는다. 연산을 읽거나 장부에 묶다 던지거나 함수가 아니면 `ledger_failed`·`threw`다.
- **값.** 검증된 봉투의 값 그대로다: `sender`, `coverage`(상태 보고는 `partial`, 인사는 `full`), `runs`, `answeredAt`(서명 시각, 모르면 `null`). `now`는 부르는 쪽의 장부 시계다.
- **결과.** 장부가 `ok`면 `saved`. 거절이면 장부의 `reason`·`unsavedSightings` 그대로 `unsaved`. 던지면 `ledger_failed`·`threw`, 답의 꼴이 틀리면(`ok`가 참·거짓이 아님, 사유가 장부의 `REFUSALS` 밖, `unsavedSightings`의 항목 꼴, 칸을 읽다 던짐) `malformed_answer`. 칸은 한 번씩 읽고 원문을 싣지 않는다.
- **사본을 놓는 것은 `saved`뿐이다.** `saved`면 그 사본은 `backlog`에 남지 않아 그 실행기의 뒤 답이 막히지 않는다. 그 밖(거절·실패·건너뜀)이면 안다는 사본은 지금처럼 `backlog`에 남아 다시 넘길 때 다시 적어 본다(장부는 첫 관측만 적으므로 다시 적어도 해가 없다).
- **닫기의 근거로 쓰지 않는다.** 이 연산은 목록에 없는 실행을 보지 않는다. 적힌 관측은 D-90 닫기의 `run_sighted` 거절의 재료가 될 뿐이다.

### 밀린 답

상태 보고는 실행기가 다시 보내지 않으므로, 장부가 저장을 확인하지 않은 답(`unsaved`, `ledger_failed`)이나 넘기기 직전에 연결의 인정이 끝난 답(`not_current`)에 `not_known` 밖 항목이 있으면 그 답의 사본(`ExecutorAnswerCopy`)이 유일한 사본이다. 처리기는 그 답부터 뒤의 답 전부를 결과의 `backlog`(받은 순서)로 돌려준다. 사본은 그 답이 온 연결의 번호(`connection`)를 갖는다. 부르는 쪽은 그 목록을 그 실행기의 다음 `status_report`의 `backlog`로 넘기거나, 새 답 없이 `replayBacklog`로 다시 넘긴다.

- **받은 순서대로 넘긴다.** `backlog`를 이번 답보다 먼저 같은 값(`coverage`·`runs`·`answeredAt`·`sender`)으로 넘긴다. 앞 답이 또 저장되지 않으면 뒤 답은 장부에 넘기지 않고(`held`) 그 뒤에 줄 세운다. 그래서 "안다"는 앞 답이 그 실행을 빼먹은 뒤 답에 묻히지 않는다.
- **다시 넘겨도 해가 없다.** 장부는 (실행, 실행기, 세대)의 첫 관측만 적고, 이미 옮긴 실행은 다시 옮기지 않는다. `ledger_failed`의 답은 적혔는지 모르지만 같은 이유로 다시 넘긴다.
- **`not_known`만 실은 답의 실패는 남기지 않는다.** 붙들 관측이 없다. 그 답으로 거두려던 임대는 그대로 남는다(아래 "다시 조회로 얻는 것").
- **장부 호출마다 그 직전에 그 답의 연결을 다시 본다.** `handleForward`가 밀린 목록을 넘기는 루프와 `replayBacklog` 양쪽에서, 사본 하나를 넘기기 직전마다 `links.current(사본의 connection, sender)`에 묻는다. 받을 때 맞았던 연결도 그 뒤 닫혔을 수 있고, 같은 루프의 앞선 장부 쓰기가 실패하며 그 연결의 인정을 끝낼 수 있다. `true`가 아니면 그 답으로 `applyExecutorAnswer`를 부르지 않고 `not_current`(`link`)다. `false`면 그 사본의 관측만 적어 보고(위 "관측만 적기"), 적히면 사본을 놓는다. 적지 못했거나 모르면(`unknown`) "안다"는 항목이 든 사본은 버리지 않고 `backlog`에 그대로 남긴다(뒤 답은 `held`). `not_known`만 실은 사본은 남기지 않는다.
- **관측을 적지 못한 인정이 끝난 연결의 "안다"는 사본은 그 실행기의 뒤 답을 막는다.** 그 사본은 다시 넘겨도 늘 `not_current`다(연결은 다시 인정되지 않는다). 다시 넘길 때마다 관측만 적기를 다시 시도하고, 적힐 때까지 그 실행기의 뒤 답은 모두 그 뒤에 줄 선다. 막힌 쪽은 닫는 쪽이다: 뒤 답이 끝났다·모른다고 해도 임대를 거두지 못하고 장부는 갱신을 계속 믿으며, 자리는 풀리지 않는다.
- **`backlog`의 꼴은 다시 본다.** 그 실행기(`sender`)의 사본이고 `connection`이 안전 정수, `coverage`가 `partial`이며 `runs`가 배열(항목마다 `run_id`)이고 `answeredAt`이 시각 또는 `null`이어야 한다. 아니면 장부를 부르지 않고 `input_malformed`·`backlog`다. 항목의 나머지 꼴은 장부가 본다.

### 다시 조회로 얻는 것

`deferred`, 실패, `status_not_current`, `not_current`의 실행은 같은 실행 ID로 다시 조회한다. 다시 조회로 얻는 것은 **새 답의 내용**이다. 앞서 들은 답을 되살리지 않는다.

- **앞서 들은 "안다"는 사실은 새 답으로 되살아나지 않는다.** 새 `not_known` 답 자체는 "안다"는 관측을 더하지 않는다. 앞 답이 `running`이었어도 그 사본 없이 새 `not_known` 답만 넘어가면 그 실행의 관측은 0행이다. 앞 답의 관측은 그 사본을 넘겨 저장해야만 남는다: 한 호출에서 밀린 사본이 새 답보다 먼저 저장되면 그 사본의 관측(1행)이 함께 남는다.
- **앞서 실패한 임대 거두기는 새 답으로 일어나지 않는다.** 새 `running` 답 자체는 앞서 저장하지 못한 답의 임대 거두기를 하지 않는다. 한 호출에서 그 앞 답의 사본이 밀린 목록으로 먼저 저장되면 그 사본이 임대를 거둔다(`not_known`만 실은 답은 목록에 남지 않으므로 그 거두기는 새 답에만 달린다). 답 하나가 임대를 거두는 것은 그 실행이 임대를 믿는 상태(`preparing`·`running`)이고, 그 답의 항목이 늦은 `not_known`이거나 같은 세대의 `preparing`·`running` 밖 상태(`stopping`, 종료 상태 등)일 때다. 그런 답을 받지 못하면 언제 거둬질지 상한이 없다(자리는 풀리지 않는 쪽이다).

## 정한 것

- **ack의 정지 세대는 감독의 값이다.** 머리의 `stop_generation`이 아니라 부르는 쪽이 넘긴 감독의 지금 정지 세대(복원기의 `stopGeneration()`)를 싣는다. 모르면(`null`) 장부는 반영하고 ack는 만들지 않는다(종료·영수증의 기록은 막지 않는다, `ledger.md` "못 씀"). 실행기가 다시 보내면 장부가 `duplicate`로 받고, 그때 정지 세대를 알고 초안 생성에 성공하면 ack한다.
- **장부의 ack id가 넘긴 id와 다르면 꼴이 틀린 답이다.** 다른 id의 ack는 다른 영수증의 재전송을 멈추게 한다.
- **영수증 하나에 ack 초안 하나.** 여러 id를 한 ack에 모으는 일은 하지 않는다.
- **옛 연결의 답은 조회 항목의 연결 번호와 포트로 막는다.** 위 "옛 연결의 답". 조회를 실은 연결은 항목의 값으로 견주고(그 사실은 싣는 순간에 정해지고 바뀌지 않는다), 연결이 지금 인정됐는지는 장부 호출마다 포트에 묻는다. 포트가 모르면 넘기지 않는다.
- **`PendingQuery`는 그대로 두고 연결 번호를 가진 `SentQuery`를 따로 둔다.** 수명 박자(`life-loop.ts`)는 내보내기 포트가 어느 연결에 실었는지 모르므로 `PendingQuery`를 돌려준다. `pendingQueries`가 `SentQuery`만 받아, 연결 번호를 더하지 않은 목록은 타입 검사에서 걸린다.
- **인정이 끝난 연결의 "안다"는 사본은 관측이 장부에 적히기 전에는 버리지 않는다.** 버리면 장부에 흔적이 없어 뒤 조각(D-90)이 "안다고 한 적 없음"으로 잘못 읽을 수 있다. 적힌 뒤에는 놓는다(쥘 까닭이 없고, 쥐면 그 실행기의 뒤 답이 막힌다). 적지 못하는 동안은 그 대가로 뒤 답이 막힌다(위 "밀린 답").
- **관측만 적기는 부르기 직전의 연결이 `false`일 때만이다.** 갈래를 고를 때와 부르기 직전 두 번 본다. 모르면 적지 않는다: 지금 연결의 답이었다면 그 관측은 `applyExecutorAnswer`로 가야 하고, 모르는 채 적으면 그 갈래를 우회한다. 사본이 남아 다음에 다시 본다.
- **`status_not_current`는 앞 밀린 사본이 없을 때만 그 자리에서 적는다.** 있으면 목록 끝에 서서 받은 차례로 적힌다. 장부의 관측은 첫 줄만 남으므로 차례가 뒤바뀌면 뒤 답의 관측이 첫 줄이 된다.
- **밀린 답은 입력으로 받고, 새 답 없는 재시도는 `replayBacklog` 하나로 한다.** 순서를 부르는 쪽의 규율에만 맡기지 않으려고 `handleForward`가 밀린 답을 이번 답 앞에 넘긴다.
- **상태 보고는 실행 ID 집합까지 대조한다.** 실행기는 물은 실행 ID마다 하나씩 답한다(`src/executor/worker.ts`의 `onStatus`). 다른 집합이면 그 조회의 답으로 보지 않는다.
- **`report_rule_check`는 받지 않는다.** 장부의 `recordReport`가 받는 꼴이 아니고(`applyRuleCheck`, `from`도 낸 쪽 이름 하나뿐), 그 증거를 쓰는 세션 계약 작업이 아직 없다. 지금 연결 판단은 작업자 실행기의 맞춤 요청만 받는다(`connections.ts`의 `syncRequest`).
- **결과 포트는 선택 칸이다.** 결과 보고 밖의 처리만 쓰는 쪽(상태 보고 대조 등)이 그대로 맞게 하려는 것이다. 빠지면 결과 보고는 닫는 쪽(`result_unknown`·`ports`, ack 없음)이다.
- **결과 보고는 장부를 먼저 읽어 거른다.** 장부의 `recordReport`가 같은 검사를 다시 하지만, 장부가 받지 않을 보고의 본문을 보관소에 맡기면 고아가 생긴다. 거르는 것은 재전송의 `duplicate`와 상관없이 장부가 받을 수 없음이 확정되는 경우뿐이다(위 "결과 보고").
- **보관 뒤 장부가 받지 않아도 본문을 지우지 않는다.** 장부가 적었는지 모르는 경우(`ledger_failed`)에 지우면 장부의 참조가 없는 본문을 가리키게 된다. 남은 본문은 같은 보고의 재전송이 같은 참조로 잇거나 고아 정리가 치운다.
- **본문의 남는 칸은 읽지 않는다.** v1의 본문 해석이 모르는 칸을 이미 거절한다. 이 모듈은 읽는 칸의 타입만 본다.

## 이 모듈에 없는 것

순환(언제 부르고 결과를 어디로 보내는가), 소켓과 ack의 봉하기·싣기, 기다리는 조회 목록의 보관과 만료, 조회 항목에 실은 연결의 번호를 붙이는 일, 밀린 답의 보관, 다시 조회하기(이 처리기는 조회를 내지 않는다), `links` 포트의 구현, 운영 중 `hello`의 `full` 답, 자리를 푸는 판단(D-90), 결과 검사와 판정(`markResult`), 결과의 확정, 보관 백엔드의 조립, 고아 정리와 보관의 만료·삭제, 본체가 결과를 읽는 길, 규칙 확인의 반영.

## 남는 한계

- **인정이 끝난 연결에서 받은 "안다"는 항목은 관측 쓰기가 실패하는 동안 장부에 없다.** `status_not_current`의 답과 `not_current`로 남은 사본이 그렇다. 그 사본이 그 실행기의 밀린 목록에 있는 동안 그 실행기의 뒤 답은 막히고(임대를 거두지 못한다), 프로세스가 다시 뜨면 그 관측은 장부에 흔적이 없다. 그러면 뒤 조각(D-90)이 그 실행을 "안다고 한 적 없음"으로 잘못 읽을 수 있어, D-90은 밀린 사본이 남은 실행기를 대기로 보고 닫지 않는다(재시작을 걸친 공백은 장부의 `sent_by_other_open`이 막는다). `status_not_current`의 `answer`는 처리기가 목록에 넣지 않는다: 부르는 쪽이 관측이 적히지 않은 사본을 따로 들고만 있으면 뒤 답은 막히지 않고 장부에 닿는다(새 `not_known` 답이 임대를 거두고, 그 실행의 관측은 0행이다).
- **밀린 답은 그 프로세스의 메모리에만 있다.** 재시작하면 사라지고 장부에 흔적이 없다(`ledger.md`의 "0행의 뜻(함정)").
- **막힘에 상한이 없다.** 앞 답이 계속 저장되지 않거나 인정이 끝난 연결의 "안다"는 사본의 관측 쓰기가 계속 실패하면 그 실행기의 뒤 답은 무기한 `held`다. 상한과 경보는 정하지 않았다.
- **`not_known`만 실은 답을 저장하지 못하면 그 임대 거두기는 다시 조회의 새 답에 달린다.** 위 "다시 조회로 얻는 것".
- **장부가 끝내 받지 않는 결과 보고는 본문부터 보관된다.** 거르기가 거르지 않는 경우다: 결과 없음으로 판정된 실행의 새 보고(`transition_denied`), 판정과 다른 결과(보고 없이 다른 digest로 판정된 `ready_result` 등, `receipt_conflict`), 이미 다른 실행에 쓴 보고 id를 다른 `run_id`로 다시 쓴 보고(그 실행의 자리에 보관된 뒤 장부가 `receipt_conflict`). 그 자리를 가리키는 커밋된 보고가 없으면 그 본문은 고아이고, 그 실행의 자리를 차지하므로 고아 정리가 지우기 전까지 판정에 맞는 뒤의 결과도 보관소의 `conflict`로 막힌다(ack가 없어 실행기는 계속 다시 보낸다). 고아 정리의 `keep`(장부에 커밋된 결과 참조 전부)을 만들 장부의 읽기는 아직 없다(`pendingReports()`는 반영 전 보고만 낸다).
- **같은 실행의 다른 결과는 장부의 충돌 기록에 남지 않는다.** 보관소가 `conflict`로 먼저 거절하므로 장부의 `receipt_conflicts`에 줄이 생기지 않는다(장부의 충돌 규칙은 장부에 닿은 보고에만 적용된다). ack가 없는 것은 같다.
- **소유자 없는 실행의 결과는 받지 못한다.** 보관소는 소유자(입력 요청 ID)로 읽기를 막으므로 `inputRequestId`가 없는 작업자 실행의 결과는 `no_owner`이고 실행기는 계속 다시 보낸다.
- **빈 자리가 있는 보류 배열은 성공으로 읽힌다.** 장부 포트가 길이만 있고 항목이 빈 `deferred`를 돌려주면 처리기는 `applied`로 센다. 실제 장부는 빈 자리 없는 배열을 돌려주므로 포트가 약속을 어긴 경우다.

## 뒤 조각이 지킬 것

- **`status_report`의 `forward`를 이 처리기로 넘긴다.** 연결 판단은 인정된 연결의 검증된 `status_report`를 점유 응답(`occupancy`, `partial`, `in_reply_to` 없음)과 `forward`(검증된 봉투 그대로, 연결 번호 함께)로 함께 낸다(`connections.ts`의 `envelope`). 대조와 장부 반영은 `forward`로만 한다. 점유 응답의 `partial` 행을 따로 `applyExecutorAnswer`에 넘기지 않는다(같은 답을 두 번 넘기게 되고, 그 행에는 대조할 `in_reply_to`도 서명 시각도 없다).
- **조회는 싣는 연결에 등록한다.** 기다리는 조회(`SentQuery`)는 `statusQueryDraft`의 초안에서 `requestId`·`recipient`·`body.run_ids`를 그대로 옮기고, 그 봉투를 **실제로 실은 연결의 번호**를 `connection`에 넣는다. 수명 박자가 돌려주는 `pendingQueries`(`PendingQuery`)에는 연결 번호가 없으므로, 어느 연결에 실었는지 아는 내보내기 포트(조립)가 붙인다. 조회의 답은 박자가 결과를 돌려주기 전에 올 수 있으므로 빠른 답보다 먼저(싣기 직전에) 등록하거나, 등록될 때까지 그 답을 보관한다(`life-loop.md` "뒤 조각이 지켜야 할 것"). 같은 초안을 다른 연결로 다시 실으면 그 연결의 항목을 따로 더한다. 연결이 철회·교체되면 그 연결의 대기 항목을 끝낸다. 같은 초안을 다시 봉해 보내면 실행기가 매번 답하므로 같은 `in_reply_to`의 답이 여럿 올 수 있다. 목록에서 언제 지울지는 순환이 정한다.
- **`links`를 지금의 연결 표로 잇는다.** 부르는 순간에 쥔 `Connections`와 지금의 복원기로, 그 연결이 `candidates(복원기)`에 있고 그 연결의 맞춤 주체(`sync.principal`)가 그 실행기 이름일 때만 `true`를 답한다. 동기로 답한다. 처리기는 상태를 바꿀 수 있는 장부 호출마다 그 직전에 묻으므로, 그 답은 묻는 순간의 사실이어야 한다(앞선 장부 쓰기가 복원기의 세대를 바꿨으면 그것까지 반영한다). 값을 미리 읽어 캐시하지 않는다.
- **한 실행기의 답은 받은 순서대로 처리한다.** 같은 실행기의 `forward`를 받은 순서대로 이 처리기에 넘기고, 그 사이에 같은 실행기의 다른 답(운영 중 `hello`의 `full` 포함)을 장부에 먼저 넘기지 않는다. `partial`과 인사의 `full`이 서로 추월하지 않게 한다. `partial`은 검증된 `forward`에서 한 번만 넘긴다. 결과의 `backlog`는 그 실행기의 이름에 묶어 쥐고, 다음 `status_report`의 `backlog`로 넘기거나 `replayBacklog`로 다시 넘긴다. `status_matched`·`backlog_settled`의 `backlog`만 쥔 목록을 대신한다(넘겨서 끝난 앞부분만 빠진다). `status_not_current`·`status_unmatched`·`rejected`에는 `backlog`가 없으므로 쥐고 있던 목록을 그대로 둔다(빈 목록으로 덮지 않는다). `status_not_current`의 `answer`에 `not_known` 밖 항목이 있고 `sighting`이 `saved`가 아니면 그 사본을 쥐고 있던 목록 끝에 넣는다(`saved`면 관측이 장부에 있어 쥐지 않는다). 따로 들고만 있으면 그 실행기의 뒤 답은 막히지 않는다. `backlog`가 비어 있지 않은 동안 그 실행기의 다른 답(인사의 `full` 답 등)을 장부에 넘기는 쪽도 그 뒤에 넘긴다.
- **밀린 "안다"는 사본은 저장될 때까지 쥔다.** 밀린 답은 그 프로세스의 메모리에만 있다. 연결이 철회되거나 실행이 끝났다는 이유만으로 버리지 않는다. 철회된 연결의 사본은 처리기가 임대 변경에 쓰지 않고(`not_current`) 관측만 적으며, 적히면 결과의 `backlog`에서 빠진다. 적히기 전까지 그 실행기의 새 답은 뒤에 줄 서므로(`held`) 임대를 거두지 못하고 장부는 갱신을 계속 믿는다(자리는 풀리지 않는 쪽이다). 오래 막히면 경보한다(상한과 경보 기준은 뒤 결정이다). 재시작·복원 실패 등으로 사본을 잃어 증거가 끊긴 실행은 D-90에서 자동 해제하지 않는다(`ledger.md`의 "0행의 뜻(함정)").
- **`deferred`·실패·`status_not_current`·`not_current`면 같은 실행 ID로 다시 묻는다.** 실패(`unsaved`, `ledger_failed`)로 넘기지 못한 답의 실행도 같다. 새 답의 서명된 `issued_at`으로 다시 판단한다(위 "다시 조회로 얻는 것": 앞 답을 되살리지 않는다). 부정 답, `outsideLedger`, 부분 목록만으로 자리를 풀지 않는다. 조회는 수명 순환(`life-loop.ts`)이 내고, 이 처리기는 내지 않는다.
- **복원이 붙든 관측이 운영의 답보다 먼저다.** 재시작 복원 2단계가 적지 못한 관측을 복원기가 붙들고 있는 동안(2단계 재시도 전) 그 실행기의 운영 중 답을 이 처리기로 장부에 넘기지 않는다. 복원의 재시도가 같은 실행기의 운영의 더 새 답보다 먼저 적혀야 앞 관측이 뒤 답에 묻히지 않는다.
- **D-90은 닫는 트랜잭션에서 증거를 다시 본다.** 지정 실행기·세대, 영수증·보고, 빠짐없는 양성 관측 이력(위 공백을 걸친 실행은 빼고), 시작 재전송 중단, 마지막 시작 봉투의 시한이 지난 뒤의 지금 전체 점유 답에서 빠졌음을 함께 확인한다(`ledger.md` "D-90의 닫기"). D-91의 관리자 판단 대상과 D-92의 갱신 금지(옮긴 실행을 되살리지 않는다)를 지킨다.
- **`src/ledger/ledger.md`의 "부르는 코드가 없다"는 두 문장(상태 조회 줄의 **미확인**, "실행기의 답을 넘기는 쪽"의 첫 문장)은 이제 낡았다.** 이 처리기가 대조된 조회의 답을 넘긴다. 장부 문서를 고치는 쪽이 맞춘다.
- **`status_not_current`의 답은 관측이 적히지 않았으면 버리지 않고, "안다"는 항목이 있으면 그 실행기의 밀린 목록 끝에 넣는다.** 그 사본은 다시 넘겨도 `not_current`이므로 다시 넘길 때마다 관측만 적기를 다시 시도하고, 적히기 전까지 그 실행기의 뒤 답은 그 뒤에 줄 선다(`held`, 위 "밀린 답"). 목록에 넣지 않고 따로 들고만 있으면 뒤 답은 막히지 않는다: 같은 실행을 지금의 연결로 다시 물으면 새 답이 장부에 닿아 새 답의 내용만 남는다(새 답이 `not_known`이면 임대를 거두고 관측은 0행이다). 그러면 앞 답의 "안다"는 사실은 위 "남는 한계"의 공백으로 남는다.
- **관측 쓰기가 실패한 답의 실행기는 D-90에서 뺀다.** 상태 보고의 사본은 밀린 목록에 남아 대기로 보이고, 인사는 답 줄이 오염으로 남긴다(`src/supervisor/runtime/answers.md` "오염·대기·고장의 규칙").
- **연결 번호는 밀린 사본이 살아 있는 동안 유효해야 한다.** 같은 연결 표를 이어 쓰면 닫은 번호를 다시 쓰지 않는다. 연결 표를 새로 시작하는 조립에서는 같은 실행기의 첫 연결 번호가 다시 처음 값이 될 수 있으므로, 밀린 사본이 살아 있는 동안 번호 발급을 이어 가거나 사본과 조회에 표의 식별을 묶는다.
- **ack는 장부가 받은 것만 싣는다.** `ack` 결과의 초안만 봉해서 보낸다. `applied_without_ack`·`ledger_refused`·`ledger_failed`에 대해 ack를 따로 만들지 않는다. ack는 재전송을 멈추라는 뜻일 뿐이고 종료·정리·실행 허가가 아니다.
- **`now`와 정지 세대는 장부와 같은 시계·같은 복원기에서 읽는다.** 정지 세대는 이 처리기를 부르는 순간의 값이다. 연결 판단이 봉투를 받아들인 때의 값을 다시 쓰지 않는다.
- **결과 포트를 늘 넘긴다.** `results`가 없으면 결과 보고는 ack 없이 끝나 실행기가 무기한 다시 보낸다. `results.backend`는 동기 백엔드(파일 백엔드의 조건은 `src/supervisor/scheduler/result-store-file.md` "뒤 조각이 지켜야 할 것": 실제 폴더, 링크 없는 경로, 바뀌지 않는 상위 폴더, 감독 하나, 기록 상한), `results.ledger`는 `ledger`와 같은 장부다. 이 처리기를 부르는 흐름에도 `await`를 두지 않는다(같은 프로세스의 고아 정리를 같은 흐름 안에서 부르지 않는다).
- **고아 정리는 장부의 결과 참조 전부를 `keep`으로 넘긴다.** 보관은 됐지만 그 참조를 가리키는 커밋된 보고가 없는 본문만 지우게 한다. 기한은 실행기의 재전송이 같은 참조로 이어질 시간보다 길어야 한다(지운 뒤 같은 보고가 오면 새로 보관된다).
- **고아 정리는 참조를 읽은 그 동기 구간 안에서 지운다.** `keep`은 장부의 모든 커밋된 결과 참조(미반영과 반영 완료 모두)를 읽어 만들고, 그 읽기와 삭제 사이에 다른 보고를 받지 않는다. 완전한 읽기를 얻지 못하면 그 회차의 삭제를 보류한다. 유예 시간만으로는 이 틈을 닫을 수 없다: 재전송은 옛 파일을 다시 쓰고(`created: false`) 그 `storedAt`은 처음 값이라, 읽은 뒤에 장부가 받은 보고의 본문도 기한이 지난 것으로 보인다.
- **결과 보고의 ack는 종료 증명이나 게시 허가가 아니다(계약 v1).** 장부에 적힌 참조로 자리를 풀거나 게시를 열지 않는다. 확정은 결과 검사(`markResult`)와 수명 박자의 일이다.
- **장부 반영의 결과로 생기는 일(갱신 발급, 결과 검사, 세션 교체, 훅 사건의 처리)은 이 처리기가 하지 않는다.** 시작의 접수 영수증을 장부가 받은 뒤에만 갱신을 발급하는 조건(`ledger.md` "스케줄러")은 순환이 장부를 다시 읽어 지킨다. D-89에 따라 감독은 갱신한 임대를 반대 증거가 없으면 믿으므로, 종료 영수증이 이 처리기를 거쳐 장부에 닿아야 그 믿음이 끝난다.
