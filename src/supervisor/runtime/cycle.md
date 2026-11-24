# 박자 순서기 (`cycle.ts`)

감독 순환의 한 박자를 차례대로 부르는 자리다. 한 박자에 연결 서버의 `tick()`과 박자 다섯(끊김 `linkLossTick` → 수명 `lifeTick` → 재전송 `resendTick` → D-90 닫기 `unreceivedTick` → 배정·시작 `assignAndStartTick`)을 차례로 부른다. 앞의 넷은 박자마다 많아야 한 번이고, 배정만 `assigned`가 나오면 같은 박자에서 `assignCallsPerBeat`번(상한 8)까지 되풀이한다. 박자 사이의 기억 넷(`watch`, `lastQueries`, `lastResends`, `unsentRenews`)을 쥐었다가 다음 박자에 넘긴다. **박자의 결과를 바꾸거나 다시 해석하지 않는다.** 결과의 정해진 칸을 기억으로 옮기고, 멈췄거나 적혔는지 모르는 결과 뒤에 장부를 다시 읽는 것만 한다.

박자 함수·서버 tick·장부 읽기·시계 둘·복원 끝 여부는 포트로 받는다. 시계·난수·타이머를 직접 부르지 않는다(시험이 소스를 읽어 지킨다). 박자를 언제 부를지(주기)는 부르는 쪽이 정한다. 이 순서기를 부르는 곳은 아직 없다. 실제 서버·포트·장부를 묶어 넘기는 것은 진입점 조각이다.

같은 폴더의 `shared-clock.ts`는 한 프로세스가 함께 쓰는 비후퇴 장부 시계다. 진입점이 이 객체 하나를 장부·내보내기 포트·연결 서버·순서기에 넘긴다(아래 "시계").

## 공개 면

```ts
createSharedClock(source: Clock): SharedClock
SharedClock = {
  now(): number                          // 원천 값이 하한보다 이르면 하한. 양의 안전 정수가 아니면 하한을 바꾸지 않고 그 값 그대로. 원천이 던지면 던진다
  read(): { state: "ok", at } | { state: "regressed" | "unavailable" }  // 순서기의 읽기. ok일 때만 하한을 올린다
}

createCycle(deps: CycleDeps): Cycle      // 정책이 범위 밖이면 CyclePolicyError(field), ledgerClock이 createSharedClock의 것이 아니거나
                                         // beats의 네 칸 중 함수가 아닌 것이 있으면 TypeError. ledgerClock과 박자 함수는 여기서 한 번만 읽는다

CycleDeps = {
  beats: CycleBeats
  serverTick: () => void                 // 연결 서버의 tick()
  ledgerClock: SharedClock               // 장부·내보내기 포트·연결 서버에 넘긴 그 공유 시계
  monotonic: MonotonicClock              // 끊긴 시간만 재는 단조 시계
  restoreDone: () => boolean             // 지금 장부의 복원이 5단계까지 끝났는가
  ledger: Pick<Ledger, "listRuns" | "listWaitingToolRequests" | "instructionTimes" | "unansweredInstructions">
  policy: { judgeMs, resendEveryMs, assignCallsPerBeat }
  observe?: (report: BeatReport) => void // 동기 기록기. 던져도 박자에 영향이 없다
}

CycleBeats = {
  linkLoss(clocks: { clock, monotonic }, policy: LinkLossPolicy, input: LinkLossTickInput): LinkLossTickResult
  life(clock: Clock, input: LifeTickInput): Promise<LifeTickResult>
  resend(clock: Clock, policy: ResendPolicy, input: ResendTickInput): Promise<ResendTickResult>
  unreceived(now: number): UnreceivedTickResult   // 동기. dispatch/unreceived.md
  assign(now: number): Promise<TickResult>
}

Cycle = {
  beat(): Promise<BeatReport>
  closeIssuance(): Promise<void>         // 깃발을 세우고 진행 중 박자가 돌아오기를 기다린다
  issuanceOpen(): boolean                // 깃발이 서기 전이면 true
  noteCandidate(executorId: string): void // 연결 표의 candidate. watch에 absentSince: null로 더한다
}

BeatReport =
  | { kind: "skipped", reason: "beat_in_progress" | "issuance_closed" }
  | { kind: "ran", serverTick: "ok" | "threw", clock: "ok" | "regressed" | "unavailable",
      linkLoss: Step, life: Step, resend: Step, unreceived: Step, assign: Step[], rereads: Reread[] }

Step = { kind: "returned", result } | { kind: "threw" } | { kind: "skipped", reason: "restore_not_done" | "issuance_closed" | "clock_untrusted" }
```

