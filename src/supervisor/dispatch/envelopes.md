# 지시 봉투 만들기 (`envelopes.ts`, `ports.ts`)

장부에 적힌 지시를 계약 v1 봉투로 만드는 순수 함수와, 배정기가 바깥과 닿는 포트의 타입이다. 장부를 열지 않고 소켓·타이머·파일을 쓰지 않는다. 시각은 인자로, 난수와 서명은 포트로만 받는다. 계약은 `src/contract/v1/index.ts`, 장부는 `src/ledger/index.ts`의 공개 면만 쓴다.

## 두 단계

| 단계 | 함수 | 정해지는 것 |
|---|---|---|
| 초안 | `startDraft`, `renewDraft`, `stopDraft`, `finalizeDraft`, `statusQueryDraft`, `ackDraft` | 받는 쪽, 요청 ID, 정지·실행 세대, 본문, 장부가 정한 발행 시각(`issuedAt`) |
| 봉하기 | `sealDraft(draft, now, { random, signer })` | nonce(난수 포트 16바이트), 이번 발행 시각, `expires_at`, 서명 |

같은 지시 기록에서 만든 초안은 같다. 같은 초안을 다시 봉하면 요청 ID와 본문 digest가 같은 새 봉투다(재전송). 계약 v1은 nonce를 한 번만 받으므로 봉투를 그대로 다시 보내지 않는다.

## 시각 규칙

| 지시 | 머리 `issued_at` | 다시 봉하면 |
|---|---|---|
| `task_start` | 장부가 시작 트랜잭션에서 정한 발행 시각(`instructionTimes(runId).lease.issuedAt`) | 같은 `issued_at`·`expires_at`, nonce만 다름 |
| `run_renew` | `recordRenewInstruction`에 넘긴 `now`. 본문 `lease_until`은 그 답의 `leaseUntil` | 같은 `issued_at`·`expires_at`, nonce만 다름 |
| `task_cancel`, `session_stop`, `result_finalize` | 봉하는 때의 `now`(처음 봉할 때는 장부 기록에 넘긴 `now`) | 새 `issued_at`·`expires_at`, 새 nonce |
| `status_query`, `ack` | 봉하는 때의 `now`. 장부에 적지 않는 메시지라 처음 봉할 때도 장부의 기록 시각이 없다 | 새 `issued_at`·`expires_at`, 새 nonce |

**시작·갱신의 시각을 옮기지 않는 이유:** 실행기는 머리 `issued_at`에서 임대 끝을 정하고(시작은 `issued_at + RUN_LEASE_MAX_MS`), 장부도 같은 식으로 기록한 발행 시각에서 계산한다. 다시 봉할 때 시각을 늦추면 실행기의 임대 끝이 장부의 계산보다 늦어지고, 시한(30초)이 지난 시작 지시가 다시 살아난다. 그래서 시작·갱신 초안은 발행 시각 없이는 만들 수도 봉할 수도 없고(타입이 `number`를 요구하고, 비어 있으면 `issued_at_unknown`), 재전송은 장부 발행 시각의 시한 안, 곧 `issued_at + MESSAGE_TTL_MS - DELIVERY_MAX_MS - CLOCK_SKEW_MS`(발행 + 19000ms)까지만 된다. 그 뒤는 `too_late_to_send`이고 같은 실행 ID를 조회한다.

**봉투 시한과 작업 기한의 여유:** 실행기는 자기 시계로 받는 시각이 `expires_at`이나 시작의 `deadline_at` 이후면(정각 포함) `expired`·`deadline_passed`로 거절한다. v1의 `not_yet_valid`는 발행 시각이 실행기 시계보다 `CLOCK_SKEW_MS`까지 앞서도 받아 줄 뿐, 실행기 시계가 감독보다 앞서는 것을 막지 않는다. 그래서 봉할 때 두 시각 모두 `DELIVERY_MAX_MS + CLOCK_SKEW_MS`(11000ms) 이상 남아야 한다(모자라면 `too_late_to_send`, `deadline_too_close`). 전달이 `DELIVERY_MAX_MS` 미만이고 두 시계의 차이가 어느 쪽으로든 `CLOCK_SKEW_MS` 이하이면, 실행기 시계의 받는 시각은 두 시각보다 이르다. 계약의 `maySend`는 `DELIVERY_MAX_MS`만 보므로 이 모듈은 그보다 넓은 여유를 직접 잰다.

**종료·확정·조회·ack의 시각을 새로 두는 이유:** 계약의 받는 쪽은 발급 시각과 시한만 보고, 이 메시지들은 본문에 발급 시각과 묶인 값이 없다. 같은 요청 ID로 다시 보냈을 때 실행기의 답은 동작마다 다르다.

- `task_cancel`·`result_finalize`: 그 요청 ID로 이미 낸 영수증(취소는 `receipt_accepted`, 확정은 `receipt_cleaned`)이 있고 본문이 같으면 그 영수증을 다시 보낸다. 같은 요청 ID에 다른 본문이면 답하지 않는다.
- `status_query`: 받을 때마다 그때의 상태로 새 `status_report`를 만들고 `in_reply_to`에 조회의 요청 ID를 싣는다. 같은 조회를 두 번 보내면 보고가 둘이고 내용이 다를 수 있다.
- `ack`: 아직 표시하지 않은 영수증·보고만 받음으로 표시하고 답하지 않는다. 다시 보내도 오는 것이 없다.
- `session_stop`: 세션 실행기 쪽의 처리는 이 조각에서 확인하지 않았다.

## 거절

