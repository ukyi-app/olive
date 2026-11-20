# 배정·시작 순환의 한 박자 (`assign-loop.ts`)

배정기 순환의 한 박자다. 대기 실행 하나에 시작을 장부에 적은 뒤에만 시작 지시를 내보내고, 대기 부탁을 골라 실행 줄에 잇는다. 상태를 갖지 않는다. 장부·접수·연결 후보·사실·자격·난수·서명·내보내기는 포트로, 정책과 지금 시각은 인자로 받는다. 소켓·타이머·시계·난수를 직접 부르지 않는다(시험이 소스를 읽어 지킨다).

## 공개 면

```ts
assignAndStartTick(ports: AssignLoopPorts, policy: AssignLoopPolicy, now: number): Promise<TickResult>

AssignLoopPorts = {
  ledger: Pick<Ledger, "listWaitingToolRequests" | "assignToolRequest" | "queueView" | "listRuns" | "slotHolds" | "listInputs" | "startRun">
  intake: Pick<Restorer, "intakeOpen" | "stopGeneration">
  connections: { candidates(): { known: true, value: Candidate[] } | { known: false } }
  facts: { facts(request: WaitingToolRequest): PreAssignFacts | Promise<PreAssignFacts> }
  credentials: CredentialPort   // ports.ts
  random: Random                // 실행 ID, 시작 지시의 요청 ID, nonce
  signer: Signer
  sink: InstructionSink
}

AssignLoopPolicy = {
  assignment: AssignmentContext  // roles/assign.ts
  accounts: AccountRef[]         // accounts/fixed.ts
  plans: RunPlan[]               // pick.ts
  queue: SchedulerPolicy         // scheduler/queue.ts
  originOf(source: string): "admin" | "alert" | undefined  // 접수 출처 이름 → 출처 종류
}

TickResult =
  | { kind: "not_run", reason: "malformed_now" | "intake_closed" | "stop_generation_unknown" | "policy_rejected" }
  | { kind: "not_run", reason: "read_unknown", read: LoopRead }
  | { kind: "ran", starts: StartOutcome[], requests: RequestOutcome[], halted: "intake_closed" | "threw" | null, haltedAt: HaltedAt | null }

HaltedAt = { step: "start", runId: string } | { step: "assign", ref: string }
```

`LoopRead`는 `waiting_requests`, `candidates`, `queue_view`, `runs`, `slot_holds`, `inputs`다. `halted`와 `haltedAt`은 아래 "박자가 멈출 때".

| 부탁마다 (`RequestOutcome`) | 뜻 |
|---|---|
| `skipped` + `pick` | `pickAssignment`가 `assign`이 아닌 답을 냈다. 그 답을 그대로 싣는다 |
| `assigned` + `runId`, `executorId` | 새 실행 ID로 이었다 |
| `already_assigned` + `runId`, `executorId` | 이미 이어진 부탁이다. 장부가 돌려준 실행이고 새 실행 줄은 없다 |
| `assign_refused` + `reason` | 장부가 거절했다(`input_cancelled`·`input_expired` 포함). 이번 호출이 새 실행을 잇지 않았다는 뜻이다. 부탁이 대기로 남는지는 장부가 정한다(그 사이 취소되어 장부가 이미 닫은 부탁이면 `transition_denied`이고 대기 목록에 없다) |
| `assign_failed` + `failure` | `random_unavailable`(장부를 부르지 않음), `threw`, `malformed_answer` |

| 실행마다 (`StartOutcome`) | 뜻 |
|---|---|
| `sent` + `requestId`, `issuedAt`, `executorId` | 시작을 적고 지시를 연결에 실었다(`sent`는 받았다는 뜻이 아니다) |
| `recorded_not_sent` + `requestId`, `stopGeneration`, `issuedAt`, `executorId`, `reason`, `delivery` | 장부에는 시작이 적혔고 전송 성공을 확인하지 못했다. 연결에 실렸는지는 `delivery`로 읽는다(`unknown`이면 실렸을 수 있다). 아래 "내보내지 못했을 때" |
| `start_refused` + `reason` | 장부가 거절했다. 지시를 만들지 않았다 |
| `start_failed` + `failure` | `random_unavailable`(장부를 부르지 않음), `threw`, `malformed_answer`. 적혔는지 모르므로 지시를 만들지 않았다 |
| `not_worker` | 세션 후보다. 세션 시작은 장부가 닫아 두었고(`session_start_closed`) 이 박자가 내지 않는다 |