`CycleBeats`는 실제 박자 함수에 포트를 묶은 것이다. 시계와 끊김·재전송의 정책은 순서기가 넘기는 값을 그대로 포트에 넣는다(시험이 실제 박자 넷을 이 꼴로 묶는 형 검사를 한다). `createCycle`은 네 함수를 만들 때 한 번 꺼내 쥐고 박자마다 `beats`를 다시 읽지 않는다. 수신자는 넘긴 `beats` 객체다. 쥔 함수는 `Reflect.apply`로 부르고 함수의 `name`·`length` 같은 메타데이터는 읽지 않는다(`bind`는 그 속성을 읽어, 접근자가 던지면 만들기가 실패한다). 나중에 그 객체의 속성을 바꿔도 따르지 않으므로, 지금의 장부·어댑터로 바꾸는 일은 함수 본문 안에서 한다:

```ts
linkLoss: (clocks, policy, input) => linkLossTick({ ...linkLossPorts, ...clocks }, policy, input)
life:     (clock, input) => lifeTick({ ...lifePorts, clock }, lifecyclePolicy, input)
resend:   (clock, policy, input) => resendTick({ ...resendPorts, clock }, policy, input)
unreceived: (now) => unreceivedTick(unreceivedPorts, now)
assign:   (now) => assignAndStartTick(assignPorts, assignPolicy, now)
```

## 한 박자의 차례

`beat()`는 먼저 깃발을 본다(섰으면 `skipped`/`issuance_closed`). 그다음 진행 중인 박자가 있으면 `skipped`/`beat_in_progress`다. 둘 다 참이면 `issuance_closed`다. 통과하면 첫 포트를 부르기 전에 이 박자의 완료 약속을 게시하고 아래를 부른다.

1. **서버 `tick()`.** 복원 전에도, 시계를 믿을 수 없어도 부른다. 던지면 `serverTick: "threw"`이고 박자는 이어진다.
2. **박자 처음의 장부 시계.** 아래 "시계"의 하한으로 읽는다. `ok`가 아니면 이 박자의 재전송·배정을 부르지 않는다.
3. **끊김.** 복원이 끝났고 깃발이 서지 않았을 때만.
4. **수명.** 같은 조건. `unsentRenews`가 비어 있지 않으면 먼저 실행 목록을 읽어 뺄 것을 빼고, 그 읽기 뒤에 조건을 본다.
5. **재전송.** 같은 조건과 박자 처음의 시계가 `ok`일 때.
5a. **D-90 닫기(`dispatch/unreceived.md`).** 재전송과 같은 조건. 배정처럼 장부 시계를 다시 읽어 `now`로 넘기고 그 읽기 뒤에 조건을 본다(다시 읽은 값이 `ok`가 아니면 `clock_untrusted`). 동기 박자라 기다리지 않는다. 던지거나 `halted: "threw"`면 실행 목록을 다시 읽고(`rereads`의 `beat: "unreceived"`), 어느 쪽이든 배정은 돈다.
6. **배정·시작.** 같은 조건. 장부 시계를 다시 읽어 `now`로 넘기고, 그 읽기 뒤에 조건을 본다. 결과에 `assigned`가 있고 멈추지 않았으면 같은 박자에서 다시 부른다(처음 포함 `assignCallsPerBeat`번까지).

박자마다 부르기 직전에 복원 끝 여부와 깃발을 다시 본다. **이 확인이 박자를 부르기 전의 마지막 일이다.** 그 앞의 포트 읽기(수명 앞의 실행 목록, 배정 앞의 시계)는 먼저 끝내고, 복원 조회가 돌아온 뒤에 깃발을 한 번 더 본다. 부르는 함수는 만들 때 꺼내 쥔 것이고 박자의 인자(끊김의 `watch` 사본, 수명·재전송의 기억 목록, 배정의 `now` 숫자)는 확인 전에 만든다. 그래서 확인과 함수 진입 사이에 외부 객체의 속성·접근자·배열 생성자가 돌 틈이 없다. `watch`는 결과를 받을 때와 넘길 때 모두 두 칸만 인덱스로 옮겨 새 일반 배열에 담는다(`map`은 박자가 돌려준 배열 하위 타입의 생성자를 부른다). 인자를 만든 뒤(확인 중 포함) 더해진 candidate는 끊김 결과 `watch`로 바꾼 뒤 다시 더한다. 포트가 그 안에서 `closeIssuance()`를 부르거나 복원을 다시 시작해도 바로 다음 박자가 열리지 않는다. **한 번 막히면 그 박자의 남은 박자도 같은 이유로 막힌다.** 박자 하나가 던지거나 멈춰도 그 박자의 남은 박자는 그대로 돈다(아래 "멈춘 박자").

### 차례의 근거