봉투를 만들지 않을 때는 `{ ok: false, reason }`이다(`REFUSAL_REASONS`). 값을 지어내지 않는다.

- **입력이 모자람:** `issued_at_unknown`(시작·갱신의 발행 시각 모름), `lease_unknown`(갱신의 임대 끝 모름), `missing_field`(`field`에 칸 이름), `random_unavailable`(난수 포트가 길이가 다른 값을 줌).
- **꼴·관계:** `input_malformed`(입력·`run`·초안이 객체가 아니거나 모르는 동작 이름, `field`에 칸 이름), `stop_generation_invalid`(0 이상의 안전 정수가 아님), `run_generation_invalid`(실행에 묶인 지시는 1 이상, 조회·ack는 0이 아님), `not_worker_run`, `recipient_invalid`(동작의 받는 쪽 종류가 아님), `role_mismatch`, `budget_exhausted`, `lease_out_of_range`(발급 시각 이하이거나 발급 + `RUN_LEASE_MAX_MS` 초과), `deadline_not_after_issue`, `run_ids_invalid`(1~8개, 중복 없음), `ids_invalid`(1~32개, 중복 없음).
- **봉하는 때:** `bad_time`, `issued_in_future`(장부의 발행 시각이 `now`보다 늦음), `deadline_passed`(작업 기한이 `now` 이하), `deadline_too_close`(작업 기한까지 `DELIVERY_MAX_MS + CLOCK_SKEW_MS`보다 적게 남음), `too_late_to_send`(남은 시한이 `DELIVERY_MAX_MS + CLOCK_SKEW_MS`보다 짧음), `seal_refused`(계약의 `SealError`, `sealReason`에 계약 사유), `signer_mismatch`(서명 포트가 돌려준 봉투가 넘긴 값과 다름).

초안의 세대·발행 시각 검사는 초안을 만들 때와 봉할 때 같은 함수로 한 번씩 한다. 그래서 공개 `Draft`를 직접 고쳐 봉해도 같은 거절이 나온다.

**서명 포트 대조:** 서명 포트에 넘기기 전에 본문의 정규 바이트와 digest, 기대하는 머리(계약 판부터 nonce까지 11칸)를 따로 만들고, 포트에는 그 바이트에서 다시 만든 본문 사본을 넘긴다. 돌려받은 봉투는 칸이 `header`·`signature`·`body` 셋뿐이고, 서명이 문자열이며, 머리 전체와 본문이 그 기준과 같은 정규 바이트일 때만 내보낸다. 내보내는 봉투는 포트가 돌려준 객체가 아니라 기준 머리, 보관한 정규 바이트에서 새로 만든 본문, 서명 문자열로 새로 만든 것이다. 그래서 포트가 받은 본문을 고쳐도 기준과 초안은 바뀌지 않고, 포트가 입력이나 자기 반환값을 `sealDraft`가 돌아온 뒤에 고쳐도 내보낸 봉투는 바뀌지 않는다. 한계: 서명 바이트는 공개 키가 없어 대조하지 않는다. 감독의 키로 머리에 맞게 서명했는지는 받는 쪽 `verifyEnvelope`만 안다.

## 포트 (`ports.ts`)

| 포트 | 꼴 | 조건 |
|---|---|---|
| `Clock` | `now(): number` | 장부 시계와 같은 시계, 후퇴하지 않음, 안전 정수 밀리초 |
| `Random` | `bytes(length): Uint8Array` | 암호학적 난수(CSPRNG). 요청 ID·nonce·실행 ID가 모두 여기서 온다 |
| `Signer` | `seal(input: SealInput): Envelope` | 감독의 개인 키로 계약의 `sealEnvelope`를 그대로 부른다. 키는 이 구현만 쥔다. 서명 바이트는 모듈이 대조하지 못한다 |
| `InstructionSink` | `send(envelope): Promise<"sent" \| "no_connection" \| "too_late_to_send">` | 실제로 싣는 시각에 연결, 봉투 시한과 (시작이면) 작업 기한의 여유를 다시 본다. `sent`는 받았다는 뜻이 아니다 |
| `CredentialPort` | `reference({ account, method })` | 자격의 revision·digest를 붙인다. 아직 쓰는 곳이 없다 |

## 만들지 않는 것

감독이 내는 v1 동작 가운데 `session_start`(세션 계약, 장부가 `session_start_closed`로 닫음)와 `stop_sync_reply`(연결의 첫 단계, 그 연결의 challenge에 답함)는 여기서 만들지 않는다. 시험이 계약의 동작 표와 대조해 이 둘만 빠졌음을 지킨다.

## 뒤 조각이 지킬 것

- 봉투는 장부의 기록(`startRun`·`record*Instruction`·`cancelToolRequest`)이 커밋한 뒤에만 만든다. 장부가 거절했으면 초안을 만들지 않는다.
- 시작 지시의 `issuedAt`은 장부가 정한 값만 넣는다. `instructionTimes`의 `lease.issuedAt`은 갱신이 적히면 갱신의 시각으로 바뀌므로, 갱신 뒤에 시작 지시를 다시 만들 수 없다. 지시마다의 발행 시각과 본문 칸은 장부가 보존해야 한다(재전송 작업).
- `statusQueryDraft`·`ackDraft`의 요청 ID는 이 함수가 새로 만든다. 조회는 그 초안을 보존해 `status_report.in_reply_to`와 대조한다.
- `InstructionSink`의 결과가 `no_connection`·`too_late_to_send`이면 새 요청 ID나 새 실행 ID로 다시 만들지 않는다.
