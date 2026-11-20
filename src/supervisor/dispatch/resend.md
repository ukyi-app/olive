# 답을 받지 못한 지시의 재전송 (`resend.ts`)

배정기 순환의 한 박자다. 장부의 `unansweredInstructions()`가 낸 지시(시작, 취소, 확정)마다 그 항목의 값만으로 초안을 다시 만들어 봉하고 지정 실행기의 연결에 싣는다. **장부에 쓰지 않는다**(장부 포트가 읽기 하나뿐이다). 새 요청 ID를 만들지 않는다. 실행기는 같은 요청 ID·같은 본문의 재전송에 이미 낸 영수증을 다시 보내므로(`src/ledger/ledger.md` "답을 받지 못한 지시"), 답이 오면 그 지시는 읽기에서 사라지고 재전송은 저절로 멈춘다.

장부·접수·연결·시계·난수·서명·내보내기는 포트로, 정책과 앞 박자들의 기억(지시마다 마지막으로 내보낸 시각)은 인자로 받는다. 소켓·타이머·시계·난수를 직접 부르지 않는다(시험이 소스를 읽어 지킨다). 쥐는 것은 같은 장부 포트로 박자가 진행 중이라는 표시 하나다.

## 공개 면

```ts
resendTick(ports: ResendPorts, policy: ResendPolicy, input: ResendTickInput): Promise<ResendTickResult>

ResendPorts = {
  ledger: Pick<Ledger, "unansweredInstructions">
  intake: Pick<Restorer, "intakeOpen">        // 시작을 다시 낼 때만 본다
  links: ResendLinkGate                        // { mayIssue(executorId, "task_start" | "task_cancel" | "result_finalize"): { ok: true } | { ok: false, reason } }, 동기
  clock: Clock                                 // 장부 시계와 같은 시계
  random: Random                               // nonce만
  signer: Signer
  sink: InstructionSink
}
ResendPolicy = { resendEveryMs: number }       // 양의 안전 정수
ResendTickInput = { lastResends: { requestId: string, at: number }[] }

ResendTickResult =
  | { kind: "not_run", reason: "clock_unavailable" | "policy_rejected" | "input_malformed" | "read_unknown" | "stop_generation_unknown" | "tick_in_progress" }
  | { kind: "ran", instructions: ResendOutcome[], halted: "threw" | null, haltedAt: string | null }

START_LAST_SEAL_MS = 19000   // 시작을 다시 봉할 수 있는 발행 뒤 거리
```

`ResendLinkGate`는 계약 v1의 `mayIssue(action, link, now)`를 그 실행기의 연결과 부르는 순간의 시각으로 부른 답이다(수명 박자의 `LinkGate`와 같은 뜻, 동작 이름만 넓다).

| 지시마다 (`ResendOutcome`) | 뜻 |
|---|---|
| `resent` + `executorId`, `sealedAt`, `at` | 같은 요청을 새 봉투에 담아 실었다(`sent`는 받았다는 뜻이 아니다). `sealedAt`은 봉할 때 읽은 시각, `at`은 다음 박자의 `lastResends`에 넘길 시각(내보내기 포트가 돌아온 뒤 읽은 시각, 읽지 못하면 그 봉투의 시한) |
| `held` + `lastAt` | `lastAt`(항목의 발행 시각과 넘겨받은 마지막 송신 시각 가운데 늦은 것)부터 간격이 지나지 않았다 |
| `answered` | 싣기 직전에 다시 읽으니 더는 답을 기다리는 지시가 아니다 |
| `not_rebuildable` | 장부가 본문을 다시 만들 수 없다(`rebuild: null`). 부르는 쪽은 같은 실행 ID를 조회한다 |
| `start_expired` + `issuedAt`, `expiresAt` | 시작의 재전송 한도(발행 + 19000ms)가 지났다. `expiresAt`은 그 시작의 모든 봉투가 갖는 시한(발행 + 30000ms) |
| `stop_generation_mismatch` + `stopGeneration`, `currentStopGeneration` | 항목의 정지 세대가 장부의 지금 세대와 다르다 |
| `withheld` + `reason` | 봉하지 않았다: `session_run`(세션 실행의 지시), `stop_recorded`(종료가 적힌 실행의 시작), `intake_closed`(시작만), `no_connection`(연결 포트가 문자열 `reason`과 함께 거절), `link_unknown`(연결 포트가 던지거나 답이 정의 밖), `clock_unavailable`(시계가 던지거나, 양의 안전 정수가 아니거나, 앞서 읽은 시각보다 이름), `read_unknown`(싣기 직전의 다시 읽기가 모름이거나 같은 요청 ID의 칸이 처음과 다름. 대조하는 칸은 동작·실행 ID·실행 세대·지정 실행기·정지 세대·발행 시각과 본문을 다시 만들 칸 전부) |
| `not_sealed` + `reason`(`field`, `sealReason`) | 초안·봉하기의 거절 이름, `draft_threw`, `seal_threw`. 실리지 않았다 |
| `not_sent` + `reason`, `delivery`, `executorId`, `sealedAt` (+ `at`) | `no_connection`·`too_late_to_send`(`delivery: "not_sent"`, `at` 없음), `send_threw`·`send_answer_malformed`(`delivery: "unknown"`: 실렸을 수 있다. `at`은 `resent`와 같은 규칙) |
| `malformed` + `field` | 항목의 칸을 읽을 수 없다(`requestId`를 읽지 못했으면 `null`). 같은 요청 ID의 항목이 둘 이상이면 모두 `malformed`(`requestId`) |