- **서버 tick이 먼저다.** 서버에는 타이머가 없다. hello 대기(`hello_late`), 복원기가 바뀐 연결(`restore_changed`), 넘긴 답의 기한은 `tick()`이 불려야 닫힌다(`transport/server.md` "뒤 조각이 지켜야 할 것"). 먼저 불러야 같은 박자의 끊김 박자가 닫힌 연결을 반영한 연결 표를 본다. 실제 서버 tick 사이의 간격이 "기한 뒤에 넘긴 답이 나갈 수 있는 틈"의 길이다. 박자가 포트를 기다리는 동안의 호출은 거절되므로 이 간격은 호출 주기보다 길 수 있다(아래 "뒤 조각이 지킬 것"의 포트 대기 예산).
- **끊김 → 수명.** 정해진 차례다(`dispatch/link-loss.md` "뒤 조각이 지킬 것"). 옮긴 실행에는 장부가 갱신을 거절하므로 끊겼다고 판정한 실행기의 실행에 갱신이 적히기 전에 옮긴다. 끊김 박자는 동기라 돌아온 뒤에 수명 박자를 부른다.
- **수명 → 재전송.** 갱신이 시간에 가장 민감하다. 갱신을 낼 수 있는 구간은 기본값에서 7000ms이고(`dispatch/life-loop.md` "박자를 되풀이해 부른다"), 재전송·배정은 내보내기 포트를 기다리므로 그 뒤에 두면 갱신이 늦어진다.
- **재전송 → 배정.** 새 일(배정·시작)은 이미 진 일(갱신·종료·재전송)을 내보낸 뒤에 연다. 배정 박자의 시작 판단은 박자 처음의 읽기로 하므로 앞 박자들의 쓰기를 본 뒤가 안전하다. 끝에 두면 배정의 되풀이가 다른 박자를 미루지 않는다.
- **D-90 닫기 박자의 자리는 재전송 뒤, 배정 앞이다.** 닫아 푼 자리를 같은 박자의 배정이 쓸 수 있다. 재전송의 결과(`start_expired`)는 쓰지 않는다: 후보와 시간 경계는 장부 읽기의 시작 지시와 그 발행 시각으로 정하므로 재전송이 던지거나 멈춘 박자에도 판단이 같다.

## 정한 것

