# 운영 중 인사의 장부 반영 (`hello-answers.ts`)

복원이 끝난 뒤 운영 중에 받은 검증된 인사(`hello`)의 전체 점유를 장부의 `applyExecutorAnswer`(`coverage: "full"`)로 넘기는 한 번의 처리다. 연결 판단(`src/supervisor/transport/connections.ts`)이 낸 `occupancy` 출력 하나를 받아, 그 출력이 지금 인정된 연결의 인사인지 다시 보고, 장부를 부르고, 장부의 답을 구별해 돌려준다. 순수 판단이다: 소켓·타이머·시계·난수를 직접 쓰지 않는다. 장부와 접수는 포트로, 연결 표와 지금 시각은 인자로 받는다. 입력 객체를 바꾸지 않고 예외를 던지지 않는다. 판단과 장부 호출은 한 동기 구간이다(사이에 `await`가 없다).

## 보장 넷

이 모듈이 주장하는 것은 아래 넷뿐이다.

1. **전체 답은 검증된 인사에서만, 서명 시각과 함께.** 연결 판단은 인사를 받으면 `occupancy` 출력의 `issuedAt`에 그 인사 봉투 머리의 `issued_at`(실행기가 실행 목록과 같은 동기 구간에서 자기 시계로 서명한 시각)을 싣는다. 받은 시각(`Greeting.at`)과 다른 값이다. 이 모듈은 그 출력만 받아 `coverage: "full"`, `sender`는 그 인사의 낸 쪽(실행기 주체 이름), `runs`는 인사의 실행 목록 그대로, `answeredAt`은 그 서명 시각으로 장부를 부른다. 상태 보고의 `partial` 행은 `refused`·`partial`이다: `full`로 올리는 길이 없다(다시 넘기는 입구도 이 모듈이 실패 결과로 낸 값만 받는다). 서명 시각이 없거나 꼴이 틀리면(1 이상의 안전 정수가 아니면. 0도 계약의 머리 시각이 아니다) `refused`·`signed_time_missing`이고 장부를 부르지 않는다(아래 "정한 것"). 장부 시계 `now`도 1 이상이어야 하고, 아니면 두 입구 모두 장부를 부르기 전에 `refused`·`malformed_now`다.
2. **지금의 인정된 인사만.** 넘기는 순간의 연결 표로 그 출력이 그 실행기의 지금 인정된 연결의 인사인지 다시 본다. 연결이 없거나(`no_connection`) 인사한 연결이 아니거나(닫힘·밀려남 포함, `not_greeted`), 연결 판단의 배정 후보와 같은 판정(`candidates(복원기)`)에 들지 않거나(`other_restore`), 그 연결의 주체가 출력의 실행기 이름과 다르거나(`other_principal`), 서명 시각·실행 목록이 그 연결의 인사와 다르거나(`other_greeting`), 그 연결이 맞춘 정지 세대가 지금 세대와 다르면(`stop_generation_changed`) `not_current`이고 `applyExecutorAnswer`를 부르지 않는다. 그 인사의 "안다"는 항목은 인정이 끝난 연결일 때만 관측으로 적는다(아래 "정한 것"). 접수가 열려 있지 않으면 `held`다(아래 "정한 것"). 실행을 맡을 수 없는 이름은 장부의 거절(`LedgerInputError`)을 `ledger_failed`·`input_rejected`로 구별해 돌려준다.
3. **장부의 답을 구별해 돌려주고, 실패한 답은 같은 값으로 다시 넘길 수 있다.** 반영(`applied`)이면 장부의 `moved`·`deferred`·`outsideLedger`를 그대로(항목마다 필드별 사본으로) 싣는다. 장부가 아무것도 적지 못했으면(`ok: false`) `ledger_unsaved`에 장부의 `reason`·`unsavedSightings`를 그대로 싣는다. 장부가 던졌거나 답의 꼴이 틀리면 `ledger_failed`다. 꼴은 항목까지 본다: `moved`·`deferred`·`outsideLedger`·`unsavedSightings`의 항목 하나라도 장부가 약속한 꼴(`LostRun`, `DeferredLoss`, `{ runId, runGeneration }`: 칸 수, 비지 않은 `runId`, 1 이상의 세대, 장부의 실행 상태와 `why` 값)이 아니거나 답을 읽다가 던지면 반영으로 세지 않고 `malformed_answer`다. 포트가 던진 일반 예외(`threw`)의 문구는 결과에 싣지 않는다(`message: null`). 문구는 장부의 입력 거절(`input_rejected`)만 싣는다. 실패에는 다시 넘길 값(`retry`: 실행기 이름, 연결 번호, 동결한 실행 목록, 서명 시각)과 새 일을 맡기지 않을 실행기(`withhold`)가 함께 나온다. `retryHelloAnswer(retry, now, { ledger })`가 같은 값으로 다시 넘긴다.
4. **자리를 풀지 않고, 기존 동작은 그대로다.** 장부 포트는 `applyExecutorAnswer`와 관측만 적는 `recordAnswerSightings`뿐이라 자리를 풀거나 실행을 닫는 길이 없다. 인사에 없는 실행은 그대로이고(D-90의 닫기는 뒤 조각), `unknown_running`은 어떤 답에도 그대로다(장부의 규칙). 복원의 판정과 답, 연결 판단의 기존 출력은 바뀌지 않는다: 연결 판단에는 칸 둘(`Greeting.issued_at`, full 출력의 `issuedAt`)을 더하기만 했고 `occupancy(source)`의 행은 복원 포트의 꼴 그대로다.

