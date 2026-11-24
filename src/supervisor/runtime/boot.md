# 감독 조립(boot.ts)

감독 프로세스 하나를 띄우고 끝내는 조립이다. 진입점(`src/main/supervisor.ts`)이 환경을 값으로 바꾸고 실제 파일 읽기·장부 열기·서버 시작·시계·타이머·CSPRNG를 포트로 넘긴다. 이 모듈은 환경을 읽지 않고 시계·타이머·난수를 직접 부르지 않는다. 기동 순서·종료 코드·환경 표·기다림 표는 README "감독 진입점"이 기준이고 이 문서는 조건과 코드 자리, 효과와 그 직전 확인을 적는다.

```ts
bootSupervisor(settings: SupervisorSettings, deps: SupervisorDeps, signal: AbortSignal): Promise<BootResult>
BootResult = { ok: true; running: RunningSupervisor } | { ok: false; step; code: 0 | 91..96; reason }   // 96은 서버를 연 뒤 기동 중 신호의 끝 차례가 실패했을 때뿐
RunningSupervisor = { stop(): Promise<number>; done: Promise<number>; tools(policy, config, observe) }   // done은 0 또는 96
waitUntil(work, limit, { monoNow, setTimer }, signal?): Promise<Waited<T>>   // done | failed | lapsed | unarmed | aborted
SUPERVISOR_EXIT = { config: 91, material: 92, registry: 93, ledger: 94, server: 95, fatal: 96, uncaught: 97 }
```

함께 쓰는 두 파일: `peers.ts`(복원 2단계의 `PeersPort`), `signer.ts`(감독 서명 키 하나로 `Signer`와 `ReplyTools`).

## 정한 것

1. **프로세스 하나 = 장부 열기 하나 = 공유 시계 하나 = 복원기 하나 = 서버 하나 = 순서기 하나.** 프로세스 안에서 다시 열지 않는다. 장부를 쓸 수 없게 되거나, 낸 접수 허가가 버려지거나, 박자·복원 단계가 기한을 넘기거나 거부되면 끝 차례를 밟고 96으로 끝내 Kubernetes 재시작에 맡긴다.
2. **연결 전에 거를 값은 서버 시작 전에 거른다.** 재료(92), 등록표(93), 장부·결과 폴더·복원기(94), 순서기 정책(95)이 모두 `deps.startServer` 앞이다. 순서기를 서버보다 먼저 만드는 까닭이 이것이다(박자 다섯과 서버 tick은 부를 때 아래 객체에 위임한다).
3. **답 줄이 서기 전에는 받지 않는다.** 서버의 `deliver`는 7단계의 같은 동기 구간에서 답 줄로 바뀌고, 그 전에 불리면 던져 그 연결을 닫는다. 복원 1단계 전이라 맞춤에 답하지 않으므로 실제로는 오지 않는다(루프백 시험이 맞춤 답 0, `deliver` 0을 본다).
4. **받아들인 복원 단계만 센다.** `stage`는 조립이 단계 결과를 기한 안에 받아들인 때 오른다. 순서기의 `restoreDone`은 5단계를 받아들였고 박자 유효 문(8)이 열렸을 때만 참이다. 답 줄의 `observationsSettled`는 2 이상일 때 참이고, 그 문이 가르는 것은 쌓아 둔 **인사·상태 관측**뿐이다: 검증된 기존 실행의 영수증·보고는 2단계 전에도 바로 장부로 가고 수락한 영수증의 ACK도 나간다(종료 영수증을 제때 적어 실행기가 끝을 확인받게). 복원기 게시 함수는 늘 같은 복원기를 내므로 게시 교체가 `deliver`·`pump` 안에서 일어날 수 없다.
5. **모름이면 같은 복원기로 같은 단계를 다시 부른다.** `RestoreStepError`(현관 없음 등)는 다음 주기에 같은 단계를 부른다. 재시작하지 않는다: 현관이 없는 동안 되풀이 재기동이 생기지 않게. 다른 실패(순서 오류, 기한 넘김, 타이머 없음)는 96이다.
6. **5단계가 처음부터 닫힌 판정이면 닫힌 채 돈다.** `intakeMayOpen: false`(정지, 이웃 미확인 등)면 끝내지 않는다. 박자는 돌아야 기존 실행에 **정지 지시와 상태 조회가** 닿는다(새 접수·시작·갱신·자격 값은 복원기의 접수 문이 막는다). 다시 여는 것은 재시작(새 복원기)이다. 끝내는 것은 **받아들인 허가가 그 뒤에 버려졌을 때**(`granted && !restorer.intakeOpen()`)와 **받아들이지 않은 허가가 장부에 있을 때**(`!granted && restorer.intakeOpen()`, 기한을 넘겨 끝난 5단계)다. 재시작 뒤 같은 사유(정지)가 남아 있으면 그 5단계는 닫힌 판정이라 닫힌 채 돈다(되풀이 재기동이 생기지 않는다).
7. **기다림마다 부르기 전에 정한 기한.** 일을 함수로 받아 부르기 전에 절대 기한을 정하고(`deadline` → `runBy`), 결과를 받아들이는 순간의 단조 시각으로 판정한다(`waitUntil`의 `accept`). 일의 동기 비용도 기한 안에 든다. 정각 이후면 타이머보다 먼저 처리된 결과여도 만료다. 시각을 읽지 못하면 기한이 지난 것으로 본다. 복원 단계의 현관 답은 복원기에 넘기기 전에 그 단계의 기한 하나를 본다(`inStep`): 정각 이후의 답은 복원기에 모름(거부)으로 가서 장부에 반영되지 않고, 4단계의 여러 게시도 각자 새 기한을 얻지 않는다. 표는 README "기한이 있는 기다림".
8. **효과의 문 둘.** 박자 유효 문(`effectsOpen`): 끝 코드 → 장부 건강·허가 읽기(`judge`) → 진행 중인 박자의 절대 기한(`beatLimit`) 비교의 차례로 보고, 하나라도 걸리면 닫힘이다. 시각을 맨 끝에 보아 장부 건강·허가 읽기에 쓴 시간까지 기한 비교에 든다. 끝낼 사유(`haltReason`: 장부를 쓸 수 없음, 받아들인 허가 폐기, 받아들이지 않은 허가, 허가를 읽지 못함)는 **처음 본 것을 붙잡는다**: 박자 안의 문이 한 번 본 사유(허가 읽기 한 번의 예외 포함)는 다음 읽기가 정상이어도 풀리지 않고, 문은 닫힌 채이며 주기가 그 사유로 96을 낸다. 붙잡지 않는 닫힘은 하나다: 5단계를 불렀고 그 결과를 아직 받지 않았을 때(`restoring`) 장부에 이미 있는 허가. 5단계는 첫 호출 안에서 동기로 허가를 내고 결과는 그 뒤에 받으므로 그 사이의 읽기(같은 동기 구간의 서버 tick 등)가 이 상태를 본다. 결과를 기한 안에 받지 못하면 복원 단계의 기한이 96으로 끝낸다. 박자 유효 문은 읽기만 한다(답 줄·증거·연결·장부를 바꾸지 않는다): D-90 박자가 마지막 증거 확인(`confirm`) 뒤에 이 문을 부르므로 그 조건이다(`boot-effects.test.ts` "읽기만 한다"). 접수 문(`intake`): 박자 유효 문과 **같은 판정 하나**(`effects`)에서 `judge`가 읽은 허가를 쓰고 허가를 다시 읽지 않는다. 다시 읽으면 그 둘째 읽기의 예외는 래치 밖이라 배정 박자가 닫힌 접수로만 읽고 감독이 계속 돈다(`boot-effects.test.ts` "접수 문은 허가를 한 번만 읽는다"). 치명 기록(`fatal`)은 처음 코드를 정할 때 이미 붙잡은 사유가 있으면 그것을 `reason`으로, 나중에 온 이름(박자 기한 넘김 등)을 `later`로 적는다: 사유를 붙잡은 박자가 뒤이어 기한을 넘겨도 먼저 생긴 원인이 기록에 남는다. `fatal`은 한 번만 적고, 적었는지는 끝 코드(96)가 아니라 따로 둔 깃발로 가른다: 명시적 정지(`stop()`)는 코드를 정하지 않으므로, 끝 차례에서 서버 닫기가 실패해 96이 먼저 정해져도 붙잡은 사유를 `fatal.reason`에 적고 닫기 실패는 `shutdown_incomplete`(`failed`)로 따로 남긴다. 기존 실행의 정리(종료·상태 조회·끊김·D-90·재전송의 송신)는 박자 유효 문만, 새 일(접수·시작·갱신·자격 값)은 접수 문을 본다. 박자 다섯은 장부 쓰기 직전에 박자 유효 문을 다시 본다(`beatValid` 포트, 아래 표). 주기는 같은 `haltReason`을 박자 전과 `pump` 바로 앞에서 보고, 끝 차례는 장부를 닫기 전에 본다: 멈춤 요청이 먼저 왔어도 이미 생긴 고장·폐기·박자 실패는 96이다. 허가를 읽다 던지면 `intake_unreadable`이다: 처음부터 닫힌 판정은 기존 실행의 정리를 허락하지만, 허가가 있는지 모르는 것은 끝낸다.

