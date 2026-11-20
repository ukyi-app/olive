# 배정·시작 순환의 한 박자 (`assign-loop.ts`)

배정기 순환의 한 박자다. 대기 실행 하나에 시작을 장부에 적은 뒤에만 시작 지시를 내보내고, 대기 부탁을 골라 실행 줄에 잇는다. 상태를 갖지 않는다. 장부·접수·연결 후보·사실·자격·난수·서명·내보내기는 포트로, 정책과 지금 시각은 인자로 받는다. 소켓·타이머·시계·난수를 직접 부르지 않는다(시험이 소스를 읽어 지킨다).

## 공개 면

```ts
assignAndStartTick(ports: AssignLoopPorts, policy: AssignLoopPolicy, now: number): Promise<TickResult>

AssignLoopPorts = {
  ledger: Pick<Ledger, "listWaitingToolRequests" | "assignToolRequest" | "queueView" | "listRuns" | "slotHolds" | "listInputs" | "startRun" | "markStartDispatch">
  intake: Pick<Restorer, "intakeOpen" | "stopGeneration">
  connections: { candidates(): { known: true, value: Candidate[] } | { known: false } }
  withheld: { executors(): { known: true, value: string[] } | { known: false } }  // 맡기지 않을 실행기(작업자 실행기 주체 이름)
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

`LoopRead`는 `waiting_requests`, `candidates`, `withheld`, `queue_view`, `runs`, `slot_holds`, `inputs`다. `halted`와 `haltedAt`은 아래 "박자가 멈출 때".

| 부탁마다 (`RequestOutcome`) | 뜻 |
|---|---|
| `skipped` + `pick` | `pickAssignment`가 `assign`이 아닌 답을 냈다. 그 답을 그대로 싣는다 |
| `assigned` + `runId`, `executorId` | 새 실행 ID로 이었다 |
| `already_assigned` + `runId`, `executorId` | 이미 이어진 부탁이다. 장부가 돌려준 실행이고 새 실행 줄은 없다 |
| `assign_refused` + `reason` | 장부가 거절했다(`input_cancelled`·`input_expired` 포함). 이번 호출이 새 실행을 잇지 않았다는 뜻이다. 부탁이 대기로 남는지는 장부가 정한다(그 사이 취소되어 장부가 이미 닫은 부탁이면 `transition_denied`이고 대기 목록에 없다) |
| `assign_failed` + `failure` | `random_unavailable`(장부를 부르지 않음), `threw`, `malformed_answer` |
| `withheld` + `reason`, `executorId` | 이 호출이 그 부탁을 잇지 않았다. 그 부탁의 지금 장부 상태는 보장하지 않는다(겹친 박자의 다른 호출이 이미 이었을 수 있다). 재시도나 지표에 지금 단계가 필요하면 장부를 다시 읽는다. `listed`: 빼고 고른 답이 `no_executor`였고 빼지 않았다면 고르기가 고를 실행기가 맡기지 않을 실행기다(`executorId`가 그 실행기), 또는 고르기가 고른 실행기 하나가 고른 뒤의 대조에서 집합에 있었다(`executorId`가 그 실행기). 뒤의 경우는 맞는 후보가 모두 막혔다는 뜻이 아니다: 같은 박자에서 다른 후보를 다시 고르지 않고, 다음 박자가 다시 고른다. `withheld_unknown`: 고르기 직전에 다시 읽은 집합이 모름이다(`executorId: null`). 아래 "맡기지 않을 실행기" |

| 실행마다 (`StartOutcome`) | 뜻 |
|---|---|
| `sent` + `requestId`, `issuedAt`, `executorId` | 시작을 적고, 송신 표식을 커밋한 뒤 지시를 연결에 실었다(`sent`는 받았다는 뜻이 아니다) |
| `recorded_not_sent` + `requestId`, `stopGeneration`, `issuedAt`, `executorId`, `reason`, `delivery` | 장부에는 시작이 적혔고 전송 성공을 확인하지 못했다. 연결에 실렸는지는 `delivery`로 읽는다(`unknown`이면 실렸을 수 있다). 표식이 `ok`가 아니어서 싣지 않았으면 `start_unmarked`(+ `markReason`). 아래 "내보내지 못했을 때" |
| `start_refused` + `reason` | 장부가 거절했다. 지시를 만들지 않았다 |
| `start_failed` + `failure` | `random_unavailable`(장부를 부르지 않음), `threw`, `malformed_answer`. 적혔는지 모르므로 지시를 만들지 않았다 |
| `withheld` + `reason`, `executorId` | 이 호출은 `startRun`을 부르지 않았다(장부 쓰기·난수·송신 0, 그 실행을 `queued`에서 바꾸지 않았다). `listed`: 지정 실행기가 맡기지 않을 실행기다(`executorId`가 그 이름). `executor_unknown`: 실행 줄의 지정 실행기가 작업자 실행기 주체 이름으로 읽히지 않았다(집합이 비어 있어도). `withheld_unknown`: `startRun` 직전에 다시 읽은 집합이 모름이다. 뒤 둘은 `executorId: null` |
| `not_worker` | 세션 후보다. 세션 시작은 장부가 닫아 두었고(`session_start_closed`) 이 박자가 내지 않는다 |

결과에는 원문·자격 참조의 값·봉투·서명·nonce가 없다(시험이 결과의 JSON에 자격 digest와 서명이 없음을 본다). 부르는 쪽은 이 목록으로 기록과 지표를 만든다.

## 한 박자의 순서

1. `now`가 장부의 시각 꼴(양의 안전 정수 ms)이 아니면 `malformed_now`.
2. **쓰기 전의 읽기.** 접수(`intakeOpen()`이 `true`가 아니면 `intake_closed`), 정지 세대(0 이상의 안전 정수가 아니면 `stop_generation_unknown`), 대기 부탁 목록, 후보 연결, 맡기지 않을 실행기(항목이 모두 작업자 실행기 주체 이름이 아니면 `withheld`, 아래 "맡기지 않을 실행기"), 시작 판단의 읽기 넷(`queueView`, `listRuns`, `slotHolds`, `listInputs`)을 이 차례로 읽는다. 하나라도 `known`이 불리언 `true`가 아니거나 던지거나 꼴이 틀리면(배열이 아님, 객체가 아닌 항목) 그 이름으로 `read_unknown`이다. `listRuns`의 대기 실행에 대한 `queueView`의 시작 불가 사유(`startBar`)는 명시적 `null`이거나 장부가 정한 이름(`StartBar`)이어야 하고, 줄이 없거나(두 읽기가 어긋남) 칸이 빠졌거나 다른 값이면 `queue_view`다. 이 검사는 행마다 본 범위에서다: 같은 실행의 `queueView` 행이 여럿이면 마지막 행만 보므로, 앞 행의 틀린 사유는 뒤의 정상 행에 가려져 시작이 불릴 수 있다(실제 장부는 한 실행에 한 행을 낸다). 읽기의 답은 받았으나 그 행을 해석하다 던지면(행의 칸 getter, 배열의 빈 원소) 구별된 결과 없이 박자가 예외로 끝난다(아래 "박자가 멈출 때").
3. 그 읽기로 `planNext`의 입력을 만들어 부른다. 출처를 나누지 못한 입력(`originOf`가 `undefined`)은 넣지 않아 그 실행이 `input_unknown`으로 보류된다. `planNext`가 정책 검사에서 던지면 `policy_rejected`다.
4. **시작.** `planNext`의 후보마다: 세션이면 `not_worker`. 작업자면 접수를 다시 보고(닫혔으면 `halted`), 맡기지 않을 실행기를 다시 읽어 그 실행의 지정 실행기와 대조하고(걸리면 `withheld`, 그 실행은 건너뛴다), 난수 포트로 요청 ID를 만들어 `startRun`. 성공 답을 받은 뒤에만 `startDraft`(장부의 실행 줄, 그 요청 ID, 박자의 정지 세대, 장부의 `issuedAt`) → `sealDraft` → 송신 표식 → `sink.send`. 표식과 송신은 공유 함수 `sendInstruction`(`send-gate.md`) 하나로 하고, 표식은 `startRun`을 부른 그 장부 객체로 봉투의 실행·요청 ID를 봉한 시각(아래 "시각")에 적는다. 표식이 `ok`가 아니면 싣지 않는다(`start_unmarked`). 거절·예외이면 지시를 만들지 않는다. 성공 답은 초안에 필요한 칸(실행 줄과 `issuedAt`)만 검증하고, 이 모듈이 쓰지 않는 칸(성공 답의 별도 `credential` 등)은 보지 않는다.
5. **잇기.** 대기 부탁마다 목록의 순서로: 사실 포트, 자격 포트, 접수와 맡기지 않을 실행기의 다시 읽기, 그 실행기를 뺀 후보로 `pickAssignment`. `assign`이면 고른 실행기를 같은 집합과 한 번 더 대조하고, 걸리지 않으면 난수 포트로 실행 ID를 만들어 `assignToolRequest`. 어느 답이든 그 부탁만의 결과이고 다음 부탁을 본다.

2의 읽기에서 1~5의 어느 쓰기도 부르지 않는다. 읽기 하나라도 닫힘·모름·틀림이면 그 박자에는 잇기도 시작도 없다.

### 박자가 멈출 때

장부에 쓰기가 한 번이라도 성공한 뒤에는 박자가 예외를 밖으로 내지 않는다. 그때 예외가 박자 밖으로 나가면, 이미 적은 시작(`sent`·`recorded_not_sent`)과 이은 부탁의 결과를 부르는 쪽이 잃고 그 실행은 아무도 모르는 채 자리를 쥔다. 시작·잇기에 들어선 뒤의 예외는 모두 아래처럼 결과가 된다.

- **쓰기 전의 읽기를 해석하다 던지면 박자가 예외로 끝난다.** 읽기 포트의 호출 자체가 던지거나 답의 겉꼴이 틀리면 `read_unknown`이지만, 받은 답의 행을 해석하다 던지면(큐·실행·입력 행의 칸 getter, 배열의 빈 원소) 구별된 결과 없이 포트가 던진 예외가 그대로 올라간다(Promise 거부). 이때 장부 쓰기와 내보내기는 0이다.
- **포트의 예외는 그 항목의 결과다.** 난수 포트가 실행 ID·요청 ID를 만들다 던지면 `start_failed`·`assign_failed`의 `random_unavailable`이고, 봉하기에서 nonce를 만들다 던지면 `recorded_not_sent`의 `seal_threw`다. 장부 포트가 던지면 `threw`다(실제 장부는 자기 시계의 예외를 `ledger_unwritable` 거절로 바꾸고 접수를 닫으므로, 박자는 그 거절을 싣고, 뒤에 접수를 다시 볼 항목이 있으면 그 직전에 `intake_closed`로 멈춘다. 마지막 잇기였으면 `halted`는 `null`이다). 사실·자격 포트가 던지면 모름으로 넘겨 고르기가 보류, 서명·내보내기 포트가 던지면 `recorded_not_sent`(`seal_threw`·`send_threw`)다. 박자는 다음 항목을 본다.
- **그 밖의 예상하지 못한 예외**(포트의 답을 읽다가 던지는 경우 등)는 남은 항목을 하지 않고 `halted: "threw"`로 멈춘다.
- **`haltedAt`은 보통 결과를 내지 못한 첫 항목**(시작 후보의 실행 ID, 또는 대기 부탁의 ref)이고, 그 항목은 목록에 없다. 다만 멈춘 대기 부탁의 ref 자체를 읽지 못하면(ref getter, 목록의 빈 원소) `haltedAt`은 앞서 결과를 낸 항목(앞의 시작이나 이은 부탁)을 가리키거나 `null`이다. 그래서 `threw`이면 부르는 쪽은 `haltedAt`의 항목만이 아니라 **그 박자의 결과 목록에 없는 대기 부탁·실행 전체를 장부에서 다시 읽는다**. 멈춘 항목에 장부 쓰기가 있었는지 이 결과로는 모른다. `intake_closed`이면 그 항목에는 쓰기를 부르지 않았다.
- 멈춰도 그 전까지의 `starts`·`requests`는 모두 결과에 있다. `kind: "ran"`과 빈 두 목록은 정상 유휴 박자와 첫 항목에서 멈춘 박자가 같으므로, 완료 여부는 `halted`로 가른다.

### 왜 시작 판단을 박자 처음의 읽기로 하는가

이번 박자에 이은 실행은 다음 박자의 읽기에서 시작 후보가 된다. 잇기 뒤에 다시 읽어 판단하면, 그 다시 읽기가 모름일 때는 이미 이은 박자라 "읽기가 모름이면 잇기도 시작도 부르지 않는다"를 지킬 수 없다. 시작 후보가 박자 처음의 읽기에서 나와도 장부의 `startRun`이 정지·세대·슬롯·입력·기한을 같은 트랜잭션에서 다시 보므로, 낡은 판단은 거절로 끝나고 시작이 되지는 않는다.

### 왜 시작을 잇기보다 먼저 하는가

시작 후보와 봉투의 시각은 박자 처음의 읽기와 `now`에 묶여 있다. 잇기는 부탁마다 비동기 포트(사실, 자격)를 기다리므로, 그 뒤에 시작하면 판단과 봉하는 시각이 그만큼 낡는다.

### 접수를 다시 보는 자리

포트가 비동기라 박자 중에 접수가 닫힐 수 있다. 쓰기 직전마다 접수를 다시 읽는다: `startRun` 직전, 그리고 `pickAssignment`에 넘기는 `intakeOpen`(고르기가 `intake_closed`를 내면 잇지 않는다). 닫혔으면 남은 쓰기를 부르지 않고 `halted: "intake_closed"`로 그 전까지의 목록을 낸다. 장부도 같은 트랜잭션에서 접수 허가를 다시 본다(`intake_closed`). 맡기지 않을 실행기도 같은 두 자리에서 접수 다음에 다시 읽는다(아래).

## 맡기지 않을 실행기

장부가 어떤 실행기의 지금 점유를 반영하지 못한 동안 그 실행기에게 새 일을 시작시키면, 장부가 모르는 점유 위에 시작이 적힌다. 인사 처리기(`hello-answers.ts`)는 그런 실행기를 `withhold`(실행기 주체 이름)로 낸다. 이 박자는 그 이름들의 집합을 `withheld` 포트로 받아 두 자리에서 막는다. 배정 박자는 후보 포트를 새 부탁을 이을 때만 쓰고 이미 배정된 대기 실행은 장부 목록에서 따로 골라 `startRun`을 부르므로, 후보에서 빼기만 하면 그 실행기 앞의 `queued` 실행이 시작된다.

- **잇기:** 그 집합의 실행기는 후보 연결에서 뺀다. 후보의 주체 이름은 `Candidate.principal`(연결 판단이 `sync.principal`을 해석한 값)에서 고르기가 장부에 적는 이름과 같은 조립(`executorName(역할, 인스턴스, 저장소)`)으로 만든다. 작업자 실행기 주체가 아니거나 이름을 만들 수 없는 후보는 빼지 않는다: 정상 후보면 고르기도 그 후보를 고르지 않으므로 기존 답이 그대로다. 집합이 비었거나, 거를 때 받은 후보 값이 배열이 아니거나, 후보 목록에 빈 자리가 있으면 거르지 않고 받은 값을 그대로 고르기에 넘긴다: 빈 자리를 건너뛰며 거르면 고르기의 검증이 `malformed_connections`로 거절할 목록이 정상 목록이 되고, 배열이 아닌 값을 거르려 하면 그 거절 대신 박자가 멈춘다(읽기 포트의 답이 검사할 때와 넘길 때 다른 값을 내는 접근자일 수 있다). 거르지 않았으면 빼고 고른 뒤 후보 목록의 길이를 다시 읽지 않는다. 고르기가 `assign`을 내면 고른 실행기(`executorId`)를 같은 집합과 한 번 더 대조하고, 걸리면 난수·잇기 전에 `withheld`·`listed`다(주체를 읽을 때마다 다른 값을 내는 후보는 거를 때 남고 고를 때 뽑힐 수 있다). 이 `listed`는 **고른 실행기 하나가 집합에 있었다**는 뜻이고 맞는 후보가 모두 막혔다는 뜻이 아니다: 같은 박자에서 그 실행기를 빼고 다시 고르지 않으므로, 집합에 없는 맞는 후보가 이미 있어도 이 박자에서는 잇지 않는다. 다음 박자가 다시 고른다. 다른 실행기에 맞는 부탁은 지금처럼 그 실행기로 잇는다.
- **`withheld`와 `no_executor`를 구별한다.** 뺀 뒤의 고르기가 `no_executor`이고 실제로 뺀 후보가 있으면, 빼지 않은 후보로 고르기를 한 번 더 부른다(쓰지 않는다). 그 답이 `assign`이면 `withheld`·`listed`이고 `executorId`는 그 답이 고른 실행기다. 아니면 빼지 않은 고르기의 답을 `skipped`로 싣는다(뺀 실행기가 빼지 않았어도 맞지 않았거나, 자격·계획 등 다른 이유로 보류된다). 구별하는 이유: `no_executor`는 지금의 연결·정책 조합에 맞는 후보가 없다는 뜻이고 그 동안 계속된다(맞는 실행기가 연결되거나 기대 revision 같은 정책 값이 연결과 맞으면 풀린다). 이 자리의 `withheld`는 맞는 후보가 있지만 모두 맡기지 않을 실행기라는 뜻이고(고른 뒤의 대조에서 나온 `listed`는 위처럼 더 좁다), 그 실행기가 집합에서 빠지거나 집합에 없는 맞는 후보가 생기면 풀린다. 부르는 쪽의 기록·지표와 다시 부를 때가 다르다.
- **시작:** `planNext`의 작업자 후보마다 `startRun` 직전에 집합을 다시 읽고, 그 실행의 지정 실행기(박자 처음에 읽은 `listRuns`의 `executorId`. 행은 시작 후보와 같은 실행 ID 값으로 찾고 행의 칸을 다시 읽지 않는다. 대기 실행의 지정 실행기는 배정 뒤 바뀌지 않는다)가 집합에 있으면 `startRun`을 부르지 않는다. 다시 읽기와 `startRun` 사이에는 `await`가 없다. 지금은 `planNext`가 작업자 후보를 하나만 내고 시작이 박자의 첫 쓰기라 박자 처음의 읽기와 이 읽기 사이에도 기다림이 없지만, 판정은 쓰기 자리에 둔다: 시작 후보가 늘거나 순서가 바뀌면 그 사이 비동기 포트를 기다리는 동안 붙들린 실행기가 생길 수 있고, 조립이 집합을 바꾸는 때는 이 박자가 정하지 않는다.
- **모르면 닫는다.** 박자 처음의 읽기에서 포트가 없거나 던지거나, `known`이 불리언 `true`가 아니거나, `value`가 배열이 아니거나(`value`는 한 번만 읽고 그 값에 모든 검사를 건다), 항목 하나라도 작업자 실행기 주체 이름(계약의 `parsePrincipal`이 `worker_executor`로 읽는 이름)이 아니면 `read_unknown`·`withheld`이고 무엇도 쓰지 않는다. 빈 배열은 "맡기지 않을 실행기 없음"으로 유효하다. 빠뜨린 포트를 빈 집합으로 치지 않는다. 쓰기 직전의 다시 읽기가 모름이면 그 항목만 `withheld`·`withheld_unknown`이고 다음 항목을 본다(이미 쓴 것이 있을 수 있어 박자 전체를 `not_run`으로 바꿀 수 없다).
- **지정 실행기를 확인할 수 없으면 시작하지 않는다.** 실행 줄의 `executorId`가 작업자 실행기 주체 이름이 아니면(빠짐, 빈 문자열, 꼴이 틀림, 읽다 던짐) 집합이 비어 있어도 `executor_unknown`이다. 이름을 모르면 그 실행기가 집합에 있는지 가릴 수 없고, 시작 지시를 받을 쪽도 모른다. 빈 집합의 박자는 이 입력이 없을 때와 같되 이 한 곳만 다르다: 이 입력이 없으면 그런 실행도 시작되지만, 여기서는 시작하지 않는다(닫는 쪽). 실제 장부는 작업자 실행에 그 역할의 작업자 실행기 이름만 적으므로(배정의 입력 검사) 정상 행에서는 달라지는 것이 없다.
- **대기열의 맨 앞이 막히면 그 박자에는 어떤 작업자도 시작하지 않는다.** `planNext`는 작업자 슬롯 하나에 후보 하나를 낸다. 그 후보가 막히면(`withheld`) 이 박자는 그 실행을 건너뛰고, 대기열을 다시 계산해 다음 실행을 고르지 않는다. 그래서 그 실행이 시작 후보로 계속 뽑히는 동안 다른 실행기의 대기 실행도 시작되지 않는다(닫는 쪽). 그 실행기가 집합에서 빠지거나, 그 실행이 취소되는 등으로 `planNext`가 다른 후보를 내면 풀린다. 대기열의 순서 규칙은 `planNext`의 몫이라 이 박자가 바꾸지 않는다(아래 "남는 한계").

## 시각

- 판단(`pickAssignment`, `planNext`)과 장부 쓰기(`assignToolRequest`·`startRun`의 `now`)는 인자로 받은 `now` 하나를 쓴다.
- 시작 지시의 머리 `issued_at`은 `startRun`이 돌려준 `issuedAt`이다(장부가 자기 시계로 정한 값, `envelopes.md` "시각 규칙").
- **송신 표식의 시각(`marked_at`)은 봉하는 시각과 같다.** 이 박자가 아는 가장 늦은 시각이다. 표식의 시각은 장부가 판정에 쓰지 않는다(D-90은 표식의 열기 ID만 본다).
- **봉하는 시각은 `now`와 `issuedAt` 가운데 늦은 값이다.** 장부는 박자의 `now`를 읽은 뒤 같은 시계로 발행 시각을 정하므로 `issuedAt`이 `now`보다 늦을 수 있고, 그때 `now`로 봉하면 `sealDraft`가 `issued_in_future`로 막는다. 늦은 값도 같은 시계에서 읽은 값이다. 실제로 싣는 시각의 봉투 시한과 작업 기한의 여유는 내보내기 포트가 다시 잰다(`ports.ts`의 `InstructionSink`).
- **실행 기한(`deadlineAt`)은 박자의 `now`부터 센다.** 잇기는 사실·자격 포트를 기다린 뒤 장부에 쓰지만 `now`는 박자 처음의 값이라, 기다리는 동안 흐른 시간만큼 실제 잇는 순간보다 기한이 먼저 흐르고, 조회가 길면 이은 직후에 이미 지나 있을 수 있다(그 실행은 `planNext`가 `deadline_passed`로 보류한다).

## 사실·자격·후보 연결

- **사실(`facts`):** 배정 전 거절의 사실을 그 부탁과 대조해 채우는 쪽은 포트다. 모르는 칸은 비운다. 포트가 던지면 빈 사실로 넘겨 고르기가 `evidence_missing`으로 보류한다. 이 모듈은 사실을 지어내지 않는다.
- **자격(`credentials`):** 고르기와 같은 `selectAccount(부탁의 역할, accounts)`로 계정을 정해 그 계정의 참조를 묻는다. 계정이 없으면 묻지 않는다(고르기가 `no_account`). `known: false`이거나 던지면 `null`로 넘겨 고르기가 `credential_unknown`으로 보류한다. 꼴과 계정 대조는 고르기가 한다.
- **후보 연결(`connections`):** `Connections.candidates(복원기)`는 정지 세대를 모르면 빈 목록을 낸다. "후보 없음"과 "모름"을 가르려면 감싸는 조립 코드가 세대를 모를 때 `known: false`를 낸다.

## 내보내지 못했을 때

`startRun`이 성공한 뒤의 실패는 `recorded_not_sent`다. 예외 하나: 결과를 만들기 전에 성공 답의 칸(`run`, `issuedAt`, 실행 줄의 칸)을 읽다 던지면 시작 결과 없이 `halted: "threw"`이고 `haltedAt`이 그 실행이므로, 부르는 쪽은 장부에서 그 실행을 조회한다(위 "박자가 멈출 때"). 그 실행은 장부에 적힌 그대로(`preparing`, `task_start` 지시 한 줄) 두고, 새 실행 ID·새 요청 ID로 다시 만들지 않는다. 다음 박자에는 그 실행이 대기가 아니라 `planNext`의 후보가 되지 않고, 그 자리를 쥔 채라 다른 시작도 없다.

| `reason` | `delivery` |
|---|---|
| `ledger_answer_malformed`(답의 실행 ID가 넘긴 것과 다름 등), `draft_threw`, `startDraft`의 거절 이름, `seal_threw`, `sealDraft`의 거절 이름(`field`·`sealReason` 함께) | `not_sent` |
| `sink_unavailable`(내보내기 포트나 그 `send`를 얻다 던지거나 함수가 아님. 포트를 부르지 않았고 표식도 적지 않았다) | `not_sent` |
| `start_unmarked`(송신 표식이 `ok`가 아님. `markReason`: 장부의 거절 이름(`ledger_unwritable` 등), `threw`, `malformed_answer`, `envelope_unreadable`) | `not_sent` |
| `no_connection`, `too_late_to_send` | `not_sent` |
| `send_threw`, `send_answer_malformed` | `unknown`: 포트가 연결에 실었는지 모른다 |

표식이 없는 `start_unmarked`·`sink_unavailable`·봉투를 만들지 못한 실패는 실리지 않은 것이 확실하다. 장부에 적힌 시작은 그대로 답을 기다리는 지시로 남고, 재전송 박자가 같은 요청으로 다시 표식을 적고 싣는다. 표식 뒤에 싣지 못한 길(`no_connection`·`too_late_to_send`·`delivery: "unknown"`, 포트 호출 전의 프로세스 죽음)은 `send-gate.md` "표식 뒤에 싣지 않고 돌아가는 길"이다. 이 박자에는 시계 포트가 없어 표식과 송신 사이에 시계를 다시 읽지 않는다.

`requestId`, `runId`, `stopGeneration`, `issuedAt`(장부의 답에서 읽지 못했으면 `null`), `executorId`를 싣는다. 이 값은 처음 지시를 가리키는 식별값이고, 본문을 다시 만들 재료는 아니다. 본문(예산 등)은 장부의 실행 줄에서 오므로 그 뒤 장부가 바뀌면 같은 식별값으로 다시 만든 본문이 처음과 다를 수 있다. 결과에는 본문이나 자격 참조를 싣지 않는다.

## 이 박자가 하지 않는 것

갱신·취소·확정·조회, 영수증 처리, 재전송, 연결 상실 반영, 자격 값 전달(계약 v1에 그 메시지가 없다. 시작 지시는 자격 참조만 싣는다), 세션 시작. 대기 부탁 목록은 소유자를 가리지 않는 감독 안쪽의 읽기라 본체의 도구 처리기(`scheduler/tools.ts`)의 포트에 잇지 않는다(이 모듈은 그 파일을 import하지 않는다).

## 남는 한계

- **시작을 장부에 적은 뒤 내보내기 포트가 기다리는 동안 그 실행기가 맡기지 않을 실행기 집합에 들어오면, 이미 만든 시작 봉투가 그 실행기에 실린다.** 이 박자의 판정은 `startRun` 직전이고 그때는 그 실행기가 집합에 없었다. 내보내기 포트를 부른 뒤 실제로 싣기까지의 사이는 이 박자가 보지 않으며, 포트를 부르기 전에 한 번 더 읽어도 그 사이는 남는다. 막는 자리는 내보내기 포트다(아래 "뒤 조각이 지킬 것").
- **대기열 맨 앞이 막힌 실행기의 실행이면 그동안 어떤 작업자도 시작하지 않는다.** 시작 후보의 판단(`planNext`)이 작업자 후보를 하나만 내기 때문이다. 이 입력이 없으면 맨 앞 실행이 시작되어 슬롯을 쥐므로 뒤 실행이 기다리는 것은 같지만, 여기서는 아무 작업자도 시작하지 않은 채 기다린다. 막힌 후보 다음의 실행을 고를지는 뒤의 설계이고, 고른다면 같은 입력으로 공정성과 작업자 슬롯 하나의 보장을 함께 시험한다.

## 뒤 조각이 지킬 것

- **박자를 되풀이해 부른다.** 이번 박자에 이은 실행은 다음 박자에 시작 후보가 된다. 결과에 `assigned`가 있으면 곧 다시 부른다.
- **`recorded_not_sent`는 처음의 본문 또는 그와 같음을 대조할 근거가 있을 때만 재전송하고, 없으면 같은 실행을 조회한다.** 재전송은 같은 요청 ID·같은 본문·새 nonce로 새 봉투에 담는다. 시작 지시는 발행 시각이 고정이라 `issuedAt + 19000ms`까지만 다시 봉할 수 있고(`envelopes.md`), 작업 기한이 더 이르면 그만큼 앞당겨진다. 결과 목록은 메모리에만 있으므로, 감독이 그 전에 죽으면 장부에서 보내지 않은 지시를 찾는 읽기가 필요하다(장부에 아직 없다).
- **`delivery: "unknown"`은 보냈을 수도 있다.** 같은 길이다. 새 요청 ID로 다시 만들지 않는다.
- **`halted`를 반드시 본다.** `kind`와 두 목록만으로는 멈춘 박자를 정상으로 읽는다. `halted: "threw"`이면 `haltedAt`의 항목만이 아니라 그 박자의 결과 목록에 없는 대기 부탁·실행 전체를 장부에서 다시 읽는다(`haltedAt`이 앞서 끝낸 항목을 가리킬 수 있다). 멈춘 항목에 쓰기가 있었는지 결과로는 모른다.
- **박자가 예외로 끝나면 쓰기가 없었다고 가정하지 않고 장부를 다시 읽는다.** 지금은 쓰기 전의 읽기를 해석하다 던질 때만 예외로 끝나고 그때 쓰기는 0이지만, 부르는 쪽은 그것에 기대지 않는다.
- **내보내는 포트는 실제로 싣는 시점에 정지 세대와 접수를 다시 본다.** 이 박자는 `startRun` 직전에 접수를 다시 보지만, 내보내기 포트가 비동기로 기다리는 동안 정지가 들어오면 옛 세대의 봉투가 실린다(실행기는 새 세대에서 `stop_generation_mismatch`로 거절한다). 싣기 직전에 대조하거나, 대조부터 싣기까지를 동기적으로 끝낸다. 지정 실행기의 살아 있는 연결과 봉투·작업 기한의 남은 여유도 이 시점에 잰다.
- **작업 자리는 종료 근거로만 푼다.** 시작을 받은 적 없는 실행을 D-90으로 풀려면 접수 영수증 없음, 추가 시작 송신 중단과 마지막 봉투의 만료, 그 뒤 전체 점유에서 부재가 함께 성립해야 한다. 기한 지난 대기 실행의 마감과 재시작 뒤 미응답 지시의 복원은 뒤 조각이다.
- **`now`는 장부 시계와 같은 시계에서 박자마다 한 번 읽은 값이고 후퇴하지 않는다**(`planNext`의 조건).
- **세션 후보(`not_worker`)는 세션 계약 작업이 연다.** 그 전에는 세션 대기 실행이 후보로 남아도 이 박자는 부르지 않는다.
- **조립은 인사 처리기의 `withhold`를 실행기 전체 이름으로 모아 `withheld` 포트로 넘긴다.** `passHelloAnswer`·`retryHelloAnswer`가 `withhold`를 낸 실행기(`held`, `ledger_unsaved`, `ledger_failed`)를 넣는다. 포트는 부를 때마다(박자 처음과 박자 중의 다시 읽기마다) 그 순간의 최신 집합을 낸다. 읽기를 보장할 수 없으면 `known: false`를 내고 빈 배열로 대신하지 않는다(빈 배열은 "없음"이라 그 실행기에게 시작이 나간다). `listed`와 `no_executor`를 구별하려면 후보 포트(`connections`)에는 집합으로 거르기 전의 연결을 넘긴다(후보 포트가 미리 거르면 맞는 실행기가 맡기지 않을 실행기뿐인 부탁이 `no_executor`로 나온다).
- **집합에서 빼는 때는 그 실행기의 붙든 답이 모두 반영되고 지금 연결의 인사가 반영된 뒤다.** 그 실행기의 붙든 답(`held`, `retry`가 있는 실패)을 받은 차례로 `applied`가 되게 하거나 `not_current`로 버리고, 그 뒤 그 실행기의 **현재 연결 인사**가 `applied`가 될 때까지 뺀다. 옛 연결의 `retry` 한 건이 성공해도 풀지 않는다. `input_rejected`(다시 넘길 값 없음)면 계속 뺀다. 마지막 `held`의 재처리를 현재 연결 인사의 반영으로 셀 조건은 조립이 명시한다(`hello-answers.md` "뒤 조각이 지켜야 할 것").
- **영수증 처리기 쪽의 같은 종류의 실패를 같은 집합에 넣을지는 조립이 정한다.** 상태 보고(`forward`)를 장부에 반영하지 못한 실행기도 장부가 그 실행기의 점유를 모르는 상태다. 이 박자는 집합에 든 이름만 보고 그 이름이 어디서 왔는지 가리지 않는다.
- **내보내기 포트는 실제로 싣는 순간에 받는 실행기가 맡기지 않을 실행기 집합에 있는지, 집합이 모름인지도 본다.** 그 순간은 마지막 비동기 기다림을 지난 자리다. 집합에 있거나 모름이면 싣지 않고, 이미 장부에 적힌 실행을 가리키는 "못 보냄"의 결과를 낸다. 같은 시작을 다시 싣는 재전송에도 같은 규칙이 필요하다. 포트를 부르기 전에만 한 번 더 읽어서는 막지 못한다(위 "남는 한계").
- **`withheld` 결과는 "이 호출이 그 부탁을 잇지 않았다, 그 실행을 시작하지 않았다"는 뜻이다.** 그 부탁·실행의 지금 장부 단계를 보장하지 않는다(겹친 박자의 다른 호출이 이미 이었을 수 있다). 막힌 동안 박자마다 되풀이될 수 있으므로 반복 보류 지표는 실행 ID·부탁 참조로 묶어 한 번으로 세고, 재시도나 지표에 지금 단계가 필요하면 장부를 다시 읽는다.
