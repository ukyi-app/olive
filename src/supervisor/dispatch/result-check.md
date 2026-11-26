# 결과 검사의 한 박자 (`result-check.ts`)

`checking`에 머문 작업자 실행을 `ready_result` 또는 `failed_stopped`로 옮기는 감독 쪽 자리다. 실행마다 반영 전 결과 보고(`pendingReports`)를 모으고, 판정 자리(`resultVerdict`)가 통과로 낸 결과만 장부의 `markResult`로 판정한다. 반영 전 결과 보고가 없는 실행은 실행기가 대조된 조회 답에서 **바로 그 종료에 대해 `failed_stopped`라고 말했을 때만** `markResult(null)`로 판정한다(아래 "결과 없음 판정", D-147). 기한으로 판정하지 않는다. **판정은 확정이 아니고 게시 허가도 아니다.** 확정(`result_finalize`)은 수명 박자가 `settledResult`(판정 + 저장 자리와 함께 반영된 보고)를 보고 낸다(`life-loop.md` "확정"). 자리는 실행기의 정리 영수증으로만 풀린다.

순서기(`runtime/cycle.ts`)가 끊김 뒤, 수명 앞에서 부른다(`cycle.md` "한 박자의 차례" 3a). 그래서 같은 박자의 수명 박자가 이 판정을 보고 확정을 낸다. 소켓·타이머·시계·난수를 직접 쓰지 않는다. `now`는 순서기가 부르기 직전에 다시 읽은 장부 시계이고, 장부의 판정 시각(`updated_at`, 보고의 `applied_at`)으로만 쓴다.

## 공개 면

```ts
resultCheckTick(ports: ResultCheckPorts, now: number): ResultCheckTickResult   // 동기

ResultCheckPorts = {
  ledger: Pick<Ledger, "listRuns" | "pendingReports" | "markResult">   // 읽기 둘, 쓰기 하나
  intake: Pick<Restorer, "intakeOpen">   // 조립의 접수 문(박자 유효 문 + 복원기의 접수)
  beatValid?: () => boolean              // 장부 호출 바로 앞. 빠지면 늘 유효(조립은 반드시 넘긴다)
  stopped?: Pick<StoppedAnswerBook, "answers" | "retain">   // 실행기의 failed_stopped 답. 빠지면 결과 없음 판정 0(조립은 넘긴다)
}

StoppedAnswer = { runId, executorId, runGeneration, lastReceiptId }   // 대조된 답 하나의 그 실행 항목
createStoppedAnswerBook(): StoppedAnswerBook   // note(답 줄) · answers · retain(이 박자). 실행마다 마지막 하나, 메모리뿐
stoppedAnswersOf(outcome: ReceiptOutcome): StoppedAnswer[]   // 답 줄이 처리기 결과에서 적을 것을 고른다

createResultWaitAlarm(limitMs): { observe(checking, now): { runId, waitedMs }[] }   // 결과 기다림 경보(D-151). checking이 null이면 세지도 잊지도 않음
checkingRunIds(ledger): Set<runId> | null   // 경보·조회 정리의 감시 목록. listRuns 하나, 접수·유효 문을 보지 않음. 읽기 모름이면 null
RESULT_WAIT_ALERT_MS = 90_000   // 잠정 기본값

resultVerdict(reports: PendingResult[]): { kind: "pass", resultDigest, reportId } | { kind: "wait" } | { kind: "conflict", digests }

ResultCheckTickResult =
  | { kind: "not_run", reason: "now_malformed" | "tick_in_progress" | "intake_closed" }
  | { kind: "not_run", reason: "read_unknown", read: "runs" | "reports" }
  | { kind: "ran", runs: ResultCheckOutcome[], halted: null | "threw" | "intake_closed" | "beat_closed", haltedAt: string | null }
```