결과에는 원문·자격 참조의 값·봉투·서명·nonce가 없다(시험이 결과의 JSON에 자격 digest와 서명이 없음을 본다). 부르는 쪽은 이 목록으로 기록과 지표를 만든다.

## 한 박자의 순서

1. `now`가 장부의 시각 꼴(양의 안전 정수 ms)이 아니면 `malformed_now`.
2. **쓰기 전의 읽기.** 접수(`intakeOpen()`이 `true`가 아니면 `intake_closed`), 정지 세대(0 이상의 안전 정수가 아니면 `stop_generation_unknown`), 대기 부탁 목록, 후보 연결, 시작 판단의 읽기 넷(`queueView`, `listRuns`, `slotHolds`, `listInputs`)을 이 차례로 읽는다. 하나라도 `known`이 불리언 `true`가 아니거나 던지거나 꼴이 틀리면(배열이 아님, 객체가 아닌 항목) 그 이름으로 `read_unknown`이다. `listRuns`의 대기 실행에 대한 `queueView`의 시작 불가 사유(`startBar`)는 명시적 `null`이거나 장부가 정한 이름(`StartBar`)이어야 하고, 줄이 없거나(두 읽기가 어긋남) 칸이 빠졌거나 다른 값이면 `queue_view`다.
3. 그 읽기로 `planNext`의 입력을 만들어 부른다. 출처를 나누지 못한 입력(`originOf`가 `undefined`)은 넣지 않아 그 실행이 `input_unknown`으로 보류된다. `planNext`가 정책 검사에서 던지면 `policy_rejected`다.
4. **시작.** `planNext`의 후보마다: 세션이면 `not_worker`. 작업자면 접수를 다시 보고(닫혔으면 `halted`), 난수 포트로 요청 ID를 만들어 `startRun`. 성공 답을 받은 뒤에만 `startDraft`(장부의 실행 줄, 그 요청 ID, 박자의 정지 세대, 장부의 `issuedAt`) → `sealDraft` → `sink.send`. 거절·예외이면 지시를 만들지 않는다. 성공 답은 초안에 필요한 칸(실행 줄과 `issuedAt`)만 검증하고, 이 모듈이 쓰지 않는 칸(성공 답의 별도 `credential` 등)은 보지 않는다.
5. **잇기.** 대기 부탁마다 목록의 순서로: 사실 포트, 자격 포트, `pickAssignment`. `assign`이면 난수 포트로 실행 ID를 만들어 `assignToolRequest`. 어느 답이든 그 부탁만의 결과이고 다음 부탁을 본다.

2의 읽기에서 1~5의 어느 쓰기도 부르지 않는다. 읽기 하나라도 닫힘·모름·틀림이면 그 박자에는 잇기도 시작도 없다.

### 박자가 멈출 때

박자는 예외를 밖으로 내지 않는다. 장부에 쓰기가 한 번이라도 성공한 뒤에 예외가 박자 밖으로 나가면, 이미 적은 시작(`sent`·`recorded_not_sent`)과 이은 부탁의 결과를 부르는 쪽이 잃고 그 실행은 아무도 모르는 채 자리를 쥔다.

- **포트의 예외는 그 항목의 결과다.** 난수 포트가 던지면 `start_failed`·`assign_failed`의 `random_unavailable`, 장부 포트가 던지면 `threw`(실제 장부는 자기 시계의 예외를 `ledger_unwritable` 거절로 바꾸고 접수를 닫으므로, 박자는 그 거절을 싣고 다음 쓰기 직전에 `intake_closed`로 멈춘다), 사실·자격 포트가 던지면 모름으로 넘겨 고르기가 보류, 서명·내보내기 포트가 던지면 `recorded_not_sent`(`seal_threw`·`send_threw`)다. 박자는 다음 항목을 본다.
- **그 밖의 예상하지 못한 예외**(포트의 답을 읽다가 던지는 경우 등)는 남은 항목을 하지 않고 `halted: "threw"`로 멈춘다.
- **`haltedAt`은 결과를 내지 못한 첫 항목**(시작 후보의 실행 ID, 또는 대기 부탁의 ref)이고, 그 항목은 목록에 없다. `threw`이면 그 항목에 장부 쓰기가 있었는지 이 결과로는 모르므로, 부르는 쪽은 그 실행·부탁을 장부에서 다시 읽는다. `intake_closed`이면 그 항목에는 쓰기를 부르지 않았다.
- 멈춰도 그 전까지의 `starts`·`requests`는 모두 결과에 있다.

