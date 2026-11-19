# 감독 장부 요약

감독 장부(D-56)의 스키마, 쓰기 규칙, 재시작 복원 순서다. 코드는 `src/ledger/`(공개 면은 `index.ts`), 설계의 기준은 homelab `docs/plans/2026-11-13-olive/supervisor.md` §3·§6·§7·§8이다. 표와 코드가 다르면 코드가 맞고, 이 문서를 고친다.

## 파일과 잠금

- SQLite 파일 하나, 감독 하나만 쓴다. `openLedger(path, { clock, mode })`만 장부를 만든다(`Ledger`는 공개 면에 타입으로만 있고 생성자를 직접 부르면 던진다). 실패하면 장부 객체 없이 이유(`locked`, `corrupt`, `full`, `io`, `too_new`, `migration_mismatch`, `migration_failed`, `not_initialized`, `already_initialized`, `foreign_data`, `interrupted_install`, `db_error`)를 돌려준다.
- **지원하는 폴더:** 장부 폴더는 감독만 쓰는 폴더다. 다른 주체가 장부 폴더의 이름을 바꿀 수 있는 경로는 지원하지 않는다. 예약한 파일과 판정한 파일의 동일성 확인은 실수와 끊김을 잡는 것이고, 그런 주체와의 경합까지 막지는 않는다.
- **받는 파일:** 링크가 없는 폴더 안의, 이름이 하나뿐인 정규 파일만 장부로 받는다. 본체와 `-wal`·`-shm`·`-journal` 자리에 심볼릭 링크, 하드 링크, 디렉터리 같은 다른 종류가 있으면 `create`는 `foreign_data`, `reopen`은 `not_initialized`다. SQLite는 링크를 풀어 WAL·저널의 이름을 정하므로 링크를 받으면 검사한 이름과 실제 이름이 갈라진다.
- **`mode`는 호출자가 고른다.** `reopen`은 보통의 기동이다: 파일이 없거나 비었거나 이 설치의 표식이 없거나 첫 설치 기록이 없으면(빈 볼륨, 빈 대체 파일, 다른 파일) 표를 만들지 않고 `not_initialized`로 닫는다. 그래서 장부를 잃은 볼륨이 첫 설치로 착각돼 정지 세대 0을 적는 일이 없다.
- **`reopen`이 쓰기 전에 보는 것:** 식별 표·트리거·판 기록 표의 구조, 적용 기록과 코드의 판 목록, 적용된 판까지의 스키마 전체(코드의 판을 메모리 DB에 적용해 `sqlite_master`를 대조한다), 식별 행의 값, 사본 기록의 값이다. 하나라도 다르면 표식도 표도 적지 않고 `not_initialized`로 닫는다(판이 더 높으면 `too_new`, 이름이 다르면 `migration_mismatch`, 사본 기록이 깨졌으면 `corrupt`). 첫 설치는 모든 판을 적용한 뒤에 식별 행을 적으므로 식별 행이 있는데 적용 기록이 없는 파일은 받지 않는다. 호출자가 넘긴 판 목록도 같은 규칙이고, 적용 기록이 하나도 없으면 무엇과 대조할지 정할 수 없어 빈 목록이어도 거절한다.
- **`create`가 받는 것은 둘뿐이다.** ① 없는 경로: `O_CREAT|O_EXCL`로 이 호출의 파일을 원자적으로 예약한다(남은 WAL·SHM·저널이 있으면 예약하지 않는다). ② 끊긴 같은 설치: 첫 설치 기록이 없고, WAL·SHM이 없고(저널은 끊긴 트랜잭션의 것이라 있어도 된다), **파일의 스키마 전체와 모든 행이 이 코드의 첫 설치가 어느 판까지 적용했을 때 남기는 내용과 정확히 같은** 파일이다. 코드의 마이그레이션을 메모리 DB에 판마다 적용해 대조한다(적용 시각만 뺀다). 업무 기록이 한 줄이라도 있거나 판 기록만 흉내 낸 파일은 증거가 없어 거절하고, 내용이 같으면 이어 받아도 잃을 것이 없다. 이미 있는 0바이트 파일은 이 설치가 예약했다는 증거가 없어 받지 않으므로, 예약 직후에 끊겨 남은 빈 파일은 사람이 지운 뒤 다시 `create`한다.
- **끊긴 첫 설치(`interrupted_install`):** 커밋 전에 끊겨 저널이 남으면 본체는 되돌리기 전의 모습이라 ②의 대조로 가를 수 없다. `create`는 자동으로 이어 받지 않고 이 사유로 닫는다. **파일을 지우지 않는다.** 사람이 할 일: ① 같은 경로로 `reopen`을 한 번 부른다. 연결이 저널을 되돌리고 첫 설치 기록이 없으므로 결과는 `not_initialized`가 맞다. ② 다시 `create`를 부른다. 되돌린 내용이 ②와 같으면 이어 받는다. ③ 그래도 `foreign_data`면 끊긴 설치가 아니므로 파일을 보존하고 내용을 확인한다.
- **판정은 파일을 바꾸지 않는다.** 판정은 `lstat`과 본체만 읽는 SQLite 연결(`immutable=1`: 잠금을 잡지 않고 WAL·저널을 보지 않는다)로 한다. 낯선 DB, 옛 스키마의 장부, 본체 없이 남은 WAL·SHM은 파일을 바꾸지 않고 `foreign_data`, 첫 설치를 마친 장부는 `already_initialized`, SQLite 파일이 아니거나 페이지 경계에서 끝나지 않으면(끊긴 파일) `corrupt`다. 새로 예약한 파일의 기준(장치·inode)은 예약한 FD가 살아 있을 때 그 FD에서 얻는다. 연 뒤에는 경로가 기준과 같은지 첫 읽기 전과 잠금 뒤에 다시 보고, `create`는 잠금을 쥔 내용으로 ②를 다시 판정한 뒤에만 표식과 표를 쓴다. 판정과 열기 사이에 경로를 바꿨다가 되돌리는 의도적인 이중 교체까지는 가르지 못한다. 완전히 빈 볼륨이 정말 새 설치인지는 파일만으로 가를 수 없어 호출자의 `mode`에 맡긴다.
- **잠금:** `locking_mode=EXCLUSIVE`와 빈 `BEGIN EXCLUSIVE`로 여는 순간 파일 잠금을 잡고 닫을 때까지 쥔다. 둘째 작성자는 같은 프로세스든 다른 프로세스든 `SQLITE_BUSY`로 `locked`다(`busy_timeout` 0). 프로세스가 죽으면 운영체제가 잠금을 푼다. **살아 있는 장부 파일을 SQLite 밖의 FD로 열지 않는다.** POSIX 잠금은 같은 프로세스가 같은 파일의 다른 FD를 닫기만 해도 풀리기 때문이다. SQLite 밖에서 FD를 여는 곳은 이 호출이 `O_EXCL`로 만든 새 파일 두 곳(장부의 예약, 사본의 임시 파일)뿐이다. `test/ledger/static.test.ts`가 모듈별로 쓸 수 있는 `node:fs` 이름을 막는다(SQL 마이그레이션 로더의 읽기는 `migrate.ts`에만 허용한다).
- **저널:** `journal_mode=WAL`, `synchronous=FULL`. 커밋마다 WAL을 fsync하므로 커밋을 돌려준 실행 줄은 전원이 나가도 남고, 감독은 실행 줄의 커밋 뒤에만 지시를 내므로 접수 기록이 영수증보다 먼저 남는다. `NORMAL`은 마지막 커밋을 잃을 수 있어 고르지 않았다. EXCLUSIVE라 `-shm` 파일이 없다. 로컬 볼륨 전제다. 첫 설치만 저널 모드로 진행하고 첫 설치 기록을 커밋한 뒤에 WAL로 바꾼다. 끊긴 첫 설치의 내용이 본체에만 있어야 WAL을 복구하지 않고 판정할 수 있다.
- 열 때 `quick_check`로 깨진 파일을 거른다. `foreign_keys=ON`.