모든 항목(`malformed` 밖)은 `requestId`, `runId`, `action`을 싣는다. 결과에는 본문·자격 참조·봉투·서명·nonce가 없다(시험이 결과의 JSON에 자격 digest·서명·nonce가 없음을 본다).

## 한 박자의 순서

1. **박자 전체의 전제.** 장부 포트(`ports.ledger`를 한 번 읽어 얻은 객체. 읽다 던지거나 객체가 아니면 `read_unknown`), 같은 장부 포트로 진행 중인 박자가 없음(있으면 `tick_in_progress`, 읽기 0), 시계, 정책의 간격, `lastResends`의 꼴, `unansweredInstructions()`. 읽기의 `known`이 불리언 `true`가 아니거나 값의 꼴이 틀리거나 던지면 `read_unknown`이고 아무것도 봉하지 않는다. 정지 세대가 `null`(정지 기록 없음)이면 `stop_generation_unknown`이다. 정지 기록이 없으면 장부가 지시를 적지 않으므로 대조할 세대를 모르는 읽기다.
2. **항목마다, 읽기의 순서대로** 아래를 차례로 본다. 앞에서 걸리면 그 이유가 결과다.

| 차례 | 보는 것 | 걸리면 |
|---|---|---|
| 1 | 다시 읽기: 장부를 다시 읽어 같은 요청 ID의 항목을 찾는다. 판단은 모두 이 읽기의 값으로 한다 | `withheld`(`read_unknown`), `answered`, `malformed` |
| 2 | 세션의 시작·정지 | `withheld`(`session_run`) |
| 3 | 본문 칸 | `not_rebuildable` |
| 4 | 시계(박자 처음과 앞 항목의 시각보다 이르지 않음) | `withheld`(`clock_unavailable`) |
| 5 | 시작: 시각이 발행 + 19000ms 이하 | `start_expired` |
| 6 | 항목의 정지 세대 = 다시 읽은 장부의 정지 세대 | `stop_generation_mismatch` |
| 7 | 시작: 같은 실행에 종료가 적히지 않음(같은 읽기에 그 실행의 종료 항목이 없고 상태가 `stopping`이 아님), 접수가 열림 | `withheld`(`stop_recorded`, `intake_closed`) |
| 8 | 간격: `시각 − max(항목의 발행 시각, lastResends의 그 요청 ID) >= resendEveryMs` | `held` |
| 9 | 연결: `links.mayIssue(지정 실행기, 동작)` | `withheld`(`no_connection`, `link_unknown`) |
| 10 | 시작: 시계를 다시 읽어 발행 + 19000ms 이하 | `withheld`(`clock_unavailable`), `start_expired` |
| 11 | 초안(항목의 값만) → `sealDraft(초안, 봉하는 시각)` | `not_sealed`, 시작의 `too_late_to_send`는 `start_expired` |
| 12 | 시작: 시계를 다시 읽어 발행 + 19000ms 이하(봉한 봉투는 버린다) | `withheld`(`clock_unavailable`), `start_expired` |
| 13 | `sink.send`, 돌아온 뒤 시계를 읽어 `at`을 정한다 | `resent`, `not_sent` |

4의 시계 읽기부터 13의 포트 호출까지 `await`가 없다. 봉하는 시각은 취소·확정이면 4에서, 시작이면 10에서 읽은 값이다. 시계를 다시 읽을 때마다 그 박자에서 앞서 읽은 시각보다 이르면 읽지 못한 것이다.

