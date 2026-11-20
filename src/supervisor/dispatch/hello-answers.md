# 운영 중 인사의 장부 반영 (`hello-answers.ts`)

복원이 끝난 뒤 운영 중에 받은 검증된 인사(`hello`)의 전체 점유를 장부의 `applyExecutorAnswer`(`coverage: "full"`)로 넘기는 한 번의 처리다. 연결 판단(`src/supervisor/transport/connections.ts`)이 낸 `occupancy` 출력 하나를 받아, 그 출력이 지금 인정된 연결의 인사인지 다시 보고, 장부를 부르고, 장부의 답을 구별해 돌려준다. 순수 판단이다: 소켓·타이머·시계·난수를 직접 쓰지 않는다. 장부와 접수는 포트로, 연결 표와 지금 시각은 인자로 받는다. 입력 객체를 바꾸지 않고 예외를 던지지 않는다. 판단과 장부 호출은 한 동기 구간이다(사이에 `await`가 없다).

## 보장 넷

이 모듈이 주장하는 것은 아래 넷뿐이다.

1. **전체 답은 검증된 인사에서만, 서명 시각과 함께.** 연결 판단은 인사를 받으면 `occupancy` 출력의 `issuedAt`에 그 인사 봉투 머리의 `issued_at`(실행기가 실행 목록과 같은 동기 구간에서 자기 시계로 서명한 시각)을 싣는다. 받은 시각(`Greeting.at`)과 다른 값이다. 이 모듈은 그 출력만 받아 `coverage: "full"`, `sender`는 그 인사의 낸 쪽(실행기 주체 이름), `runs`는 인사의 실행 목록 그대로, `answeredAt`은 그 서명 시각으로 장부를 부른다. 상태 보고의 `partial` 행은 `refused`·`partial`이다: `full`로 올리는 길이 없다(다시 넘기는 입구도 이 모듈이 실패 결과로 낸 값만 받는다). 서명 시각이 없거나 꼴이 틀리면 `refused`·`signed_time_missing`이고 장부를 부르지 않는다(아래 "정한 것").
2. **지금의 인정된 인사만.** 넘기는 순간의 연결 표로 그 출력이 그 실행기의 지금 인정된 연결의 인사인지 다시 본다. 연결이 없거나(`no_connection`) 인사한 연결이 아니거나(닫힘·밀려남 포함, `not_greeted`), 연결 판단의 배정 후보와 같은 판정(`candidates(복원기)`)에 들지 않거나(`other_restore`), 그 연결의 주체가 출력의 실행기 이름과 다르거나(`other_principal`), 서명 시각·실행 목록이 그 연결의 인사와 다르거나(`other_greeting`), 그 연결이 맞춘 정지 세대가 지금 세대와 다르면(`stop_generation_changed`) `not_current`이고 장부를 부르지 않는다. 접수가 열려 있지 않으면 `held`다(아래 "정한 것"). 실행을 맡을 수 없는 이름은 장부의 거절(`LedgerInputError`)을 `ledger_failed`·`input_rejected`로 구별해 돌려준다.
3. **장부의 답을 구별해 돌려주고, 실패한 답은 같은 값으로 다시 넘길 수 있다.** 반영(`applied`)이면 장부의 `moved`·`deferred`·`outsideLedger`를 그대로 싣는다. 장부가 아무것도 적지 못했으면(`ok: false`) `ledger_unsaved`에 장부의 `reason`·`unsavedSightings`를 그대로 싣는다. 장부가 던졌거나 답의 꼴이 틀리면 `ledger_failed`다. 실패에는 다시 넘길 값(`retry`: 실행기 이름, 연결 번호, 동결한 실행 목록, 서명 시각)과 새 일을 맡기지 않을 실행기(`withhold`)가 함께 나온다. `retryHelloAnswer(retry, now, { ledger })`가 같은 값으로 다시 넘긴다.
4. **자리를 풀지 않고, 기존 동작은 그대로다.** 장부 포트는 `applyExecutorAnswer` 하나뿐이라 자리를 풀거나 실행을 닫는 길이 없다. 인사에 없는 실행은 그대로이고(D-90의 닫기는 뒤 조각), `unknown_running`은 어떤 답에도 그대로다(장부의 규칙). 복원의 판정과 답, 연결 판단의 기존 출력은 바뀌지 않는다: 연결 판단에는 칸 둘(`Greeting.issued_at`, full 출력의 `issuedAt`)을 더하기만 했고 `occupancy(source)`의 행은 복원 포트의 꼴 그대로다.

