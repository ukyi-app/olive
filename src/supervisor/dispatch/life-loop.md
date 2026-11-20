# 수명 순환의 한 박자 (`life-loop.ts`)

배정기 순환의 한 박자다. 끝나지 않은 작업자 실행마다 수명 판단(`nextIntent`, `src/supervisor/scheduler/lifecycle.ts`)의 의도 하나를 장부에 적고, 적은 뒤에만 지시를 내보낸다. 상태를 갖지 않는다. 장부·접수·시계·난수·서명·내보내기는 포트로, 정책과 앞 박자의 조회 시각은 인자로 받는다. 소켓·타이머·시계·난수를 직접 부르지 않는다(시험이 소스를 읽어 지킨다).

## 공개 면

```ts
lifeTick(ports: LifeLoopPorts, policy: LifecyclePolicy, input: LifeTickInput): Promise<LifeTickResult>

LifeLoopPorts = {
  ledger: Pick<Ledger, "listRuns" | "listInputs" | "instructionTimes" | "recordRenewInstruction" | "recordStopInstruction">
  intake: Pick<Restorer, "intakeOpen" | "stopGeneration">
  clock: Clock          // ports.ts. 장부 시계와 같은 시계
  random: Random        // 요청 ID, nonce
  signer: Signer
  sink: InstructionSink
}

LifeTickInput = { lastQueries: { runId: string, at: number }[] }

LifeTickResult =
  | { kind: "not_run", reason: "clock_unavailable" | "input_malformed" | "stop_generation_unknown" | "policy_rejected" }
  | { kind: "not_run", reason: "read_unknown", read: "runs" | "inputs" }
  | { kind: "ran", runs: RunOutcome[], pendingQueries: PendingQuery[], halted: "threw" | null, haltedAt: string | null }
```

`PendingQuery`는 영수증 처리기(`receipts.ts`)의 꼴(요청 ID, 받는 실행기, 물은 실행 ID)이다. 부르는 쪽은 결과의 `pendingQueries`를 처리기의 기다리는 조회에 더한다.

| 실행마다 (`RunOutcome`) | 뜻 |
|---|---|
| `wait` | 판단이 기다림을 냈다. 아무것도 쓰지 않았다 |
| `not_worker` | 세션 실행. 세션의 수명은 세션 계약 작업이 연다 |
| `read_unknown` + `read` | 그 실행의 판단 읽기(`instruction_times`, 또는 이어진 입력 줄 `inputs`)가 모름이다. 쓰지 않았다 |
| `finalize_withheld` | 판단이 확정을 냈지만 옮기지 않았다(아래 "확정") |
| `renew_withheld` + `reason` | 갱신을 적지 않았다: `start_not_accepted`, `deadline_within_margin`, `intake_closed`, `margin_lost`(기록 직전에 다시 잰 여유가 모자람), `clock_unavailable`. 장부를 부르지 않았다 |
| `renew_sent` + `requestId`, `issuedAt`, `leaseUntil`, `executorId` | 갱신을 적고 연결에 실었다(`sent`는 받았다는 뜻이 아니다) |
| `renew_refused` + `reason` | 장부가 거절했다. 지시를 만들지 않았다 |
| `renew_failed` + `failure` | `random_unavailable`(장부를 부르지 않음), `threw`, `malformed_answer`. 적혔는지 모르므로 지시를 만들지 않았다 |
| `renew_recorded_not_sent` + `requestId`, `stopGeneration`, `issuedAt`, `leaseUntil`, `executorId`, `reason`, `delivery` | 장부에는 갱신이 적혔고 전송 성공을 확인하지 못했다(아래 "내보내지 못했을 때") |
| `stop_sent` + `requestId`, `cancelReason`, `issuedAt`, `executorId` | `task_cancel`을 적고 연결에 실었다 |
| `closed_not_started` | 대기 실행을 지시 없이 `not_started`로 닫았다 |
| `stop_refused` / `stop_failed` | 갱신의 같은 이름과 같은 뜻. `stop_failed`에는 `clock_unavailable`도 있다(장부를 부르지 않음) |
| `stop_recorded_not_sent` + 식별값, `cancelReason`, `reason`, `delivery` | 장부에는 종료가 적혔고 전송 성공을 확인하지 못했다 |
| `query_sent` + `requestId`, `executorId`, `at`, `cause` | 같은 실행 ID의 `status_query`를 실었다 |
| `query_held` + `lastQueryAt`, `cause` | 마지막 조회부터 `answerTimeoutMs`가 지나지 않아 묻지 않았다 |
| `query_not_sent` + `at`, `cause`, `reason`, `delivery` | 조회를 싣지 못했다. `delivery: "unknown"`이면 기다리는 조회에는 넣었다 |

