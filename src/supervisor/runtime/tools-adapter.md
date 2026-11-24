# 도구 어댑터 (`tools-adapter.ts`)

감독 도구 처리기(`scheduler/tools.ts`의 `handleToolCall`)가 받는 포트 `ToolPorts`를 실제 장부·취소 어댑터·정책·설정에 잇는다. **지금 장부에 맞는 연산이 있는 포트 넷만 잇고, 없는 셋(`liveSession`·`inputPinned`·`readResult`)은 지어내지 않고 늘 모름으로 둔다.** 처리기는 `liveSession`을 도구마다 먼저 부르므로, 이 공장이 돌려준 포트 그대로는 **네 도구 모두 장부를 읽지도 쓰지도 않고 `unknown`이다.** 세션 계약(U6)이 그 연산을 낼 때까지 닫혀 있는 것이 정한 동작이다. 처리기를 부르는 곳(감독 진입점, 박자 잇기, 관리 통로)은 아직 없다.

상태를 갖지 않는다. 시계·난수·타이머·환경을 직접 부르지 않는다: 새 부탁 참조의 후보는 주입한 난수 포트로, 취소의 기록 시각은 취소 어댑터의 시계 포트로 만든다.

## 공개 면

```ts
createToolPorts(deps: ToolAdapterDeps): ToolPorts   // 얼린 객체. 장부 함수 다섯·judge·random.bytes·cancel.observe가 함수가 아니면 만들 때 TypeError

interface ToolAdapterDeps {
  ledger: ToolLedger;        // Pick<Ledger, "findToolRequest" | "readToolRequest" | "recordToolRequest" | "cancelToolRequest" | "unansweredInstructions">
  policy: ToolPolicyPort;    // 역할·목적 분류의 허용 판단. 처리기가 답을 확인한다
  config: ToolConfig;        // 만들 때 한 번 읽어 고정
  random: Random;            // 부탁 참조 후보와 취소 지시의 요청 ID. 암호학적 난수
  cancel: Omit<CancelPorts, "ledger" | "random">;  // links·clock·signer·sink·observe
}

CLOSED_PORTS = ["liveSession", "inputPinned", "readResult"]
LINKED_PORTS = ["findByRetryKey", "readOwnedWork", "recordStart", "requestCancel"]
```

취소 어댑터(`dispatch/cancel.ts`의 `cancelAdapter`)는 이 공장 안에서 만들고, **이 공장이 받은 장부·난수 객체를 그대로 넣는다.** 다른 열기의 장부나 다른 난수를 따로 넘기는 길이 없다.

## 지금 장부의 연산 (설계 조사와의 대조)