## 공개 면

| 이름 | 꼴 |
|---|---|
| `passHelloAnswer(input, ports)` | `HelloAnswerInput` → `HelloAnswerOutcome` |
| `retryHelloAnswer(retry, now, { ledger })` | 이 모듈이 실패 결과로 낸 `HelloRetry`만 받는다. 아니면 `refused`·`not_retry`. 연결과 접수를 다시 보지 않는다 |
| `HelloAnswerInput` | `output`(연결 판단의 `occupancy` 출력 그대로), `table`(넘기는 순간의 연결 표, `Pick<Connections, "get" \| "candidates">`), `now`(장부 시계) |
| `HelloAnswerPorts` | `ledger: Pick<Ledger, "applyExecutorAnswer" \| "recordAnswerSightings">`, `intake: Pick<Restorer, "intakeOpen" \| "stopGeneration">`(연결 판단의 맞춤에 답한 그 복원기 객체), `links: AnswerLinks`(`receipts.ts`. 지금 인정된 연결인가. 관측을 적기 직전에만 묻는다) |
| `HelloRetry` | `executorId`, `connection`, `runs`(동결), `answeredAt`(서명 시각) |
| `REFUSED_WHY`, `NOT_CURRENT_WHY` | 구별된 거절의 이름 |

`HelloAnswerOutcome`:

| `kind` | 뜻 | 장부 호출 | `withhold` | `retry` |
|---|---|---|---|---|
| `applied` | 장부가 반영했다. `answeredAt`(서명 시각), `moved`·`deferred`·`outsideLedger`(장부의 답 그대로) | 했다 | 없음 | 없음 |
| `ledger_unsaved` | 장부가 아무것도 적지 못했다. `reason`·`unsavedSightings` 그대로 | 했다 | 실행기 | 있음 |
| `ledger_failed` | `threw`(장부가 던짐, `message: null`), `malformed_answer`(답이나 그 항목의 꼴이 틀림, 답을 읽다가 던짐, `message: null`), `input_rejected`(장부의 `LedgerInputError`: 같은 값은 다시 넘겨도 같다. `message`는 장부의 문구) | 했다 | 실행기 | `input_rejected`만 `null` |
| `held` | 접수가 열려 있지 않다(복원 중, 정지 중 등) | 안 했다 | 실행기 | 없음(같은 `output`을 다시 넘긴다) |
| `not_current` | 위 보장 2의 여섯 까닭(`why`). `sighting`: 관측만 적기의 결과(`receipts.ts`의 `SightingOutcome`) | `applyExecutorAnswer`는 안 했다. `recordAnswerSightings`는 아래 조건일 때만 | 없음 | 없음 |
| `refused` | `not_occupancy`, `partial`, `malformed_output`, `signed_time_missing`, `malformed_now`, `not_retry` | 안 했다 | 없음 | 없음 |

