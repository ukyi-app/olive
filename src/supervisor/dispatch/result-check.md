# 결과 검사의 한 박자 (`result-check.ts`)

`checking`에 머문 작업자 실행을 `ready_result`나 `failed_stopped`로 옮기는 감독 쪽 자리다. 실행마다 반영 전 결과 보고(`pendingReports`)를 모으고, 판정 자리(`resultVerdict`)가 통과로 낸 결과만 장부의 `markResult`로 판정한다. 반영 전 결과 보고 없이 기한이 지난 실행은 `markResult(null)`로 결과 없음을 판정한다(D-113). **판정은 확정이 아니고 게시 허가도 아니다.** 확정(`result_finalize`)은 수명 박자가 `settledResult`(판정 + 저장 자리와 함께 반영된 보고)를 보고 낸다(`life-loop.md` "확정"). 자리는 실행기의 정리 영수증으로만 풀린다.

순서기(`runtime/cycle.ts`)가 끊김 뒤, 수명 앞에서 부른다(`cycle.md` "한 박자의 차례" 3a). 그래서 같은 박자의 수명 박자가 이 판정을 보고 확정을 낸다. 소켓·타이머·시계·난수를 직접 쓰지 않는다. `now`는 순서기가 부르기 직전에 다시 읽은 장부 시계이고, 장부의 판정 시각(`updated_at`, 보고의 `applied_at`)과 기한 비교에만 쓴다. 기한은 정책 인자(`ResultCheckPolicy`)이고 운영 값은 감독 설정 한 자리(`src/main/supervisor.ts`의 `RESULT_CHECK`, T1 실측 전의 시험 숫자 60000ms)다.

## 공개 면

```ts
resultCheckTick(ports: ResultCheckPorts, now: number, policy?: ResultCheckPolicy): ResultCheckTickResult   // 동기

ResultCheckPolicy = { reportWaitMs: number }   // 양의 안전 정수. 빠지면 결과 없음 판정 없음(조립은 반드시 넘긴다)

ResultCheckPorts = {
  ledger: Pick<Ledger, "listRuns" | "pendingReports" | "markResult">   // 읽기 둘, 쓰기 하나
  intake: Pick<Restorer, "intakeOpen">   // 조립의 접수 문(박자 유효 문 + 복원기의 접수)
  beatValid?: () => boolean              // 장부 호출 바로 앞. 빠지면 늘 유효(조립은 반드시 넘긴다)
}

resultVerdict(reports: PendingResult[]): { kind: "pass", resultDigest, reportId } | { kind: "wait" } | { kind: "conflict", digests }

ResultCheckTickResult =
  | { kind: "not_run", reason: "now_malformed" | "policy_malformed" | "tick_in_progress" | "intake_closed" }
  | { kind: "not_run", reason: "read_unknown", read: "runs" | "reports" }
  | { kind: "ran", runs: ResultCheckOutcome[], halted: null | "threw" | "intake_closed" | "beat_closed", haltedAt: string | null }
```

| 실행마다 (`ResultCheckOutcome`) | 뜻 |
|---|---|
| `judged` + `reportId`, `resultDigest`, `state` | 장부가 판정을 적었다고 답했다. `state`는 답의 실행 줄 상태(`ready_result`, 장부가 이미 판정을 마친 실행이면 그 뒤 상태) |
| `waiting` | 반영 전 결과 보고가 없고 기한 전이다(정책 인자가 없거나 실행 줄의 `updatedAt`을 읽지 못한 때도). 장부를 부르지 않았다 |
| `no_result` + `checkingSince`, `state` | 반영 전 결과 보고 없이 기한이 지나 장부가 결과 없음 판정을 적었다고 답했다(`state`는 `failed_stopped`). `checkingSince`는 판정에 쓴 실행 줄의 `updatedAt`이다. 조립이 감독 기록에 `result_check_alert`(`reason: "no_result"`) 한 줄을 남긴다 |
| `digest_conflict` + `digests`, `reports` | 서로 다른 digest의 반영 전 결과 보고가 있다. 장부를 부르지 않았다. 조립이 감독 기록에 `result_check_alert` 한 줄을 남긴다(실행마다 프로세스에서 한 번) |
| `refused` + `reportId`, `reason` | 장부가 거절했다(`transition_denied`, `reference_mismatch` 등). 결과 없음 판정이면 `reportId`는 `null`이다. 박자는 다음 실행으로 간다 |
| `ledger_failed` + `reportId`, `reason` | 장부가 적었는지 모른다(`threw`: 장부 호출이 던짐, `malformed_answer`: 답이 정의 밖). 그 자리에서 `halted: "threw"` |

