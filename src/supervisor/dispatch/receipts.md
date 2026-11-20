# 영수증·보고 처리기 (`receipts.ts`)

연결 판단(`src/supervisor/transport/connections.ts`)이 낸 `forward` 하나를 받아 장부 연산을 부르고, 그 결과로 ack 초안을 만들거나 만들지 않거나 구별된 거절을 낸다. 순수 판단이다: 소켓·타이머·시계·난수를 직접 쓰지 않는다. 장부와 난수는 포트로, 지금 시각과 감독의 정지 세대는 인자로 받는다. ack는 초안(`envelopes.ts`의 `ackDraft`)까지만 만들고, 봉하기(`sealDraft`)와 싣기는 부르는 순환이 한다. 입력 객체를 바꾸지 않는다.

## 보장 넷

이 모듈이 주장하는 것은 아래 넷뿐이다.

1. **낸 쪽과 세대는 검증 결과에서만 온다.** 장부에 넘기는 `from`은 검증된 봉투 머리의 `sender`와 `run_generation`이다. 본문의 값(본문이 주장하는 실행기 이름이나 세대)으로 대신하지 않는다. 낸 쪽이 받아들여지는지, 세대가 맞는지는 장부가 본다(`sender_mismatch`, `run_generation_mismatch`). 장부의 규칙은 이렇다: 일반 영수증·보고는 그 실행의 지정 실행기만 낼 수 있다. 세션 인수 영수증(`receipt_session_takeover`)은 앞 세션의 지정 실행기이거나 대기 중인 세션 실행의 지정 실행기가 낼 수 있고, 같은 인수의 재전송은 처음 낸 쪽만 ack를 받는다(`src/ledger/ledger.md` "세션 증거"). 인수의 ack는 인수 증거를 저장했다는 확인일 뿐이고, 앞 세션의 종료나 다음 세션의 시작을 허가하지 않는다. 이 모듈은 그 검사를 복사하지 않는다. ack의 받는 쪽도 같은 머리의 `sender`다.
2. **장부가 받은 것에만 ack.** 장부가 `ok`를 돌려준 영수증·보고에만, 장부가 돌려준 그 id로 ack 초안을 만든다. 장부가 거절했거나, 던졌거나, 답이 꼴에 맞지 않으면(`ok`인데 `delivery`가 `new`·`duplicate`가 아니거나 `ack`가 넘긴 id와 다름, 거절 사유가 장부의 `REFUSALS` 밖) ack가 없어 실행기가 다시 보낸다. 재전송은 장부가 `delivery: "duplicate"`(이미 반영함)로 받고, 그때 부르는 쪽이 감독의 정지 세대를 알고(`null`이 아님) `ackDraft`가 초안을 만들면 ack를 다시 만든다: 앞의 ack가 유실됐을 수 있다. 정지 세대가 계속 `null`이면 재전송에도 계속 ack가 없다. 한 `forward` 안에서 장부 호출이 먼저이고, `ackDraft`(난수 포트를 쓰는 유일한 자리)는 장부가 `ok`를 돌려준 뒤에만 불린다.
3. **`status_report`는 감독이 낸 조회의 답일 때만 받는다.** 부르는 쪽이 넘긴 "답을 기다리는 조회" 목록에서 `in_reply_to`가 그 요청 ID인 것을 찾고, 그 조회를 받은 실행기(초안의 `recipient`)가 서명한 보고만 받는다. 답의 실행 ID 집합이 물은 실행 ID 집합과 같아야 한다. 아니면 `status_unmatched`이고 장부를 부르지 않는다. 받은 보고는 장부에 반영하지 않는다(아래 "운영 중 상태 보고의 장부 반영").
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
| `status_report` | 둘 다 | 없음 | `status_reply` | 부르지 않음 | 없음(상태 보고에는 id가 없고 실행기가 다시 보내지 않는다) |
| `hello`, `stop_sync_request` | 둘 다 | 없음 | 거절 `connection_layer` | 부르지 않음 | 없음 |
| 감독이 내는 동작(지시 여섯, `status_query`, `ack`, `stop_sync_reply`) | 감독 | | 거절 `not_executor_action` | 부르지 않음 | 없음 |
| 계약에 없는 이름 | | | 거절 `unknown_action` | 부르지 않음 | 없음 |

본문에서 읽는 칸의 타입이 틀리면 `rejected`·`body_malformed`(`field`에 칸 이름), `forward`·머리가 틀리면 `rejected`·`input_malformed`다. `now`는 장부에 쓸 동작(영수증 다섯, 훅·세션 깨짐 보고)에서만 검사하고 틀리면 `input_malformed`다. `status_report`와 `report_result`는 `now`를 읽지 않으므로 `now`가 틀려도 각각 대조 결과와 `result_not_supported_yet`을 낸다(둘 다 장부·난수를 부르지 않는다). 본문 전체의 v1 형식 검사는 연결 판단이 이미 끝냈고, 이 모듈은 분기마다 필요한 칸만 읽는다. 예외를 던지지 않는다. 값의 꼴(UUID, digest 등)은 계약 검증과 장부가 다시 본다. 장부가 입력을 거부하며 던진 것(`LedgerInputError`)은 `ledger_failed`·`threw`다.

