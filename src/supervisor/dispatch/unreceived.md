# 받은 적 없는 실행의 자동 닫기 박자 (`unreceived.ts`)

D-90의 감독 쪽 판단이다. 실행기가 받은 적 없는 작업자 실행을 고르고, 그 실행기의 마지막 반영 인사가 조건을 모두 채울 때만 장부의 `closeUnreceivedRun`을 부른다. **닫는 판단은 장부가 한 트랜잭션에서 다시 한다**(`src/ledger/ledger.md` "받은 적 없는 실행의 닫기"). 이 박자는 후보를 고르고, 모름이면 부르지 않고, 부르면 결과를 구별할 뿐이다. 하나라도 맞지 않으면 그 실행은 지금처럼 관리자 닫기(D-91)를 기다린다.

순서기(`runtime/cycle.ts`)가 재전송 뒤, 배정 앞에서 부른다(`cycle.md` "한 박자의 차례" 5a). 소켓·타이머·시계·난수를 직접 쓰지 않는다. `now`는 순서기가 부르기 직전에 다시 읽은 장부 시계이고, 근거 줄의 닫은 시각으로만 쓴다(시간 판정은 실행기의 서명 시각과 장부의 발행 시각으로 한다).

## 병합해도 동작이 0인 까닭

- **증거 포트의 구현이 없다.** 답 줄이 실행기마다 마지막 반영 인사의 전체 목록·연결·주체·세대·시각과 오염을 내는 일은 뒤 조각이다. 그 전까지 조립은 증거를 `{ known: false }`로 줄 수밖에 없고, 그러면 모든 후보가 `evidence_unknown`이다.
- **순서기를 부르는 진입점이 없다**(`cycle.md`). 이 박자도 불리지 않는다.
- 새 인사를 부르는 길과 관측만 적는 장부 연산·그 호출도 없다. 셋 다 생겨도 이 박자의 판단은 바뀌지 않고 후보가 늘 뿐이다(아래 "뒤 조각이 지켜야 할 것").

## 공개 면

```ts
unreceivedTick(ports: UnreceivedPorts, now: number): UnreceivedTickResult   // 동기

UnreceivedPorts = {
  ledger: Pick<Ledger, "unansweredInstructions" | "closeUnreceivedRun">
  evidence: { read(executorId): UnreceivedEvidenceRead }   // 답 줄이 낸다(뒤 조각). 동기
  links: AnswerLinks                     // 내보내기 포트의 answers.current와 같은 것
  withheld: WithheldSource               // 답 줄의 withheld(배정·송신과 같은 원천)
  intake: Pick<Restorer, "stopGeneration"> // 연결 판단의 맞춤에 쓴 그 복원기
  observationsSettled: () => boolean     // 답 줄과 같은 신호
}

UnreceivedEvidenceRead =
  | { known: false }
  | { known: true, tainted: boolean, pending: boolean,
      lastFull: null | { connection, principal, stopGeneration, runs, answeredAt, receivedAt } }

UnreceivedTickResult =
  | { kind: "not_run", reason: "now_malformed" | "tick_in_progress" | "observations_unsettled"
        | "stop_generation_unknown" | "stop_generation_mismatch" | "withheld_unknown" | "read_unknown" }
  | { kind: "ran", runs: UnreceivedOutcome[], halted: null | "threw" | "observations_unsettled"
        | "stop_generation_unknown" | "stop_generation_mismatch" | "withheld_unknown", haltedAt: 요청 ID | null }

UnreceivedOutcome =
  | closed { requestId, runId, executorId, connection, answeredAt, at }
  | refused { …, reason: 장부의 거절 이름 }
  | skipped { …, reason: UnreceivedSkip }
  | ledger_failed { …, reason: "threw" | "malformed_answer" }   // 장부의 문구는 싣지 않는다
  | malformed { requestId | null, field }
```

