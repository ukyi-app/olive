# 취소 포트 어댑터 (`cancel.ts`)

본체(오케스트레이터 세션)의 `cancel_worker`가 부르는 도구 처리기의 취소 포트(`src/supervisor/scheduler/tools.ts`의 `requestCancel`)를 장부와 실행기 연결에 잇는다. **취소는 장부에 먼저 적고, 장부가 적은 지시 줄의 값 그대로만 `task_cancel`로 내보낸다.** 처리기에는 장부의 사실만 답하고, 전달의 결과는 관측 포트로 따로 낸다. 장부·연결·시계·난수·서명·내보내기·관측은 포트로만 받고 상태를 쥐지 않는다. 소켓·타이머·시계·난수를 직접 부르지 않는다(시험이 소스를 읽어 지킨다).

## 공개 면

```ts
cancelAdapter(ports: CancelPorts): (input: CancelInput) => Answer<CancelWrite>   // tools.ts의 requestCancel 자리

CancelPorts = {
  ledger: Pick<Ledger, "cancelToolRequest" | "unansweredInstructions">
  links: CancelLinkGate   // { mayIssue(executorId, "task_cancel"): { ok: true } | { ok: false, reason: string } }, 동기
  clock: Clock            // ports.ts. 장부 시계와 같은 시계
  random: Random          // 호출 ID(= 지시의 요청 ID), nonce
  signer: Signer
  sink: InstructionSink
  observe(event: CancelDelivery): void   // 호출마다 한 번(내보내기 포트의 약속이 끝나지 않으면 마지막 결과는 오지 않는다)
}
```

`CancelInput`·`CancelWrite`·`Answer`는 `tools.ts`의 꼴 그대로다. 처리기의 포트는 동기이고 내보내기는 비동기라, 전달의 결과는 답에 실을 자리가 없어 `observe`로 낸다. 실었는지(`sent`·`delivery_unknown`)와 내보내기 포트의 거절은 처리기에 답한 뒤에 온다. `observe`가 던져도 답과 장부에 닿지 않는다.

## 한 호출의 순서

1. 입력의 `ref`·`owner`·`sessionId`를 한 번씩 읽는다(문자열이 아니면 `not_recorded`/`input_malformed`).
2. 호출 ID를 난수 포트로 새로 만든다(`newUuid`). 못 만들면 `random_unavailable`.
3. 시계를 한 번 읽는다(양의 안전 정수가 아니면 `clock_unavailable`). 여기부터 장부 호출까지 포트도 `await`도 없다.
4. `cancelToolRequest({ owner, ref, sessionId, callId: 새 호출 ID, now: 읽은 시각 })`.
5. 답이 이 요청 ID의 지시를 실은 `stopping`이면, 같은 동기 흐름에서 `unansweredInstructions()`로 **그 요청 ID의 지시 줄**을 찾아 대조한다(아래 "지시 줄의 대조").
6. 연결 포트 `mayIssue(지정 실행기, "task_cancel")`.
7. `stopDraft` → `sealDraft(초안, 기록 시각)` → `sink.send` 한 번.

1~4에서 멈추면 장부에 아무것도 적히지 않았거나(거절) 무엇이 적혔는지 모른다. 5~7에서 멈추면 장부에는 취소가 적혔고 처리기의 답은 그대로 `stopping`이다.

## 장부의 답 × 처리기에 주는 답

`cancelToolRequest`의 답 갈래 전부다(`src/ledger/ledger.ts`의 `cancelToolRequest`·`#recordStop`·`#write`, `ledger.md` "이은 부탁의 취소"). 시험은 `test/supervisor/dispatch/cancel.test.ts`의 "장부의 답 갈래마다"(가짜 장부)와 "실제 장부: …"(임시 파일)다.