장부 입력으로 옮기지 않는 본문 칸: `started_at`, `stopped_at`, `remaining_processes`(계약이 0만 받는다), `cleaned_at`. 장부의 `ReceiptInput`에 그 칸이 없다. `bodyDigest`는 머리의 `body_digest`이고 `now`는 부르는 쪽이 넘긴 값이다.

## 공개 면

| 이름 | 꼴 |
|---|---|
| `handleForward(input, ports)` | `ForwardInput` → `ReceiptOutcome` |
| `ForwardInput` | `forward`(연결의 `forward` 출력, `verified`만 읽음), `now`(장부 시계와 같은 시계), `stopGeneration`(감독의 지금 정지 세대, 모르면 `null`), `pendingQueries` |
| `PendingQuery` | `requestId`, `recipient`, `runIds`. `statusQueryDraft`의 초안에서 그대로 옮긴다 |
| `ReceiptPorts` | `ledger: ReceiptLedger`, `random: Random`(`ports.ts`) |
| `ReceiptLedger` | `Pick<Ledger, "applyReceipt" \| "recordReport">`. 실제 장부가 그대로 맞는다 |
| `EXECUTOR_ACTION_HANDLING` | 위 표의 동작 → 처리 |
| `REJECT_REASONS`, `STATUS_UNMATCHED_REASONS` | 구별된 거절의 이름 |

`ReceiptOutcome`:

| `outcome` | 뜻 | ack 초안 |
|---|---|---|
| `ack` | 장부가 받았다(`delivery`: `new` 이번에 반영, `duplicate` 이미 반영) | 있음(`ack`) |
| `applied_without_ack` | 장부는 받았지만 ack 초안을 만들지 못했다(`stop_generation_unknown`, `ackDraft`의 거절 사유, `draft_threw`). 실행기가 다시 보내면 장부가 `duplicate`로 받고, 그때 정지 세대를 알고 초안 생성에 성공하면 ack한다 | 없음 |
| `ledger_refused` | 장부의 거절 사유 그대로 | 없음 |
| `ledger_failed` | 장부가 던졌다(`threw`) 또는 답이 꼴에 맞지 않는다(`malformed_answer`) | 없음 |
| `status_matched` | 기다리는 조회의 답이다. `ledger: "not_reflected"`, `runs`는 입력의 사본 | 없음 |
| `status_unmatched` | `unknown_query`, `other_executor`, `runs_mismatch` | 없음 |
| `result_not_supported_yet` | 결과 보고. 장부에 넘기지 않았다 | 없음 |
| `rejected` | 위 표의 거절과 꼴 거절 | 없음 |

## 운영 중 상태 보고의 장부 반영

**장부에 운영 중의 공개 연산이 없다.** 장부의 상태를 상태 보고로 바꾸는 길은 재시작 복원 2·3단계뿐이고(`src/ledger/ledger.md` "스케줄러가 쓰는 읽기"의 상태 조회 줄), 점유를 적는 `holdSlots`는 복원 열쇠가 있어야 부를 수 있다. 그래서 이 모듈은 대조까지만 하고 `status_matched`(`ledger: "not_reflected"`)를 돌려준다. 장부 밖 실행의 항목을 장부에 실행으로 올리지 않는다(계약 v1 "장부 밖 실행의 세대는 닫는 데만 쓴다").

반영하려면 장부에 이런 꼴의 연산이 필요하다(장부 작업의 몫):

```ts
applyStatusReport(
  input: { inReplyTo: string; runs: readonly RunStatus[]; now: number },
  from: { sender: string },
): {
  ok: true;
  changed: { runId: string; from: LedgerRunState; to: LedgerRunState }[];
  outsideLedger: { runId: string; runGeneration: number }[];
} | Refused
```

- `from.sender`는 검증된 봉투의 낸 쪽이고, 장부는 실행마다 그 실행의 지정 실행기와 같을 때만 본다. `run_generation`은 장부의 세대와 같아야 한다(계약 검증이 아는 실행은 이미 대조했다).
- 장부에 없는 실행은 실행 줄로 올리지 않는다. 닫을 대상(실행 ID와 세대)으로만 `outsideLedger`에 돌려준다(`runsOutsideLedger`와 같은 규칙). 이 처리기의 `status_matched`도 대조한 `runs`를 그대로 돌려주므로, 장부 연산이 생기기 전에는 부르는 쪽이 그 `runs`에 `runsOutsideLedger`를 적용해 같은 목록을 얻는다.
- `not_known`은 종료의 증거가 아니다. 무엇을 종료 증명으로 볼지는 아직 정하지 않은 관리자 결정이다(`ledger.md` "뒤 작업이 알아야 할 것"의 "실제 연결").
- 상태 보고에는 실행기의 임대 끝이 없으므로 갱신의 근거로 쓰지 않는다.

