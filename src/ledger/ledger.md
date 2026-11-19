# 감독 장부 요약

감독 장부(D-56)의 스키마, 쓰기 규칙, 재시작 복원 순서다. 코드는 `src/ledger/`(공개 면은 `index.ts`), 설계의 기준은 homelab `docs/plans/2026-11-13-olive/supervisor.md` §3·§6·§7·§8이다. 표와 코드가 다르면 코드가 맞고, 이 문서를 고친다.

## 파일과 잠금

- SQLite 파일 하나, 감독 하나만 쓴다. `openLedger(path, { clock, mode })`만 장부를 만든다(`Ledger`는 공개 면에 타입으로만 있고 생성자를 직접 부르면 던진다). 실패하면 장부 객체 없이 이유(`locked`, `corrupt`, `full`, `io`, `too_new`, `migration_mismatch`, `migration_failed`, `not_initialized`, `already_initialized`, `foreign_data`, `interrupted_install`, `db_error`)를 돌려준다.
- **지원하는 폴더:** 장부 폴더는 감독만 쓰는 폴더다. 다른 주체가 장부 폴더의 이름을 바꿀 수 있는 경로는 지원하지 않는다. 예약한 파일과 판정한 파일의 동일성 확인은 실수와 끊김을 잡는 것이고, 그런 주체와의 경합까지 막지는 않는다.
- **받는 파일:** 링크가 없는 폴더 안의, 이름이 하나뿐인 정규 파일만 장부로 받는다. 본체와 `-wal`·`-shm`·`-journal` 자리에 심볼릭 링크, 하드 링크, 디렉터리 같은 다른 종류가 있으면 `create`는 `foreign_data`, `reopen`은 `not_initialized`다. SQLite는 링크를 풀어 WAL·저널의 이름을 정하므로 링크를 받으면 검사한 이름과 실제 이름이 갈라진다.
- **`mode`는 호출자가 고른다.** `reopen`은 보통의 기동이다: 파일이 없거나 비었거나 이 설치의 표식이 없거나 첫 설치 기록이 없으면(빈 볼륨, 빈 대체 파일, 다른 파일) 표를 만들지 않고 `not_initialized`로 닫는다. 그래서 장부를 잃은 볼륨이 첫 설치로 착각돼 정지 세대 0을 적는 일이 없다.
- **`reopen`이 쓰기 전에 보는 것:** 식별 표·트리거·판 기록 표의 구조, 적용 기록과 코드의 판 목록, 적용된 판까지의 스키마 전체(코드의 판을 메모리 DB에 적용해 `sqlite_master`를 대조한다), 식별 행의 값, 사본 기록의 값이다. 하나라도 다르면 표식도 표도 적지 않고 `not_initialized`로 닫는다(판이 더 높으면 `too_new`, 이름이 다르면 `migration_mismatch`, 사본 기록이 깨졌으면 `corrupt`). 첫 설치는 모든 판을 적용한 뒤에 식별 행을 적으므로 식별 행이 있는데 적용 기록이 없는 파일은 받지 않는다. 호출자가 넘긴 판 목록도 같은 규칙이고, 적용 기록이 하나도 없으면 무엇과 대조할지 정할 수 없어 빈 목록이어도 거절한다. 커밋을 담을 수 있는 크기의 WAL이 곁에 있으면 같은 판정을 읽기 전용 연결로 먼저 한다. 읽기쓰기 연결은 닫을 때 WAL을 체크포인트하므로, 그런 쌍은 거절할 때 읽기쓰기 연결을 열지 않는다. 그보다 작은 WAL이 곁에 있으면 읽기쓰기 연결에서 판정하므로 스키마가 달라 거절해도 그 WAL 이름이 사라진다("알려진 결함"의 "스키마 거절과 짧은 WAL").
- **`create`가 받는 것은 둘뿐이다.** ① 없는 경로: `O_CREAT|O_EXCL`로 이 호출의 파일을 원자적으로 예약한다(남은 WAL·SHM·저널이 있으면 예약하지 않는다). ② 끊긴 같은 설치: 첫 설치 기록이 없고, WAL·SHM이 없고(저널은 끊긴 트랜잭션의 것이라 있어도 된다), **파일의 스키마 전체와 모든 행이 이 코드의 첫 설치가 어느 판까지 적용했을 때 남기는 내용과 정확히 같은** 파일이다. 코드의 마이그레이션을 메모리 DB에 판마다 적용해 대조한다(적용 시각만 뺀다). 업무 기록이 한 줄이라도 있거나 판 기록만 흉내 낸 파일은 증거가 없어 거절하고, 내용이 같으면 이어 받아도 잃을 것이 없다. 이미 있는 0바이트 파일은 이 설치가 예약했다는 증거가 없어 받지 않으므로, 예약 직후에 끊겨 남은 빈 파일은 사람이 지운 뒤 다시 `create`한다.
- **끊긴 첫 설치(`interrupted_install`):** 저널이 남은 파일의 본체가 ②의 내용과 정확히 같으면 `create`가 그대로 이어 받는다. 저널이 있고 **본체 내용만으로 이어 받기를 입증하지 못하면** 이 사유로 닫는다. 이 사유는 그 저널이 정말 끊긴 설치의 것이라는 확인이 아니다(저널의 내용은 읽지 않는다). **파일을 지우지 않는다.** 사람이 할 일: ① 같은 경로로 `reopen`을 한 번 부른다. 연결이 저널을 되돌리고 첫 설치 기록이 없으므로 결과는 `not_initialized`가 맞다. ② 다시 `create`를 부른다. 되돌린 내용이 ②와 같으면 이어 받는다. ③ 그래도 `foreign_data`면 끊긴 설치가 아니므로 파일을 보존하고 내용을 확인한다.
- **판정은 파일을 바꾸지 않는다.** 판정은 `lstat`과 본체만 읽는 SQLite 연결(`immutable=1`: 잠금을 잡지 않고 WAL·저널을 보지 않는다)로 한다. 낯선 DB, 옛 스키마의 장부, 본체 없이 남은 WAL·SHM은 파일을 바꾸지 않고 `foreign_data`, 첫 설치를 마친 장부는 `already_initialized`, SQLite 파일이 아니면 `corrupt`다. **본체 길이 검사**(페이지 경계에서 끝나지 않으면 끊긴 파일로 `corrupt`)는 본체만으로 판단할 수 있는 파일에 건다: 곁 파일 없는 독립 본체(사본)와, 커밋을 담을 수 없는 크기(머리 32바이트 + 프레임 하나 미만)의 WAL만 곁에 있는 본체다. `reopen`에서 커밋을 담을 수 있는 크기의 WAL이 곁에 있으면 체크포인트가 페이지 중간에서 끊긴 정상 장부일 수 있어 길이로 판정하지 않고, WAL까지 읽은 SQLite의 `quick_check`와 재개방 검증으로 판단한다. 이 경우 WAL이 덮지 못한 마지막 페이지의 잘림은 `quick_check`가 잡는 만큼만 가려진다. 체크포인트가 파일을 늘리다 끊겨 머리의 페이지 수가 본체 길이보다 앞서면 본체만 읽는 연결은 식별을 읽지 못한다(`SQLITE_CORRUPT`). 그 실패가 `reopen`·저널 없음·커밋을 담을 수 있는 크기의 WAL인 쌍에서 났을 때만 본체 머리 100바이트를 FD로 읽고(아래 "잠금"의 예외), 그 머리의 이 설치 표식과 처음 여는 사본의 표식으로 본체만 읽을 때와 같은 거절을 먼저 한 뒤, 머리의 페이지 수가 유효하고(offset 92와 24가 같다) 본체 길이를 페이지로 올린 수보다 클 때만 같은 방법(길이 대신 WAL까지 읽은 SQLite)으로 판단한다. 그 밖에서 식별을 읽지 못하면 `corrupt`다. 처음 여는 사본 곁의 WAL은 이 예외를 받지 않고 거절한다. 이런 WAL이 곁에 있는 장부를 판정에서 거절할 때 본체·WAL의 바이트와 곁 파일의 목록은 그대로다(읽기 전용 판정이 만든 `-shm`은 지운다. 판정이 겹치면 다른 판정자가 쓰는 `-shm`일 수 있다: "알려진 결함"의 "겹친 판정의 `-shm` 정리"). 저널이 함께 남은 쌍과, 판정을 지난 뒤 판을 적용하다 실패한 경우에는 이 보장이 없다: 읽기쓰기 연결이 닫히며 SQLite가 체크포인트한다. 새로 예약한 파일의 기준(장치·inode)은 예약한 FD가 살아 있을 때 그 FD에서 얻는다. 연 뒤에는 경로가 기준과 같은지 첫 읽기 전과 잠금 뒤에 다시 보고, `create`는 잠금을 쥔 내용으로 ②를 다시 판정한 뒤에만 표식과 표를 쓴다. 판정과 열기 사이에 경로를 바꿨다가 되돌리는 의도적인 이중 교체까지는 가르지 못한다. 완전히 빈 볼륨이 정말 새 설치인지는 파일만으로 가를 수 없어 호출자의 `mode`에 맡긴다.
- **잠금:** `locking_mode=EXCLUSIVE`와 빈 `BEGIN EXCLUSIVE`로 여는 순간 파일 잠금을 잡고 닫을 때까지 쥔다. 둘째 작성자는 같은 프로세스든 다른 프로세스든 `SQLITE_BUSY`로 `locked`다(`busy_timeout` 0). 프로세스가 죽으면 운영체제가 잠금을 푼다. **살아 있는 장부 파일을 SQLite 밖의 FD로 열지 않는다.** POSIX 잠금은 같은 프로세스가 같은 파일의 다른 FD를 닫기만 해도 풀리기 때문이다. **예외는 판정의 머리 읽기 한 곳이다(관리자 결정).** 위 판정이 머리를 FD로 읽기로 한 쌍에서만, `/proc/locks`에 이 프로세스의 pid로 같은 inode의 잠금 줄이 없음을 확인한 뒤 본체를 읽기 전용·`O_NOFOLLOW`로 열고, `fstat`이 판정한 장치·inode와 같을 때 맨 앞 100바이트만 읽고 닫는다. 이 프로세스가 그 파일을 쥐고 있으면 FD를 열지 않고 `locked`, `/proc/locks`를 읽지 못하거나 꼴을 모르는 줄이 있으면 FD를 열지 않고 `corrupt`다. 장치 번호는 비교하지 않는다: stat의 장치 번호가 잠금 목록과 다른 파일시스템(btrfs 하위 볼륨 등)에서 쥔 파일을 놓치지 않으려는 것이고, 넓게 잡은 쪽은 `locked`로 끝날 뿐이다. 확인과 닫기 사이에 같은 프로세스의 다른 스레드가 그 파일을 잠그면 풀리므로 장부를 여는 스레드는 하나라는 전제다. WAL과 그 밖의 바이트는 SQLite 밖에서 읽지 않는다. SQLite 밖에서 FD를 여는 곳은 이 머리 읽기와 이 호출이 `O_EXCL`로 만든 새 파일 두 곳(장부의 예약, 사본의 임시 파일)뿐이다. `test/ledger/static.test.ts`가 모듈별로 쓸 수 있는 `node:fs` 이름을 막는다(SQL 마이그레이션 로더의 읽기는 `migrate.ts`에만, `/proc/locks` 읽기와 읽기 전용 머리 열기 한 곳은 `ledger.ts`에만 허용한다).
- **저널:** `journal_mode=WAL`, `synchronous=FULL`. 커밋마다 WAL을 fsync하므로 커밋을 돌려준 실행 줄은 전원이 나가도 남고, 감독은 실행 줄의 커밋 뒤에만 지시를 내므로 접수 기록이 영수증보다 먼저 남는다. `NORMAL`은 마지막 커밋을 잃을 수 있어 고르지 않았다. EXCLUSIVE라 `-shm` 파일이 없다. 로컬 볼륨 전제다. 첫 설치만 저널 모드로 진행하고 첫 설치 기록을 커밋한 뒤에 WAL로 바꾼다. 끊긴 첫 설치의 내용이 본체에만 있어야 WAL을 복구하지 않고 판정할 수 있다.
- **chunk size:** `openLedger`의 읽기쓰기 연결은 첫 쓰기 전에 `SQLITE_FCNTL_CHUNK_SIZE` 4,096(페이지 크기)을 건다. `create`와 `reopen`, 새 파일과 이미 있는 장부 모두 같다. 체크포인트가 페이지를 옮기기 전에 본체를 늘려, 도중에 프로세스가 죽어도 머리의 페이지 수가 본체보다 앞서지 않는다(Bun 1.4.4·SQLite 3.53.4, tmpfs에서 체크포인트 도중 SIGKILL로 확인했다). 걸지 못하면 `db_error`다. 판정의 읽기 전용 연결, 메모리 DB, 사본(`serialize()` 그림을 FD로 쓴다)은 체크포인트로 본체를 늘리지 않아 걸지 않는다. 실제 전원 차단에서 파일 길이와 1번 페이지의 디스크 반영 순서는 확인하지 못했다.
- 열 때 `quick_check`로 깨진 파일을 거른다. `foreign_keys=ON`.