| 실행마다 (`ResultCheckOutcome`) | 뜻 |
|---|---|
| `judged` + `reportId`, `resultDigest`, `state` | 장부가 판정을 적었다고 답했다. `state`는 답의 실행 줄 상태(`ready_result`, 장부가 이미 판정을 마친 실행이면 그 뒤 상태) |
| `waiting` | 반영 전 결과 보고가 없다. 장부를 부르지 않았다(아래 "관리자 결정 대기"의 Q-H3) |
| `digest_conflict` + `digests`, `reports` | 서로 다른 digest의 반영 전 결과 보고가 있다. 장부를 부르지 않았다. 조립이 감독 기록에 `result_check_alert` 한 줄을 남긴다(실행마다 프로세스에서 한 번) |
| `refused` + `reportId`, `reason` | 장부가 거절했다(`transition_denied`, `reference_mismatch` 등). 박자는 다음 실행으로 간다 |
| `ledger_failed` + `reportId`, `reason` | 장부가 적었는지 모른다(`threw`: 장부 호출이 던짐, `malformed_answer`: 답이 정의 밖). 그 자리에서 `halted: "threw"` |
| `judged_no_result` + `lastReceiptId` | 결과 없음 판정(`markResult(null)`)을 장부가 적었다(답의 실행 줄이 `failed_stopped`, digest 없음). `lastReceiptId`는 근거가 된 답의 마지막 영수증 ID(= 장부의 종료 영수증 ID) |
| `no_result_refused` + `reason` | 결과 없음 판정을 장부가 거절했다(그 사이 다른 판정이 적혔으면 `transition_denied`). 박자는 다음 실행으로 간다 |
| `no_result_failed` + `reason` | 결과 없음 판정을 장부가 적었는지 모른다. 그 자리에서 `halted: "threw"` |

결과에는 `checking`인 작업자 실행만 실행 목록의 차례대로 있다. 세션 실행과 다른 상태의 실행은 보지 않는다. 결과 보고의 저장 자리와 장부의 문구는 싣지 않는다.

## 판단의 차례

1. **박자 전체의 전제.** 진행 중인 박자가 없음(있으면 `tick_in_progress`), `now`가 양의 안전 정수, 접수 문이 열림(`intake_closed`), 실행 목록(`listRuns`)과 반영 전 보고(`pendingReports`)를 앎. 하나라도 아니면 `not_run`이고 장부를 부르지 않는다.
2. **모름은 판정하지 않는다.** 두 목록 모두 `known: true`이고 배열이어야 하고, 줄마다 칸을 한 번씩 읽는다. 실행 줄은 실행 ID(UUID)·종류(`worker`·`session`)·상태(장부의 상태 이름), 보고 줄은 보고 ID(UUID)·동작(보고 셋 중 하나), 결과 보고면 실행 ID·저장 자리(빈 문자열 아님)·digest(소문자 16진수 64자리)다. **한 줄이라도 읽지 못하거나 꼴이 틀리거나 같은 ID의 줄이 둘이면 그 목록 전체가 모름이다**(`read_unknown`). 보고 한 줄을 건너뛰고 판정하면 그 실행의 다른 digest를 보지 못한 채 판정하고, 장부는 그 보고를 충돌 기록으로 닫는다(`ledger.ts`의 `markResult`).
3. **실행마다 판정 자리.** `checking`인 작업자 실행마다 그 실행의 반영 전 결과 보고(장부의 차례: 받은 시각, ID)를 `resultVerdict`에 넘긴다. 보고가 없으면 `wait`, digest가 둘 이상이면 `conflict`, 정확히 하나면 `pass`(그 digest의 첫 보고 ID). `wait`인 실행만 아래 "결과 없음 판정"의 대조를 본다. 대조가 맞지 않으면 `waiting`이다.
4. **판정 하나.** 인자 `{ runId, resultDigest, reportId, now }`를 만든 뒤 → `callAfterGate`(장부 포트 객체·`markResult`·인자 원소 얻기 → 문 → 호출 하나, `send-gate.ts`). 문은 접수 문 → 박자 유효 문 차례다(`gateOpen`). 접수 문을 얻기 뒤에 두어 얻기의 접근자 안에서 정지가 적용돼도 적지 않고(장부는 판정을 정지 중에도 받는다), 박자 유효 문을 맨 끝에 두어 접수 문 안의 읽기에 쓴 시간까지 박자 기한에 든다. 문 뒤에는 외부 코드가 없고 읽기부터 호출까지 `await`가 없다. 접수 문이 닫혔으면 `halted: "intake_closed"`, 유효 문이 닫혔으면 `halted: "beat_closed"`이고 그 실행의 장부 호출은 0회다.
5. **답.** 칸마다 한 번만 읽는다. `ok: false`와 장부의 거절 이름이면 `refused`. `ok: true`면 답의 실행 줄이 같은 실행 ID·같은 digest·판정 뒤 상태(`ready_result`·`cleanup_pending`·`finalized`)일 때만 `judged`. 그 밖은 `ledger_failed`이고 박자를 멈춘다. 결과 없음 판정은 같은 문·같은 호출 한 줄(`callMark`)을 지나고, 답의 실행 줄이 같은 실행 ID·`failed_stopped`·digest `null`일 때만 `judged_no_result`다.
6. **답 자리 줄이기.** 멈추지 않고 돈 박자의 끝에 그 박자의 `checking` 실행 밖의 답을 버린다(`retain`). `checking`으로 돌아오는 전이가 없어 버린 답이 다시 쓰일 곳이 없다. 멈춘 박자는 목록이 일부라 버리지 않는다.