## 공개 면

| 이름 | 꼴 |
|---|---|
| `passHelloAnswer(input, ports)` | `HelloAnswerInput` → `HelloAnswerOutcome` |
| `retryHelloAnswer(retry, now, { ledger })` | 이 모듈이 실패 결과로 낸 `HelloRetry`만 받는다. 아니면 `refused`·`not_retry`. 연결과 접수를 다시 보지 않는다 |
| `HelloAnswerInput` | `output`(연결 판단의 `occupancy` 출력 그대로), `table`(넘기는 순간의 연결 표, `Pick<Connections, "get" \| "candidates">`), `now`(장부 시계) |
| `HelloAnswerPorts` | `ledger: Pick<Ledger, "applyExecutorAnswer">`, `intake: Pick<Restorer, "intakeOpen" \| "stopGeneration">`(연결 판단의 맞춤에 답한 그 복원기 객체) |
| `HelloRetry` | `executorId`, `connection`, `runs`(동결), `answeredAt`(서명 시각) |
| `REFUSED_WHY`, `NOT_CURRENT_WHY` | 구별된 거절의 이름 |

`HelloAnswerOutcome`:

| `kind` | 뜻 | 장부 호출 | `withhold` | `retry` |
|---|---|---|---|---|
| `applied` | 장부가 반영했다. `answeredAt`(서명 시각), `moved`·`deferred`·`outsideLedger`(장부의 답 그대로) | 했다 | 없음 | 없음 |
| `ledger_unsaved` | 장부가 아무것도 적지 못했다. `reason`·`unsavedSightings` 그대로 | 했다 | 실행기 | 있음 |
| `ledger_failed` | `threw`(장부가 던짐), `malformed_answer`(답의 꼴이 틀림), `input_rejected`(장부의 `LedgerInputError`: 같은 값은 다시 넘겨도 같다) | 했다 | 실행기 | `input_rejected`만 `null` |
| `held` | 접수가 열려 있지 않다(복원 중, 정지 중 등) | 안 했다 | 실행기 | 없음(같은 `output`을 다시 넘긴다) |
| `not_current` | 위 보장 2의 여섯 까닭(`why`) | 안 했다 | 없음 | 없음 |
| `refused` | `not_occupancy`, `partial`, `malformed_output`, `signed_time_missing`, `malformed_now`, `not_retry` | 안 했다 | 없음 | 없음 |

`withhold`는 실행기 주체 이름(`executor/<역할>/<인스턴스>/<저장소>`)이다. 배정 쪽은 후보 연결의 주체 이름(`Connections.get(candidate.connection).sync.principal`)과 대조해 뺀다.

## 정한 것