## 같은 요청

- **초안은 항목의 값만으로 만든다.** 실행 줄을 따로 읽지 않는다. 시작은 `startDraft({ run: { runId, runGeneration, executorId, kind: "worker", ...rebuild }, requestId, stopGeneration, issuedAt })`, 취소는 `stopDraft`, 확정은 `finalizeDraft`이고 요청 ID·정지 세대는 항목의 값이다. 그래서 받는 쪽·요청 ID·본문·본문 digest·머리의 두 세대가 처음 봉투와 같다.
- **새로 만드는 것.** 모든 동작에서 nonce·서명은 새것이다. 머리의 시각은 봉투 모듈의 시각 규칙을 따른다(`envelopes.md`): 시작은 장부의 발행 시각을 그대로 실어 `issued_at`·`expires_at`이 처음과 같고, 취소·확정은 두 시각도 봉하는 때의 것으로 바뀐다. 실행기는 취소·확정의 재전송을 요청 ID와 본문 digest로 대조하므로 새 시각의 봉투도 같은 요청이다.
- **본문 칸은 읽은 값을 칸마다 한 번 옮겨 적는다.** 칸의 종류(문자열, 시각, 정수)가 틀리면 그 항목은 `malformed`(`rebuild`)이고, 값이 계약 밖이면 초안·봉하기(계약의 `sealEnvelope`)가 거절한다. 비어 있는 칸을 채우지 않는다.
- **싣기 직전의 다시 읽기는 본문 칸도 대조한다.** 다시 읽은 항목의 머리 칸이나 본문을 다시 만들 칸이 처음 읽은 것과 하나라도 다르면 `read_unknown`으로 내지 않는다. 장부의 지시 줄은 적은 뒤 바뀌지 않으므로 다르면 틀린 읽기이고, 그대로 봉하면 같은 요청 ID에 다른 본문 digest가 실린다.

## 시작

- **한도.** 시작은 발행 + `START_LAST_SEAL_MS`(봉투 모듈의 규칙: 시한 30000 − (`DELIVERY_MAX_MS` + `CLOCK_SKEW_MS`) = 19000ms) 뒤에 봉하지 않고 `start_expired`를 낸다. 봉투 모듈이 그보다 일찍 `too_late_to_send`를 내도 `start_expired`다. 그래서 두 규칙이 어긋나도 늦은 시작이 나가지 않는다. 새 시각으로 되살리지 않는다.
- **판단한 뒤에 흐른 시간.** 연결·서명 포트 안에서도 시각이 흐르므로, 시작은 연결 확인 뒤에 시계를 다시 읽어 그 시각으로 봉하고, 봉한 뒤 `sink.send`를 부르기 직전에 한 번 더 읽는다. 어느 쪽이든 한도를 넘었으면 원래 두 시각을 실은 `start_expired`이고 내보내기 포트를 부르지 않는다. 시계를 읽지 못하면 `withheld`(`clock_unavailable`)이고 역시 부르지 않는다.
- **이 박자가 지키는 범위.** "마지막으로 시계를 읽은 때에 봉할 수 있었다"까지다. 그 읽기와 실제로 싣는 순간 사이에도 시각은 흐르므로, 싣는 순간의 한도는 내보내기 포트가 지킨다(`ports.ts` `InstructionSink`의 조건).
- **D-90의 조건 (2)의 재료.** 이 박자는 발행 + 19000ms 뒤에 그 시작을 봉하지 않고, 그 시작의 봉투는 다시 봉해도 시한이 모두 발행 + 30000ms다. 그래서 장부의 발행 시각만으로 "더 보내지 않고 마지막 봉투의 시한이 지남"의 시각을 정할 수 있다. 단 배정·시작 박자와 다른 경로가 같은 시작을 더 봉하지 않는다는 것은 각 경로의 조건이다(배정·시작 박자는 `startRun` 직후 한 번만 봉한다). 자리를 푸는 판단(D-90)은 이 PR에 없다.
- **종료가 적힌 실행의 시작은 다시 내지 않는다**(`stop_recorded`). 장부는 "같은 실행에 시작과 종료가 함께 답이 없으면 어느 쪽을 보낼지는 부르는 쪽이 정한다"고 남겼다(`ledger.md` "시작은 시한 안에서만 다시 보낸다"). 실행기가 시작을 받은 적이 없다면 시작을 다시 보내면 열자마자 닫힐 작업자를 띄우고, 받았다면 시작의 재전송은 영수증을 다시 받는 것뿐이다. 종료는 따로 다시 낸다. 모르는 실행의 종료에 실행기는 답하지 않으므로, 실행기가 시작을 받은 적이 없으면 그 종료는 답 없이 간격마다 다시 나간다(아래 "남는 한계").
- **접수가 닫히면 시작을 다시 내지 않는다**(`intake_closed`). 시작은 새 일을 연다. 정지(세대가 오름)는 6의 대조가 막고, 복원 중·사본 보류 같은 다른 닫힘은 이 확인이 막는다. 종료·확정은 접수와 무관하게 다시 낸다(장부도 정지 중에 종료를 적는다).