`cause`는 `intent`(판단이 조회를 냄) 또는 `stop_already_recorded`(아래 "이미 적힌 종료"). 끝난 실행(`finalized`·`not_started`)은 목록에 없다. 결과에는 원문·자격 참조의 값·봉투·서명·nonce가 없다(시험이 결과의 JSON에 자격 digest·서명·nonce가 없음을 본다).

## 한 박자의 순서

1. **박자 전체의 전제.** 시계(양의 안전 정수), `lastQueries`의 꼴, 정지 세대(0 이상의 안전 정수), `listRuns`, `listInputs`. 하나라도 모름이면 `not_run`이고 아무것도 쓰지 않는다. **접수가 닫혀 있어도 박자는 돈다.** 정지는 새 일을 막는 것이고 멈춤을 막는 것이 아니다. 장부도 종료 지시는 정지 중에도 접수가 닫혀도 적고(쓰기 모드 `continue`), 갱신은 새 업무와 같은 전제(접수 허가, 정지 아님)를 본다. 그래서 접수는 갱신 직전에만 본다.
2. **쓰기 전의 읽기와 판단.** 끝나지 않은 작업자 실행마다 이어진 입력의 취소 여부와(대기가 아니면) `instructionTimes`를 읽어 `nextIntent`를 부른다. 판단이 정책 검사에서 던지면 `policy_rejected`이고 어느 실행에도 쓰지 않는다.
3. **의도 하나를 옮긴다.** 실행 순서(`listRuns`의 대기 순번)대로 한 번에 하나씩. 아래 표.

| 의도 | 하는 일 |
|---|---|
| `wait` | 없음 |
| `renew_lease` | 아래 "갱신"의 조건을 모두 지난 뒤 `recordRenewInstruction` → `renewDraft` → `sealDraft` → 송신 규칙 → `sink.send` |
| `stop` | 이미 종료 지시가 적힌 실행이면 조회로 간다. 아니면 `recordStopInstruction`(사유 함께) → 대기 실행이면 끝, 아니면 `stopDraft` → `sealDraft` → `sink.send` |
| `query` | 간격을 지났으면 `statusQueryDraft` → `sealDraft` → `sink.send`. 장부에 쓰지 않는다 |
| `finalize` | 없음(`finalize_withheld`) |

판단에 넘기는 값: `lease`는 장부가 끝을 아는 임대만(`expiresAt`이 `"unknown"`이거나 지시가 없으면 `null`이라 판단은 조회로 간다), `lastInstructionAt`은 `stopping`이면 `lastStopAt`, 결과 쪽 상태면 `lastFinalizeAt`(그 밖의 상태에서 판단은 이 값을 쓰지 않는다), `resultSettled`는 늘 `false`, `cancelRequested`는 이어진 입력의 `cancelled`(입력이 없는 실행은 `false`).

## 갱신

- **시작 접수 뒤에만.** 실행 줄의 `acceptedReceiptId`나 `startedReceiptId`가 있을 때만 적는다. 이 칸은 그 실행의 지정 실행기가 같은 세대로 낸 영수증만 채운다. `preparing`·`running`에는 종료 지시가 없으므로(종료를 적으면 `stopping`으로 가고 돌아오지 않는다) 접수 영수증은 시작 지시의 것이다. 시작 영수증만 먼저 닿아도 실행기가 시작을 받은 것이다. `unansweredInstructions()`를 쓰지 않은 이유: 이미 읽은 실행 줄로 가를 수 있고, 장부 전체를 읽는 그 읽기가 모름이면 모든 실행의 갱신이 막히며, 보고만 있는 실행까지 받은 것으로 넓힐 근거가 없다(넓히지 않는 쪽은 갱신을 덜 낸다).
- **작업 기한.** `기록 시각 + RENEW_MARGIN_MS > deadlineAt`이면 내지 않는다(`deadline_within_margin`). 실행기는 임대보다 기한을 먼저 보므로 그런 갱신은 닿기 전에 기한으로 끝날 수 있다. 판단이 갱신을 낸 임대는 이미 `기록 시각 + 여유` 뒤에 끝나므로 기한까지 덮고, 기한에 닿으면 판단이 `deadline` 종료를 낸다.
- **기록 직전에 다시 잰다.** 접수를 다시 보고, 시계를 다시 읽어 그 시각으로 판단을 다시 부르고 기한도 다시 본다. 갱신이 아니면 적지 않는다(`margin_lost`). 기록·봉투의 발행 시각은 그 다시 읽은 시각이다.
- **송신 규칙.** 봉투는 발행 시각부터 기본 수명 전체로 봉하고(`sealDraft`), 싣기 직전에 시계를 다시 읽어 `min(앞 임대의 끝, expires_at) − 지금 >= RENEW_MARGIN_MS`일 때만 싣는다. 앞 임대의 끝은 이 갱신을 적기 전에 읽은 `lease.expiresAt`이다. 잰 뒤 포트를 부르기까지 await가 없다. **포트 안에서 실제로 싣기까지의 시간은 이 박자가 재지 못한다**(아래 "뒤 조각이 지킬 것").