## 효과와 그 직전 확인

자리는 `boot.ts`의 기호 이름이고(줄 번호는 코드가 바뀌면 어긋나 적지 않는다), 박자 안은 각 부품(`src/supervisor/dispatch/`)이다. 문은 (1) 접수 문 `intake` = (2)와 같은 판정(`effects`)에서 읽은 허가, (2) 박자 유효 문 `effectsOpen`이다. 박자 다섯의 `beatValid` 포트에는 (2) 그 함수 하나를 넘긴다(`beats`·`assignPorts`). 그 포트가 빠지면 부품은 늘 유효로 읽으므로 `boot-effects.test.ts`가 다섯 박자의 같은 함수를 단언한다. 처음부터 닫힌 5단계(`granted`도 장부 허가도 없음)는 (2)가 열림이라 기존 실행의 정지·상태 조회가 나간다.

규칙은 하나다: **장부 쓰기·송신 표식·송신마다 얻을 것(포트의 수신 객체·메서드·인자, 공유 송신 함수에 넘기는 입력 객체의 칸)을 모두 얻고, 박자 유효 문을 마지막에 보고, 그 바로 뒤에 호출 하나.** 예외는 시작·갱신의 송신 하나다: 유효 문과 송신 사이에 시한·여유를 재는 장부 시계 호출 하나가 남는다(아래 "남는 한계"). 유효 문 뒤에 접근자 같은 외부 코드가 돌면 그 안에서 흐른 시간으로 박자 기한이 지나도 쓰거나 싣는다. "사이"는 마지막 확인(시계·연결·증거 등)과 효과 사이의 외부 호출, "유효 문 뒤"는 박자 유효 문을 본 뒤 호출 전에 도는 외부 코드(접근자 포함)다. 박자 안의 장부 쓰기·표식은 이 차례를 `send-gate.ts`의 `callAfterGate` 한 함수로 한다(얻기·인자 원소를 함수 안 배열로 옮기기 → 유효 문 → `Reflect.apply`). 유효 문은 장부 쓰기마다 `holdBeatValid`로 포트의 칸을 한 번 읽어 그 포트 묶음을 수신자로 부른다(같은 칸을 두 번 읽지 않는다). 정적 시험(`test/supervisor/dispatch/start-send.test.ts`)이 그 본문과 부르는 줄 일곱(장부 쓰기 여섯·송신 표식 하나)을 글자 그대로 본다. 아래 표에서 "유효 문 뒤"가 "없음"이 아닌 자리는 박자 밖이거나 내보내기 포트 안, 또는 시작·갱신의 마지막 판정이 부르는 장부 시계 호출 하나다.