결과에는 `checking`인 작업자 실행만 실행 목록의 차례대로 있다. 세션 실행과 다른 상태의 실행은 보지 않는다. 결과 보고의 저장 자리와 장부의 문구는 싣지 않는다.

## 판단의 차례

1. **박자 전체의 전제.** 진행 중인 박자가 없음(있으면 `tick_in_progress`), `now`가 양의 안전 정수, 정책 인자가 있으면 기한이 양의 안전 정수(`policy_malformed`), 접수 문이 열림(`intake_closed`), 실행 목록(`listRuns`)과 반영 전 보고(`pendingReports`)를 앎. 하나라도 아니면 `not_run`이고 장부를 부르지 않는다.
2. **모름은 판정하지 않는다.** 두 목록 모두 `known: true`이고 배열이어야 하고, 줄마다 칸을 한 번씩 읽는다. 실행 줄은 실행 ID(UUID)·종류(`worker`·`session`)·상태(장부의 상태 이름), 보고 줄은 보고 ID(UUID)·동작(보고 셋 중 하나), 결과 보고면 실행 ID·저장 자리(빈 문자열 아님)·digest(소문자 16진수 64자리)다. **한 줄이라도 읽지 못하거나 꼴이 틀리거나 같은 ID의 줄이 둘이면 그 목록 전체가 모름이다**(`read_unknown`). 보고 한 줄을 건너뛰고 판정하면 그 실행의 다른 digest를 보지 못한 채 판정하고, 장부는 그 보고를 충돌 기록으로 닫는다(`ledger.ts`의 `markResult`).
3. **실행마다 판정 자리.** `checking`인 작업자 실행마다 그 실행의 반영 전 결과 보고(장부의 차례: 받은 시각, ID)를 `resultVerdict`에 넘긴다. 보고가 없으면 `wait`, digest가 둘 이상이면 `conflict`, 정확히 하나면 `pass`(그 digest의 첫 보고 ID). `wait`이면 실행 줄의 `updatedAt`(`checking`이 된 시각)부터 `now`까지가 기한 이상일 때만(정각 포함) 결과 없음 판정으로 간다. 시계가 그 시각보다 뒤면 경과가 음수라 기다린다.
4. **판정 하나.** 인자 `{ runId, resultDigest, reportId, now }`(결과 없음이면 `{ runId, resultDigest: null, now }`)를 만든 뒤 → `callAfterGate`(장부 포트 객체·`markResult`·인자 원소 얻기 → 문 → 호출 하나, `send-gate.ts`). 문은 접수 문 → 박자 유효 문 차례다(`gateOpen`). 접수 문을 얻기 뒤에 두어 얻기의 접근자 안에서 정지가 적용돼도 적지 않고(장부는 판정을 정지 중에도 받는다), 박자 유효 문을 맨 끝에 두어 접수 문 안의 읽기에 쓴 시간까지 박자 기한에 든다. 문 뒤에는 외부 코드가 없고 읽기부터 호출까지 `await`가 없다. 접수 문이 닫혔으면 `halted: "intake_closed"`, 유효 문이 닫혔으면 `halted: "beat_closed"`이고 그 실행의 장부 호출은 0회다.
5. **답.** 칸마다 한 번만 읽는다. `ok: false`와 장부의 거절 이름이면 `refused`. `ok: true`면 답의 실행 줄이 같은 실행 ID·같은 digest·판정 뒤 상태(`ready_result`·`cleanup_pending`·`finalized`)일 때만 `judged`, 결과 없음 판정이면 같은 실행 ID·digest `null`·`failed_stopped`일 때만 `no_result`(보고 ID 없이 부르면 장부는 `checking`에서 옮길 때만 `ok`다). 그 밖은 `ledger_failed`이고 박자를 멈춘다.

## 정한 것