### 왜 시작 판단을 박자 처음의 읽기로 하는가

이번 박자에 이은 실행은 다음 박자의 읽기에서 시작 후보가 된다. 잇기 뒤에 다시 읽어 판단하면, 그 다시 읽기가 모름일 때는 이미 이은 박자라 "읽기가 모름이면 잇기도 시작도 부르지 않는다"를 지킬 수 없다. 시작 후보가 박자 처음의 읽기에서 나와도 장부의 `startRun`이 정지·세대·슬롯·입력·기한을 같은 트랜잭션에서 다시 보므로, 낡은 판단은 거절로 끝나고 시작이 되지는 않는다.

### 왜 시작을 잇기보다 먼저 하는가

시작 후보와 봉투의 시각은 박자 처음의 읽기와 `now`에 묶여 있다. 잇기는 부탁마다 비동기 포트(사실, 자격)를 기다리므로, 그 뒤에 시작하면 판단과 봉하는 시각이 그만큼 낡는다.

### 접수를 다시 보는 자리

포트가 비동기라 박자 중에 접수가 닫힐 수 있다. 쓰기 직전마다 접수를 다시 읽는다: `startRun` 직전, 그리고 `pickAssignment`에 넘기는 `intakeOpen`(고르기가 `intake_closed`를 내면 잇지 않는다). 닫혔으면 남은 쓰기를 부르지 않고 `halted: "intake_closed"`로 그 전까지의 목록을 낸다. 장부도 같은 트랜잭션에서 접수 허가를 다시 본다(`intake_closed`).

## 시각

- 판단(`pickAssignment`, `planNext`)과 장부 쓰기(`assignToolRequest`·`startRun`의 `now`)는 인자로 받은 `now` 하나를 쓴다.
- 시작 지시의 머리 `issued_at`은 `startRun`이 돌려준 `issuedAt`이다(장부가 자기 시계로 정한 값, `envelopes.md` "시각 규칙").
- **봉하는 시각은 `now`와 `issuedAt` 가운데 늦은 값이다.** 장부는 박자의 `now`를 읽은 뒤 같은 시계로 발행 시각을 정하므로 `issuedAt`이 `now`보다 늦을 수 있고, 그때 `now`로 봉하면 `sealDraft`가 `issued_in_future`로 막는다. 늦은 값도 같은 시계에서 읽은 값이다. 실제로 싣는 시각의 봉투 시한과 작업 기한의 여유는 내보내기 포트가 다시 잰다(`ports.ts`의 `InstructionSink`).
- **실행 기한(`deadlineAt`)은 박자의 `now`부터 센다.** 잇기는 사실·자격 포트를 기다린 뒤 장부에 쓰지만 `now`는 박자 처음의 값이라, 기다리는 동안 흐른 시간만큼 실제 잇는 순간보다 기한이 먼저 흐르고, 조회가 길면 이은 직후에 이미 지나 있을 수 있다(그 실행은 `planNext`가 `deadline_passed`로 보류한다).

## 사실·자격·후보 연결

- **사실(`facts`):** 배정 전 거절의 사실을 그 부탁과 대조해 채우는 쪽은 포트다. 모르는 칸은 비운다. 포트가 던지면 빈 사실로 넘겨 고르기가 `evidence_missing`으로 보류한다. 이 모듈은 사실을 지어내지 않는다.
- **자격(`credentials`):** 고르기와 같은 `selectAccount(부탁의 역할, accounts)`로 계정을 정해 그 계정의 참조를 묻는다. 계정이 없으면 묻지 않는다(고르기가 `no_account`). `known: false`이거나 던지면 `null`로 넘겨 고르기가 `credential_unknown`으로 보류한다. 꼴과 계정 대조는 고르기가 한다.
- **후보 연결(`connections`):** `Connections.candidates(복원기)`는 정지 세대를 모르면 빈 목록을 낸다. "후보 없음"과 "모름"을 가르려면 감싸는 조립 코드가 세대를 모를 때 `known: false`를 낸다.

## 내보내지 못했을 때