## 마이그레이션

`migrations/NNNN-이름.sql`을 번호 순서대로 한 번씩 적용한다.

| 판 | 내용 |
|---|---|
| `0001-core` | 아래 "표"의 핵심 표와 그 트리거·인덱스·제약. `instructions.lease_until`은 판 2, `tool_requests`는 판 3이 만든다 |
| `0002-renew-lease-end` | `instructions.lease_until`(INTEGER, NULL 허용) 칸 하나. 갱신 지시(`run_renew`)만 값을 가질 수 있고 그 값은 발행 시각보다 늦고 9007199254740991 이하다(CHECK). 칸만 더하므로 기존 줄은 NULL(끝 모름)이고 다른 칸의 값과 제약은 그대로다 |
| `0003-tool-requests` | 표 `tool_requests`와 트리거 셋(`tool_requests_born_waiting`, `tool_requests_permanent`, `tool_requests_fixed`). 아래 "작업 부탁(배정 전 대기)". 새 표만 더하므로 기존 표·줄은 그대로다 |

판 하나는 트랜잭션 하나라 도중에 실패하거나 끊기면 그 판 전체가 되돌려진다. 적용 기록은 `ledger_migrations(version, name, applied_at)`. 번호가 비거나, 이름과 번호가 다르거나, 폴더에 꼴이 다른 파일이 있거나, 장부의 판이 코드보다 높거나, 같은 번호의 이름이 다르면 열지 않는다. 호출자가 `migrations`로 넘긴 목록도 같은 검사를 파일을 열기 전에 자리마다 거친다(배열의 빈 자리 포함). 적용 시각으로 쓸 시계의 값도 파일을 건드리기 전에 확인한다.

**지원하는 판의 범위: 모든 판은 식별 행이 없는 빈 DB에서 번호 순서대로 재생할 수 있어야 한다. 기존 행에 기대는 판(데이터 이관이 필요한 판)은 이 장부가 아직 지원하지 않는다.** 재개방은 코드의 판을 빈 메모리 DB에 재생한 스키마와 장부를 대조하기 때문이다. 판을 올리는 `reopen`과 `create`는 실제 판을 커밋하기 전에 목록 전체를 재생해 보고, 재생하지 못하면 장부를 바꾸지 않고 `migration_failed`로 거절한다. 판이 하나도 없는 목록의 `create`는 재개방이 대조할 적용 기록이 남지 않으므로 파일을 만들지 않고 `migration_mismatch`로 거절한다. 재생은 되지만 실제 장부의 행에 따라 다른 스키마를 남기는 판(행이 있을 때만 통계 표를 만드는 `PRAGMA optimize` 등)은 미리 가르지 못한다. 판의 결과 스키마는 데이터에 따라 달라지면 안 된다.

이 장부는 아직 어디에도 배포되지 않아 리뷰 반영을 `0001-core.sql`에 직접 고쳤다. **첫 배포 뒤에는 기존 번호를 고치지 않고 다음 번호로 더한다.**

## 표

`instructions.lease_until`은 `0002-renew-lease-end`, `tool_requests`는 `0003-tool-requests`이고 나머지는 모두 `0001-core`다.

| 묶음 | 표 | 요지 |
|---|---|---|
| 정지·일시 중지 | `stop_state`, `diagnosis_pause` | 정지 세대(0 포함, 줄이 없으면 아직 적지 않음), 정지 여부, 확인 단계, 진단 일시 중지의 끝 |
| 실행·슬롯·예산 | `runs`, `run_epoch`, `run_transitions`, `instructions`, `slot_holds` | 실행 ID·세대·역할·revision 둘·snapshot·실행기·자격 네 칸·기한·남은 예산·상태·영수증 id들. 낸 지시(v1 여섯, 적은 뒤 불변)와 갱신 지시가 발급한 임대 끝("스케줄러가 쓰는 읽기"의 "발급한 갱신의 끝"). 점유가 맞지 않은 관측: (실행기, 실행, 세대)마다 한 줄이고 관측 번호를 가진다. 줄이 있으면 그 실행 ID를 영영 시작하지 않고, `holds_slot`이면 그 종류의 슬롯도 막는다 |
| 입력·대기열 | `inputs` | 요청 ID, 인증된 출처, 원문 참조(`<저장소>/<UUID>`)와 만료, 순번, 취소 |
| 작업 부탁 | `tool_requests` | 오케스트레이터의 `start_worker` 부탁: 참조(UUID), 소유자(논리 요청, `inputs`의 외래 키), 재시도 키(`dedupe_key`), 역할·목적 분류·원본 참조·입력 digest, 기록한 세션·호출 ID, 단계(`waiting_assignment`·`not_started`), 이은 실행(`run_id`, 배정 전에는 비어 있음), 기록·취소 시각과 취소한 세션·호출 ID. (소유자, 재시도 키)마다 한 줄 |
| 영수증·보고 | `deliveries`, `receipt_conflicts`, `report_signals` | 받은 id와 본문 digest, 속한 실행(외래 키), 가리킨 지시, 결과 보고의 저장 자리·digest·반영 시각. 같은 id에 다른 digest의 기록(같은 충돌은 한 줄). 훅·세션 깨짐 보고의 구조화 칸(사건 종류, `session_id`, 턴 ID, 오류 종류, 원인, 표식 digest, 관측 시각) |
| 세션·인계 | `sessions`, `rule_checks`, `session_takeovers`, `start_permit_uses` | 세션 ID, 시작 순번, 세대 표식 digest, 교체 시각, 처리 위치, 인계 참조, 규칙 확인(D-51)과 낸 쪽, 교체 기록(앞 실행·인수 발신자·표식·허가·확정한 규칙 확인·다음 실행, D-50), 시작 허가의 한 번 사용. **지금 쓰는 것은 `rule_checks`와 `session_takeovers`의 받은 칸뿐이다**("세션 증거" 참조) |
| 게시 연결 | `publications` | 현관 작업 ID, 후보 digest, 대기·확정·모름(확정이면 posted·not_posted) |
| nonce | `nonces` | 감독이 받는 봉투의 (낸 쪽, nonce). 계약의 `NonceStore` |
| 사본 기록 | `ledger_snapshots` | 이 파일이 어느 장부(`ledger_id`)의 어느 시각(`taken_at`)의 사본인지, 대조 끝 시각과 그 사본의 식별. 원본 장부에는 줄이 없다. 지울 수 없고 바꿀 수 있는 것은 대조 끝 한 번뿐이다(트리거) |

`ledger_identity`(첫 설치 기록)는 마이그레이션이 아니라 `openLedger`의 `create`가 만든다.

**넣지 않는 것:** 원문(요청 글, 모델 출력, 로그)과 자격 값. 원문은 참조와 만료만, 자격은 계정·방식·revision·digest만 둔다. 쓰기 함수는 정해진 칸만 받고(모르는 칸이면 `LedgerInputError`), 칸마다 좁은 꼴만 받는다: 계정은 계약의 별칭 꼴(소문자·숫자·하이픈 32자), 방식은 `subscription`·`api_key`, 실행기는 계약의 실행기 주체 이름, 원문·결과 참조는 `<저장소 이름>/<UUID>`. `test/ledger/static.test.ts`가 스키마의 칸 이름과 쓰기 함수가 실제로 받는 칸(`exact`의 칸 목록, 인라인 인자 타입, 입력 타입)을 막는다.

**정수:** 장부 표의 정수 칸은 모두 0(또는 1)부터 9007199254740991까지다(STRICT 열의 CHECK, 쓰기 함수의 `Number.isSafeInteger`). `ledger_migrations`의 판과 적용 시각, `receipt_conflicts.seq`, `slot_holds.observation`도 같다. 예외는 SQLite가 관리하는 내부 표 `sqlite_sequence`뿐이다. 읽은 세대·예산이 안전 정수가 아니면 그 값으로 판단하지 않고 `corrupt`로 닫는다.

## 새 업무를 열어도 되는 조건

새 접수·작업 부탁·배정·실행 줄·시작·자격·게시·갱신(`enqueueInput`, `recordToolRequest`, `assignToolRequest`, `admitRun`, `startRun`, `startSession`, `recordPublication`, `recordRenewInstruction`)은 모두 한 자리(`Ledger`의 쓰기 모드 `start`)의 전제를 거친다.

1. 장부가 건강하다(한 번이라도 쓰기·읽기가 실패했으면 다시 열 때까지 `ledger_unwritable`).
2. 사본에서 떠 대조가 끝나지 않은 장부가 아니다(`snapshot_hold`, "사본에서 뜬 장부의 보류").
3. 같은 트랜잭션 안에서 읽은 지금의 정지 기록이 있고(`stop_unknown`) 정지가 아니다(`stopped`).
4. 살아 있는 접수 허가가 있다(`intake_closed`).

**접수 허가는 "어느 복원 시도가, 어느 정지 세대에서 냈는가"에 묶인 한 자리다.** 장부는 열 때마다 허가 없이 시작하고, 복원 5단계만 허가를 낸다. 아래 가운데 하나가 일어나면 허가는 버려지고, 새 복원 시도가 1~5단계를 끝까지 다시 마칠 때까지 새 업무는 닫혀 있다.

- 정지 기록의 세대나 정지 여부가 바뀐다(`applyStop`, `mergeStop` 모두).
- 관리자가 푼다(`releaseStop`).
- 새 복원 시도가 시작된다(1단계 호출).
- 사본 대조가 끝난다(`confirmSnapshotReconciled`). 이때는 허가뿐 아니라 진행 중이던 복원 시도도 끝난다.
- 장부의 쓰기나 읽기가 실패한다.

복원 시도는 1단계에서 정지 기록을 합친 시점의 정지 상태에 고정된다. 그 뒤에 정지가 걸렸다 풀렸으면 그 시도의 5단계는 `stop_changed`로 닫힌다. 앞서 모은 대조가 풀리기 전의 것이기 때문이다. 더 새로운 시도가 시작되거나 사본 대조가 끝난 뒤에는 앞 시도의 늦은 응답과 늦은 단계가 `RestoreStepError`로 실패하고 지금의 허가를 바꾸지 못한다.

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

## 스케줄러가 쓰는 읽기

스케줄러의 판단(`src/supervisor/scheduler/`의 `planNext`·`nextIntent`)은 상태를 갖지 않고 장부에서 읽은 것을 인자로 받는다. 그 입력은 공개 읽기 `queueView`·`listRuns`·`slotHolds`와 아래 둘로 조립한다. 둘 다 장부를 바꾸지 않고, 원문·원문 참조·자격 값을 싣지 않는다.