- **`reportId`를 늘 넘긴다.** 장부가 그 보고가 이 실행의 반영 전 보고이고 digest가 같은지 대조하므로(아니면 `reference_mismatch`) 판정이 이 박자가 본 보고를 정확히 가리킨다. 확정을 여는 데에는 필요 없다: 빠져도 장부는 판정하면서 그 실행의 반영 전 결과 보고를 모두 반영해 `settledResult`가 값을 낸다(`life-loop.md` "뒤 조각이 지킬 것"). 같은 digest의 보고가 여럿이면 첫 보고의 ID를 넘기고 나머지는 장부가 같은 판정에서 함께 반영한다.
- **digest가 둘 이상이면 판정하지 않는다.** 어느 결과를 택할지 감독이 정할 근거가 없다(결과 보관은 둘 다 됐다). 장부의 `markResult`에 맡기면 판정한 digest 밖의 보고를 충돌 기록으로 닫아 되돌릴 수 없다. 그래서 반영 전 그대로 두고 경보만 남긴다. 그 실행은 관리자가 볼 때까지 `checking`으로 자리를 쥔다.
- **접수 문을 본다.** 복원 5단계 전, 정지 중, 허가 폐기 때는 판정하지 않는다. 장부는 판정을 정지 중에도 받지만(쓰기 모드 `continue`), 수명 박자가 확정을 접수가 열렸을 때만 적으므로 판정만 앞당겨도 자리는 풀리지 않는다. 정지가 풀린 뒤 복원 판정과 같은 문을 지나서 판정한다. 박자 처음과, 장부 호출마다 그 바로 앞의 문 안에서 본다(앞 실행의 장부 호출이나 장부 포트를 얻는 접근자 안에서 닫힐 수 있다).
- **박자 안에서 같은 실행은 한 번만 판정한다.** 실행 목록에 같은 실행 ID가 둘이면 목록 전체가 모름이다. 판정이 끝난 실행은 다음 박자의 목록에서 `checking`이 아니라 다시 판정하지 않는다.
- **결과 없음 판정은 반영 전 결과 보고가 하나도 없을 때만이다(D-113).** 기한 직전에 보고가 오면 그 박자는 그 보고로 통과 판정을 한다. 기한의 기준은 실행 줄의 `updatedAt`이다: `checking`으로 오는 길은 `completed` 종료 영수증 하나라 그 시각이 영수증을 받은 시각이고, 영수증의 전이와 같은 트랜잭션에서 적힌다. 결과 없음 판정에는 `reportId`를 넘기지 않는다(반영할 보고가 없고, 장부는 판정하면서 그 실행의 반영 전 결과 보고를 모두 닫는다).
- **늦게 온 결과 보고는 장부가 거절한다.** `failed_stopped`가 된 실행의 결과 보고는 장부가 `transition_denied`로 거절한다(`ledger.ts`의 `#resultDisposition`). ack가 없어 실행기가 계속 다시 보낸다. 판정은 되돌리지 않는다.
- **확정은 수명 박자가 낸다.** 결과 없음으로 판정한 실행의 확정 본문은 `outcome` `failed`(사유 `requested`의 취소 지시가 적혔으면 `cancelled`), `stored_at`은 이 판정의 `now`다(`life-loop.md` "실패 확정").
- **재시작 뒤에도 같은 길이다.** 복원 3단계는 `checking` 실행(`resumeChecks`)과 반영 전 보고를 다시 꺼내지만 판정하지 않는다. 이 박자가 매 박자 장부에서 같은 두 목록을 읽으므로 따로 이어 받을 것이 없다.

## 관리자 결정 대기

보고가 있는 실행의 판정 갈림은 모두 `resultVerdict` 한 함수에 있다. 답에 따라 이 함수를 바꾼다.

- **Q-H1(감독이 직접 검사할 범위):** 지금은 "반영 전 결과 보고가 정확히 한 digest인가"만 본다. 역할 일치·출처 참조·비밀 패턴은 보지 않는다.
- **Q-H5(결과 `outcome`이 `failed`·`needs_input`인 결과):** 장부의 보고 줄에는 결과의 `outcome`이 없고 이 박자는 보관소의 본문을 읽지 않으므로 digest가 있는 결과는 모두 통과다. `outcome`으로 가르기로 하면 이 함수와 함께 보관소 읽기 포트가 필요하다.
- **기한의 숫자:** `RESULT_CHECK.reportWaitMs`는 T1 실측 전의 시험 숫자다. 실측 뒤 조정한다.