## 정지 세대

항목의 `stopGeneration`(그 지시를 적을 때의 세대)이 다시 읽은 장부의 `stopGeneration`과 다르면 봉하지 않는다. 실행기가 새 세대를 적용한 뒤에는 옛 세대의 지시를 받지 않고, 적용하기 전이면 장부가 이미 넘어선 세대의 지시가 실행된다(`ledger.md` "항목의 정지 세대가 장부의 지금 세대와 다르면 보내지 않는다"). 세대를 맞춘 뒤 종료는 새 세대의 비상 종료로, 확정은 새 세대·새 요청 ID의 확정으로 다른 조각이 낸다.

## 두드리지 않기

- **간격의 기준은 `max(항목의 발행 시각, lastResends의 그 요청 ID)`다.** 장부는 송신을 적지 않으므로 마지막 송신 시각은 부르는 쪽의 메모리다. 발행 시각도 기준에 넣어, 다른 박자(배정·시작, 수명)가 방금 적고 실은 지시를 곧바로 다시 내지 않는다. 감독이 다시 뜨면 `lastResends`는 비고, 발행 뒤 간격이 지난 지시는 첫 박자에 바로 나간다.
- **부르는 쪽이 넘기는 것:** 결과의 `resent`와 `delivery: "unknown"`인 `not_sent`의 `{ requestId, at }`(`sealedAt`이 아니다). `at`은 내보내기 포트가 돌아온 뒤 읽은 시각이라 실은 시각보다 이르지 않다. 그래서 포트 안에서 시간이 걸려도(봉한 뒤 5000ms 뒤에 실림) 다음 박자는 실은 때부터 간격을 잰다. 그 시계를 읽지 못하면(던짐, 뒤로 감) 봉투의 시한을 쓴다. 포트는 시한 뒤에 싣지 않으므로 실은 시각의 상한이고, 그만큼 다음 재전송이 늦어질 뿐 앞당겨지지 않는다.
- **멈춤.** 실행기가 답하면 그 지시는 읽기에서 사라진다(`answered`, 또는 다음 박자에 항목이 없다). 앞 항목을 내보내는 동안 온 답은 1의 다시 읽기가 받아 낸다.
- **시작과 간격.** 간격이 19000ms보다 크면 시작은 한 번도 다시 나가지 않는다(간격을 발행 시각부터 세므로). 정책 검증은 양의 안전 정수만 본다.
- **취소를 다시 낸 직후의 조회.** 수명 판단은 `stopping` 실행의 응답 대기를 장부의 발행 시각(`instructionTimes`의 `lastStopAt`)부터 센다. 재전송은 장부에 새 시각을 적지 않으므로, 처음 발행부터 `answerTimeoutMs`가 지난 취소를 다시 내면 그 직후의 수명 박자는 응답 대기가 이미 끝난 것으로 보고 같은 실행을 조회할 수 있다. 조회는 상태만 묻고 실행을 바꾸지 않는다.
- **확정을 다시 낸 뒤에는 지금의 수명 판단이 그 실행을 조회하지 않는다.** 결과 쪽 상태는 수명 판단의 확정·대기 분기로만 가고, 수명 박자는 `resultSettled`를 거짓으로 넘긴다. 그래서 `answerTimeoutMs` 20000에서 확정을 적고 30000ms 뒤에 다시 낸 `ready_result`는 `wait`, 23000ms 뒤에 다시 낸 `failed_stopped`는 `finalize_withheld`이고 조회는 0건이다. 확정에 답이 없는 실행을 조회하는 일은 뒤 조각의 몫이다.

## 수명 박자와 겹치지 않는가 (같은 실행의 종료 지시)