## 정한 것

- **`reportId`를 늘 넘긴다.** 장부가 그 보고가 이 실행의 반영 전 보고이고 digest가 같은지 대조하므로(아니면 `reference_mismatch`) 판정이 이 박자가 본 보고를 정확히 가리킨다. 확정을 여는 데에는 필요 없다: 빠져도 장부는 판정하면서 그 실행의 반영 전 결과 보고를 모두 반영해 `settledResult`가 값을 낸다(`life-loop.md` "뒤 조각이 지킬 것"). 같은 digest의 보고가 여럿이면 첫 보고의 ID를 넘기고 나머지는 장부가 같은 판정에서 함께 반영한다.
- **digest가 둘 이상이면 판정하지 않는다.** 어느 결과를 택할지 감독이 정할 근거가 없다(결과 보관은 둘 다 됐다). 장부의 `markResult`에 맡기면 판정한 digest 밖의 보고를 충돌 기록으로 닫아 되돌릴 수 없다. 그래서 반영 전 그대로 두고 경보만 남긴다. 그 실행은 관리자가 볼 때까지 `checking`으로 자리를 쥔다.
- **접수 문을 본다.** 복원 5단계 전, 정지 중, 허가 폐기 때는 판정하지 않는다. 장부는 판정을 정지 중에도 받지만(쓰기 모드 `continue`), 수명 박자가 확정을 접수가 열렸을 때만 적으므로 판정만 앞당겨도 자리는 풀리지 않는다. 정지가 풀린 뒤 복원 판정과 같은 문을 지나서 판정한다. 박자 처음과, 장부 호출마다 그 바로 앞의 문 안에서 본다(앞 실행의 장부 호출이나 장부 포트를 얻는 접근자 안에서 닫힐 수 있다).
- **박자 안에서 같은 실행은 한 번만 판정한다.** 실행 목록에 같은 실행 ID가 둘이면 목록 전체가 모름이다. 판정이 끝난 실행은 다음 박자의 목록에서 `checking`이 아니라 다시 판정하지 않는다.
- **재시작 뒤에도 같은 길이다.** 복원 3단계는 `checking` 실행(`resumeChecks`)과 반영 전 보고를 다시 꺼내지만 판정하지 않는다. 이 박자가 매 박자 장부에서 같은 두 목록을 읽으므로 따로 이어 받을 것이 없다.

