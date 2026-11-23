# 박자 순서기 (`cycle.ts`)

감독 순환의 한 박자를 차례대로 부르는 자리다. 한 박자에 연결 서버의 `tick()`과 박자 넷(끊김 `linkLossTick` → 수명 `lifeTick` → 재전송 `resendTick` → 배정·시작 `assignAndStartTick`)을 한 번씩 부르고, 박자 사이의 기억 넷(`watch`, `lastQueries`, `lastResends`, `unsentRenews`)을 쥐었다가 다음 박자에 넘긴다. **박자의 결과를 바꾸거나 다시 해석하지 않는다.** 결과의 정해진 칸을 기억으로 옮기고, 멈췄거나 적혔는지 모르는 결과 뒤에 장부를 다시 읽는 것만 한다.

박자 함수·서버 tick·장부 읽기·시계 둘·복원 끝 여부는 포트로 받는다. 시계·난수·타이머를 직접 부르지 않는다(시험이 소스를 읽어 지킨다). 박자를 언제 부를지(주기)는 부르는 쪽이 정한다. 이 순서기를 부르는 곳은 아직 없다. 실제 서버·포트·장부를 묶어 넘기는 것은 진입점 조각이다.

## 공개 면

```ts
createCycle(deps: CycleDeps): Cycle      // 정책이 범위 밖이면 CyclePolicyError(field)를 던진다

CycleDeps = {
  beats: CycleBeats
  serverTick: () => void                 // 연결 서버의 tick()
  ledgerClock: Clock                     // 장부에 주입한 그 시계
  monotonic: MonotonicClock              // 끊긴 시간만 재는 단조 시계
  restoreDone: () => boolean             // 지금 장부의 복원이 5단계까지 끝났는가
  ledger: Pick<Ledger, "listRuns" | "instructionTimes" | "unansweredInstructions">
  policy: { judgeMs, resendEveryMs, assignCallsPerBeat }
  observe?: (report: BeatReport) => void // 동기 기록기. 던져도 박자에 영향이 없다
}

CycleBeats = {
  linkLoss(clocks: { clock, monotonic }, policy: LinkLossPolicy, input: LinkLossTickInput): LinkLossTickResult
  life(clock: Clock, input: LifeTickInput): Promise<LifeTickResult>
  resend(clock: Clock, policy: ResendPolicy, input: ResendTickInput): Promise<ResendTickResult>
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
      linkLoss: Step, life: Step, resend: Step, assign: Step[], rereads: Reread[] }

Step = { kind: "returned", result } | { kind: "threw" } | { kind: "skipped", reason: "restore_not_done" | "issuance_closed" | "clock_untrusted" }
```

`CycleBeats`는 실제 박자 함수에 포트를 묶은 것이다. 시계와 끊김·재전송의 정책은 순서기가 넘기는 값을 그대로 포트에 넣는다(시험이 실제 박자 넷을 이 꼴로 묶는 형 검사를 한다):

```ts
linkLoss: (clocks, policy, input) => linkLossTick({ ...linkLossPorts, ...clocks }, policy, input)
life:     (clock, input) => lifeTick({ ...lifePorts, clock }, lifecyclePolicy, input)
resend:   (clock, policy, input) => resendTick({ ...resendPorts, clock }, policy, input)
assign:   (now) => assignAndStartTick(assignPorts, assignPolicy, now)
```

## 한 박자의 차례

1. **서버 `tick()`.** 복원 전에도, 시계를 믿을 수 없어도 부른다. 던지면 `serverTick: "threw"`이고 박자는 이어진다.
2. **박자 처음의 장부 시계.** 아래 "시계"의 하한으로 읽는다. `ok`가 아니면 이 박자의 재전송·배정을 부르지 않는다.
3. **끊김.** 복원이 끝났고 깃발이 서지 않았을 때만.
4. **수명.** 같은 조건. 부르기 전에 `unsentRenews`가 비어 있지 않으면 실행 목록을 읽어 뺄 것을 뺀다.
5. **재전송.** 같은 조건과 박자 처음의 시계가 `ok`일 때.
6. **배정·시작.** 같은 조건. 부르기 직전에 장부 시계를 다시 읽어 `now`로 넘긴다. 결과에 `assigned`가 있고 멈추지 않았으면 같은 박자에서 다시 부른다(처음 포함 `assignCallsPerBeat`번까지).

박자마다 부르기 직전에 복원 끝 여부와 깃발을 다시 본다. **한 번 막히면 그 박자의 남은 박자도 같은 이유로 막힌다.** 박자 하나가 던지거나 멈춰도 그 박자의 남은 박자는 그대로 돈다(아래 "멈춘 박자").