| 장부의 답 | 언제 | 처리기에 주는 답 | 내보내기 | 관측 |
|---|---|---|---|---|
| `{ ok: true, phase: "not_started" }`(지시 없음) | 배정 전 대기의 부탁, 시작 전(`queued`) 실행 | `{ ok: true, phase: "not_started" }` | 없음 | `nothing_to_send` |
| `{ ok: true, phase: "stopping", instruction }` | 시작 뒤(`preparing`·`running`·`unknown_running`·`stopping`) | `{ ok: true, phase: "stopping" }` | 지시 줄 대조 뒤 한 번 | `sent` / `recorded_not_sent` / `delivery_unknown` |
| `{ ok: false, reason: "transition_denied" }` | 종료가 확인됐거나 끝난 실행, 이미 `not_started`인 부탁 | `{ ok: false, reason: "already_ended" }` | 없음 | `refused` |
| `stop_unknown` | 정지 기록이 없는 장부의 시작 뒤 실행 | 모름(`known: false`) | 없음 | `refused` |
| `invariant_violation` | 같은 호출 ID의 지시가 이미 있음(난수 포트가 같은 값을 냄), 실행 종류와 동작이 어긋남 | 모름 | 없음 | `refused` |
| `unknown_run` | 남의 부탁·없는 부탁(처리기가 이미 거른 뒤라 경합이나 포트의 결함) | 모름 | 없음 | `refused` |
| `ledger_unwritable` | 닫힌 장부, 쓰기 실패 | 모름 | 없음 | `refused` |
| 그 밖의 거절 이름(`REFUSALS`) | 이 연산의 코드에서 직접 내는 길은 없다. 제약 위반을 이름으로 옮기는 `constraintRefusal`로는 나올 수 있다 | 모름 | 없음 | `refused` |
| 던짐(`LedgerInputError` 포함) | 입력 꼴, 예외 | 모름 | 없음 | `record_unknown`(`threw`) |
| 정의 밖의 답 | 객체 아님, `ok`가 불리언 아님, 모르는 거절 이름, `not_started`·`stopping` 밖의 단계, 지시 없는 `stopping`, 지시를 실은 `not_started`, 지시의 요청 ID가 넘긴 호출 ID와 다름, 지시의 실행 ID가 UUID가 아님, 지시의 정지 세대가 없거나 0 이상의 안전 정수가 아님 | 모름 | 없음 | `record_unknown`(`malformed_answer`) |

**적었다고 답하는 것은 장부가 정의 안의 성공을 돌려줬을 때뿐이다.** 정의 밖의 답은 무엇이 적혔는지 모르는 답이라 적혔다고 답하지 않고 내보내지도 않는다. `record_unknown`의 `requestId`는 지시가 적혔다면 그 요청 ID다(재전송 읽기에서 찾을 수 있다).

## 지시 줄의 대조

장부의 답(`instruction`)에는 요청 ID·정지 세대·실행 ID만 있고 **받는 실행기와 실행 세대가 없으며, 사유는 지시 줄에만 있다.** 그래서 `unansweredInstructions()`에서 그 요청 ID의 줄을 찾아 그 줄의 값으로만 초안을 만든다. 재전송 박자가 쓰는 것과 같은 읽기라, 처음 봉투와 재전송 봉투의 본문이 같은 줄에서 나온다. 이 읽기는 `cancelToolRequest`와 같은 동기 흐름에서 부르므로 그 사이에 이 요청 ID의 영수증이 장부에 닿을 수 없다. 장부 전체를 읽는 읽기라 지시가 많으면 그만큼 느리다.

| 대조 | 어긋나면(`recorded_not_sent`의 `reason`) |
|---|---|
| 읽기가 `known: true`이고 꼴이 맞다 | `read_unknown`(던짐 포함) |
| 장부의 지금 정지 세대가 있다 | `stop_generation_unknown` |
| 그 세대가 0 이상의 안전 정수다 | `read_unknown` |
| 그 세대가 지시의 정지 세대와 같다 | `stop_generation_changed` |
| 그 요청 ID의 줄이 정확히 하나 | 없으면 `instruction_not_found`, 둘 이상이면 `instruction_mismatch` |
| 줄의 동작이 `task_cancel`, 실행 ID·정지 세대가 답과 같고, 실행 세대가 1 이상, 지정 실행기가 문자열 | `instruction_mismatch` |
| 본문을 다시 만들 칸이 `task_cancel`의 계약 사유 | `not_rebuildable` |

**정지 세대를 모르면 내보내지 않는다.** 실행기는 머리의 정지 세대가 자기 값과 정확히 같을 때만 받고, 적용 전이면 장부가 이미 넘어선 옛 세대의 지시를 받는다(`ledger.md` "재전송").

## 관측 (`CancelDelivery`)

모든 항목에 `ref`(작업 참조)가 있다. 원문·자격 참조·봉투·서명·nonce는 싣지 않는다(시험이 관측의 JSON에 자격 digest·계정·서명·nonce·원문 참조가 없음을 본다).