설계 조사는 olive main `109d162`을 읽었다. 그 뒤 `src/ledger/`·`result-store*.ts`·`tools.ts`·`cancel.ts`를 바꾼 커밋은 요청 예산(`1ef8ab4`, #58) 하나다(`git log 109d162..HEAD -- <그 경로들>`). 그 커밋은 `listRuns`의 `reservedBudget`과 `queue.ts`의 예산 판단을 더했고 도구 요청 연산은 바꾸지 않았다.

| 포트 | 조사 때 | 지금 | 근거 |
|---|---|---|---|
| `findByRetryKey` | `findToolRequest`로 이름 옮기기 | 같음 | `ledger.ts`의 `findToolRequest`(소유자·키로 찾음) |
| `readOwnedWork` | `readToolRequest`로 | 같음 | `readToolRequest`(소유자·참조로 찾음) |
| `recordStart` | `recordToolRequest`로 | 같음 | `recordToolRequest`(쓰기 모드 `start`, `created`·`existing`·`conflict`) |
| `requestCancel` | `cancelAdapter`로 | 같음 | `cancel.ts`의 `cancelAdapter`(안에서 `cancelToolRequest`) |
| `liveSession` | 없음(U6) | **여전히 없음**. `startSession`은 늘 `session_start_closed`이고, 지금 호출권을 가진 세션·세대를 읽는 연산이 없다 | `ledger.ts`의 `startSession` |
| `inputPinned` | 없음 | **여전히 없음**. 입력 줄(`inputs`)에는 입력 digest 칸이 없고(`0001-core.sql`), 원본 참조를 소유자로 대조해 읽는 연산도 없다(`listInputs`는 원문 참조를 싣지 않는다) | `migrations/0001-core.sql`의 `inputs`, `ledger.ts`의 `listInputs` |
| `readResult` | 없음(R2) | **여전히 없음**. 부탁 참조에서 이은 실행의 결과 참조·digest를 읽는 연산이 없다(결과 참조는 반영 전 보고에만 있다: `pendingReports`). 결과 보관소의 `readStored`는 참조·소유자·digest와 판정 포트(`ReadGate`)를 받는데 그 규칙(D-22·O18)을 정하지 않았다. 검사 통과의 근거도 장부에 없다 | `ledger.ts`의 `pendingReports`·`markResult`, `result-store.ts`의 `readStored` |

## 포트와 장부 연산의 대조

| 포트 | 장부 연산 | 뜻의 대조와 옮김 | 자리 |
|---|---|---|---|
| `findByRetryKey({ owner, retryKey })` | `findToolRequest({ owner, dedupeKey })` | 이름만 다르다(`retryKey` ↔ `dedupeKey`, `content` ↔ 펼친 네 칸). 소유자가 다른 줄은 `null`, 자기 줄인데 키가 다르면 모름 | `tools-adapter.ts:119`, `ownedRead` `:92` |
| `readOwnedWork({ owner, ref })` | `readToolRequest({ owner, ref })` | 같은 옮김. 소유자가 다른 줄은 `null`(처리기의 `not_found`), 자기 줄인데 참조가 다르면 모름 | `:126`, `:92` |
| `recordStart(input)` | `recordToolRequest({ ref: 후보, owner, dedupeKey, role, purpose, sourceRef, inputDigest, sessionId, callId, now })` | 후보는 `newUuid(random)`. 결과와 돌려준 줄을 넘긴 값과 대조한다(아래 표). 거절은 `stopped` → `stopped`, `intake_closed`·`snapshot_hold` → `intake_closed`(`ledger.md` "작업 부탁"의 옮김), 그 밖은 모름 | `:135`~`:168` |
| `requestCancel(input)` | `cancelAdapter`(→ `cancelToolRequest`, 지시를 적었으면 `unansweredInstructions`로 그 줄을 찾아 `task_cancel`을 한 번 보냄) | 취소 어댑터의 답 그대로: 적었으면 `{ ok: true, phase }`, `transition_denied`는 `already_ended`, 그 밖은 모름. 지시의 요청 ID는 호출마다 새 UUID(문맥의 `callId`가 아니다) | `:184` |
| `liveSession()` | 없음 | 늘 `{ known: false }` | `:174` |
| `inputPinned(query)` | 없음 | 늘 `{ known: false }` | `:178` |
| `readResult(ref)` | 없음 | 늘 `{ known: false }` | `:182` |

`recordStart`가 받는 답의 대조(`:157`~`:166`):

| 장부의 답 | 돌려준 줄 | 어댑터 |
|---|---|---|
| `created` | 소유자·키·내용이 넘긴 값, 참조가 넘긴 후보, 단계 `waiting_assignment` | 그 줄 |
| `existing` | 소유자·키·내용이 넘긴 값 | 그 줄(처리기는 같은 참조로 `ok`) |
| `conflict` | 소유자·키가 넘긴 값, 내용이 다름 | 그 줄(처리기가 내용을 대조해 `retry_conflict`) |
| 위와 어긋남, 모르는 결과, 꼴이 틀린 줄, 남의 줄 | | 모름. 쓰기는 이미 나갔을 수 있어 없음으로 바꾸지 않는다 |

## 닫은 포트와 그 이유

- **`liveSession`**: 장부에 세션을 여는 길이 닫혀 있고(`startSession`) 호출권을 가진 세션·세대를 읽는 연산이 없다. 참으로 지어내면 폐기된 세션의 호출이 통과하고, `null`로 지어내면 살아 있는 세션을 `session_retired`로 거절한다. 모름이면 처리기는 도구별 판단 전에 `unknown`으로 닫는다(`tools.ts`의 `run`: 문맥 → 정지 → 인자 → 살아 있는 세션).
- **`inputPinned`**: 입력 digest가 장부에 없어 "이 digest가 고정된 입력인가"를 장부가 답할 수 없다. 참이라고 답하면 고정되지 않은 입력에 작업이 접수되고, 거짓이면 모든 시작이 `input_not_fixed`가 된다. 모름이면 `start_worker`는 재시도 키 조회 전에 `unknown`이고 아무것도 적지 않는다.
- **`readResult`**: 위 표대로 읽을 연산과 판정 규칙이 없다. `{ state: "none" }`(처리기의 `result_not_ready`)으로 답하면 확정된 결과가 있는 작업을 "아직"이라고 말한다. 모름이면 `worker_result`는 자기 부탁에 `unknown`, 없는 부탁·남의 부탁에는 그 전 단계에서 같은 `not_found`다.

## 모름으로 닫히는 길

열(列)의 "처리기"는 그 포트에 닿을 때까지의 포트(닫힌 둘 포함)를 시험의 대역으로 연 뒤의 답이다. 이 공장 그대로는 첫 줄처럼 모두 `unknown`이다. "적힌 것"은 대기 부탁·실행 줄·답 없는 지시를 공개 읽기(`listWaitingToolRequests`·`listRuns`·`unansweredInstructions`)로 앞뒤 비교한 결과다. 시험 이름은 `test/supervisor/runtime/tools-adapter.test.ts`의 것이다.

| 포트 | 입력 | 어댑터의 반환 | 처리기의 답 | 적힌 것 | 시험 |
|---|---|---|---|---|---|
| (공장 그대로) | 네 도구, 자기 부탁 | `liveSession` 모름 | 넷 모두 `unknown` | 없음, 장부 호출 0 | "닫힌 포트: 공장이 돌려준 포트 그대로는" |
| `inputPinned` | 세션만 열고 `start_worker` | 모름 | `unknown` | 없음, 장부 호출 0 | "세션만 열면 입력 고정이 모름이라" |
| `readResult` | 자기 부탁 / 없는 부탁 / 남의 부탁 | 모름 / (안 부름) / (안 부름) | `unknown` / `not_found` / `not_found` | 없음 | "worker_result는 자기 부탁이면" |
| `findByRetryKey` | 새 키 | `null` | 기록으로 감 → `ok`, `waiting_assignment` | 대기 1줄 | "새 부탁은 대기로 한 줄" |
| `findByRetryKey` | 같은 재시도 키 두 번 | 자기 줄 | 같은 참조의 `ok`, 기록 안 부름 | 1줄 그대로 | 같음 |
| `findByRetryKey` | 같은 키, 내용이 다름 | 자기 줄 | `retry_conflict` | 그대로 | "같은 키에 내용이 다르면" |
| `findByRetryKey` | 다른 소유자의 같은 키(실제 장부) | `null` | 각자 `ok`, 답의 꼴이 같음 | 소유자마다 1줄 | "다른 소유자의 같은 키는" |
| `findByRetryKey` | 장부가 남의 줄을 줌(대역) | `null` | 자기 줄을 새로 적고 `ok`, 남의 참조는 답에 없음 | 자기 1줄 | "재시도 키 조회가 남의 줄을 주면" |
| `findByRetryKey` | 던짐 / Read 꼴 아님 / 단계가 틀린 자기 줄 / 소유자 칸 없음 / 다른 키의 자기 줄 | 모름 | `unknown`, 기록 안 부름 | 없음 | "재시도 키 조회가 던지거나" |
| `findByRetryKey` | 장부 읽기 실패(닫힌 장부) | 모름 | `unknown`, 기록 안 부름 | 없음 | "장부 읽기가 실패하면" |
| `recordStart` | 조회와 기록 사이에 같은 키가 생김 | `existing`의 그 줄 / `conflict`의 그 줄 | 같은 참조의 `ok` / `retry_conflict` | 1줄 그대로 | "조회와 기록 사이에" |
| `recordStart` | 장부가 정지 | `stopped` | `stopped` | 없음 | "장부가 정지면 stopped" |
| `recordStart` | 복원 중(접수 허가 없음) | `intake_closed` | `intake_closed` | 없음 | 같음 |
| `recordStart` | 사본 보류(대역) | `intake_closed` | `intake_closed` | (장부 대역) | "기록의 거절은" |
| `recordStart` | 정지 기록 없음(`stop_unknown`, 실제 장부) | 모름 | `unknown` | 없음 | "정지 기록이 없으면" |
| `recordStart` | 접수하지 않은 소유자(`invariant_violation`) | 모름 | `unknown` | 없음 | "접수하지 않은 소유자" |
| `recordStart` | 그 밖의 장부 거절 전부(`REFUSALS`를 하나씩, 대역) | 모름 | `unknown` | (장부 대역) | "기록의 거절은" |
| `recordStart` | 난수 포트가 후보를 못 만듦 | 모름, 장부 안 부름 | `unknown` | 없음 | "난수 포트가 참조 후보를" |
| `recordStart` | 남의 줄 / 다른 키 / 결과와 내용의 어긋남 / 후보가 아닌 새 참조 / 대기가 아닌 새 줄 / 모르는 결과 / 꼴이 틀린 줄 / 던짐(대역) | 모름 | `unknown` | (장부 대역) | "기록의 답이 넘긴 값과 맞지 않으면" |
| `readOwnedWork` | 자기 부탁 / 없는 부탁 / 남의 대기 부탁 / 남의 시작한 부탁 | 자기 줄 / `null` / `null` / `null` | 단계 / `not_found` 셋이 같은 답 | 없음 | "자기 부탁은 단계" |
| `readOwnedWork` | 장부가 남의 줄을 줌(꼴이 틀려도) | `null` | `not_found` | 없음 | "참조 읽기가 남의 줄을 주면" |
| `readOwnedWork` | 던짐 / 읽기 실패 / 꼴이 틀린 자기 줄 / 소유자가 문자열이 아님 / 다른 참조의 자기 줄 | 모름 | `unknown` | 없음 | 같음 |
| `requestCancel` | 대기 부탁, 두 번 | `not_started` / `already_ended` | `accepted`·`not_started` / `already_ended` | 부탁이 `not_started`, 지시 0, 보냄 0 | "대기 부탁은 not_started로" |
| `requestCancel` | 배정됐고 시작 전, 두 번 | `not_started` / `already_ended` | 같음 | 실행 `not_started`, 지시 0 | "배정됐지만 시작 전인" |
| `requestCancel` | 시작한 실행 | `stopping` | `accepted`·`stopping` | `task_cancel` 1줄(요청 ID ≠ 문맥 `callId`), 한 번 보냄 | "시작한 실행은 stopping으로" |
| `requestCancel` | 남의 부탁 | (안 부름: 읽기에서 `null`) | `not_found` | 그대로, 관측 0 | "남의 부탁은 not_found" |
| `requestCancel` | 장부의 `stop_unknown` / `invariant_violation` / 던짐(대역) | 모름 | `unknown`, 보냄 0 | (장부 대역) | "장부의 stop_unknown" |
| `requestCancel` | 같은 호출 ID로 두 번(시작한 실행) | `stopping` 둘 | 둘 다 `accepted` | 서로 다른 요청 ID의 지시 2줄 | "같은 호출 ID로 두 번" |
| (모든 포트) | 예산 소진·보류 | 이 길에 예산 판단이 없다 | 대기로 접수, 단계는 장부의 것 | 대기 줄 | 해당 없음(아래 "남는 한계") |

훑은 결과: 모름이 없음으로 바뀌는 칸, 남의 줄이 읽히거나 취소되는 칸, 같은 소유자의 같은 키로 두 줄이 적히는 칸, 확정 전 결과가 본체에 넘어가는 칸은 없다. 같은 호출 ID의 두 번째 취소는 모름이 아니라 접수다(아래 C32).

## 지킨 조건

| 번호 | 조건 | 자리 | 시험 | 원문 |
|---|---|---|---|---|
| C28 | 취소 어댑터의 관측은 부르기 전에 등록하고, 관측에 새 쓰기를 잇지 않는다 | 관측 포트는 공장을 만들 때 받고 없으면 던진다(`:207`, `:192`). 이 어댑터는 관측을 그대로 넘길 뿐 받아서 쓰지 않는다. 관측을 받는 쪽이 새 쓰기를 잇지 않는 것은 조립(N5)의 몫 | "대기 부탁은 not_started로"(처리기가 답하기 전에 관측이 와 있음), "조립: 취소 관측 포트" | `dispatch/cancel.md` "관측을 받는다" |
| C31 | 처리기 포트와 장부의 어긋남을 어댑터로 | 이름 옮기기 넷(`:119`, `:126`, `:135`, `:184`), 없는 연산 셋은 모름(`:174`, `:178`, `:182`) | 위 표 전부 | `scheduler/tools.ts`의 `ToolLedgerPort`, `ledger.md` "작업 부탁" |
| C32 | `stop_unknown`·같은 호출 ID 재호출은 `unknown` | `stop_unknown`은 기록(`:152`)과 취소(`cancelAdapter`) 모두 모름. 같은 호출 ID의 재호출은 **장부에서 부딪히는 길이 없다**: 시작은 재시도 키가 같아 같은 줄의 `ok`, 취소는 호출마다 새 요청 ID라 지시가 한 줄 더 적히고 `accepted`. 장부의 남은 `invariant_violation`은 모름 | "정지 기록이 없으면", "장부의 stop_unknown", "같은 호출 ID로 두 번", "같은 재시도 키를 다시" | `dispatch/cancel.md` "세션 재호출" |
| C33 | `credential`은 `selectAccount`가 고른 계정의 것 | **이 어댑터의 면에 닿지 않는다.** 도구 요청은 실행기·자격 없이 대기로 적히고(`recordToolRequest`), 자격은 배정 박자(`assign-loop.ts`의 `credentials`)가 고른다. 이 모듈은 자격을 받지도 만들지도 않는다 | 정적 시험(배정 연산 `assignToolRequest`를 부르지 않음) | `dispatch/pick.md` "뒤 조각이 지킬 것" |
| C34 | `facts`는 대조한 근거로만, 모르면 비움 | **이 어댑터의 면에 닿지 않는다**(`facts`는 배정 고르기의 입력). 같은 원칙을 이 어댑터의 답에 적용했다: 장부가 답하지 못한 것은 채우지 않고 모름(닫은 셋, `ownedRead`) | 위 표의 모름 칸 | `dispatch/pick.md` "뒤 조각이 지킬 것" |
| C35 | `tools.ts` 깊이 16·17과 설정 0의 회귀 시험 | **해당 없음**: `tools.ts`를 고치지 않았다 | | `tools.ts` 리뷰의 P3 |

## 정한 것

- **세션·입력 고정의 주입 자리를 두지 않았다.** 공장이 `liveSession`·`inputPinned`를 바깥에서 받게 하면 장부가 아닌 값이 그 자리를 채울 수 있다. 그 연산이 장부에 생기면 이 파일에서 잇는다. 시험은 처리기 포트의 그 칸만 대역으로 바꿔 나머지 이은 넷을 실제 장부로 돈다.
- **소유자가 다른 줄은 모름이 아니라 없음이다.** 처리기 포트의 전제(`tools.ts`의 `findByRetryKey` 주석)대로다. 그래야 남의 줄이 있든 없든 답이 같다(모름으로 답하면 그 키·참조에 남의 줄이 있다는 것이 드러난다). 장부의 두 조회는 SQL에서 이미 소유자로 거르므로 이 대조는 손상된 장부에서만 갈린다.
- **자기 줄인데 묻는 키·참조가 다르면 모름이다.** `not_found`로 답하면 본체가 자기 작업을 잃은 것으로 안다.
- **기록의 `now`는 처리기 문맥의 `now`다.** 부탁의 기록 시각은 대기 목록의 순서에만 쓰이고(`ledger.md` "대기 부탁의 목록": 뒤집혀도 참조로 가른다), 포트의 뜻이 그 값이다. 취소의 기록 시각은 취소 어댑터가 장부와 같은 시계에서 다시 읽는다.
- **설정은 만들 때 한 번 읽는다.** 처리기는 호출마다 `purposeBriefMaxChars`를 검사하므로 틀린 값이면 모든 호출이 `context_invalid`다.

## 이 모듈에 없는 것

처리기를 부르는 곳(감독 진입점 N5, 박자 잇기, 관리 통로), 세션 계약(U6)의 장부 연산, 입력 고정의 장부 연산, 결과 읽기(R2와 결과 보관소의 판정 규칙), 같은 호출 ID의 답 재생, 정책 표(역할·목적 분류의 허용 조합)의 값.

## 뒤 조각이 지켜야 할 것

- **U6(세션 계약):** 지금 호출권을 가진 세션 ID와 세대를 장부에서 읽는 연산을 내고 `liveSession`을 그것에 잇는다. 읽지 못하면 `{ known: false }`, 살아 있는 세션이 없음을 장부에서 확인했을 때만 `null`이다. 같은 호출 ID의 답 재생(저장의 담당, 범위, 보존 기간)도 여기서 정한다. 그 전까지 시작한 실행의 같은 취소를 다시 보내면 지시가 한 줄씩 더 적힌다(`cancel.md` "세션 재호출").
- **입력 고정 연산:** 접수한 입력의 digest(또는 그것을 대조할 근거)를 장부에 두고 `(owner, sourceRef, inputDigest)`가 그 소유자의 고정된 입력인지 답하는 읽기를 낸 뒤 `inputPinned`에 잇는다. 모르면 모름이다(거짓으로 바꾸지 않는다).
- **R2·결과 읽기:** 부탁 참조(소유자 대조 뒤)에서 이은 실행의 결과 참조·digest·검사 통과·정리 대기를 읽는 장부 연산과 `ReadGate`의 규칙을 정한 뒤 `readResult`를 `readStored`에 잇는다. 확정 전(결과 참조 없음)이면 `none`, 읽기 실패·판정 모름이면 모름이다. `readResult(ref)`는 소유자를 받지 않으므로 그 읽기가 소유자를 다시 대조할 근거를 함께 줘야 한다.
- **N5(진입점):** 처리기에 넘길 포트는 이 공장 하나로 만든다. 장부는 박자·표식·처리기와 **같은 열기의 객체**, 취소의 `clock`은 **장부에 주입한 시계와 같은 시계**(공유 비후퇴 시계), `random`은 암호학적 난수, `links`는 그 실행기의 `Link`와 부르는 순간의 시각으로 계약 v1의 `mayIssue`를 동기로 부르는 문, `sink`는 싣는 순간 시한·정지 세대·대상 연결을 다시 보는 내보내기 포트(`runtime/sink.ts`)다. 처리기 문맥의 `now`도 같은 시계에서 읽는다. 관측(`observe`)은 받는 쪽을 먼저 붙이고, 관측에 새 쓰기나 새 요청 ID의 발급을 잇지 않는다(`record_unknown`은 `unansweredInstructions()`에서 그 요청 ID를 찾았을 때만 적혔다고 본다). 처리기 호출과 박자는 같은 이벤트 루프에서 겹치지 않게 부른다(취소 어댑터는 시계 읽기부터 지시 줄 대조까지 동기다).
- **관리 통로:** 도구 처리기의 포트를 관리 명령에 다시 쓰지 않는다. 소유자를 가리지 않는 읽기(`listWaitingToolRequests`)를 이 포트에 잇지 않는다(본체가 남의 부탁을 알게 된다).
- **이 파일을 고치는 쪽:** 닫은 포트를 열 때 `CLOSED_PORTS`·`LINKED_PORTS`와 시험의 "닫힌 포트" 묶음을 함께 고친다.

## 남는 한계

- **지금은 네 도구가 모두 `unknown`이다.** 감독을 켜도 본체는 작업을 맡길 수 없다. U6과 입력 고정 연산이 둘 다 생겨야 `start_worker`가 적고, `worker_result`는 R2 뒤에야 결과를 낸다.
- **예산은 이 길에서 보지 않는다.** 요청 예산(`listRuns`의 `reservedBudget`, `queue.ts`의 예산 판단)은 배정·시작 때 판단한다. 예산이 다한 요청의 `start_worker`도 대기로 접수되고 단계는 `waiting_assignment`로 남는다(거짓은 아니지만 본체는 그 작업이 언제 돌지 모른다).
- **같은 호출 ID의 재호출:** 시작한 실행의 취소를 같은 호출로 다시 보내면 지시가 한 줄 더 적히고 그 기록 시각이 수명 박자의 첫 상태 조회를 늦춘다(`cancel.md` "세션 재호출").
- **장부 조회의 소유자 대조는 SQL에도 있어** 어댑터의 대조가 실제로 갈리는 것은 손상된 장부에서뿐이다. 그 칸은 대역으로만 시험했다.
- **정책 포트의 값은 이 모듈이 정하지 않는다.** 역할·목적 분류의 허용 조합은 설계에 표가 없고, 조립이 넣는 정책이 처리기에 그대로 간다.
