# 수명 순환의 한 박자 (`life-loop.ts`)

배정기 순환의 한 박자다. 끝나지 않은 작업자 실행마다 수명 판단(`nextIntent`, `src/supervisor/scheduler/lifecycle.ts`)의 의도 하나를 옮긴다. **갱신·취소는 장부에 적은 뒤에만 내보낸다. 조회는 장부에 적지 않고**, 내보낸 조회를 결과의 기다리는 조회로 돌려준다(부르는 쪽의 메모리). 장부·접수·연결·시계·난수·서명·내보내기는 포트로, 정책과 앞 박자들의 기억(조회 시각, 싣지 못한 갱신)은 인자로 받는다. 소켓·타이머·시계·난수를 직접 부르지 않는다(시험이 소스를 읽어 지킨다). 쥐는 것은 같은 장부 포트로 박자가 진행 중이라는 표시 하나이고 박자가 돌아오면 지운다(아래 "겹쳐 부르기").

## 공개 면

```ts
lifeTick(ports: LifeLoopPorts, policy: LifecyclePolicy, input: LifeTickInput): Promise<LifeTickResult>

LifeLoopPorts = {
  ledger: Pick<Ledger, "listRuns" | "listInputs" | "instructionTimes" | "recordRenewInstruction" | "recordStopInstruction">
  intake: Pick<Restorer, "intakeOpen" | "stopGeneration">
  links: LinkGate       // { mayIssue(executorId, "run_renew"): { ok: true } | { ok: false, reason } }, 동기
  clock: Clock          // ports.ts. 장부 시계와 같은 시계
  random: Random        // 요청 ID, nonce
  signer: Signer
  sink: InstructionSink
}

LifeTickInput = { lastQueries: { runId: string, at: number }[], unsentRenews: string[] }

LifeTickResult =
  | { kind: "not_run", reason: "clock_unavailable" | "input_malformed" | "stop_generation_unknown" | "policy_rejected" | "tick_in_progress" }
  | { kind: "not_run", reason: "read_unknown", read: "runs" | "inputs" }
  | { kind: "ran", runs: RunOutcome[], pendingQueries: PendingQuery[], halted: "threw" | null, haltedAt: string | null }
```

`LinkGate`는 계약 v1의 `mayIssue`를 그 실행기의 연결과 부르는 순간의 시각(장부와 같은 시계)으로 부른 답이다. 조립이 만든다. `PendingQuery`는 영수증 처리기(`receipts.ts`)의 꼴(요청 ID, 받는 실행기, 물은 실행 ID)이다.