`withhold`는 연결 번호가 아니라 실행기 주체 이름(`executor/<역할>/<인스턴스>/<저장소>`)이다. 배정 쪽은 후보 연결의 주체 이름(`Connections.get(candidate.connection).sync.principal`)과 대조해 새 부탁의 후보에서 빼고, 이미 그 주체에 배정된 대기 실행도 `startRun` 직전에 막는다(아래 "뒤 조각이 지켜야 할 것"). 후보 필터 하나로는 대기 실행의 시작이 막히지 않는다.

## 정한 것

- **서명 시각이 없으면 `null`로 넘기지 않고 부르지 않는다.** 장부는 `answeredAt: null`을 받지만, 그러면 `full` + 시각 모름의 답이 장부에 들어가고 뒤 조각(D-90)이 그것을 자리 해제의 근거로 쓸 틈이 생긴다. 연결 판단의 full 출력에는 늘 서명 시각이 있으므로 시각이 없는 full 출력은 그 판단이 낸 것이 아니다(모르면 닫는다). 그래서 이 모듈을 지나는 `full` 답은 모두 서명 시각을 싣는다.
- **복원 중에는 넘기지 않는다(`held`).** 접수(`intakeOpen()`)가 열리기 전의 인사는 복원 2단계가 `occupancy(source)`로 읽는 몫이다. 여기서 장부를 부르면 복원의 판정(2단계의 대조, 3단계의 `markLost`) 전에 상태를 옮긴다. 처음 넘기기(`passHelloAnswer`)에서 막는 자리는 `intakeOpen()` 하나다(다시 넘기기는 접수를 보지 않는다. 아래): 5단계를 마친 복원기의 허가가 살아 있고 장부가 건강하고 정지가 아닐 때만 열린다. 같은 출력을 접수가 열린 뒤 다시 넘기면 연결을 다시 보고 넘긴다.
- **연결 대조는 연결 판단의 판정을 다시 쓴다.** "지금 인정된 인사"는 연결 판단이 배정 후보로 내는 것과 같은 판정(`candidates(복원기)`: 지금의 복원기로 답한 맞춤 뒤 인사했고, 그 복원기가 세대를 알며, 아직 열린 연결)에 더해, 그 연결이 맞춘 정지 세대가 지금 세대와 같을 것이다. 연결 판단은 인사 뒤 새 정지로 오른 세대를 막지 않는다(그 연결로 비상 종료를 보내야 한다). 장부에 넘기는 것은 맞춘 세대 그대로일 때만이다.
- **출력의 실행 목록도 그 연결의 인사와 대조한다.** 연결 번호만 맞추면 다른 연결의 출력을 섞은 값이 지나간다. 실행 목록은 항목마다 네 칸이 같아야 한다.
- **두 번 세지 않는다.** 입력은 인사 하나가 내는 `occupancy`(full) 출력 하나뿐이다. 같은 인사가 나타나는 다른 자리(`candidate` 출력, `occupancy(source)`·`candidates(source)` 조회)는 받지 않는다(`candidate`는 `not_occupancy`). 상태 보고는 `occupancy`(partial)와 `forward` 두 출력으로 나오는데, partial은 여기서 거절하므로 상태 보고가 장부에 닿는 길은 `forward`(영수증 처리기) 하나다.
- **세션 실행기의 인사는 이 처리에 닿지 않는다.** 연결 판단은 작업자 실행기의 맞춤만 받는다(`connections.ts`의 `syncRequest`). 세션 실행기 이름을 단 출력은 연결 대조에서 `not_current`다. 장부는 세션 실행기 이름을 받는 쪽이라(`runExecutor`) 장부의 거절은 실행을 맡을 수 없는 이름(`supervisor` 등)에서만 나온다.
- **다시 넘기기는 연결과 접수를 다시 보지 않는다.** 처음 넘길 때 지금의 인사였고, 같은 값을 다시 적어야 그 인사의 양성 관측이 남는다(`src/ledger/ledger.md` "실행기의 답을 넘기는 쪽"). 장부의 이 연산은 `continue` 쓰기라 장부가 "못 씀"이어도 시도한다. 입구는 이 모듈이 실패 결과로 낸 값만 받는다(메모리의 `WeakSet`): 지어낸 값으로 `full`을 넘기는 길을 막는다. 접수를 보지 않으므로 다시 넘기기는 복원 중(새 복원기의 2단계 전)에도 장부에 닿는다: 그 순서를 이 모듈이 세우지 않는다(아래 "뒤 조각이 지켜야 할 것").
- **인정이 끝난 연결의 인사는 관측만 적는다.** `not_current`의 까닭이 `no_connection`·`not_greeted`·`other_restore`·`stop_generation_changed`이면 그 출력은 연결 판단이 인정했던 인사다. 그 "안다"는 항목을 `full`·서명 시각 그대로 `recordSighting`(`receipts.ts`, 규칙은 `receipts.md` "인정이 끝난 연결의 답: 관측만 적기")으로 넘긴다: 부르기 직전에 `links`로 그 연결을 다시 보고, 인정이 끝났다고 확인될 때만 부른다. 정지 세대만 오른 연결처럼 지금도 인정된 연결이면(`link_current`) 또는 모르면(`link_unknown`) 적지 않는다. `other_principal`·`other_greeting`은 출력이 그 연결의 인사와 다르다는 뜻이라 낸 쪽·목록을 인정된 값으로 믿을 수 없어 적지 않는다(`output_mismatch`). 결과는 `not_current`의 `sighting`에 싣고, 그 인사를 버렸는지(오염)는 부르는 쪽이 `saved`인지로 가른다.
- **시각은 1 이상만 받는다.** 계약의 머리 시각과 장부의 시각은 1 이상의 안전 정수다. 서명 시각 0은 서명 시각 없음(`signed_time_missing`), `now` 0은 `malformed_now`로 장부를 부르기 전에 거절한다. 장부에 0을 넘기면 입력 거절(`input_rejected`)이 되어 정상 인사가 다시 넘길 값 없는 실패와 맡기지 않을 실행기로 보인다.