| 효과 | 자리(확인 → 효과) | 직전에 읽는 문 | 사이 | 유효 문 뒤·호출 전에 도는 외부 코드(접근자 포함) | 기한이 정해지는 때 |
|---|---|---|---|---|---|
| 박자 다섯 부르기 | 순서기의 `gate()`가 박자마다 `restoreDone` | `stage >= 5 && (2)` | 없음(순서기가 인자를 확인 전에 만든다) | 없음(만들 때 쥔 박자 함수를 `Reflect.apply`로 부른다) | 박자를 부르기 전(주기 `loop`의 `beatLimit`). 시각을 읽지 못하면 박자를 부르지 않고 96 |
| 끊김: `markLostFor` | `link-loss.ts`의 인자(`lostInput`) → `callAfterGate`(장부 포트 객체·`markLostFor` 얻기 → (2) → `Reflect.apply`), 실행기마다 | (2) | 없음 | 없음 | 박자 기한 |
| 수명: 갱신 기록 | `life-loop.ts`의 (1) → 연결 문 → 시계 → 인자(`renewInput`) → `callAfterGate`(장부 포트 객체·`recordRenewInstruction` → (2) → 호출) | (1) 뒤 (2) | 없음 | 없음 | 박자 기한 |
| 수명: 종료 기록 | `life-loop.ts`의 시계 → 인자(`stopInput`) → `callAfterGate`(장부 포트 객체·`recordStopInstruction` → (2) → 호출) | (2)만(닫힌 접수에서도 종료는 적는다) | 없음 | 없음 | 박자 기한 |
| 수명: 확정 기록 | `life-loop.ts`의 결과 보관 다시 읽기(`settledResult`) → (1) → 시계 → 인자(`finalizeInput`) → `callAfterGate`(장부 포트 객체·`recordFinalizeInstruction` → (2) → 호출) | (1) 뒤 (2) | 없음 | 없음 | 박자 기한 |
| 수명: 갱신·종료·확정·조회 송신 | 갱신은 `life-loop.ts`의 시계 함수 쥐기 → `deliver`(마지막 여유 판정 `plainCheck`를 넘김), 종료·확정·조회는 `deliver` → `sendInstruction`(`send-gate.ts`: 칸 쥐기(`readEnvelope`의 봉투 데이터 사본, `holder.sink`·`send`, `holdBeatValid`, `plain`의 두 칸) → `if (!gate())` (2) → 갱신이면 `verdictOf`의 여유 판정(장부 시계 호출) → 마지막 줄의 `Reflect.apply(send, target, …)`) → 내보내기 포트의 `lastCheck` | (2), 그 뒤 포트 맨 앞의 발급 깃발 = 순서기 깃발 `&&` (2) | 갱신: (2) 뒤 장부 시계 호출 하나(남는 한계). 종료·확정·조회: 없음 | 갱신은 그 장부 시계 호출. 모두 포트 안에서 깃발 뒤 서버의 인정 재확인·`finalCheck`(아래 "실행기로의 송신") | 박자 기한 |
| 재전송: 시작의 송신 표식 | `resend.ts`의 (1) → 연결 문·시계·봉하기 → 시계 함수 쥐기 → 공유 함수 → `send-gate.ts`의 `sendInstruction`: 칸 쥐기(`readEnvelope`의 봉투 데이터 사본, `holder.sink`·`send`, `holdBeatValid`, `holdStart`의 `start` 칸) → `const marking = callAfterGate(`(쥔 표식 포트·`markStartDispatch` → (2) → 호출) | (1) 뒤 (2) | 입력의 칸 쥐기(포트 호출·await 없음). 표식 뒤 마지막 판정(`if (!gate())` (2) → `verdictOf`의 시한 확인)이 막으면 표식만 남고 싣지 않는다 | 없음 | 박자 기한 |
| 재전송: 송신(시작·취소·확정) | `send-gate.ts`의 `if (!gate())` (2) → (시작이면 `verdictOf`가 부르는 `lastCheck`: 시작 시한의 장부 시계 호출 1회) → 마지막 줄의 `Reflect.apply(send, target, …)` | (2). 시작은 (2) 뒤 마지막 확인 | 시작: (2) 뒤 장부 시계 호출 하나(남는 한계). 취소·확정: 없음(`lastCheck`·`plain` 없음) | 시작은 그 장부 시계 호출. 수신 객체·`send`·`start`의 칸은 칸 쥐기에서 미리 쥐었다. 포트 안은 아래 "실행기로의 송신" | 박자 기한 |
| 배정: 시작의 송신 | `send-gate.ts`의 `if (!gate())` (2) → 마지막 줄의 `Reflect.apply(send, target, …)` | (2) | 없음: 배정의 `start`에는 `lastCheck`가 없어 표식 뒤 두 번째 (2)와 송신 사이의 장부 시계 호출이 0이다(`assign-loop.ts`의 `sendInstruction` 호출) | 없음. 포트 안은 아래 "실행기로의 송신" | 박자 기한 |
| 배정: 잇기 | `assign-loop.ts`의 (1) → 맡기지 않을 실행기·고르기 → 난수 → 인자(`assignInput`) → `callAfterGate`(장부 포트 객체·`assignToolRequest` → (2) → 호출) | (1) 뒤 (2) | 없음 | 없음 | 박자 기한 |
| 배정: 시작 기록 | `assign-loop.ts`의 (1) → 맡기지 않을 실행기 → 난수 → 인자(`startInput`) → `callAfterGate`(장부 포트 객체·`startRun` → (2) → 호출) | (1) 뒤 (2) | 없음 | 없음 | 박자 기한 |
| 배정: 시작의 송신 표식 | `assign-loop.ts`의 봉하기 → 공유 함수 → `send-gate.ts`의 칸 쥐기 → `const marking = callAfterGate(` | (2) | 재전송과 같음. 막히면 적힌 시작은 표식 없이 남아 재전송이 다룬다 | 없음 | 박자 기한 |
| D-90 닫기 | `unreceived.ts`의 `readGate`(2단계 `&&` (2)) → `confirm` → (2) → `closeUnreceivedRun` | (2) 두 번 | 박자 유효 문 하나(읽기만 한다는 조건, 정한 것 8) | 없음(박자 처음에 쥔 함수·수신자를 `Reflect.apply`로) | 박자 기한 |
| D-90 새 인사: 연결 하나 닫기 | `unreceived.ts`의 `readGate`(2단계 `&&` (2)) → 임대 읽기(장부 `listRuns`·`instructionTimes`) → `confirm` → `rehello.valid`(순서기 발급 깃발 `&&` (2)) → 기억 적기 → `closeConnection` | 발급 깃발 `&&` (2) | 닫기 문 하나(읽기만 한다는 조건, `boot-effects.test.ts` "D-90 박자의 새 인사 포트") | 없음(박자 처음에 쥔 함수·수신자를 `Reflect.apply`로) | 박자 기한 |
| 실행기로의 송신(지시·조회·재전송)·ACK | 내보내기 포트의 `lastCheck`가 맨 앞에서 발급 깃발 | 발급 깃발(`make.issuance`의 `cycle.issuanceOpen`) = 순서기 깃발 `&&` (2) | 서버의 인정 재확인, `finalCheck`(시계로 봉투·작업 시한). 그 뒤 박자 기한은 다시 보지 않는다 | 사이 칸과 같다(뒤 조각, 남는 한계) | 박자 안이면 박자 기한 |
| 자격 값 읽기·송신 | 자격 송신기의 두 문(읽기 앞, `lastCheck`) | 같은 발급 깃발 `&&` 복원기 접수 | 계정 파일 읽기(비동기, 두 번째 문이 다시 본다) | 해당 없음(박자 밖) | 박자 밖(영수증마다) |
| 5단계 허가를 소비자에 보이기 | `kickRestore`의 수락(`granted`) | 단계 결과를 기한 안에 받아들임. 받기 전은 닫힘(붙잡지 않음), 기한 넘김은 `intake_unaccepted` | 없음 | 해당 없음 | 단계를 부르기 전(`kickRestore`의 `stepLimit`) |
| 현관 결과의 장부 반영(1단계 정지 병합, 2단계 이웃, 4단계 게시) | 복원기 안. 조립은 현관 포트를 `inStep`으로 감싼다 | 답을 받은 순간 `pastLimit(stepLimit)`, 정각 이후면 거부(모름) | 없음(거부한 답은 복원기가 장부에 쓰지 않거나 `unknown`으로 적는다) | 해당 없음 | 단계를 부르기 전(`kickRestore`의 `stepLimit`) |
| 답 처리(`pump`) | 주기 `loop`의 `haltReason` → `answerLines.pump()` | `haltReason`. 박자 시간 기록(`beat_time`, 시계·기록 포트)은 그 앞 | 없음 | 해당 없음 | 박자 결과를 받은 뒤 |