| 공개 함수 | 돌려주는 것 | 쓰는 곳 |
|---|---|---|
| `listInputs()` | `Read<InputEntry[]>`. 접수한 입력 전부를 순번대로: `requestId`, `seq`, `source`(접수 때 받은 출처 이름 그대로), `receivedAt`, `expiresAt`(원문 만료), `cancelled`. 처리 위치(`processedSeq`)를 지난 입력도 낸다 | `planNext`의 입력(`origin`·`receivedAt`·`expiresAt`·`cancelled`), 시작한 실행의 `cancelRequested` |
| `instructionTimes(runId)` | `Read<InstructionTimes \| null>`. 없는 실행이면 `null`. `lease`(판단이 살아 있는 임대로 쓰는 값: 임대를 준 지시의 `issuedAt`과 장부가 믿는 임대 끝 `expiresAt`), `renewIssued`(발급 기록: `issuedAt`은 기록된 갱신 발행 시각의 최댓값, `leaseUntil`은 아래 "발급 기록"의 검사를 통과한 마지막 발급의 끝이고 그 밖에는 모름. 판단에 넘기지 않는다), `lastStopAt`(`task_cancel`·`session_stop`의 기록된 발행 시각 최댓값), `lastFinalizeAt`(`result_finalize`의 기록된 발행 시각 최댓값) | `nextIntent`의 `lease`·`lastInstructionAt` |

- **출처 이름은 분류하지 않는다.** `source`를 관리자 요청과 자동 경보로 나누는 규칙은 접수 정책의 몫이다. 장부는 `enqueueInput`이 받은 이름을 그대로 낸다.
- **모름과 미발행:** 읽기가 실패하면 `{ known: false }`다. 읽기가 성공했을 때 `lease`·`renewIssued`·`lastStopAt`·`lastFinalizeAt`의 `null`은 그런 지시를 낸 적이 없음을 장부에서 확인한 값이다. `lease.expiresAt`의 `"unknown"`은 지시는 있는데 실행기의 그 임대의 끝을 장부가 모른다는 뜻이고, `renewIssued.leaseUntil`의 `"unknown"`은 발급한 끝을 장부가 갖지 않거나 가를 수 없다는 뜻이다. 0이나 짐작한 값으로 채우지 않는다.
- **임대의 끝:** 시작 지시(`task_start`)의 임대 끝은 계약이 정한 값(발행 시각 + `RUN_LEASE_MAX_MS`, 실행기가 머리의 `issued_at`에서 같은 식으로 정한다)이라 장부의 `issued_at`에서 계산한다. 지시의 머리에 장부의 `issued_at`보다 이른 시각을 실으면 이 값이 실제보다 늦어진다. **세션 시작 지시의 임대 끝은 장부에 없어 언제나 `"unknown"`이다.** 갱신이 없을 때만 시작 지시의 임대이고, 발행 시각이 같은 시작 지시가 여럿이면 하나라도 모르면 모름, 아니면 이른 끝이다.
- **갱신 뒤의 임대(일찍 낸 갱신을 믿는다, D-89 후보):** 갱신 지시가 하나라도 있으면 `lease.issuedAt`은 기록된 갱신 발행 시각의 최댓값이다. `lease.expiresAt`은 발급 기록의 끝이 숫자이고(아래 "발급 기록"의 검사를 모두 통과) **시작 임대부터 그 갱신까지 사슬의 갱신마다 `발행 시각 + RENEW_MARGIN_MS <= 앞 임대의 끝`**일 때만 그 끝이고, 하나라도 아니면 `"unknown"`이다. **이 끝은 감독의 추정이다.** 실행기 계약 v1에는 갱신의 영수증이 없어, 아래 가정 안에서만 실행기가 적용한 끝과 같다.
  - **식:** `RENEW_MARGIN_MS = DELIVERY_MAX_MS + CLOCK_SKEW_MS + RENEW_HANDLING_MS` = 10000 + 1000 + 2000 = **13000ms**(기본값). `RENEW_HANDLING_MS`(처리 허용치)는 **감독 쪽 기본값(관리자 미확정)**이고 계약(`src/contract/`)의 상수가 아니다. 재 본 값이 아니고, 기본 갱신 간격(`RENEW_INTERVAL_MS`)에서 갱신을 낼 수 있는 구간 `RUN_LEASE_MAX_MS − RENEW_MARGIN_MS − RENEW_INTERVAL_MS`가 7000ms 남도록 골랐다.
  - **가정 넷:** (1) 전달(연결에 실은 때부터 실행기가 받기까지) `< DELIVERY_MAX_MS`. (2) 두 시계의 차이 `<= CLOCK_SKEW_MS`. (3) 양끝의 처리 시간의 합 `<= RENEW_HANDLING_MS`: 장부에 갱신을 적은 시각부터 연결에 싣기까지 + 실행기가 받은 시각부터 임대를 검사하기까지(실행기는 받은 시각에 봉투를 검증하고, nonce를 저장한 뒤 시각을 다시 읽어 검사한다: `src/executor/link.ts`, `src/executor/store.ts`의 `consume`, `src/executor/worker.ts`의 `onRenew`·`expire`). (4) 봉투가 실행기에서 검사될 때 시한 안(뒤 작업이 지킬 송신 규칙, 아래 "뒤 작업이 알아야 할 것"의 "스케줄러").
  - **등호도 믿는 이유:** 실행기는 자기 시계로 검사 시각이 앞 임대의 끝 이상(정각 포함)이면 연장하지 않고 닫는다. 발행 시각 `s`(감독 시계)의 갱신이 검사되는 시각은 감독 시계로 `s + 싣기까지의 처리 + 전달 + 받은 뒤의 처리`이고 실행기 시계가 앞서는 만큼 더 늦게 읽힌다. 가정 안이면 검사 시각 `< s + RENEW_MARGIN_MS <= 앞 임대의 끝`이다.
  - **가정의 경계(`test/ledger/lease-trust.test.ts` "가정의 경계"):** 시작 `T`이면 장부가 믿는 마지막 발행은 `T+17000`이다. 전달 9999ms, 실행기 시계 +1000ms, 처리 1ms이면 검사는 `T+28000`이고, 처리가 허용치 끝(2000ms)이어도 `T+29999`라 적용된다. 나머지가 가정의 끝(전달 9999ms, 시계 +1000ms, 처리 2000ms)일 때 처리가 2001ms이거나 전달이 10000ms이거나 시계가 1001ms 앞서면(가정 밖) 검사가 `T+30000`이라 실행기는 닫고, 장부는 끝을 `T+47000`으로 믿는다. 처리 허용치를 넣지 않은 여유(전달 + 오차 = 11000ms)라면 마지막 발행이 `T+19000`인데, 그 갱신은 처리 1ms로도 `T+30000`에 검사되어 닫힌다. 장부는 그 갱신을 믿지 않고 판단도 그 시각에 갱신을 내지 않는다.
  - 늦게 낸 갱신 하나가 사슬에 있으면 그 뒤 갱신이 제때여도 모름이다(실행기는 늦은 갱신을 거절하고 그 앞 임대의 끝에서 이미 닫았을 수 있다). 수명 판단(`nextIntent`)은 같은 여유가 남지 않으면 갱신을 내지 않는다(`src/supervisor/scheduler/lifecycle.ts`의 `RENEW_MARGIN_MS`, 같은 식). 그래도 장부는 늦은 갱신을 기록받을 수 있다: 판단을 거치지 않은 호출자뿐 아니라 같은 배정기도 판단 뒤 시각을 다시 읽어 그 시각으로 기록하면 늦은 갱신이다(장부는 그 끝을 믿지 않고 판단은 조회로 간다). 두 자리의 값이 같은지는 같은 시험 파일의 경계 시험이 지킨다.
- **반대 증거가 이긴다:** `lease`는 지시의 시각만 본다. 실행기의 종료 확인 영수증을 받으면 실행은 `checking`·`failed_stopped`로, 끊김 표시(`markLost`)나 복원 3단계 뒤에는 `unknown_running`으로 옮겨 가고, 그 상태에서 `nextIntent`는 믿은 임대가 남아 있어도 갱신을 내지 않는다(결과 검사·확정, 같은 ID 조회). 갱신 기록도 거절된다: 접수가 열려 실행 상태 검사에 이르면 `preparing`·`running` 밖에서 `transition_denied`이고, 복원 중처럼 접수가 닫혀 있으면 공통 접수 검사가 먼저 `intake_closed`를 낸다. 슬롯은 임대와 무관하게 종료 확인까지 쥔다("쓰기 규칙"의 "슬롯").
- **남는 한계(가정 밖, 갱신의 유실):** 믿은 갱신이 실행기에 적용되지 않으면(전달 중에 사라짐, 가정 밖의 지연, 송신 규칙으로 싣지 않음) 장부와 실행기의 끝이 갈린다. 실행기는 그 전에 다른 유효한 갱신을 받지 않았다면 앞 임대의 끝 `L`에서 닫고, 장부는 그 갱신이 발급한 끝 `s + RUN_LEASE_MAX_MS`까지 살아 있다고 낸다.
  - **한 번 발급한 두 끝의 차이(같은 숫자 축):** `(s + RUN_LEASE_MAX_MS) − L`. 믿는 갱신은 `s + RENEW_MARGIN_MS <= L`이므로 최댓값은 **`RUN_LEASE_MAX_MS − RENEW_MARGIN_MS` = 30000 − 13000 = 17000ms**(기본값).
  - **실제 종료에서 장부의 끝까지(감독 시계):** 실행기 시계가 `CLOCK_SKEW_MS`만큼 앞서면 실행기가 임대로 닫는 순간은 감독 시계로 `L − CLOCK_SKEW_MS`다. 최댓값은 **`RUN_LEASE_MAX_MS − RENEW_MARGIN_MS + CLOCK_SKEW_MS` = 18000ms**다(실행기가 닫는 순간 기준이고 프로세스 정리 시간은 들지 않는다). 예: 시작 `T`, `T+17000`의 갱신이 사라지면 실행기는 감독 시계 `T+29000`에 닫고 장부의 끝은 `T+47000`이다.
  - **차이는 반대 증거가 장부에 닿을 때까지 늘어난다.** 감독은 그 뒤에도 그 실행을 `running`으로 보고 갱신 주기마다 갱신을 적고, 그 갱신도 여유를 지켰으면 믿는다. 앞의 예에서 `T+27000`, `T+37000`, …의 갱신으로 장부의 끝은 `T+57000`, `T+67000`, …으로 늘고, 이미 닫힌 실행기는 뒤 갱신을 적용하지 않는다. 위 두 최댓값은 갱신 하나에 대한 값이다.
  - **감독이 알게 되는 길:** 셋 모두 반대 증거가 장부의 실행 상태에 닿아야 판단이 바뀐다. 지금 저장소에는 운영 중 그 증거를 장부까지 잇는 코드가 없다.

    | 길 | 지금 저장소에서 이어진 구간 | 뒤 작업이 이어야 하는 구간 |
    |---|---|---|
    | 실행기의 종료 영수증 | 실행기: 임대가 끝나면 실패로 닫고(`worker.ts`의 `expire`) 남은 프로세스 0개를 센 뒤 `receipt_stopped`를 저장·송신하고, 받음 확인이 없으면 다시 보낸다(`tick`). 감독 연결: 검증한 영수증을 `forward` 출력으로 낸다(`src/supervisor/transport/connections.ts`). 장부: `applyReceipt`를 부르면 같은 트랜잭션에서 `failed_stopped`가 된다(시험으로 확인) | `forward` → `applyReceipt` → ack를 잇는 운영 처리기. **미확인**(제품 코드에 호출이 없다). 남은 프로세스 수를 모르면 실행기는 `unknown_running`에 머물고 종료 영수증을 내지 않는다 |
    | 끊김 판정 | 계약의 `viewLink`가 마지막 수신부터 `DISCONNECT_JUDGE_MS`(30초) 뒤 `lost`를 내고, 살아 있지 않은 연결에는 `mayIssue`가 지시를 막는다(`src/contract/v1/transport.ts`). `markLost`는 진행 중 실행 전부를 `unknown_running`으로 옮기고, 지금 부르는 곳은 복원 3단계뿐이다(`src/ledger/restore.ts`) | 운영 중 끊김을 그 실행기의 그 실행만 `unknown_running`으로 옮기는 장부 쓰기와 그 호출. **미확인**(없다). 기록 때마다 `mayIssue`를 보면 연결이 끊긴 뒤 장부의 마지막 끝은 마지막 수신 + `DISCONNECT_JUDGE_MS` + `RUN_LEASE_MAX_MS`(60초) 미만이지만, 다른 유효한 수신이 이어지는 동안에는 이 상한이 없다 |
    | 상태 조회 | 실행기는 같은 ID 조회에 파일에 적힌 상태·세대·마지막 영수증 ID를 답한다(`worker.ts`의 `onStatus`). 감독 연결은 받은 `status_report`를 점유 응답(`partial`)으로 낸다. 장부의 상태를 바꾸는 길은 복원 2·3단계뿐이다. 판단은 믿은 임대에 여유가 남는 동안 조회를 내지 않는다 | 운영 중 조회의 송신, 답과 질문의 상관(`not_known`은 세대가 null), 그 실행의 장부 쓰기. **미확인**(없다). 답에는 실행기의 임대 끝이 없다 |

  - **슬롯:** 어느 경우에도 슬롯은 종료가 확인될 때까지 풀리지 않는다("쓰기 규칙"의 "슬롯"). 일이 겹치지 않고 자리가 그만큼 늦게 풀린다.