1. **겹친 `beat()`는 기다리지 않고 거절한다**(`skipped`/`beat_in_progress`, 아무 박자도 부르지 않는다). 박자 안의 포트(서버 tick, 끊김 박자의 포트 등)에서 다시 부른 것도 같다. 기다리게 하면 박자 안에서 다시 부른 호출이 자기 박자를 기다려 끝나지 않고, 주기로 부르는 쪽은 밀린 박자를 쌓을 이유가 없다. 거절은 약속을 만들기 전의 동기 깃발로 가르므로 동기 구간의 재진입도 잡는다.
2. **복원 전에는 박자 넷을 모두 부르지 않는다.** 정해진 것은 끊김 박자뿐이다(`link-loss.md` "실패한 장부는 다시 열어 복원하고"). 나머지도 막은 이유: 복원은 단계마다 장부를 바꾸고(3단계가 진행 중 실행을 `unknown_running`으로 옮김) 박자의 다시 읽기는 그런 겹침을 분석하지 않았다. 배정·시작은 접수가 5단계 뒤에 열려 어차피 돌지 않는다. 대가는 취소·기한의 종료와 조회가 복원이 끝날 때까지 미뤄지는 것이다. 끊김 박자 없이 수명 박자만 도는 박자를 만들지 않으려고 막힘은 그 박자 끝까지 이어진다.
3. **끊김 박자가 `not_run`이거나 던져도 수명 박자는 돈다.** 수명 박자는 갱신 직전에 그 실행기의 연결을 `mayIssue`로 따로 본다. 끊김 박자의 읽기 실패마다 수명 박자를 막으면 모든 실행기의 갱신이 멈춰 살아 있는 일이 임대 끝에서 닫힌다.
4. **시계 하한은 프로세스 전체가 나눈다(`shared-clock.ts`).** 공유 시계는 누가 읽든(장부·내보내기 포트·연결 서버·순서기) 그 값을 하한으로 올린다. 장부·포트·서버가 쓰는 `now()`는 원천 값이 하한보다 이르면 하한을 낸다(내는 값이 줄지 않는다). 순서기는 `read()`로 원천 값을 하한과 견주고, 박자에는 하한보다 이른 원천 값을 던지는 시계를 넘긴다(같은 값은 받는다). 박자들은 던지는 시계를 "읽지 못함"으로 다룬다(끊김·수명·재전송은 `clock_unavailable`, 배정은 `now`를 받지 못해 불리지 않는다). 박자 처음의 읽기가 후퇴나 읽지 못함이면 그 박자의 **재전송 전체**와 배정을 부르지 않는다. 재전송에서 시작만 골라 막을 자리가 순서기에 없어 취소·확정의 재전송도 한 박자 미뤄진다. 송신 직전 확인이 읽은 시각도 하한이라, 그 확인이 "늦었다"고 닫은 시작의 송신 창은 원천 시계가 뒤로 가도 다시 열리지 않는다. 원천 값이 양의 안전 정수가 아니면 `now()`는 하한을 바꾸지 않고 그 값을 그대로 내고, 순서기는 `read()`의 `unavailable`로 알아 그 박자의 재전송·배정을 보류한다. `now()`가 던지면 장부는 읽기 실패로 실패 표시를 남겨 다시 열 때까지 쓰지 못하고, TLS 수락 콜백에서는 예외가 밖으로 나간다. 그래서 무효 값은 각 소비자의 무효 시각 처리에 맡긴다(장부의 `#ledgerNow`는 모든 기한이 지난 것으로 본다). 그 처리가 없는 소비자의 틈은 아래 "남는 한계"다. 원천이 던지면 `now()`도 던진다. 끊김 박자의 단조 시계는 순서기만 넘기므로 순서기 안에 하한을 둔다.
5. **기억을 줄이는 때.** `lastQueries`는 수명 결과가 완결(`halted: null`)일 때 그 목록에 없는 실행을 뺀다(끝난 실행은 목록에 없다). `lastResends`는 재전송 결과가 완결일 때 읽기에서 사라진 요청 ID를 뺀다(`resend.md` "뒤 조각이 지킬 것"). 멈춘 결과로는 줄이지 않는다. 같은 키의 시각은 늦은 쪽을 남긴다(다음 조회·재전송을 앞당기지 않는 쪽).
6. **`noteCandidate`는 작업자 실행기 이름만 받는다.** 끊김 박자는 기억에 작업자 실행기가 아닌 이름이 하나라도 있으면 기억 전체를 `input_malformed`로 거절하므로, 다른 이름을 넣으면 그 뒤 끊김 박자가 영영 돌지 않는다. 끊김 박자를 부르는 동안 더해진 이름은 결과 `watch`로 바꾼 뒤 다시 더한다(결과가 덮어 지우지 않게. 연결을 본 기록이라 판정을 늦추는 쪽이다).
7. **배정 되풀이의 상한은 `ASSIGN_CALLS_MAX`(8)다.** 되풀이하는 동안 수명 박자가 돌지 않으므로 박자 하나가 갱신 구간을 다 쓰지 않게 묶는다. 이 상한은 호출 수만 묶고 한 포트의 대기 시간은 묶지 않는다(포트 대기 상한은 진입점이 정한다. 아래 "뒤 조각이 지킬 것"). 운영 값은 정하지 않았다.
8. **기억은 이 객체의 메모리에만 있다.** 감독이 다시 뜨면 새 객체가 빈 기억으로 시작한다. `watch`의 시각은 프로세스마다 기점이 다른 단조 시각이라 옮기면 안 되고, 나머지 셋은 비었을 때의 동작이 각 박자 문서에 정해져 있다(곧바로 묻기, 발행 시각부터 간격, 복원 3단계의 `unknown_running` 전이).

## 기억 넷

| 기억 | 넣는 것 | 빼는 것 | 원문 |
|---|---|---|---|
| `watch` | 끊김 결과가 `ran`이면 `halted`여도 결과의 `watch`로 바꾼다. `not_run`·던짐이면 앞 것을 쥔다. `noteCandidate`가 `{ 이름, absentSince: null }`을 더한다 | 결과가 바꿀 때만 | `link-loss.md` "뒤 조각이 지킬 것" |
| `lastQueries` | 수명 결과의 `query_sent`와 `delivery: "unknown"`인 `query_not_sent`의 `{ runId, at }` | 완결된 결과에 없는 실행 | `life-loop.md` "조회", "뒤 조각이 지킬 것" |
| `lastResends` | 재전송 결과의 `resent`와 `delivery: "unknown"`인 `not_sent`의 `{ requestId, at }`(`sealedAt`이 아니다) | 완결된 결과에 없는 요청 ID | `resend.md` "두드리지 않기", "뒤 조각이 지킬 것" |
| `unsentRenews` | 수명 결과의 `renew_recorded_not_sent`(어느 `delivery`든)와 `renew_record_unknown`의 실행 ID | 장부의 실행 목록에서 그 행의 `state`가 유효한 상태 값(`LEDGER_RUN_STATES`)이고 `preparing`·`running`이 아님을 확인했을 때만. 결과 목록에서 사라진 것, 읽지 못한 것, 목록에 없는 것, `state` 칸이 없거나 모르는 값인 행으로는 빼지 않는다 | `life-loop.md` "싣지 못한 갱신" |