| `outcome` | 칸 | 뜻 |
|---|---|---|
| `not_recorded` | `reason`: `input_malformed`·`random_unavailable`·`clock_unavailable` | 장부를 부르지 않았다 |
| `refused` | `requestId`, `reason`(장부의 거절 이름) | 장부가 거절했다. 아무것도 적히지 않았다 |
| `record_unknown` | `requestId`, `reason`: `threw`·`malformed_answer` | 무엇이 적혔는지 모른다 |
| `nothing_to_send` | `requestId` | 적었고 보낼 지시가 없다 |
| `sent` | `requestId`, `runId`, `executorId` | 적었고 연결에 실었다. 받았다는 뜻은 아니다 |
| `recorded_not_sent` | `requestId`, `runId`, `executorId`(대조 전이면 `null`), `reason`, (`field`·`sealReason`) | 적었지만 싣지 않았다. `reason`은 위 대조의 이름, `no_connection`·`link_unknown`(연결 포트), `draft_threw`·`seal_threw`·봉투 모듈의 거절 이름, 내보내기 포트의 `no_connection`·`too_late_to_send` |
| `delivery_unknown` | `requestId`, `runId`, `executorId`, `reason`: `send_threw`·`send_answer_malformed` | 내보내기 포트를 불렀고 실었는지 모른다 |

## 전달이 실패하면

처리기의 답은 바꾸지 않는다(장부에는 취소가 적혔다). 이 어댑터는 같은 봉투도 새 봉투도 다시 보내지 않는다. 그 지시는 맞는 영수증이 없어 `unansweredInstructions()`에 같은 요청 ID로 남고, 같은 요청 ID·같은 본문을 다시 보내는 것은 재전송 박자의 몫이다. 시험은 연결 없음·연결 포트의 예외·서명 실패·내보내기의 거절·예외·거부·정의 밖의 답·다시 읽기의 모름·관측 포트의 예외마다 답이 `stopping` 그대로이고, 내보내기 포트를 부른 횟수가 0 또는 1이며, 그 지시가 재전송 읽기에 남는 것을 본다.

## 정한 것

- **호출 ID는 처리기 문맥의 `callId`가 아니라 난수 포트의 새 UUID다.** 장부는 이 값을 지시의 요청 ID로 쓰고 같은 값을 다시 받으면 `invariant_violation`으로 막는다(`ledger.md` "배정기와 조립 코드가 지킬 것" 4). 문맥의 호출 ID는 꼴(UUID)만 검사될 뿐 호출마다 새것이라는 보장이 없다. 대가: 배정 전 대기의 부탁을 취소하면 장부의 `cancel_call_id`에는 세션의 호출 ID가 아니라 이 UUID가 남는다. 세션 쪽 호출과의 대응은 관측의 `ref`·`requestId`로 잇는다.
- **기록 시각은 문맥의 `now`가 아니라 시계 포트를 장부 호출 직전에 한 번 읽은 값이다.** 이 시각이 `lastStopAt`이 되고 수명 판단이 같은 시계로 답을 기다리므로 다른 출처의 시각을 섞지 않는다(`ports.ts`의 `Clock`). 처음 봉하는 시각도 이 값이다(`envelopes.md` "시각 규칙").
- **사유 칸은 넘기지 않는다.** `cancelToolRequest`는 사유 칸을 받지 않고(넘기면 `LedgerInputError`) 이은 부탁의 취소에 늘 `requested`를 적는다. 그래서 이 어댑터가 적는 줄은 늘 다시 만들 수 있다(시험이 지시 줄의 `reason`과 재전송 읽기를 본다).
- **연결은 적은 뒤에 본다.** 취소는 연결이 없어도 적는다(전해야 할 것이 남았다는 기록). 연결 포트가 막으면 내보내기를 부르지 않는다.

## 수명 박자와 겹칠 때: 한 실행의 종료 지시는 몇 줄인가

장부는 끝나지 않은 실행(`preparing`·`running`·`unknown_running`·`stopping`, 종료 확인 없음)에 새 요청 ID의 `task_cancel`을 받을 때마다 줄을 하나 더 적는다(`#recordStop`, `ledger.md` "이은 부탁의 취소"의 `stopping`). 줄 수를 막는 장부의 조건은 없다.