- **발급한 갱신의 끝:** `recordRenewInstruction`은 `leaseUntil`(넘긴 `now` + `RUN_LEASE_MAX_MS`)을 돌려준다. 부르는 쪽은 그 값을 갱신 본문의 `lease_until`에, `now`를 머리의 `issued_at`에 그대로 싣는다. 계약이 허락하는 가장 긴 갱신이다(`parseRunRenew`). 장부는 같은 값을 `instructions.lease_until`에 적는다. 이 값은 감독이 발급한 끝이고 실행기가 적용한 끝이 아니다. **같은 실행의 앞 임대 지시(시작·갱신) 가운데 발행 시각이 `now` 이상인 것이 있으면 끝을 적지 않는다(NULL).** 기록 자체와 거절 조건은 그대로다. 장부에는 지시의 기록 순서가 없어서, 끝을 적은 갱신들의 발행 시각이 기록 순서대로 엄격히 늘게 하는 곳이 이 기록이다. `now` + `RUN_LEASE_MAX_MS`가 안전 정수를 넘는 `now`는 본문을 만들 수 없어 `LedgerInputError`다.
- **발급 기록:** 갱신이 있으면 `renewIssued`는 발행 시각이 가장 큰 갱신의 시각과 그 끝이다. 갱신을 발행 시각 순서로 시작 임대부터 이어 보아, 하나라도 아래에 걸리면 끝은 `"unknown"`이다: 끝이 없는 갱신(이 판 전에 적힌 줄, 순서가 어긋나 적지 않은 줄), 앞 임대 지시보다 늦지 않은 발행 시각(같은 시각 포함), 앞 임대(시작 임대, 그 뒤로는 앞 갱신이 발급한 끝)의 끝 이후에 낸 갱신, 발행 시각 이하이거나 발행 시각 + `RUN_LEASE_MAX_MS`보다 늦은 끝, 시작 임대의 끝을 모름. 끝을 저장했는지는 기록 순서만 가른다. **위 검사를 모두 통과할 때만**(각 갱신이 끝을 갖고, 발행 시각이 엄격히 늘고, 각 갱신이 앞 임대가 끝나기 전에 발행됐을 때) 내는 끝은 실제로 마지막에 기록한 갱신이 발급한 끝과 같다. 모든 갱신이 끝을 가져도 그중 하나가 앞 임대의 끝 이후에 발행됐으면 모름이다(시작 `T`, 갱신 `T+30000` 하나면 저장값은 `T+60000`이고 발급 기록의 끝은 `"unknown"`). 모름이 된 실행은 그 뒤에 갱신을 적어도 모름이다. 이 검사는 발행 시각만 보므로 숫자가 나와도 실행기가 그 끝을 적용했다는 뜻이 아니다. 여유는 보지 않는다: 늦게 낸 갱신의 끝도 여기에는 숫자로 남고, 임대로 믿을지는 위 "갱신 뒤의 임대"가 가른다.
- **필요한 판:** `instructionTimes`와 `recordRenewInstruction`은 판 2(`0002-renew-lease-end`) 이상의 장부를 요구한다. 기본 판 목록으로 여는 재개방은 판 2까지 올라간다. **`migrations` 옵션으로 판 목록을 그 앞에서 끊어 연 장부(시험용 길)에서는 기존 실행의 `instructionTimes`가 `{ known: false, reason: "db_error" }`, `recordRenewInstruction`이 `ledger_unwritable`로 닫히고 건강 상태가 `{ writable: false, reason: "db_error" }`가 된다.** 그 뒤에는 다른 실행의 새 접수(`admitRun` 등)도 `ledger_unwritable`이다. 틀린 값을 내지 않고 닫히는 쪽이다.
- **종료·확정은 발행 시각의 최댓값:** `lastStopAt`·`lastFinalizeAt`은 마지막으로 기록한 행이 아니라 기록된 발행 시각의 최댓값이다. 더 이른 시각으로 나중에 기록한 지시는 앞 지시의 시각에 가려진다.
- **지금 상태로 좁히지 않는다:** 장부는 실행이 지금 상태에 들어온 시각을 따로 적지 않는다. `lastStopAt`·`lastFinalizeAt`은 상태와 무관한 그 실행의 마지막 지시다. 예를 들어 `cleanup_pending`의 `lastFinalizeAt`은 그 앞 상태에서 낸 확정 지시일 수 있고, 그러면 확정 재시도가 그 시각부터 답을 기다린 뒤에 나온다.

## 작업 부탁(배정 전 대기)

오케스트레이터 세션이 `start_worker`로 낸 부탁을 실행 줄과 따로 적는다. 부탁을 받은 순간에는 맞는 실행기나 계정이 없을 수 있다. 그때 실행 줄(`admitRun`: 실행기·자격·기한·예산을 가진다)을 만들거나 가짜 실행기 ID를 채우지 않고, 부탁만 적고 참조를 돌려준다. 맞는 실행기를 고른 쪽(배정기)이 `assignToolRequest`로 그 부탁을 실행 줄에 잇는다. 감독의 도구 처리기(`src/supervisor/scheduler/tools.ts`)의 장부 포트 넷을 아래 함수 넷이 채운다.

| 공개 함수 | 동작 | 처리기 포트 |
|---|---|---|
| `findToolRequest({ owner, dedupeKey })` | `Read<ToolRequest \| null>`. 그 소유자의 그 재시도 키의 줄 | `findByRetryKey` |
| `readToolRequest({ owner, ref })` | `Read<ToolRequest \| null>`. 그 소유자의 그 참조의 줄 | `readOwnedWork` |
| `recordToolRequest(input)` | 쓰기 모드 `start`. `{ ok: true, outcome, request }`(`outcome`은 `created`·`existing`·`conflict`) 또는 거절 | `recordStart` |
| `cancelToolRequest({ owner, ref, sessionId, callId, now })` | 쓰기 모드 `continue`. 대기 부탁은 `not_started`로, 이은 부탁은 그 실행의 취소로 적고 `{ ok: true, phase }`(지시를 적었으면 `instruction`도) 또는 거절 | `requestCancel` |
| `assignToolRequest(input)` | 쓰기 모드 `start`. 대기 부탁을 새 실행 줄에 잇고 `{ ok: true, outcome, run }`(`outcome`은 `assigned`·`already_assigned`) 또는 거절 | 없음(배정기가 부른다) |

`ToolRequest`는 `ref`, `owner`, `dedupeKey`, `role`, `purpose`, `sourceRef`, `inputDigest`, `phase`다. `phase`는 이어지지 않은 부탁이면 줄의 단계, 이은 부탁이면 이은 실행 줄의 지금 상태를 옮긴 단계다(아래 "이은 뒤의 단계"). 포트의 `WorkRecord`와는 이름만 다르다(`retryKey` ↔ `dedupeKey`, `content`의 네 칸 ↔ 펼친 네 칸). 장부의 입력 칸 이름은 `test/ledger/static.test.ts`가 막는 조각(`key`로 끝나는 이름은 `dedupe_key`뿐, `content`)을 쓰지 않는다. 그래서 포트를 채우는 어댑터는 이름을 옮기고, 새 참조의 후보를 넘기고, 거절을 포트의 꼴로 옮긴다: `stopped` → `stopped`, `intake_closed`·`snapshot_hold` → `intake_closed`, `transition_denied` → `already_ended`, 그 밖은 모름(`known: false`). 그 어댑터는 `test/ledger/tool-requests.test.ts`에 있다.

- **소유:** 소유자(`owner`)는 부탁을 낸 논리 요청이고 접수한 입력이어야 한다(`inputs`의 외래 키, 아니면 `invariant_violation`이고 줄이 생기지 않는다). 두 조회와 취소는 소유자가 같은 줄만 본다. 다른 소유자의 같은 키·같은 참조는 이어졌든 아니든 없는 줄과 같은 답이다: 조회는 `{ known: true, value: null }`, 취소는 `unknown_run`. 읽기 실패의 꼴(`known: false`)도 소유와 무관하다. 이 조회·취소의 격리는 아래 "참조"의 후보 조건과 무관하게 성립한다.
- **유일성:** (소유자, 재시도 키)마다 한 줄이다. 유일 인덱스가 지키고, 같은 참조나 같은 (소유자, 키)의 INSERT는 트리거가 막는다(`INSERT OR REPLACE`가 옛 줄을 지우고 새 참조를 들이는 길이 없다). 기록은 같은 트랜잭션에서 그 소유자의 같은 키를 먼저 찾는다. 있으면 새 줄 없이 그 줄을 돌려준다: 내용(역할·목적 분류·원본 참조·입력 digest)이 같으면 `existing`, 다르면 `conflict`. 처리기가 조회한 뒤 기록하기 전에 같은 키가 생겨도 같다. 다른 소유자가 같은 키를 쓰면, 새 참조 후보가 표 전체에서 비어 있는 한 각자 자기 줄을 만들고 서로의 줄에 닿지 않는다(아래 "참조"). 처리기는 돌려받은 줄의 소유자와 내용을 다시 대조한다.
- **참조:** 불투명 UUID이고 배정 뒤에도 같다. 참조는 소유자와 무관하게 표 전체에서 유일하다(기본 키와 INSERT 트리거). 장부는 난수를 부르지 않으므로 부르는 쪽(포트 어댑터, 뒤의 조립 코드)이 후보(`ref`)를 넘기고, 장부는 새 줄을 만들 때만 그 후보를 쓴다. 후보가 이미 쓰인 참조이면(자기 것이든 다른 소유자의 것이든) `invariant_violation`이고 줄이 생기지 않으며, 처리기는 `unknown`으로 답한다. 이 답에는 그 참조를 가진 부탁의 소유자·내용·단계가 실리지 않는다. 그래서 두 보장, 다른 소유자의 같은 재시도 키도 각자 접수된다는 것과 다른 소유자의 부탁이 있든 없든 기록의 응답이 같다는 것은 **새 후보가 표 전체에서 비어 있을 때** 성립한다. 후보는 부르는 쪽이 암호학적 난수 UUID로 만들어야 하고, 예측할 수 있는 값이나 순번을 쓰지 않는다. 본체(모델)의 `start_worker` 인자에는 참조를 지정하는 칸이 없다.
- **정지:** 기록은 새 업무다. 처리기가 들어올 때 본 정지와 별개로 "새 업무를 열어도 되는 조건"을 기록 트랜잭션 안에서 다시 본다. 정지(`stopped`), 정지 기록 없음(`stop_unknown`), 접수 허가 없음(`intake_closed`), 사본 보류(`snapshot_hold`), 쓸 수 없음(`ledger_unwritable`)이면 거절이고 줄이 생기지 않는다. 같은 키의 기존 줄을 돌려주는 것도 이 전제를 지난 뒤다. 취소 접수는 닫는 기록이라 정지 중에도, 접수가 닫혀도 적는다(처리기는 정지 중 호출을 문맥에서 먼저 거절한다).
- **단계:** 부탁 줄에 적는 단계는 배정 전의 둘이고(`TOOL_REQUEST_PHASES`), 처리기의 단계 이름(`PHASES`) 안에 있다. `waiting_assignment`는 대기, `not_started`는 배정 전에 취소돼 시작하지 않은 부탁이다. 대기 부탁의 취소는 한 번만 된다(다시 취소하면 `transition_denied`). 재시도 키는 논리 요청과 목적 분류로만 만들어지므로, 취소한 뒤 같은 부탁을 다시 내면 새 줄이 아니라 그 줄이 `not_started`로 나온다.
- **배정 전 대기는 실행 줄이 아니다:** 기록과 대기 부탁의 취소는 `runs`·`slot_holds`·`instructions`에 아무것도 적지 않는다. 부탁은 슬롯을 쥐지 않고 실행기·자격·기한·예산을 갖지 않는다. 닫았다 다시 연 뒤에도 같은 참조와 단계로 읽힌다.