## 정한 것

- **ack의 정지 세대는 감독의 값이다.** 머리의 `stop_generation`이 아니라 부르는 쪽이 넘긴 감독의 지금 정지 세대(복원기의 `stopGeneration()`)를 싣는다. 모르면(`null`) 장부는 반영하고 ack는 만들지 않는다(종료·영수증의 기록은 막지 않는다, `ledger.md` "못 씀"). 실행기가 다시 보내면 장부가 `duplicate`로 받고, 그때 정지 세대를 알고 초안 생성에 성공하면 ack한다.
- **장부의 ack id가 넘긴 id와 다르면 꼴이 틀린 답이다.** 다른 id의 ack는 다른 영수증의 재전송을 멈추게 한다.
- **영수증 하나에 ack 초안 하나.** 여러 id를 한 ack에 모으는 일은 하지 않는다.
- **상태 보고는 실행 ID 집합까지 대조한다.** 실행기는 물은 실행 ID마다 하나씩 답한다(`src/executor/worker.ts`의 `onStatus`). 다른 집합이면 그 조회의 답으로 보지 않는다.
- **`report_rule_check`는 받지 않는다.** 장부의 `recordReport`가 받는 꼴이 아니고(`applyRuleCheck`, `from`도 낸 쪽 이름 하나뿐), 그 증거를 쓰는 세션 계약 작업이 아직 없다. 지금 연결 판단은 작업자 실행기의 맞춤 요청만 받는다(`connections.ts`의 `syncRequest`).
- **본문의 남는 칸은 읽지 않는다.** v1의 본문 해석이 모르는 칸을 이미 거절한다. 이 모듈은 읽는 칸의 타입만 본다.

## 이 모듈에 없는 것

순환(언제 부르고 결과를 어디로 보내는가), 소켓과 ack의 봉하기·싣기, 기다리는 조회 목록의 보관과 만료, 결과 보관(S6)과 결과 보고의 반영, 운영 중 상태 보고의 장부 반영, 규칙 확인의 반영.

## 뒤 조각이 지킬 것

- **`status_report`를 이 처리기로 넘긴다.** 지금 연결 판단은 검증된 `status_report`를 `forward`가 아니라 점유 응답(`occupancy`, `partial`)으로만 내고, 그 출력에는 `in_reply_to`가 없다(`connections.ts`의 `envelope`). 운영 중 조회의 답을 대조하려면 순환이나 연결 쪽이 검증된 `status_report`를 `forward` 꼴로 여기에 넘겨야 한다.
- **기다리는 조회는 `statusQueryDraft`의 초안에서 옮긴다.** `requestId`·`recipient`·`body.run_ids`를 그대로 넣는다. 같은 초안을 다시 봉해 보내면 실행기가 매번 답하므로 같은 `in_reply_to`의 답이 여럿 올 수 있다. 목록에서 언제 지울지는 순환이 정한다.
- **ack는 장부가 받은 것만 싣는다.** `ack` 결과의 초안만 봉해서 보낸다. `applied_without_ack`·`ledger_refused`·`ledger_failed`에 대해 ack를 따로 만들지 않는다. ack는 재전송을 멈추라는 뜻일 뿐이고 종료·정리·실행 허가가 아니다.
- **`now`와 정지 세대는 장부와 같은 시계·같은 복원기에서 읽는다.** 정지 세대는 이 처리기를 부르는 순간의 값이다. 연결 판단이 봉투를 받아들인 때의 값을 다시 쓰지 않는다.
- **결과 보고(S6):** 보관 → `recordReport`(`storedRef`·`resultDigest`) → ack 순서이고 그 사이에 await가 없어야 한다. 그때 이 표의 `report_result` 줄이 바뀐다.
- **장부 반영의 결과로 생기는 일(갱신 발급, 결과 검사, 세션 교체, 훅 사건의 처리)은 이 처리기가 하지 않는다.** 시작의 접수 영수증을 장부가 받은 뒤에만 갱신을 발급하는 조건(`ledger.md` "스케줄러")은 순환이 장부를 다시 읽어 지킨다. D-89에 따라 감독은 갱신한 임대를 반대 증거가 없으면 믿으므로, 종료 영수증이 이 처리기를 거쳐 장부에 닿아야 그 믿음이 끝난다.