## 조회

- 같은 실행 ID 하나를 지정 실행기에 묻는다. 새 실행 ID를 만들지 않고 장부에 지시 줄을 만들지 않는다.
- **간격의 입력은 부르는 쪽이 준다.** 장부는 조회를 적지 않으므로 마지막 조회 시각은 장부에 없다. 부르는 쪽은 결과의 `query_sent`와 `delivery: "unknown"`인 `query_not_sent`의 `{ runId, at }`을 메모리에 쥐고 다음 박자의 `lastQueries`로 넘긴다. 같은 실행은 마지막 조회부터 판단의 `answerTimeoutMs`가 지나야 다시 묻는다(`query_held`). 감독이 다시 뜨면 비어 있으므로 첫 박자는 곧바로 묻는다. 연결이 없어 싣지 못한 조회는 넘기지 않아도 된다(실행기에 닿지 않았다).
- `stopping`의 조회는 판단이 `lastStopAt`부터 `answerTimeoutMs`를 기다린 뒤에 내고, 그 뒤로는 이 간격이 막는다.

## 종료

- 사유: 이어진 입력이 취소됐으면 `requested`, 아니면(판단은 취소나 기한일 때만 종료를 낸다) `deadline`. 계약 v1의 `TASK_CANCEL_REASONS` 이름이다. **사유를 늘 장부에 함께 적는다.** 빼고 적은 종료 지시는 장부가 본문을 다시 만들 수 없음으로 남기고 같은 요청 ID로 나중에 채울 수도 없다.
- **이미 적힌 종료.** 그 실행의 `lastStopAt`이 있으면(종료를 적은 뒤 끊겨 `unknown_running`이 된 실행) 새 요청 ID의 종료를 적지 않는다. 장부는 새 요청 ID면 받아 주므로 이 박자가 막는다. 앞 지시를 다시 보내는 것은 재전송 조각의 일이고, 이 박자는 같은 ID로 묻기만 한다(`cause: "stop_already_recorded"`).
- 대기 실행의 취소는 장부가 지시 없이 `not_started`로 닫는다(`closed_not_started`).
- 종료의 머리 `issued_at`은 장부 기록에 넘긴 시각이다(`envelopes.md` "시각 규칙").

## 확정

내지 않는다. 결과 보관(S6)이 없어 `resultSettled`는 늘 `false`이고, 판단이 그래도 확정을 내는 상태(`failed_stopped`·`cleanup_pending`)는 `finalize_withheld`로 남는다. 장부 포트에 확정 기록이 없다. 그 실행들은 자리를 쥔 채 남는다.

## 박자가 멈출 때

- **쓰기 전의 읽기를 해석하다 던지면 박자가 예외로 끝난다**(행의 칸 getter 등). 이때 장부 쓰기와 내보내기는 0이다.
- **포트의 예외는 그 항목의 결과다.** 난수는 `*_failed`의 `random_unavailable`, 장부가 던지면 `threw`, 서명·내보내기는 `*_recorded_not_sent`(`seal_threw`·`send_threw`), 시계는 `clock_unavailable`. 박자는 다음 실행을 본다.
- **그 밖의 예상하지 못한 예외**(장부 답의 칸을 읽다 던짐 등)는 남은 실행을 하지 않고 `halted: "threw"`, `haltedAt`은 그 실행이다. 그 전까지의 결과와 `pendingQueries`는 그대로다. 그 실행에 장부 쓰기가 있었는지 결과로는 모르므로 부르는 쪽은 결과 목록에 없는 실행을 장부에서 다시 읽는다.