## 결과 없음 판정(D-147)

보고가 끝내 오지 않는 `checking` 실행을 자동으로 "결과 없음 → 실패"로 옮기는 길은 이것 하나다. **근거는 감독이 본 부재(기한 안에 보고가 안 옴)가 아니라 실행기의 말이다.**

- **실행기의 말.** 실행기는 결과 보고가 있는 실행을 `ready_result`, 종료 확인 뒤 결과 보고가 없는 실행을 `failed_stopped`로 답하고, `failed_stopped` 뒤에 결과 보고를 만들지 않는다(`src/contract/v1.md` "실행 상태 항목", 실행기 시험 `test/executor/failed-stopped-answer.test.ts`). 그래서 `failed_stopped`는 되돌아가지 않는 말이다. 낡은 답(먼저 낸 조회의 늦은 답, 같은 요청 ID로 두 번 실은 조회의 어느 답)이어도 아직 대조되는 답이면 참이다. 낡은 `checking`·`ready_result` 답은 근거가 아니다(판정하지 않으므로 낡아도 해가 없다).
- **조회.** 수명 박자가 판단이 기다림인 `checking` 실행에 같은 실행 ID로 `status_query`를 낸다(`life-loop.md` "조회", `cause: "result_wait"`). 간격은 다른 조회와 같은 `answerTimeoutMs`다. `failed_stopped`·`ready_result`는 실행기가 인사(`hello`)에 반드시 싣는 상태(슬롯을 쥔 상태)가 아니라, 묻지 않으면 이 말을 들을 길이 보장되지 않는다.
- **대조된 답.** 영수증 처리기(`receipts.ts`)가 `status_matched`로 낸 답이다: `in_reply_to`가 받은 때 등록부에 있던 조회의 요청 ID이고, 그 조회를 받은 실행기가 서명했고, 답의 실행 ID 집합이 물은 집합과 같고, 그 조회를 실은 연결에서 왔고, 넘기기 직전에 그 연결이 지금 인정된 연결이다. 답 줄(`runtime/answers.ts`)은 그 결과에서 **이번 답 자신이 장부에 반영됐을 때(`settled`의 마지막이 `applied`)만** `stoppedAnswersOf`로 `failed_stopped` 항목을 골라 답 자리에 적는다. 인정이 끝난 연결의 답(`status_not_current`), 대조되지 않은 답(`unknown_query`·`other_executor`·`runs_mismatch`·`other_connection`), 받은 때 등록부를 읽지 못한 답, 밀린 사본, 저장되지 않은 답은 적지 않는다.
- **판정 조건.** 같은 박자의 같은 동기 구간에서 읽은 그 실행 줄이 `checking`이고 반영 전 결과 보고가 하나도 없으며, 답 자리의 그 실행 ID 항목이 낸 쪽 = 실행 줄의 지정 실행기, 세대 = 실행 줄의 실행 세대, `last_receipt_id` = 실행 줄의 종료 영수증 ID(`stopReceiptId`)일 때만 `markResult({ runId, resultDigest: null, now })`. 다른 실행의 항목은 그 실행 ID로만 찾으므로 이 실행에 닿지 않는다. 그 실행 줄의 칸을 읽지 못하면 그 실행은 결과 없음 판정을 하지 않는다(보고 판정은 그대로).
- **보고가 늘 먼저다.** 장부의 `markResult(null)`은 그 실행의 반영 전 결과 보고를 반영된 것으로 닫는다(`ledger.ts`). 그래서 반영 전 결과 보고가 하나라도 있으면(통과든 충돌이든) 결과 없음 판정을 하지 않는다.
- **판정 뒤.** 실행은 `failed_stopped`(종료 영수증 exit `completed`)이고, 같은 박자의 수명 박자가 D-114 본문(`failed`, 요청 취소가 적혔으면 `cancelled`, `stored_at`은 이 판정의 `now`)으로 실패 확정을 적고 내보낸다(`life-loop.md` "실패 확정"). 자리는 실행기의 정리 영수증으로 풀린다.
- **왜 이 박자에서 적는가.** 장부의 `markResult`를 부르는 자리를 하나로 두어(`callMark` 한 줄) 보고 판정과 같은 문(접수 → 박자 유효 문)을 지나고, "반영 전 보고가 없다"는 읽기와 쓰기가 같은 동기 구간에 있다. 답 줄에서 바로 적으면 그 읽기와 문을 다시 만들어야 하고 박자 유효 문 밖에서 장부를 쓴다. 답 자리에 머무는 동안 낡아도 위의 까닭으로 거짓이 되지 않는다.