## 시험

`test/supervisor/dispatch/result-check.test.ts`(실제 임시 장부), `test/supervisor/runtime/cycle.test.ts` "결과 검사 박자", `test/supervisor/runtime/boot-result-check.test.ts`(조립).

| 무엇 | 시험 |
|---|---|
| 결과 보고 → 판정 → 같은 박자의 수명 박자가 확정을 적고 내보냄 | "한 줄: 결과 보고 → 판정 → 확정", 조립 "판정하고 같은 박자의 수명 박자가 확정을" |
| 같은 digest 둘은 첫 보고로 한 번, 다음 박자의 판정 0 | "같은 digest의 보고가 둘이면" |
| 다른 digest 섞임 → 판정 0, 경보 한 줄 | "다른 digest가 섞이면", 조립 "경보는 그 실행에 한 줄만" |
| 보고 없음 → 기다림, 세션·다른 상태는 보지 않음 | "보고가 없는 checking은 기다린다" |
| 복원 전·정지 중·장부 읽기 모름 → 0 | "판정하지 않는 때", 순서기 "복원 전·발급 닫힘이면" |
| 보고 없이 기한 전 0, 정각에 `failed_stopped` → 같은 박자의 실패 확정(`failed`, 판정 시각), 늦은 보고 `transition_denied` | "한 줄: completed 종료 뒤 보고가 없으면", 조립 "보고 없이 기한이 지난 checking" |
| 취소 지시(`requested`) 뒤 종료 → 확정 `cancelled` | "취소 지시(requested) 뒤 cancelled로", "취소 지시(requested)가 적혔는데 completed로" |
| 기한 직전 보고 → `ready_result`(결과 없음 판정 0) | "기한 직전에 보고가 오면" |
| 기한 1ms 전·정책 없음·시계 뒤·`updatedAt` 모름 → 기다림, 정책 꼴 틀림 → `not_run` | "기한 1ms 전", "기한 정책의 꼴이 틀리면" |
| 기한 뒤에도 복원 전·정지 중·접수 문·읽기 모름·직전 문 닫힘 → 0 | "기한이 지나도 복원 전", "결과 없음 판정 직전의" |
| 장부 호출 직전의 접수 문·유효 문 → 그 실행부터 0 | "장부 호출 직전의 접수 문이나 박자 유효 문이 닫히면" |
| 재시작(복원 3단계) 뒤 남은 `checking` | "재시작" |
| 장부 쓰기는 `markResult` 하나, 시계·난수·송신 없음 | "정적", `start-send.test.ts`의 `callAfterGate` 줄 목록 |

## 남는 한계

- **충돌한 실행은 자리를 쥔다.** 경보 뒤에 그 실행을 닫는 길은 아직 없다(관리자 닫기는 종료 확인이 있는 실행을 받지 않는다, `ledger.md`).
- **감독이 멈춰 있던 시간도 기한에 든다.** 기한은 종료 영수증을 받은 시각부터 센다. 감독이 그 뒤 기한보다 오래 멈췄다가 다시 뜨면, 복원 5단계 뒤 첫 박자에서 실행기가 다시 보내는 결과 보고가 장부에 닿기 전에 결과 없음으로 판정할 수 있다(그 보고는 `transition_denied`로 거절된다).
- **기한의 기준이 `updatedAt`이다.** 장부의 `recordBudget`은 상태와 무관하게 `updatedAt`을 바꾼다. 지금 부르는 코드는 없지만, `checking` 줄에 부르면 기한이 그만큼 늦어진다(이른 판정 쪽으로는 틀리지 않는다).
- **결과 없음으로 판정한 실행의 자리는 확정·정리로만 풀린다.** 수명 박자가 `outcome`을 정하지 못하는 `failed_stopped`(`life-loop.md` "실패 확정")는 자리를 쥔다.
- **판정과 장부 호출 사이에 새 보고가 끼는 것은 막지 못한다.** 박자는 동기이고 보고는 소켓 사건으로만 오므로 실제로는 끼지 않는다. 장부 포트 안에서 다시 보고를 적는 경우는 장부가 다른 digest의 보고를 충돌로 닫는다.
- **경보 기억은 메모리뿐이다.** 감독이 다시 뜨면 같은 충돌에 경보를 한 줄 더 남긴다.