| 실행마다 (`RunOutcome`) | 뜻 |
|---|---|
| `wait` | 판단이 기다림을 냈다. 아무것도 쓰지 않았다 |
| `not_worker` | 세션 실행. 세션의 수명은 세션 계약 작업이 연다 |
| `read_unknown` + `read` | 그 실행의 판단 읽기(`runs`: 실행 줄의 꼴이 틀리거나 같은 실행의 줄이 둘 이상, `instruction_times`, `inputs`)가 모름이다. 쓰지도 내보내지도 않았다 |
| `finalize_withheld` | 판단이 확정을 냈지만 옮기지 않았다(아래 "확정") |
| `superseded` + `planned` | 쓰기 직전에 다시 읽은 실행 줄·입력 취소·지시 이력으로 판단하니 계획한 의도(`renew_lease`·`stop`)가 아니었다. 쓰지 않았다. 다음 박자가 그때의 의도를 옮긴다 |
| `renew_withheld` + `reason` | 갱신을 적지 않았다: `start_not_accepted`, `deadline_within_margin`, `intake_closed`, `no_connection`(연결 포트의 거절), `link_unknown`(연결 포트가 던지거나 답이 정의 밖), `margin_lost`(같은 사실로 기록 시각에 잰 여유가 모자람), `clock_unavailable`. 장부를 부르지 않았다 |
| `renew_sent` + `requestId`, `issuedAt`, `leaseUntil`, `executorId` | 갱신을 적고 연결에 실었다(`sent`는 받았다는 뜻이 아니다) |
| `renew_refused` + `reason` | 장부가 거절했다. 지시를 만들지 않았다 |
| `renew_failed` + `failure` | `random_unavailable`. 장부를 부르지 않았다 |
| `renew_record_unknown` + `requestId`, `stopGeneration`, `issuedAt`, `executorId`, `reason` | 장부를 불렀지만 적혔는지 모른다(`threw`: 쓰기 포트가 던짐, `malformed_answer`: 답이 정의 밖). 지시를 만들지 않았다. 적혔다면 이 요청 ID로 적혔다 |
| `renew_recorded_not_sent` + `requestId`, `stopGeneration`, `issuedAt`, `leaseUntil`, `executorId`, `reason`, `delivery` | 장부에는 갱신이 적혔고 전송 성공을 확인하지 못했다(아래 "내보내지 못했을 때") |
| `stop_sent` + `requestId`, `cancelReason`, `issuedAt`, `executorId` | `task_cancel`을 적고 연결에 실었다 |
| `closed_not_started` | 대기 실행을 지시 없이 `not_started`로 닫았다 |
| `stop_refused` / `stop_failed` | 갱신의 같은 이름과 같은 뜻. `stop_failed`에는 `clock_unavailable`도 있다(장부를 부르지 않음) |
| `stop_record_unknown` + 식별값, `cancelReason`, `reason` | `renew_record_unknown`과 같은 뜻의 종료 |
| `stop_recorded_not_sent` + 식별값, `cancelReason`, `reason`, `delivery` | 장부에는 종료가 적혔고 전송 성공을 확인하지 못했다 |
| `query_sent` + `requestId`, `executorId`, `at`, `cause` | 같은 실행 ID의 `status_query`를 실었다. `at`은 내보내기 포트가 돌아온 뒤에 읽은 시각 |
| `query_held` + `lastQueryAt`, `cause` | 마지막 조회부터 `answerTimeoutMs`가 지나지 않아 묻지 않았다 |
| `query_not_sent` + `at`, `cause`, `reason`, `delivery` | 조회를 싣지 못했다. `delivery: "unknown"`이면 기다리는 조회에는 넣었다 |

`cause`는 `intent`(판단이 조회를 냄) 또는 `stop_already_recorded`(아래 "이미 적힌 종료"). 끝난 실행(`finalized`·`not_started`)은 목록에 없다. 결과에는 원문·자격 참조의 값·봉투·서명·nonce가 없다(시험이 결과의 JSON에 자격 digest·서명·nonce가 없음을 본다).

## 한 박자의 순서

1. **박자 전체의 전제.** 같은 장부 포트로 진행 중인 박자가 없음(있으면 `tick_in_progress`, 읽기·쓰기 0), 시계(양의 안전 정수), `lastQueries`·`unsentRenews`의 꼴, 정지 세대(0 이상의 안전 정수), `listRuns`, `listInputs`. 하나라도 모름이면 `not_run`이고 아무것도 쓰지 않는다. 실행 ID(UUID)를 읽을 수 없는 줄이 하나라도 있으면 실행 목록 전체가 모름이다. **접수가 닫혀 있어도 박자는 돈다.** 정지는 새 일을 막는 것이고 멈춤을 막는 것이 아니다. 장부도 종료 지시는 정지 중에도 접수가 닫혀도 적고(쓰기 모드 `continue`), 갱신은 새 업무와 같은 전제(접수 허가, 정지 아님)를 본다. 그래서 접수는 갱신 직전에만 본다.
2. **쓰기 전의 읽기와 판단.** 끝나지 않은 작업자 실행마다 이어진 입력의 취소 여부와(대기가 아니면) `instructionTimes`를 읽어 `nextIntent`를 부른다. 판단이 정책 검사에서 던지면 `policy_rejected`이고 어느 실행에도 쓰지 않는다. 판단에 쓰는 칸은 꼴을 보고 칸마다 한 번만 읽어 옮겨 적는다(아래 "판단에 쓰는 칸").
3. **의도 하나를 옮긴다.** 실행 순서(`listRuns`의 대기 순번)대로 한 번에 하나씩. 갱신·종료는 쓰기 직전에 그 실행을 다시 읽고 판단을 다시 한다(아래 "쓰기 직전").