### 배정(`assignToolRequest`)

`tool_requests.run_id`가 부탁을 실행 줄에 잇는 자리다(실행 하나에 부탁 하나, 대기 부탁만, 한 번만 채운다: CHECK와 트리거). 이 칸을 채우는 연산은 `assignToolRequest` 하나다.

- **입력:** `{ ref, runId, snapshotDigest, profileRevision, policyRevision, executorId, credential, deadlineAt, budgetLeft, now }`. 실행기·자격 참조·기한·예산은 배정기가 고른 실제 값이고 `admitRun`의 같은 칸과 같은 검사(`#admitInput`)를 거친다. 역할·입력 digest·실행의 입력(`inputRequestId` = 소유자)은 부탁의 값이라 받지 않는다(받으면 모르는 칸으로 `LedgerInputError`). 대기 부탁을 새로 이을 때 실행기가 부탁의 역할을 맡을 수 없으면 `admitRun`과 같이 `LedgerInputError`다. 이미 이어진 부탁에는 이 검사보다 `already_assigned`가 먼저라, 역할이 맞지 않는 실행기와 새 실행 ID를 넘겨도 이은 그 실행이 돌아온다. 재시도는 돌려받은 실행의 실행기·실행 ID를 쓴다. 소유자는 받지 않는다: 부르는 쪽은 배정기 하나이고 참조는 표 전체에서 유일하다.
- **한 트랜잭션:** 새 업무의 전제(위 "새 업무를 열어도 되는 조건") → 그 참조의 부탁을 다시 읽음 → 실행 줄 기록(`admitRun`과 같은 `#admit`) → `run_id` 채움이 한 트랜잭션이다. 커밋 전에 끊기면 실행 줄과 잇기가 함께 되돌려진다.
- **답:** 처음 이으면 `{ ok: true, outcome: "assigned", run }`(`run.state`는 `queued`). 이미 이어진 부탁이면 새 실행 줄 없이 `{ ok: true, outcome: "already_assigned", run }`(이은 그 실행의 지금 값, 넘긴 `runId`는 쓰이지 않는다). 취소된 부탁(`not_started`)은 `transition_denied`, 없는 참조는 `unknown_run`이고 실행 줄이 생기지 않는다. 실행 줄의 접수가 장부의 기존 사유로 거절되면(정지, 접수 허가 없음, 사본 보류, 이미 쓰인 실행 ID의 `invariant_violation` 등) 부탁은 `waiting_assignment` 그대로다.
- **실행의 중복 키:** 실행 줄의 `dedupe_key`는 `tool_request:<참조>`다. `runs.dedupe_key`는 소유자와 무관하게 전역 유일이라 부탁의 재시도 키를 그대로 쓰면 다른 소유자의 같은 키와 부딪혀 남의 실행이 돌아온다. 참조는 표 전체에서 유일하므로 이 키는 부탁마다 하나다. 이 키의 실행이 이미 있으면(잇는 연산 밖에서 만든 줄) 그 실행을 잇지 않고 `invariant_violation`이다.

### 이은 뒤의 단계

두 조회는 부탁과 이은 실행 줄을 한 문장(`LEFT JOIN`)으로 읽고, 실행 줄의 지금 상태를 `TOOL_REQUEST_RUN_PHASES`(옮기는 표, `ledger.ts` 한 자리)로 처리기의 단계 이름으로 옮긴다. 처리기의 `PHASES`는 배정 전 대기에 장부의 실행 상태 이름을 그대로 더한 것이라 지금은 같은 이름이다.

| 실행 상태 | 단계 |
|---|---|
| `queued`·`preparing`·`running`·`stopping`·`unknown_running` | 같은 이름 |
| `checking`·`ready_result`·`failed_stopped`·`cleanup_pending` | 같은 이름 |
| `finalized`·`not_started` | 같은 이름 |

- 표는 `Record<LedgerRunState, …>`라 상태가 더해지면 타입 검사가, 상태 목록(`LEDGER_RUN_STATES`)을 읽는 시험(`test/ledger/tool-request-assign.test.ts`)이 실패한다.
- 읽기가 실패하면 `{ known: false }`다(단계를 지어내지 않는다).
- `run_id`가 가리키는 실행 줄이 없거나 그 상태가 장부의 상태가 아니면 `corrupt`로 닫는다(장부가 실패 상태가 된다). 외래 키와 `runs_permanent` 트리거가 막으므로 제약을 지나친 파일에서만 생긴다. 대기로 답하면 본체가 오지 않을 진행을 기다리고, `not_started`로 답하면 실행 중일 수 있는 일을 끝났다고 말하게 된다.
- `recordToolRequest`가 같은 키의 기존 줄을 돌려줄 때도 같은 단계다.

### 이은 부탁의 취소

`cancelToolRequest`는 같은 트랜잭션에서 소유를 다시 보고, 이은 부탁이면 부탁 줄을 바꾸지 않고(줄은 `waiting_assignment`·취소 칸 빔 그대로다: CHECK) 그 실행의 취소를 종료 지시의 기록(`recordStopInstruction`과 같은 `#recordStop`)으로 남긴다.

- 시작 전(`queued`): 지시 없이 `not_started`로 닫는다. 답의 단계는 `not_started`다.
- 시작 뒤(`preparing`·`running`·`unknown_running`은 `stopping`으로, `stopping`은 그대로): `task_cancel` 지시를 적는다. 지시의 요청 ID는 이 취소 호출의 ID(`callId`)이고 정지 세대는 장부의 지금 값이다(처리기는 세대를 모른다. 정지 기록이 없으면 `stop_unknown`). 답은 `{ ok: true, phase: "stopping", instruction: { runId, requestId, stopGeneration } }`이고, 지시를 보내는 것은 부르는 쪽이다.
- **취소의 접수는 종료가 아니다:** 자리를 놓지 않는다. `stopping`은 슬롯을 쥐고, 그 뒤의 전이는 영수증과 기존 연산의 일이다.
- 종료가 확인됐거나(`stop_receipt_id`가 있음: `checking`·`ready_result`·`failed_stopped`·`cleanup_pending`) 끝난(`finalized`·`not_started`) 실행이면 취소가 바꿀 것이 없어 `transition_denied`다(처리기의 `already_ended`).
- 정지 중에도, 접수가 닫혀도 적는다(쓰기 모드 `continue`).
- 같은 호출 ID로 다시 부른 답은 그때의 실행 상태를 따른다(같은 호출 ID의 응답 재생은 없다). 시작 뒤의 취소를 종료가 아직 확인되지 않았을 때 다시 부르면 같은 요청 ID의 지시가 이미 있어 `invariant_violation`이다. 종료 확인 영수증 뒤에 다시 부르면 `transition_denied`(처리기의 `already_ended`)다. `queued`에서 취소한 뒤 다시 부르면 `transition_denied`다.

**넣지 않는 것:** 목적의 자유 글(`brief`), 원문, 실행기 ID, 계정·자격, 모델 이름, 경로. 세션 ID와 호출 ID는 부탁을 기록·취소한 호출의 기록이고 판단(소유·중복·충돌)에 쓰지 않는다. 이은 부탁의 취소는 부탁 줄에 남지 않는다. 시작 뒤 지시를 적었을 때만 실행의 지시(요청 ID = 호출 ID)로 남고, `queued`에서의 취소는 지시가 없어 그 세션 ID·호출 ID가 지시에도 부탁의 취소 칸에도 남지 않는다. 입력이 그 소유자의 고정된 입력인지(`inputPinned`), 지금 호출권을 가진 세션인지(`liveSession`), 결과(`readResult`)는 이 표가 답하지 않는다.

**배정기와 조립 코드가 지킬 것:**

1. 실행기·자격·기한·예산은 실제로 고른 값만 넘긴다. 맞는 실행기가 없으면 부르지 않고 부탁을 대기로 둔다. 대기 부탁의 목록을 읽는 연산은 아직 없다.
2. 배정한 실행의 시작(`startRun`)과 지시의 전송은 배정과 따로다. `assigned`의 실행은 `queued`이고 시작 보장이 아니다.
3. 이은 부탁의 취소가 돌려준 `instruction`을 그 값(요청 ID, 정지 세대) 그대로 실은 `task_cancel`로 보낸다. 장부에는 보내지 않은 지시를 찾는 읽기가 없다. 보내기 전에 끊긴 실행은 장부를 단순히 다시 열면 `stopping`으로 남고 스케줄러(`nextIntent`)는 답을 기다린 뒤 조회를 낸다. 재시작 복원의 3단계(`markLost`)를 거치면 `unknown_running`이 되고 그 실행의 상태 조회(`statusQueries`)가 바로 나온다. 어느 쪽이든 슬롯은 쥔 채다. 장부의 기록만으로는 지시가 전달됐는지 알 수 없으므로, 조립 코드는 장부가 돌려준 식별값을 보존하고 중단 뒤 같은 실행의 전달·종료 여부를 대조해 필요하면 다시 보낼 방법을 정한다.
4. 호출 ID는 호출마다 새 UUID여야 한다. 이은 부탁의 취소에서 지시의 요청 ID로 쓰인다.

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
| `snapshot_unsupported` | 호출자가 넘긴 판 목록이 사본을 지원하지 않는다: 사본 기록의 표가 없거나, 사본 기록이 최신 미대조 기록으로 들어가지 않거나, 판이 사본 표식의 칸(`user_version`)을 쓴다 |
| `ledger_unwritable` | 장부가 닫혔거나 실패했거나, 시계를 읽지 못했거나 그 값을 믿을 수 없다 |
| `io` | 사본 파일을 쓰지 못했다. 장부는 계속 쓸 수 있고 임시 파일은 지운다 |