## 마이그레이션

`migrations/NNNN-이름.sql`을 번호 순서대로 한 번씩 적용한다. 판 하나는 트랜잭션 하나라 도중에 실패하거나 끊기면 그 판 전체가 되돌려진다. 적용 기록은 `ledger_migrations(version, name, applied_at)`. 번호가 비거나, 이름과 번호가 다르거나, 폴더에 꼴이 다른 파일이 있거나, 장부의 판이 코드보다 높거나, 같은 번호의 이름이 다르면 열지 않는다. 호출자가 `migrations`로 넘긴 목록도 같은 검사를 파일을 열기 전에 자리마다 거친다(배열의 빈 자리 포함). 적용 시각으로 쓸 시계의 값도 파일을 건드리기 전에 확인한다.

이 장부는 아직 어디에도 배포되지 않아 리뷰 반영을 `0001-core.sql`에 직접 고쳤다. **첫 배포 뒤에는 기존 번호를 고치지 않고 다음 번호로 더한다.**

## 표(0001-core)

| 묶음 | 표 | 요지 |
|---|---|---|
| 정지·일시 중지 | `stop_state`, `diagnosis_pause` | 정지 세대(0 포함, 줄이 없으면 아직 적지 않음), 정지 여부, 확인 단계, 진단 일시 중지의 끝 |
| 실행·슬롯·예산 | `runs`, `run_epoch`, `run_transitions`, `instructions`, `slot_holds` | 실행 ID·세대·역할·revision 둘·snapshot·실행기·자격 네 칸·기한·남은 예산·상태·영수증 id들. 낸 지시(v1 여섯, 적은 뒤 불변). 점유가 맞지 않은 관측: (실행기, 실행, 세대)마다 한 줄이고 관측 번호를 가진다. 줄이 있으면 그 실행 ID를 영영 시작하지 않고, `holds_slot`이면 그 종류의 슬롯도 막는다 |
| 입력·대기열 | `inputs` | 요청 ID, 인증된 출처, 원문 참조(`<저장소>/<UUID>`)와 만료, 순번, 취소 |
| 영수증·보고 | `deliveries`, `receipt_conflicts`, `report_signals` | 받은 id와 본문 digest, 속한 실행(외래 키), 가리킨 지시, 결과 보고의 저장 자리·digest·반영 시각. 같은 id에 다른 digest의 기록(같은 충돌은 한 줄). 훅·세션 깨짐 보고의 구조화 칸(사건 종류, `session_id`, 턴 ID, 오류 종류, 원인, 표식 digest, 관측 시각) |
| 세션·인계 | `sessions`, `rule_checks`, `session_takeovers`, `start_permit_uses` | 세션 ID, 시작 순번, 세대 표식 digest, 교체 시각, 처리 위치, 인계 참조, 규칙 확인(D-51)과 낸 쪽, 교체 기록(앞 실행·인수 발신자·표식·허가·확정한 규칙 확인·다음 실행, D-50), 시작 허가의 한 번 사용. **지금 쓰는 것은 `rule_checks`와 `session_takeovers`의 받은 칸뿐이다**("세션 증거" 참조) |
| 게시 연결 | `publications` | 현관 작업 ID, 후보 digest, 대기·확정·모름(확정이면 posted·not_posted) |
| nonce | `nonces` | 감독이 받는 봉투의 (낸 쪽, nonce). 계약의 `NonceStore` |
| 사본 기록 | `ledger_snapshots` | 이 파일이 어느 장부(`ledger_id`)의 어느 시각(`taken_at`)의 사본인지, 대조 끝 시각과 그 사본의 식별. 원본 장부에는 줄이 없다. 지울 수 없고 바꿀 수 있는 것은 대조 끝 한 번뿐이다(트리거) |

`ledger_identity`(첫 설치 기록)는 마이그레이션이 아니라 `openLedger`의 `create`가 만든다.

**넣지 않는 것:** 원문(요청 글, 모델 출력, 로그)과 자격 값. 원문은 참조와 만료만, 자격은 계정·방식·revision·digest만 둔다. 쓰기 함수는 정해진 칸만 받고(모르는 칸이면 `LedgerInputError`), 칸마다 좁은 꼴만 받는다: 계정은 계약의 별칭 꼴(소문자·숫자·하이픈 32자), 방식은 `subscription`·`api_key`, 실행기는 계약의 실행기 주체 이름, 원문·결과 참조는 `<저장소 이름>/<UUID>`. `test/ledger/static.test.ts`가 스키마의 칸 이름과 쓰기 함수가 실제로 받는 칸(`exact`의 칸 목록, 인라인 인자 타입, 입력 타입)을 막는다.