`startRun`이 성공한 뒤의 실패는 모두 `recorded_not_sent`다. 그 실행은 장부에 적힌 그대로(`preparing`, `task_start` 지시 한 줄) 두고, 새 실행 ID·새 요청 ID로 다시 만들지 않는다. 다음 박자에는 그 실행이 대기가 아니라 `planNext`의 후보가 되지 않고, 그 자리를 쥔 채라 다른 시작도 없다.

| `reason` | `delivery` |
|---|---|
| `ledger_answer_malformed`(답의 실행 ID가 넘긴 것과 다름 등), `draft_threw`, `startDraft`의 거절 이름, `seal_threw`, `sealDraft`의 거절 이름(`field`·`sealReason` 함께) | `not_sent` |
| `no_connection`, `too_late_to_send` | `not_sent` |
| `send_threw`, `send_answer_malformed` | `unknown`: 포트가 연결에 실었는지 모른다 |

`requestId`, `runId`, `stopGeneration`, `issuedAt`(장부의 답에서 읽지 못했으면 `null`), `executorId`를 싣는다. 이 값은 처음 지시를 가리키는 식별값이고, 본문을 다시 만들 재료는 아니다. 본문(예산 등)은 장부의 실행 줄에서 오므로 그 뒤 장부가 바뀌면 같은 식별값으로 다시 만든 본문이 처음과 다를 수 있다. 결과에는 본문이나 자격 참조를 싣지 않는다.

## 이 박자가 하지 않는 것

갱신·취소·확정·조회, 영수증 처리, 재전송, 연결 상실 반영, 자격 값 전달(계약 v1에 그 메시지가 없다. 시작 지시는 자격 참조만 싣는다), 세션 시작. 대기 부탁 목록은 소유자를 가리지 않는 감독 안쪽의 읽기라 본체의 도구 처리기(`scheduler/tools.ts`)의 포트에 잇지 않는다(이 모듈은 그 파일을 import하지 않는다).

## 뒤 조각이 지킬 것

- **박자를 되풀이해 부른다.** 이번 박자에 이은 실행은 다음 박자에 시작 후보가 된다. 결과에 `assigned`가 있으면 곧 다시 부른다.
- **`recorded_not_sent`는 처음의 본문 또는 그와 같음을 대조할 근거가 있을 때만 재전송하고, 없으면 같은 실행을 조회한다.** 재전송은 같은 요청 ID·같은 본문·새 nonce로 새 봉투에 담는다. 시작 지시는 발행 시각이 고정이라 `issuedAt + 19000ms`까지만 다시 봉할 수 있고(`envelopes.md`), 작업 기한이 더 이르면 그만큼 앞당겨진다. 결과 목록은 메모리에만 있으므로, 감독이 그 전에 죽으면 장부에서 보내지 않은 지시를 찾는 읽기가 필요하다(장부에 아직 없다).
- **`delivery: "unknown"`은 보냈을 수도 있다.** 같은 길이다. 새 요청 ID로 다시 만들지 않는다.
- **`halted: "threw"`이면 `haltedAt`의 실행·부탁을 장부에서 다시 읽는다.** 그 항목에 쓰기가 있었는지 결과로는 모른다.
- **내보내는 포트는 실제로 싣는 시점에 정지 세대와 접수를 다시 본다.** 이 박자는 `startRun` 직전에 접수를 다시 보지만, 내보내기 포트가 비동기로 기다리는 동안 정지가 들어오면 옛 세대의 봉투가 실린다(실행기는 새 세대에서 `stop_generation_mismatch`로 거절한다). 싣기 직전에 대조하거나, 대조부터 싣기까지를 동기적으로 끝낸다. 지정 실행기의 살아 있는 연결과 봉투·작업 기한의 남은 여유도 이 시점에 잰다.
- **작업 자리는 종료 근거로만 푼다.** 시작을 받은 적 없는 실행을 D-90으로 풀려면 접수 영수증 없음, 추가 시작 송신 중단과 마지막 봉투의 만료, 그 뒤 전체 점유에서 부재가 함께 성립해야 한다. 기한 지난 대기 실행의 마감과 재시작 뒤 미응답 지시의 복원은 뒤 조각이다.
- **`now`는 장부 시계와 같은 시계에서 박자마다 한 번 읽은 값이고 후퇴하지 않는다**(`planNext`의 조건).
- **세션 후보(`not_worker`)는 세션 계약 작업이 연다.** 그 전에는 세션 대기 실행이 후보로 남아도 이 박자는 부르지 않는다.