## 조건과 코드 자리

조건 번호는 설계 조사의 목록(S1~S49)이다. 원문은 각 부품 문서의 "뒤 조각(N5·진입점·조립)이 지켜야 할 것"이다. 자리는 `boot.ts`의 기호 이름이다.

| 번호 | 조건 | 코드 자리 | 시험(`test/supervisor/runtime/`) |
|---|---|---|---|
| S1 | 원천 시계를 공유 시계로 한 번 감싸 모든 소비자에 | `make.sharedClock`, 장부 `clock: ledgerClock`, 복원기(`make.restorer`의 `ledgerClock`), 순서기 `ledgerClock: shared`, 서버 `clock`, 발급·내보내기 포트·답 줄 `clock: shared`, 박자에는 순서기가 넘긴 시계, 도구 포트(`tools`의 `clock: shared`) | `boot.test.ts` "같은 객체", "공유 시계를 거친다(S1)", "도구 처리기 포트의 자리(S41)" |
| S2 | 장부 한 열기를 박자·순서기·답 줄·결과·발급·송신 표식에 | `const ledger`(한 자리), 박자 다섯과 배정 포트(`beats`·`assignPorts`), 순서기, 발급(`make.issuance`), 답 줄 `ledger`·`results.ledger`(`make.lines`) | "같은 객체", 정적 "한 자리" |
| S3 | 복원기 게시 함수 하나 | `published`를 서버·내보내기 포트·답 줄·발급에, 박자에는 같은 복원기(접수 문은 `intake`가 효과의 문을 더해 감싼다) | "같은 객체" |
| S4 | 서버 하나 | `server = live`, 발급·내보내기 포트의 `server`, 답 줄 `table` | "같은 객체" |
| S5 | 조회 등록부 하나 | `make.queries()`를 내보내기 포트와 답 줄에 | "같은 객체" |
| S6 | 맡기지 않을 실행기 | 내보내기 포트는 답 줄에 위임(`make.sink`의 `withheld`), 배정·D-90 박자는 `lines.withheld` | "같은 객체" |
| S7 | 순서기 하나, 박자는 순서기로만 | `cycle = make.cycle` 한 자리 | 정적 "한 자리" |
| S8 | 내보내기 포트에 `issuanceOpen`을 반드시 | `make.sink`의 `issuanceOpen: issuance.issuanceOpen`. 발급의 깃발은 순서기 깃발에 박자 유효 문을 더한 것(`make.issuance`의 `cycle.issuanceOpen`) | "같은 객체"(빼면 실패, 아래 "일부러 틀리게") |
| S9 | 답 줄의 `credentials`는 발급의 것 | `make.lines`의 `credentials: issuance.credentials` | "같은 객체" |
| S10 | 끝낼 때 `issuance.shutdown()`만, 박자 안에서 기다리지 않음 | `finish`의 한 자리. 치명 판단은 박자가 돌아온 뒤 주기에서만 한다(박자 안의 포트는 끝 차례를 부르지 않는다). 발급을 만든 뒤의 7단계 실패도 `issuance.shutdown()` | "기동과 종료의 차례", "박자 약속의 거부", `boot-effects.test.ts` "조립 실패 뒤 정리", 정적 "한 자리" |
| S11 | `shutdown()`을 부른 시점 기록 | `shutdown_called`(공유 시계의 시각) | 끝 차례 차례 단언 |
| S12 | 발급 `observe`는 동기, 값과 섞지 않음, `maxBytes` ≤ 16,384 | 발급 기록은 이름·결과만(`make.issuance`의 `observe`), `maxBytes`는 진입점의 `CREDENTIAL_MAX_BYTES` | `entry.test.ts` |
| S13 | 주기로 `beat()` | 주기(`loop`) 1초 | "기동과 종료의 차례" |
| S14 | 호출 주기와 실제 간격을 따로 관측, 포트 대기 상한 | `beat_time`에 시작·끝 단조 시각, 박자 기한 `beatWaitMs` | 박자 기한 시험. 포트마다의 상한은 실측 뒤(남는 한계) |
| S15 | 서버 `deliver`에 `lines.deliver`, 박자마다 `pump()` | 서버의 `deliver`(답 줄이 선 뒤 `ready.deliver`), 주기의 `answerLines.pump()` | "pump 수 = 박자 수", 루프백의 인사 반영 |
| S16 | `candidate`마다 `noteCandidate` | 답 줄이 한다(`answers.ts`의 `candidate`). 조립은 답 줄의 `cycle`에 그 순서기를 넘긴다 | "같은 객체" |
| S17 | `takeRequery()`를 다시 묻게 | 꺼내 수를 기록만(`answerLines.takeRequery()`). 답 줄은 실행 ID만 내고 사유를 내지 않는다. 다시 묻기는 수명 박자의 간격 | 남는 한계 |
| S19 | D-90 박자에 같은 답 줄의 `evidence`·`withheld`, 증거 장부는 프로세스에 하나 | `beats.unreceived`(박자 함수 본문에서 `need(lines)`로 위임), `make.lines`의 `evidenceBook: createAnswerEvidenceBook()` | `boot-evidence.test.ts`(시한 뒤 빈 full이면 닫기 1회, 오염·대기·번호 변경·연결 바뀜은 0회), `boot-effects.test.ts` "D-90 박자의 증거·맡기지 않을 실행기는 같은 답 줄의", "읽기만 한다" |
| S20 | `reopen`, `not_initialized`를 첫 설치로 넘기지 않음 | `deps.openLedger`의 `mode: "reopen"` | "장부 not_initialized", 정적 `"create"` 0 |
| S21 | 필수 이웃에 현관·관측 중계·실행기 | `requiredPeers`(`settings.otherPeers`와 등록표의 활성 실행기) | "필수 이웃(S21)" |
| S22 | 1단계 전 서버가 보는 세대 `null` | 복원기를 감싸지 않고 넘김(`published`) | 루프백 1단계 전 맞춤 답 0 |
| S23 | `restoreDone`은 5단계 뒤만 | 순서기의 `restoreDone: () => stage >= 5 && effectsOpen()` | "관측 신호는 2단계를, 복원 끝은 5단계를" |
| S24 | `observationsSettled`는 2단계 뒤만 | `observationsSettled = () => stage >= 2` | 같음 |
| S25 | 게시 교체는 `deliver`·`pump` 밖 | 게시 교체가 없다(정한 것 4) | 정적 "다시 넣는 자리 없음" |
| S26 | `PeersPort` 행은 인증 연결과 검증한 인사가 맞은 것만 | `peers.ts`, 복원기 포트의 `peers: createPeers(…)` | 루프백(정책 일치 실행기 행으로 5단계가 열림) |
| S27 | `OccupancyPort`는 지금 서버 표 | 복원기 포트의 `occupancy` | 루프백 |
| S28 | 현관이 없으면 모름(던짐), 지어낸 `null` 없음 | 진입점의 `absent`, 복원기 포트의 `stopAuthority`·`publications`·`peers`(`inStep`이 감싼다) | "현관이 답하지 않으면 1단계를 같은 복원기로" |
| S29 | 새 업무는 `intakeOpen()`일 때만, 허가가 버려지면 새 복원기 | 박자의 접수 문 `intake`. 버려지면 96(`judge`, 주기 `loop`의 `haltReason`) | "낸 접수 허가가 버려지면", `boot-effects-loopback.test.ts` F4 |
| S33·S34 | 재개방 때 위임·새 객체 | **해당 없음.** 재개방을 두지 않는다(아래) | 정적 "한 자리와 재개방 없음" |
| S35 | `maxPendingWriteBytes` 주입 | 서버의 `maxPendingWriteBytes: settings.maxPendingWriteBytes`, 진입점 `MAX_MESSAGE_BYTES × 4` | `entry.test.ts`(산출값), `boot.test.ts` "같은 객체"(서버로 넘긴 값) |
| S36 | `nonces`는 장부, 요청 ID·nonce는 CSPRNG, `seal`은 키를 내주지 않음 | `nonces: ledger.nonceStore()`, `signer.ts` | "같은 객체"(같은 nonce 두 번째 거짓) |
| S37 | `deliver`는 던지지 않음 | 답 줄이 서기 전만 던진다(정한 것 3), 그 뒤는 답 줄 그대로 | "답 줄이 서기 전의 deliver" |
| S38 | 재료는 바이트로 한 번, 비면 거부 | 2단계(재료 읽기) | "연결 전에 거를 값" 표 |
| S43 | 보고의 `threw`·`rereads`·`clock`, 답 줄 `fault`, D-90 보고를 기록 | `summarize`: D-90은 결과 종류별 건수(`unreceivedOutcomes`, 건너뜀·거절·장부 고장은 사유까지)와 멈춘 이유(`unreceivedHalted`), 다시 읽기는 `박자:사유` 건수(`rereadCauses`). `answer_fault` | `boot-effects.test.ts` "D-90 박자의 기록". 경보 기준은 켜기 전 |
| S44 | 기록에 비밀 없음 | 결과 객체를 싣지 않고 갈래 이름·수만 | 정적 확인 없음(코드 읽기) |
| S47 | 답 줄의 `results` 필수, 실제 폴더 | `deps.createResultBackend`(실패면 `result_dir:…`), `make.lines`의 `results: { backend, ledger }`. 백엔드는 마지막 경로 요소만 `lstat`한다. 상위 경로는 배포 전제(README 환경 표) | "결과 보관 폴더가 틀림" |
| S48 | 환경을 읽는 파일은 진입점뿐 | `src/main/supervisor.ts` | `test/entrypoints.test.ts` 환경 목록 |
| S49 | 감독의 듣기는 `tls-server.ts` 하나 | 서버 하나 | `test/entrypoints.test.ts` "감독에서 닿는 코드", "허용 파일 안의 두 번째 종류 듣기" |
| S41 | 도구 포트는 같은 장부·공유 시계·CSPRNG로 | `RunningSupervisor.tools` | "도구 처리기 포트의 자리(S41)" |