**자동으로 풀리지 않고 자리를 쥐는 것**(결과는 잃지 않는다. 관리자 자리 풀기는 다음 조각):

- 답하지 않거나 늘 늦게 답하는(조회가 등록부에서 끝난 뒤에 오는) 실행기, 연결이 없는 실행기.
- `not_known`·`unknown_running`·`checking` 답, `ready_result`라는데 감독이 보관하지 못한 보고.
- 종료 뒤에 그 실행의 다른 영수증이 생긴 실행. 실행기는 종료 뒤에 받은 취소(`task_cancel`)도 접수 영수증을 내고 그 ID가 `last_receipt_id`가 된다(실행기 시험이 고정한다). 그러면 답의 마지막 영수증 ID가 장부의 종료 영수증 ID와 달라 판정하지 않는다.
- 감독이 다시 뜬 직후: 답 자리는 메모리뿐이라 비고, 다음 조회의 답이 다시 채운다.

## 결과 기다림 경보(D-151)

`checking`에 한도만큼 머문 실행마다 감독 로그에 경보 한 줄을 남긴다. 판정은 하지 않는다(숫자가 틀려도 결과를 잃지 않는다).

- **줄의 꼴.** `result_check_alert` `{ reason: "result_wait_overdue", runId, waitedMs }`(digest 충돌 경보와 같은 이름, D-127 장부 경보와 같은 감독 로그 길). 조립(`runtime/boot.ts`의 `watchResultWait`)이 박자 기록 뒤에 낸다.
- **감시 목록.** 박자 뒤에 장부의 `listRuns` 하나로 읽은 `checking` 작업자 실행이다(`checkingRunIds`). 이 박자의 결과에 묶지 않는다: 복원 5단계가 접수를 닫은 채 끝나면(`peer_unconfirmed` 등) 감독과 수명 박자는 돌지만 이 박자는 늘 `not_run:intake_closed`라, 결과에 묶으면 그동안 경보가 없다. 목록을 읽지 못한 박자는 세지도 잊지도 않는다.
- **시각.** 순서기가 그 박자의 결과 검사에 넘긴 시각을 다시 쓰고 시계를 따로 읽지 않는다. 공유 시계의 `read()`는 하한을 올리므로, 경보의 읽기 하나가 앞선 값을 내면 다음 박자의 결과 검사·배정이 `clock_untrusted`로 건너뛴다. 결과 검사에 시각을 넘기지 않은 박자(복원 전, 박자 처음의 시계가 `ok`가 아님)는 경보를 건너뛰고 목록도 읽지 않는다: 복원 2단계 앞의 기다림 동안 장부를 읽지 않아야 한다(D-142). 그 박자의 조회 항목 정리는 수만 줄인다.
- **한도.** 설정 `resultWaitAlertMs`(양의 정수 ms, 틀리면 기동하지 않는다). 없으면 `RESULT_WAIT_ALERT_MS` = 90초이고 **잠정값**이다: T1 다음 바퀴에서 `checking`에 머문 시간을 잰 뒤 정한다.
- **세는 시작.** 이 감독 프로세스가 그 실행을 `checking`으로 처음 본 박자의 시각(위 "시각")부터 센다. 감독이 다시 뜨면 다시 센다(경보가 늦어질 뿐이다).
- **한 번만.** 같은 실행에는 프로세스에서 한 번만 낸다. 보고·답이 끝내 오지 않는 실행은 관리자가 손댈 때까지 박자마다 같은 상태라 거르지 않으면 박자 수만큼 같은 줄이 쌓인다. 감시 목록에서 빠진 실행(판정 등으로 `checking`을 떠남)은 기억에서 뺀다(돌아오는 전이가 없다). 감독이 다시 뜨면 한 줄을 더 남긴다.