박자에는 기억의 사본을 넘긴다. `watch`는 넘길 때와 결과를 받을 때 모두 원소까지 복사한다: 박자가 넘겨받은 배열·원소나 자기가 돌려준 결과를 나중에 고쳐도 순서기의 기억은 바뀌지 않는다. 원소는 칸 둘(`executorId`, `absentSince`)뿐이고 실행기마다 하나라 복사 비용이 작다. 나머지 셋은 순서기 안의 `Map`·`Set`에서 박자마다 새 배열과 새 원소를 만들어 넘긴다.

## 멈춘 박자

순서기는 장부를 다시 읽고 그 결과를 보고(`rereads`)에 싣는다. 다음 박자의 재료는 각 박자가 처음에 다시 읽으므로, 순서기가 다시 읽는 것은 "쓰기가 없었다고 가정하지 않음"을 관측에 남기고 `unsentRenews`를 확인하기 위해서다.

| 무엇 | 순서기가 하는 것 |
|---|---|
| 박자 함수가 던짐(`threw`) | 실행 목록(`listRuns`)을 다시 읽는다. 배정이면 대기 부탁 목록(`listWaitingToolRequests`)도 먼저 읽는다. 그 박자의 기억은 앞 것을 쥔다. 남은 박자는 돈다 |
| `ran`이고 `halted`가 있음(끊김·수명·재전송의 `threw`, 배정의 `threw`) | 실행 목록을 다시 읽는다. 배정이면 대기 부탁 목록도 읽고(`assign-loop.md` "박자가 멈출 때"의 "대기 부탁·실행 전체") 되풀이하지 않는다. 배정의 `halted: "intake_closed"`는 되풀이만 멈추고 다시 읽지 않는다. 결과의 기억 칸은 반영한다(완결이 아니어서 줄이지는 않는다) |
| 끊김의 `ledger_failed`가 `threw`·`malformed_answer` | 실행 목록을 다시 읽는다. 장부의 거절 이름이면 다시 읽지 않는다(기억의 `absentSince`가 남아 다음 박자가 다시 부른다) |
| 수명의 `renew_record_unknown` | `instructionTimes(runId)`의 `renewIssued.issuedAt`이 결과의 `issuedAt`과 같은지(`found`). 실행 ID는 `unsentRenews`에 넣는다 |
| 수명의 `stop_record_unknown` | `unansweredInstructions()`에 그 요청 ID가 있는지(`found`). 답을 받은 지시는 없으므로 `false`가 "적히지 않음"은 아니다 |

다시 읽기를 읽지 못하면 `known: false`·`found: null`이다. 다음 박자는 평소대로 돈다. 배정의 다시 읽기는 목록마다 하나씩(`read: "waiting_requests"`, `read: "runs"`) 싣는다. `known: true`는 그 목록을 읽었다는 뜻까지다. 결과 밖의 항목을 대조해 고친 것은 아니고, 끊김 뒤의 `known: true`도 실행이 `unknown_running`으로 옮겨졌는지는 말하지 않는다.

## 발급 닫기

`closeIssuance()`는 깃발을 곧(첫 `await` 전에) 세우고 진행 중인 박자가 돌아오기를 기다린다. `beat()`는 첫 포트(서버 tick)를 부르기 전에 그 박자의 완료 신호를 게시하므로, 박자 안의 어느 포트(서버 tick, 복원 조회, 끊김 박자, 수명 박자의 동기 구간 등)에서 부른 닫기도 그 박자가 돌아온 뒤에 돌아온다. 완료 신호는 박자가 이행하든 거부하든 이행만 한다. 박자의 거부는 `beat()`의 약속 하나로만 호출자에게 가고, 닫기는 거부하지 않는다(호출자가 그 거부를 잡으면 받을 곳 없는 거부가 남지 않는다). 깃발 뒤에는:

- 새 `beat()`는 서버 tick도 부르지 않고 `skipped`/`issuance_closed`다.
- 진행 중인 박자는 지금 부르고 있는 박자 함수가 돌아올 때까지 기다리고, 그 뒤의 박자(배정 되풀이 포함)를 부르지 않는다. 진행 중인 박자 함수 안의 발급은 막지 못한다.
- `issuanceOpen()`이 `false`다. 내보내기 포트의 마지막 확인이 이것을 보게 하는 것은 뒤 조각이다.

박자 안의 포트에서 `closeIssuance()`를 **기다리면** 그 박자가 끝나지 않는다(자기 박자를 기다린다). 부르기만 하고 기다리지 않는 것은 된다.

## 지킨 조건

번호는 설계 조사의 조건 번호다.