**정수:** 장부 표의 정수 칸은 모두 0(또는 1)부터 9007199254740991까지다(STRICT 열의 CHECK, 쓰기 함수의 `Number.isSafeInteger`). `ledger_migrations`의 판과 적용 시각, `receipt_conflicts.seq`, `slot_holds.observation`도 같다. 예외는 SQLite가 관리하는 내부 표 `sqlite_sequence`뿐이다. 읽은 세대·예산이 안전 정수가 아니면 그 값으로 판단하지 않고 `corrupt`로 닫는다.

## 새 업무를 열어도 되는 조건

새 접수·실행 줄·시작·자격·게시·갱신(`enqueueInput`, `admitRun`, `startRun`, `startSession`, `recordPublication`, `recordRenewInstruction`)은 모두 한 자리(`Ledger`의 쓰기 모드 `start`)의 전제를 거친다.

1. 장부가 건강하다(한 번이라도 쓰기·읽기가 실패했으면 다시 열 때까지 `ledger_unwritable`).
2. 사본에서 떠 대조가 끝나지 않은 장부가 아니다(`snapshot_hold`, "사본에서 뜬 장부의 보류").
3. 같은 트랜잭션 안에서 읽은 지금의 정지 기록이 있고(`stop_unknown`) 정지가 아니다(`stopped`).
4. 살아 있는 접수 허가가 있다(`intake_closed`).

**접수 허가는 "어느 복원 시도가, 어느 정지 세대에서 냈는가"에 묶인 한 자리다.** 장부는 열 때마다 허가 없이 시작하고, 복원 5단계만 허가를 낸다. 아래 가운데 하나가 일어나면 허가는 버려지고, 새 복원 시도가 1~5단계를 끝까지 다시 마칠 때까지 새 업무는 닫혀 있다.

- 정지 기록의 세대나 정지 여부가 바뀐다(`applyStop`, `mergeStop` 모두).
- 관리자가 푼다(`releaseStop`).
- 새 복원 시도가 시작된다(1단계 호출).
- 장부의 쓰기나 읽기가 실패한다.

복원 시도는 1단계에서 정지 기록을 합친 시점의 정지 상태에 고정된다. 그 뒤에 정지가 걸렸다 풀렸으면 그 시도의 5단계는 `stop_changed`로 닫힌다. 앞서 모은 대조가 풀리기 전의 것이기 때문이다. 더 새로운 시도가 시작된 뒤에는 앞 시도의 늦은 응답과 늦은 단계가 `RestoreStepError`로 실패하고 지금의 허가를 바꾸지 못한다.

**일반 기록과 풀기는 다르다.** `applyStop`은 이미 정지인 장부를 풀지 못한다. 세대가 더 높은 해제 값이 와도 세대만 오르고 정지는 남으며, 푸는 길은 `releaseStop` 하나다. 권위 기록을 합치는 `mergeStop`은 더 높은 세대의 해제를 사실로 적지만, 세대가 바뀌므로 허가는 없어지고 복원을 다시 마쳐야 열린다.

`startSession`은 이 전제를 지난 뒤 항상 `session_start_closed`로 거절한다("세션 증거" 참조). 작업자 시작(`startRun`)은 여기에 더해 지시의 정지 세대가 장부의 지금 값과 같고, 실행 줄의 세대가 지금 실행 세대(`run_epoch`)와 같고(`run_generation_stale`), 그 종류에 슬롯 차단(`slot_holds`의 `holds_slot`)도 자리를 쥔 실행도 없을 때(`slot_busy`)만 된다. 시작 트랜잭션 안에서 이 실행 자체도 다시 본다: 이 실행 ID의 점유 관측이 있으면 `run_blocked`, 연결된 입력이 취소됐으면 `input_cancelled`, 원문이 만료됐으면 `input_expired`, 실행 기한이 지났으면 `deadline_passed`다. 기한과 만료는 호출자가 넘긴 값이 아니라 장부에 주입한 시계로 재고, 트랜잭션마다 시계를 한 번만 읽어 판정과 발행 시각(`issued_at`)과 상태 변경에 같은 값을 쓴다. 작업자는 v1 `task_start`를 만들 수 있는 줄(입력 digest가 있고 예산이 1 이상, 역할과 지정 실행기가 맞음)만 자리를 잡는다(`not_startable`).

종료 기록, 영수증·보고의 반영, 복원 자체의 쓰기, 조회는 이 전제 없이 된다. `Restorer.intakeOpen()`과 `Ledger.intakeOpen()`은 단계 결과가 아니라 지금의 장부(건강, 허가, 정지 기록)를 읽고, 읽지 못하면 `false`다. `Restorer.intakeOpen()`은 그 복원기가 낸 허가만 센다. 5단계의 `intakeMayOpen`은 허가를 낸 그 순간의 판정이라, 그 뒤에 정지가 걸리면 값은 `true`로 남아도 `intakeOpen()`은 `false`다.

## 쓰기 규칙