`UNRECEIVED_ANSWER_AFTER_MS`(30000)는 장부의 `START_UNREACHABLE_MS`와 같은 식(`max(RUN_LEASE_MAX_MS, MESSAGE_TTL_MAX_MS)`)이다. 장부가 다시 보므로 미리 거르는 데만 쓴다: 값이 어긋나도 작으면 장부가 거절하고 크면 늦게 닫힐 뿐이다. 경계는 장부와 같이 정각 통과다(시험 #1·#2가 같은 실제 장부로 본다).

## 판단의 차례

박자 하나(`unreceived.ts:135`의 `unreceivedTick` → `:294`의 `tickOnce`):

1. **재진입.** 같은 장부 포트로 진행 중이면 `tick_in_progress`(`:133`). 박자 안에 `await`가 없어 겹치는 길은 포트 안에서 다시 부르는 것뿐이다.
2. **`now`.** 양의 안전 정수가 아니면 `now_malformed`.
3. **전역 포트 셋**(`readGate`, `:152`). 복원 대기(`observationsSettled() === true`가 아니면, 던짐 포함 `observations_unsettled`) → 복원기의 정지 세대(던짐·`null`·음수·정수 아님은 `stop_generation_unknown`) → 맡기지 않을 실행기(`known: false`·원소 하나라도 작업자 실행기 이름 아님·던짐은 `withheld_unknown`, `:173`).
4. **장부 읽기**(`:192`). `unansweredInstructions()`가 던지거나 `known: false`거나 꼴이 틀리면 `read_unknown`. 장부의 지금 정지 세대가 `null`이면 `stop_generation_unknown`, 복원기의 세대와 다르면 `stop_generation_mismatch`(`:300-301`).
5. **항목마다**(`judge`, `:321`). 시작 지시(`:226`) 밖의 항목은 후보가 아니라 결과에 없다. 칸이 틀린 항목은 `malformed`.
   1. 닫을 수 있는 상태(`preparing`·`unknown_running`, `:116`)가 아니면 `run_state`, 받는 쪽이 작업자 실행기 이름이 아니면 `not_worker`.
   2. **증거를 한 번 읽는다**(`:251`). 칸마다 한 번 읽고 목록은 원소까지 복사한다. 던짐·`known: false`·깃발이 `boolean`이 아님·시각이 양의 안전 정수가 아님·연결 번호가 음이 아닌 안전 정수가 아님·목록 원소의 `run_id`가 문자열이 아님은 모두 모름이다.
   3. **전역 포트 셋을 다시 본다**(`:328`). 앞 항목의 장부 쓰기나 증거 포트가 같은 동기 구간에서 바꿀 수 있다. 모름이면 그 자리에서 박자를 멈추고(`halted`), 복원기의 세대가 박자 처음의 장부 세대와 달라졌으면 `stop_generation_mismatch`로 멈춘다(`:330`).
   4. 읽어 둔 값만으로 견준다(`:332-343`): 지시를 적을 때의 세대 = 지금 세대(`stop_generation`) → 맡기지 않을 실행기에 없음(`withheld`) → 증거를 앎(`evidence_unknown`) → 오염 없음(`tainted`) → 대기 답 없음(`pending`) → 반영된 전체 인사 있음(`no_full`) → 그 인사의 주체 = 지정 실행기(`principal_mismatch`) → 그 인사가 맞춘 세대 = 지금 세대(`stop_generation`) → **서명 시각** ≥ 발행 + 30000(`answer_too_early`) → 그 인사의 목록에 이 실행이 없음(`run_in_answer`).
   5. **연결 재확인**(`:347`). 그 인사의 연결이 지금도 그 실행기의 인정된 연결인가(`links.current`). 거짓·던짐은 `link_not_current`. **이것이 장부 호출 전의 마지막 포트 호출이다.**
   6. **장부 호출**(`:351`). 입력은 증거에서 읽어 복사한 값 그대로다(`runs`, `answeredAt`, `receivedAt`)와 `now`, 낸 쪽은 지정 실행기 이름이다. 던지면 `ledger_failed`(`threw`), `ok`가 `true`·`false`가 아니거나 모르는 거절 이름이거나 돌려준 실행이 이 실행의 `not_started`가 아니면 `ledger_failed`(`malformed_answer`). 둘 다 그 자리에서 박자를 멈춘다(`halted: "threw"`, 장부가 적었는지 모른다). 장부의 거절은 `refused`로 그 이름 그대로 싣고 다음 항목을 본다.

순서기는 박자가 던지거나 `halted: "threw"`면 실행 목록을 다시 읽는다(`cycle.ts:442-443`). 전역 포트로 멈춘 것은 장부를 부르지 않았으므로 다시 읽지 않는다.

## 지킨 조건

번호는 설계 조사의 조건 번호다.

| 번호 | 조건 | 지킨 자리 | 시험 |
|---|---|---|---|
| E1 | 그 연결의 검증된 전체 인사만 근거. 부분 답·받은 시각은 근거가 아니다 | 증거 포트의 꼴(`lastFull` 하나, 서명 시각 칸), 시간 판정은 `answeredAt`만(`:342`). 근거가 그 출력이라는 것은 포트 구현이 지킨다(뒤 조각) | #2, #18 |
| E2 | 닫는 판단은 장부만 | 장부 포트는 읽기와 `closeUnreceivedRun` 둘(`:19`), 미리 거르기는 장부보다 더 막기만 한다 | 정적 "장부에는 닫기 하나만", #16(실제 장부의 `sent_by_other_open`) |
| E3 | 시각을 원래 전체 목록·연결·주체·세대에 묶음 | `UnreceivedFull` 한 묶음을 한 번 읽어 복사(`:251`), 장부에는 그 복사본을 넘김 | #2, "연결 재확인이 증거 목록을 고쳐도" |
| E4 | 앞선 인사·답이 버려진 실행기의 실행은 뺌 | `tainted`(`:335`) | #8 |
| E5 | 옛 연결 `retry`의 성공을 지금 연결의 부재 증명으로 쓰지 않음 | 증거의 연결 번호를 `links.current`로 지금 인정된 연결과 견줌(`:347`) | #7 |
| E6 | 더 새 양성 답이 대기 중인 실행은 뺌 | `pending`(`:336`) | #9 |
| E7 | 복원이 붙든 관측을 먼저 저장 | `observationsSettled`를 박자 처음과 항목마다(`:152`, `:328`) | #12 |
| E9 | 맡기지 않을 실행기·`known: false`면 0 | `readWithheld`(`:173`), 항목의 `withheld`(`:333`) | #11 |
| E10 | 서버를 새로 만들어 밀린 사본을 버린 실행기는 뺌 | `tainted`(포트가 이 버림도 오염으로 낸다) | #10 |
| E12 | 정지 세대가 다르면 아무것도 하지 않음 | 복원기·장부의 세대 일치(`:300-301`, `:330`), 지시의 세대와 인사가 맞춘 세대(`:332`, `:340`) | #13, "지시를 적을 때의 세대" |
| E13 | 시계를 믿을 수 없는 박자에는 보류 | 순서기: 박자 처음의 시계 `ok`와 부르기 직전 다시 읽은 시계 `ok`(`cycle.ts:431-434`, 박자 처음의 읽기는 `trusted()`) | #4, 순서기 "D-90 닫기 박자" |
| E14 | 같은 막힘(복원·깃발·시계), 재전송 뒤·배정 앞 | 순서기의 `trusted()`와 자리, 박자 함수는 만들 때 꺼내 쥠(`cycle.ts:183`) | 순서기 "차례", "D-90 닫기 박자", "박자 함수와 완료 신호" |
| E24 | 장부를 부르기 직전에 연결을 다시 봄(철회 경합) | `links.current`가 장부 호출 전의 마지막 포트 호출(`:347`), 증거 읽기부터 장부 호출까지 `await` 없음 | #5, #6, 정적 "연결 재확인은 마지막 포트 호출" |

**지키지 않은 것:** E25(새 인사를 부르는 길)는 이 조각에 없다. 연결이 살아 있는 동안 시작 발행 뒤의 인사가 오지 않으면 닫히지 않는다(#3).

## 모름으로 닫히는 입력

줄마다 실제 장부(시험의 `started`: `admitRun` → `startRun` → `markStartDispatch`, 공개 함수만)와 가짜 증거 포트로 `closeUnreceivedRun` 호출 횟수와 결과 갈래를 본다(`test/supervisor/dispatch/unreceived.test.ts`, "모름 표"). 작업자 자리가 하나라 후보 둘이 드는 줄(#6·#12·#16)은 실제 읽기 뒤에 장부에 없는 가짜 항목을 붙이고, 불리면 횟수로 드러난다(#6의 대조군은 그 항목이 장부까지 가 `unknown_run`이 되는 것을 본다).

| # | 입력 | 호출 | 결과 |
|---|---|---|---|
| 1 | 서명 시각 = 발행 + 29,999 | 0 | `skipped`/`answer_too_early`(장부도 같은 값에서 `answer_too_early`) |
| 2 | 서명 시각 = 발행 + 30,000 | 1 | `closed`, 장부 입력의 `answeredAt`·`receivedAt`이 제 칸 |
| 3 | 인사가 시작 발행보다 이르고 연결이 계속 산다 | 0 | `answer_too_early`(늦은 `now`·받은 시각에도) |
| 4 | 박자 처음의 시계가 후퇴·읽지 못함 | 0 | 순서기가 `skipped`/`clock_untrusted`, 돌아오면 같은 증거로 닫힘(대조군) |
| 5 | 장부 직전 재확인이 거짓·던짐, 증거·맡기지 않을 실행기 포트 안에서 철회 | 0 | `link_not_current` |
| 6 | 앞 실행의 닫기 쓰기 도중 철회 | 앞 1, 다음 0 | `closed`, `link_not_current` |
| 7 | 증거의 연결 ≠ 지금 연결 | 0 | `link_not_current` |
| 8 | 앞선 인사·상태 보고가 버려짐 | 0 | `tainted` |
| 9 | `held` 인사·`retry`·밀린 사본이 남음 | 0 | `pending` |
| 10 | 서버를 새로 만들어 밀린 사본을 버림 | 0 | `tainted`(이 모듈이 보는 칸은 #8과 같다) |
| 11 | `withheld`에 그 실행기 / `known: false`·이름 아님·던짐 | 0 | `withheld` / `not_run`/`withheld_unknown` |
| 12 | `observationsSettled`가 참 아님·던짐 / 박자 중에 거짓 | 0 / 앞 1 | `not_run`/`observations_unsettled` / `halted: "observations_unsettled"` |
| 13 | 인사의 세대 ≠ 지금 / 세대 모름 / 복원기 ≠ 장부 | 0 | `stop_generation` / `stop_generation_unknown` / `stop_generation_mismatch` |
| 14 | 목록에 그 실행이 있음 | 0 | `run_in_answer` |
| 15 | 증거 읽기 던짐·꼴 틀림(13가지), 전체 인사 없음, 주체 다름 / 장부 읽기 모름 | 0 | `evidence_unknown`, `no_full`, `principal_mismatch` / `not_run`/`read_unknown` |
| 16 | 장부가 던짐·답의 꼴이 틀림 / 장부의 거절 | 1 | `ledger_failed`(문구 없음)·`halted: "threw"`·뒤 항목 0회 / `refused`/`sent_by_other_open` |
| 17 | 세션·`queued`·`running` 실행 | 0 | 장부 읽기에 없음. 읽기가 틀리게 내도 `run_state`·`not_worker` |
| 18 | 받은 시각이 늦고 서명 시각이 이름 | 0 | `answer_too_early` |

"모름"이 닫기로 바뀌는 칸은 찾지 못했다. 일부러 틀리게 바꿔 본 줄(연결 재확인 지우기, 오염·대기 검사 지우기, `answeredAt`에 `receivedAt` 넣기, `withheld`의 `known: false`를 빈 집합으로 읽기, 인사의 세대 대조 지우기, 순서기의 다시 읽기를 박자 처음 시각으로 바꾸기·시계 막힘 빼기)은 모두 위 시험이 잡았다.

## 정한 것

- **오염은 실행기 단위다.** 버린 답의 내용을 모르는 경우(읽기 실패 등)도 있어 실행 단위로는 다 가리지 못한다. 닫지 않는 쪽이다.
- **증거 읽기의 모름은 그 항목만, 전역 포트의 모름은 박자 전체를 멈춘다.** 한 실행기의 증거를 모른다고 다른 실행기의 닫기를 막지 않는다("한 실행기의 모름은" 시험).
- **지시를 적을 때의 세대도 지금 세대와 같아야 한다.** 장부는 보지 않는 조건이고 닫는 쪽을 좁히기만 한다. 정지를 걸친 실행은 관리자 닫기로 간다.
- **목록과 서명 시각은 장부도 다시 보지만 미리 거른다.** 박자마다 시간 경계 전의 실행에 장부 쓰기 트랜잭션을 열지 않는다.
- **장부의 예외·정의 밖의 답 뒤에는 박자를 멈춘다.** 장부가 적었는지 모르는 채 다음 실행을 닫지 않는다. 순서기가 실행 목록을 다시 읽는다.

## 뒤 조각이 지켜야 할 것

- **증거 포트(답 줄):** 실행기마다 마지막 `applied` 인사 하나의 원래 `occupancy`(full) 출력 그대로 연결 번호·주체·맞춘 세대·전체 목록·서명 시각을 묶어 내고, `receivedAt`은 그 인사를 넘긴 때의 장부 시계로 낸다. 부분 답·`occupancy(source)`·받은 시각을 서명 시각 자리에 넣지 않는다. `held`·실패·`not_current`·`refused`는 `lastFull`을 바꾸지 않는다. 옛 연결 `retry`의 성공도 `lastFull`의 연결을 그 옛 번호로 둔다(그러면 재확인이 막는다).
- **오염 규칙:** 그 실행기의 인사·상태 보고·밀린 사본이 반영되지 않고 버려지면(`not_current`, 서버를 새로 만들며 버린 사본, 내용을 모르는 버림) 그 프로세스·그 장부 열기 동안 `tainted: true`. 답 줄이 고장 나면(`faulted`) `known: false`. 줄에 넘기지 않은 답이 있으면 `pending: true`. 동기로 읽힌다.
- **같은 객체:** `ledger`는 순서기·다른 박자와 같은 장부 객체, `links`는 내보내기 포트의 `answers`, `withheld`는 답 줄의 것, `intake`는 연결 판단의 맞춤에 쓴 복원기, `observationsSettled`는 답 줄에 넘긴 그 신호, `now`는 순서기가 넘긴 값을 그대로. 장부를 다시 열면 박자 함수 본문에서 지금의 객체로 위임한다.
- **새 인사를 부르는 길(A6e):** 시한 뒤의 전체 인사가 없는 실행기에만, 그 실행기에 임대를 믿는 실행이 없을 때 연결을 닫는다. 이 박자에 갈래를 더해도 연결 재확인은 장부 호출 직전의 마지막 포트 호출로 둔다.
- **관측만 적는 장부 연산과 그 호출(L5d+A6d):** 버려진 답의 양성 관측이 적힌 경우에만 오염을 풀 수 있다. 적기에 실패한 답은 오염으로 남긴다. 장부의 `run_sightings`가 늘면 `closeUnreceivedRun`이 `run_sighted`로 거절한다(이 박자는 `refused`로 싣는다).
- **진입점(N5):** 순서기의 `unreceived`에 위 포트를 묶은 `unreceivedTick`을 넘긴다. 보고의 `unreceived`(`closed`, `ledger_failed`, `halted`)를 관리자 기록으로 잇는 것도 진입점이 정한다.

## 남는 한계

- **오염은 그 프로세스 동안 유지된다.** 재접속 경합이 한 번이라도 있던 실행기는 그 프로세스가 사는 동안 D-90이 꺼진다. 관측만 적는 연산이 생기면 "적기에 실패한 답"으로 좁힐 수 있다.
- **새 인사가 오지 않으면 닫히지 않는다.** 연결이 살아 있고 실행기가 조용히 거절한 가장 흔한 경우는 A6e 전까지 관리자 닫기로 간다.
- **연결 재확인과 장부 커밋 사이는 한 동기 호출이다.** 그 호출 안에서 연결이 철회돼도 이미 확인한 인사로 닫는다(인사는 그 연결이 인정됐을 때 받은 것이다). 다음 항목부터는 다시 본다(#6).
- **근거가 그 연결의 검증된 인사라는 것은 이 모듈이 증명하지 못한다.** 포트가 넘긴 값을 믿는다(뒤 조각의 조건).