**쓰기가 막히는 정도.** 동기 호출이라 끝날 때까지 이 프로세스의 쓰기와 읽기가 모두 기다린다. **막히는 시간의 상한은 없다.** 시간은 장부 크기와 디스크에 달려 있고(`fsync`가 늦으면 작은 장부도 그만큼 막힌다) 제한 시간이나 취소가 없다. `maxBytes`가 보장하는 것은 하나다: 장부(그림을 뜨기 전에 검사)나 사본 기록을 넣은 결과(그 뒤에 검사)가 이 크기를 넘으면 사본을 내지 않는다(`too_large`). 실제로 막힌 시간은 성공한 결과의 `blockedMs`로 돌려준다. 메모리는 그림, 메모리 DB, 최종 바이트가 잠시 함께 있어 장부 크기의 최대 세 벌과 런타임의 몫이 더 든다. `maxBytes`는 프로세스 메모리의 상한도 아니다.

**끊겼을 때.** 최종 이름은 fsync 뒤에만 생긴다. 끊기면 `<path>.partial-<UUID>`만 남는다. 쓰다 끊긴 파일은 `corrupt`로 열리지 않고, 끝까지 쓴 임시 파일은 사본 기록이 있어 보류로 뜬다. `link`와 `unlink` 사이에서 끊기면 이름이 둘이라 받지 않는다.

## 사본에서 뜬 장부의 보류

백업에서 복원한 장부는 옛 시점이라 계정 잠금과 영수증이 옛것일 수 있다(D-56). 사본 기록이 있고 대조가 끝나지 않은 파일은 열리지만 새 업무를 열지 않는다.

| 쪽 | 쓰기 | 보류 중 |
|---|---|---|
| 여는 쪽(쓰기 모드 `start`) | `enqueueInput`, `recordToolRequest`, `assignToolRequest`, `admitRun`, `startRun`, `startSession`, `recordPublication`, `recordRenewInstruction` | `snapshot_hold`로 거절 |
| 닫는 쪽(`continue`) | `applyStop`, `mergeStop`, `setPause`, `cancelInput`, `cancelToolRequest`, `recordStopInstruction`, `recordFinalizeInstruction`, `markResult`, `markCleanupPending`, `recordBudget`, `markLost`, `holdSlots`, `clearSlotHold`, `applyReceipt`, `recordReport`, `settleReport`, `setProcessedSeq`, `planRotation`, `settlePublication`, nonce 소비 | 막지 않는다 |
| 근거·풀기(`new`) | `applyRuleCheck`, `releaseStop`, `confirmSnapshotReconciled` | 막지 않는다. `releaseStop`은 보류를 풀지 않는다 |

- **읽기:** `snapshotOrigin()`은 원본이면 `null`, 사본에서 떴으면 `snapshotId`, `ledgerId`, `takenAt`, `reconciledAt`, `held`, `mayBeStale`(`account_locks`, `receipts`)을 낸다. 복원 5단계도 같은 값을 `snapshotOrigin`으로 내고, 보류면 `intakeMayOpen: false`, `closedBecause`에 `snapshot_hold`다.
- **풀리지 않는 것:** 재시작, 새 복원 시도, `releaseStop`, 접수 허가를 다시 내려는 시도.
- **푸는 길:** `confirmSnapshotReconciled({ snapshotId, now })` 하나다. 사본의 식별이 맞아야 하고(`reference_mismatch`) 시각과 식별만 남긴다. 누가 불렀는지는 받지 않는다. 성공하면 접수는 닫힌 채이고 진행 중이던 복원 시도도 끝난다: 그 시도의 늦은 응답과 다음 단계는 `RestoreStepError`로 실패하고, 새 `Restorer`가 1단계부터 끝까지 마쳐야 열린다. 대조가 실패했거나 다른 사본 식별로 불렸으면 진행 중이던 시도는 그대로다.
- **사본 기록을 지키는 것:** 트리거가 삭제, 교체, 대조 끝 밖의 변경, 대조가 끝나지 않은 줄이 있을 때의 추가를 막는다. 트리거나 표를 지운 파일은 재개방의 스키마 대조가 거절한다. 파일에 직접 SQL을 실행할 수 있는 주체는 이 장치로 막지 못한다. 그런 주체는 장부 폴더를 감독만 쓴다는 전제 밖이다.
- **표식과 기록은 함께 맞아야 한다:** `createSnapshot`은 요청한 사본 식별·장부·시각의 최신 미대조 기록이 정확히 하나 들어간 파일만 낸다. 처음 여는 사본의 표식(`user_version`)이 있는 파일은 같은 조건을 통과해야 표식을 소비하고, 아니면 `corrupt`다. 두 검사가 미대조를 가르는 칸은 같지 않아, 사용자 정의 사본 표에서는 낸 사본이 첫 열기에서 `corrupt`일 수 있다("알려진 결함"의 "사본을 내는 검사와 첫 열기 검사의 차이").
- **보류가 보호하지 못하는 경우:** 표식은 첫 열기에서 소비되므로, 이미 한 번 연 사본에서 사본 기록의 줄이 모두 사라지면 원본 장부와 가를 수 없어 보류가 걸리지 않는다.

| 파일 | 결과 |
|---|---|
| 끊긴 사본 | `corrupt` |
| 사본 기록의 값이 깨진 파일, 다른 `ledger_id`를 주장하는 파일 | `corrupt` |
| 처음 여는 사본의 표식이 있는데 최신 미대조 기록이 정확히 하나가 아닌 파일(빈 기록, 대조 끝난 기록만, 미대조가 최신이 아님) | `corrupt` |
| 사본 기록의 표나 트리거가 없는 파일 | `not_initialized` |
| 한 번도 열지 않은 사본 곁에 `-wal`·`-shm`이 있는 파일 | `not_initialized`. 다른 시점의 WAL이 재생되면 사본 기록까지 덮을 수 있다 |
| 한 번도 열지 않은 사본 곁에 `-journal`만 있는 파일 | `interrupted_install`. 이 사본의 첫 열기가 끊겼을 수 있지만 다른 시점의 저널과 가를 수 없어 받지 않는다. 사람이 할 일은 아래 "원격에서 되가져와 장부 자리에 놓을 때"의 7번 |

## 재시작 복원(`Restorer`)

`new Restorer(ledger, ports, clock, { requiredPeers })`. 열린 장부(잠금을 잡은 상태)와 포트 넷, 응답을 반드시 받아야 하는 이웃 이름의 목록을 받는다. 목록에서 계약의 실행기 주체 이름인 항목은 필수 실행기다. 단계는 순서대로만 부르고, 앞 단계가 끝나지 않았거나 겹쳐 부르면 `RestoreOrderError`다. 단계가 실패하면 `RestoreStepError`이고 같은 단계를 다시 부를 수 있다. 더 새로운 복원 시도가 시작됐거나 사본 대조가 끝난 복원기의 단계는 실패한다. 단계 결과는 복사본이라 호출자가 바꿔도 뒤 단계의 판단이 바뀌지 않는다. 지시는 보내지 않고 목록을 돌려준다.

| 단계 | 하는 일 | 돌려주는 것 |
|---|---|---|
| 1 | 복원 시도를 새로 연다(앞 허가가 끝난다). 권위 기록(`StopAuthorityPort`)을 받아 정수·불리언 꼴을 확인하고, 장부를 다시 읽어 한 트랜잭션에서 합친다(`mergeStop`, 같은 세대는 정지가 이김). 첫 설치 장부에서 둘 다 없으면 0을 적는다. 둘 중 하나라도 모르면 실패 | 정지 세대, 정지 여부, 출처. 끝나기 전 `stopGeneration()`은 `null`, 끝난 뒤에는 지금의 장부 값(장부가 실패했으면 `null`) |
| 2 | 필수 이웃이 정확히 한 번씩 답했는지와 이웃마다 그 이웃의 계약 판·정책(`PeersPort`, 아래 "이웃의 판과 정책")을 보고, 실행기의 점유(`OccupancyPort`)를 실행 ID·세대·지정 실행기·양쪽 상태(끝난 상태 포함)로 장부와 대조. 대기 줄과 장부 밖 실행의 관측은 끝났다는 답이어도 `slot_holds`에 남기고, 이미 시작한 줄은 활동 중이라는 답만 남긴다(끝났다는 답이나 끝난 상태끼리 이름만 다른 답은 불일치 목록에만 나온다. 그 줄이 슬롯을 계속 쥐거나 이미 끝나 있어 다시 시작될 수 없다). 슬롯 종류를 모르는 실행기가 답한 장부 밖 실행은 적을 수 없어 접수를 보류한다 | 종료 대상(장부 밖 실행, 장부에서는 끝났는데 실행기가 쥔 실행), 점유 불일치, 남긴 관측, 슬롯 종류를 모르는 실행기, 전체 점유를 확인하지 못한 필수 실행기, 다시 물을 실행, 판이 다른 이웃, 정책이 맞다고 확인되지 않은 이웃, 빠진·겹친 이웃 |
| 3 | 종료 확인이 없는 진행 중 실행을 `unknown_running`에 둔다. 새 실행을 만들지 않는다 | 실행기별 상태 조회(같은 실행 ID, 8개씩, 종료 확인이 있는 실행은 2단계에서 어긋난 것만), 옮긴 실행, 결과 검사를 이을 실행(`checking`), 반영하지 않은 보고(훅·세션 깨짐은 `signal` 포함), 자리를 쥔 실행 |
| 4 | 확정되지 않은 게시를 현관(`PublicationPort`)에 작업 ID로 묻는다. 던지면(시간 초과 포함) `unknown` | 확정·대기·모름의 작업 ID |
| 5 | 일시 중지·대기열·예산·입력을 읽고 접수를 열어도 되는지 낸다. 판정, 장부의 허가, 완료 표시, 반환값을 한 동기 구간에서 정한다 | 사본 보류가 아니고, 정지가 아니고, 1단계 뒤 정지가 바뀌지 않았고, 이웃마다 판이 맞고, 정책이 맞다고 확인되지 않은 이웃이 없고, 필수 이웃이 모두 한 번씩 답했고, 필수 실행기의 전체 점유를 확인했고, 슬롯 종류를 모르는 점유가 없고, 장부를 쓸 수 있을 때만 `intakeMayOpen: true`. 시작 후보(`queued`: 이 실행 자체를 막는 사유가 없는 대기 실행), 옛 세대·입력 취소·만료·점유 관측으로 빠진 대기 실행, 처리 위치 뒤의 입력(대기·취소·만료). 대기 실행과 입력의 만료는 장부 시계의 같은 시각 하나로 판정한다 |

**`queued`는 시작 보장이 아니다.** 접수가 닫힌 복원에서도 목록은 나온다. 실제 시작은 시작 트랜잭션이 접수 허가, 슬롯(`slot_busy`), 예산·입력 digest(`not_startable`)를 다시 보고 거절할 수 있다. 세션 실행은 후보로 나와도 `startSession`이 닫혀 있어 시작하지 않는다.

**점유 응답의 세 모양.** `OccupancyPort`의 행은 `coverage`로 가른다. `full`은 그 실행기가 쥔 실행 전부를 이번 복원에서 답한 것이고(빈 `runs`는 "쥔 것 없음"), `partial`은 특정 실행만 물은 답이다. 행이 없으면 모름이다. 필수 실행기는 `full`이 정확히 하나 있어야 확인된 것으로 세고, 아니면 `occupancy_unconfirmed`로 접수를 닫는다.

**이웃의 판과 정책.** `PeersPort`의 행은 `{ peer, contract, policy? }`(`PeerContractAnswer`)다. 기대하는 판은 복원기가 이웃의 이름으로 고른다(D-65): 계약의 현관 주체 이름(`front-door`)은 v2의 `CONTRACT`(`olive-control/v2`), 그 밖(실행기, 관측 중계, 계약의 주체 이름이 아닌 이웃)은 v1의 `CONTRACT`(`olive-control/v1`)다. 행이 밝힌 판으로 기대를 고르지 않으므로 현관이 v1이라고 답하거나 실행기가 v2라고 답하면 `contract_mismatch`다.