| 의도 | 하는 일 |
|---|---|
| `wait` | 없음 |
| `renew_lease` | 아래 "갱신"의 조건을 모두 지난 뒤 `recordRenewInstruction` → `renewDraft` → `sealDraft` → 송신 규칙 → `sink.send` |
| `stop` | 이미 종료 지시가 적힌 실행이면 조회로 간다. 아니면 쓰기 직전의 확인 → `recordStopInstruction`(사유 함께) → 대기 실행이면 끝, 아니면 `stopDraft` → `sealDraft` → `sink.send` |
| `query` | 간격을 지났으면 `statusQueryDraft` → `sealDraft` → `sink.send`. 장부에 쓰지 않는다 |
| `finalize` | 없음(`finalize_withheld`) |

판단에 넘기는 값: `lease`는 장부가 끝을 아는 임대만(`expiresAt`이 `"unknown"`이거나 지시가 없거나 그 실행이 `unsentRenews`에 있으면 `null`이라 판단은 조회로 간다), `lastInstructionAt`은 `stopping`이면 `lastStopAt`, 결과 쪽 상태면 `lastFinalizeAt`(그 밖의 상태에서 판단은 이 값을 쓰지 않는다), `resultSettled`는 늘 `false`, `cancelRequested`는 이어진 입력의 `cancelled`(입력이 없는 실행은 `false`).

## 판단에 쓰는 칸

- **실행 줄:** `runId`(UUID), `kind`(`worker`·`session`), `state`(장부의 상태 이름), `runGeneration`(0 이상의 안전 정수), `deadlineAt`(양의 안전 정수), `executorId`(빈 문자열이 아닌 문자열), `inputRequestId`(문자열 또는 `null`), `acceptedReceiptId`·`startedReceiptId`(`null` 또는 UUID). 하나라도 꼴이 틀리거나 칸이 없거나 읽다 던지면, 또는 같은 `runId`의 줄이 둘 이상이면 그 실행은 `read_unknown`(`runs`)이다.
- **지시 이력:** 답의 `runId`가 물은 실행과 같고, `lease`는 `null`이거나 `{ issuedAt: 시각, expiresAt: 시각 | "unknown" }`, `lastStopAt`·`lastFinalizeAt`은 `null`이거나 시각. 아니면 `read_unknown`(`instruction_times`). 잘못된 `lastStopAt`이 취소를 조회로 돌리거나, 칸이 빠진 이력이 갱신을 내는 일을 막는다.
- **입력:** 같은 `requestId`의 줄이 둘 이상이거나 `cancelled`가 불리언이 아니면 그 입력에 이어진 실행은 `read_unknown`(`inputs`)이다.

## 쓰기 직전

갱신·종료는 쓰기 직전에 `listRuns`·`listInputs`·`instructionTimes`로 그 실행을 다시 읽고(꼴 검사 같음), 기록에 쓸 시각으로 판단을 다시 부른다. 박자 처음의 읽기 뒤에 다른 박자나 다른 쓰기(소유자 취소, 다른 경로의 종료 기록)가 끼었을 수 있기 때문이다.

- 다시 읽은 것이 모름이면 `read_unknown`이고 쓰지 않는다.
- 다시 부른 판단이 계획한 의도가 아니면 쓰지 않는다. 사실(상태·기한·취소·지시 시각·임대)이 같고 시각만 흘러 갱신이 조회로 바뀌었으면 `margin_lost`, 사실이 바뀌었으면 `superseded`다. 종료는 그 사이 종료 지시가 적혔으면(`lastStopAt`) `superseded`다.
- **요청 ID를 먼저 만든다.** 순서는 요청 ID → 다시 읽기 → (갱신이면) 접수 → 연결 → 마지막 시계 읽기 → 판단 → 장부 호출이다. 마지막 시계 읽기부터 장부 호출까지 포트를 부르지 않고 `await`도 없다. 그래서 같은 프로세스의 다른 박자는 다시 읽기와 쓰기 사이에 끼지 못하고, 기록 시각은 장부에 들어가는 순간과 같다.

## 갱신