- **실행 줄이 먼저:** `admitRun`이 대기(`queued`)로 실행 줄을 적는다. `startRun`이 자리를 잡고(`preparing`) 시작 지시를 적은 커밋이 끝난 뒤에만 지시를 보낸다. 영수증은 장부에 적힌 지시만 가리킬 수 있다. 같은 중복 키는 같은 실행을 돌려준다.
- **영수증:** `applyReceipt(input, from)`의 `from`은 검증을 마친 봉투의 낸 쪽 주체 이름과 머리의 `run_generation`이다. 대조 순서는 발신자·실행·세대 → 이미 받은 id의 분류 → 새 id의 원 지시 대조와 효과다. 낸 쪽이 그 실행의 지정 실행기가 아니면 `sender_mismatch`, 세대가 다르면 `run_generation_mismatch`이고 충돌 기록을 포함해 아무것도 적지 않는다(ack·상태·슬롯이 그대로). 같은 id·같은 digest는 한 번만 반영하고 다시 받으면 `duplicate`(ack는 다시 준다). 같은 id에 다른 digest는 원 지시가 달라도 `receipt_conflicts`에 남기고 `receipt_conflict`. 새 접수 영수증은 원 지시의 이름(`instruction`, v1 여섯 가운데 하나)이 장부의 지시와 같아야 한다. 영수증과 그 상태 전이는 한 트랜잭션이다.
- **증거:** 실행 줄의 영수증 id 칸은 같은 실행이 받은 맞는 종류의 영수증만 가리키고 한 번만 채운다(트리거 `runs_evidence`). 정리 영수증은 그 실행의 `result_finalize` 지시를 가리킨다. 받은 기록, 낸 지시, 실행 줄, 규칙 확인, 교체 기록, 시작 허가의 사용은 지우거나 바꿔 넣지 못한다(트리거). 실행 줄과 교체 기록은 보조 고유 키(`queue_seq`, `dedupe_key`, 슬롯, 다음 실행, 앞 세션의 확정)가 부딪히는 `INSERT OR REPLACE`·`UPDATE OR REPLACE`로도 밀려나지 않는다. TEXT 키의 표는 모두 `WITHOUT ROWID`라 rowid 충돌로 행이 교체되지 않는다.
- **상태 전이:** `states.ts`의 표만 허용한다. 같은 표가 장부의 `run_transitions`와 트리거에 있다. 종료 확인(`stop_receipt_id`) 없이 `checking`·`ready_result`·`failed_stopped`·`cleanup_pending`이 되지 않는다(CHECK). `not_started`는 지시를 내기 전(`queued`)에서만 간다. 종료 확인 영수증의 `exit`가 `completed`면 `checking`, 그 밖이면 `failed_stopped`다. `checking`에서 `unknown_running`으로 가는 길은 없다.
- **끊김 판정:** `markLost`는 종료 확인이 없는 `preparing`·`running`·`stopping`에만 계약의 `stateAfterLoss`를 쓴다(→ `unknown_running`). 계약의 함수는 종료 증명이 없는 실행기 쪽 상태의 함수라, 장부에서는 `stop_receipt_id`가 없는 줄에만 그대로 쓸 수 있다. 종료 확인이 있는 `checking`은 그대로 두고 결과 검사를 이어 간다.
- **슬롯:** 작업자 하나, 세션 하나(부분 유일 인덱스). `queued`·`finalized`·`not_started` 밖은 모두 자리를 쥔다. 그래서 `unknown_running`·`cleanup_pending`이 있으면 새 실행은 `slot_busy`다. 슬롯을 막는 관측(`holds_slot`)이 있는 종류도 `slot_busy`다.
- **점유 관측:** "이 슬롯이 사용 중"과 "이 실행 ID는 이미 쓰였다"를 따로 둔다. 끝났다고 답한 대기 줄과 장부 밖 실행은 슬롯을 막지 않고 그 실행 ID만 막으므로 관계없는 다른 일은 시작한다. `clearSlotHold({ executorId, runId, runGeneration, observation })`은 확인한 그 세대와 번호의 줄의 **슬롯만 돌려준다.** 줄은 남고 그 실행 ID는 영영 시작하지 못한다(`run_blocked`, 나중에 같은 ID를 접수해도 같다). 다시 할 일은 새 실행 ID를 받는다. 옛 세대의 종료 확인이나 다시 관측되기 전의 확인은 `reference_mismatch`이고 지금의 차단은 그대로다. `slotHolds()`는 슬롯을 막고 있는 관측만 낸다. 자동으로 푸는 경로는 없다.
- **정지:** 0도 줄로 적는다. 낮은 세대로 덮지 않는다(코드와 트리거 둘 다, 트리거는 UPDATE·UPSERT·INSERT OR REPLACE·DELETE 모두). `applyStop`은 합치기다: 이미 정지면 세대가 높아도 정지로 남고, 확인 단계를 생략하면 같은 세대에서는 이미 적은 단계를 남긴다(새 세대는 `none`). 일반 기록으로는 정지가 풀리지 않는다. 푸는 연산은 관리자 풀기의 `releaseStop({ generation })` 하나이고 같은 세대만 푼다(권위의 더 높은 해제는 `mergeStop`이 사실로 적지만 접수는 복원을 다시 마칠 때까지 닫혀 있다).
- **지시의 정지 세대:** 종료(`recordStopInstruction`)·확정(`recordFinalizeInstruction`)·갱신 지시도 장부의 지금 정지 세대와 같아야 적힌다(`stop_generation_mismatch`, 기록이 없으면 `stop_unknown`). 종료·확정은 정지 중에도, 접수가 닫혀도, 장부가 실패한 뒤에도 시도한다. 기록이 실패해도 호출자는 최선 노력의 종료를 보낼 수 있지만 그것은 "지금 세대로 발급하도록 기록한 지시"가 아니다.
- **예산:** 남은 예산은 늘지 않는다(트리거만 비교한다).
- **보고:** `recordReport(input, from)`도 지정 실행기와 세대를 본다. 결과 보고는 감독이 결과를 먼저 저장한 자리(`storedRef`)와 결과 digest를, 훅·세션 깨짐 보고는 업무를 잇는 구조화 칸(`signal`)을 함께 커밋한 뒤에만 ack를 준다. 원문 로그나 모델 출력은 받지 않는다. `markResult`로 판정하면 그 실행의 미반영 결과 보고는 모두 닫힌다: 같은 digest는 반영이고, 다른 digest는 `receipt_conflicts`에 남긴다. 판정이 끝난 실행에 늦게 온 결과 보고는 ack 전에 갈린다: 같은 결과면 적자마자 마치고, 다른 결과면 충돌을 남기고 `receipt_conflict`, 결과가 없다고 판정했거나 시작하지 않은 실행이면 적지 않고 `transition_denied`다(거절된 보고는 ack가 없어 실행기가 다시 보낸다. 같은 id·같은 두 digest의 충돌은 몇 번 다시 와도 한 줄이다). 판정 전에 받아 남은 보고는 `markResult({ …, reportId })`가 상태를 되돌리지 않고 그 보고만 마친다. 결과 밖의 보고는 `settleReport`. 반영하지 않은 보고는 `pendingReports()`와 복원 3단계에 남는다.
- **게시:** 같은 작업 ID·같은 후보·같은 실행이면 재시도로 성공(`created: false`), 다르면 `publication_conflict`이고 기존 연결은 그대로다. 확정된 게시는 키·후보·실행·상태·결과가 바뀌지 않는다(UPDATE·교체·삭제·다른 줄의 키 변경 모두 트리거). 갱신 시각만 바뀐다.
- **세션 증거(D-50·D-51):** 이 PR은 세션 증거의 영속 저장과 읽기까지다. **교체에 따른 시작·자격 반환은 세션 계약 작업이 만든다.** 아래 "세션 증거" 절에 받는 것, 닫은 것, 그 작업이 지킬 조건이 있다.
- **인계 참조:** `handoffRef`는 저장소가 낸 불투명 ID 꼴(`<저장소 이름>/<UUID>`)만 받고 `handoffDigest`와 함께 있거나 함께 없다. 인계 저장소의 실제 ID 꼴이 설계에 없어 장부가 받을 수 있는 가장 좁은 꼴로 정했다.
- **못 씀:** 쓰기나 읽기가 한 번 실패하면 다시 열 때까지 "쓸 수 없음"이다. 새 업무와 규칙 확인·풀기는 `ledger_unwritable`. 정지·종료·영수증·nonce의 기록은 계속 시도한다. 읽기 실패는 `{ known: false }`이고 `runGeneration`과 nonce 소비는 던진다(장부 밖이나 재사용으로 바꾸지 않는다). "모름"은 그 읽기가 실패했을 때다. 실패한 뒤에도 성공한 읽기는 값을 준다(새 업무는 위 1로 닫혀 있다).