- **정책:** `policy`는 그 이웃과의 인사에서 확인한 정책 revision의 대조 결과(`match`·`mismatch`·`unknown`)다. 현관의 행은 `match`여야 하고, 칸이 없거나 아는 값이 아니면 모름이다. 다른 이웃의 행은 칸을 실었을 때만 보고 `match`가 아니면 닫는다. 실행기 v1의 정책 revision은 이 행이 아니라 hello에서 배정이 대조한다(`src/supervisor/roles/assign.ts`). 정책이 맞다고 확인되지 않은 이웃이 하나라도 있으면 `policy_mismatch`로 접수를 닫는다(D-72).
- **기대 집합:** 어느 이웃이 필수인지는 `requiredPeers`가 정한다. 현관이 목록에 있을 때만 현관의 누락·중복이 `peer_unconfirmed`로 접수를 닫는다. 목록 밖 이웃의 행은 누락·중복으로 세지 않지만 판과 정책은 대조한다.
- **v2는 후보다:** 이 대조를 통과했다는 것은 현관의 행이 기대한 식별자와 맞은 정책을 실었다는 뜻일 뿐, v2로 실제 연결을 켜도 된다는 뜻이 아니다. 후보인 동안에는 이 계약으로 실제 연결을 켜지 않는다(README "계약 `olive-control/v2`").
- **포트를 채우는 쪽:** 인사에서 확인한 판과 정책만 싣는다. 확인하지 못한 정책은 `unknown`으로 싣고, 상대의 판을 다른 판의 이름으로 바꿔 싣지 않는다.

**접수를 닫지 않는 예외(합의한 정책).** 아래는 "앞 단계가 모두 맞을 때만"의 예외로, 접수는 열고 그 자리만 막는다.

- 장부 안의 `unknown_running`·`cleanup_pending`: 그 실행이 슬롯을 쥐고 있어 같은 종류의 새 실행은 `slot_busy`다.
- 장부 밖·불일치 점유: 실행 줄로 올리지 않고 `slot_holds`로 그 실행 ID와(활동 중이면) 그 종류의 슬롯만 막는다. 슬롯 종류를 알 수 없으면(실행기 주체 이름이 아님) 이 예외에 들지 않고 접수를 보류한다.
- 게시 조회의 모름: 그 작업 ID를 `unknown`으로 남겨 다시 내지 않는다.

## 알려진 결함

아래는 이 장부가 **아직 보장하지 않는 것**이다. 항목마다 지금 일어나는 일과 닫는 조건(코드로 닫을지, 부르는 쪽·운영 절차가 지킬지, 누가 언제까지)을 적는다.

- **끊긴 체크포인트 뒤의 재기동:** 체크포인트가 파일을 늘리다 끊겨 머리의 페이지 수가 본체보다 앞선 본체(1번 페이지만 새것, 끝난 체크포인트의 앞부분만 있는 것)와 온전한 WAL의 쌍은 `reopen`이 WAL까지 읽은 값으로 연다. 같은 모양의 받다 끊긴 미개봉 사본과 이 설치가 만들지 않은 본체는 곁의 WAL과 관계없이 본체 머리의 표식으로 거절하고 파일을 바꾸지 않는다. 읽기쓰기 연결의 chunk size가 프로세스 죽음으로 이 모양이 생기는 것을 막는다(위 "판정", "잠금", "chunk size"). 남는 것은 셋이다.
  - **운영 컨테이너의 `/proc/locks`:** 머리를 읽기 전의 잠금 확인은 호스트의 tmpfs에서만 확인했다. 운영 컨테이너(pid 네임스페이스)와 운영 볼륨에서 `/proc/locks`가 이 프로세스의 잠금을 `process.pid`와 같은 pid, `stat`과 같은 inode로 보여 주는지는 확인하지 못했다. 다르게 보이면 같은 프로세스가 쥔 장부를 머리가 앞선 모양으로 다시 열 때 머리 FD를 열어 쥔 쪽의 잠금이 풀린다.
    - 닫는 조건(배포하는 쪽, **감독을 처음 배포하기 전**): 운영 이미지와 볼륨에서 장부를 쥔 감독 프로세스의 `/proc/locks` 줄이 그 프로세스의 pid와 장부 파일의 inode로 보이는지 확인한다.
  - **실제 전원 차단:** chunk size의 효과는 프로세스를 죽여서만 확인했다. 전원이 나가면 파일 길이(메타데이터)와 1번 페이지 덮어쓰기(데이터)가 디스크에 남는 순서는 파일시스템에 달려 같은 모양이 남을 수 있다. 그 모양은 위 판정이 연다.
  - **잘린 다른 본체 + 이 장부의 WAL:** 사본 표식이 없는 이 설치의 본체를 페이지 단위로 잘라 그 본체의 것이 아닌 WAL 곁에 두면 섞인 채 열린다. 위 판정은 WAL이 그 본체의 것인지 보지 않고, 본체 페이지와 WAL 페이지를 합친 것이 `quick_check`와 재개방 검증을 지나면 연다. 사본에서 뜬 장부가 아니므로 보류도 걸리지 않는다.
    - **다른 장부의 본체:** 장부 ID는 본체 쪽, 정지 세대와 기록은 WAL 쪽에서 온다. 같은 순서로 만든 장부 A·B에서 B의 최종 본체를 4,096바이트 자르고 A의 옛 WAL 곁에 두면 장부 ID B, 정지 세대 1·nonce 170(A의 WAL 값)으로 열렸다. WAL이 모든 페이지를 담으면 장부 ID도 WAL 쪽이다.
    - **같은 장부의 다른 시점 본체:** 정지 세대가 옛 값으로 되돌아갈 수 있다. A의 최종 본체(정지 세대 2)를 4,096바이트 자르고 그보다 옛 A의 WAL 곁에 두면 정지 세대 1로 열렸다.
    - **본체 머리로 가를 수 없다:** 같은 순서로 만든 두 장부의 머리 100바이트가 바이트 단위로 같았다. SQLite 파일 머리와 WAL 머리에는 데이터베이스를 가르는 칸이 없다. 그래서 이 쌍을 막는 것은 반입 절차뿐이다(아래 "반입의 조건", "원격에서 되가져와 장부 자리에 놓을 때"의 2~4번).
    - **생기는 길:** 정상 운용에서 이 순서가 생기는 길은 찾지 못했다(일어나지 않는다고 확인한 것은 아니다). 장부 경로의 본체를 다른 파일로 바꾸는 코드는 없고, 알려진 길은 사람의 반입·복구·백업 되살리기다.
    - **거절과 섞임의 경계:** 곁의 WAL과 관계없이 거절하는 것은 이 설치가 만들지 않은 본체(`application_id`가 이 설치의 값이 아님)와 곁 파일이 있는 처음 여는 사본(사본 표식)뿐이다. 다른 장부의 보통 본체(사본 표식 없음)는 온전하면 본체만 읽는 판정이 식별을 읽어, 페이지 단위로 잘렸으면 위 판정의 머리 읽기 예외를 거쳐 이 장부의 WAL과 섞인 채 열린다.
- **사본을 내는 검사와 첫 열기 검사의 차이:** `createSnapshot`은 사본 기록의 `reconciled_at`만 비어 있으면 미대조로 보고, 첫 열기는 `reconciled_snapshot_id`도 비어 있어야 미대조로 본다. 그래서 그 칸에 빈 문자열 기본값을 둔 사용자 정의 사본 표에서는 생성이 성공하고 SHA도 맞는데 그 파일의 `reopen`은 `corrupt`다. 기본 `0001`은 CHECK로 이 조합을 막으므로 사용자 정의 사본 표에 한정된다.
  - 닫는 조건(판을 더하는 쪽과 사본을 보내는 쪽): 감독에는 기본 사본 표·트리거와 그 행을 보존하는 판만 배포하고, 보내는 쪽은 해시가 같은 별도 복제본을 같은 판으로 열어 장부 ID·사본 ID·시각·보류를 확인한 뒤 보관 성공을 기록한다. 모든 사용자 정의 사본 표를 지원해야 한다면 반입 검증은 실패를 발견할 뿐이므로 장부의 코드로 닫는다.
- **한 번 연 사본의 대조 대상:** 첫 열기 표식을 이미 소비한 사본에서 앞 순번이 미대조 행이고 최신 순번이 대조가 끝난 행이면, 검증을 지나 `snapshotOrigin()`이 최신 행의 ID와 대조 시각에 `held: true`를 붙여 낸다. 관리자가 그 ID로 대조하면 `reference_mismatch`이고 보류는 남으며, 공개 읽기는 대조해야 할 행의 ID를 알려 주지 않는다. 기본판의 정상 쓰기가 이 순서를 만드는 경로는 찾지 못했다(일어나지 않는다고 확인한 것은 아니다).
  - 닫는 조건(감독 진입점과 관리 명령): 대조 전의 모든 기동에서 반입 영수증의 ID, 읽은 ID, `held=true`, `reconciledAt=null`을 함께 요구하고, 모순이면 격리한다. 코드로 닫으려면 미대조 행이 남아 있을 때 첫 열기 여부와 무관하게 그 행이 최신인지 본다.
- **스키마 거절과 짧은 WAL:** 커밋을 담을 수 없는 크기(4,096바이트 페이지에서 4,152바이트 미만)의 WAL이 곁에 있는 장부를 같은 판 이름·다른 스키마의 목록으로 `reopen`하면, 읽기쓰기 연결에서 판정해 `not_initialized`로 닫으면서 본체 바이트는 그대로지만 **기존 WAL 이름이 사라진다.** 0·32·4,151바이트에서 확인했고, 커밋 소실은 관찰하지 않았다.
  - 닫는 조건(사본을 되가져오는 쪽과 장애 진단 절차): 반입·장애 진단은 정지한 원본과 모든 곁 파일을 먼저 보존하고, 쓰기 가능한 작업 사본에만 판정을 한다. 일반 재기동의 거절 자체가 곁 파일의 이름을 보존해야 한다면 장부의 코드로 닫는다(짧은 WAL의 스키마 불일치도 쓰기 연결 전에 거절).
- **겹친 판정의 `-shm` 정리:** 읽기 전용 판정은 시작할 때 `-shm`이 없었다는 것만 기억하고 끝날 때 그 이름을 지운다. 두 기동 시도의 판정이 겹치면, 먼저 끝난 쪽이 다른 판정자가 쓰고 있는 `-shm` 이름을 지울 수 있다(감독 전용 폴더에서도 성립하는 순서). 실제 동시 쓰기, 장부 손상, 주 장부 잠금 해제로 이어지는지는 확인하지 못했다.
  - 닫는 조건(감독 진입점): 같은 경로의 기동·재개방·진단을 프로세스 사이에서도 직렬화하고, 검사 연결이 모두 닫힐 때까지 다른 판정자를 들이지 않는다. 스케줄러 한 프로세스의 뮤텍스만으로는 부족하다. 코드로 닫으려면 `-shm` 정리를 SQLite에 맡긴다.
- **사본 표식과 같은 `user_version`:** 판이 `user_version`을 사본 표식 값(`0x4f4c5653`)으로 남기면, 원본의 판 올리기는 성공하고 사본 생성은 `snapshot_unsupported`지만, 정상 종료한 **원본**을 같은 목록으로 다시 열면 표식에 맞는 사본 기록이 없어 `corrupt`다. 기본 `0001`은 `user_version`을 쓰지 않으므로 사용자 판에 한정된다(다른 값, 예를 들어 17은 사본만 거절하고 원본은 다시 열린다).
  - 닫는 조건(판을 더하는 쪽): 사본을 쓰는 배포는 모든 판의 각 커밋 경계에서 `user_version=0`을 유지한 목록만 감독에 넘긴다. 사본이 필요 없는 사용자 판까지 운영한다면 최소한 이 표식 값을 금지한다. 코드로 닫으려면 판을 적용하기 전에 이 값을 남기는 목록을 거절한다.