## 관리자 결정 대기

판정의 갈림은 모두 `resultVerdict` 한 함수에 있다. 답에 따라 이 함수를 바꾼다.

- **Q-H1(감독이 직접 검사할 범위):** 지금은 "반영 전 결과 보고가 정확히 한 digest인가"만 본다. 역할 일치·출처 참조·비밀 패턴은 보지 않는다.
- **Q-H3(보고 없는 `checking`):** D-147·D-151로 정했다. 실행기의 `failed_stopped` 답으로만 `markResult(null)`(위 "결과 없음 판정"), 기한은 경보로만(위 "결과 기다림 경보"). 경보 한도의 값은 잠정이다.
- **Q-H5(결과 `outcome`이 `failed`·`needs_input`인 결과):** 장부의 보고 줄에는 결과의 `outcome`이 없고 이 박자는 보관소의 본문을 읽지 않으므로 digest가 있는 결과는 모두 통과다. `outcome`으로 가르기로 하면 이 함수와 함께 보관소 읽기 포트가 필요하다.
- **Q-H4(`failed_stopped` 확정 본문):** D-114로 정했고 수명 박자가 장부 이력(`failedStop`)으로 낸다(`life-loop.md` "실패 확정"). 이 박자가 만드는 `failed_stopped`는 결과 없음 판정 하나다.

## 시험

`test/supervisor/dispatch/result-check.test.ts`(실제 임시 장부), `test/supervisor/dispatch/result-check-stopped.test.ts`(결과 없음 판정·경보, 실제 답 줄·등록부·수명 박자로 끝까지), `test/supervisor/runtime/cycle.test.ts` "결과 검사 박자", `test/supervisor/runtime/boot-result-check.test.ts`(조립), `test/executor/failed-stopped-answer.test.ts`(실행기의 `failed_stopped` 뜻).