- **서명 시각이 없으면 `null`로 넘기지 않고 부르지 않는다.** 장부는 `answeredAt: null`을 받지만, 그러면 `full` + 시각 모름의 답이 장부에 들어가고 뒤 조각(D-90)이 그것을 자리 해제의 근거로 쓸 틈이 생긴다. 연결 판단의 full 출력에는 늘 서명 시각이 있으므로 시각이 없는 full 출력은 그 판단이 낸 것이 아니다(모르면 닫는다). 그래서 이 모듈을 지나는 `full` 답은 모두 서명 시각을 싣는다.
- **복원 중에는 넘기지 않는다(`held`).** 접수(`intakeOpen()`)가 열리기 전의 인사는 복원 2단계가 `occupancy(source)`로 읽는 몫이다. 여기서 장부를 부르면 복원의 판정(2단계의 대조, 3단계의 `markLost`) 전에 상태를 옮긴다. 막는 자리는 `intakeOpen()` 하나다: 5단계를 마친 복원기의 허가가 살아 있고 장부가 건강하고 정지가 아닐 때만 열린다. 같은 출력을 접수가 열린 뒤 다시 넘기면 연결을 다시 보고 넘긴다.
- **연결 대조는 연결 판단의 판정을 다시 쓴다.** "지금 인정된 인사"는 연결 판단이 배정 후보로 내는 것과 같은 판정(`candidates(복원기)`: 지금의 복원기로 답한 맞춤 뒤 인사했고, 그 복원기가 세대를 알며, 아직 열린 연결)에 더해, 그 연결이 맞춘 정지 세대가 지금 세대와 같을 것이다. 연결 판단은 인사 뒤 새 정지로 오른 세대를 막지 않는다(그 연결로 비상 종료를 보내야 한다). 장부에 넘기는 것은 맞춘 세대 그대로일 때만이다.
- **출력의 실행 목록도 그 연결의 인사와 대조한다.** 연결 번호만 맞추면 다른 연결의 출력을 섞은 값이 지나간다. 실행 목록은 항목마다 네 칸이 같아야 한다.
- **두 번 세지 않는다.** 입력은 인사 하나가 내는 `occupancy`(full) 출력 하나뿐이다. 같은 인사가 나타나는 다른 자리(`candidate` 출력, `occupancy(source)`·`candidates(source)` 조회)는 받지 않는다(`candidate`는 `not_occupancy`). 상태 보고는 `occupancy`(partial)와 `forward` 두 출력으로 나오는데, partial은 여기서 거절하므로 상태 보고가 장부에 닿는 길은 `forward`(영수증 처리기) 하나다.
- **세션 실행기의 인사는 이 처리에 닿지 않는다.** 연결 판단은 작업자 실행기의 맞춤만 받는다(`connections.ts`의 `syncRequest`). 세션 실행기 이름을 단 출력은 연결 대조에서 `not_current`다. 장부는 세션 실행기 이름을 받는 쪽이라(`runExecutor`) 장부의 거절은 실행을 맡을 수 없는 이름(`supervisor` 등)에서만 나온다.
- **다시 넘기기는 연결과 접수를 다시 보지 않는다.** 처음 넘길 때 지금의 인사였고, 같은 값을 다시 적어야 그 인사의 양성 관측이 남는다(`src/ledger/ledger.md` "실행기의 답을 넘기는 쪽"). 장부의 이 연산은 `continue` 쓰기라 장부가 "못 씀"이어도 시도한다. 입구는 이 모듈이 실패 결과로 낸 값만 받는다(메모리의 `WeakSet`): 지어낸 값으로 `full`을 넘기는 길을 막는다.

## 이 모듈에 없는 것

순환(언제 부르고 결과를 어디로 보내는가), 실행기별 답의 줄과 그 보관, 배정 후보에서 실행기를 빼는 일, `outsideLedger`의 닫는 지시, `deferred`의 같은 ID 조회, 상태 보고의 장부 반영(영수증 처리기의 몫), D-90의 닫기와 자리 해제.

## 뒤 조각이 지켜야 할 것

