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
| `task_cancel`, `session_stop`, `result_finalize`, `status_query`, `ack` | 봉하는 때의 `now`(처음 봉할 때는 장부 기록에 넘긴 `now`) | 새 `issued_at`·`expires_at`, 새 nonce |

**시작·갱신의 시각을 옮기지 않는 이유:** 실행기는 머리 `issued_at`에서 임대 끝을 정하고(시작은 `issued_at + RUN_LEASE_MAX_MS`), 장부도 같은 식으로 기록한 발행 시각에서 계산한다. 다시 봉할 때 시각을 늦추면 실행기의 임대 끝이 장부의 계산보다 늦어지고, 시한(30초)이 지난 시작 지시가 다시 살아난다. 그래서 시작·갱신의 재전송은 장부 발행 시각의 시한 안, 곧 `issued_at + MESSAGE_TTL_MS - DELIVERY_MAX_MS`까지만 된다. 그 뒤는 `too_late_to_send`이고 같은 실행 ID를 조회한다.

**종료·확정·조회·ack의 시각을 새로 두는 이유:** 계약의 받는 쪽은 발급 시각과 시한만 보고, 이 지시들은 본문에 발급 시각과 묶인 값이 없다. 같은 요청 ID·같은 본문이면 실행기가 같은 영수증을 다시 낸다.

## 거절

봉투를 만들지 않을 때는 `{ ok: false, reason }`이다(`REFUSAL_REASONS`). 값을 지어내지 않는다.

- **입력이 모자람:** `issued_at_unknown`(시작의 발행 시각 모름), `lease_unknown`(갱신의 임대 끝 모름), `missing_field`(`field`에 칸 이름), `random_unavailable`(난수 포트가 길이가 다른 값을 줌).
- **꼴·관계:** `not_worker_run`, `recipient_invalid`(동작의 받는 쪽 종류가 아님), `role_mismatch`, `budget_exhausted`, `lease_out_of_range`(발급 시각 이하이거나 발급 + `RUN_LEASE_MAX_MS` 초과), `deadline_not_after_issue`, `run_ids_invalid`(1~8개, 중복 없음), `ids_invalid`(1~32개, 중복 없음).
- **봉하는 때:** `bad_time`, `issued_in_future`(장부의 발행 시각이 `now`보다 늦음), `deadline_passed`(작업 기한이 `now` 이하), `too_late_to_send`(남은 시한이 `DELIVERY_MAX_MS`보다 짧음, 계약의 `maySend`), `seal_refused`(계약의 `SealError`, `sealReason`에 계약 사유), `signer_mismatch`(서명 포트가 넘긴 값과 다른 머리·본문을 실음).

## 포트 (`ports.ts`)

| 포트 | 꼴 | 조건 |
|---|---|---|
| `Clock` | `now(): number` | 장부 시계와 같은 시계, 후퇴하지 않음, 안전 정수 밀리초 |
| `Random` | `bytes(length): Uint8Array` | 암호학적 난수(CSPRNG). 요청 ID·nonce·실행 ID가 모두 여기서 온다 |
| `Signer` | `seal(input: SealInput): Envelope` | 감독의 개인 키로 계약의 `sealEnvelope`를 그대로 부른다. 키는 이 구현만 쥔다 |
| `InstructionSink` | `send(envelope): Promise<"sent" \| "no_connection" \| "too_late_to_send">` | 싣는 순간 연결과 남은 시한을 다시 본다. `sent`는 받았다는 뜻이 아니다 |
| `CredentialPort` | `reference({ account, method })` | 자격의 revision·digest를 붙인다. 아직 쓰는 곳이 없다 |

## 만들지 않는 것

감독이 내는 v1 동작 가운데 `session_start`(세션 계약, 장부가 `session_start_closed`로 닫음)와 `stop_sync_reply`(연결의 첫 단계, 그 연결의 challenge에 답함)는 여기서 만들지 않는다. 시험이 계약의 동작 표와 대조해 이 둘만 빠졌음을 지킨다.

## 뒤 조각이 지킬 것

- 봉투는 장부의 기록(`startRun`·`record*Instruction`·`cancelToolRequest`)이 커밋한 뒤에만 만든다. 장부가 거절했으면 초안을 만들지 않는다.
- 시작 지시의 `issuedAt`은 장부가 정한 값만 넣는다. `instructionTimes`의 `lease.issuedAt`은 갱신이 적히면 갱신의 시각으로 바뀌므로, 갱신 뒤에 시작 지시를 다시 만들 수 없다. 지시마다의 발행 시각과 본문 칸은 장부가 보존해야 한다(재전송 작업).
- `statusQueryDraft`·`ackDraft`의 요청 ID는 이 함수가 새로 만든다. 조회는 그 초안을 보존해 `status_report.in_reply_to`와 대조한다.
- `InstructionSink`의 결과가 `no_connection`·`too_late_to_send`이면 새 요청 ID나 새 실행 ID로 다시 만들지 않는다.