| 무엇 | 시험 |
|---|---|
| 결과 보고 → 판정 → 같은 박자의 수명 박자가 확정을 적고 내보냄 | "한 줄: 결과 보고 → 판정 → 확정", 조립 "판정하고 같은 박자의 수명 박자가 확정을" |
| 같은 digest 둘은 첫 보고로 한 번, 다음 박자의 판정 0 | "같은 digest의 보고가 둘이면" |
| 다른 digest 섞임 → 판정 0, 경보 한 줄 | "다른 digest가 섞이면", 조립 "경보는 그 실행에 한 줄만" |
| 보고 없음 → 기다림, 세션·다른 상태는 보지 않음 | "보고가 없는 checking은 기다린다" |
| 복원 전·정지 중·장부 읽기 모름 → 0 | "판정하지 않는 때", 순서기 "복원 전·발급 닫힘이면" |
| 장부 호출 직전의 접수 문·유효 문 → 그 실행부터 0 | "장부 호출 직전의 접수 문이나 박자 유효 문이 닫히면" |
| 재시작(복원 3단계) 뒤 남은 `checking` | "재시작" |
| 장부 쓰기는 `markResult` 하나, 시계·난수·송신 없음 | "정적", `start-send.test.ts`의 `callAfterGate` 줄 목록 |
| 그 종료의 `failed_stopped` 답 → `markResult(null)` 한 번 → 같은 줄에서 수명 박자의 실패 확정 | "결과 없음 판정"의 첫 시험, "답 줄에서 실패 확정까지"의 첫 시험, 조립 "같은 답 자리를" |
| 영수증 ID·낸 쪽·세대가 다름, 무응답, 다른 실행의 답 → 장부 호출 0 | "하나라도 장부의 그 종료와 다르면", "답이 없으면" |
| `ready_result`·`not_known`·`unknown_running`·`checking` 답 → 0 | "답 줄에서 실패 확정까지"의 둘째 시험 |
| 다른 실행을 물은 조회(F9), 끝난 조회의 늦은 답(F12), 인정이 끝난 연결, 등록부를 읽지 못한 답(F10·F14) → 0 | "다른 실행을 물은 조회의 답" |
| 늦어도 대조되는 `failed_stopped`는 판정(단조) | "먼저 낸 조회의 늦은 답도" |
| 보고가 있으면 보고가 먼저, 충돌이면 둘 다 0 | "반영 전 결과 보고가 있으면" |
| 경보 한 번, 목록에서 빠지면 잊음, 목록을 읽지 못한 박자는 줄이지 않음, 한도 설정 | "결과 기다림 경보", 조립 "경보 한도만큼 머문", "경보 한도가 양의 정수가 아니면" |
| 접수가 닫힌 5단계에서도 경보 한 줄·판정 0 | 조립 "복원 5단계가 접수를 닫은 채 끝나도" |
| 경보가 공유 시계를 읽지 않음(다음 박자의 하한·결과 검사·배정 보존) | 조립 "경보는 공유 시계를 다시 읽지 않는다" |
| 답하지 않는 실행기의 `result_wait` 조회 항목은 실행마다 3개까지, `checking`을 떠나면 0. 받은 답이 쥔 항목은 남김 | 조립 "답하지 않는 실행기에 낸 결과 기다림 조회는", `runtime/result-wait-queries.test.ts` |

## 남는 한계

- **충돌한 실행은 자리를 쥔다.** 경보 뒤에 그 실행을 닫는 길은 아직 없다(관리자 닫기는 종료 확인이 있는 실행을 받지 않는다, `ledger.md`).
- **보고도 그 종료의 `failed_stopped` 답도 오지 않는 `checking`은 자리를 쥔다**(위 "자동으로 풀리지 않고 자리를 쥐는 것"). 경보 한 줄이 남고, 푸는 길은 관리자 닫기(다음 조각)다.
- **답하지 않는 실행기의 `result_wait` 조회 항목은 실행마다 최근 3개만 남는다.** 연결이 살아 있고 답이 없으면 `answerTimeoutMs`마다 새 조회가 나가고, 조립이 박자마다 그 실행의 최근 3개 밖 항목을, 그 실행이 `checking`을 떠나면 남은 항목을 모두 끝낸다(`runtime/query-book.ts`의 `createResultWaitQueries`, `runtime/answers.ts`의 `releaseQueries`). 받아 줄에 선 답이 쥔 항목은 남기고 다음 박자에 다시 끝낸다. 함정: 간격을 답의 왕복 시간보다 훨씬 짧게 잡으면 늦은 답의 항목이 먼저 끝나 `unknown_query`가 된다(판정이 늦어질 뿐 다음 조회로 다시 묻는다). 다른 사유(`intent`·`stop_already_recorded`)의 조회는 이 정리 밖이다(연결이 철회될 때 끝난다).
- **판정과 장부 호출 사이에 새 보고가 끼는 것은 막지 못한다.** 박자는 동기이고 보고는 소켓 사건으로만 오므로 실제로는 끼지 않는다. 장부 포트 안에서 다시 보고를 적는 경우는 장부가 다른 digest의 보고를 충돌로 닫는다.
- **경보 기억은 메모리뿐이다.** 감독이 다시 뜨면 같은 충돌에 경보를 한 줄 더 남긴다.