- **수명 박자(`life-loop.ts`)는 실행마다 많아야 한 줄이다.** 쓰기 직전에 다시 읽어 `lastStopAt`이 있으면 적지 않는다(`superseded`). 그 다시 읽기와 쓰기 사이에 `await`가 없고 이 어댑터의 쓰기도 동기라, 한 프로세스 안에서 어댑터의 쓰기가 그 사이에 끼지 않는다. 어댑터가 먼저 적으면 박자는 둘째 줄을 적지 않는다.
- **이 어댑터는 받아들여진 `cancel_worker` 호출마다 한 줄이다.** 박자가 먼저 `deadline`을 적은 실행에도, 앞서 취소한 `stopping` 실행에도 새 요청 ID로 한 줄을 더 적고 그 줄만 보낸다(시험 "수명 박자가 먼저 적은 종료 뒤의 취소도", "같은 부탁의 취소를 두 번"). 종료 확인 영수증 뒤에는 `already_ended`라 더 적지 않는다.
- **그래서 한 실행의 줄 수는 (박자의 많아야 한 줄) + (종료 확인 전에 받아들여진 취소 호출 수)다.** 비상 정지의 종료 등 다른 경로가 더 적을 수 있다. 실행기는 새 요청 ID의 취소마다 지금 세대·지금 연결이면 새 접수 영수증을 내고, 닫는 효과는 처음 받은 것에서 이미 시작했다(`src/executor/worker.ts`의 `onCancel`·`answerCancel`). 영수증을 받지 못한 줄은 줄마다 재전송 읽기에 남는다.

## 내보내기 포트의 조건

`ports.ts`의 `InstructionSink`가 지킨다. 이 어댑터는 봉할 때(기록 시각) 시한의 여유만 보고, 실제로 싣는 순간은 보지 못한다.

- **싣는 순간에 정지 세대를 다시 본다.** 이 어댑터는 기록 직후 장부의 지금 세대와 지시의 세대가 같을 때만 부른다. 포트를 부른 뒤 실제로 싣기까지 세대가 올라가면 옛 세대의 지시가 나간다. 실행기가 새 세대를 적용했으면 받지 않고, 적용 전이면 받는다.
- **시한 뒤에는 싣지 않는다.** 봉투 시한까지 `DELIVERY_MAX_MS + CLOCK_SKEW_MS`가 남지 않으면 `too_late_to_send`이고 고치거나 새 요청 ID로 다시 만들지 않는다.
- **연결이 살아 있지 않으면 싣지 않는다**(`no_connection`). 쌓아 두었다가 다시 붙은 뒤 보내지 않는다.

## 이 어댑터가 하지 않는 것

재전송(답 없는 지시를 같은 요청 ID로 다시 보내기), 영수증 처리, 세션(본체 자신)을 멈추는 `session_stop`, 비상 종료, 같은 호출 ID의 응답 재생(세션 계약), 처리기(`tools.ts`)의 다른 포트.

## 뒤 조각이 지킬 것

- **조립:** 처리기의 `requestCancel`에 `cancelAdapter(…)`를 넣고, `links`는 그 실행기의 `Link`와 부르는 순간의 시각으로 계약 v1의 `mayIssue("task_cancel", …)`를 동기로 부른다. `clock`은 장부에 주입한 시계와 같은 시계다.
- **관측을 받는다.** `record_unknown`은 장부를 다시 읽어(`unansweredInstructions()`의 그 `requestId`) 적혔는지 가린다. `recorded_not_sent`·`delivery_unknown`은 재전송 박자가 같은 요청 ID로 다시 낸다. 관측만 보고 새 요청 ID로 다시 적지 않는다.
- **직렬화:** 장부는 한 프로세스만 열고, 이 어댑터와 수명 박자는 같은 이벤트 루프에서 부른다. 이 어댑터는 시계 읽기부터 지시 줄 대조까지 `await`가 없어야 한다(포트를 비동기로 바꾸면 수명 박자의 다시 읽기와 쓰기 사이에 끼어 같은 실행에 박자의 줄이 하나 더 생길 수 있다).
- **줄 수를 더 막으려면** 장부의 조건부 쓰기(예: 이미 종료 지시가 있는 실행의 취소는 기존 지시를 돌려줌)가 필요하다. 지금은 위 "몇 줄인가"대로 줄마다 나간다.
- **내보내기 포트**는 위 "내보내기 포트의 조건"을 싣는 순간에 지킨다.