- **시작 접수 뒤에만.** 실행 줄의 `acceptedReceiptId`나 `startedReceiptId`에 **장부의 영수증 ID(UUID)가 있을 때만** 접수의 증거다. `null`은 접수 없음이고, 칸이 없거나 `undefined`·빈 문자열·다른 꼴이면 줄 전체가 모름이다(위 "판단에 쓰는 칸"). 이 칸은 그 실행의 지정 실행기가 같은 세대로 낸 영수증만 채운다. `preparing`·`running`에는 종료 지시가 없으므로(종료를 적으면 `stopping`으로 가고 돌아오지 않는다) 접수 영수증은 시작 지시의 것이다. 시작 영수증만 먼저 닿아도 실행기가 시작을 받은 것이다. `unansweredInstructions()`를 쓰지 않은 이유: 이미 읽은 실행 줄로 가를 수 있고, 장부 전체를 읽는 그 읽기가 모름이면 모든 실행의 갱신이 막히며, 보고만 있는 실행까지 받은 것으로 넓힐 근거가 없다(넓히지 않는 쪽은 갱신을 덜 낸다).
- **연결.** 기록 직전에 `links.mayIssue(지정 실행기, "run_renew")`를 부른다. `{ ok: true }`가 아니면 적지 않는다(`ok: false`는 `no_connection`, 던지거나 정의 밖의 답은 `link_unknown`). 장부의 임대는 그대로다. 끊긴 연결에 적은 갱신은 실행기에 닿지 않고 장부만 연장한다(`src/ledger/ledger.md` "기록 전에 연결이 살아 있는지(`mayIssue`)를 본다").
- **작업 기한.** `기록 시각 + RENEW_MARGIN_MS > deadlineAt`이면 내지 않는다(`deadline_within_margin`). 실행기는 임대보다 기한을 먼저 보므로 그런 갱신은 닿기 전에 기한으로 끝날 수 있다. **이 경우에 한해** 갱신 없이도 앞 임대가 기한까지 덮는다: 판단이 갱신을 냈다면 앞 임대는 `기록 시각 + 여유` 뒤에 끝나고, 그 시각은 기한보다 늦다. 기한에 닿으면 판단이 `deadline` 종료를 낸다. 기한이 먼 실행(예: 앞 임대 끝 `T+30000`, 기한 `T+600000`)에는 이 문장이 해당하지 않고 판단대로 갱신한다.
- **기록 직전에 다시 잰다.** 위 "쓰기 직전"의 순서로 다시 읽은 사실과 기록 시각으로 판단·접수·기한을 다시 본다. 기록·봉투의 발행 시각은 그 마지막 시계 읽기다.
- **송신 규칙.** 봉투는 발행 시각부터 기본 수명 전체로 봉하고(`sealDraft`), 싣기 직전에 시계를 다시 읽어 `min(앞 임대의 끝, expires_at) − 지금 >= RENEW_MARGIN_MS`(아니면 `renew_margin_lost`)이고 `deadlineAt − 지금 >= RENEW_MARGIN_MS`(아니면 `deadline_within_margin`)일 때만 싣는다. 앞 임대의 끝은 이 갱신을 적기 전에 다시 읽은 `lease.expiresAt`이다. 잰 뒤 포트를 부르기까지 `await`가 없다. **이 판정은 포트를 부르는 시점까지다.** 포트 안에서 실제로 싣기까지의 시간은 이 박자가 재지 못한다(아래 "뒤 조각이 지킬 것").

## 싣지 못한 갱신 (`unsentRenews`)

장부는 적힌 갱신의 끝을 임대로 믿는다(보냈는지의 표시가 없다). 실행기는 그 갱신을 받지 못했으면 앞 임대의 끝에서 닫는다. 그 끝으로 다음 갱신을 고르면, 실행기의 임대가 이미 끝난 뒤에 새 요청 ID의 갱신이 나가고 장부의 끝만 늘어난다.

- **넣는 것:** 결과의 `renew_recorded_not_sent`(어느 `delivery`든)와 `renew_record_unknown`의 실행 ID. 부르는 쪽이 메모리에 쥐고 다음 박자마다 넘긴다.
- **이 박자가 하는 일:** 그 실행의 임대를 판단에 넘기지 않는다. 판단은 `preparing`·`running`에서 조회를 내고 새 갱신을 적지 않는다. 취소·기한의 종료는 그대로 낸다.
- **빼는 때(부르는 쪽이 정한다):** 그 실행이 결과에서 사라지거나(끝남) 장부에서 `preparing`·`running`을 떠났을 때(종료 영수증, 끊김 표시). 조회의 답(`status_report`)은 임대 끝을 담지 않으므로 빼는 근거가 아니다. 같은 요청 ID를 다시 실은 재전송도, 실은 시각이 그 갱신의 앞 임대 끝 기준 송신 규칙 안이었음을 확인하기 전에는 빼지 않는다.
- **대가:** 갱신이 실제로는 실렸어도(`delivery: "unknown"`) 그 실행은 더 갱신되지 않고 실행기가 받은 임대의 끝에서 닫힌다. 잃는 것은 그 일이고, 장부가 믿는 끝이 실행기보다 늘어나지는 않는다. 감독이 다시 뜨면 이 목록은 비지만 복원 3단계가 진행 중 실행을 `unknown_running`으로 옮겨 갱신이 나가지 않는다.