## 내보내지 못했을 때

장부에 적은 뒤의 실패는 `*_recorded_not_sent`이고 새 요청 ID로 다시 만들지 않는다.

| `reason` | `delivery` |
|---|---|
| `ledger_answer_malformed`, `draft_threw`, 초안의 거절 이름, `seal_threw`, `sealDraft`의 거절 이름(`field`·`sealReason` 함께), `clock_unavailable`, `renew_margin_lost` | `not_sent` |
| `no_connection`, `too_late_to_send` | `not_sent` |
| `send_threw`, `send_answer_malformed` | `unknown`: 포트가 연결에 실었는지 모른다 |

## D-89의 한계(감독이 믿는 끝은 추정이다)

계약 v1의 갱신에는 영수증이 없어, 장부가 믿는 임대의 끝은 감독의 추정이다(`src/ledger/ledger.md` "갱신 뒤의 임대"·"남는 한계"). 이 박자는 그 추정이 틀릴 길 셋을 줄인다: 시작 접수가 장부에 닿기 전에는 갱신을 적지 않아 "실행기가 모르는 실행으로 거절하고 장부만 연장되는" 경우를 막고, 기록 직전과 싣기 직전에 여유를 다시 재어 늦게 낸 갱신을 적거나 싣지 않으며, 끝을 모르면 갱신 대신 같은 실행을 묻는다. 줄이지 못하는 것: 실행기가 이미 끝났는데(기한, 앞 임대의 만료, 자연 종료) 그 종료 영수증이 장부에 닿기 전이면 판단은 실행을 `running`으로 보고 갱신을 계속 적고, 장부의 끝은 실제보다 늦어진다. 적었지만 싣지 못한 갱신도 장부에는 믿는 끝으로 남는다. 자리는 종료 확인까지 쥐므로 일이 겹치지는 않고 그만큼 늦게 풀린다.

## 이 박자가 하지 않는 것

확정, 재전송(답 없는 지시를 같은 요청 ID로 다시 보내기), 영수증·보고의 처리, 배정·시작, 연결 상실의 반영(끊긴 실행기의 실행을 모름으로 옮김), 세션 실행의 수명, 비상 정지의 종료.

## 뒤 조각이 지킬 것

- **싣지 못한 갱신을 다음 갱신의 근거로 쓰지 않는다.** `renew_recorded_not_sent`의 갱신은 장부가 그 끝을 임대로 믿는다(장부에는 보냈는지의 표시가 없다). 다음 박자의 판단은 그 끝으로 다음 갱신을 고르므로, 실행기의 실제 끝(앞 임대)보다 늦게 닿는 갱신이 나갈 수 있다. 부르는 쪽이 그 실행의 임대를 모름으로 넘기는 입력(예: 싣지 못한 갱신의 실행 ID)을 이 박자에 더하거나, 같은 실행을 조회로 돌린다.
- **내보내기 포트가 갱신의 송신 규칙을 싣는 순간에 다시 본다.** 이 박자는 싣기 직전에 재지만 포트 안의 대기(연결 쓰기 등)는 재지 못한다. 포트가 봉투마다 "이 시각 뒤에는 싣지 않음"을 받으려면 `InstructionSink.send`에 그 시각을 넘기는 칸(예: `send(envelope, { notAfter })`)이 필요하다(`ports.ts`의 꼴을 바꾸는 일이라 이 PR에 없다). 그 전까지는 포트가 대조부터 싣기까지를 동기적으로 끝낸다.
- **`lastQueries`를 넘긴다.** 넘기지 않으면 조회가 필요한 실행을 박자마다 묻는다.
- **`pendingQueries`를 영수증 처리기에 더한다.** 더하지 않으면 그 조회의 답이 `unknown_query`로 버려진다.
- **정지 세대를 실행기와 맞춘다.** 정지 중의 종료는 장부의 지금 세대를 싣는다. 실행기가 그 세대를 적용하기 전이면 `requested`·`deadline` 종료를 받지 않는다(높은 세대는 `emergency_stop`만 받는다). 세대 맞춤과 비상 종료는 다른 조각이다.
- **`halted`를 본다.** `threw`이면 결과 목록에 없는 실행을 장부에서 다시 읽는다.
- **박자를 되풀이해 부른다.** 갱신을 낼 수 있는 구간은 기본값에서 7000ms라(`ledger.md` "판단을 갱신 구간 안에서 부른다") 그 안에서 여러 번 부른다.