| 번호 | 조건 | 지킨 자리 | 시험 | 원문 |
|---|---|---|---|---|
| C1 | 박자를 겹쳐 부르지 않는다(재진입 포함) | `beat()`의 `busy` 깃발(약속을 만들기 전에 세움) | 직렬화와 재진입 | `life-loop.md`·`resend.md` "박자를 직렬화한다" |
| C2 | 끊김 박자를 수명 박자보다 먼저 | `runBeat`의 차례, 막힘이 그 박자 끝까지 이어짐 | 차례 | `link-loss.md` "끊김 박자를 수명 박자보다 먼저 부른다" |
| C3 | 복원이 끝나기 전에는 끊김 박자를 부르지 않는다 | `gate()`가 박자마다, 그 앞의 포트 읽기 뒤에 `restoreDone()`을 다시 봄(던지면 끝나지 않음), 박자 함수는 `takeBeats`가 만들 때 꺼내 쥠(확인 뒤 외부 조회 없음) | 복원 전, 포트 안에서 바뀐 상태, 박자 함수와 완료 신호 | `link-loss.md` "실패한 장부는 다시 열어 복원하고" |
| C4 | 장부와 같은 시계, 박자 사이에 후퇴하지 않게. 믿을 수 없으면 시작 재전송 보류 | `shared-clock.ts`의 공유 하한(장부·포트·서버의 읽기 포함), 박자에 넘기는 던지는 `clock`, 박자 처음의 읽기로 재전송·배정 보류, 배정 직전의 다시 읽기 | 시계, 공유 시계, 실제 박자 넷과 장부 | `resend.md` "박자 사이에도 시계가 뒤로 가지 않게", `assign-loop.md` "`now`는 장부 시계와 같은 시계" |
| C5 | 끊김 박자의 단조 시계는 벽시계와 따로, 재기동하면 기억을 비움 | `monotonic`을 끊김 박자에만, 같은 하한. 기억은 객체 메모리 | 단조 시계 | `link-loss.md` "`monotonic`은 한 프로세스 안에서", "감독이 다시 뜨면 기억을 비운다" |
| C6 | 되풀이 부름: `assigned`면 곧 | 배정 되풀이(상한 `assignCallsPerBeat`) | 차례 | `assign-loop.md` "박자를 되풀이해 부른다" |
| C8 | `watch` 넘기기, `candidate`마다 `null`로 더함 | `takeLinkLoss`, `noteCandidate` | 기억 넷 | `link-loss.md` "`watch`를 넘긴다", "`candidate`를 낼 때" |
| C9 | `unsentRenews`는 장부 상태를 확인한 뒤에만 뺌 | `takeLife`(넣기), `pruneUnsent`(빼기) | 기억 넷 | `life-loop.md` "싣지 못한 갱신" |
| C10 | `lastQueries`·`lastResends`는 결과의 `at` | `takeLife`, `takeResend` | 기억 넷 | `life-loop.md` "`lastQueries`를 넘긴다", `resend.md` "`lastResends`를 넘긴다" |
| C12 | `halted`를 본다, 예외로 끝나도 쓰기 0을 가정하지 않음 | `rereadRuns`(네 박자 모두), 배정은 `rereadAssign`(대기 부탁과 실행 목록) | 멈춘 박자와 던진 박자, 멈춘 배정 | `assign-loop.md`·`life-loop.md`·`resend.md` "`halted`를 본다" |
| C13 | `*_record_unknown`은 장부를 다시 읽어 가림 | `rereadRenew`, `rereadStop` | 멈춘 박자와 던진 박자 | `life-loop.md` "`halted`를 본다" |
| C14 | 끊김의 `ledger_failed`는 다음 박자에, `threw`·`malformed_answer`·`halted`면 다시 읽기 | 끊김 블록의 다시 읽기 갈래 | 멈춘 박자와 던진 박자 | `link-loss.md` "`ledger_failed`면" |
| C26 | 시작을 다시 내려면 `resendEveryMs <= 19000` | `readPolicy`(`START_LAST_SEAL_MS` 이하만) | 정책 검사 | `resend.md` "간격을 정한다" |
| C36 | 서버를 닫기 시작하면 새 발급을 먼저 막음(깃발과 기다림까지) | `closeIssuance`, 첫 포트 전에 게시하고 성공·실패 모두 이행하는 완료 신호, `gate()`의 깃발(복원 조회 뒤에 다시), `issuanceOpen` | 발급 닫기, 포트 안에서 바뀐 상태, 박자 함수와 완료 신호 | `transport/server.md`, `runtime/sink.md` "뒤 조각이 지켜야 할 것" |
| C41 | `server.tick()`을 박자마다 | 박자 처음의 `serverTick()` | 차례, 복원 전 | `transport/server.md` "`tick()`을 박자마다 부른다" |
| C61 | 판정 시간은 정책으로, `RUN_LEASE_MAX_MS` 이상 | `readPolicy` | 정책 검사 | `link-loss.md` "판정 시간은 정책으로 넘긴다" |