## 재개방을 두지 않는 까닭

장부를 다시 열면 박자·순서기의 재조회 넷이 부를 때마다 지금 장부에 위임하거나 순서기를 새로 만들어야 하고(S33), 서버를 새로 시작하면 등록부·내보내기 포트·답 줄·발급·자격 송신기·순서기를 함께 새로 만들어야 한다(S34, 연결 번호가 1부터). 그 조건 열 개 남짓을 지키는 대신 프로세스를 끝내고 재시작에 맡긴다.

- **얻는 것:** 옛 장부·옛 복원기·옛 서버의 값으로 판단할 길이 구조적으로 없다. 장부 잠금은 프로세스가 죽으면 운영체제가 푼다. 정적 시험이 장부 열기·복원기·순서기·서버의 자리를 하나씩, 다시 넣는 자리를 0으로 잠근다.
- **대가:** 잠깐의 장부 실패마다 재기동이다(복원 1~5단계와 모든 실행기의 재맞춤). 메모리 기억(`watch` 등)은 어차피 재기동에 비게 설계됐다. 배포가 `Recreate`라 교체 중 두 파드가 겹치지 않는다.
- **되풀이 재기동을 막는 것:** 현관이 없는 동안은 재시작하지 않고 같은 복원기로 1단계를 다시 부른다. 5단계가 닫힌 판정이면 닫힌 채 돈다. 재시작은 "새 복원기가 필요하고 지금 복원기로는 될 수 없을 때"만이다.