## 조회

- 같은 실행 ID 하나를 지정 실행기에 묻는다. 새 실행 ID를 만들지 않고 장부에 지시 줄을 만들지 않는다.
- **간격의 입력은 부르는 쪽이 준다.** 장부는 조회를 적지 않으므로 마지막 조회 시각은 장부에 없다. 부르는 쪽은 결과의 `query_sent`와 `delivery: "unknown"`인 `query_not_sent`의 `{ runId, at }`을 메모리에 쥐고 다음 박자의 `lastQueries`로 넘긴다. 같은 실행은 마지막 조회부터 판단의 `answerTimeoutMs`가 지나야 다시 묻는다(`query_held`). 감독이 다시 뜨면 비어 있으므로 첫 박자는 곧바로 묻는다. 연결이 없어 싣지 못한 조회는 넘기지 않아도 된다(실행기에 닿지 않았다).
- **간격은 실제로 실은 시각부터 센다.** 결과의 `at`은 내보내기 포트가 돌아온 뒤에 읽은 시각이다. 포트는 돌아오기 전에 실었으므로 실은 시각보다 이르지 않다. 그 시계를 읽지 못하면 봉한 시각을 쓴다(그때만 간격이 그만큼 짧아질 수 있다).
- `stopping`의 조회는 판단이 `lastStopAt`부터 `answerTimeoutMs`를 기다린 뒤에 내고, 그 뒤로는 이 간격이 막는다.

## 종료

- 사유: 이어진 입력이 취소됐으면 `requested`, 아니면(판단은 취소나 기한일 때만 종료를 낸다) `deadline`. 계약 v1의 `TASK_CANCEL_REASONS` 이름이다. 사유는 쓰기 직전에 다시 읽은 취소 여부로 정한다. **사유를 늘 장부에 함께 적는다.** 빼고 적은 종료 지시는 장부가 본문을 다시 만들 수 없음으로 남기고 같은 요청 ID로 나중에 채울 수도 없다.
- **연결을 보지 않고 적는다.** 종료는 전해야 할 것이 남았다는 기록이다. 연결이 없으면 내보내기가 `no_connection`을 내고 `stop_recorded_not_sent`로 구별된다.
- **이미 적힌 종료.** 그 실행의 `lastStopAt`이 있으면(종료를 적은 뒤 끊겨 `unknown_running`이 된 실행) 새 요청 ID의 종료를 적지 않는다. 장부는 새 요청 ID면 받아 주므로 이 박자가 막는다. 박자 처음에 이미 있었으면 같은 ID로 묻기만 하고(`cause: "stop_already_recorded"`), 쓰기 직전에 새로 보이면 `superseded`다. 앞 지시를 다시 보내는 것은 재전송 조각의 일이다.
- 대기 실행의 취소는 장부가 지시 없이 `not_started`로 닫는다(`closed_not_started`).
- 종료의 머리 `issued_at`은 장부 기록에 넘긴 시각이다(`envelopes.md` "시각 규칙").

## 확정

내지 않는다. 결과 보관(S6)이 없어 `resultSettled`는 늘 `false`이고, 판단이 그래도 확정을 내는 상태(`failed_stopped`·`cleanup_pending`)는 `finalize_withheld`로 남는다. 장부 포트에 확정 기록이 없다. 그 실행들은 자리를 쥔 채 남는다.

## 겹쳐 부르기

