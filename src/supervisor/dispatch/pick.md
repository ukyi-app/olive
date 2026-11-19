# 배정 고르기 (`pick.ts`)

대기 부탁 하나를 어느 실행기에 맡길지 고르는 순수 판단이다. 장부·연결·계정·정책에서 읽은 값과 지금 시각을 받아, 장부의 `assignToolRequest`에 넘길 입력(실행 ID만 뺀 것) 또는 구별된 답 하나를 낸다. 장부를 열거나 쓰지 않고, 시계·난수·소켓·파일을 부르지 않는다.

고른 결과는 실행 허가가 아니다. 장부의 배정 연산이 정지·접수·꼴을 같은 트랜잭션에서 다시 보고, 시작은 그 뒤 `planNext`와 `startRun`이 따로 정한다.

## 공개 면

```ts
pickAssignment(input: PickInput): Pick

PickInput = {
  request: WaitingRequest       // { ref, role, inputDigest, input: { cancelled, expiresAt } }
  connections: Candidate[]      // Connections.candidates(...)의 출력 그대로
  assignment: AssignmentContext // roles/assign.ts의 허용 표·등록행·기대 revision
  accounts: AccountRef[]        // 배포가 주입한 계정 참조(고르는 것은 selectAccount)
  credential: CredentialRef | null // 고른 계정의 revision·digest. null이면 모름
  plans: RunPlan[]              // 역할마다 { role, snapshotDigest, budgetLeft, runDurationMs }
  facts: PreAssignFacts         // 아래 "배정 전 거절" 표의 사실
  intakeOpen: boolean           // Restorer.intakeOpen()
  now: number                   // 장부 시계와 같은 시계
}

Pick =
  | { kind: "assign", input: AssignmentInput, connection, candidate }
  | { kind: "intake_closed" }
  | { kind: "refused", reason: "input_cancelled" | "input_expired" | PreAssignFact }
  | { kind: "held", reason: "evidence_missing", missing: PreAssignFact[] }
  | { kind: "held", reason: "no_executor", holds: { connection, reason: HoldReason }[] }
  | { kind: "held", reason: "no_account", account: <selectAccount의 none 이유> }
  | { kind: "held", reason: "credential_unknown" | "credential_mismatch" | "plan_missing" }
  | { kind: "input_rejected", reason: PickRejectReason }
  | { kind: "input_rejected", reason: "assignment_input", assign: InputRejectReason }

AssignmentInput = Omit<AssignToolRequestInput, "runId">
```

`refused`는 부탁 자체가 배정될 수 없다는 뜻이고 다음 박자에도 같다. `held`는 지금 고를 수 없다는 뜻이고 입력이 바뀌면 달라질 수 있다. `input_rejected`는 부르는 쪽이나 주입 자료의 결함이다. `assign` 밖의 답은 모두 배정 입력을 만들지 않는다.

## 판단 순서

먼저 걸린 답 하나만 낸다.

1. 접수가 열리지 않았으면(`intakeOpen`이 `true`가 아니면) `intake_closed`. 다른 입력은 보지 않는다.
2. 시각·부탁의 꼴(`ref` UUID, 역할, `inputDigest` sha256, 취소 boolean, 만료 유한 수).
3. 입력 취소 → `input_cancelled`, 만료(`expiresAt <= now`, 장부 `queueView`와 같은 경계) → `input_expired`.
4. 배정 전 거절의 사실: 하나라도 `true`면 그 이름으로 `refused`, 아니면 `false`가 아닌 것을 모아 `evidence_missing`.
5. 연결마다 `judgeAssignment`. 입력 거절이 하나라도 나오면 그대로 `assignment_input`. 통과한 후보가 없으면 연결마다의 보류 이유를 연결 번호 순으로 `no_executor`.
6. `selectAccount(부탁의 역할, accounts)`. `none`이면 그 이유로 `no_account`.
7. 자격 참조: 없으면 `credential_unknown`, 꼴이 틀리면 `malformed_credential`, 고른 계정·방식과 다르면 `credential_mismatch`.
8. 그 역할의 정책: 없으면 `plan_missing`, 같은 역할이 둘이면 `duplicate_plan`, 꼴이 틀리면(예산 1 미만 포함) `malformed_plan`.