정책은 만들 때 한 번 검사하고 얼려 둔 사본을 쓴다. 넘긴 정책 객체를 나중에 바꿔도 따르지 않는다(시험이 본다).

**일부만 지킨 것:** C4의 "같은 프로세스 전체의 비후퇴"는 진입점이 공유 시계 하나를 장부·내보내기 포트·연결 서버·순서기에 모두 넘길 때 성립한다(순서기는 꼴만 같은 시계를 거절하지만 다른 소비자에 같은 객체를 넘겼는지는 확인할 수 없다). 원천이 무효 값을 내는 읽기는 하한을 거치지 않고 소비자의 무효 처리를 따른다(아래 "남는 한계"). C4의 "재기동을 걸친 비후퇴"와 C6의 "갱신 구간 7000ms 안에서 여러 번"은 이 순서기 밖이다(아래).

## 뒤 조각이 지킬 것

- **진입점(N5): 공유 시계 하나를 모두에 넘긴다.** 원천 시계를 `createSharedClock`으로 한 번 감싸고, 그 객체를 장부(`openLedger`의 `clock: () => shared.now()`)·복원기·내보내기 포트(`createWireSink`의 `clock`)·연결 서버의 `clock`·박자 넷의 포트·순서기의 `ledgerClock`에 넘긴다. 원천 시계를 직접 받는 소비자가 하나라도 있으면 그 읽기가 하한에 들지 않아, 송신 직전 확인이 닫은 시작의 송신 창이 원천 시계의 후퇴로 다시 열린다(시험 "실제 박자 넷과 장부"의 +19,001ms/+19,000ms 사례).
- **진입점(N5): 같은 객체를 넘긴다.** 박자 넷의 포트, 순서기의 `ledger`, 서버, 내보내기 포트가 같은 장부 객체·같은 복원기 게시 함수·같은 공유 시계를 쓴다.
- **진입점(N5): 박자 함수를 이 순서기로만 부른다.** 박자를 따로 부르는 다른 경로가 있으면 직렬화가 깨진다. 같은 장부는 한 프로세스만 연다. 순서기는 프로세스마다 하나다.
- **진입점(N5): 주기로 `beat()`를 부른다.** 이 모듈에는 타이머가 없다. 수명 박자가 갱신 구간(기본 7000ms) 안에서 여러 번 돌 만큼 짧게 부른다. `beat_in_progress`로 거절된 호출은 버려도 된다. 보고(`observe`)의 `threw`·`rereads`·`clock`을 관리자 경보로 잇는 것도 진입점이 정한다.
- **진입점(N5): 호출 주기와 실제 처리 간격을 따로 보고 포트 대기 예산을 정한다.** 박자 하나가 포트(내보내기 포트, 자격 조회 등)를 기다리는 동안 그 사이의 `beat()`는 모두 `beat_in_progress`로 거절되고, 서버 tick과 수명 박자도 그만큼 돌지 않는다. 배정 횟수 상한(8)은 호출 수만 묶고 한 포트의 대기 시간은 묶지 않는다. 그래서 갱신 구간과 서버 답 기한의 틈은 호출 주기가 아니라 실제 서버 tick·수명 박자 사이의 간격으로 잰다. 진입점은 그 간격을 관측하고(보고의 시각 또는 거절 수), 포트마다 기다릴 수 있는 상한을 주기와 함께 정한다.
- **진입점(N5): 장부를 다시 열고 복원하는 동안 `restoreDone()`이 `false`다.** 순서기는 복원을 돌리지 않는다. 다시 연 뒤에도 같은 순서기를 쓴다면 박자 함수는 부를 때마다 함수 본문 안에서 지금의 장부·복원기에 위임해야 한다(순서기가 만들 때 꺼내 쥐므로 `beats` 객체의 속성을 바꿔 끼우는 것은 따르지 않는다. 옛 객체를 붙들지 않는다). 기억은 같은 프로세스 안에서는 이어도 된다.
- **진입점(N5): 장부를 다시 열 때 순서기의 재조회 넷도 새 장부로 위임한다.** 순서기는 만들 때 받은 `ledger`를 쥐고 `listRuns`·`listWaitingToolRequests`·`instructionTimes`·`unansweredInstructions`를 그 객체에 부른다. 같은 순서기를 이어 쓰면 이 포트는 호출할 때마다 지금의 장부에 위임하는 객체여야 한다(닫힌 옛 장부를 붙들면 목록 다시 읽기 둘은 `known: false`, 지시 다시 읽기 둘은 `found: null`이 된다). 순서기를 새로 만들어 바꾸는 설계라면 옛 박자가 돌아오기를 기다리는 것과 공유 시계(하한의 소유자)를 넘기는 것도 정한다.
- **내보내기 포트(싱크): 송신 시한 검사의 시각을 유효한 양의 안전 정수로 확인한다.** 지금은 0·음수 안전 정수를 시각으로 받아, 원천이 그 값을 낸 읽기로는 송신 시한을 넘겨 닫은 시작의 창이 열릴 수 있다. 무효면 그 송신을 거절한다(아래 "남는 한계").
- **TLS 수락: 인증서 기간 비교의 시각을 유효한 양의 안전 정수로 확인하고, 원천 시계의 예외도 그 연결만 거절한다.** 지금은 `NaN`이면 재료 만료·상대 인증서 기간 비교가 모두 거짓이고, 원천이 던지면 수락 콜백 밖으로 나간다(아래 "남는 한계").
- **재기동을 걸친 시계 비후퇴는 이 PR 밖이다.** 하한은 메모리에만 있다. 장부의 마지막 기록 시각을 하한으로 읽을지는 정하지 않았다.
- **답 줄과 연결 잇기(N4a2):** 연결 서버의 `candidate` 사건마다 `noteCandidate(주체 이름)`을 부른다. 수명 결과의 `pendingQueries`를 영수증 처리기에 넘기는 것과 조회 등록부는 그 조각이다(순서기는 넘기지 않는다). `not_rebuildable`·`stop_generation_mismatch` 뒤의 조회도 그 쪽이다.
- **자격 값과 종료 순서(N4a3):** 내보내기 포트와 자격 값 보내기의 `lastCheck`가 `issuanceOpen()`을 보게 하고, `closeIssuance()`가 돌아온 뒤에 `server.close()`를 부른다. 그 전까지 진행 중이던 박자 함수 안의 발급은 포트가 막지 않는다.
- **D-90 닫기 박자의 증거와 진입점:** 박자는 `unreceived`로 끼웠다(위 5a). 진입점은 답 줄·내보내기 포트·복원기와 같은 객체를 그 포트에 묶는다. 증거 포트의 구현과 그 밖의 조건은 `dispatch/unreceived.md` "뒤 조각이 지켜야 할 것"이다.
- **재전송의 보류 사유가 늘어도 순서기는 바뀌지 않는다.** `resent`와 `delivery: "unknown"`인 `not_sent`만 기억으로 옮기고 다른 갈래는 그대로 보고에 싣는다.

