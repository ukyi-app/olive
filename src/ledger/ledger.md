# 감독 장부 요약

감독 장부(D-56)의 스키마, 쓰기 규칙, 재시작 복원 순서다. 코드는 `src/ledger/`(공개 면은 `index.ts`), 설계의 기준은 homelab `docs/plans/2026-11-13-olive/supervisor.md` §3·§8이다. 표와 코드가 다르면 코드가 맞고, 이 문서를 고친다.

## 파일과 잠금

- SQLite 파일 하나, 감독 하나만 쓴다. `openLedger(path, { clock })`가 연다. 실패하면 장부 객체 없이 이유(`locked`, `corrupt`, `full`, `io`, `too_new`, `migration_mismatch`, `migration_failed`)를 돌려준다.
- **잠금:** `locking_mode=EXCLUSIVE`와 빈 `BEGIN IMMEDIATE`로 여는 순간 파일 잠금을 잡고 닫을 때까지 쥔다. 둘째 작성자는 같은 프로세스든 다른 프로세스든 `SQLITE_BUSY`로 `locked`다(`busy_timeout` 0). 프로세스가 죽으면 운영체제가 잠금을 푼다.
- **저널:** `journal_mode=WAL`, `synchronous=FULL`. 커밋마다 WAL을 fsync하므로 커밋을 돌려준 실행 줄은 전원이 나가도 남고, 감독은 실행 줄의 커밋 뒤에만 지시를 내므로 접수 기록이 영수증보다 먼저 남는다. `NORMAL`은 마지막 커밋을 잃을 수 있어 고르지 않았다. EXCLUSIVE라 `-shm` 파일이 없다. 로컬 볼륨 전제다.
- 열 때 `quick_check`로 깨진 파일을 거른다. `foreign_keys=ON`.

## 마이그레이션

`migrations/NNNN-이름.sql`을 번호 순서대로 한 번씩 적용한다. 판 하나는 트랜잭션 하나라 도중에 실패하거나 끊기면 그 판 전체가 되돌려진다. 적용 기록은 `ledger_migrations(version, name, applied_at)`. 번호가 비거나, 폴더에 꼴이 다른 파일이 있거나, 장부의 판이 코드보다 높거나, 같은 번호의 이름이 다르면 열지 않는다. 적용된 파일은 고치지 않고 다음 번호로 더한다.

## 표(0001-core)

| 묶음 | 표 | 요지 |
|---|---|---|
| 정지·일시 중지 | `stop_state`, `diagnosis_pause` | 정지 세대(0 포함, 줄이 없으면 모름), 정지 여부, 확인 단계, 진단 일시 중지의 끝 |
| 실행·슬롯·예산 | `runs`, `run_epoch`, `run_transitions`, `instructions` | 실행 ID·세대·역할·revision 둘·snapshot·실행기·자격 네 칸·기한·남은 예산·상태·영수증 id들. 낸 지시 |
| 입력·대기열 | `inputs` | 요청 ID, 인증된 출처, 원문 참조와 만료, 순번, 취소 |
| 영수증·보고 | `deliveries`, `receipt_conflicts` | 받은 id와 본문 digest, 같은 id에 다른 digest의 기록 |
| 세션·인계 | `sessions`, `rule_checks`, `session_takeovers`, `start_permit_uses` | 세션 ID, 세대 표식 digest, 교체 시각, 처리 위치, 인계 참조, 규칙 확인(D-51), 인수 영수증(D-50), 시작 허가의 한 번 사용 |
| 게시 연결 | `publications` | 현관 작업 ID, 후보 digest, 대기·확정·모름(확정이면 posted·not_posted) |
| nonce | `nonces` | 감독이 받는 봉투의 (낸 쪽, nonce). 계약의 `NonceStore` |

**넣지 않는 것:** 원문(요청 글, 모델 출력, 로그)과 자격 값. 원문은 참조와 만료만, 자격은 계정·방식·revision·digest만 둔다. 쓰기 함수는 정해진 칸만 받고(모르는 칸이면 `LedgerInputError`), 글자 칸은 공백 없는 짧은 식별자만 받는다. `test/ledger/static.test.ts`가 스키마와 입력 타입의 칸 이름을 막는다.

## 쓰기 규칙