## 모름·실패 표

| 갈래 | 입력 | 결과 | 시험 |
|---|---|---|---|
| 대조·복원 전 값 | 복원 1단계 전에 붙은 연결의 맞춤 요청 | 맞춤 답 0, `deliver` 0, 세대 `null` | `boot-loopback.test.ts` 1 |
| | 답 줄이 서기 전의 `deliver` | 던져 그 연결을 닫음 | "답 줄이 서기 전의 deliver" |
| | 2단계 전 | `observationsSettled` 거짓, `restoreDone` 거짓 | "관측 신호는 2단계를" |
| | 현관 무응답 | 1단계 되풀이, 재시작 없음, 박자는 서버 tick만 | "현관이 답하지 않으면" |
| | 5단계 닫힌 판정 | 끝내지 않고 닫힌 채 박자. 기한이 지난 작업에는 `task_cancel`, 기한 안의 작업에는 `status_query`가 나간다(입력마다 그 봉투 하나) | "5단계가 닫힌 판정이면", `boot-effects.test.ts` "처음부터 닫힌 5단계에서도 기존 실행의 정지는"·"상태 조회는" |
| 연결 전에 거를 값 | 환경 하나 빈 값·꼴 틀림 | 91, 파일 읽기 0 | `entry.test.ts`, `test/entrypoints.test.ts` |
| | TLS 키 0바이트, 신뢰 묶음 없음, 서명 키가 Ed25519 아님 | 92, 서버 시작 0 | "연결 전에 거를 값" 표 |
| | 등록표 읽기 실패, `environment` 불일치 | 93, 서버 시작 0 | 같음 |
| | 장부 `not_initialized`, `locked` | 94, 서버 시작 0, `create`로 넘어가지 않음 | "장부 not_initialized", "장부 locked" |
| | 결과 폴더가 틀림 | 94, 장부 닫음 | 표 |
| | 순서기 정책 범위 밖(`resendEveryMs` 19,001) | 95, **서버 시작 0**(서버 전에 거름) | 표 |
| | 서버 `listen_failed`·`no_material` | 95·92, 장부 닫음 | "서버 시작 실패" |
| | 서버를 연 뒤 조립 생성자가 던짐 | 발급을 만들었으면 발급 문으로(깃발 → 서버), 아니면 서버를 닫고 장부를 닫고 95 | "조립 생성자가 던지면", `boot-effects.test.ts` "조립 실패 뒤 정리" |
| 치명 → 종료 | 박자 약속의 거부 | 끝 차례 → 96 | "박자 약속의 거부" |
| | 장부 `health().writable === false` | 박자·`pump` 전에 끝 차례 → 96, 다시 열지 않음 | "장부가 쓸 수 없게 되면" |
| | 낸 허가가 버려짐 | 다음 박자 전에 끝 차례 → 96, 상태 조회 0 | "낸 접수 허가가 버려지면", `boot-effects-loopback.test.ts` F4 |
| | 박자가 기한을 넘김(서버 tick이 한도 + 1ms) | 남은 박자·갱신 기록·송신 0, 96 | `boot-effects-loopback.test.ts` F1 |
| | 수명 박자 안의 실행 목록 읽기가 박자 한도 + 1ms(기한이 끝난 기존 작업) | 종료 기록 0, 96, 같은 장부의 새 기동이 다시 넘기는 취소 0 | `boot-effects.test.ts` R1 |
| | 박자 부품의 마지막 외부 호출 안에서 박자 기한이 지남(수명의 시계, 재전송·배정의 서명, 배정의 난수, D-90의 `confirm`, 끊김의 앞 실행기 쓰기) | 그 쓰기 0, 결과 `beat_closed`. 대조군(기한 안)은 그대로 쓴다 | 각 부품 시험 "박자 유효 문" |
| | 박자 유효 문 안의 장부 건강 읽기나 허가 읽기가 박자 한도 + 1ms(기한이 끝난 기존 작업) / 한도 − 1ms | 종료 기록 포트 호출 0, 96 `beat_lapsed` / 호출 1, 0 | `boot-effects.test.ts` "유효 문 안의 읽기가" |
| | 공유 함수가 내보내기 포트의 수신 객체·`send`·표식 메서드(`markStartDispatch`)를 얻는 접근자, 수명 박자가 장부 포트 객체·쓰기 메서드를 얻는 접근자 안에서 박자 기한이 지남 | 표식·송신·쓰기 0, `beat_closed`. 대조군(기한 안)은 그대로 | 재전송·배정·수명 시험 "접근자 안에서" |
| | 허가 읽기(`restorer.intakeOpen`)가 던짐 | 96 `intake_unreadable`(처음부터 닫힌 판정과 구별) | `boot-effects.test.ts` R5 |
| | 배정 박자의 접수 문 안 허가 읽기 한 번이 던짐 / 그 예외를 붙잡은 박자가 뒤이어 기한 + 1ms를 씀 | 접수 문의 허가 읽기 1회, 답 처리 0·업무 쓰기 0·96 `intake_unreadable` / 기록은 `reason: intake_unreadable`, `later: beat_lapsed` | `boot-effects.test.ts` "허가 읽기 한 번의 예외와 치명 사유" |
| | 수명 박자가 내보내기 포트의 `send`를 얻는 접근자 안에서 박자 기한이 지남(갱신·취소·조회) | 포트 진입 0, 적은 갱신·종료는 `*_recorded_not_sent`(`beat_closed`), 조회는 기다리는 조회 0 | `life-loop.test.ts` "싣기" |
| | 재전송 시작의 마지막 판정에서 유효 문 안의 읽기가 1ms를 써 발행 + 19,001ms | `start_expired`, 포트 호출 0(19,000ms 대조는 싣는다) | `resend.test.ts` "시작의 마지막 판정" |
| | 진행 중인 D-90 박자 안에서 부른 유효 문 | 열림, 단조 시계 1회, 증거 포트·답 줄·서버 호출 0, 쓰기 0 | `boot-effects.test.ts` "D-90 박자 안의 박자 유효 문" |
| | 박자 안의 허가 읽기 한 번만 던지고 다음 읽기는 정상 | 처음 본 사유를 붙잡아 96 `intake_unreadable`, 업무 쓰기 0 | `boot-effects.test.ts` "한 번만 던져도" |
| | 박자 시간 기록 안에서 허가 폐기, 쥔 답 있음 | `pump` 0, 96 `intake_discarded` | `boot-effects.test.ts` R4 |
| | 멈춤 요청과 같은 차례의 박자 거부 / 장부 고장 뒤 다음 확인 전 멈춤 | 96(0으로 덮지 않음) | `boot-effects.test.ts` F5 |
| | 끝 차례의 서버 닫기 실패 | 96 | "서버 닫기가 실패하면" |
| | 처리하지 않은 예외·거부 | 97(진입점) | 미시험(아래 남는 한계) |
| 시간 경계 | 파일 읽기·서버 시작·복원 단계·박자·끝 차례의 기한 정각(결과가 먼저 / 타이머가 먼저) | 둘 다 만료: 92·95·96·96·96 | "기다림마다 기한" |
| | 파일 읽기·서버 시작·5단계·끝 차례·7단계 정리의 동기 비용이 상한 + 1ms | 92·93·95·96(5단계 허가를 받아들이지 않음)·96·`serverClosed:false` | `boot-effects.test.ts` F2 |
| | 끝 차례의 마지막 장부 닫기, 또는 첫 치명 기록이 상한 + 1ms / 장부 닫기가 상한 1ms 전 | 96 `shutdown_incomplete=lapsed` / 0 | `boot-effects.test.ts` R3 |
| | 박자를 부르기 전 시각이 유한하지 않음 | 박자 0, 96 `beat_unarmed` | `boot-effects.test.ts` R7 |
| | 복원 단계 기한 정각에 받은 현관 답(1단계 정지, 4단계 두 번째 게시) | 장부에 반영하지 않음, 96, 새 기동의 4단계가 다시 물음 | `boot-effects.test.ts` F3 |
| | 기한 1ms 전의 결과 | 받음 | `waitUntil` 시험, "대조군: 기한 1ms 전" |
| | 원천 시계 후퇴 | 장부·서버·복원기·도구 포트 시각이 하한에 멈춤, 순서기는 `regressed`를 앎 | "공유 시계를 거친다(S1)" |
| | 기동 중 멈춤(서버 전 / 서버 시작 대기 중) | 0, 서버 시작 0 / 늦게 선 서버를 닫고 0 | "기동 중 멈춤" |