### 차례의 근거

- **서버 tick이 먼저다.** 서버에는 타이머가 없다. hello 대기(`hello_late`), 복원기가 바뀐 연결(`restore_changed`), 넘긴 답의 기한은 `tick()`이 불려야 닫힌다(`transport/server.md` "뒤 조각이 지켜야 할 것"). 먼저 불러야 같은 박자의 끊김 박자가 닫힌 연결을 반영한 연결 표를 본다. 박자 주기가 "기한 뒤에 넘긴 답이 나갈 수 있는 틈"의 길이다.
- **끊김 → 수명.** 정해진 차례다(`dispatch/link-loss.md` "뒤 조각이 지킬 것"). 옮긴 실행에는 장부가 갱신을 거절하므로 끊겼다고 판정한 실행기의 실행에 갱신이 적히기 전에 옮긴다. 끊김 박자는 동기라 돌아온 뒤에 수명 박자를 부른다.
- **수명 → 재전송.** 갱신이 시간에 가장 민감하다. 갱신을 낼 수 있는 구간은 기본값에서 7000ms이고(`dispatch/life-loop.md` "박자를 되풀이해 부른다"), 재전송·배정은 내보내기 포트를 기다리므로 그 뒤에 두면 갱신이 늦어진다.
- **재전송 → 배정.** 새 일(배정·시작)은 이미 진 일(갱신·종료·재전송)을 내보낸 뒤에 연다. 배정 박자의 시작 판단은 박자 처음의 읽기로 하므로 앞 박자들의 쓰기를 본 뒤가 안전하다. 끝에 두면 배정의 되풀이가 다른 박자를 미루지 않는다.
- **D-90 닫기 박자의 자리는 재전송 뒤, 배정 앞이다.** 재전송의 `start_expired`를 재료로 쓰고, 닫아 푼 자리를 같은 박자의 배정이 쓸 수 있다. 이 PR에는 그 박자가 없다.

## 정한 것

1. **겹친 `beat()`는 기다리지 않고 거절한다**(`skipped`/`beat_in_progress`, 아무 박자도 부르지 않는다). 박자 안의 포트(서버 tick, 끊김 박자의 포트 등)에서 다시 부른 것도 같다. 기다리게 하면 박자 안에서 다시 부른 호출이 자기 박자를 기다려 끝나지 않고, 주기로 부르는 쪽은 밀린 박자를 쌓을 이유가 없다. 거절은 약속을 만들기 전의 동기 깃발로 가르므로 동기 구간의 재진입도 잡는다.
2. **복원 전에는 박자 넷을 모두 부르지 않는다.** 정해진 것은 끊김 박자뿐이다(`link-loss.md` "실패한 장부는 다시 열어 복원하고"). 나머지도 막은 이유: 복원은 단계마다 장부를 바꾸고(3단계가 진행 중 실행을 `unknown_running`으로 옮김) 박자의 다시 읽기는 그런 겹침을 분석하지 않았다. 배정·시작은 접수가 5단계 뒤에 열려 어차피 돌지 않는다. 대가는 취소·기한의 종료와 조회가 복원이 끝날 때까지 미뤄지는 것이다. 끊김 박자 없이 수명 박자만 도는 박자를 만들지 않으려고 막힘은 그 박자 끝까지 이어진다.
3. **끊김 박자가 `not_run`이거나 던져도 수명 박자는 돈다.** 수명 박자는 갱신 직전에 그 실행기의 연결을 `mayIssue`로 따로 본다. 끊김 박자의 읽기 실패마다 수명 박자를 막으면 모든 실행기의 갱신이 멈춰 살아 있는 일이 임대 끝에서 닫힌다.
4. **시계 하한은 박자에 넘기는 시계를 감싸 둔다.** 이 프로세스에서 장부 시계로 읽은 가장 늦은 값보다 이른 값은 던진다(같은 값은 받는다). 박자들은 던지는 시계를 "읽지 못함"으로 다룬다(끊김·수명·재전송은 `clock_unavailable`, 배정은 `now`를 받지 못해 불리지 않는다). 박자 처음의 읽기가 후퇴나 읽지 못함이면 그 박자의 **재전송 전체**와 배정을 부르지 않는다. 재전송에서 시작만 골라 막을 자리가 순서기에 없어 취소·확정의 재전송도 한 박자 미뤄진다. 끊김 박자의 단조 시계도 같은 하한을 둔다.
5. **기억을 줄이는 때.** `lastQueries`는 수명 결과가 완결(`halted: null`)일 때 그 목록에 없는 실행을 뺀다(끝난 실행은 목록에 없다). `lastResends`는 재전송 결과가 완결일 때 읽기에서 사라진 요청 ID를 뺀다(`resend.md` "뒤 조각이 지킬 것"). 멈춘 결과로는 줄이지 않는다. 같은 키의 시각은 늦은 쪽을 남긴다(다음 조회·재전송을 앞당기지 않는 쪽).
6. **`noteCandidate`는 작업자 실행기 이름만 받는다.** 끊김 박자는 기억에 작업자 실행기가 아닌 이름이 하나라도 있으면 기억 전체를 `input_malformed`로 거절하므로, 다른 이름을 넣으면 그 뒤 끊김 박자가 영영 돌지 않는다. 끊김 박자를 부르는 동안 더해진 이름은 결과 `watch`로 바꾼 뒤 다시 더한다(결과가 덮어 지우지 않게. 연결을 본 기록이라 판정을 늦추는 쪽이다).
7. **배정 되풀이의 상한은 `ASSIGN_CALLS_MAX`(8)다.** 되풀이하는 동안 수명 박자가 돌지 않으므로 박자 하나가 갱신 구간을 다 쓰지 않게 묶는다. 운영 값은 정하지 않았다.
8. **기억은 이 객체의 메모리에만 있다.** 감독이 다시 뜨면 새 객체가 빈 기억으로 시작한다. `watch`의 시각은 프로세스마다 기점이 다른 단조 시각이라 옮기면 안 되고, 나머지 셋은 비었을 때의 동작이 각 박자 문서에 정해져 있다(곧바로 묻기, 발행 시각부터 간격, 복원 3단계의 `unknown_running` 전이).