## 세션 증거

v1의 인수 영수증과 규칙 확인에는 다음 실행 ID가 없어, 어느 대기 실행의 시작 근거인지 장부가 정할 수 없다. 그래서 이 PR은 증거를 받아 적고 읽는 데서 멈춘다.

| 구분 | 공개 함수 | 동작 |
|---|---|---|
| 받아 적음 | `applyReceipt`(`receipt_session_takeover`) | 앞 실행이 장부의 세션 실행이고, 머리의 실행 세대가 그 실행과 같고, 낸 쪽이 앞 실행의 지정 실행기이거나 대기 중인 세션 실행의 지정 실행기일 때 적고 ack한다. 같은 허가를 실은 다른 인수는 `permit_used` |
| 받아 적음 | `applyRuleCheck` | 세션 실행기가 낸 규칙 확인을 낸 쪽과 함께 적고 ack한다 |
| 받아 적음 | `recordReport`(훅·세션 깨짐) | 지정 실행기와 세대를 대조하고 `signal`과 함께 적고 ack한다 |
| 읽기 | `sessionEvidence({ executorId, previousRunId })` | 확정 여부와 무관하게 받은 인수·규칙 확인·훅·세션 깨짐 보고를 실행기 기준으로 읽는다. `previousRunId`를 주면 인수와 보고를 그 실행의 것으로 좁힌다. 재시작 뒤에도 같다 |
| 닫음 | `startSession` | 첫 세션과 교체 모두 새 업무의 공통 전제를 지난 뒤 `session_start_closed`로 거절한다. 시작 지시, 자격 참조, 슬롯, 허가 사용을 남기지 않는다 |
| 닫음 | 앞 세션의 종료 | 인수와 규칙 확인이 맞아도 앞 세션을 `finalized`로 끝내지 않고 교체를 확정하지 않는다 |

중복·충돌의 분류와 ack는 다른 영수증과 같다: 같은 id·같은 digest는 처음 낸 쪽만 다시 ack를 받고, 같은 id의 다른 digest는 `receipt_conflicts`에 한 줄 남기고 `receipt_conflict`다. 앞 세션의 상태, `session_stop` 지시, 표식의 대조는 증거를 소비할 때의 일이라 받을 때 보지 않는다.

**지금 쓰지 않는 것(세션 계약 작업이 쓴다. 지우지 않았다):** 표 `sessions`, `start_permit_uses`, 칸 `session_takeovers.confirmed_at`·`rule_check_id`·`next_run_id`, 부분 유일 인덱스 `session_takeovers_one_confirmed`. 세션 줄이 없으므로 `setProcessedSeq`·`planRotation`은 `unknown_run`이고 입력의 처리 위치는 0이다.

**세션 계약 작업이 지킬 조건:** 앞 실행·유일하게 예약한 다음 실행·검증된 실행기·표식·허가·규칙 확인·영수증을 한 기록에 함께 커밋한 뒤에만 앞 세션을 끝내고 최종 확인한다. 다음 실행 ID 하나로 재개방 뒤에도 미사용 기록을 읽어 같은 시작 트랜잭션에서 소비할 수 있어야 한다. 후보가 없거나 여럿이면 보류한다. 받아 적은 증거는 소비할 때 앞 세션의 상태, `session_stop` 지시, 앞 세션과 다른 표식을 다시 대조한다.

## 사본

`ledger.createSnapshot({ path, maxBytes })`가 지금까지 커밋된 장부의 사본 파일 하나를 만든다. 원본에는 아무것도 적지 않는다. 성공하면 `snapshotId`, `ledgerId`, `takenAt`, `path`, `bytes`, `sha256`, `blockedMs`를 돌려준다.

**방법.** 장부를 쥔 연결의 `serialize()`로 커밋된 그림을 메모리에 받고, 그 그림을 메모리 DB로 열어 사본 기록을 넣은 뒤, 그 바이트를 임시 이름에 쓰고 fsync하고 `link`로 최종 이름을 붙인다. 사본 기록이 없는 온전한 장부가 디스크에 놓이는 순간이 없다. 다른 연결은 `locking_mode=EXCLUSIVE`인 장부를 읽지도 못하므로(`SQLITE_BUSY`) 장부를 쥔 연결이 만들어야 한다.

**버린 방법.** 파일 복사는 살아 있는 장부의 FD를 열었다 닫아 잠금을 푼다. `VACUUM INTO`는 이미 있는 빈 파일을 덮고 끊어진 링크를 따라가며, 끝난 파일에 사본 기록을 넣기 전까지 원본과 구별되지 않는 파일이 디스크에 남는다. 온라인 백업 API는 `bun:sqlite`에 없다.