- **호출 계약: 박자는 겹쳐 부르지 않는다.** 앞 박자가 돌아온 뒤에 다음을 부른다.
- **모듈이 알아채는 범위:** 같은 장부 포트 객체(`ports.ledger`)로 박자가 진행 중이면 다음 호출은 읽기·쓰기 없이 `not_run`/`tick_in_progress`다. 다른 포트 객체로 같은 장부를 겹쳐 부르면 알아채지 못하고, 그때는 위 "쓰기 직전"의 다시 읽기가 같은 실행의 두 번째 지시를 막는다(한 프로세스 안에서는 다시 읽기와 쓰기 사이에 `await`가 없다).
- **닫지 못하는 것:** 같은 장부 파일을 다른 프로세스가 동시에 다시 읽고 쓰는 경우. 감독은 장부를 한 프로세스만 연다는 전제다.
- 정지 세대는 박자 처음에 한 번 읽는다. 박자 중에 세대가 바뀌면 갱신·종료 쓰기는 장부가 `stop_generation_mismatch`로 거절하지만, 그 박자의 조회는 처음의 세대를 싣는다.

## 박자가 멈출 때

- **읽기의 실패는 그 실행의 결과다.** 실행 줄·이력·입력의 칸을 읽다 던지면 그 실행은 `read_unknown`이다(실행 ID를 읽지 못하면 목록 전체가 모름).
- **포트의 예외는 그 항목의 결과다.** 난수는 `*_failed`의 `random_unavailable`, 쓰기 포트가 던지면 `*_record_unknown`(`threw`), 서명·내보내기는 `*_recorded_not_sent`(`seal_threw`·`send_threw`), 시계는 `clock_unavailable`, 연결 포트는 `link_unknown`. 박자는 다음 실행을 본다.
- **장부 쓰기의 답을 해석하다 던지면**(답의 칸 getter 등) 남은 실행을 하지 않고 `halted: "threw"`, `haltedAt`은 그 실행이다. 그 실행의 항목은 쓰기 전에 확보한 식별값(실행 ID, 요청 ID, 정지 세대, 기록 시각, 지정 실행기)으로 결과에 남는다: 성공(`ok: true`)을 읽기 전이면 `*_record_unknown`, 읽은 뒤면 `*_recorded_not_sent`(`ledger_answer_malformed`, 대기 실행의 종료면 `closed_not_started`). 그 전까지의 결과와 `pendingQueries`는 그대로다.

## 내보내지 못했을 때

장부에 적은 뒤의 실패는 `*_recorded_not_sent`이고 새 요청 ID로 다시 만들지 않는다.

| `reason` | `delivery` |
|---|---|
| `ledger_answer_malformed`, `draft_threw`, 초안의 거절 이름, `seal_threw`, `sealDraft`의 거절 이름(`field`·`sealReason` 함께), `clock_unavailable`, `renew_margin_lost`, `deadline_within_margin` | `not_sent` |
| `no_connection`, `too_late_to_send` | `not_sent` |
| `send_threw`, `send_answer_malformed` | `unknown`: 포트가 연결에 실었는지 모른다 |

## D-89의 한계(감독이 믿는 끝은 추정이다)

계약 v1의 갱신에는 영수증이 없어, 장부가 믿는 임대의 끝은 감독의 추정이다(`src/ledger/ledger.md` "갱신 뒤의 임대"·"남는 한계"). 이 박자가 줄이는 것: 시작 접수 영수증이 장부에 닿기 전에는 갱신을 적지 않아 "실행기가 모르는 실행으로 거절하고 장부만 연장되는" 경우를 막고, 지정 실행기의 연결이 지시를 낼 수 없으면 적지 않고, 기록 직전(그 시각으로 다시 읽은 사실)과 포트를 부르기 직전에 여유와 작업 기한을 다시 재어 늦은 갱신을 적거나 싣지 않고, 겹친 박자나 끼어든 쓰기가 같은 실행에 두 번째 지시를 적지 않게 하고, 부르는 쪽이 싣지 못했다고 넘긴 갱신의 끝으로 다음 갱신을 고르지 않고, 끝을 모르면 갱신 대신 같은 실행을 묻는다. 줄이지 못하는 것: 실행기가 이미 끝났는데(기한, 앞 임대의 만료, 자연 종료) 그 종료 영수증이 장부에 닿기 전이면 판단은 실행을 `running`으로 보고 갱신을 계속 적고, 장부의 끝은 실제보다 늦어진다. 연결에 실은 뒤 전달 중에 사라진 갱신, 포트를 부른 뒤 실제로 싣기까지 늦어진 갱신, 연결 포트가 살아 있다고 답한 직후에 끊긴 연결도 장부에는 믿는 끝으로 남는다. 부르는 쪽이 `unsentRenews`를 넘기지 않으면 싣지 못한 갱신의 끝으로 다음 갱신을 고를 수 있다. 자리는 종료 확인까지 쥐므로 일이 겹치지는 않고 그만큼 늦게 풀린다.