## 이 모듈에 없는 것

순환(언제 부르고 결과를 어디로 보내는가), 실행기별 답의 줄과 그 보관, 배정 후보에서 실행기를 빼는 일과 그 실행기에 이미 배정된 대기 실행의 시작을 막는 일, `outsideLedger`의 닫는 지시, `deferred`의 같은 ID 조회, 상태 보고의 장부 반영(영수증 처리기의 몫), D-90의 닫기와 자리 해제.

## 뒤 조각이 지켜야 할 것

- **실행기별로 받은 순서를 지킨다.** 조립은 실행기마다 답(이 처리의 인사 출력, 인사와 조회에 대조된 상태 보고)을 받은 순서의 줄에 둔다. 앞 답이 `held`이거나 실패(`ledger_unsaved`, `retry`가 있는 `ledger_failed`)로 붙들린 동안 그 실행기의 뒤 답을 장부에 넘기지 않는다. 실패한 답은 **원본 `retry` 객체**를 `retryHelloAnswer`로 더 새 답보다 먼저 다시 넘긴다(같은 내용의 복제본은 `not_retry`로 거절된다). `held`는 접수가 열리면 **넘기는 순간의 가장 새 연결 표와, 연결 판단의 맞춤에 쓴 그 복원기**로 같은 출력을 `passHelloAnswer`에 다시 넘긴다(그때 `not_current`면 버린다). 이미 지나간 상태 전이를 나중 답 위에 재생하지 않으려면 이 순서가 필요하다. 다만 철회된(버려진) 답의 상태 전이를 막는 것과 그 답의 양성 이력을 보존하는 것은 다른 일이다: 버리면 그 답이 안다고 한 실행의 관측도 사라진다(아래 "남는 한계").
- **복원과의 순서는 처음 넘기기에서만 저절로 선다.** 복원기가 적지 못하고 붙든 양성 관측은 2단계를 다시 불러야 적히고, 2단계가 통과해야 5단계가 접수를 연다. `passHelloAnswer`(처음 넘기기)는 접수가 열리기 전에는 장부를 부르지 않으므로(`held`) 이 경우에만 그 순서가 저절로 선다. `retryHelloAnswer`(다시 넘기기)는 접수와 연결을 다시 보지 않으므로 복원 중(새 복원기의 2단계 전)에도 장부에 닿는다: 옛 연결의 빈 full을 다시 넘긴 것이 아직 2단계가 읽지 않은 새 연결의 양성 인사보다 먼저 장부에 들어갈 수 있다. 다시 넘기기와 복원 작업의 순서는 조립이 정한다. 조립이 이 처리를 우회해 `applyExecutorAnswer`를 직접 부르지 않는다.
- **`withhold`의 실행기는 새 부탁의 후보에서 빼고, 이미 그 주체에 배정된 대기 실행도 `startRun` 직전에 막는다. 두 조건을 갖추기 전에는 후보 필터만으로 새 시작을 막았다고 보지 않는다.** 배정 박자는 후보 포트(`CandidateSource`)를 새 부탁을 배정할 때만 쓰고, 이미 배정된 대기 실행은 장부 목록에서 따로 골라 `startRun`을 부른다. 후보를 감싸 빼기만 하면 그 실행기 앞의 `queued` 실행이 `preparing`이 되고 서명한 `task_start`가 그 실행기로 나간다. 인수 기준: 그 실행기의 `queued` 실행이 있고 `withhold`로 뺀 상태에서 배정 박자를 한 번 돌리면 후보 0개, `startRun` 0회, 송신 0회, 원래 실행은 `queued` 그대로다. `withhold`는 연결 번호가 아니라 실행기 주체 이름이고, 성공 결과(`applied`)에는 `withhold` 칸이 없다. 빼는 기간은 그 실행기의 붙든 답이 모두 `applied`가 되거나 버려지고(`not_current`) 그 뒤 그 실행기의 **현재 연결 인사**가 `applied`가 될 때까지다. 제외의 해제는 조립이 맡으며, 옛 연결의 `retry` 하나가 성공해도 해제하지 않고 남은 답과 현재 연결의 인사를 확인한다. 마지막 `held`가 현재 연결의 인사로 다시 넘겨져 `applied`가 된 경우를 해제 조건에 셀 수 있는지는 조립이 명시한다. 같은 연결에서는 두 번째 `hello`가 허용되지 않는다(`connections.ts`). 장부가 그 실행기의 점유를 반영하지 못한 동안 시작을 맡기면, 장부가 모르는 점유 위에 시작이 적힌다. `input_rejected`(다시 넘길 값 없음)면 그 실행기를 계속 뺀다.
- **각 full 출력은 한 번만 넘긴다.** 새 full은 `Connections.step`이 낸 그 `occupancy` 출력만 한 번 넘긴다. 상태 보고는 대조된 `forward` 쪽에서 `partial`로 처리한다. `candidate`·`occupancy(source)` 조회나 직접 장부 호출로 우회하지 않는다. 다시 넘기는 것은 `held`와 실패뿐이고, **성공한 출력을 되풀이하지 않는다**: 같은 출력을 두 번 넘기면 `outsideLedger`에 같은 장부 밖 실행이 다시 나오므로 닫는 지시도 실행·세대로 중복을 막는다.
- **연결 표는 넘기는 순간의 가장 새 값을, 복원기는 연결 판단의 맞춤에 쓴 그 객체를, `now`는 장부 시계를 넘긴다.** 옛 표 값을 넘기면 옛 판단이 된다. 다른 복원기 객체면 모든 인사가 `other_restore`다.
- **D-90의 닫기는 이 처리의 `applied` 결과의 서명 시각(`answeredAt`)과 `full`만 근거로 쓰고, 그것만으로는 충분하지 않다.** `held`·실패·`not_current`·`refused`, 상태 보고(`partial`), `occupancy(source)`의 행(서명 시각이 없다), 받은 시각은 근거가 아니다. 장부는 `full` 답 자체(어떤 실행이 없었는지)를 적지 않으므로(양성 관측은 `not_known` 밖만 적는다) 닫는 근거는 그 조각이 따로 남긴다(`src/ledger/ledger.md` "D-90의 닫기(뒤 조각)가 지킬 것"). 그 조각은 다음을 지킨다.
  - **철회된 인사의 양성은 관측만 적기(`sighting`이 `saved`)로 보존된다. 보존하지 못했으면(그 밖의 `sighting`) 이 모듈의 `applied` 하나를 "그 실행기가 그 실행을 모른다"의 증거로 쓰지 않는다.** 교체되었거나 대기 중인 연결의 "안다"는 답을 잃으면 뒤의 빈 full `applied`와 관측 0행이 함께 보인다(아래 "남는 한계"). 보존하지 못한 구간이 있거나 더 새 양성 답이 대기 중인 실행은 자동 해제에서 뺀다. 옛 연결 `retry`의 관측 저장 성공을 현재 연결의 부재 증명으로 쓰지 않는다.
  - **`applied`의 시각을 원래 full 목록·연결·주체·세대에 묶는다.** `applied`에는 전체 목록이 없으므로 입력 출력이나 `retry`를 함께 보존한다.
  - **복원이 붙든 관측을 먼저 저장하고**, 같은 트랜잭션에서 시작 재송신 중단, 실행기 서명 시각 ≥ 시작 발행 + 30,000ms, 그 실행의 목록 부재, 영수증·상태 보고·양성 관측 0과 이력 공백 없음을 확인한다. 접수 증거가 있으나 종료를 확인할 수 없는 실행은 D-91의 관리자 확인 대상으로 남긴다.