## 고르는 순서

통과한 후보가 둘 이상이면 실행기 이름(`executor/<역할>/<인스턴스>/<저장소>`, 장부에 적히는 `executorId`)의 문자열 오름차순으로 첫 것을 고른다. 이름이 같으면 연결 번호가 작은 쪽이다. 이름이 같으면 장부에 적히는 값이 같아 실행 줄은 어느 쪽이든 같다. 입력 목록의 순서는 결과를 바꾸지 않는다.

슬롯·부하·최근 사용 같은 기준은 쓰지 않는다. 작업자 슬롯은 하나뿐이고(B-07) 시작은 뒤 단계가 정한다.

## 배정 전 거절

설계 `supervisor.md` §4 `start_worker` 행의 거절과 장부 배정 연산이 보지 않는 입력의 취소·만료다. 판정할 입력이 이 모듈에 있으면 거절, 없으면 부르는 쪽이 사실(`facts`)로 채워야 하고 채우지 않으면 보류(입력 없음)다.

| 조건 | 이 모듈의 답 | 근거 입력 |
|---|---|---|
| 입력 취소 | 거절 `input_cancelled` | `request.input.cancelled` |
| 입력 만료 | 거절 `input_expired` | `request.input.expiresAt`, `now` |
| 허용되지 않은 역할·목적 조합 | 사실 `role_purpose_not_allowed`. 없으면 보류 | 없음(정책 판단은 도구 처리기의 포트) |
| 고정되지 않은 원본 | 사실 `source_not_pinned`. 없으면 보류. `inputDigest`가 sha256이 아니면 `malformed_request` | 꼴만 있음(소유자의 고정 입력인지는 없음) |
| 자기 저장소를 고치는 작성(D-25) | 사실 `self_repo_write`. 없으면 보류 | 없음 |
| 외부 코드 실행 | 사실 `external_code`. 없으면 보류 | 없음 |
| 스스로 고치는 작성인데 근거 문이 닫힘(D-34) | 사실 `self_fix_basis_closed`. 없으면 보류 | 없음 |
| 앞 실행의 종료 미확인 | 사실 `prior_run_end_unconfirmed`. 없으면 보류 | 없음(실행 목록을 받지 않음) |

이 사실을 채우는 쪽은 아직 없다. 그래서 지금은 어떤 부탁도 `assign`에 이르지 않는다. 틀리는 방향은 늘 "배정하지 않음"이다.

## 기한과 예산

예산(`budgetLeft`)과 snapshot digest는 그 역할의 `RunPlan`에서 그대로 옮긴다. 기한은 `min(now + runDurationMs, request.input.expiresAt)`이다: 입력이 만료된 실행은 장부가 시작하지 않으므로 그보다 늦은 기한은 쓸 수 없다. 숫자는 코드에 기본값이 없고, 값이 없으면 `plan_missing`이다.

## 다시 만들지 않는 것

역할·대상·등록·revision의 대조는 `roles/assign.ts`의 `judgeAssignment`, 계정은 `accounts/fixed.ts`의 `selectAccount`가 한다. 이 모듈은 그 결과를 옮길 뿐 검사를 다시 쓰지 않는다. 다른 역할의 실행기는 `judgeAssignment`가 `principal_role_mismatch`로 보류하므로 대신 고르지 않는다.

## 뒤 조각이 지킬 것

- 부르는 쪽은 `assign`을 받으면 새 UUID 실행 ID를 붙여 `assignToolRequest`에 그대로 넘기고, 장부의 거절을 따른다. `already_assigned`면 돌려받은 실행의 실행기·실행 ID를 쓴다.
- `credential`은 `selectAccount`가 고를 그 계정의 것이어야 한다. 다르면 `credential_mismatch`로 보류된다.
- `facts`를 채우는 어댑터는 장부의 고정 입력에서만 복원하고, 모르면 칸을 비운다(`false`로 채우지 않는다).
- `now`는 장부 시계와 같은 시계에서 읽고, `intakeOpen`은 같은 박자의 `Restorer.intakeOpen()`이다.