- **실행 줄이 먼저:** `admitRun`이 대기(`queued`)로 실행 줄을 적는다. `startRun`·`startSession`이 자리를 잡고(`preparing`) 시작 지시를 적은 커밋이 끝난 뒤에만 지시를 보낸다. 영수증은 장부에 적힌 지시만 가리킬 수 있다. 같은 중복 키는 같은 실행을 돌려준다.
- **영수증:** 같은 id·같은 digest는 한 번만 반영하고 다시 받으면 `duplicate`(ack는 다시 준다). 같은 id에 다른 digest는 `receipt_conflicts`에 남기고 `receipt_conflict`. 반영할 수 없는 영수증(실행·지시 없음, 허용되지 않은 전이)은 적지 않는다. 영수증과 그 상태 전이는 한 트랜잭션이다.
- **상태 전이:** `states.ts`의 표만 허용한다. 같은 표가 장부의 `run_transitions`와 트리거에 있다. 종료 확인(`stop_receipt_id`) 없이 `checking`·`ready_result`·`failed_stopped`·`cleanup_pending`이 되지 않는다(CHECK). `not_started`는 지시를 내기 전(`queued`)에서만 간다. 종료 확인 영수증의 `exit`가 `completed`면 `checking`, 그 밖이면 `failed_stopped`다.
- **슬롯:** 작업자 하나, 세션 하나(부분 유일 인덱스). `queued`·`finalized`·`not_started` 밖은 모두 자리를 쥔다. 그래서 `unknown_running`·`cleanup_pending`이 있으면 새 실행은 `slot_busy`다.
- **정지:** 0도 줄로 적는다. 낮은 세대로 덮지 않는다(코드와 트리거 둘 다). 정지 중이거나 기록이 없거나 지시의 세대가 장부와 다르면 새 실행과 자격의 근거(`startRun`이 돌려주는 자격 네 칸)를 주지 않는다.
- **예산:** 남은 예산은 늘지 않는다(트리거).
- **못 씀:** 쓰기나 읽기가 한 번 실패하면 다시 열 때까지 "쓸 수 없음"이다. 새 접수·새 실행·자격 발급(`admitRun`, `startRun`, `startSession`, `enqueueInput`, `recordPublication`, `applyRuleCheck`)은 `ledger_unwritable`. 정지·종료·영수증·nonce의 기록은 계속 시도한다. 읽기 실패는 `{ known: false }`이고 `runGeneration`과 nonce 소비는 던진다(장부 밖이나 재사용으로 바꾸지 않는다).

## 재시작 복원(`Restorer`)

열린 장부(잠금을 잡은 상태)와 포트 넷을 받는다. 단계는 순서대로만 부르고, 앞 단계가 끝나지 않았거나 겹쳐 부르면 `RestoreOrderError`다. 단계가 실패하면 `RestoreStepError`이고 같은 단계를 다시 부를 수 있다. 지시는 보내지 않고 목록을 돌려준다.

| 단계 | 하는 일 | 돌려주는 것 |
|---|---|---|
| 1 | 장부의 정지 기록과 권위 기록(`StopAuthorityPort`)을 읽어 더 새로운 쪽을 장부에 적는다. 둘 다 없으면 0을 적는다. 둘 중 하나라도 모르면 실패 | 정지 세대, 정지 여부, 출처. 끝나기 전 `stopGeneration()`은 `null` |
| 2 | 이웃의 계약 판(`PeersPort`)과 실행기의 점유(`OccupancyPort`)를 장부와 대조 | 종료 대상(장부 밖 실행, 장부에서는 끝났는데 실행기가 쥔 실행), 판이 다른 이웃 |
| 3 | 진행 중이던 실행을 계약의 `stateAfterLoss`로 `unknown_running`에 둔다. 새 실행을 만들지 않는다 | 실행기별 상태 조회(같은 실행 ID, 8개씩), 옮긴 실행, 자리를 쥔 실행 |
| 4 | 확정되지 않은 게시를 현관(`PublicationPort`)에 작업 ID로 묻는다. 던지면(시간 초과 포함) `unknown` | 확정·대기·모름의 작업 ID |
| 5 | 일시 중지·대기열·예산을 읽고 접수를 열어도 되는지 낸다 | 정지가 아니고 판이 맞고 장부를 쓸 수 있을 때만 `intakeMayOpen: true` |

`unknown_running`·`cleanup_pending`·게시 모름은 접수를 닫지 않는다. 그 실행의 자리를 막고, 그 게시를 다시 내지 않을 뿐이다.

## 끊김 지점(시험)

`Faults.at(point)`가 부르는 이름: `migration:<판>`, `<쓰기>:before_commit`(예: `receipt:before_commit`, `stop:before_commit`), `receipt:after_insert`(영수증을 적고 상태를 옮기기 전), `read`. 운영에서는 아무것도 하지 않는다.

## 자리만 만든 묶음

설계 §8 표의 나머지 넷은 칸을 추측으로 채우지 않는다. 빈 마이그레이션 파일도 두지 않는다. 적용된 번호는 고칠 수 없어 빈 판이 번호만 차지하고, 묶음의 칸은 그 작업이 정하기 때문이다. 각 작업이 그때의 다음 번호로 자기 마이그레이션을 더한다.

| 묶음 | 표 이름의 머리 | 마이그레이션을 더하는 작업 |
|---|---|---|
| 계정 장부 | `account_` | O17(`accounts.md` §4) |
| 장애 색인 | `incident_` | O16 |
| 병합 뒤 확인 | `post_merge_` | O16 |
| 삭제 진행 | `deletion_` | O18 |

## 이 작업 밖

사본 만들기·R2 전송·사본에서 복원한 장부의 보류(D-56의 남은 일), 스케줄러·역할 표·작업자 API, 현관 계약의 감독 쪽, 실제 연결과 진입점, 포트의 실제 구현, 실행 세대를 올리는 풀기(§7.6), 확인 단계를 올리는 쪽은 뒤 작업이다.