## 남는 한계

- **붙든 답은 메모리에만 있다.** 다시 넘길 값(`retry`)과 `held` 출력은 프로세스가 다시 뜨면 사라진다. 그 답의 양성 관측은 장부 어디에도 흔적이 없다(`src/ledger/ledger.md` "0행의 뜻(함정)").
- **`held` 뒤 연결이 바뀐 인사의 관측은 관측만 적기가 실패하면 잃는다.** 복원 2단계가 이미 읽은 인사라면 복원이 적었다. 2단계 뒤 5단계 전에 받은 인사는 다시 넘기기 전에 연결이 바뀌면 `not_current`이고 관측만 적는다. 그 쓰기가 실패하면 다시 넘길 값이 없어(`full`을 다시 넘기는 입구는 `retry`뿐이다) 그 관측은 장부에 없고, 부르는 쪽은 그 실행기를 오염으로 남긴다.
- **`held`를 다시 넘기면 복원 2단계가 읽은 인사가 한 번 더 반영될 수 있다.** 장부의 첫 관측은 덮이지 않고, 3단계가 옮긴 실행은 `unknown_running`이라 다시 옮겨지지 않는다. 다만 `outsideLedger`가 2단계의 종료 대상과 겹칠 수 있다(닫는 지시가 두 번).
- **연결 대조는 부르는 쪽이 넘긴 표 값을 믿는다.** 표는 평범한 값이라 그 출처를 스스로 증명하지 못한다.
- **교체되었거나 대기 중인 연결의 "안다"는 답의 관측 쓰기가 실패하면, 뒤의 빈 full과 관측 0행이 함께 보인다.** 한 실행기에서 연결 1이 실행 R을 안다고 인사하고 연결 2가 빈 full을 인사한 뒤, 받은 순서대로 넘기면 연결 1의 출력은 이미 밀려나 `not_current`이고 관측만 적힌 뒤 연결 2는 `applied`다. 관측 쓰기가 실패하면 그 실행의 양성 관측은 0행, 미응답 시작, 시작 임대 끝을 지난 빈 full이 동시에 남는다(부르는 쪽이 오염으로 막는다). 반대로 실패했던 옛 빈 full의 `retry`가 아직 2단계가 읽지 않은 새 연결의 양성 인사보다 먼저 장부에 들어갈 수도 있다. 뒤 조각의 조건은 위 "D-90의 닫기"에 있다.