| 실패 사유 | 뜻 |
|---|---|
| `target_exists` | 그 경로나 그 곁 파일 자리에 이미 무언가 있다(빈 파일, 링크 포함). 덮지 않는다 |
| `target_refused` | 장부 자신과 그 곁 파일의 자리, 링크가 낀 폴더, 없는 폴더 |
| `too_large` | 장부나 사본이 `maxBytes`보다 크다 |
| `in_transaction` | 열린 트랜잭션 안에서 불렀다. 그 연결의 그림에는 커밋되지 않은 페이지가 보인다 |
| `snapshot_hold` | 대조가 끝나지 않은 장부다. 사본의 출처가 흐려지므로 만들지 않는다 |
| `snapshot_unsupported` | 호출자가 넘긴 판 목록으로 만들어 사본 기록의 표가 없는 장부다 |
| `ledger_unwritable` | 장부가 닫혔거나 실패했거나, 시계의 값을 믿을 수 없다 |
| `io` | 사본 파일을 쓰지 못했다. 장부는 계속 쓸 수 있고 임시 파일은 지운다 |

**쓰기가 막히는 정도.** 동기 호출이라 끝날 때까지 이 프로세스의 쓰기와 읽기가 모두 기다린다. 시간은 장부 크기와 디스크에 달려 있어 고정된 숫자가 없다. 호출자는 `maxBytes`로 크기의 상한을 정하고 `blockedMs`로 실제 시간을 읽는다. 메모리는 그림, 메모리 DB, 최종 바이트가 잠시 함께 있어 장부 크기의 최대 세 벌이 든다.

**끊겼을 때.** 최종 이름은 fsync 뒤에만 생긴다. 끊기면 `<path>.partial-<UUID>`만 남는다. 쓰다 끊긴 파일은 `corrupt`로 열리지 않고, 끝까지 쓴 임시 파일은 사본 기록이 있어 보류로 뜬다. `link`와 `unlink` 사이에서 끊기면 이름이 둘이라 받지 않는다.

## 사본에서 뜬 장부의 보류

백업에서 복원한 장부는 옛 시점이라 계정 잠금과 영수증이 옛것일 수 있다(D-56). 사본 기록이 있고 대조가 끝나지 않은 파일은 열리지만 새 업무를 열지 않는다.

| 쪽 | 쓰기 | 보류 중 |
|---|---|---|
| 여는 쪽(쓰기 모드 `start`) | `enqueueInput`, `admitRun`, `startRun`, `startSession`, `recordPublication`, `recordRenewInstruction` | `snapshot_hold`로 거절 |
| 닫는 쪽(`continue`) | `applyStop`, `mergeStop`, `setPause`, `cancelInput`, `recordStopInstruction`, `recordFinalizeInstruction`, `markResult`, `markCleanupPending`, `recordBudget`, `markLost`, `holdSlots`, `clearSlotHold`, `applyReceipt`, `recordReport`, `settleReport`, `setProcessedSeq`, `planRotation`, `settlePublication`, nonce 소비 | 막지 않는다 |
| 근거·풀기(`new`) | `applyRuleCheck`, `releaseStop`, `confirmSnapshotReconciled` | 막지 않는다. `releaseStop`은 보류를 풀지 않는다 |

- **읽기:** `snapshotOrigin()`은 원본이면 `null`, 사본에서 떴으면 `snapshotId`, `ledgerId`, `takenAt`, `reconciledAt`, `held`, `mayBeStale`(`account_locks`, `receipts`)을 낸다. 복원 5단계도 같은 값을 `snapshotOrigin`으로 내고, 보류면 `intakeMayOpen: false`, `closedBecause`에 `snapshot_hold`다.
- **풀리지 않는 것:** 재시작, 새 복원 시도, `releaseStop`, 접수 허가를 다시 내려는 시도.
- **푸는 길:** `confirmSnapshotReconciled({ snapshotId, now })` 하나다. 사본의 식별이 맞아야 하고(`reference_mismatch`) 시각과 식별만 남긴다. 누가 불렀는지는 받지 않는다. 풀어도 접수는 닫힌 채이고 진행 중이던 복원 시도는 허가를 내지 못한다. 새 복원 시도가 끝까지 마쳐야 열린다.
- **사본 기록을 지키는 것:** 트리거가 삭제, 교체, 대조 끝 밖의 변경, 대조가 끝나지 않은 줄이 있을 때의 추가를 막는다. 트리거나 표를 지운 파일은 재개방의 스키마 대조가 거절한다. 파일에 직접 SQL을 실행할 수 있는 주체는 이 장치로 막지 못한다. 그런 주체는 장부 폴더를 감독만 쓴다는 전제 밖이다.

| 파일 | 결과 |
|---|---|
| 끊긴 사본 | `corrupt` |
| 사본 기록의 값이 깨진 파일, 다른 `ledger_id`를 주장하는 파일 | `corrupt` |
| 사본 기록의 표나 트리거가 없는 파일 | `not_initialized` |
| 한 번도 열지 않은 사본 곁에 `-wal`·`-shm`·`-journal`이 있는 파일 | `not_initialized`. 다른 시점의 WAL이 재생되면 사본 기록까지 덮을 수 있다 |

## 재시작 복원(`Restorer`)

`new Restorer(ledger, ports, clock, { requiredPeers })`. 열린 장부(잠금을 잡은 상태)와 포트 넷, 응답을 반드시 받아야 하는 이웃 이름의 목록을 받는다. 목록에서 계약의 실행기 주체 이름인 항목은 필수 실행기다. 단계는 순서대로만 부르고, 앞 단계가 끝나지 않았거나 겹쳐 부르면 `RestoreOrderError`다. 단계가 실패하면 `RestoreStepError`이고 같은 단계를 다시 부를 수 있다. 더 새로운 복원 시도가 시작된 복원기의 단계는 실패한다. 단계 결과는 복사본이라 호출자가 바꿔도 뒤 단계의 판단이 바뀌지 않는다. 지시는 보내지 않고 목록을 돌려준다.