- **첫 열기 저널의 오류 상세:** 처음 여는 사본 곁에 저널만 있어 `interrupted_install`로 닫을 때, 오류 상세는 같은 첫 열기에서 나온 저널에도 "다른 시점의 파일이 있다"고 단정한다(사유와 보존 동작은 맞다). 이 사유는 본체에 사본 표식이 아직 보일 때만 나오고, 표식 소비가 본체에 먼저 반영된 뒤 끊기면 SQLite의 저널 복구와 행 검증으로 가며 그 구간의 실제 전원 차단 결과는 확인하지 못했다.
  - 닫는 조건(코드, 기한 미정): 상세를 "첫 열기 중단인지 다른 저널인지 가를 수 없어 두 파일을 함께 격리한다"로 바꾼다.
- **반입의 조건:** 지금 코드는 처음 여는 사본 곁의 WAL, 잘린 사본, 이 설치가 만들지 않은 본체를 거절하지만, 사본 표식이 없는 이 설치의 본체를 그 본체의 것이 아닌 WAL과 섞어 여는 입력이 있다. 온전한 다른 장부 본체, 그리고 페이지 단위로 잘린 다른 장부나 같은 장부의 다른 시점 본체다(위 첫 항목의 "잘린 다른 본체 + 이 장부의 WAL"). 본체 머리로는 이 쌍을 가를 수 없어 섞인 장부를 막는 것은 반입 절차뿐이다.
  - 닫는 조건(사본을 되가져오는 쪽): 장부 경로에는 해시를 맞춘 미개봉 단일 파일만 두고, 두기 전에 같은 경로의 `-wal`·`-shm`·`-journal`을 치운다. 절차는 아래 "원격에서 되가져와 장부 자리에 놓을 때"의 2~4번이다.

## 뒤 작업이 알아야 할 것

**이 PR이 남긴 네 가지.** 장부는 아래가 채워져야 실제로 보호가 성립한다.

1. **실제 연결이 `from`을 서명 검증 결과에서 뽑는다.** 장부의 `from`은 평범한 값이라 그 출처를 스스로 증명하지 못한다. `applyReceipt`·`recordReport`·`applyRuleCheck`에는 봉투 검증을 통과한 낸 쪽 주체와 머리의 `run_generation`만 넘긴다. 실행기별 전체 점유(`coverage: "full"`)의 출처와 신선도, 종료 증명의 수집도 이 작업이 정한다.
2. **기동이 `reopen`을 고르고 필수 이웃을 설정한다.** 운영의 보통 기동은 `mode: "reopen"`이다. `not_initialized`면 장부를 잃은 것이고 첫 설치로 넘어가지 않는다. `requiredPeers`에 현관·관측 중계·실행기를 실제로 넣어야 빠진 응답이 접수를 닫는다.
3. **R2 전송과 현관.** 사본을 R2로 보내는 일(자격, 일정, 보존 기간, 되가져오는 절차)과 현관 계약의 감독 쪽은 아직 없다. 보내는 쪽이 지킬 조건은 아래 "R2로 보내는 쪽이 지킬 것"에 있다.
4. **세션 계약.** `startSession`을 열고 교체를 확정·소비하는 일은 이 작업의 몫이다. 조건은 "세션 증거" 절에 있다.

- **실제 연결:** 세션 인수 영수증의 낸 쪽은 앞 세션의 지정 실행기이거나 대기 중인 세션 실행의 지정 실행기여야 한다. 규칙 확인은 `applyRuleCheck(input, { sender })`로 낸 쪽을 함께 넘긴다. 훅·세션 깨짐 보고는 `recordReport`의 `signal`에 v1 본문의 구조화 칸을 옮겨 넣는다. `clearSlotHold`는 그 실행기가 그 세대의 그 실행을 더는 쥐지 않는다고 재대조했거나 종료를 증명했을 때, `slotHolds()`나 2단계가 돌려준 세대와 관측 번호를 함께 넘겨 부른다. 슬롯만 돌아오고 그 실행 ID는 다시 시작할 수 없다. 무엇을 증명으로 볼지(`not_known`은 종료의 증거가 아니다)는 그 작업이 정한다. 맞춤 답의 세대는 `Restorer.stopGeneration()`이고 `null`이면 맞춤에 답하지 않는다.
- **스케줄러:** 새 업무는 `Restorer.intakeOpen()`이 true일 때만 시도하고, 장부의 거절(`snapshot_hold`, `intake_closed`, `stopped`, `slot_busy`, `run_blocked`, `input_cancelled`, `input_expired`, `deadline_passed`, `run_generation_stale`, `not_startable`, `session_start_closed`)을 그대로 따른다. 복원 5단계의 `queued`는 시작 후보이고 시작의 보장이 아니다. `run_blocked`인 일을 다시 하려면 새 실행 ID로 접수한다. 허가가 버려졌으면(`intake_closed`) 새 `Restorer`로 1단계부터 다시 복원한다. 재시작 뒤 결과 검사는 3단계의 `resumeChecks`·`pendingReports`에서 다시 꺼낸다. 새 세션은 5단계의 `inputs.pending`을 순서대로 한 번씩 전한다. 갱신 지시는 `recordRenewInstruction`이 돌려준 `leaseUntil`을 본문 `lease_until`에, 넘긴 `now`를 머리 `issued_at`에 싣는다. 그 `now`는 장부 시계와 같은 시계에서 읽는다: 시작 지시의 발행 시각은 장부 시계이고, 그보다 늦지 않은 갱신은 끝을 적지 않아 발급 기록의 끝이 모름이 된다. 기록·송신·실행기의 적용은 서로 다른 시점이고, 장부는 기록한 `now`로 여유를 재어 끝을 믿는다("스케줄러가 쓰는 읽기"의 "갱신 뒤의 임대"). 그래서 갱신은 아래를 지킨다.
  - **기록 직전에 여유를 다시 잰다.** 기록에 쓸 `now`로 `now + RENEW_MARGIN_MS <= lease.expiresAt`을 확인한다(같은 `now`로 `nextIntent`를 다시 불러도 된다). 판단 뒤 시각을 다시 읽어 그 시각으로 기록하면 같은 배정기도 늦은 갱신을 적는다(장부는 그 끝을 믿지 않고 판단은 조회로 간다). `now`는 판단과 같은 시계의 지금 값이고 앞 지시의 시각을 다시 쓰지 않는다. 기록 전에 연결이 살아 있는지(`mayIssue`)를 본다.
  - **봉투는 기본 수명 전체로 봉하고, 싣는 순간 남은 시간을 잰다.** 갱신 봉투는 발행 시각(`issued_at` = 기록한 `now`)부터 `MESSAGE_TTL_MAX_MS`(30000ms) 전체로 봉한다. 실제로 연결에 싣는 순간 `min(앞 임대의 끝, expires_at) − 싣는 시각 >= RENEW_MARGIN_MS`일 때만 싣는다. 앞 임대의 끝은 그 갱신을 기록하기 전의 `lease.expiresAt`이다. `maySend`(남은 시한 `>= DELIVERY_MAX_MS`)보다 강한 조건이다. 모자라면 싣지 않고 사라진 갱신으로 다룬다(장부에는 그 표시가 없어 믿은 끝이 남는다. 싣지 않은 기록을 다음 갱신의 근거로 쓰지 않는 처리는 배정기의 몫이다). 장부의 식은 봉투 시한과 싣는 시각을 입력받지 않으므로 이 규칙은 보내는 쪽의 조건이고, 어기면 장부가 믿는 끝이 틀린다(가정 (4)). 제때(앞 지시의 발행 + 기본 간격에) 기록한 갱신은 기록부터 7000ms 안에 실으면 이 조건을 통과하므로, 같은 판단 주기 안에 곧바로 싣는다.
  - **판단을 갱신 구간 안에서 부른다.** 갱신을 낼 수 있는 구간은 `[lease.issuedAt + renewEveryMs, lease.expiresAt − RENEW_MARGIN_MS]`이고 기본값에서 7000ms다. 판단 호출이 구간을 지나치면 갱신 대신 조회가 나오고, 조회의 답에는 임대 끝이 없어 같은 실행을 다시 갱신할 길이 없다. 타이머가 늦을 수 있는 만큼 구간을 확보한다(구간의 앞쪽에 깨우고 구간 안에서 여러 번 부른다). 정책 검증(`renewEveryMs + RENEW_MARGIN_MS <= RUN_LEASE_MAX_MS`, 지금 `renewEveryMs <= 17000`)은 구간 0ms를 허락한다. 타이머 지연의 상한이 정해지지 않아 검증으로 더 조이지 않았다.
  - 계속 실행할 수 있는 상태에서 임대 끝을 모르거나 여유가 없으면 같은 ID를 조회하고, 취소·기한·종료·결과 처리는 실행 상태에 따른다.
- **CLI 풀기(§7.6):** 장부 쪽은 `releaseStop({ generation })` 하나다. 풀면 접수가 닫히고 새 복원 시도가 끝까지 마쳐야 열린다. 새 실행 세대를 적는 연산은 아직 없다. 세대를 올리면 옛 세대의 대기 실행은 시작되지 않고(`run_generation_stale`, 5단계 `staleQueued`) 종료 기록만 된다. 확인 단계(`phase`)는 `applyStop`의 `phase`로 같은 세대에 덧붙인다.
- **현관:** 권위 정지 기록의 답은 `{ generation, stopped }` 두 칸이어야 하고 다른 꼴은 모름이다. 게시 연결은 같은 작업 ID에 다른 후보를 다시 연결하지 않는다.

### R2로 보내는 쪽이 지킬 것

**사본을 만들고 보낼 때**

1. 실행마다 없는 새 경로를 넘긴다. 같은 이름을 다시 쓰면 `target_exists`다.
2. 사본 폴더는 감독만 쓰는 폴더에 두고, 링크가 없는 실제 경로를 넘긴다.
3. `ok: true`로 돌려준 `path`만 올린다. `<path>.partial-<UUID>`는 올리지 않고 지운다.
4. 돌려준 `sha256`을 함께 보관하고, 올린 뒤 대조한 다음에 로컬 사본을 지운다.
5. `maxBytes`는 내보낼 사본 크기의 상한이다. 쓰기가 막히는 시간과 프로세스 메모리의 상한이 아니므로, 호출 시점과 메모리 여유는 `blockedMs`의 실측과 장부 크기의 세 벌을 보고 보내는 쪽이 정한다. `too_large`와 `snapshot_hold`는 사본이 만들어지지 않은 것이므로 실패로 알린다.

**원격에서 되가져와 장부 자리에 놓을 때**

1. 감독을 멈춘다. 장부를 쥔 프로세스가 있으면 놓지 않는다.
2. 되가져온 파일의 `sha256`을 대조한다.
3. 장부 자리의 본체와 `-wal`·`-shm`·`-journal`을 함께 장부 폴더 밖으로 옮긴다. 하나만 옮기지 않는다.
4. 사본을 장부 이름의 정규 파일 하나로 놓는다(링크, 이름이 둘인 파일은 받지 않는다).
5. `mode: "reopen"`으로 연다. `create`로 열지 않는다. 사본 기록을 고치지 않는다.
6. 보류 상태에서 관리자가 계정 잠금과 영수증을 대조한 뒤 `confirmSnapshotReconciled`를 부르고, 새 복원 시도를 끝까지 마친다.
7. 첫 열기가 `interrupted_install`로 닫히면 그 본체와 저널을 함께 장부 폴더 밖으로 옮겨 보존하고, 해시가 맞는 사본을 2번부터 다시 놓는다. 저널을 지우고 같은 본체를 다시 열지 않는다.

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