## 남는 한계

- **진행 중인 박자 함수는 멈추지 못한다.** 깃발 뒤에도 지금 부르고 있는 박자 함수 안의 발급은 나갈 수 있다. 포트 쪽 차단이 붙을 때까지 남는다.
- **박자 처음의 시계 후퇴는 재전송 전체를 미룬다.** 취소·확정의 재전송도 한 박자 늦어진다.
- **원천 시계가 뒤로 간 동안 장부·포트·서버의 시각은 하한에 멈춘다.** 원천이 하한보다 작은 동안(후퇴한 폭만큼) 기한·임대·답 기한이 흐르지 않은 것으로 보인다. 그동안 순서기는 박자마다 재전송·배정을 미루고 끊김·수명 박자는 `clock_unavailable`이다. 원천이 하한과 같아진 박자부터 다시 부른다.
- **원천이 무효 값을 내면 그 읽기는 각 소비자의 무효 처리를 따르고, 그 처리가 없는 소비자에서는 하한이 지켜지지 않는다.** 장부는 모든 기한이 지난 것으로 보고 실패 표시를 남기지 않는다. 싱크는 안전 정수가 아니면 `clock_unavailable`로 거절하지만 0·음수 안전 정수는 시각으로 받으므로, 그 읽기로는 송신 시한을 넘겨 닫은 시작의 창이 열릴 수 있다. 연결 서버와 TLS 수락은 받은 값을 그대로 판정에 쓴다(`NaN`이면 기한·인증서 기간 비교가 모두 거짓이다). 소비자 쪽 검사는 이 PR 밖이다.
- **복원 중에는 종료·조회도 나가지 않는다.** 복원이 오래 걸리면(실패해 되풀이하면) 그동안 취소가 실행기에 닿지 않는다.
- **끊김 박자가 실패한 박자에도 수명 박자는 돈다.** 끊긴 실행기를 옮기지 못한 채 수명 박자가 돌 수 있고, 그 실행기의 갱신은 연결 포트(`mayIssue`)만이 막는다.
- **다시 읽기는 관측까지다.** 결과 밖의 실행·대기 부탁을 대조해 고치는 일은 하지 않는다(다음 박자의 박자 함수가 처음에 다시 읽는다). 보고를 받는 곳이 아직 없다.
- **`unsentRenews`가 비어 있지 않은 동안 박자마다 실행 목록 전체를 한 번 더 읽는다.**