| 단계 | 하는 일 | 돌려주는 것 |
|---|---|---|
| 1 | 복원 시도를 새로 연다(앞 허가가 끝난다). 권위 기록(`StopAuthorityPort`)을 받아 정수·불리언 꼴을 확인하고, 장부를 다시 읽어 한 트랜잭션에서 합친다(`mergeStop`, 같은 세대는 정지가 이김). 첫 설치 장부에서 둘 다 없으면 0을 적는다. 둘 중 하나라도 모르면 실패 | 정지 세대, 정지 여부, 출처. 끝나기 전 `stopGeneration()`은 `null`, 끝난 뒤에는 지금의 장부 값(장부가 실패했으면 `null`) |
| 2 | 필수 이웃이 정확히 한 번씩 답했는지와 계약 판(`PeersPort`)을 보고, 실행기의 점유(`OccupancyPort`)를 실행 ID·세대·지정 실행기·양쪽 상태(끝난 상태 포함)로 장부와 대조. 대기 줄과 장부 밖 실행의 관측은 끝났다는 답이어도 `slot_holds`에 남기고, 이미 시작한 줄은 활동 중이라는 답만 남긴다(끝났다는 답이나 끝난 상태끼리 이름만 다른 답은 불일치 목록에만 나온다. 그 줄이 슬롯을 계속 쥐거나 이미 끝나 있어 다시 시작될 수 없다). 슬롯 종류를 모르는 실행기가 답한 장부 밖 실행은 적을 수 없어 접수를 보류한다 | 종료 대상(장부 밖 실행, 장부에서는 끝났는데 실행기가 쥔 실행), 점유 불일치, 남긴 관측, 슬롯 종류를 모르는 실행기, 전체 점유를 확인하지 못한 필수 실행기, 다시 물을 실행, 판이 다른 이웃, 빠진·겹친 이웃 |
| 3 | 종료 확인이 없는 진행 중 실행을 `unknown_running`에 둔다. 새 실행을 만들지 않는다 | 실행기별 상태 조회(같은 실행 ID, 8개씩, 종료 확인이 있는 실행은 2단계에서 어긋난 것만), 옮긴 실행, 결과 검사를 이을 실행(`checking`), 반영하지 않은 보고(훅·세션 깨짐은 `signal` 포함), 자리를 쥔 실행 |
| 4 | 확정되지 않은 게시를 현관(`PublicationPort`)에 작업 ID로 묻는다. 던지면(시간 초과 포함) `unknown` | 확정·대기·모름의 작업 ID |
| 5 | 일시 중지·대기열·예산·입력을 읽고 접수를 열어도 되는지 낸다. 판정, 장부의 허가, 완료 표시, 반환값을 한 동기 구간에서 정한다 | 사본 보류가 아니고, 정지가 아니고, 1단계 뒤 정지가 바뀌지 않았고, 판이 맞고, 필수 이웃이 모두 한 번씩 답했고, 필수 실행기의 전체 점유를 확인했고, 슬롯 종류를 모르는 점유가 없고, 장부를 쓸 수 있을 때만 `intakeMayOpen: true`. 시작 후보(`queued`: 이 실행 자체를 막는 사유가 없는 대기 실행), 옛 세대·입력 취소·만료·점유 관측으로 빠진 대기 실행, 처리 위치 뒤의 입력(대기·취소·만료). 대기 실행과 입력의 만료는 장부 시계의 같은 시각 하나로 판정한다 |

**`queued`는 시작 보장이 아니다.** 접수가 닫힌 복원에서도 목록은 나온다. 실제 시작은 시작 트랜잭션이 접수 허가, 슬롯(`slot_busy`), 예산·입력 digest(`not_startable`)를 다시 보고 거절할 수 있다. 세션 실행은 후보로 나와도 `startSession`이 닫혀 있어 시작하지 않는다.

**점유 응답의 세 모양.** `OccupancyPort`의 행은 `coverage`로 가른다. `full`은 그 실행기가 쥔 실행 전부를 이번 복원에서 답한 것이고(빈 `runs`는 "쥔 것 없음"), `partial`은 특정 실행만 물은 답이다. 행이 없으면 모름이다. 필수 실행기는 `full`이 정확히 하나 있어야 확인된 것으로 세고, 아니면 `occupancy_unconfirmed`로 접수를 닫는다.

**접수를 닫지 않는 예외(합의한 정책).** 아래는 "앞 단계가 모두 맞을 때만"의 예외로, 접수는 열고 그 자리만 막는다.

- 장부 안의 `unknown_running`·`cleanup_pending`: 그 실행이 슬롯을 쥐고 있어 같은 종류의 새 실행은 `slot_busy`다.
- 장부 밖·불일치 점유: 실행 줄로 올리지 않고 `slot_holds`로 그 실행 ID와(활동 중이면) 그 종류의 슬롯만 막는다. 슬롯 종류를 알 수 없으면(실행기 주체 이름이 아님) 이 예외에 들지 않고 접수를 보류한다.
- 게시 조회의 모름: 그 작업 ID를 `unknown`으로 남겨 다시 내지 않는다.

## 뒤 작업이 알아야 할 것

**이 PR이 남긴 네 가지.** 장부는 아래가 채워져야 실제로 보호가 성립한다.

1. **실제 연결이 `from`을 서명 검증 결과에서 뽑는다.** 장부의 `from`은 평범한 값이라 그 출처를 스스로 증명하지 못한다. `applyReceipt`·`recordReport`·`applyRuleCheck`에는 봉투 검증을 통과한 낸 쪽 주체와 머리의 `run_generation`만 넘긴다. 실행기별 전체 점유(`coverage: "full"`)의 출처와 신선도, 종료 증명의 수집도 이 작업이 정한다.
2. **기동이 `reopen`을 고르고 필수 이웃을 설정한다.** 운영의 보통 기동은 `mode: "reopen"`이다. `not_initialized`면 장부를 잃은 것이고 첫 설치로 넘어가지 않는다. `requiredPeers`에 현관·관측 중계·실행기를 실제로 넣어야 빠진 응답이 접수를 닫는다.
3. **R2 전송과 현관.** 사본을 R2로 보내는 일(자격, 일정, 보존 기간, 되가져오는 절차)과 현관 계약의 감독 쪽은 아직 없다. 보내는 쪽이 지킬 조건은 아래 "R2로 보내는 쪽이 지킬 것"에 있다.
4. **세션 계약.** `startSession`을 열고 교체를 확정·소비하는 일은 이 작업의 몫이다. 조건은 "세션 증거" 절에 있다.