## 뒤 조각이 지켜야 할 것

- **차트 짝(N5c, homelab):** README 환경 표의 "차트 짝" 다섯(`OLIVE_REGISTRY_FILE`, `OLIVE_ENVIRONMENT`, `OLIVE_TARGETS`, `OLIVE_POLICY_REVISION`, `OLIVE_RESULT_DIR`)을 더하고, `OLIVE_TLS_DIR`·`OLIVE_TRUST_DIR`을 감독에는 늘 준다. 서명 키 Secret의 키 이름을 `supervisor-signing.key`로 맞춘다(지금 차트의 이름은 확인하지 않았다). 결과 폴더를 장부 PVC 아래에 둘지 정하고, 그 상위 경로에 링크를 두지 않는다(기동은 마지막 요소만 본다).
- **현관(O08):** `FrontDoorPorts` 셋을 채운다. 권위 정지 기록은 모르면 던지고 "기록 없음"을 지어내지 않는다. 이웃 행은 현관(`front-door`, v2)과 관측 중계(이름을 진입점의 `observation-relay`와 맞춘다)를 그 연결이 실제로 쓰는 판과 인사에서 확인한 정책으로 낸다. 한 단계의 모든 답이 30초(`restoreStepWaitMs`) 안에 와야 한다(4단계는 게시 전부가 이 기한 하나를 나눠 쓴다). 넘기면 그 답은 모름이고 96이다.
- **연결 하나 닫기:** `closeConnection`은 D-90 박자의 새 인사 갈래만 부른다. 조립은 그 박자 포트의 `rehello`에 같은 서버의 `closeConnection`, 닫기 문(`cycle.issuanceOpen() && effectsOpen()`), 프로세스에 하나인 기억, 서버에 넘긴 재접속 제한 창을 넘긴다(`dispatch/unreceived.md` "새 인사를 부르는 갈래"). 다른 자리에서 부르려면 같은 기억과 닫기 문을 거친다.
- **관리 통로(M1a):** 상태는 조립의 기록(`restore_step`, `beat`의 D-90 건수·사유, `fatal`)과 같은 값을 읽는다. 도구 처리기 포트(`tools`)를 관리 명령에 다시 쓰지 않는다. 감독의 두 번째 듣기라 `test/entrypoints.test.ts`의 "감독에서 닿는 코드" 단언에 한 칸과 까닭을 더한다.
- **시험 작업 넣기(M1t):** 운영 값에서는 켜지 않는다(차트 CI가 막을 일). 접수 판단(`intake`)은 공개 면(`RunningSupervisor`)에 더하지 않았다: 조립이 `settings.testJobs`일 때만 만드는 `testJob` 포트의 문(`gate`)이 조립 변수(끝 차례·끝낼 사유·5단계·받아들인 허가 `granted`)와 박자 기한·요청 기한만 보고, 접수 허가·정지는 장부가 쓰기 트랜잭션 안에서 다시 본다(쓰기 모드 `start`, README "감독 관리 통로"). 문은 래치(`look()`·`haltReason()`)를 부르지 않고 장부를 읽지 않는다. 복원기를 직접 읽지 않는다: 기한을 넘긴 5단계의 허가는 장부에 남아 있을 수 있다.
- **도구 처리기를 부르는 길(O10):** `RunningSupervisor.tools`로만 포트를 만들고 처리기 문맥의 `now`도 거기서 읽는다. 처리기 호출을 박자와 겹치지 않게 부른다.
- **역할 프로필(O11·O12):** 배정 정책의 등록행·기대 프로필 revision·계정·실행 계획과 배정 전 사실·자격 참조 포트를 채운다. 지금은 모두 닫힌 값이다.