## 기억 넷

| 기억 | 넣는 것 | 빼는 것 | 원문 |
|---|---|---|---|
| `watch` | 끊김 결과가 `ran`이면 `halted`여도 결과의 `watch`로 바꾼다. `not_run`·던짐이면 앞 것을 쥔다. `noteCandidate`가 `{ 이름, absentSince: null }`을 더한다 | 결과가 바꿀 때만 | `link-loss.md` "뒤 조각이 지킬 것" |
| `lastQueries` | 수명 결과의 `query_sent`와 `delivery: "unknown"`인 `query_not_sent`의 `{ runId, at }` | 완결된 결과에 없는 실행 | `life-loop.md` "조회", "뒤 조각이 지킬 것" |
| `lastResends` | 재전송 결과의 `resent`와 `delivery: "unknown"`인 `not_sent`의 `{ requestId, at }`(`sealedAt`이 아니다) | 완결된 결과에 없는 요청 ID | `resend.md` "두드리지 않기", "뒤 조각이 지킬 것" |
| `unsentRenews` | 수명 결과의 `renew_recorded_not_sent`(어느 `delivery`든)와 `renew_record_unknown`의 실행 ID | 장부의 실행 목록에서 그 실행이 `preparing`·`running`이 아님을 확인했을 때만. 결과 목록에서 사라진 것, 읽지 못한 것, 목록에 없는 것으로는 빼지 않는다 | `life-loop.md` "싣지 못한 갱신" |

박자에는 기억의 사본을 넘긴다. 박자가 넘겨받은 배열을 고쳐도 순서기의 기억은 바뀌지 않는다.

## 멈춘 박자

순서기는 장부를 다시 읽고 그 결과를 보고(`rereads`)에 싣는다. 다음 박자의 재료는 각 박자가 처음에 다시 읽으므로, 순서기가 다시 읽는 것은 "쓰기가 없었다고 가정하지 않음"을 관측에 남기고 `unsentRenews`를 확인하기 위해서다.

| 무엇 | 순서기가 하는 것 |
|---|---|
| 박자 함수가 던짐(`threw`) | 실행 목록(`listRuns`)을 다시 읽는다. 그 박자의 기억은 앞 것을 쥔다. 남은 박자는 돈다 |
| `ran`이고 `halted`가 있음(끊김·수명·재전송의 `threw`, 배정의 `threw`) | 실행 목록을 다시 읽는다. 결과의 기억 칸은 반영한다(완결이 아니어서 줄이지는 않는다). 배정이면 되풀이하지 않는다 |
| 끊김의 `ledger_failed`가 `threw`·`malformed_answer` | 실행 목록을 다시 읽는다. 장부의 거절 이름이면 다시 읽지 않는다(기억의 `absentSince`가 남아 다음 박자가 다시 부른다) |
| 수명의 `renew_record_unknown` | `instructionTimes(runId)`의 `renewIssued.issuedAt`이 결과의 `issuedAt`과 같은지(`found`). 실행 ID는 `unsentRenews`에 넣는다 |
| 수명의 `stop_record_unknown` | `unansweredInstructions()`에 그 요청 ID가 있는지(`found`). 답을 받은 지시는 없으므로 `false`가 "적히지 않음"은 아니다 |