## 이 박자가 하지 않는 것

확정, 재전송(답 없는 지시를 같은 요청 ID로 다시 보내기), 영수증·보고의 처리, 배정·시작, 연결 상실의 반영(끊긴 실행기의 실행을 모름으로 옮김), 세션 실행의 수명, 비상 정지의 종료.

## 뒤 조각이 지킬 것

- **박자를 겹쳐 부르지 않는다.** 앞 박자가 돌아온 뒤에 다음을 부르고, 같은 장부는 한 프로세스만 연다. 다른 경로의 취소·종료 쓰기는 이 박자의 다시 읽기가 받아 내지만, 같은 실행에 종료를 적는 다른 경로(비상 정지 등)와의 순서는 그 조각이 정한다.
- **`unsentRenews`를 넘긴다.** `renew_recorded_not_sent`·`renew_record_unknown`의 실행 ID를 쥐고 넘기고, 위 "빼는 때"에만 뺀다. 상태 보고에는 임대 끝이 없으므로 조회를 보냈다는 사실만으로 신뢰를 되돌리지 않는다. 재시작은 복원 3단계의 `unknown_running` 전이를 따른다.
- **`links`를 실제 연결로 잇는다.** 그 실행기의 `Link`와 부르는 순간의 시각으로 계약 v1의 `mayIssue`를 부르고, 동기로 답한다.
- **내보내기 포트가 갱신의 송신 규칙을 싣는 순간에 다시 본다.** 이 박자는 포트를 부르기 직전에 재지만 포트 안의 대기(연결 쓰기 등)는 재지 못한다. 실제 적재 시각까지 13000ms 여유를 지키려면 포트가 봉투마다 "이 시각 뒤에는 싣지 않음"(`min(앞 임대의 끝, expires_at, deadlineAt) − RENEW_MARGIN_MS`)을 받아 적재 직전에 대조해야 한다. 그 칸(예: `send(envelope, { notAfter })`)은 `ports.ts`의 꼴을 바꾸는 일이라 이 PR에 없다. 그 전까지는 포트가 대조부터 싣기까지를 지연 없이 끝내고, 그 지연은 조립이 책임진다.
- **기다리는 조회를 싣기 전에 등록한다.** 조회의 답은 박자가 결과를 돌려주기 전에 올 수 있다. 결과의 `pendingQueries`를 받은 뒤에 영수증 처리기에 더하면 그 사이 온 정상 답이 `unknown_query`로 버려진다. 내보내기 포트가 싣기 직전에 그 조회를 처리기에 등록하거나, 결과가 반영될 때까지 그 답을 보관한다.
- **`lastQueries`를 넘긴다.** 결과의 `at`(실은 뒤의 시각)을 쓴다. 넘기지 않으면 조회가 필요한 실행을 박자마다 묻는다.
- **실행별 연결·정지 세대를 실행기와 맞춘다.** 정지 중의 종료는 장부의 지금 세대를 싣는다. 실행기가 그 세대를 적용하기 전이면 `requested`·`deadline` 종료를 받지 않는다(높은 세대는 `emergency_stop`만 받는다). 세대 맞춤과 비상 종료는 다른 조각이고 기존 경로를 쓴다. 재전송은 장부의 기존 요청 ID와 본문을 쓴다.
- **`halted`를 본다.** `threw`이면 앞 결과를 반영하고, 멈춘 실행(`haltedAt`)과 결과 목록에 없는 실행을 장부에서 다시 대조한다. `*_record_unknown`은 장부를 다시 읽어(종료는 `unansweredInstructions`의 그 요청 ID, 갱신은 `instructionTimes.renewIssued`의 발행 시각) 적혔는지 가린다.
- **박자를 되풀이해 부른다.** 갱신을 낼 수 있는 구간은 기본값에서 7000ms라(`ledger.md` "판단을 갱신 구간 안에서 부른다") 그 안에서 여러 번 부른다.