## 남는 한계

- **현관이 없으면 접수가 열리지 않는다.** 감독은 듣고 서버 tick만 돌리며 맞춤 요청에 답하지 않는다.
- **정지를 푼 뒤 다시 여는 것은 재시작이다.** 5단계가 닫힌 판정이면 같은 프로세스에서 새 복원 시도를 하지 않는다.
- **필수 실행기 하나가 2단계 때 인사하지 않았으면 그 기동의 접수는 닫힌 채다.** 2단계는 1단계 다음 주기에 바로 부른다. 늦게 붙은 실행기는 다음 재시작에서 센다. 2단계 전에 필수 이웃을 기다리는 문은 두지 않았다.
- **박자 하나의 기한(5초)이 포트마다의 상한을 대신한다.** 포트마다 상한은 시험 클러스터 실측 뒤 정한다(S14).
- **5단계 결과를 받기 전의 허가는 사유로 붙잡지 않는다.** 5단계는 첫 호출 안에서 동기로 허가를 내고 결과는 그 뒤에 받으므로, 그 사이에 문을 읽으면(같은 동기 구간의 서버 tick 등) 받아들이지 않은 허가가 보인다. 이를 사유로 붙잡으면 정상 기동이 96으로 끝나므로 닫힘으로만 읽고, 결과를 기한 안에 받지 못하면 복원 단계의 기한이 96으로 끝낸다.
- **재전송 시작과 갱신의 마지막 판정에는 시계 읽기 하나가 유효 문 뒤에 남는다.** 시작의 마지막 판정은 유효 문 → 시작 시한(장부 시계) → 송신, 갱신은 유효 문 → 13,000ms 여유(앞 임대 끝·봉투 시한·작업 기한, 장부 시계) → 송신 차례이고, 장부 시계 읽기 자체에 쓴 시간은 박자 기한 판정에 들어가지 않는다(장부 시계는 조립의 직접 함수라 접근자·포트 지연이 없다는 전제). 박자 기한(단조 시계)과 시작 시한(장부 시계)은 한 번의 읽기로 같이 볼 수 없어, 비용이 큰 유효 문(장부 건강·허가 읽기)을 앞에 둔다(`dispatch/send-gate.md` "남는 틈").
- **박자 유효 문은 장부 호출 직전까지만 본다.** 장부 호출(동기 커밋) 안에서 흐른 시간은 그 쓰기를 막지 못한다. 그 쓰기는 기한 안에 시작한 것이고, 결과를 받아들이는 순간의 박자 기한 비교가 96으로 끝낸다. 실행기로의 송신은 발급 깃발 뒤 서버의 인정 재확인·`finalCheck`를 지나고, 그 사이 박자 기한은 다시 보지 않는다.
- **장부의 접수 허가 자체는 기한을 넘긴 5단계에도 남는다.** 복원기가 5단계 안에서 동기로 내기 때문이다. 조립의 소비자(박자·발급 깃발·자격 값)는 `intake_unaccepted`로 보지 않고 곧 96으로 끝난다. 복원기·장부를 직접 읽는 새 소비자는 이 문을 거쳐야 한다.
- **동기 비용은 끊지 못한다.** 기한은 동기 일이 돌아온 뒤 받아들이는 순간에 판정한다. 그 일이 이미 장부에 쓴 것(현관 답을 기한 안에 받은 뒤의 반영 비용 포함)은 되돌리지 않는다.
- **다시 물을 실행(`takeRequery`)은 수만 기록한다.** 실제 조회는 수명 박자의 간격(`answerTimeoutMs`)을 따른다.
- **수명·배정 정책은 기동 때 검사하지 않는다.** 배정은 부를 때 `policy_rejected`로 돌지 않는다.
- **97(처리하지 않은 예외)은 시험하지 않았다.** 진입점의 처리기 한 줄이다. 연결 서버의 TLS 수락이 시계 예외를 잡지 않는 경로가 여기에 든다(`transport/server.md`).
- **재기동을 걸친 시계 비후퇴는 없다.** 공유 시계의 하한은 메모리에만 있다.