- **실제 연결:** 세션 인수 영수증의 낸 쪽은 앞 세션의 지정 실행기이거나 대기 중인 세션 실행의 지정 실행기여야 한다. 규칙 확인은 `applyRuleCheck(input, { sender })`로 낸 쪽을 함께 넘긴다. 훅·세션 깨짐 보고는 `recordReport`의 `signal`에 v1 본문의 구조화 칸을 옮겨 넣는다. `clearSlotHold`는 그 실행기가 그 세대의 그 실행을 더는 쥐지 않는다고 재대조했거나 종료를 증명했을 때, `slotHolds()`나 2단계가 돌려준 세대와 관측 번호를 함께 넘겨 부른다. 슬롯만 돌아오고 그 실행 ID는 다시 시작할 수 없다. 무엇을 증명으로 볼지(`not_known`은 종료의 증거가 아니다)는 그 작업이 정한다. 맞춤 답의 세대는 `Restorer.stopGeneration()`이고 `null`이면 맞춤에 답하지 않는다.
- **스케줄러:** 새 업무는 `Restorer.intakeOpen()`이 true일 때만 시도하고, 장부의 거절(`snapshot_hold`, `intake_closed`, `stopped`, `slot_busy`, `run_blocked`, `input_cancelled`, `input_expired`, `deadline_passed`, `run_generation_stale`, `not_startable`, `session_start_closed`)을 그대로 따른다. 복원 5단계의 `queued`는 시작 후보이고 시작의 보장이 아니다. `run_blocked`인 일을 다시 하려면 새 실행 ID로 접수한다. 허가가 버려졌으면(`intake_closed`) 새 `Restorer`로 1단계부터 다시 복원한다. 재시작 뒤 결과 검사는 3단계의 `resumeChecks`·`pendingReports`에서 다시 꺼낸다. 새 세션은 5단계의 `inputs.pending`을 순서대로 한 번씩 전한다.
- **CLI 풀기(§7.6):** 장부 쪽은 `releaseStop({ generation })` 하나다. 풀면 접수가 닫히고 새 복원 시도가 끝까지 마쳐야 열린다. 새 실행 세대를 적는 연산은 아직 없다. 세대를 올리면 옛 세대의 대기 실행은 시작되지 않고(`run_generation_stale`, 5단계 `staleQueued`) 종료 기록만 된다. 확인 단계(`phase`)는 `applyStop`의 `phase`로 같은 세대에 덧붙인다.
- **현관:** 권위 정지 기록의 답은 `{ generation, stopped }` 두 칸이어야 하고 다른 꼴은 모름이다. 게시 연결은 같은 작업 ID에 다른 후보를 다시 연결하지 않는다.

### R2로 보내는 쪽이 지킬 것

**사본을 만들고 보낼 때**

1. 실행마다 없는 새 경로를 넘긴다. 같은 이름을 다시 쓰면 `target_exists`다.
2. 사본 폴더는 감독만 쓰는 폴더에 두고, 링크가 없는 실제 경로를 넘긴다.
3. `ok: true`로 돌려준 `path`만 올린다. `<path>.partial-<UUID>`는 올리지 않고 지운다.
4. 돌려준 `sha256`을 함께 보관하고, 올린 뒤 대조한 다음에 로컬 사본을 지운다.
5. `maxBytes`는 쓰기가 멈춰도 되는 시간과 메모리에 맞춰 정한다. `too_large`와 `snapshot_hold`는 사본이 만들어지지 않은 것이므로 실패로 알린다.

**원격에서 되가져와 장부 자리에 놓을 때**

1. 감독을 멈춘다. 장부를 쥔 프로세스가 있으면 놓지 않는다.
2. 되가져온 파일의 `sha256`을 대조한다.
3. 장부 자리의 본체와 `-wal`·`-shm`·`-journal`을 함께 장부 폴더 밖으로 옮긴다. 하나만 옮기지 않는다.
4. 사본을 장부 이름의 정규 파일 하나로 놓는다(링크, 이름이 둘인 파일은 받지 않는다).
5. `mode: "reopen"`으로 연다. `create`로 열지 않는다. 사본 기록을 고치지 않는다.
6. 보류 상태에서 관리자가 계정 잠금과 영수증을 대조한 뒤 `confirmSnapshotReconciled`를 부르고, 새 복원 시도를 끝까지 마친다.

## 끊김 지점(시험)

`Faults.at(point)`가 부르는 이름: `open:reserved`(새 파일을 예약한 직후), `open:inspected`(파일을 판정한 뒤 SQLite로 열기 전), `snapshot:serialized`(장부의 그림을 받은 뒤), `snapshot:writing`(사본의 조각을 하나 쓸 때마다), `snapshot:written`(임시 파일을 fsync하고 닫은 뒤 이름을 붙이기 전), `migration:<판>`, `<쓰기>:before_commit`(예: `receipt:before_commit`, `stop:before_commit`), `receipt:after_insert`(영수증을 적고 상태를 옮기기 전), `read`. 운영에서는 아무것도 하지 않는다.

## 자리만 만든 묶음

설계 §8 표의 나머지 넷은 칸을 추측으로 채우지 않는다. 빈 마이그레이션 파일도 두지 않는다. 적용된 번호는 고칠 수 없어 빈 판이 번호만 차지하고, 묶음의 칸은 그 작업이 정하기 때문이다. 각 작업이 그때의 다음 번호로 자기 마이그레이션을 더한다.

| 묶음 | 표 이름의 머리 | 마이그레이션을 더하는 작업 |
|---|---|---|
| 계정 장부 | `account_` | O17(`accounts.md` §4) |
| 장애 색인 | `incident_` | O16 |
| 병합 뒤 확인 | `post_merge_` | O16 |
| 삭제 진행 | `deletion_` | O18 |

## 이 작업 밖

R2 전송과 그 일정·보존 기간, 사본을 되가져오는 실행 절차, 보류를 푸는 관리 명령(D-56의 남은 일), 스케줄러·역할 표·작업자 API, 세션 계약의 감독 쪽(세션 시작·교체의 확정과 소비), 현관 계약의 감독 쪽, 실제 연결과 진입점, 포트의 실제 구현, 실행 세대를 올리는 풀기(§7.6), 확인 단계를 올리는 쪽은 뒤 작업이다.