다시 읽기를 읽지 못하면 `known: false`·`found: null`이다. 다음 박자는 평소대로 돈다.

## 발급 닫기

`closeIssuance()`는 깃발을 곧(첫 `await` 전에) 세우고 진행 중인 박자가 돌아오기를 기다린다. 깃발 뒤에는:

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
| C3 | 복원이 끝나기 전에는 끊김 박자를 부르지 않는다 | `gate()`가 박자마다 `restoreDone()`을 다시 봄(던지면 끝나지 않음) | 복원 전 | `link-loss.md` "실패한 장부는 다시 열어 복원하고" |
| C4 | 장부와 같은 시계, 박자 사이에 후퇴하지 않게. 믿을 수 없으면 시작 재전송 보류 | 하한을 씌운 `clock`, 박자 처음의 `readNow()`로 재전송·배정 보류, 배정 직전의 다시 읽기 | 시계 | `resend.md` "박자 사이에도 시계가 뒤로 가지 않게", `assign-loop.md` "`now`는 장부 시계와 같은 시계" |
| C5 | 끊김 박자의 단조 시계는 벽시계와 따로, 재기동하면 기억을 비움 | `monotonic`을 끊김 박자에만, 같은 하한. 기억은 객체 메모리 | 단조 시계 | `link-loss.md` "`monotonic`은 한 프로세스 안에서", "감독이 다시 뜨면 기억을 비운다" |
| C6 | 되풀이 부름: `assigned`면 곧 | 배정 되풀이(상한 `assignCallsPerBeat`) | 차례 | `assign-loop.md` "박자를 되풀이해 부른다" |
| C8 | `watch` 넘기기, `candidate`마다 `null`로 더함 | `takeLinkLoss`, `noteCandidate` | 기억 넷 | `link-loss.md` "`watch`를 넘긴다", "`candidate`를 낼 때" |
| C9 | `unsentRenews`는 장부 상태를 확인한 뒤에만 뺌 | `takeLife`(넣기), `pruneUnsent`(빼기) | 기억 넷 | `life-loop.md` "싣지 못한 갱신" |
| C10 | `lastQueries`·`lastResends`는 결과의 `at` | `takeLife`, `takeResend` | 기억 넷 | `life-loop.md` "`lastQueries`를 넘긴다", `resend.md` "`lastResends`를 넘긴다" |
| C12 | `halted`를 본다, 예외로 끝나도 쓰기 0을 가정하지 않음 | `rereadRuns`(네 박자 모두) | 멈춘 박자와 던진 박자 | `assign-loop.md`·`life-loop.md`·`resend.md` "`halted`를 본다" |
| C13 | `*_record_unknown`은 장부를 다시 읽어 가림 | `rereadRenew`, `rereadStop` | 멈춘 박자와 던진 박자 | `life-loop.md` "`halted`를 본다" |
| C14 | 끊김의 `ledger_failed`는 다음 박자에, `threw`·`malformed_answer`·`halted`면 다시 읽기 | 끊김 블록의 다시 읽기 갈래 | 멈춘 박자와 던진 박자 | `link-loss.md` "`ledger_failed`면" |
| C26 | 시작을 다시 내려면 `resendEveryMs <= 19000` | `readPolicy`(`START_LAST_SEAL_MS` 이하만) | 정책 검사 | `resend.md` "간격을 정한다" |
| C36 | 서버를 닫기 시작하면 새 발급을 먼저 막음(깃발과 기다림까지) | `closeIssuance`, `gate()`의 깃발, `issuanceOpen` | 발급 닫기 | `transport/server.md`, `runtime/sink.md` "뒤 조각이 지켜야 할 것" |
| C41 | `server.tick()`을 박자마다 | 박자 처음의 `serverTick()` | 차례, 복원 전 | `transport/server.md` "`tick()`을 박자마다 부른다" |
| C61 | 판정 시간은 정책으로, `RUN_LEASE_MAX_MS` 이상 | `readPolicy` | 정책 검사 | `link-loss.md` "판정 시간은 정책으로 넘긴다" |