- **이 박자는 종료 지시를 만들지 않는다.** 장부 포트가 읽기뿐이고, 다시 내는 지시는 읽기의 요청 ID 그대로다.
- **수명 박자는 종료가 적힌 실행에 새 종료를 적지 않는다.** 판단이 종료를 내도 그 실행의 `lastStopAt`이 있으면 조회로 가고(`cause: "stop_already_recorded"`), 쓰기 직전에 다시 읽어 새로 보이면 `superseded`다(`life-loop.md` "이미 적힌 종료"). 그래서 수명 박자의 경로만 보면 실행 하나에 종료 지시는 하나이고, 이 박자는 그 하나를 같은 요청 ID로 다시 낸다.
- **다른 경로는 둘째 종료를 적을 수 있다.** 본체의 이은 부탁 취소(`cancelToolRequest`)는 `stopping` 실행에도 호출 ID를 요청 ID로 한 `task_cancel`을 적는다(`ledger.md` "이은 부탁의 취소"). 그러면 읽기에 같은 실행의 종료가 둘 나오고, 이 박자는 각각을 자기 요청 ID·본문으로 다시 낸다. 실행기는 지금 세대의 새 요청 ID 취소에 새 접수 영수증을 내므로 둘 다 답을 받을 수 있다. 이 박자가 셋째 지시를 만드는 일은 없다.
- **겹쳐 부르기.** 이 박자와 수명 박자가 같은 장부에 겹쳐 돌아도 이 박자는 쓰지 않으므로 수명 박자의 다시 읽기를 흔들지 않는다. 수명 박자가 방금 적은 종료는 발행 시각 기준의 간격에 걸려 곧바로 다시 나가지 않는다.

## 박자가 멈출 때

- **한 항목의 실패는 그 항목의 결과다.** 다시 읽기·시계·접수·연결·초안·서명·난수·내보내기의 예외와 거절은 위 표의 이름으로 그 항목에 남고, 박자는 다음 항목을 본다.
- **그래도 항목 처리 밖으로 예외가 나오면** 남은 항목을 하지 않고 `halted: "threw"`, `haltedAt`은 그 항목의 요청 ID다. 그때까지의 결과는 그대로 싣는다(시험이 본다). 내보내기를 부른 뒤였으면 그 항목을 `not_sent`(`send_threw`, `delivery: "unknown"`, `at`은 그 봉투의 시한)로 싣는다. 포트의 메서드 호출은 모두 예외 처리 안에 있지만, 항목 안에서 포트 묶음의 속성(`ports.ledger`·`ports.intake`·`ports.links`)을 읽는 접근은 그 밖에 있다. 그 접근(getter)이 던지면 이 길로 온다. 장부에 쓰지 않으므로 멈춰도 잃는 기록은 없다.
- **박자 처음에 장부 포트를 얻지 못하면** 예외를 내지 않고 `not_run`/`read_unknown`이다(아무것도 읽거나 봉하지 않는다).
- **겹쳐 부르기:** 같은 장부 포트 객체로 박자가 진행 중이면 다음 호출은 읽기 없이 `not_run`/`tick_in_progress`다. 다른 포트 객체로 겹쳐 부르면 알아채지 못한다.

## 이 박자가 하지 않는 것

갱신의 재전송(읽기가 내지 않는다. 갱신에는 영수증이 없다), 세션 지시의 재전송(세션 계약 작업이 연다. 세션 실행기가 `session_stop`의 재전송을 같은 요청으로 처리하는지는 확인하지 않았다), 새 요청 ID의 지시, 장부 쓰기, 조회(`not_rebuildable`·`stop_generation_mismatch` 뒤의 조회는 수명 박자나 부르는 쪽의 일), 받은 적 없는 실행의 자리 풀기(D-90), 본체의 도구 처리기의 취소 포트 어댑터.

## 뒤 조각이 지킬 것