- **실행기별로 받은 순서를 지킨다.** 조립은 실행기마다 답(이 처리의 인사 출력, 영수증 처리기가 대조한 상태 보고)을 받은 순서의 줄에 둔다. 앞 답이 `held`이거나 실패(`ledger_unsaved`, `retry`가 있는 `ledger_failed`)로 붙들린 동안 그 실행기의 뒤 답을 장부에 넘기지 않는다. 실패한 답은 `retryHelloAnswer`로 같은 값을 먼저 다시 넘기고, `held`는 접수가 열린 뒤 같은 출력을 `passHelloAnswer`로 다시 넘긴다(그때 `not_current`면 버린다). 이미 지나간 상태 전이를 나중 답 위에 재생하지 않으려면 이 순서가 필요하다.
- **복원이 붙든 관측의 재시도가 운영의 더 새 답보다 먼저다.** 복원기가 적지 못하고 붙든 양성 관측은 2단계를 다시 불러야 적히고, 2단계가 통과해야 5단계가 접수를 연다. 이 처리는 접수가 열리기 전에는 장부를 부르지 않으므로(`held`) 그 순서가 저절로 선다. 조립이 이 처리를 우회해 `applyExecutorAnswer`를 직접 부르지 않는다.
- **실패한 실행기를 배정에서 뺀다.** 배정 순환의 후보 포트(`CandidateSource`)를 감싸는 쪽이 `withhold`의 실행기 후보를 뺀다. 그 실행기의 붙든 답이 모두 `applied`가 되거나 버려지고(`not_current`) 그 뒤 그 실행기의 인사가 `applied`가 될 때까지다. 장부가 그 실행기의 점유를 반영하지 못한 동안 새 시작을 맡기면, 장부가 모르는 점유 위에 시작이 적힌다. `input_rejected`(다시 넘길 값 없음)면 그 실행기를 계속 뺀다.
- **각 full 출력은 한 번만 넘긴다.** 다시 넘기는 것은 `held`와 실패뿐이다. 같은 출력을 두 번 넘기면 `outsideLedger`가 두 번 나와 닫는 지시가 겹친다.
- **연결 표는 넘기는 순간의 가장 새 값을, 복원기는 연결 판단의 맞춤에 쓴 그 객체를, `now`는 장부 시계를 넘긴다.** 옛 표 값을 넘기면 옛 판단이 된다. 다른 복원기 객체면 모든 인사가 `other_restore`다.
- **D-90의 닫기는 이 처리의 `applied` 결과의 서명 시각(`answeredAt`)과 `full`만 근거로 쓴다.** `held`·실패·`not_current`·`refused`, 상태 보고(`partial`), `occupancy(source)`의 행(서명 시각이 없다), 받은 시각은 근거가 아니다. 장부는 `full` 답 자체(어떤 실행이 없었는지)를 적지 않으므로(양성 관측은 `not_known` 밖만 적는다) 닫는 근거는 그 조각이 따로 남긴다(`src/ledger/ledger.md` "D-90의 닫기(뒤 조각)가 지킬 것").

## 남는 한계

- **붙든 답은 메모리에만 있다.** 다시 넘길 값(`retry`)과 `held` 출력은 프로세스가 다시 뜨면 사라진다. 그 답의 양성 관측은 장부 어디에도 흔적이 없다(`src/ledger/ledger.md` "0행의 뜻(함정)").
- **`held` 뒤 연결이 바뀌면 그 인사의 관측을 잃는다.** 복원 2단계가 이미 읽은 인사라면 복원이 적었다. 2단계 뒤 5단계 전에 받은 인사는 다시 넘기기 전에 연결이 바뀌면 `not_current`로 버려지고 아무도 적지 않는다.
- **`held`를 다시 넘기면 복원 2단계가 읽은 인사가 한 번 더 반영될 수 있다.** 장부의 첫 관측은 덮이지 않고, 3단계가 옮긴 실행은 `unknown_running`이라 다시 옮겨지지 않는다. 다만 `outsideLedger`가 2단계의 종료 대상과 겹칠 수 있다(닫는 지시가 두 번).
- **연결 대조는 부르는 쪽이 넘긴 표 값을 믿는다.** 표는 평범한 값이라 그 출처를 스스로 증명하지 못한다.