정책은 만들 때 한 번 검사하고 얼려 둔 사본을 쓴다. 넘긴 정책 객체를 나중에 바꿔도 따르지 않는다(시험이 본다).

**일부만 지킨 것:** C4의 "재기동을 걸친 비후퇴"와 C6의 "갱신 구간 7000ms 안에서 여러 번"은 이 순서기 밖이다(아래).

## 뒤 조각이 지킬 것

- **진입점(N5): 같은 객체를 넘긴다.** 박자 넷의 포트, 순서기의 `ledger`, 서버, 내보내기 포트가 같은 장부 객체·같은 복원기 게시 함수·같은 시계를 쓴다. `ledgerClock`은 장부에 주입한 그 시계다. 장부가 안에서 읽는 시계는 순서기의 하한을 거치지 않는다.
- **진입점(N5): 박자 함수를 이 순서기로만 부른다.** 박자를 따로 부르는 다른 경로가 있으면 직렬화가 깨진다. 같은 장부는 한 프로세스만 연다. 순서기는 프로세스마다 하나다.
- **진입점(N5): 주기로 `beat()`를 부른다.** 이 모듈에는 타이머가 없다. 수명 박자가 갱신 구간(기본 7000ms) 안에서 여러 번 돌 만큼 짧게 부른다. `beat_in_progress`로 거절된 호출은 버려도 된다. 보고(`observe`)의 `threw`·`rereads`·`clock`을 관리자 경보로 잇는 것도 진입점이 정한다.
- **진입점(N5): 장부를 다시 열고 복원하는 동안 `restoreDone()`이 `false`다.** 순서기는 복원을 돌리지 않는다. 다시 연 뒤에도 같은 순서기를 쓴다면 박자 함수의 묶음은 지금의 장부·복원기를 가리켜야 한다(옛 객체를 붙들지 않는다). 기억은 같은 프로세스 안에서는 이어도 된다.
- **재기동을 걸친 시계 비후퇴는 이 PR 밖이다.** 하한은 메모리에만 있다. 장부의 마지막 기록 시각을 하한으로 읽을지는 정하지 않았다.
- **답 줄과 연결 잇기(N4a2):** 연결 서버의 `candidate` 사건마다 `noteCandidate(주체 이름)`을 부른다. 수명 결과의 `pendingQueries`를 영수증 처리기에 넘기는 것과 조회 등록부는 그 조각이다(순서기는 넘기지 않는다). `not_rebuildable`·`stop_generation_mismatch` 뒤의 조회도 그 쪽이다.
- **자격 값과 종료 순서(N4a3):** 내보내기 포트와 자격 값 보내기의 `lastCheck`가 `issuanceOpen()`을 보게 하고, `closeIssuance()`가 돌아온 뒤에 `server.close()`를 부른다. 그 전까지 진행 중이던 박자 함수 안의 발급은 포트가 막지 않는다.
- **D-90 닫기 박자(A6c):** 재전송 뒤, 배정 앞에 끼운다. `CycleBeats`에 박자 하나를 더하고 같은 막힘(복원·깃발·시계)을 건다. 재전송이 시작을 보류한 박자(`clock_untrusted`)에는 시간 판정도 보류한다.
- **재전송의 보류 사유가 늘어도 순서기는 바뀌지 않는다.** `resent`와 `delivery: "unknown"`인 `not_sent`만 기억으로 옮기고 다른 갈래는 그대로 보고에 싣는다.

## 남는 한계

- **진행 중인 박자 함수는 멈추지 못한다.** 깃발 뒤에도 지금 부르고 있는 박자 함수 안의 발급은 나갈 수 있다. 포트 쪽 차단이 붙을 때까지 남는다.
- **박자 처음의 시계 후퇴는 재전송 전체를 미룬다.** 취소·확정의 재전송도 한 박자 늦어진다.
- **복원 중에는 종료·조회도 나가지 않는다.** 복원이 오래 걸리면(실패해 되풀이하면) 그동안 취소가 실행기에 닿지 않는다.
- **끊김 박자가 실패한 박자에도 수명 박자는 돈다.** 끊긴 실행기를 옮기지 못한 채 수명 박자가 돌 수 있고, 그 실행기의 갱신은 연결 포트(`mayIssue`)만이 막는다.
- **다시 읽기는 관측까지다.** 결과 밖의 실행을 대조해 고치는 일은 하지 않는다(다음 박자의 박자 함수가 처음에 다시 읽는다). 보고를 받는 곳이 아직 없다.
- **`unsentRenews`가 비어 있지 않은 동안 박자마다 실행 목록 전체를 한 번 더 읽는다.**