- **`lastResends`를 넘긴다.** `resent`와 `delivery: "unknown"`인 `not_sent`의 `at`을 요청 ID마다 쥐고 넘긴다(`sealedAt`을 넘기면 포트 안의 지연만큼 간격이 짧아진다). 넘기지 않으면 발행 시각부터 간격이 지난 지시를 박자마다 다시 낸다. 읽기에서 사라진 요청 ID는 버려도 된다.
- **박자 사이에도 시계가 뒤로 가지 않게 잇는다**(재기동 포함. `ports.ts`의 비후퇴 시계 전제). 시각을 믿을 수 없으면 시작의 재전송과 D-90의 시간 판정을 보류한다.
- **박자를 직렬화한다.** 앞 박자가 돌아온 뒤에 다음을 부른다(다른 포트 객체로도).
- **`links`를 실제 연결로 잇는다.** 그 실행기의 `Link`와 부르는 순간의 시각으로 계약 v1의 `mayIssue`를 부르고 동기로 답한다.
- **모른다고 옮긴 실행의 시작을 다시 낼지는 조립·설계가 정한다.** 끊김 판정(`markLostFor`) 뒤 다시 붙은 실행기에 대해 지금 이 박자는 연결과 시한이 맞으면 시작을 다시 낸다.
- **내보내기 포트는 싣는 순간에 정지 세대와 봉투 시한을 다시 본다.** 이 박자는 내보내기 포트를 부르기 직전까지 재지만 포트 안의 대기는 재지 못한다(`ports.ts` `InstructionSink`의 조건). 시작의 한도도 마찬가지로 싣는 순간에는 포트가 지킨다.
- **`not_rebuildable`은 같은 실행 ID를 조회한다.** 새 요청 ID로 다시 만들지 않는다.
- **`stop_generation_mismatch`는 세대 맞춤 뒤 다른 조각이 낸다.** 종료는 새 세대의 비상 종료, 확정은 새 세대·새 요청 ID의 확정(그때는 이번 발행 시각을 판단과 같은 시계로 적는다).
- **`start_expired`는 D-90의 재료로만 쓴다.** 자리를 풀려면 접수 영수증이 한 번도 없음(장부의 읽기만이 아니라 실행기의 과거 점유 응답도 본다)과 그 뒤 전체 점유에 없음이 함께 성립해야 한다(`ledger.md` "D-90"). 접수 보류(`intake_closed`) 중에 한도가 지난 시작도 D-90이 접수 보류·봉투 시한·전체 점유를 한데 확인해 닫는다.
- **확정에 답이 없는 실행의 조회를 맡는다.** 확정을 다시 낸 뒤 지금의 수명 판단은 그 실행을 조회하지 않는다(위 "두드리지 않기").
- **`halted`를 본다.** `threw`이면 이미 돌려받은 항목을 반영하고, 결과 목록에 없는 지시를 다음 박자가 다시 본다(장부는 그대로다). 조립은 포트 묶음의 속성 접근이 던지지 않게 만든다(평범한 객체).
- **간격을 정한다.** 시작을 한 번이라도 다시 내려면 `resendEveryMs <= 19000`이어야 한다. 운영 값은 정해지지 않았다.

## 남는 한계

- **포트 안의 지연.** 내보내기 포트를 부른 뒤 실제로 싣기까지의 시간은 이 박자가 재지 못한다. 시작은 마지막으로 시계를 읽은 때에 봉할 수 있었다는 것까지만 이 박자가 지키고, 싣는 순간의 한도는 내보내기 포트가, 실행기 쪽의 받는 시각은 봉투 모듈의 여유(11000ms)가 지킨다.
- **박자 사이의 시계 후퇴.** 시계의 하한은 한 박자 안에서만 유효하다. 앞 박자에서 `start_expired`였던 시작도 다음 박자의 시계가 뒤로 가면(발행 + 19001 → + 18000) 다시 나간다.
- **끊김 판정 뒤 다시 붙은 실행기.** 모른다고 옮긴 실행이라도 연결과 시한이 맞으면 시작을 다시 내므로, 처음 봉투를 받지 못했던 실행기에서 그 시작이 열릴 수 있다.
- **접수 보류 중 시한이 지난 시작.** 다시 나가지 않지만(`intake_closed` 뒤 `start_expired`) 그 실행은 D-90이 닫기 전까지 작업 슬롯을 쥔다.
- **다시 읽기가 막는 범위.** 앞 항목을 기다리는 동안 끼어든 쓰기(영수증, 정지, 새 종료)는 막는다. 다시 읽기와 내보내기 사이의 동기 포트(시계·접수·연결·서명) 안에서 일어난 쓰기는 보지 못한다.
- **받은 적 없는 실행의 종료.** 실행기가 시작을 받지 못한 채 종료만 적힌 실행은, 실행기가 모르는 실행의 종료에 답하지 않으므로 그 종료가 간격마다 다시 나간다. D-90이 그 실행을 닫기 전까지다.
- **`delivery: "unknown"`.** 실렸을 수 있다. 같은 요청 ID로만 다시 내므로 실행기에서 겹치지 않는다.
