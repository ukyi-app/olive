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
| `0001-core` | 아래 "표"의 핵심 표와 그 트리거·인덱스·제약. `instructions.lease_until`은 판 2, `tool_requests`는 판 3, `instructions`의 본문 칸 다섯은 판 4가 만든다 |
| `0002-renew-lease-end` | `instructions.lease_until`(INTEGER, NULL 허용) 칸 하나. 갱신 지시(`run_renew`)만 값을 가질 수 있고 그 값은 발행 시각보다 늦고 9007199254740991 이하다(CHECK). 칸만 더하므로 기존 줄은 NULL(끝 모름)이고 다른 칸의 값과 제약은 그대로다 |
| `0003-tool-requests` | 표 `tool_requests`와 트리거 셋(`tool_requests_born_waiting`, `tool_requests_permanent`, `tool_requests_fixed`). 아래 "작업 부탁(배정 전 대기)". 새 표만 더하므로 기존 표·줄은 그대로다 |
| `0004-instruction-rebuild` | `instructions`에 지시 본문을 다시 만들 칸 다섯(NULL 허용): `budget_left`(시작 지시만, 1 이상), `reason`(종료 지시만, 동작마다 계약 v1의 목록), `outcome`·`result_digest`·`stored_at`(확정 지시만, `outcome`과 `stored_at`은 함께, `result_digest`는 `succeeded`일 때만이고 그때는 반드시. 그래서 세 칸은 다시 만들 수 있는 완전한 조합이거나 셋 다 비어 있고, `outcome` 없이 `result_digest`만 있는 줄도 CHECK가 막는다). 이 CHECK는 칸의 조합과 `reason`·`outcome`의 목록, 정수의 범위만 본다. 값의 형식(결과 digest가 계약의 소문자 16진수 64자리인가 등)은 장부의 공개 쓰기가 검사한다. 아래 "답을 받지 못한 지시". 칸만 더하므로 기존 줄은 NULL(다시 만들 수 없음)이고 다른 칸의 값과 제약·트리거(`instructions_fixed` 등)는 그대로다 |
| `0005-run-sightings` | 표 `run_sightings`와 트리거 셋(`run_sightings_first_only`, `run_sightings_fixed`, `run_sightings_permanent`). 아래 "실행기의 답". 새 표만 더하므로 기존 표·줄·트리거는 그대로이고 올라간 장부의 표는 비어 있다(지난 답은 거슬러 적지 않는다) |
| `0006-unreceived-closure` | 전이 두 줄(`run_transitions`에 작업자의 `preparing → not_started`, `unknown_running → not_started`), 표 `start_dispatches`(송신 표식)와 트리거 셋(`start_dispatches_start_only`, `start_dispatches_fixed`, `start_dispatches_permanent`), 표 `starts_before_closure`(이 판을 적용할 때 이미 있던 시작 지시)와 트리거 셋(`starts_before_closure_sealed`, `starts_before_closure_fixed`, `starts_before_closure_permanent`), 표 `snapshots_before_closure`(이 판을 적용할 때 이미 있던 사본 기록)와 트리거 셋(`snapshots_before_closure_sealed`, `snapshots_before_closure_fixed`, `snapshots_before_closure_permanent`), 표 `snapshot_run_bounds`(사본의 경계)와 트리거 셋(`snapshot_run_bounds_sealed`, `snapshot_run_bounds_fixed`, `snapshot_run_bounds_permanent`), 표 `unreceived_closures`(D-90 닫기 근거)와 트리거 셋(`unreceived_closures_proven`, `unreceived_closures_fixed`, `unreceived_closures_permanent`), `runs`의 트리거 `runs_not_started_needs_closure`. 새 표 다섯의 모든 칸은 `NOT NULL`이다. 아래 "받은 적 없는 실행의 닫기". 새 표·트리거·전이 줄만 더하므로 기존 줄은 그대로다. 올라간 장부에서 `start_dispatches`·`snapshot_run_bounds`·`unreceived_closures`는 비어 있고, `starts_before_closure`에는 적용하는 트랜잭션에 있던 `instructions`의 시작 지시(`task_start`·`session_start`)가, `snapshots_before_closure`에는 그때 있던 `ledger_snapshots`의 사본 기록이 모두 들어간다. 그 뒤로는 두 표 모두 줄이 늘지 않는다(트리거). 이 줄 옮기기는 기존 행을 읽지만 결과 스키마는 행과 무관하다(빈 DB에 재생하면 같은 스키마에 0줄) |
| `0007-operator-closure` | 전이 한 줄(`run_transitions`에 작업자의 `stopping → not_started`), 표 `operator_closures`(관리자 닫기 근거: `run_id`·`from_state`·`checked_by`·`pod_name`(`TEXT`)·`pod_started_at`·`stop_generation`·`closed_at`(`ANY`에 CHECK `typeof = 'integer'`와 범위), 모두 `NOT NULL`)와 트리거 넷(`operator_closures_proven`: 세 정수 칸의 형이 정수, 확인 방법 `pod_replaced` 하나, 그 실행의 `task_start`가 있고 `session_start`가 없음, 정지 기록과 세대, 닫은 시각과 새 파드가 뜬 시각이 모두 닫을 수 있게 되는 시각 이후이고 파드가 뜬 시각 ≤ 닫은 시각 등을 본다, 근거 줄을 넣는 문장 안에서 실행 줄을 닫고 그 실행의 미반영 보고를 마치는 `AFTER INSERT` 트리거 `operator_closures_close_run`, `operator_closures_fixed`, `operator_closures_permanent`), `unreceived_closures`의 트리거 `unreceived_closures_exclusive`, 그리고 `runs_not_started_needs_closure`를 `DROP` 뒤 "두 근거 표 가운데 하나"로 다시 `CREATE`. 판 6의 표·칸·다른 트리거·전이 줄은 그대로이고 올라간 장부의 새 표는 비어 있다. 아래 "관리자가 실패로 닫기(D-91)" |

판 하나는 트랜잭션 하나라 도중에 실패하거나 끊기면 그 판 전체가 되돌려진다. 적용 기록은 `ledger_migrations(version, name, applied_at)`. 번호가 비거나, 이름과 번호가 다르거나, 폴더에 꼴이 다른 파일이 있거나, 장부의 판이 코드보다 높거나, 같은 번호의 이름이 다르면 열지 않는다. 호출자가 `migrations`로 넘긴 목록도 같은 검사를 파일을 열기 전에 자리마다 거친다(배열의 빈 자리 포함). 적용 시각으로 쓸 시계의 값도 파일을 건드리기 전에 확인한다.

**지원하는 판의 범위: 모든 판은 식별 행이 없는 빈 DB에서 번호 순서대로 재생할 수 있어야 한다. 기존 행에 기대는 판(데이터 이관이 필요한 판)은 이 장부가 아직 지원하지 않는다.** 판 6이 기존 시작 지시를 새 표로 옮기는 것은 스키마가 행에 기대지 않아(빈 DB에서는 0줄) 이 범위 안이다. 재개방은 코드의 판을 빈 메모리 DB에 재생한 스키마와 장부를 대조하기 때문이다. 판을 올리는 `reopen`과 `create`는 실제 판을 커밋하기 전에 목록 전체를 재생해 보고, 재생하지 못하면 장부를 바꾸지 않고 `migration_failed`로 거절한다. 판이 하나도 없는 목록의 `create`는 재개방이 대조할 적용 기록이 남지 않으므로 파일을 만들지 않고 `migration_mismatch`로 거절한다. 재생은 되지만 실제 장부의 행에 따라 다른 스키마를 남기는 판(행이 있을 때만 통계 표를 만드는 `PRAGMA optimize` 등)은 미리 가르지 못한다. 판의 결과 스키마는 데이터에 따라 달라지면 안 된다.

**병합된 판은 고치지 않고 다음 번호로 더한다.** 장부가 아직 어디에도 배포되지 않았어도 같다. 리뷰 반영을 그 판의 파일에 직접 고치는 것은 그 판이 병합되기 전까지다(`0001-core.sql`의 리뷰 반영도 그 판이 병합되기 전에 그 파일에 했다). 병합된 판의 한계는 그 파일을 고치지 않고 이 문서에 적거나 다음 번호의 판이 막는다(판 6의 닫기 근거 표가 원 SQL의 소수 시각을 정수로 받는 한계는 아래 "받은 적 없는 실행의 닫기"의 "이 판이 막지 못하는 것").

**판을 올린 장부는 옛 코드로 열지 않는다.** 판 4를 적용한 장부를 판 3까지 아는 코드(또는 판 목록을 그 앞에서 끊은 열기)로 열면 `too_new`로 거절한다. 판 5를 적용한 장부도 판 4까지 아는 코드로는 `too_new`이고, 판 6을 적용한 장부도 판 5까지 아는 코드로는 `too_new`다(판 6의 송신 표식·닫기 근거를 모르는 코드가 근거 없는 `not_started`를 읽지 않게 한다). 판 7을 적용한 장부도 판 6까지 아는 코드로는 `too_new`다(관리자 근거를 모르는 코드가 관리자가 닫은 `not_started`를 "시작 안 함"으로 읽어 그 실행이 잡은 예산을 같은 요청의 한도로 돌려주지 않게 한다). 판 2·3과 같은 성질이고, 되돌리려면 그 판 전에 만든 사본으로 돌아가야 한다(그 사본에는 그 뒤의 양성 관측이 없다).

## 표

`instructions.lease_until`은 `0002-renew-lease-end`, `tool_requests`는 `0003-tool-requests`, `run_sightings`는 `0005-run-sightings`, `start_dispatches`·`starts_before_closure`·`snapshots_before_closure`·`snapshot_run_bounds`·`unreceived_closures` 다섯은 판 6(`0006-unreceived-closure`)에서, `operator_closures`는 판 7(`0007-operator-closure`)에서 처음 생기고 나머지는 모두 `0001-core`다(`instructions`의 본문 칸 다섯은 `0004`).

| 묶음 | 표 | 요지 |
|---|---|---|
| 정지·일시 중지 | `stop_state`, `diagnosis_pause` | 정지 세대(0 포함, 줄이 없으면 아직 적지 않음), 정지 여부, 확인 단계, 진단 일시 중지의 끝 |
| 실행·슬롯·예산 | `runs`, `run_epoch`, `run_transitions`, `instructions`, `slot_holds` | 실행 ID·세대·역할·revision 둘·snapshot·실행기·자격 네 칸·기한·남은 예산·상태·영수증 id들. 낸 지시(v1 여섯, 적은 뒤 불변)와 갱신 지시가 발급한 임대 끝("스케줄러가 쓰는 읽기"의 "발급한 갱신의 끝"), 지시 본문을 다시 만들 칸("답을 받지 못한 지시"). 점유가 맞지 않은 관측: (실행기, 실행, 세대)마다 한 줄이고 관측 번호를 가진다. 줄이 있으면 그 실행 ID를 영영 시작하지 않고, `holds_slot`이면 그 종류의 슬롯도 막는다 |
| 양성 관측 | `run_sightings` | 실행기가 그 실행을 안다고(`not_known` 밖으로) 답한 첫 관측. (실행, 실행기, 세대)마다 한 줄이고 그 셋은 실행 줄의 실행·지정 실행기·실행 세대와 같아야 한다. 답한 상태, 답의 시각(실행기 시계, 복원 경로는 없음), 받은 시각, `full`·`partial`. 지우거나 고치거나 덮지 않는다 |
| 송신 표식·닫기 근거 | `start_dispatches`, `starts_before_closure`, `snapshots_before_closure`, `snapshot_run_bounds`, `unreceived_closures`, `operator_closures` | 시작 봉투를 실었을 수 있는 장부 열기: (실행, 열기 ID)마다 한 줄, 그 실행의 시작 지시의 요청 ID와 적은 시각. 판 6을 적용할 때 이미 있던 시작 지시: (실행, 요청 ID)마다 한 줄, 판의 트랜잭션에서만 들어간다. 판 6을 적용할 때 이미 있던 사본 기록(경계를 모르는 사본): 사본 기록마다 한 줄, 판의 트랜잭션에서만 들어간다. 사본의 경계: 판 6에서 봉한 사본 기록마다 한 줄, 사본을 봉할 때의 `runs.queue_seq` 최댓값. D-90으로 닫은 실행의 근거: 실행마다 한 줄, 앞 상태, 그 실행을 싣지 않은 전체 답의 낸 쪽·서명 시각(실행기 시계)·받은 시각, 닫은 열기 ID, 닫은 시각. 관리자가 닫은 실행의 근거(판 7): 실행마다 한 줄, 앞 상태, 확인 방법, 확인한 파드의 이름과 그 파드가 뜬 시각, 그때의 정지 세대, 닫은 시각. 여섯 다 지우거나 고치지 않는다 |
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

새 접수·작업 부탁·배정·실행 줄·시작·자격·게시·갱신·송신 표식·받은 적 없는 실행의 닫기(`enqueueInput`, `recordToolRequest`, `assignToolRequest`, `admitRun`, `startRun`, `startSession`, `recordPublication`, `recordRenewInstruction`, `markStartDispatch`, `closeUnreceivedRun`)는 모두 한 자리(`Ledger`의 쓰기 모드 `start`)의 전제를 거친다.

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

`startSession`은 이 전제를 지난 뒤 항상 `session_start_closed`로 거절한다("세션 증거" 참조). 작업자 시작(`startRun`)은 여기에 더해 지시의 정지 세대가 장부의 지금 값과 같고, 실행 줄의 세대가 지금 실행 세대(`run_epoch`)와 같고(`run_generation_stale`), 그 종류에 슬롯 차단(`slot_holds`의 `holds_slot`)도 자리를 쥔 실행도 없을 때(`slot_busy`)만 된다. 시작 트랜잭션 안에서 이 실행 자체도 다시 본다: 이 실행 ID의 점유 관측이 있으면 `run_blocked`, 연결된 입력이 취소됐으면 `input_cancelled`, 원문이 만료됐으면 `input_expired`, 실행 기한이 지났으면 `deadline_passed`다. 이 넷은 앞의 검사(공통 전제, 정지 세대, 실행 줄이 `queued`인지, 실행 세대, 슬롯)를 모두 지난 뒤에만 나온다. 앞의 검사가 먼저 걸리면 그 이름이 답이고(예: 입력이 취소된 실행이어도 다른 실행이 슬롯을 쥐고 있으면 `slot_busy`), 어느 쪽이든 시작되지 않는다. 기한과 만료는 호출자가 넘긴 값이 아니라 장부에 주입한 시계로 재고, 트랜잭션마다 시계를 한 번만 읽어 판정과 발행 시각(`issued_at`)과 상태 변경에 같은 값을 쓴다. 성공 답은 `{ ok: true, run, credential, issuedAt }`이고 `issuedAt`은 그 시작 지시에 적은 발행 시각이다(넘긴 `now`가 아니다. 갱신 전의 `instructionTimes(runId).lease.issuedAt`과 같다). 부르는 쪽은 이 값을 `task_start` 머리의 `issued_at`에 싣는다. 이미 시작한 실행을 다시 부르면 거절이고 발행 시각은 성공 답에만 있다. 그 거절의 이름도 앞선 검사를 따른다: 같은 정지 세대면 `transition_denied`, 맞지 않는 정지 세대면 `stop_generation_mismatch`, 정지 뒤면 `stopped`다. 작업자는 v1 `task_start`를 만들 수 있는 줄(입력 digest가 있고 예산이 1 이상, 역할과 지정 실행기가 맞음)만 자리를 잡는다(`not_startable`).

종료 기록, 영수증·보고의 반영, 복원 자체의 쓰기, 조회는 이 전제 없이 된다. `Restorer.intakeOpen()`과 `Ledger.intakeOpen()`은 단계 결과가 아니라 지금의 장부(건강, 허가, 정지 기록)를 읽고, 읽지 못하면 `false`다. `Restorer.intakeOpen()`은 그 복원기가 낸 허가만 센다. 5단계의 `intakeMayOpen`은 허가를 낸 그 순간의 판정이라, 그 뒤에 정지가 걸리면 값은 `true`로 남아도 `intakeOpen()`은 `false`다.

## 쓰기 규칙

- **실행 줄이 먼저:** `admitRun`이 대기(`queued`)로 실행 줄을 적는다. `startRun`이 자리를 잡고(`preparing`) 시작 지시를 적은 커밋이 끝난 뒤에만 지시를 보낸다. 영수증은 장부에 적힌 지시만 가리킬 수 있다. 같은 중복 키는 같은 실행을 돌려준다.
- **영수증:** `applyReceipt(input, from)`의 `from`은 검증을 마친 봉투의 낸 쪽 주체 이름과 머리의 `run_generation`이다. 대조 순서는 발신자·실행·세대 → 이미 받은 id의 분류 → 새 id의 원 지시 대조와 효과다. 낸 쪽이 그 실행의 지정 실행기가 아니면 `sender_mismatch`, 세대가 다르면 `run_generation_mismatch`이고 충돌 기록을 포함해 아무것도 적지 않는다(ack·상태·슬롯이 그대로). 같은 id·같은 digest는 한 번만 반영하고 다시 받으면 `duplicate`(ack는 다시 준다). 같은 id에 다른 digest는 원 지시가 달라도 `receipt_conflicts`에 남기고 `receipt_conflict`. 새 접수 영수증은 원 지시의 이름(`instruction`, v1 여섯 가운데 하나)이 장부의 지시와 같아야 한다. 영수증과 그 상태 전이는 한 트랜잭션이다.
- **증거:** 실행 줄의 영수증 id 칸은 같은 실행이 받은 맞는 종류의 영수증만 가리키고 한 번만 채운다(트리거 `runs_evidence`). 정리 영수증은 그 실행의 `result_finalize` 지시를 가리킨다. 받은 기록, 낸 지시, 실행 줄, 규칙 확인, 교체 기록, 시작 허가의 사용은 지우거나 바꿔 넣지 못한다(트리거). 실행 줄과 교체 기록은 보조 고유 키(`queue_seq`, `dedupe_key`, 슬롯, 다음 실행, 앞 세션의 확정)가 부딪히는 `INSERT OR REPLACE`·`UPDATE OR REPLACE`로도 밀려나지 않는다. TEXT 키의 표는 모두 `WITHOUT ROWID`라 rowid 충돌로 행이 교체되지 않는다.
- **상태 전이:** `states.ts`의 표만 허용한다. 같은 표가 장부의 `run_transitions`와 트리거에 있다. 종료 확인(`stop_receipt_id`) 없이 `checking`·`ready_result`·`failed_stopped`·`cleanup_pending`이 되지 않는다(CHECK). `not_started`는 지시를 내기 전(`queued`)에서, 또는 닫기 근거가 있을 때만 간다: 판 6이 작업자의 `preparing`·`unknown_running → not_started`를, 판 7이 `stopping → not_started`를 더했고, 트리거 `runs_not_started_needs_closure`(판 7이 다시 만든 것)가 `queued` 밖에서 `not_started`로 가는 갱신을 같은 앞 상태의 근거 줄이 `unreceived_closures`·`operator_closures` 가운데 하나에 있을 때만 허락한다(아래 "받은 적 없는 실행의 닫기", "관리자가 실패로 닫기"). 관리자 근거 줄은 그 줄을 넣는 문장 안에서 `operator_closures_close_run`이 실행 줄을 닫는다. 종료 확인 영수증의 `exit`가 `completed`면 `checking`, 그 밖이면 `failed_stopped`다. `checking`에서 `unknown_running`으로 가는 길은 없다.
- **끊김 판정:** `markLost`는 종료 확인이 없는 `preparing`·`running`·`stopping`에만 계약의 `stateAfterLoss`를 쓴다(→ `unknown_running`). 계약의 함수는 종료 증명이 없는 실행기 쪽 상태의 함수라, 장부에서는 `stop_receipt_id`가 없는 줄에만 그대로 쓸 수 있다. 종료 확인이 있는 `checking`은 그대로 두고 결과 검사를 이어 간다.
- **실행기 하나의 끊김(`markLostFor`):** `markLostFor({ executorId, now })`는 위 `markLost`와 같은 집합(종료 확인이 없는 `preparing`·`running`·`stopping`) 가운데 **지정 실행기가 `executorId`인 실행만** 같은 규칙(`stateAfterLoss`)으로 옮긴다. 두 연산은 옮기는 자리 하나를 함께 쓴다(`ledger.ts`의 `#moveLost`). 다른 실행기의 실행, 이미 끝난 실행, 종료 확인이 있는 실행, 실행기에 보낸 적 없는 `queued`는 그대로다. 입력은 그 두 칸뿐이다. `executorId`는 `admitRun`이 지정 실행기로 받는 이름이어야 한다: 같은 판정(계약의 `parsePrincipal`)으로 작업자·세션 실행기만 받는다. 꼴이 틀리거나 실행을 맡을 수 없는 이름(`supervisor`, `executor`, 역할이 틀린 이름, 대문자 이름)이면 `admitRun`처럼 `LedgerInputError`이고 장부는 그대로다.
  - **답:** `{ ok: true, runs: LostRun[] }`. 항목은 `{ runId, runGeneration, before, after }`(옮기기 전과 뒤의 상태, `after`는 지금 규칙에서 늘 `unknown_running`)이고 접수 순번(`queue_seq`) 순서다. 부르는 쪽은 그 `runId`로 같은 ID의 상태 조회를 낸다. 문법상 유효하지만 실행이 없는 실행기 이름이나 옮길 실행이 없는 실행기는 아무것도 바꾸지 않고 빈 목록이다. 이미 옮긴 실행은 `unknown_running`이라 집합 밖이므로 다시 부르면 빈 목록이다(멱등).
  - **실행 세대로 좁히지 않는다.** 실행 세대(`run_generation`)는 실행 줄을 적을 때의 `run_epoch`이고 시작(`run_generation_stale`)과 영수증·보고(`run_generation_mismatch`)의 대조 값이다. 연결의 세대가 아니고 연결이 끊긴다고 바뀌지 않는다. 그래서 세대가 오른 뒤에도 끊긴 실행기에 남은 옛 세대의 진행 중 실행은 똑같이 살아 있는지 모르고, 좁히면 그 실행이 `running`으로 남는 쪽(틀리는 방향)으로 틀린다. 장부에는 연결의 세대가 없어 그것으로는 가를 수 없다.
  - **자리와 임대:** 끊김은 실행을 `unknown_running`으로만 옮긴다. `unknown_running`은 자리를 놓는 상태가 아니고 진행 중 상태에서 자리를 놓는 상태로 가는 전이도 없어서, 옮긴 실행은 자리를 쥔 채다. 그 뒤 수명 판단(`nextIntent`)은 믿은 임대가 남아 있어도 갱신을 내지 않는다: 취소 요청이 없고 기한 전이면 같은 ID의 조회이고, 취소·기한이 걸려 있으면 종료(`stop`)가 먼저다. 갱신 기록은 거절되고, 사유는 공통 검사의 우선순위를 따른다: 정지 중이면 `stopped`(접수가 닫혀 있으면 `intake_closed`), 다른 정지 세대면 `stop_generation_mismatch`이고, 정상 접수·같은 정지 세대에서만 실행 상태 검사에 이르러 `preparing`·`running` 밖이라 `transition_denied`다. 자리를 놓는 조건은 실행 종류마다 다르다. 작업자는 나중에 종료 확인 영수증이 오면 지금 규칙대로 `checking`·`failed_stopped`가 되지만 그 뒤에도 자리를 쥐고, `result_finalize`를 가리키는 정리 영수증(`receipt_cleaned`)으로 `finalized`가 된 뒤에야 놓는다. 세션은 표의 `stopping`·`unknown_running → finalized`와 인수 영수증의 별도 경로를 따르고, 지금의 인수 반영은 증거만 적을 뿐 작업자의 결과 상태로 옮기지 않는다(`test/ledger/executor-loss.test.ts`).
  - **쓰기 모드는 `markLost`와 같은 `continue`다.** 장부가 "못 씀"이 된 뒤에도, 사본 보류 중에도 시도한다. 이 쓰기는 새 일을 열지 않고 "살아 있다"는 믿음만 거두는 닫는 쪽이라, 실패한 장부에서 막으면 끊긴 실행기의 실행이 `running`으로 남는다. 닫힌 장부는 `ledger_unwritable`이다.
  - **남는 한계:** 부르기 전까지 적힌 갱신과 그 발급 기록은 그대로 남는다(`instructionTimes`의 `lease`·`renewIssued`는 지우지 않는다. 판단은 상태로 가른다). 옮긴 뒤 조회의 답은 `applyExecutorAnswer`(아래 "실행기의 답")가 받지만 `unknown_running`을 되살리지 않는다. 그래서 다시 붙은 실행기가 "아직 돈다"고 답해도 장부는 `unknown_running`이고 그 실행에 갱신을 다시 적을 길이 없으며, 위 "자리와 임대"의 조건이 찰 때까지 자리를 쥔다.
- **실행기의 답(`applyExecutorAnswer`):** 운영 중에 받은 실행기의 답(조회의 답 `status_report`, 또는 인사 `hello`의 실행 목록)을 장부에 반영한다. 입력은 `{ coverage, runs, answeredAt, now }`와 `{ sender }`다. `runs`는 계약 v1의 실행 상태 항목(`run_id`, `state`, `run_generation`, `last_receipt_id`) 그대로이고 계약과 같은 꼴만 받는다(같은 실행 ID는 한 번, `not_known`이면 세대·영수증이 `null`이고 그 밖은 세대 1 이상, 많아야 `STATUS_MAX_RUNS`개, `partial`은 하나 이상). `sender`는 검증된 답 봉투의 낸 쪽, `answeredAt`은 그 봉투의 `issued_at`(실행기 시계, 모르면 `null`), `now`는 장부에 적는 시각(장부 시계)이다. `coverage`는 `partial`(조회의 답)과 `full`(인사의 전체 목록)을 받되 **지금은 둘을 같은 규칙으로 처리하고 값을 관측에 적기만 한다.** `full`에서 "목록에 없는 실행"을 닫는 일은 뒤 조각(D-90)의 몫이다. 꼴이 틀리거나 `sender`가 실행을 맡을 수 없는 이름이면 `markLostFor`와 같은 판정으로 `LedgerInputError`이고 장부는 그대로다.
  - **보는 항목:** 장부에 있고 그 실행의 지정 실행기가 `sender`인 항목만 본다. `not_known` 밖의 답은 실행 세대도 장부와 같아야 한다(`not_known`은 계약상 세대가 `null`이라 지정 실행기만 본다). 다른 실행기·다른 세대의 항목은 상태도 관측도 바꾸지 않는다. 장부에 없는 실행은 실행 줄로 올리지 않고 계약의 `runsOutsideLedger`(복원 2단계의 종료 대상과 같은 규칙)로 고른 닫을 대상으로만 돌려준다. 낸 쪽과 무관하고 `not_known`은 고르지 않는다.
  - **양성 관측:** 지정 실행기가 같은 세대로 `not_known` 밖의 상태를 답하면 `run_sightings`에 (실행, 실행기, 세대)의 첫 관측(답한 상태, 답의 `last_receipt_id`, `answeredAt`, `now`, `coverage`)을 적는다. 같은 열쇠의 답을 다시 받으면 그대로다(첫 관측을 덮지 않는다). 장부의 상태와 무관하게 적는다(대기·끝난 실행도). `last_receipt_id`는 적기만 하고 영수증으로 반영하지 않는다(영수증은 `applyReceipt`의 몫). 읽기는 `hasRunSighting(runId)`: `Read<boolean | null>`(양성 관측이 하나라도 있는가, 없는 실행이면 `null`). `unansweredInstructions()`의 항목에 표시를 더하는 쪽보다 좁아 이것을 골랐다: D-90의 닫기는 시작 지시만 보는데 그 읽기는 종료·확정 지시도 내고, 기존 읽기의 항목 꼴을 바꾸지 않는다.
  - **상태:** 아래 표대로다. 옮기는 자리는 `markLostFor`와 같은 `#moveLost`이고 전이는 `preparing`·`running → unknown_running` 하나다(지금 전이표에 있다). 자리는 어떤 답으로도 풀지 않는다. **답은 지시를 만들지 않는다:** 돈다는 답에도 갱신 기록을 만들지 않고 임대를 늘리지 않는다(답에는 실행기의 임대 끝이 없다).

    | 장부 \ 실행기의 답 | `preparing`·`running`(갱신을 받는 상태) | `stopping`·`checking`·`unknown_running`(끝내는 중·모름) | `not_started`·`failed_stopped`·`ready_result`·`cleanup_pending`·`finalized`(끝났다) | `not_known`(모른다) |
    |---|---|---|---|---|
    | `preparing`·`running` | 그대로(믿은 임대 유지) | `unknown_running` | `unknown_running` | 실행기 시계로 시작 발행 + `RUN_LEASE_MAX_MS` 이후(정각 포함)에 만든 답이면 `unknown_running`. 그 전이거나 답의 시각을 모르면 그대로(`deferred`) |
    | `stopping` | 그대로 | 그대로 | 그대로 | 그대로 |
    | `unknown_running` | 그대로(되살리지 않는다) | 그대로 | 그대로 | 그대로 |
    | 그 밖(`queued`, 종료 확인 뒤, 끝난 상태) | 그대로 | 그대로 | 그대로 | 그대로 |

    슬롯 점유 여부는 답 전후 같다(쥐던 상태는 계속 쥐고, `queued`·`finalized`·`not_started`는 계속 비어 있다).

    - **가른 근거(실행기 코드):** 실행기는 갱신을 `preparing`·`running`에서만 적용하고 한 번 닫힌 실행(취소·기한·임대 만료)의 임대는 되살리지 않는다(`src/executor/worker.ts`의 `onRenew`). `stopping`은 실행기가 프로세스를 끝내는 중, `checking`은 남은 프로세스 0개를 센 뒤 종료 영수증을 적기 전, `unknown_running`은 남은 프로세스를 모르거나 실행기 장부가 그 실행을 설명하지 못하는 상태다(`worker.ts`의 `confirmStopped`·`statusOf`). 끝난 다섯은 실행기 디스크에 종료 영수증이 꼭 있는 상태다(`src/executor/store.ts`의 `REQUIRED_EVENTS`). 그래서 `preparing`·`running` 밖의 유세대 양성 답(`not_known` 밖의 답)은 모두 "그 실행에 갱신이 더는 적용되지 않는다"는 반대 증거이고 D-89의 "상태 보고가 이긴다"에 따라 믿던 임대를 거둔다. `not_known`은 아래 "이른 `not_known`은 보류한다"의 조건을 넘은 답만 거둔다.
    - **끝난 상태로 옮기지 않는다:** "끝났다"는 답만으로 `checking`·`failed_stopped` 등이 되지 않는다. 그 상태는 종료 확인 영수증이 있어야 하고(CHECK), 실행기는 그 영수증을 ack를 받을 때까지 다시 보낸다. 옮긴 뒤 그 영수증이 오면 지금 규칙대로 `checking`·`failed_stopped`가 되고, 자리는 정리 영수증으로 `finalized`가 된 뒤에 놓는다.
    - **장부가 `stopping`이면** 이미 갱신하지 않으므로 그대로 둔다. **`unknown_running`은** 어떤 답에도 그대로다(전이표에 `unknown_running → running`이 없고 만들지 않는다).
    - **이른 `not_known`은 보류한다.** 시작을 아직 받지 못한 실행기는 그 실행을 모른다고 답한다. 그 답으로 임대를 거두면 곧 시작을 받아 정상으로 도는 작업이 갱신을 잃고 실패한다(옮긴 뒤 도착한 시작 영수증으로는 되살리지 않는다). 그래서 `not_known`은 실행기가 그 시작을 더는 받을 수 없을 때 만든 답일 때만 옮긴다: `answeredAt >= 시작 지시 줄의 발행 시각 + RUN_LEASE_MAX_MS`. 실행기는 봉투 시한(발행 + `MESSAGE_TTL_MAX_MS`) 뒤로는 시작을 받지 않고, 받아도 발행 + `RUN_LEASE_MAX_MS`에 임대가 끝난다(v1에서 둘 다 30000ms). 시작 지시는 실행마다 하나이고 다시 봉해도 그 발행 시각을 싣는다. 갱신 뒤의 `instructionTimes`의 `lease.issuedAt`(갱신의 시각)으로 재지 않는다. `answeredAt`이 `null`이면 보류한다: 살아 있을 수 있는 작업을 죽이지 않는 쪽이고, 그 임대는 실행기 쪽에서 스스로 끝난다. 보류한 실행은 상태·임대·발급 기록이 그대로이고 답의 `deferred`에 나온다. 부르는 쪽은 같은 ID를 다시 조회한다. 끝났다·끝내는 중이라는 답은 시각과 무관하게 지금처럼 옮긴다.
  - **닫힌 실행이 아직 돈다는 답은 경보만 싣는다(D-128):** 닫기 근거(D-90·관리자 닫기)가 있는 `not_started` 실행을 지정 실행기가 같은 세대의 `running`으로 답하면(`full`·`partial` 모두) 답에 `alarms`의 항목 `{ runId, runGeneration, alarm: "closed_run_running" }`을 싣는다. 상태·임대·점유(`slot_holds`)·받은 기록은 바꾸지 않는다: 그 실행은 `not_started`라 위 표의 "그 밖"이고, 양성 관측은 다른 실행처럼 첫 줄만 적는다. 같은 답을 다시 받으면 경보를 다시 싣는다(관측은 그대로다). 다른 실행기·다른 세대·`running` 밖의 상태(`preparing`·`stopping` 등)·닫기 근거가 없는 `not_started`(대기에서 취소됨)에는 싣지 않는다. 판정은 늦은 영수증과 같은 `#closedAfterStart`이고 같은 쓰기 트랜잭션 안의 읽기라 새 표·칸이 없다. 쓰기가 실패한 답(`ok: false`)에는 경보가 없고, 같은 답을 다시 넘겨 적히면 그때 실린다.
  - **답:** `{ ok: true, moved, deferred, outsideLedger }`, 경보가 있으면 `alarms`를 더한다(없으면 칸이 없다: `applyReceipt`의 `alarm`과 같이 경보 없는 답의 꼴은 그대로다. `alarms`는 접수 순번 순서). `moved`는 `markLostFor`와 같은 꼴(`{ runId, runGeneration, before, after }`, `after`는 늘 `unknown_running`)이고 접수 순번 순서다. `deferred`는 `{ runId, runGeneration, state, why }`이고 `why`는 `start_may_arrive`(시작이 아직 닿을 수 있는 동안의 답) 또는 `answer_time_unknown`(답의 시각 모름), 접수 순번 순서다. `outsideLedger`는 `{ runId, runGeneration }`이고 그 세대는 닫는 지시(`task_cancel`·`session_stop`)에만 쓴다. 이미 옮긴 실행은 `unknown_running`이라 같은 답을 다시 받아도 `moved`가 비어 있다.
  - **실패:** `{ ok: false, reason, unsavedSightings }`. 아무것도 적지 못한 것이다(상태 이동도 관측도 없다). `unsavedSightings`는 이 답의 `not_known` 밖 항목 전부(`{ runId, runGeneration }`, 장부와 대조하기 전이라 남의 항목도 들어 있다)다. 비어 있지 않으면 부르는 쪽은 그 실행기의 더 새 답을 넘기기 전에 이 답을 같은 값으로 다시 넘긴다: 새 답이 그 실행을 빼먹으면 "안다고 한 적이 있다"가 사라진다.
  - **쓰기 모드는 `markLostFor`와 같은 `continue`다.** 장부가 "못 씀"이 된 뒤에도, 사본 보류 중에도 시도한다. 임대를 거두는 것도 관측을 남기는 것도 자리를 더 오래 쥐는 쪽(D-90의 자동 해제를 막는 쪽)의 기록이라, 실패한 장부에서 막으면 끝난 실행에 갱신이 계속 적히거나 실행기가 안다고 한 사실을 잃는다. 닫힌 장부는 `ledger_unwritable`이다. 상태 이동과 관측은 한 트랜잭션이라 커밋 전에 끊기면 둘 다 남지 않는다.
  - **필요한 판:** 판 5. 판 목록을 그 앞에서 끊어 연 장부(시험용 길)에서는 양성 관측을 적어야 하는 답이 `ledger_unwritable`로 닫히고(상태도 옮기지 않는다) 건강 상태가 실패가 된다. `hasRunSighting`도 `{ known: false }`다. 복원 2단계도 관측을 적어야 하는 답을 받으면 실패한다.
  - **복원 2단계도 같은 표에 적는다.** 2단계가 받은 점유 응답 가운데 지정 실행기·같은 세대·`not_known` 밖의 항목(장부의 상태와 무관)을 같은 안쪽 함수로 적는다. 포트가 답 봉투의 시각을 싣지 않아 `answered_at`은 비고, `received_at`은 복원기가 그 답을 처음 받은 시각(복원기의 시계)이다. 붙든 관측을 다음 시도에서 다시 적어도 처음 받은 시각을 쓴다. 2단계의 판정·순서·답은 그대로이고, 점유 차단을 적은 뒤에 적는다. 적지 못하면 2단계가 `RestoreStepError`로 실패한다(다시 부를 수 있다): 관측을 잃으면 D-90의 자동 해제가 실행기가 안다고 한 실행의 자리를 풀 수 있다. 복원기는 적지 못한 관측(점유 차단을 적지 못해 단계가 먼저 멈춘 시도의 관측도)을 붙들고, 같은 복원기에서 2단계를 다시 부르면 새 답의 관측보다 먼저 함께 적는다. 다시 물은 답이 그 실행을 빼먹어도 앞의 관측을 적어야 단계가 통과한다. 붙든 관측은 메모리에만 있어 그 복원기를 버리거나(새 `Restorer`), 장부를 다시 열거나, 프로세스가 다시 뜨면 사라진다. 붙드는 것은 장부의 실행 목록과 대조한 뒤라, 같은 복원기 객체에서도 양성 답을 받은 뒤 실행 목록의 읽기가 실패하면 그 답은 붙들리지 않고 사라진다(다음 시도의 답이 그 실행을 빼먹으면 0행으로 통과한다).
  - **운영 중 관측만 적기(`recordAnswerSightings({ coverage, runs, answeredAt, now }, { sender })`):** 입력·꼴 검사·보는 항목·관측의 규칙은 `applyExecutorAnswer`와 같다(입력 타입 `AnswerSightingsInput`도 같은 타입이다). 다른 점은 **`run_sightings`에 첫 관측만 적고 실행 상태·임대(지시 기록)·영수증과 보고(`deliveries`)·자리(`slot_holds`)는 바꾸지 않는다**는 것이다. 장부 밖 실행도 돌려주지 않는다(닫을 대상을 고르는 일은 지금 연결의 답의 몫이다). 다른 실행기·다른 세대·장부 밖·`not_known` 항목은 거절하지 않고 건너뛴다: 트리거에 닿게 두면 답 전체가 거절되어 맞는 항목의 관측까지 잃는다. 성공은 `{ ok: true }`, 실패는 던지지 않고 `applyExecutorAnswer`와 같은 `{ ok: false, reason, unsavedSightings }`다(꼴이 틀린 입력만 `LedgerInputError`). 이 연산이 적은 줄도 `hasRunSighting`이 "본 적 있음"으로 읽고, 그 실행은 `closeUnreceivedRun`으로 닫히지 않는다. 거절 이름은 닫기의 앞선 검사를 따른다(아래 "받은 적 없는 실행의 닫기"의 조건표 차례. 예: 장부 실패면 `ledger_unwritable`, 사본 보류면 `snapshot_hold`). 정지 중이면 `stopped`, `preparing`·`unknown_running`이 아니면(`queued`·`running`·`not_started`·`finalized` 등) `transition_denied`이고, 앞 조건을 모두 지나 관측 검사에 닿을 때만 `run_sighted`다.
    - **왜 따로 있는가:** 받을 때는 검증·인정된 연결의 답이었으나 소비할 때 그 연결이 대체되었거나 대기 사본이 된 답(연결 판단의 `not_current`)으로 `applyExecutorAnswer`를 부르면 지금 연결이 아닌 쪽이 지금 실행의 임대를 거둔다. 그렇다고 답을 버리면 실행기가 안다고 한 사실이 사라져, D-90 닫기가 그 실행을 "받은 적 없음"으로 닫을 수 있다. 받을 때 유효했던 답이라 "안다고 한 적이 있다"만 남긴다.
    - **쓰기 모드는 `continue`다.** 관측을 적는 다른 두 연산(`applyExecutorAnswer`, `recordRunSightings`)과 같이 장부가 한 번 실패한 뒤에도, 사본 보류·정지·접수 닫힘 중에도 시도한다. 새 일을 열지 않고 자리를 더 오래 쥐는 쪽(D-90을 막는 쪽)의 기록이라 막을 까닭이 없고, `new`로 두면 장부가 한 번 실패한 뒤 받은 "안다"는 답은 부르는 쪽의 메모리에만 남아 프로세스가 다시 뜨면 사라진다. 닫힌 장부는 `ledger_unwritable`이다. 실패한 장부에서는 `closeUnreceivedRun`(쓰기 모드 `start`)이 어차피 닫지 않으므로, 실패 뒤의 기록이 D-90에 주는 이득은 다시 연 뒤에도 남는 사실이라는 것이다.
    - **남는 한계:** 답의 출처(어느 연결의 답인지, 어느 연산으로 적었는지)는 표에 남지 않는다. 판 5의 칸 그대로 쓰고 이관을 더하지 않는다. 지금 이 표를 읽는 쪽(`hasRunSighting`, D-90 닫기의 `run_sighted`)은 "그 실행기가 그 세대를 안다고 한 적이 있는가"만 보므로 출처가 판정을 바꾸지 않는다. 실패한 답을 다시 넘길 수 있는 것은 같은 프로세스 안뿐이라 아래 "0행의 뜻"은 그대로다.
  - **0행의 뜻(함정):** `run_sightings`에 그 실행의 줄이 0개라는 것은 저장에 실패한 양성 관측이 없었을 때만 "실행기가 그 실행을 안다고 한 적이 없다"이다. 같은 프로세스 안에서는 위의 두 길(운영의 `unsavedSightings`를 같은 답으로 다시 넘기기, 복원기가 붙든 관측)이 실패한 관측을 다시 적지만, 프로세스가 다시 떠서 원래 답을 잃으면 그 실패는 장부 어디에도 흔적이 없다. 이 판은 그 경우를 닫지 않는다(아래 "뒤 작업이 알아야 할 것"의 D-90).
  - **표의 제약:** `run_sightings`의 CHECK는 정수의 범위, 상태(계약 v1의 실행 상태에서 `not_known`을 뺀 열)와 `coverage`의 목록, NULL 허용(`answered_at`·`last_receipt_id`만)을 본다. 값의 형식(UUID, 실행기 주체 이름)은 공개 쓰기가 검사한다. INSERT 트리거는 (실행, 실행기, 세대)가 실행 줄의 실행·지정 실행기·실행 세대와 같지 않거나 같은 열쇠의 줄이 이미 있으면 막는다(`INSERT OR REPLACE`도). 비교 값에 NULL이 섞이면 맞는 실행이 없는 것으로 읽혀 막힌다. UPDATE·DELETE는 모두 막는다. 실행 줄의 세 칸은 바뀌지 않으므로(`runs_evidence`) 적은 줄은 계속 그 실행의 지정 실행기·세대의 것이다.
- **받은 적 없는 실행의 닫기(D-90, 판 6):** 실행기가 받은 적 없는 작업자 실행을 `not_started`로 닫아 자리를 푼다. 하나라도 맞지 않으면 지금대로 자리를 쥔 채 모름이다.
  - **송신 표식(`markStartDispatch({ runId, requestId, now })`):** 시작 봉투를 연결에 싣기 직전에 부른다. 이 장부 객체의 열기 ID와 함께 `start_dispatches`에 한 줄을 커밋하고 `{ ok: true, created }`를 낸다. 열기 ID는 `openLedger`가 장부 객체를 만들 때마다 `crypto.randomUUID()`로 새로 만든다(장부 ID·사본 ID처럼 장부가 스스로 만드는 식별이다. 부르는 쪽이 넘기게 하면 다시 연 객체가 앞 열기의 값을 쓸 수 있다). 같은 열기에서 같은 실행을 다시 적으면 그대로다(`created: false`, 처음 시각을 덮지 않는다). 그 실행의 시작 지시(`task_start`)의 요청 ID가 아니면 `unknown_instruction`, 없는 실행이면 `unknown_run`, 끝났거나(`finalized`·`not_started`) 종료가 확인된 실행이면 `transition_denied`다. 시작 봉투를 싣는 것은 새 일을 여는 일이라 쓰기 모드는 `start`다(못 씀·사본 보류·정지 기록 없음·정지·접수 닫힘이면 거절). 표는 트리거로 시작 지시를 가리키는 줄만 받고, 고치기·지우기·같은 (실행, 열기)의 교체를 막는다.
  - **표식의 뜻:** 표식은 "이 열기에서 그 시작을 실었을 수 있다"는 증거이지 실었다는 증거가 아니다. 표식을 커밋한 직후 실제로 싣기 전에 감독이 죽어도 표식은 남고, 다시 연 장부에서는 다른 열기의 표식이라 자동으로 닫지 않는다(`sent_by_other_open`, 손 닫기로 간다). 반대로 "표식이 없다"를 "한 번도 실리지 않았다"로 읽는 것은 아래 셋이 모두 맞을 때뿐이다: 싣는 쪽이 아래 조건을 지켰다, 그 시작이 판 6을 적용한 뒤에 낸 것이다(`starts_before_closure`에 없다), 그 실행이 사본의 경계 밖이다(사본에서 되살린 장부라면 사본 뒤에 만든 실행이다).
  - **싣는 쪽이 지킬 것(부르는 코드는 `src/supervisor/dispatch/send-gate.ts`의 `sendInstruction` 하나다):** 시작 봉투를 싣는 모든 길(배정·시작 박자, 재전송 박자)은 이 표식이 `ok`로 커밋된 뒤에만 싣고, 표식이 거절·실패하면 싣지 않는다. 그래야 위의 "표식 없음 = 한 번도 실리지 않음"이 선다. 어기면 실린 시작을 장부가 실리지 않은 것으로 읽고 닫을 수 있다.
  - **닫기(`closeUnreceivedRun({ runId, runs, answeredAt, receivedAt, now }, { sender })`):** `sender`는 검증된 전체 답(`hello`) 봉투의 낸 쪽, `runs`는 그 답의 `runs` 그대로(계약 v1의 실행 상태 항목, `applyExecutorAnswer`와 같은 꼴 검사), `answeredAt`은 그 봉투의 `issued_at`(실행기 시계, 모르면 `null`), `receivedAt`은 감독이 그 답을 받은 시각, `now`는 닫는 시각이다. 꼴이 틀리면 `LedgerInputError`다. **"그 답에 이 실행이 없다"는 부르는 쪽의 판단으로 받지 않고 답의 목록을 받아 장부가 직접 본다:** 부르는 쪽이 다른 답을 잘못 고르면 그 실행이 실린 답으로 닫을 수 있는데, 목록을 받으면 실린 답(`not_known`으로 실린 것 포함)으로는 닫히지 않는다. 그 목록이 전체 답인지는 장부가 가를 수 없다(부르는 쪽이 그 연결의 검증된 `hello`만 넘긴다). 성공 답은 `{ ok: true, run }`(`run.state`는 `not_started`)이다. 쓰기 모드는 `start`다(새 일을 여는 쪽과 같은 전제, 정지 중에는 닫지 않는다).
  - **조건(한 트랜잭션에서 위에서부터 보고, 처음 걸린 거절을 낸다. 거절이면 아무것도 적지 않는다):**

    | 조건 | 맞지 않을 때 |
    |---|---|
    | 장부가 건강하다, 사본 보류가 아니다, 정지 기록이 있고 정지가 아니다, 접수 허가가 있다 | `ledger_unwritable`, `snapshot_hold`, `stop_unknown`, `stopped`, `intake_closed` |
    | 실행이 있다 | `unknown_run` |
    | 작업자이고 `preparing`·`unknown_running`이고 종료 확인이 없다 | `transition_denied` |
    | 그 실행의 시작 지시가 정확히 하나다 | `unknown_instruction` |
    | 답을 낸 쪽이 그 실행의 지정 실행기와 정확히 같다 | `sender_mismatch` |
    | 답의 시각을 안다 | `answer_time_unknown` |
    | 답의 시각(실행기 시계) ≥ 시작 지시 줄의 발행 시각 + 30000ms(계약 v1의 `RUN_LEASE_MAX_MS`·`MESSAGE_TTL_MAX_MS` 가운데 큰 쪽, 정각 포함. `applyExecutorAnswer`의 이른 `not_known`과 같은 경계) | `answer_too_early` |
    | 답의 목록에 그 실행이 없다 | `run_in_answer` |
    | 그 실행의 영수증·보고(`deliveries`)가 0줄이다 | `receipt_seen` |
    | 양성 관측(`run_sightings`)이 0줄이다 | `run_sighted` |
    | 점유 관측(`slot_holds`)이 0줄이다 | `run_blocked` |
    | 판 6의 적용 기록이 있고, 그 실행의 시작이 `starts_before_closure`(판 6을 적용할 때 이미 있던 시작 지시)에 없고, 시작 지시의 발행 시각 ≥ 판 6의 적용 시각(`ledger_migrations.applied_at`, 같은 장부 시계) | `started_before_migration` |
    | 시작 지시에 고정된 예산(`instructions.budget_left`)이 있고 실행의 지금 남은 예산(`runs.budget_left`)과 같다(시작 뒤 `recordBudget`의 감액이 적히지 않았다) | `budget_reduced` |
    | 판 6을 적용할 때 이미 있던 사본 기록(`snapshots_before_closure`)이 없고, 사본 기록(`ledger_snapshots`)마다 경계(`snapshot_run_bounds`)가 있다. 판 6 전에 만든 사본의 기록은 판 6을 적용하는 트랜잭션에서 그 집합에 값으로 남고 뒤에도 경계를 얻지 못해(대조 전이어도) 그 장부에서는 이 조건이 맞지 않는다 | `snapshot_bound_unknown` |
    | 실행의 `queue_seq`가 모든 사본의 경계보다 크고, 실행의 생성 시각과 시작 지시의 발행 시각이 모두 사본 기록의 가장 늦은 `taken_at`보다 늦다(대조가 끝난 뒤에도) | `created_before_snapshot` |
    | 송신 표식이 없거나 모두 이 장부 객체의 열기 ID다 | `sent_by_other_open` |

    **판 이전의 시작과 사본 안의 실행은 시계와 무관한 값으로 가른다.** `starts_before_closure`와 `snapshots_before_closure`는 판 6을 적용한 트랜잭션에서만 채워져 그 뒤로 늘지 않고, 사본의 경계는 사본을 봉한 그림의 `queue_seq` 최댓값이다(`queue_seq`는 새 실행마다 최댓값 + 1이고 실행 줄은 지우거나 순번을 고칠 수 없어 뒤로 가지 않는다). 그래서 같은 밀리초에 낸 판 5의 시작, 시계가 뒤로 간 사본 안의 실행도 막힌다. 같은 두 행의 시각 비교(적용 시각, 사본 시각)는 판정의 근거가 아니라 **더 막기만 하는 보조**다: 빼면 값으로는 판 이후·사본 뒤인 실행까지 닫혀 지금보다 닫히는 경우가 늘어난다. 두 비교는 같은 밀리초를 다르게 다룬다:
    - **적용 시각:** 시작 발행 < 판 6의 적용 시각이면 막는다. 같은 밀리초는 받는다.
    - **사본 시각:** 실행 생성(`runs.created_at`, 접수 때 부르는 쪽이 넘긴 시각) ≤ 가장 늦은 사본 시각이거나 시작 발행(장부 시계) ≤ 그 시각이면 막는다. 같은 밀리초도 막는다. 그래서 **시계가 뒤로 가지 않은 장부에서도 사본과 같은 밀리초에 만들었거나 발행한 새 실행은 경계 밖이어도 닫지 않는다.** 그 시각은 고정 값이라 기다려도 풀리지 않고 지금처럼 자리를 쥔 채 손 닫기로 간다.
    **예산 감액을 막는 이유:** D-90으로 닫힌 실행의 예약은 0이라 그 예산이 같은 요청의 한도로 돌아온다("스케줄러가 쓰는 읽기"의 "요청 예산의 예약"). 시작 뒤에 감액이 적힌 실행(계측이 소비를 적은 실행)을 닫으면 쓴 예산까지 돌려주게 된다. 그래서 감액이 적힌 실행은 자동으로 닫지 않는다(실제 토큰 소비와 무관하게 닫는 쪽으로 틀린다). 대기 중에 줄인 예산은 시작 지시에 그대로 고정되므로 막지 않는다.

  - **닫으면:** `unreceived_closures`에 근거 줄(앞 상태, 답의 낸 쪽·시각·받은 시각, 열기 ID, 닫은 시각)을 넣고 같은 트랜잭션에서 `not_started`로 옮긴다. 자리가 풀려 같은 종류의 새 실행이 시작된다. 같은 실행 ID는 다시 시작하지 않는다(`startRun`은 `queued`에서만, `not_started`는 끝 상태). `unansweredInstructions()`에도 더 나오지 않고 수명 판단(`nextIntent`)은 `wait`다.
  - **누가 무엇을 확인하는가:**
    - **부르는 쪽이 보증하는 것:** 넘긴 `runs`가 그 실행기가 쥔 전부(그 연결의 검증된 `hello`)라는 것, `answeredAt`이 그 봉투의 서명된 `issued_at`이라는 것. 장부는 받은 목록이 전체 답인지, 진짜인지 가르지 못한다.
    - **코드(`closeUnreceivedRun`)가 확인하는 것:** 위 표의 조건 전부. 이 가운데 아래 SQL이 보지 않는 것은 코드만 본다: 받은 목록에 그 실행이 없음(세대를 불문하고 같은 ID, `not_known`으로 실린 것 포함), 시작 지시가 정확히 하나, 접수 허가, 열기 ID가 지금 장부 객체의 것, 장부가 건강함, 사본 보류가 아님, 정지 기록이 있고 정지가 아님.
    - **SQL(근거 표의 INSERT 트리거 `unreceived_closures_proven`)이 코드 없이도 막는 것:** 이미 근거가 있음, 작업자가 아님, 지금 상태가 근거 줄의 앞 상태가 아니거나 `preparing`·`unknown_running`이 아님, 종료 확인이 있음, 답을 낸 쪽이 지정 실행기가 아님, 영수증·보고·양성 관측·점유 관측이 한 줄이라도 있음, 시작 지시(`task_start`)가 없음, 답의 시각이 어느 시작 지시의 발행 + 30000보다 이름, 시작 지시의 예산과 지금 남은 예산이 다름(`IS NOT`이라 판 4 전의 빈 칸도 다름), 근거 줄의 열기가 아닌 열기의 표식이 있음, 그 실행의 시작이 `starts_before_closure`에 있음, 판 6 기록이 없거나 그보다 이른 발행, 판 6을 적용할 때 있던 사본 기록(`snapshots_before_closure`)이 있음, 경계 없는 사본 기록이 있음, 사본의 경계 이하의 순번, 사본 시각 이하의 생성·발행. 근거 줄에는 답의 목록이 없어 SQL은 "그 답에 이 실행이 없다"를 보지 않는다. 시작 지시의 개수도 보지 않는다. 그래서 코드의 검사가 빠져도 받은 흔적·판 이전의 시작·사본 안의 실행·감액이 있는 실행은 닫히지 않지만(`invariant_violation`), 원 SQL로 유효한 행 조건만 맞춘 근거 줄은 들어간다. 상태 트리거(`runs_not_started_needs_closure`)는 근거 줄 없이 `queued` 밖에서 `not_started`로 가는 모든 갱신을 막는다. 대기 실행의 취소(`queued → not_started`)는 그대로다. 근거 줄과 상태 갱신을 한 커밋으로 묶고 그 사이 다른 쓰기를 막는 것은 공개 연산의 `immediate` 트랜잭션이다.
  - **D-90의 글자보다 좁힌 것(자동으로 닫지 않고 지금대로 자리를 쥔다. 관리자 닫기 D-91로 간다):**
    - **다른 열기의 표식이 있는 실행:** 실은 뒤 감독이 다시 뜬 실행, 그리고 표식을 커밋한 직후 실제로 싣기 전에 감독이 죽은 실행(실제로는 실리지 않았어도)이다.
    - **사본의 경계 안의 실행, 경계를 모르는 사본 기록이 있는 장부의 모든 실행:** 사본에서 되살린 장부의 옛 실행은 영수증 0이 거짓일 수 있고, 전체 답은 실행기가 이미 끝낸 실행을 싣지 않는다. 판 6 전에 만든 사본에서 뜬 장부는 어느 실행이 사본에 있었는지 몰라 그 장부에서는 자동으로 닫지 않는다. 그 사본 기록은 판 6을 적용하는 트랜잭션에서 `snapshots_before_closure`에 값으로 남고, 경계 표의 트리거가 그 기록의 경계를 받지 않아 대조 전에 원 SQL로 경계를 넣어도 이 장벽은 사라지지 않는다.
    - **판 6을 적용할 때 이미 있던 시작:** 표식이 없던 판에서 실렸을 수 있다(적용과 같은 밀리초에 낸 시작 포함).
    - **시작 뒤 예산 감액이 적힌 실행:** 닫으면 예약이 0으로 돌아와 쓴 예산까지 같은 요청에 돌려준다(위 "예산 감액을 막는 이유").
    - **사본 시각 이하(같은 밀리초 포함)로 만들었거나 발행한 실행, 판 6의 적용 시각보다 이르게(같은 밀리초는 아님) 발행한 실행:** 값으로는 닫을 수 있어도 보조 시각 비교가 막는다(위 "판 이전의 시작과 사본 안의 실행"). 시계가 뒤로 간 장부만이 아니라, 시계가 정상이어도 사본과 같은 밀리초에 만들었거나 발행한 새 실행이 여기 든다. 기다려도 풀리지 않는다.

    장부 쪽 관측 공백(재시작·저장 실패·읽기 실패)을 걸친 실행을 빼는 장치가 앞의 셋이다: 같은 열기의 표식만 있고 장부가 건강하면 그 열기는 연 뒤로 관측을 잃은 적이 없다(쓰기·읽기가 한 번 실패하면 다시 열 때까지 `start` 모드가 거절된다).
  - **닫힌 실행에 늦게 온 것(닫기 근거가 있는 `not_started`에만. 대기에서 취소돼 `not_started`가 된 실행은 지금 동작 그대로다):**

    | 늦게 온 것 | 처리 |
    |---|---|
    | `receipt_accepted`·`receipt_stopped` | 받은 기록(`deliveries`)만 남기고 ack. 상태와 실행 줄의 증거 칸(`accepted_receipt_id`·`stop_receipt_id`)은 그대로 |
    | `receipt_started` | 받은 기록을 남기고 ack, 답에 `alarm: "closed_run_started"`를 싣고, `slot_holds`에 `why = 'ended_in_ledger'`, `holds_slot = 1`로 그 종류의 자리를 다시 막는다(같은 트랜잭션). 같은 영수증의 재전송(`duplicate`)에도 경보를 싣는다(감독은 둘 다 로그 `ledger_alert` 한 줄로 낸다, D-127). 막은 자리는 `clearSlotHold`로만 풀린다. 실행 줄에 연결된 첫 시작 영수증(`started_receipt_id`. D-90 닫기에는 없고 관리자 닫기에는 있을 수 있다)의 재전송만 경보 없이 다시 ack한다. 같은 시작 지시에 다른 ID로 닫기 전에 받은 두 번째 시작 영수증의 재전송은 `duplicate`와 ack에 경보를 싣는다(점유는 새로 적지 않는다): 그 영수증을 처음 받은 것이 닫기 전인지 뒤인지 장부의 칸으로 가를 수 없어(받은 순서의 칸이 없고 `received_at`·`closed_at`은 부르는 쪽의 시각) 경보가 빠지는 쪽보다 남는 쪽을 고른다 |
    | 결과·훅·세션 깨짐 보고 | 적고 ack하되 반영하지 않는다: 적자마자 마친 것으로 두고(`applied_at` = 받은 시각) 실행 줄은 그대로다. `pendingReports()`와 복원 3단계에 나오지 않는다 |

    대기에서 취소된 `not_started`는 지금처럼 `receipt_stopped`·결과 보고가 `transition_denied`(ack 없음), 접수 영수증은 `accepted_receipt_id`를 채우고 ack, 경보 없음이다. 위 표의 영수증 처리는 그 실행 자신의 세 영수증(`receipt_accepted`·`receipt_stopped`·`receipt_started`)에만 건다. 닫힌 작업자를 앞 실행으로 가리키는 세션 인수 영수증(`receipt_session_takeover`)은 원래 분기의 종류 검사에서 `invariant_violation`이고 아무것도 적지 않는다(닫히지 않은 작업자와 같다). 판을 그 앞에서 끊어 연 장부(시험용 길)에는 근거 표가 없어 늦은 영수증은 모두 지금 동작이다.
  - **다음 판(D-91 관리자 닫기)이 더하기만 해서 쓰는 꼴:** 원인별로 표를 나눴고(이 판은 D-90의 표 하나), 모든 칸이 `NOT NULL`이고, 늘어날 수 있는 집합(닫을 수 있는 앞 상태)은 CHECK가 아니라 트리거에 있다. 다음 판은 자기 근거 표(관리자 닫기)와 전이 한 줄(`('worker', 'stopping', 'not_started')`)을 더하고, `runs_not_started_needs_closure`를 `DROP` 뒤 "두 근거 표 가운데 하나에 같은 앞 상태의 줄이 있으면"으로 다시 `CREATE`한다. 이 판의 새 표 다섯(`start_dispatches`·`starts_before_closure`·`snapshots_before_closure`·`snapshot_run_bounds`·`unreceived_closures`)과 그 칸, 상태 트리거 밖의 트리거, 전이 두 줄은 바꾸지 않는다. 판 6을 올린 장부에 그 모양의 판 7(관리자 근거 표 하나: 확인 방법 두 가지 가운데 하나와 확인한 파드의 이름 칸, 전이 한 줄, 상태 트리거 다시 만들기)을 판 목록에 더해 열어 본 결과, 새 표들과 그 칸, 다른 트리거의 정의는 그대로이고 정의가 바뀐 판 6까지의 객체는 다시 만든 상태 트리거 하나였다. 근거 없는 `stopping → not_started`는 막히고, 목록 밖 방법·빈 파드 이름의 근거는 들어가지 않고, 관리자 근거 뒤에는 되었으며, D-90 닫기도 그대로 되었다. 늦은 영수증의 처리는 `ledger.ts`의 `#closedAfterStart` 한 자리에 그 표를 더하면 같이 쓴다. 관리자 닫기가 이 꼴을 어떻게 쓰는지는 아래 "관리자가 실패로 닫기(D-91)".
  - **이 판이 막지 못하는 것(막았다고 주장하지 않는다): 원 SQL로 넣은 소수 시각이 정수로 판정된다.**
    - **무엇이 일어나는가:** `unreceived_closures`의 정수 칸은 `STRICT` 표의 `INTEGER`라, 원 SQL로 넣은 TEXT·REAL을 SQLite가 트리거보다 먼저 정수로 바꾸고 트리거(`unreceived_closures_proven`)는 바뀐 뒤의 값을 본다. 1.8e12 언저리의 double 간격은 2^-12(약 0.000244)라서, **정수에서 약 0.000122ms(그 간격의 절반) 안쪽의 소수 시각은 그 정수가 되어 그 정수로 판정된다.** 그래서 `answer_issued_at`이 한도(시작 발행 + 30000)보다 그만큼 이른 값(예: 한도가 1800000030000일 때 TEXT `'1800000029999.9999'`·`'1800000029999.99988'`, SQL REAL 리터럴 `1800000029999.9999`)이어도 근거 줄이 한도 정각으로 들어가고, 실행은 `not_started`로 닫혀 자리가 풀린다. 보통 INSERT, `INSERT OR IGNORE`, `INSERT OR REPLACE` 모두 같다. 정수 꼴의 TEXT(`'1.80000003e12'`, 앞뒤 공백)와 정수 값의 REAL도 그 정수가 되지만 그 정수를 넣은 것과 결과가 같다. **그 밖의 소수(예: `'1800000029999.9998'`, REAL `1800000029999.5`)는 `STRICT` 형 오류로 막힌다.** 실제로 한도보다 이르게 닫히는 폭은 1마이크로초 미만이다.
    - **트리거로는 막지 못한다:** 트리거가 받는 값이 이미 `integer`라서 이 표에 `typeof` 검사를 더해도 원래 형을 되찾지 못한다. 막으려면 칸을 `ANY`로 둔 표를 다시 만들어야 한다.
    - **공개 연산은 정수 시각만 받는다:** `closeUnreceivedRun`의 `answeredAt`은 TEXT를 `LedgerInputError`로 거절한다. 다만 **호출자 쪽 JS 숫자의 반올림은 어느 판도 막지 못한다:** JS 숫자 `1800000029999.9999`는 넘기기 전에 이미 정수 `1800000030000`이라 닫힌다(봉투의 JSON에서 읽은 값도 같다).
    - **다른 칸에는 새 길이 없다:** 판 1~6의 다른 정수 칸도 같은 반올림을 하지만, 트리거가 저장될 정수와 같은 값을 보므로 반올림된 입력이 지나는 검사는 그 정수를 직접 넣어도 지나 결과가 같다. 이 표의 `answer_received_at`·`closed_at`은 트리거가 비교하지 않고 칸의 CHECK만 본다. `snapshot_run_bounds.queue_seq_bound`는 실측하지 않았다(등호 비교라 지나는 입력은 저장값이 정확히 `MAX(queue_seq)`인 경우뿐이다).
    - **판 7은 막았다:** `operator_closures`는 같은 문제를 세 정수 칸의 `ANY`와 트리거 첫 줄의 `typeof` 검사로 막는다(아래 "관리자가 실패로 닫기"의 "SQL이 코드 없이도 막는 것"). **이 판의 표는 다시 만들지 않는다(관리자 결정 D-99).** 뒤에 다른 까닭으로 이 표를 다시 만들게 되면 판 7의 꼴로 바꿀지를 그때 정한다.
- **관리자가 실패로 닫기(D-91·D-93·D-94·D-96·D-97, 판 7, `closeRunByOperator({ runId, checkedBy, podName, podStartedAt, now })`):** **새 작업자 파드가 닫을 수 있게 되는 시각 뒤에 떴고, 그 사실을 근거에 남긴 뒤에만** 종료가 확인되지 않은 작업자 실행을 "실패로 끝남"으로 닫아 그 실행이 쥔 자리를 놓는다. 상태는 `not_started`(자리를 놓는 끝 상태)이고 근거 줄(`operator_closures`)이 관리자 닫기를 말한다. 새 상태를 두지 않은 이유: `runs.state`의 CHECK는 표를 다시 만들어야 바뀌고, `failed_stopped`는 받은 종료 영수증이 있어야 하며 그 뒤에도 자리를 쥔다.
  - **실행이 놓은 자리와 쓸 수 있는 자리는 따로다:** 성공은 그 실행이 쥔 작업자 자리를 놓았다는 뜻이다. 같은 종류의 점유 관측(`slot_holds`의 `holds_slot = 1`, 복원 2단계나 닫힌 실행의 늦은 시작 영수증이 적은 것)이 따로 있으면 닫기가 성공해도 작업자 자리는 막힌 채다(`slotFree("worker")`가 `false`). 그 관측은 닫기가 풀지 않고, 실행기·실행·세대·관측 번호를 대조하는 지금의 절차(`clearSlotHold`)로 따로 푼다.
  - **입력:** `checkedBy`는 확인 방법 하나(`pod_replaced`: 작업자 파드가 바뀌었다, D-96)이고 그 밖의 값(`process_absent` 포함)은 목록 밖이다. `podName`은 확인한 파드(바꾼 뒤의 작업자 파드)의 이름(Kubernetes 이름 규칙: 소문자·숫자·`-`·`.`, 라벨마다 영숫자로 시작하고 끝남, 253자 이하), `podStartedAt`은 그 파드가 뜬 시각(Unix epoch 밀리초, 클러스터의 시계, D-97), `now`는 닫는 시각(감독의 시계)이다. 꼴이 틀리거나 모르는 칸이 있거나 `podStartedAt`이 `now`보다 늦으면 트랜잭션을 열기 전에 `LedgerInputError`이고 아무것도 쓰지 않는다. 장부는 파드의 이름과 시각을 스스로 확인하지 못한다: 사람·명령이 넘긴 값의 기록이다(D-93과 같다). 자유 메모 칸과 "누가" 칸은 없다(장부는 원문을 넣지 않고, 관리 진입점이 넘기는 이름은 검증되지 않는다). 확인 방법의 목록은 트리거(`operator_closures_proven`)와 `OPERATOR_CHECKS`에 있어 뒤의 판이 더할 수 있다(칸 `checked_by`는 그대로 둔다).
  - **확인 방법이 파드 교체 하나인 까닭(D-96):** 관리자는 닫기 전에 작업자 파드를 지워 새로 띄운다. 옛 실행기 프로세스가 끝나므로, 그 실행기가 쥐고 있던 시작 권한(임대)은 장부가 그 갱신을 알든 모르든(사본에서 되살린 장부) 함께 사라지고, 마지막 임대 검사를 이미 통과한 옛 실행기가 뒤늦게 띄우는 일도 없다. "프로세스가 없다"만으로는 이 둘을 막지 못한다: 실행기가 살아 있으면 사본이 모르는 갱신의 임대가 남아 있을 수 있고, 마지막 검사와 프로세스 생성 사이에는 감독과의 상호 배제도 지연의 상한도 없다. **장부는 파드가 바뀌었는지 확인하지 못한다:** 근거 줄은 사람이 했다는 기록이다(D-93).
  - **받는 실행:** 작업자이고 `unknown_running`·`stopping`이며 종료 확인(`stop_receipt_id`)이 없는 실행. 영수증·관측·표식·사본·예산은 보지 않으므로 D-90이 좁혀 닫지 않는 실행(위 "D-90의 글자보다 좁힌 것")도 이 상태면 닫힌다. **접수 영수증이 없는 실행도 닫는다(D-94):** D-91의 글자(실행기가 받았다고 알린 실행)보다 넓고, D-90이 자동으로 닫을 수 있는 실행도 포함한다. 관리자가 닫으면 늘 실패로 기록되고(아래 "보이는 단계는 실패") 시작 예산 전부를 예약으로 남긴다(아래 "요청 예산"). 그래서 같은 실행이라도 **어느 닫기가 먼저 불렸느냐에 따라 본체가 보는 단계(`not_started`·`failed_stopped`)와 같은 입력의 다음 배정(같은 요청의 남은 몫을 넘는 예산의 시작·보류)이 다르다.** 두 닫기는 서로를 막아 먼저 된 쪽이 남는다. 좁히지 않은 이유: 실행기가 영영 답하지 않으면 D-90도 닫지 못해 그 자리를 풀 방법이 없다. `preparing`·`running`은 믿는 임대가 있을 수 있어 받지 않는다: 끊김·답으로 `unknown_running`이 된 뒤 닫는다.
  - **닫을 수 있게 되는 시각:** 그 실행의 `task_start`·`run_renew` 지시의 발행 시각 최댓값 + `max(RUN_LEASE_MAX_MS, MESSAGE_TTL_MAX_MS)`(30000) + `CLOCK_SKEW_MS`(1000) = **최댓값 + 31000ms**(정각 포함). 그 실행의 `task_start` 지시가 없거나(갱신 한 줄이나 세션 시작 한 줄만 있어도), `session_start` 지시가 있거나, `now`가 이 시각 전이면 `start_may_launch`다. **`now`가 이 시각 전이면 같은 파드로는 기다려도 닫히지 않는다:** 공개 입력은 `podStartedAt ≤ now`를 먼저 요구하므로 그 파드도 이 시각 전에 떴다. **이력이 맞으면 한도까지 기다린 뒤 파드를 교체하고, 새 파드가 뜬 시각을 다시 읽어 닫는다.** `task_start`가 없거나 `session_start`가 섞인 이력은 지시 줄이 바뀌지 않으므로 기다리거나 파드를 바꿔도 같은 답이다. **`podStartedAt`이 이 시각 전이면 `pod_started_too_early`(D-97)**: 새 파드가 그 시작을 받을 수 있었으므로 관리자는 파드를 한 번 더 바꾼다. 두 이름은 거절 순서대로 나온다: 이른 파드로 한도 전에 부르면 `start_may_launch`이고, 같은 파드로 한도 뒤에 다시 부르면 `pod_started_too_early`다. 그래서 `start_may_launch` 하나로는 시간이 모자란지, 이력이 닫을 수 없는지, 파드도 너무 일렀는지 가를 수 없다: 그 실행의 지시 이력과 파드가 뜬 시각을 따로 확인한다. 원 SQL에서는 둘 다 트리거가 막고(이름 하나 `operator_closure_unproven`), `pod_started_at ≤ closed_at`도 본다.
    - **이 시각이 막는 것: 새 파드의 실행기가 감독이 다시 보낸 시작을 받아 띄우는 길.** 파드를 바꿔도 감독은 미응답 시작을 새 실행기에 다시 보낼 수 있다. 다시 보내도 장부의 발행 시각을 그대로 싣고 발행 + 19000ms까지만 봉한다(`src/supervisor/dispatch/resend.ts`의 `START_LAST_SEAL_MS`). 실행기는 봉투의 시한(발행 + `MESSAGE_TTL_MAX_MS`) 뒤로는 시작을 받지 않고(`src/contract/v1/envelope.ts`의 시한 검사), 발행 + `RUN_LEASE_MAX_MS`부터는(정각 포함) 준비·자격·띄우기 직전의 검사에서 멈춘다(`src/executor/worker.ts`의 `launchBlocked`). 띄우기 전(`preparing`)에 받은 갱신은 임대 끝을 그 갱신의 발행 + `RUN_LEASE_MAX_MS`까지 늘릴 수 있다(실행기의 `onRenew`, 계약의 `parseRunRenew`). 그래서 실행기 시계로 발행 최댓값 + 30000부터 받기와 그 검사가 막히고, 시계 오차 `CLOCK_SKEW_MS`를 더한다. **새 파드의 실행기는 파드가 뜬 뒤에 시작하므로 무엇이든 파드가 뜬 시각 뒤에 받는다.** 그 시각이 한도 뒤면 그 실행의 시작은 이미 시한이 지나 새 파드는 그것을 받지도 띄우지도 못한다. 갱신은 그 실행을 이미 받은 실행기에만 늘릴 임대가 있어 새 파드에는 `task_start`의 발행만으로 족하지만, 같은 식(갱신 포함)을 써서 닫는 쪽으로만 틀린다. 그래서 사본에서 되살린 장부가 원본의 갱신을 몰라도, 한도 뒤에 뜬 파드에는 그 갱신이 늘릴 임대가 없다. `closed_at`의 조건은 그대로 두고(`pod_started_at ≤ closed_at`이라 함께 맞는다), D-90(`answer_too_early`)은 같은 30000을 쓰지만 실행기 시계인 답의 시각과 바로 비교하므로 시계 오차를 더하지 않고, 받은 적 없는 실행에는 갱신이 닿아도 늘릴 임대가 없어 갱신을 보지 않는다.
    - **시계의 전제:** `podStartedAt`은 파드가 뜬 시각을 적은 클러스터(쿠버네티스)의 시계, 발행 시각과 `now`는 감독의 시계, 시작을 받아 검사하는 것은 새 파드의 실행기의 시계다. **비교할 것은 파드의 기록 시각과 그 뒤에 실행기가 시작을 검사하는 시각의 차이다:** 실행기가 시작을 검사하는 시각(실행기 시계)이 파드의 기록 시각 − 1000ms(`CLOCK_SKEW_MS`) 이상이면, `pod_started_at ≥ 발행 + 31000`에서 그 검사 시각 ≥ 발행 + 30000(봉투의 시한, 임대 상한)이 따라와 그 실행기는 시작을 받지도 띄우지도 못한다. 실행기는 봉투의 발행 시각 값과 자기 시계를 바로 비교하므로 감독의 시계는 이 비교에 들지 않는다. 전제는 실행기의 시계가 클러스터의 시계보다 1000ms 넘게 뒤처지지 않고, 공통 시계가 파드가 뜬 뒤 1000ms 넘게 뒤로 가지 않는다는 것이다(홈랩은 한 머신이라 시계가 하나다). 감독이 다시 보낼지(발행 + 19000ms까지만 봉하는 재전송 한도)는 감독의 시계로 따로 정해지고, 이 조건은 그것에 기대지 않는다. 쿠버네티스의 시각은 초 단위라 부르는 쪽이 내림해 넘기면 실제보다 이르게 적혀 거절 쪽으로 간다(명령이 어느 시각을 읽는지는 뒤 조각이 정한다).
    - **`session_start`가 섞인 작업자 실행은 닫지 않는다:** 작업자 실행의 정상 이력에는 없다(`startRun`은 `task_start`만 적고, `startSession`은 어떤 입력에도 지시를 적지 않는다: `session_start_closed`). 원 SQL로 섞이면 그 시작이 무엇을 언제까지 띄울 수 있는지 위의 식이 세지 않는다. 그래서 시각과 상관없이 `start_may_launch`(원 SQL은 트리거)다.
    - **새 파드의 실행기가 저장소에서 그 실행을 되살려 띄우는 길은 없다:** 다시 뜬 실행기의 복원(`worker.ts`의 `recover`·`reconcile`)은 사건·상태를 맞추고 남은 프로세스를 정리할 뿐 띄우지 않고, 기록이 이미 있는 실행의 시작 지시는 사건만 다시 보낸다(`onStart`).
    - **이 판이 막지 못하는 것(막았다고 주장하지 않는다):** (ㄱ) **사람·명령이 넘긴 값이 틀리면 닫힌다:** 파드를 바꾸지 않았으면 사본이 모르는 갱신의 임대가 남았거나 마지막 임대 검사를 지난 옛 실행기가 띄우는 중일 수 있고, 넘긴 파드의 시각이 그 파드의 실행기가 뜬 시각보다 늦으면 새 파드가 그 시작을 받았을 수 있다. (ㄴ) **시계 전제가 깨지면**(새 파드의 실행기가 시작을 검사하는 시각이 파드의 기록 시각 − 1000ms보다 이르면: 실행기의 시계가 클러스터의 시계보다 1000ms 넘게 뒤처지거나, 공통 시계가 파드가 뜬 뒤 그만큼 뒤로 가면) 한도 뒤로 적힌 새 파드의 실행기도 감독이 그때 다시 보낸 시작을 받아 띄울 수 있다. 이때 장부가 남기는 신호는 **닫은 뒤 새 시작 영수증 ID를 처음 받을 때마다** 생기는 경보와 자리 다시 막기다(아래 "닫은 뒤", 판 6과 같은 처리). 같은 실행에 서로 다른 새 ID가 둘 오면 둘 다 경보와 점유를 내고(점유는 같은 실행기·실행·세대의 줄을 새 관측 번호로 바꿔 적는다), 그 새 ID의 재전송은 경보만 다시 싣고 점유를 새로 적지 않는다. 닫기 전에 받아 실행 줄에 연결된 첫 시작 영수증의 재전송은 경보·점유가 없고, 닫기 전에 받은 다른 시작 영수증의 재전송은 경보만 있고 점유는 없다.
    - **장부가 보는 것은 넘겨받은 두 시각뿐이다:** 사람이 언제 파드를 바꾸고 확인했는지, 넘긴 파드의 시각이 맞는지 모른다(부르는 쪽이 지킬 조건, 아래 "관리자 닫기를 부르는 쪽").
  - **거절(순서대로):** 장부 실패·닫힘 `ledger_unwritable` → 없는 실행 `unknown_run` → 세션 실행 `run_not_worker` → 끝 상태(`finalized`·`not_started`, D-90으로 닫힌 실행 포함) `run_ended` → 종료 확인 있음(`checking`·`ready_result`·`failed_stopped`·`cleanup_pending`) `stop_confirmed` → 그 밖의 앞 상태(`queued`·`preparing`·`running`, 판 7 전의 장부) `transition_denied` → 정지 기록 없음 `stop_unknown` → `task_start` 지시가 없거나 `session_start` 지시가 있거나 `now`가 닫을 수 있게 되는 시각 전 `start_may_launch` → `podStartedAt`이 그 시각 전 `pod_started_too_early`. 거절이면 아무것도 쓰지 않고 상태와 자리는 그대로다. `start_may_launch`는 세 원인을 한 이름으로 낸다: 시간이 모자란 경우는 그 호출의 파드도 한도 전에 떴으므로 같은 파드로는 기다려도 풀리지 않고, 이력이 맞으면 한도까지 기다린 뒤 파드를 교체하고 새 파드가 뜬 시각을 다시 읽어 닫는다. 지시 이력 때문인 경우는 기다리거나 파드를 바꿔도 풀리지 않는다(위 "닫을 수 있게 되는 시각").
  - **한 문장:** 근거 줄(실행, 앞 상태, 확인 방법, 파드 이름, 그 파드가 뜬 시각, 그때의 정지 세대, 닫은 시각)을 넣는 SQL 문장 하나가 실행 줄을 `not_started`로, `updated_at`을 닫은 시각으로 바꾼다(`operator_closures_close_run`). 닫는 전이가 거절되면 근거 줄도 들어가지 않고, 근거만 있고 상태는 그대로인 장부는 원 SQL로도 만들 수 없다. 같은 문장에서 같은 트리거가 그 실행의 미반영 보고(`deliveries`의 `applied_at`이 빈 결과·훅·세션 깨짐 보고)를 반영하지 않고 마친다(`applied_at` = 닫은 시각): 닫힌 뒤 처음 온 보고를 받은 자리에서 마치는 것과 같은 끝이라 `pendingReports()`와 복원 3단계에 남지 않고, 같은 보고의 재전송은 `duplicate`와 ack다. 공개 연산으로 닫든 원 SQL 근거 한 문장으로 닫든 같고, 다른 실행의 보고는 건드리지 않는다. D-90 닫기에는 이 일이 없다: 영수증·보고가 한 줄이라도 있으면 닫지 않는다(`receipt_seen`, 트리거의 `deliveries` 검사). 성공 답은 `{ ok: true, run, closure }`이고, `operatorClosure(runId)`가 근거 줄을 읽는다(없으면 `null`).
  - **쓰기 모드 `new`(풀기 `releaseStop`과 같은 묶음):** 장부가 한 번이라도 실패했으면 거절한다. 사본 보류·정지·접수 닫힘은 막지 않는다: 관리자는 사본을 대조하는 주체이고, 닫기는 자리만 풀며 새 시작은 여전히 시작의 전제를 지난다.
  - **SQL이 코드 없이도 막는 것(`operator_closures_proven`):** 이미 근거가 있음(`INSERT OR REPLACE` 포함), D-90 근거가 있음, 앞 상태가 `unknown_running`·`stopping`이 아님, 방법이 목록 밖, 파드 이름이 규칙 밖(문자열 안의 U+0000 포함: `length`·`GLOB`은 U+0000에서 읽기를 멈춰 `instr(이름, char(0))`로 따로 본다), 작업자가 아니거나 지금 상태가 앞 상태가 아니거나 종료 확인이 있음, 정지 기록이 없거나 정지 세대가 그 기록과 같지 않음(입력이 NULL이면 같지 않다), 그 실행의 `task_start` 지시가 없음, 그 실행의 `session_start` 지시가 있음, 닫은 시각이나 파드가 뜬 시각이 `task_start`·`run_renew` 지시의 발행 최댓값 + 31000 전, 파드가 뜬 시각이 닫은 시각 뒤. 값의 검사는 `(조건) IS NOT 1`·`IS NOT 0`으로, 다른 표와의 대조는 `=`로 맞는 줄의 `NOT EXISTS`로 써서 NULL이 섞이거나 줄이 없으면 막는 쪽이다(두 쪽이 모두 NULL이면 거짓이 되는 `IS NOT` 대조는 쓰지 않는다). 그래서 NULL이 섞인 입력은 세 INSERT 방식(보통, `OR REPLACE`, `OR IGNORE`) 모두 트리거가 거절하고, `OR IGNORE`가 칸의 `NOT NULL`에서 예외 없이 0줄로 끝나는 길에 닿지 않는다. **세 정수 칸(`pod_started_at`·`stop_generation`·`closed_at`)은 `ANY`로 받고 트리거가 `typeof`가 `'integer'`인지 맨 먼저 본다:** `INTEGER` 칸이면 SQLite가 트리거보다 먼저 정수로 바꿀 수 있는 값을 바꿔 넘겨, 한도보다 0.0001ms 이른 `'1800000030999.9999'`가 한도 정각으로, 범위 위의 `'9007199254740991.1'`이 범위 끝으로 반올림되어 닫힌다(`'1800000031000'`·`'1.800000031e12'`·앞뒤 공백의 TEXT와 정수 값의 REAL도 정수가 된다). `ANY` 칸은 들어온 형을 그대로 트리거에 넘기므로 정수가 아닌 값(TEXT·REAL·BLOB)은 세 방식 모두 트리거가 거절한다. 칸의 CHECK도 `typeof = 'integer'`와 범위를 보지만 BEFORE 트리거 뒤에 돈다(`NOT NULL`도 같다). 공개 연산은 안전 정수만 넘기므로 결과가 같다. 남는 길 하나: `closed_at`이 칸의 범위(1–9007199254740991) 위이면(`pod_started_at`은 `closed_at` 이하여야 트리거를 지나므로 그때만 그 위일 수 있다) 트리거를 지나 칸의 CHECK가 막는데, `OR IGNORE`는 이것을 예외 없이 0줄로 끝낸다(닫힌 것은 없다). 원 SQL 호출자는 예외만이 아니라 변경 수를 본다. 근거와 전이가 한 문장이라 그 사이에 종료 영수증이 끼어들 틈이 없다. 근거 줄의 고침·지움은 `operator_closures_fixed`·`operator_closures_permanent`가 막고, 관리자 근거가 있는 실행의 D-90 근거는 `unreceived_closures_exclusive`가 막는다(한 실행에 근거 하나). 상태 트리거 `runs_not_started_needs_closure`는 두 근거 표 가운데 하나에 같은 앞 상태의 줄이 있을 때만 `queued` 밖의 `not_started`를 허락한다.
  - **보이는 단계는 실패:** 작업 부탁의 단계(`TOOL_REQUEST_RUN_PHASES`를 쓰는 읽기)는 관리자가 닫은 실행에 `failed_stopped`(`OPERATOR_CLOSED_PHASE`)를 낸다. `not_started`를 그대로 보이면 본체가 "시작 안 함"으로 읽고 이미 일부 돈 일을 다시 맡길 수 있다. D-90으로 닫은 실행과 대기에서 취소된 실행은 `not_started` 그대로다. `getRun`·`listRuns`의 `state`는 장부 상태 그대로 `not_started`다.
  - **요청 예산:** 관리자가 닫은 실행은 이미 돌았을 수 있어 `listRuns()`의 `reservedBudget`이 시작 지시에 고정된 예산 전부다(시작 뒤 감액과 무관, "스케줄러가 쓰는 읽기"의 "요청 예산의 예약"). 그래서 같은 요청의 다음 작업이 그만큼 덜 받고, 같은 요청의 남은 몫을 넘는 예산이면 보류된다. D-94의 "더 큰 예산으로 다시 맡기는 것은 보류"는 이 규칙에서 늘 참이 아니다: 닫은 실행의 예산보다 커도 남은 몫 안이면 시작한다. `listRuns()`는 `not_started` 줄마다 `closedByOperator`(관리자 근거 줄이 있는가)도 싣는다(다른 상태의 줄과 다른 읽기에는 없다). 스케줄러의 `budgetBar`(`src/supervisor/scheduler/queue.ts`)는 `queued`와 이 칸이 `false`인 `not_started` 밖의 작업자 줄의 예약이 0이면 장부와 어긋난 읽기로 보고 보류한다(`budget_unknown`). 배정 순환(`src/supervisor/dispatch/assign-loop.ts`)은 두 칸을 그대로 넘긴다.
  - **닫은 뒤:** 같은 실행 ID는 다시 시작하지 않는다(`startRun`은 `queued`에서만). 늦은 영수증·보고는 위 "닫힌 실행에 늦게 온 것"과 같다. 닫은 뒤 새 시작 영수증 ID를 처음 받을 때마다 경보와 자리 다시 막기다(닫은 실행의 시작 영수증이 도착했다: 다시 확인해야 한다. 서로 다른 새 ID가 둘 오면 둘 다). 실행 줄에 연결된 첫 시작 영수증의 재전송은 경보 없이 ack한다. 닫기 전에 다른 ID로 받은 두 번째 시작 영수증의 재전송은 경보를 싣는다(위 표의 `receipt_started`). 닫은 실행의 시작은 `unansweredInstructions()`에 더 나오지 않아 다시 나가지 않는다.
- **슬롯:** 작업자 하나, 세션 하나(부분 유일 인덱스). `queued`·`finalized`·`not_started` 밖은 모두 자리를 쥔다. 그래서 `unknown_running`·`cleanup_pending`이 있으면 새 실행은 `slot_busy`다. 슬롯을 막는 관측(`holds_slot`)이 있는 종류도 `slot_busy`다.
- **점유 관측:** "이 슬롯이 사용 중"과 "이 실행 ID는 이미 쓰였다"를 따로 둔다. 끝났다고 답한 대기 줄과 장부 밖 실행은 슬롯을 막지 않고 그 실행 ID만 막으므로 관계없는 다른 일은 시작한다. `clearSlotHold({ executorId, runId, runGeneration, observation })`은 확인한 그 세대와 번호의 줄의 **슬롯만 돌려준다.** 줄은 남고 그 실행 ID는 영영 시작하지 못한다(`run_blocked`, 나중에 같은 ID를 접수해도 같다). 다시 할 일은 새 실행 ID를 받는다. 옛 세대의 종료 확인이나 다시 관측되기 전의 확인은 `reference_mismatch`이고 지금의 차단은 그대로다. `slotHolds()`는 슬롯을 막고 있는 관측만 낸다. 자동으로 푸는 경로는 없다.
- **정지:** 0도 줄로 적는다. 낮은 세대로 덮지 않는다(코드와 트리거 둘 다, 트리거는 UPDATE·UPSERT·INSERT OR REPLACE·DELETE 모두). `applyStop`은 합치기다: 이미 정지면 세대가 높아도 정지로 남고, 확인 단계를 생략하면 같은 세대에서는 이미 적은 단계를 남긴다(새 세대는 `none`). 일반 기록으로는 정지가 풀리지 않는다. 푸는 연산은 관리자 풀기의 `releaseStop({ generation })` 하나이고 같은 세대만 푼다(권위의 더 높은 해제는 `mergeStop`이 사실로 적지만 접수는 복원을 다시 마칠 때까지 닫혀 있다).
- **지시의 정지 세대:** 종료(`recordStopInstruction`)·확정(`recordFinalizeInstruction`)·갱신 지시도 장부의 지금 정지 세대와 같아야 적힌다(`stop_generation_mismatch`, 기록이 없으면 `stop_unknown`). 종료·확정은 정지 중에도, 접수가 닫혀도, 장부가 실패한 뒤에도 시도한다. 기록이 실패해도 호출자는 최선 노력의 종료를 보낼 수 있지만 그것은 "지금 세대로 발급하도록 기록한 지시"가 아니다.
- **지시의 본문 칸:** 지시 줄은 같은 트랜잭션의 같은 INSERT에서 본문을 다시 만들 칸과 함께 적힌다. `startRun`은 그때의 남은 예산(`budget_left`, 본문 `budget_tokens`)을, `recordStopInstruction`은 넘긴 `reason`을, 이은 부탁의 `cancelToolRequest`는 `requested`를, `recordFinalizeInstruction`은 넘긴 `outcome`·`resultDigest`·`storedAt`을 적는다. 종료의 `reason`과 확정의 세 칸은 넘기지 않아도 지시는 적히지만 그 지시는 다시 만들 수 없음으로 남는다(빼고 부르던 기존 호출 그대로). 넘긴 값이 그 동작의 계약 목록 밖이거나, 확정의 세 칸이 일부만 있거나, `succeeded`와 결과 digest의 있고 없음이 어긋나거나, 결과 digest가 계약의 꼴(소문자 16진수 64자리)이 아니면 적지 않고 `LedgerInputError`다. 값의 형식은 이 공개 쓰기만 검사하고 판 4 이관의 CHECK는 칸의 조합만 본다. 확정의 `resultDigest`가 실행 줄의 `result_digest`와 같은지는 장부가 보지 않는다.
- **예산:** 남은 예산은 늘지 않는다(트리거만 비교한다).
- **보고:** `recordReport(input, from)`도 지정 실행기와 세대를 본다. 결과 보고는 감독이 결과를 먼저 저장한 자리(`storedRef`)와 결과 digest를, 훅·세션 깨짐 보고는 업무를 잇는 구조화 칸(`signal`)을 함께 커밋한 뒤에만 ack를 준다. 원문 로그나 모델 출력은 받지 않는다. `markResult`로 판정하면 그 실행의 미반영 결과 보고는 모두 닫힌다: 같은 digest는 반영이고, 다른 digest는 `receipt_conflicts`에 남긴다. 판정이 끝난 실행에 늦게 온 결과 보고는 ack 전에 갈린다: 같은 결과면 적자마자 마치고, 다른 결과면 충돌을 남기고 `receipt_conflict`, 결과가 없다고 판정했거나 시작하지 않은 실행이면 적지 않고 `transition_denied`다(예외: 닫기 근거가 있는 `not_started` 실행의 보고는 적자마자 마친다. "받은 적 없는 실행의 닫기". 거절된 보고는 ack가 없어 실행기가 다시 보낸다. 같은 id·같은 두 digest의 충돌은 몇 번 다시 와도 한 줄이다). 판정 전에 받아 남은 보고는 `markResult({ …, reportId })`가 상태를 되돌리지 않고 그 보고만 마친다. 결과 밖의 보고는 `settleReport`. 반영하지 않은 보고는 `pendingReports()`와 복원 3단계에 남는다.
- **게시:** 같은 작업 ID·같은 후보·같은 실행이면 재시도로 성공(`created: false`), 다르면 `publication_conflict`이고 기존 연결은 그대로다. 확정된 게시는 키·후보·실행·상태·결과가 바뀌지 않는다(UPDATE·교체·삭제·다른 줄의 키 변경 모두 트리거). 갱신 시각만 바뀐다.
- **세션 증거(D-50·D-51):** 이 PR은 세션 증거의 영속 저장과 읽기까지다. **교체에 따른 시작·자격 반환은 세션 계약 작업이 만든다.** 아래 "세션 증거" 절에 받는 것, 닫은 것, 그 작업이 지킬 조건이 있다.
- **인계 참조:** `handoffRef`는 저장소가 낸 불투명 ID 꼴(`<저장소 이름>/<UUID>`)만 받고 `handoffDigest`와 함께 있거나 함께 없다. 인계 저장소의 실제 ID 꼴이 설계에 없어 장부가 받을 수 있는 가장 좁은 꼴로 정했다.
- **못 씀:** 쓰기나 읽기가 한 번 실패하면 다시 열 때까지 "쓸 수 없음"이다. 새 업무와 규칙 확인·풀기는 `ledger_unwritable`. 정지·종료·영수증·nonce의 기록은 계속 시도한다. 읽기 실패는 `{ known: false }`이고 `runGeneration`과 nonce 소비는 던진다(장부 밖이나 재사용으로 바꾸지 않는다). "모름"은 그 읽기가 실패했을 때다. 실패한 뒤에도 성공한 읽기는 값을 준다(새 업무는 위 1로 닫혀 있다).

## 스케줄러가 쓰는 읽기

스케줄러의 판단(`src/supervisor/scheduler/`의 `planNext`·`nextIntent`)은 상태를 갖지 않고 장부에서 읽은 것을 인자로 받는다. 그 입력은 공개 읽기 `queueView`·`listRuns`·`slotHolds`와 아래 셋으로 조립한다. 셋 다 장부를 바꾸지 않고, 원문·원문 참조·자격 값을 싣지 않는다.

| 공개 함수 | 돌려주는 것 | 쓰는 곳 |
|---|---|---|
| `listInputs()` | `Read<InputEntry[]>`. 접수한 입력 전부를 순번대로: `requestId`, `seq`, `source`(접수 때 받은 출처 이름 그대로), `receivedAt`, `expiresAt`(원문 만료), `cancelled`. 처리 위치(`processedSeq`)를 지난 입력도 낸다 | `planNext`의 입력(`origin`·`receivedAt`·`expiresAt`·`cancelled`), 시작한 실행의 `cancelRequested` |
| `instructionTimes(runId)` | `Read<InstructionTimes \| null>`. 없는 실행이면 `null`. `lease`(판단이 살아 있는 임대로 쓰는 값: 임대를 준 지시의 `issuedAt`과 장부가 믿는 임대 끝 `expiresAt`), `renewIssued`(발급 기록: `issuedAt`은 기록된 갱신 발행 시각의 최댓값, `leaseUntil`은 아래 "발급 기록"의 검사를 통과한 마지막 발급의 끝이고 그 밖에는 모름. 판단에 넘기지 않는다), `lastStopAt`(`task_cancel`·`session_stop`의 기록된 발행 시각 최댓값), `lastFinalizeAt`(`result_finalize`의 기록된 발행 시각 최댓값) | `nextIntent`의 `lease`·`lastInstructionAt` |
| `settledResult(runId)` | `Read<SettledResult \| null>`. 실행 줄에 결과 digest가 있고, 그 실행의 결과 보고 가운데 반영됐고(`applied_at`) 저장 자리(`storedRef`)가 있고 digest가 실행 줄의 `result_digest`와 같은 것이 있을 때만 `{ runId, resultDigest, storedRef, storedAt }`, 아니면(없는 실행, 보고 없음, 반영 전, digest 다름) `null`. 같은 결과의 보고가 둘이면 먼저 적은 것이고, `storedAt`은 그 보고의 `deliveries.received_at`이다: 결과 보고 처리기가 보관소와 장부에 함께 넘긴 시각이라, 첫 전달이면 보관소 머리의 `storedAt`과 같고 장부가 거절·모름으로 답해 같은 보고가 다시 오면 보관소의 값보다 늦다. 상태는 보지 않는다. 있는 칸만 읽어 판 번호는 그대로다 | 수명 박자의 `resultSettled`와 확정 지시의 `result_digest`·`stored_at`(`src/supervisor/dispatch/life-loop.md` "확정") |

- **요청 예산의 예약(`listRuns`의 `reservedBudget`, D-105·D-106 후보):** 한 요청(입력 ID)의 작업자 실행들이 시작할 때 잡은 예산의 합은 출처(관리자·경보)별 요청 한도를 넘지 못한다. 한도 숫자는 스케줄러 설정(`SchedulerPolicy.requestBudget`, 배포가 넣는다)에 있고 장부에는 없다. 장부는 작업자 줄마다 예약을 실행 줄과 같은 읽기(한 동기 호출, 장부를 쥔 연결 하나)에서 싣는다. 세션 줄과 다른 읽기에는 이 칸이 없다. 새 표·칸·인덱스·트리거는 없고 판 번호도 그대로다.

    | 실행 | 예약 |
    |---|---|
    | 시작 지시(`task_start`)가 없다(`queued`, 대기에서 닫힌 `not_started`) | 0 |
    | 시작 지시가 있고 D-90 근거(`unreceived_closures`)가 있다 | 0(받은 적 없음이 증명됐고 감액도 없다) |
    | 시작 지시가 있고 그 밖이다(진행 중, `finalized`, `failed_stopped`, `cleanup_pending`, 관리자 닫기) | 시작 지시에 고정된 `instructions.budget_left` 전부 |
    | 시작 지시의 고정 예산이 비었다(판 4 전에 적힌 줄) | `null`(모름) |
    | 시작 지시가 둘 이상이거나 작업자 줄에 `session_start`가 있다 | `null`(모름) |

  - **돌려주지 않는다(D-77):** `runs.budget_left`는 읽지 않는다. 시작 뒤 `recordBudget`의 감액은 예약을 줄이지 않고(계측이 아직 없다), 대기 중 감액은 시작 지시에 이미 고정돼 있다. 예약이 0으로 돌아오는 길은 D-90 닫기뿐이다. 요청의 남은 몫이 느는 것도 D-90 닫기와, 배포가 한도 숫자를 올릴 때뿐이다(올리면 진행 중인 요청도 더 받는다).
  - **스케줄러의 판단(`src/supervisor/scheduler/queue.ts`):** 같은 입력의 다른 작업자 줄의 예약 합을 그 입력의 출처 한도에서 뺀 나머지보다 대기 실행의 예산이 크면 `request_budget_exceeded`, 나머지가 0 이하면 `budget_exhausted`, 예약을 모르는 줄이 있으면 `budget_unknown`으로 보류한다. 줄여 시작하지 않고 입력이 만료될 때까지 기다린다. 같은 요청의 줄에 남은 예산 0이 적혀 있으면 한도와 무관하게 `budget_exhausted`다. **한도가 역할 계획의 예산보다 작으면 그 역할의 작업은 예약이 하나도 없는 요청에서도 시작하지 않는다**(두 값을 견주는 곳이 없다). 그래서 출처별 한도는 그 출처가 부를 수 있는 역할 계획 예산의 최댓값 이상이어야 한다. 세션 줄의 예약은 세지 않지만, 판단은 종류를 가리지 않아 대기 세션 자신의 예산도 같은 남은 몫과 비교된다(세션 시작이 닫혀 있어 지금은 닿지 않는다).
  - **`startRun`은 요청 한도를 다시 보지 않는다.** 작업자 자리가 하나(`runs_one_per_slot`)이고 배정 박자가 직렬이라, 판단과 시작 사이에 같은 요청의 다른 작업이 시작할 길이 없다는 전제다.
  - **사본에서 뜬 장부:** 사본 뒤에 시작한 실행은 사본에 없어서 되가져온 장부의 예약은 실제보다 적을 수 있다(그 실행들의 예산이 다음 작업에 다시 나간다). 대조가 끝날 때까지 `startRun`이 `snapshot_hold`로 막혀 그 값으로 시작하지는 않는다. 그래서 **대조하는 관리자는 계정 잠금·영수증과 함께, 요청마다 사본 뒤에 시작했을 수 있는 작업과 그 예산을 확인한 뒤에 `confirmSnapshotReconciled`를 부른다.** 장부는 이 확인을 강제하지 못한다.
  - **이 읽기와 판단이 하지 않는 것:** 요청 한도를 장부에 고정하는 이관, `startRun`의 요청 한도 재검사, 배정 때 예산을 남은 몫으로 줄이기, 실제 사용량 계측, 세션 줄의 예약(세션 시작이 닫혀 있어 세지 않는다. 대기 세션을 한도로 막을지도 세션 시작을 열 때 정한다), 도구 처리기의 새 거절 이름. 뒤 작업이 지킬 것은 "뒤 작업이 알아야 할 것"의 "요청 예산"에 있다.
- **출처 이름은 분류하지 않는다.** `source`를 관리자 요청과 자동 경보로 나누는 규칙은 접수 정책의 몫이다. 장부는 `enqueueInput`이 받은 이름을 그대로 낸다.
- **모름과 미발행:** 읽기가 실패하면 `{ known: false }`다. 읽기가 성공했을 때 `lease`·`renewIssued`·`lastStopAt`·`lastFinalizeAt`의 `null`은 그런 지시를 낸 적이 없음을 장부에서 확인한 값이다. `lease.expiresAt`의 `"unknown"`은 지시는 있는데 실행기의 그 임대의 끝을 장부가 모른다는 뜻이고, `renewIssued.leaseUntil`의 `"unknown"`은 발급한 끝을 장부가 갖지 않거나 가를 수 없다는 뜻이다. 0이나 짐작한 값으로 채우지 않는다.
- **임대의 끝:** 시작 지시(`task_start`)의 임대 끝은 계약이 정한 값(발행 시각 + `RUN_LEASE_MAX_MS`, 실행기가 머리의 `issued_at`에서 같은 식으로 정한다)이라 장부의 `issued_at`에서 계산한다. 지시의 머리에 장부의 `issued_at`보다 이른 시각을 실으면 이 값이 실제보다 늦어진다. **세션 시작 지시의 임대 끝은 장부에 없어 언제나 `"unknown"`이다.** 갱신이 없을 때만 시작 지시의 임대이고, 발행 시각이 같은 시작 지시가 여럿이면 하나라도 모르면 모름, 아니면 이른 끝이다.
- **갱신 뒤의 임대(일찍 낸 갱신을 믿는다, D-89 후보):** 갱신 지시가 하나라도 있으면 `lease.issuedAt`은 기록된 갱신 발행 시각의 최댓값이다. `lease.expiresAt`은 발급 기록의 끝이 숫자이고(아래 "발급 기록"의 검사를 모두 통과) **시작 임대부터 그 갱신까지 사슬의 갱신마다 `발행 시각 + RENEW_MARGIN_MS <= 앞 임대의 끝`**일 때만 그 끝이고, 하나라도 아니면 `"unknown"`이다. **이 끝은 감독의 추정이다.** 실행기 계약 v1에는 갱신의 영수증이 없다. 아래 가정 넷은 그 갱신이 **앞 임대와 봉투의 시간 검사를 통과한다**까지만 보장하고, 실행기가 실제로 적용해 같은 끝을 갖는 데는 아래 "가정 넷이 보장하지 않는 것"의 전제가 더 필요하다.
  - **식:** `RENEW_MARGIN_MS = DELIVERY_MAX_MS + CLOCK_SKEW_MS + RENEW_HANDLING_MS` = 10000 + 1000 + 2000 = **13000ms**(기본값). `RENEW_HANDLING_MS`(처리 허용치)는 **감독 쪽 기본값(관리자 미확정)**이고 계약(`src/contract/`)의 상수가 아니다. 재 본 값이 아니고, 기본 갱신 간격(`RENEW_INTERVAL_MS`)에서 갱신을 낼 수 있는 구간 `RUN_LEASE_MAX_MS − RENEW_MARGIN_MS − RENEW_INTERVAL_MS`가 7000ms 남도록 골랐다.
  - **가정 넷:** (1) 전달(연결에 실은 때부터 실행기가 받기까지) `< DELIVERY_MAX_MS`. (2) 두 시계의 차이 `<= CLOCK_SKEW_MS`. (3) 양끝의 처리 시간의 합 `<= RENEW_HANDLING_MS`: 장부에 갱신을 적은 시각부터 연결에 싣기까지 + 실행기가 받은 시각부터 임대를 검사하기까지(실행기는 받은 시각에 봉투를 검증하고, nonce를 저장하기 전에 봉투의 시한을 읽고, 저장한 뒤 시각을 다시 읽어 업무 기한과 앞 임대를 검사한다: `src/executor/link.ts`, `src/executor/store.ts`의 `consume`, `src/executor/worker.ts`의 `onRenew`·`expire`). (4) 봉투가 실행기에서 검사될 때 시한 안(뒤 작업이 지킬 송신 규칙, 아래 "뒤 작업이 알아야 할 것"의 "스케줄러").
  - **등호도 믿는 이유:** 실행기는 자기 시계로 검사 시각이 앞 임대의 끝 이상(정각 포함)이면 연장하지 않고 닫는다. 발행 시각 `s`(감독 시계)의 갱신이 검사되는 시각은 감독 시계로 `s + 싣기까지의 처리 + 전달 + 받은 뒤의 처리`이고 실행기 시계가 앞서는 만큼 더 늦게 읽힌다. 가정 안이면 검사 시각 `< s + RENEW_MARGIN_MS <= 앞 임대의 끝`이라 앞 임대의 시간 검사를 통과한다.
  - **가정 넷이 보장하지 않는 것:** 실행기가 갱신을 실제로 적용하려면 시간 검사 밖의 전제가 더 필요하다. 시작과 앞 임대가 실행기에 반영됐고, 검사 시점에도 작업이 진행 중이며, 작업 기한·취소·연결·접수·세대의 조건이 유효해야 한다. **이 전제는 감독에 확인되지 않을 수 있다**(갱신의 영수증이 없다). 처리 허용치를 늘려도 아래 두 경우는 닫히지 않는다.
    - **작업 기한 정각에 닿는 갱신:** 실행기는 앞 임대보다 업무 기한(`now >= deadline_at`)을 먼저 보고, 기한에 닿았으면 갱신을 적용하지 않고 작업을 끝낸다. 예: 시작 `T`, 업무 기한 `T+28000`, `T+17000`의 갱신이 가정 안(전달 9999ms, 시계 +1000ms, 처리 1ms)에서 `T+28000`에 검사되면 기한으로 끝나고, 장부의 끝은 `T+47000`, 실행기의 끝은 `T+30000`이다. 감독의 판단은 기한 전이라 갱신을 내고, 종료 영수증이 장부에 닿기 전까지 다시 갱신을 낼 수 있다.
    - **시작을 접수하는 중에 닿은 갱신:** 장부는 시작을 발급하면 곧바로 `preparing`이고 그 상태에서도 갱신을 판단·기록한다. 실행기는 시작의 실행 기록을 다 쓴 뒤에야 그 실행의 세대를 읽을 수 있어서, 그 전에 받은 갱신은 모르는 실행(`unknown_run`)으로 거절한다. 예: 시작 `T`의 접수 중 `T+10000`에 닿은 갱신이면 장부의 끝은 `T+40000`, 실제로 시작한 작업의 끝은 `T+30000`이다. 실행기의 수신이 앞 수신의 처리가 끝날 때까지 기다리는지는 미확인이고, 지금의 연결 API와 송신 규칙은 그 순서를 보장하지 않는다.
    - **그때 일어나는 일:** 장부만 연장되고 실행기는 앞 임대의 끝이나 기한에서 닫는다(아래 "남는 한계"). 자리는 종료 확인까지 유지되어 일이 겹치지 않는다. 감독은 반대 증거가 장부에 닿을 때까지 그 실행에 갱신을 더 적을 수 있다.
  - **가정의 경계(`test/ledger/lease-trust.test.ts` "가정의 경계", 실행기를 띄우지 않은 충분조건의 계산):** 시작 `T`이면 장부가 믿는 마지막 발행은 `T+17000`이다. 전달 9999ms, 실행기 시계 +1000ms, 처리 1ms이면 검사는 `T+28000`이고, 처리가 허용치 끝(2000ms)이어도 `T+29999`라 시간 검사를 통과한다(싣기 전의 처리가 있으면 송신 규칙에 따라 그만큼 앞서 발행해 `T+17000`에 싣는다). 나머지가 가정의 끝(전달 9999ms, 시계 +1000ms, 처리 2000ms)일 때 처리가 2001ms이거나 전달이 10000ms이거나 시계가 1001ms 앞서면(가정 밖) 검사가 `T+30000`이라 실행기는 닫고, 장부는 끝을 `T+47000`으로 믿는다. 처리 허용치를 넣지 않은 여유(전달 + 오차 = 11000ms)라면 마지막 발행이 `T+19000`인데, 그 갱신은 처리 1ms로도 `T+30000`에 검사되어 닫힌다. 장부는 그 갱신을 믿지 않고 판단도 그 시각에 갱신을 내지 않는다.
  - 늦게 낸 갱신 하나가 사슬에 있으면 그 뒤 갱신이 제때여도 모름이다(실행기는 늦은 갱신을 거절하고 그 앞 임대의 끝에서 이미 닫았을 수 있다). 수명 판단(`nextIntent`)은 같은 여유가 남지 않으면 갱신을 내지 않는다(`src/supervisor/scheduler/lifecycle.ts`의 `RENEW_MARGIN_MS`, 같은 식). 그래도 장부는 늦은 갱신을 기록받을 수 있다: 판단을 거치지 않은 호출자뿐 아니라 같은 배정기도 판단 뒤 시각을 다시 읽어 그 시각으로 기록하면 늦은 갱신이다(장부는 그 끝을 믿지 않고 판단은 조회로 간다). 두 자리의 값이 같은지는 같은 시험 파일의 경계 시험이 지킨다.
- **반대 증거가 이긴다:** `lease`는 지시의 시각만 본다. 실행기의 종료 확인 영수증을 받으면 실행은 `checking`·`failed_stopped`로, 끊김 표시(`markLost`, 실행기 하나면 `markLostFor`)나 복원 3단계 뒤에는 `unknown_running`으로 옮겨 가고, 그 상태에서 `nextIntent`는 믿은 임대가 남아 있어도 갱신을 내지 않는다(결과 검사·확정, 같은 ID 조회). 갱신 기록도 거절된다: 접수가 열려 실행 상태 검사에 이르면 `preparing`·`running` 밖에서 `transition_denied`이고, 복원 중처럼 접수가 닫혀 있으면 공통 접수 검사가 먼저 `intake_closed`를 낸다. 슬롯은 임대와 무관하게 종료 확인까지 쥔다("쓰기 규칙"의 "슬롯").
- **남는 한계(가정 밖, 갱신의 유실):** 믿은 갱신이 실행기에 적용되지 않으면(전달 중에 사라짐, 가정 밖의 지연, 송신 규칙으로 싣지 않음, 위 "가정 넷이 보장하지 않는 것"의 전제가 어긋남) 장부와 실행기의 끝이 갈린다. 실행기는 그 전에 다른 유효한 갱신을 받지 않았다면 앞 임대의 끝 `L`에서 닫고, 장부는 그 갱신이 발급한 끝 `s + RUN_LEASE_MAX_MS`까지 살아 있다고 낸다.
  - **한 번 발급한 두 끝의 차이(같은 숫자 축):** `(s + RUN_LEASE_MAX_MS) − L`. 믿는 갱신은 `s + RENEW_MARGIN_MS <= L`이므로, **앞 임대의 끝 `L`이 장부와 실행기에서 같을 때** 최댓값은 **`RUN_LEASE_MAX_MS − RENEW_MARGIN_MS` = 30000 − 13000 = 17000ms**(기본값)다.
  - **실제 종료에서 장부의 끝까지(감독 시계):** 실행기 시계가 `CLOCK_SKEW_MS`만큼 앞서면 실행기가 임대로 닫는 순간은 감독 시계로 `L − CLOCK_SKEW_MS`다. **앞 임대의 끝이 양쪽에서 같고, 시계 오차가 상한 안이며, 실행기가 임대의 만료로 닫을 때** 최댓값은 **`RUN_LEASE_MAX_MS − RENEW_MARGIN_MS + CLOCK_SKEW_MS` = 18000ms**다(실행기가 닫는 순간 기준이고 프로세스 정리 시간은 들지 않는다). 이 조건 밖에는 이 값을 쓸 수 없다: 시계가 1001ms 앞서면(가정 밖) 18001ms이고, 업무 기한이나 자연 종료로 먼저 닫히면 다른 값이다. 예: 시작 `T`, `T+17000`의 갱신이 사라지면 실행기는 감독 시계 `T+29000`에 닫고 장부의 끝은 `T+47000`이다.
  - **차이는 반대 증거가 장부에 닿을 때까지 늘어난다.** 감독은 그 뒤에도 그 실행을 `running`으로 보고 갱신 주기마다 갱신을 적고, 그 갱신도 여유를 지켰으면 믿는다. 앞의 예에서 `T+27000`, `T+37000`, …의 갱신으로 장부의 끝은 `T+57000`, `T+67000`, …으로 늘고, 이미 닫힌 실행기는 뒤 갱신을 적용하지 않는다. 위 두 최댓값은 갱신 하나에 대한 값이다.
  - **감독이 알게 되는 길:** 셋 모두 반대 증거가 장부의 실행 상태에 닿아야 판단이 바뀐다. 지금 저장소에는 운영 중 그 증거를 장부까지 잇는 코드가 없다.

    | 길 | 지금 저장소에서 이어진 구간 | 뒤 작업이 이어야 하는 구간 |
    |---|---|---|
    | 실행기의 종료 영수증 | 실행기: 임대가 끝나면 실패로 닫고(`worker.ts`의 `expire`) 남은 프로세스 0개를 센 뒤 `receipt_stopped`를 저장·송신하고, 받음 확인이 없으면 다시 보낸다(`tick`). 감독 연결: 검증한 영수증을 `forward` 출력으로 낸다(`src/supervisor/transport/connections.ts`). 장부: `applyReceipt`를 부르면 같은 트랜잭션에서 `failed_stopped`가 된다(시험으로 확인) | `forward` → `applyReceipt` → ack를 잇는 운영 처리기. **미확인**(제품 코드에 호출이 없다). 남은 프로세스 수를 모르면 실행기는 `unknown_running`에 머물고 종료 영수증을 내지 않는다 |
    | 끊김 판정 | 계약의 `viewLink`가 마지막 수신부터 `DISCONNECT_JUDGE_MS`(30초) 뒤 `lost`를 내고, 살아 있지 않은 연결에는 `mayIssue`가 지시를 막는다(`src/contract/v1/transport.ts`). `markLost`는 진행 중 실행 전부를 `unknown_running`으로 옮기고, 지금 부르는 곳은 복원 3단계뿐이다(`src/ledger/restore.ts`). 그 실행기의 실행만 옮기는 장부 쓰기는 `markLostFor`다("쓰기 규칙"의 "실행기 하나의 끊김") | 끊김을 판정해 `markLostFor`를 부르는 운영 순환. **미확인**(제품 코드에 호출이 없다). 기록 때마다 `mayIssue`를 보면 연결이 끊긴 뒤 장부의 마지막 끝은 마지막 수신 + `DISCONNECT_JUDGE_MS` + `RUN_LEASE_MAX_MS`(60초) 미만이지만, 다른 유효한 수신이 이어지는 동안에는 이 상한이 없다 |
    | 상태 조회 | 실행기는 같은 ID 조회에 파일에 적힌 상태·세대·마지막 영수증 ID를 답한다(`worker.ts`의 `onStatus`). 감독 연결은 받은 `status_report`를 점유 응답(`partial`)으로 낸다. 장부: `applyExecutorAnswer`가 갱신을 받지 않는 상태의 답(끝났다·모른다 등)이면 `preparing`·`running`을 `unknown_running`으로 옮긴다. 시작이 아직 닿을 수 있는 동안 만든 `not_known`은 보류한다("쓰기 규칙"의 "실행기의 답"). 판단은 믿은 임대에 여유가 남는 동안 조회를 내지 않는다 | 운영 중 조회의 송신, 답과 질문의 상관(`not_known`은 세대가 null), 대조한 답을 `applyExecutorAnswer`에 넘기는 처리기. **미확인**(제품 코드에 호출이 없다). 답에는 실행기의 임대 끝이 없다 |

  - **슬롯:** 어느 경우에도 슬롯은 종료가 확인될 때까지 풀리지 않는다("쓰기 규칙"의 "슬롯"). 일이 겹치지 않고 자리가 그만큼 늦게 풀린다.
- **발급한 갱신의 끝:** `recordRenewInstruction`은 `leaseUntil`(넘긴 `now` + `RUN_LEASE_MAX_MS`)을 돌려준다. 부르는 쪽은 그 값을 갱신 본문의 `lease_until`에, `now`를 머리의 `issued_at`에 그대로 싣는다. 계약이 허락하는 가장 긴 갱신이다(`parseRunRenew`). 장부는 같은 값을 `instructions.lease_until`에 적는다. 이 값은 감독이 발급한 끝이고 실행기가 적용한 끝이 아니다. **같은 실행의 앞 임대 지시(시작·갱신) 가운데 발행 시각이 `now` 이상인 것이 있으면 끝을 적지 않는다(NULL).** 기록 자체와 거절 조건은 그대로다. 장부에는 지시의 기록 순서가 없어서, 끝을 적은 갱신들의 발행 시각이 기록 순서대로 엄격히 늘게 하는 곳이 이 기록이다. `now` + `RUN_LEASE_MAX_MS`가 안전 정수를 넘는 `now`는 본문을 만들 수 없어 `LedgerInputError`다.
- **발급 기록:** 갱신이 있으면 `renewIssued`는 발행 시각이 가장 큰 갱신의 시각과 그 끝이다. 갱신을 발행 시각 순서로 시작 임대부터 이어 보아, 하나라도 아래에 걸리면 끝은 `"unknown"`이다: 끝이 없는 갱신(이 판 전에 적힌 줄, 순서가 어긋나 적지 않은 줄), 앞 임대 지시보다 늦지 않은 발행 시각(같은 시각 포함), 앞 임대(시작 임대, 그 뒤로는 앞 갱신이 발급한 끝)의 끝 이후에 낸 갱신, 발행 시각 이하이거나 발행 시각 + `RUN_LEASE_MAX_MS`보다 늦은 끝, 시작 임대의 끝을 모름. 끝을 저장했는지는 기록 순서만 가른다. **위 검사를 모두 통과할 때만**(각 갱신이 끝을 갖고, 발행 시각이 엄격히 늘고, 각 갱신이 앞 임대가 끝나기 전에 발행됐을 때) 내는 끝은 실제로 마지막에 기록한 갱신이 발급한 끝과 같다. 모든 갱신이 끝을 가져도 그중 하나가 앞 임대의 끝 이후에 발행됐으면 모름이다(시작 `T`, 갱신 `T+30000` 하나면 저장값은 `T+60000`이고 발급 기록의 끝은 `"unknown"`). 모름이 된 실행은 그 뒤에 갱신을 적어도 모름이다. 이 검사는 발행 시각만 보므로 숫자가 나와도 실행기가 그 끝을 적용했다는 뜻이 아니다. 여유는 보지 않는다: 늦게 낸 갱신의 끝도 여기에는 숫자로 남고, 임대로 믿을지는 위 "갱신 뒤의 임대"가 가른다.
- **필요한 판:** `instructionTimes`와 `recordRenewInstruction`은 판 2(`0002-renew-lease-end`) 이상의 장부를 요구한다. 기본 판 목록으로 여는 재개방은 판 2까지 올라간다. **`migrations` 옵션으로 판 목록을 그 앞에서 끊어 연 장부(시험용 길)에서는 기존 실행의 `instructionTimes`가 `{ known: false, reason: "db_error" }`, `recordRenewInstruction`이 `ledger_unwritable`로 닫히고 건강 상태가 `{ writable: false, reason: "db_error" }`가 된다.** 그 뒤에는 다른 실행의 새 접수(`admitRun` 등)도 `ledger_unwritable`이다. 틀린 값을 내지 않고 닫히는 쪽이다.
- **종료·확정은 발행 시각의 최댓값:** `lastStopAt`·`lastFinalizeAt`은 마지막으로 기록한 행이 아니라 기록된 발행 시각의 최댓값이다. 더 이른 시각으로 나중에 기록한 지시는 앞 지시의 시각에 가려진다.
- **지금 상태로 좁히지 않는다:** 장부는 실행이 지금 상태에 들어온 시각을 따로 적지 않는다. `lastStopAt`·`lastFinalizeAt`은 상태와 무관한 그 실행의 마지막 지시다. 예를 들어 `cleanup_pending`의 `lastFinalizeAt`은 그 앞 상태에서 낸 확정 지시일 수 있고, 그러면 확정 재시도가 그 시각부터 답을 기다린 뒤에 나온다.

## 답을 받지 못한 지시

감독이 지시를 적고 보내기 전에 끊기면, 다시 뜬 감독은 장부만으로 그 지시가 전달됐는지 모른다. 실행기는 같은 요청 ID·같은 본문의 재전송을 멱등으로 처리하고(아는 실행이면 같은 영수증을 다시 보낸다) 같은 요청 ID에 다른 본문이면 답하지 않는다. 그래서 장부는 "보냈는가"가 아니라 "맞는 영수증을 받았는가"로 가르고, 받지 못한 지시를 처음과 같은 본문으로 다시 만들 값을 낸다.

| 공개 함수 | 돌려주는 것 | 쓰는 곳 |
|---|---|---|
| `unansweredInstructions()` | `Read<UnansweredInstructions>`. `stopGeneration`(장부의 지금 정지 세대, 기록이 없으면 `null`)과 `instructions`(아래 판정에 걸린 지시 전부). 항목은 `requestId`, `action`, `runId`, `runGeneration`, `executorId`(지정 실행기), `runState`, `stopGeneration`(그 지시를 적을 때의 세대), `issuedAt`(그 지시 줄의 발행 시각), `rebuild`(본문을 다시 만들 칸, 못 만들면 `null`) | 재전송(뒤 작업), D-90의 "접수 영수증이 한 번도 없음"의 장부 쪽 증거(점유 응답은 따로 본다, 아래 "뒤 작업이 알아야 할 것") |

**판정.** 영수증은 `deliveries`의 받은 기록이다(낸 쪽이 그 실행의 지정 실행기이고 세대가 같을 때만 적힌다). 예외는 세션 인수 영수증(`receipt_session_takeover`)이다: 앞 세션의 지정 실행기 말고 대기 중인 세션 실행의 지정 실행기가 낸 것도 적히고, 이 영수증이 가리키는 실행은 앞 세션이다("세션 증거").

| 지시 | 답을 받지 못함 | 내지 않는 실행 |
|---|---|---|
| `task_start`·`session_start` | 그 실행에서 받은 영수증·보고가 하나도 없다 | `finalized`·`not_started`, 종료 확인(`stop_receipt_id`)이 있는 실행 |
| `task_cancel`·`session_stop` | 그 요청 ID를 가리키는 `receipt_accepted`가 없고, 그 실행의 종료 확인도 없다 | 같음 |
| `result_finalize` | 그 요청 ID를 가리키는 `receipt_cleaned`가 없다 | `finalized`·`not_started` |
| `run_renew` | 내지 않는다. 계약 v1의 갱신에는 영수증이 없다 | 전부 |

- **시작은 접수 영수증만 보지 않는다.** 실행기는 시작 지시로만 실행을 알게 되므로 그 실행의 영수증·보고가 하나라도 있으면 시작을 받은 것이다. 접수 영수증만 보면 그것이 늦게 오는 동안 이미 도는 실행을 "받은 적 없음"으로 읽는다. 그래서 이 읽기에 시작이 나오면 그 실행의 접수 영수증도 한 번도 없었다(반대는 아니다: 접수 영수증만 빠진 실행은 나오지 않는다).
- **순서:** 실행의 대기 순번, 그 안에서 시작 → 종료 → 확정, 발행 시각, 요청 ID. 종료의 발행 시각이 시작보다 일러도 같은 실행에서는 시작이 앞이다.
- **본문 칸(`rebuild`):** 시작은 `role`·`profileRevision`·`policyRevision`·`snapshotDigest`·`inputDigest`·`deadlineAt`·`credential`(실행 줄, 시작 뒤 바뀌지 않음)과 `budgetLeft`(지시 줄, 시작 때의 남은 예산)다. 종료는 `reason`, 확정은 `outcome`·`resultDigest`·`storedAt`이다. 실행 ID·세대·지정 실행기·정지 세대·발행 시각은 항목에 있다. 자격은 참조 네 칸만이고 값·원문은 없다. 봉투 모듈(`src/supervisor/dispatch/envelopes.ts`)의 초안 입력으로는 시작이 `startDraft({ run: { runId, runGeneration, executorId, kind: "worker", ...rebuild }, requestId, stopGeneration, issuedAt })`, 종료가 `stopDraft({ action, run, requestId, stopGeneration, reason })`, 확정이 `finalizeDraft({ run, requestId, stopGeneration, outcome, resultDigest, storedAt })`다.
- **다시 봉한 봉투:** 위 초안으로 다시 봉한 봉투는 모든 동작에서 처음 봉투와 받는 쪽·요청 ID·본문 digest·본문·머리의 두 세대(정지·실행)가 같고 nonce·서명은 새것이다. 머리의 두 시각은 봉투 모듈의 시각 규칙(`src/supervisor/dispatch/envelopes.md`)대로 동작마다 다르다. **시작**은 항목의 `issuedAt`(지시 줄의 발행 시각)으로 봉하므로 `issued_at`·`expires_at`도 처음과 같다. **취소·세션 정지·확정**은 다시 봉하는 때의 시각으로 봉하므로 `issued_at`·`expires_at`이 달라진다(처음 발행 +3000ms, 다시 연 뒤 +60000ms에 봉하면 시한이 +33000ms에서 +90000ms로 옮는다). 실행기는 취소·확정의 재전송을 요청 ID와 본문 digest로 대조해 같으면 앞서 낸 영수증을 다시 보내므로(봉투 모듈 문서의 "종료·확정·조회·ack의 시각을 새로 두는 이유") 새 시각의 봉투도 같은 요청이다. 세션 실행기가 `session_stop`의 재전송을 같은 요청으로 처리하는지는 확인하지 않았다(봉투 모듈 문서와 같다). 시험은 `test/ledger/unanswered-instructions.test.ts`(세션 정지는 세션 시작이 닫혀 있어 공개 API로 만들 수 없다).
- **같은 요청 ID로 다시 적기:** 지시 줄은 적은 뒤 바뀌지 않는다(`instructions_fixed`·`instructions_no_replace`). 같은 요청 ID의 줄을 다시 넣으려는 기록은 거절되고 기존 줄과 칸은 그대로다. 거절 사유는 상태 검사가 먼저 걸리는지에 따른다: 같은 실행의 `startRun` 재호출과, 종료가 확인됐거나 끝난 실행에 이은 부탁의 취소(`cancelToolRequest`)는 `transition_denied`이고, 중복 INSERT까지 닿은 직접 취소·이은 부탁 취소·확정은 `invariant_violation`이다. 그래서 빼고 적은 본문 칸을 같은 요청 ID로 나중에 채울 수 없다.
- **지시마다의 발행 시각:** 항목의 `issuedAt`은 그 지시 줄의 값이다. 갱신이 적힌 뒤의 `instructionTimes(runId).lease.issuedAt`은 갱신의 시각이라 시작 지시를 다시 만드는 데 쓰지 않는다.
- **다시 만들 수 없음(`rebuild: null`):** 판 4 전에 적힌 줄, 본문 칸을 넘기지 않고 적힌 줄(위 "쓰기 규칙"의 "지시의 본문 칸"), 세션 시작(세션 계약 전이라 적히지 않는다), 칸의 값이 계약 밖인 줄. 결과 digest는 있는지만 보고 형식은 다시 보지 않는다(공개 쓰기가 형식을 검사한 줄만 있다는 전제다. 이관의 CHECK는 형식을 보지 않는다). 비어 있는 칸을 실행 줄의 지금 값(예: 줄어든 예산)이나 기본값으로 채우지 않는다.
- **모름:** 읽기가 실패하면 `{ known: false }`이고 장부를 바꾸지 않는다(다른 읽기처럼 건강 상태만 "쓸 수 없음"이 된다).
- **필요한 판:** 판 4. 판 목록을 그 앞에서 끊어 연 장부(시험용 길)에서는 지시를 판 4 전의 꼴로 적고 이 읽기는 모든 항목을 다시 만들 수 없음으로 낸다.

## 작업 부탁(배정 전 대기)

오케스트레이터 세션이 `start_worker`로 낸 부탁을 실행 줄과 따로 적는다. 부탁을 받은 순간에는 맞는 실행기나 계정이 없을 수 있다. 그때 실행 줄(`admitRun`: 실행기·자격·기한·예산을 가진다)을 만들거나 가짜 실행기 ID를 채우지 않고, 부탁만 적고 참조를 돌려준다. 맞는 실행기를 고른 쪽(배정기)이 `assignToolRequest`로 그 부탁을 실행 줄에 잇는다. 감독의 도구 처리기(`src/supervisor/scheduler/tools.ts`)의 장부 포트 넷을 아래 함수 넷이 채운다.

| 공개 함수 | 동작 | 처리기 포트 |
|---|---|---|
| `findToolRequest({ owner, dedupeKey })` | `Read<ToolRequest \| null>`. 그 소유자의 그 재시도 키의 줄 | `findByRetryKey` |
| `readToolRequest({ owner, ref })` | `Read<ToolRequest \| null>`. 그 소유자의 그 참조의 줄 | `readOwnedWork` |
| `recordToolRequest(input)` | 쓰기 모드 `start`. `{ ok: true, outcome, request }`(`outcome`은 `created`·`existing`·`conflict`) 또는 거절 | `recordStart` |
| `cancelToolRequest({ owner, ref, sessionId, callId, now })` | 쓰기 모드 `continue`. 대기 부탁은 `not_started`로, 이은 부탁은 그 실행의 취소로 적고 `{ ok: true, phase }`(지시를 적었으면 `instruction`도) 또는 거절 | `requestCancel` |
| `assignToolRequest(input)` | 쓰기 모드 `start`. 대기 부탁을 새 실행 줄에 잇고 `{ ok: true, outcome, run }`(`outcome`은 `assigned`·`already_assigned`) 또는 거절 | 없음(배정기가 부른다) |
| `listWaitingToolRequests()` | `Read<WaitingToolRequest[]>`. 대기이고 실행에 이어지지 않은 부탁 전부. 아래 "대기 부탁의 목록" | 없음(배정기가 읽는다) |

`ToolRequest`는 `ref`, `owner`, `dedupeKey`, `role`, `purpose`, `sourceRef`, `inputDigest`, `phase`다. `phase`는 이어지지 않은 부탁이면 줄의 단계, 이은 부탁이면 이은 실행 줄의 지금 상태를 옮긴 단계다(아래 "이은 뒤의 단계"). 포트의 `WorkRecord`와는 이름만 다르다(`retryKey` ↔ `dedupeKey`, `content`의 네 칸 ↔ 펼친 네 칸). 장부의 입력 칸 이름은 `test/ledger/static.test.ts`가 막는 조각(`key`로 끝나는 이름은 `dedupe_key`뿐, `content`)을 쓰지 않는다. 그래서 포트를 채우는 어댑터는 이름을 옮기고, 새 참조의 후보를 넘기고, 거절을 포트의 꼴로 옮긴다: `stopped` → `stopped`, `intake_closed`·`snapshot_hold` → `intake_closed`, `transition_denied` → `already_ended`, 그 밖은 모름(`known: false`). 그 어댑터는 `test/ledger/tool-requests.test.ts`에 있다.

- **소유:** 소유자(`owner`)는 부탁을 낸 논리 요청이고 접수한 입력이어야 한다(`inputs`의 외래 키, 아니면 `invariant_violation`이고 줄이 생기지 않는다). 두 조회와 취소는 소유자가 같은 줄만 본다. 다른 소유자의 같은 키·같은 참조는 이어졌든 아니든 없는 줄과 같은 답이다: 조회는 `{ known: true, value: null }`, 취소는 `unknown_run`. 읽기 실패의 꼴(`known: false`)도 소유와 무관하다. 이 조회·취소의 격리는 아래 "참조"의 후보 조건과 무관하게 성립한다.
- **유일성:** (소유자, 재시도 키)마다 한 줄이다. 유일 인덱스가 지키고, 같은 참조나 같은 (소유자, 키)의 INSERT는 트리거가 막는다(`INSERT OR REPLACE`가 옛 줄을 지우고 새 참조를 들이는 길이 없다). 기록은 같은 트랜잭션에서 그 소유자의 같은 키를 먼저 찾는다. 있으면 새 줄 없이 그 줄을 돌려준다: 내용(역할·목적 분류·원본 참조·입력 digest)이 같으면 `existing`, 다르면 `conflict`. 처리기가 조회한 뒤 기록하기 전에 같은 키가 생겨도 같다. 다른 소유자가 같은 키를 쓰면, 새 참조 후보가 표 전체에서 비어 있는 한 각자 자기 줄을 만들고 서로의 줄에 닿지 않는다(아래 "참조"). 처리기는 돌려받은 줄의 소유자와 내용을 다시 대조한다.
- **참조:** 불투명 UUID이고 배정 뒤에도 같다. 참조는 소유자와 무관하게 표 전체에서 유일하다(기본 키와 INSERT 트리거). 장부는 난수를 부르지 않으므로 부르는 쪽(포트 어댑터, 뒤의 조립 코드)이 후보(`ref`)를 넘기고, 장부는 새 줄을 만들 때만 그 후보를 쓴다. 후보가 이미 쓰인 참조이면(자기 것이든 다른 소유자의 것이든) `invariant_violation`이고 줄이 생기지 않으며, 처리기는 `unknown`으로 답한다. 이 답에는 그 참조를 가진 부탁의 소유자·내용·단계가 실리지 않는다. 그래서 두 보장, 다른 소유자의 같은 재시도 키도 각자 접수된다는 것과 다른 소유자의 부탁이 있든 없든 기록의 응답이 같다는 것은 **새 후보가 표 전체에서 비어 있을 때** 성립한다. 후보는 부르는 쪽이 암호학적 난수 UUID로 만들어야 하고, 예측할 수 있는 값이나 순번을 쓰지 않는다. 본체(모델)의 `start_worker` 인자에는 참조를 지정하는 칸이 없다.
- **정지:** 기록은 새 업무다. 처리기가 들어올 때 본 정지와 별개로 "새 업무를 열어도 되는 조건"을 기록 트랜잭션 안에서 다시 본다. 정지(`stopped`), 정지 기록 없음(`stop_unknown`), 접수 허가 없음(`intake_closed`), 사본 보류(`snapshot_hold`), 쓸 수 없음(`ledger_unwritable`)이면 거절이고 줄이 생기지 않는다. 같은 키의 기존 줄을 돌려주는 것도 이 전제를 지난 뒤다. 취소 접수는 닫는 기록이라 정지 중에도, 접수가 닫혀도 적는다(처리기는 정지 중 호출을 문맥에서 먼저 거절한다).
- **단계:** 부탁 줄에 적는 단계는 배정 전의 둘이고(`TOOL_REQUEST_PHASES`), 처리기의 단계 이름(`PHASES`) 안에 있다. `waiting_assignment`는 대기, `not_started`는 배정 전에 취소돼 시작하지 않은 부탁이다. 대기 부탁의 취소는 한 번만 된다(다시 취소하면 `transition_denied`). 재시도 키는 논리 요청과 목적 분류로만 만들어지므로, 취소한 뒤 같은 부탁을 다시 내면 새 줄이 아니라 그 줄이 `not_started`로 나온다.
- **배정 전 대기는 실행 줄이 아니다:** 기록과 대기 부탁의 취소는 `runs`·`slot_holds`·`instructions`에 아무것도 적지 않는다. 부탁은 슬롯을 쥐지 않고 실행기·자격·기한·예산을 갖지 않는다. 닫았다 다시 연 뒤에도 같은 참조와 단계로 읽힌다.

### 대기 부탁의 목록(`listWaitingToolRequests`)

배정기가 이을 부탁을 고르는 읽기다. 장부를 바꾸지 않는다.

- **내는 줄:** 단계가 `waiting_assignment`이고 `run_id`가 빈 부탁만이다. 이은 부탁과 취소된 부탁(`not_started`)은 나오지 않는다. 소유자 입력이 취소됐거나 만료된 부탁은 뺄 근거가 장부 시계에 달려 있어 그대로 내고, 그 입력의 값을 함께 싣는다. 거르는 것은 고르는 쪽(`pick.ts`)과 잇기(아래 "배정"의 입력 재확인)다.
- **순서:** 소유자 입력의 순번(`inputs.seq`), 부탁의 기록 시각(`created_at`), 참조 순이다. 기록 시각은 부르는 쪽이 넘긴 값이라 같거나 뒤집힐 수 있고, 표가 `WITHOUT ROWID`라 삽입 순서가 없으므로 참조로 끝까지 가른다. 같은 장부를 두 번 읽으면 같은 순서다.
- **항목(`WaitingToolRequest`):** `ref`(잇기의 `ref`), `owner`(소유자 입력의 요청 ID), `role`, `inputDigest`, `input: { cancelled, expiresAt }`(소유자 입력의 취소 여부와 원문 만료 시각). `pick.ts`의 `WaitingRequest`가 읽는 칸에 `owner`를 더한 꼴이다. 원문·원문 참조·자격·세션 ID·호출 ID·재시도 키·목적은 싣지 않는다(`test/ledger/waiting-requests.test.ts`가 칸 이름 집합을 고정한다).
- **모름:** 읽기가 실패하면 `{ known: false }`다. 소유자 입력 줄이 없거나 꼴이 어긋난 줄은 빼지 않고 `corrupt`로 닫는다. 빼면 그 부탁이 대기로 남은 채 영영 배정되지 않는다.
- **소유자를 가리지 않는다:** 감독 안쪽(배정기)의 읽기이고 모든 소유자의 부탁을 낸다. 두 조회(`findToolRequest`·`readToolRequest`)의 소유자 대조는 그대로이고, 이 읽기를 도구 처리기(`src/supervisor/scheduler/tools.ts`)의 포트에 잇지 않는다. 이으면 본체가 남의 부탁의 참조와 존재를 알게 된다.

### 배정(`assignToolRequest`)

`tool_requests.run_id`가 부탁을 실행 줄에 잇는 자리다(실행 하나에 부탁 하나, 대기 부탁만, 한 번만 채운다: CHECK와 트리거). 이 칸을 채우는 연산은 `assignToolRequest` 하나다.

- **입력:** `{ ref, runId, snapshotDigest, profileRevision, policyRevision, executorId, credential, deadlineAt, budgetLeft, now }`. 실행기·자격 참조·기한·예산은 배정기가 고른 실제 값이고 `admitRun`의 같은 칸과 같은 검사(`#admitInput`)를 거친다. 역할·입력 digest·실행의 입력(`inputRequestId` = 소유자)은 부탁의 값이라 받지 않는다(받으면 모르는 칸으로 `LedgerInputError`). 대기 부탁을 새로 이을 때 실행기가 부탁의 역할을 맡을 수 없으면 `admitRun`과 같이 `LedgerInputError`다. 이미 이어진 부탁에는 이 검사보다 `already_assigned`가 먼저라, 역할이 맞지 않는 실행기와 새 실행 ID를 넘겨도 이은 그 실행이 돌아온다. 재시도는 돌려받은 실행의 실행기·실행 ID를 쓴다. 소유자는 받지 않는다: 부르는 쪽은 배정기 하나이고 참조는 표 전체에서 유일하다.
- **한 트랜잭션:** 새 업무의 전제(위 "새 업무를 열어도 되는 조건") → 그 참조의 부탁을 다시 읽음 → 실행 줄 기록(`admitRun`과 같은 `#admit`) → 소유자 입력의 취소·만료 재확인 → `run_id` 채움이 한 트랜잭션이다. 커밋 전에 끊기면 실행 줄과 잇기가 함께 되돌려진다.
- **답:** 처음 이으면 `{ ok: true, outcome: "assigned", run }`(`run.state`는 `queued`). 이미 이어진 부탁이면 새 실행 줄 없이 `{ ok: true, outcome: "already_assigned", run }`(이은 그 실행의 지금 값, 넘긴 `runId`는 쓰이지 않는다). 취소된 부탁(`not_started`)은 `transition_denied`, 없는 참조는 `unknown_run`이고 실행 줄이 생기지 않는다. 실행 줄의 접수가 장부의 기존 사유로 거절되면(정지, 접수 허가 없음, 사본 보류, 이미 쓰인 실행 ID의 `invariant_violation` 등) 부탁은 `waiting_assignment` 그대로다.
- **입력의 취소·만료:** 위의 답과 거절이 모두 먼저이고, 그 밖에 이을 수 있는 부탁이면 소유자 입력을 같은 트랜잭션에서 다시 본다. 취소됐으면 `input_cancelled`, 원문 만료 시각이 장부 시계로 지났으면(정각 포함) `input_expired`다. `startRun`이 같은 조건에서 내는 이름·경계와 같다. 실행 줄은 되돌려져 남지 않고 부탁은 `waiting_assignment` 그대로다. 고른 직후 만료된 부탁이 시작할 수 없는 `queued` 실행 줄을 얻지 않게 한다. 이미 이어진 부탁은 입력이 취소·만료돼도 `already_assigned`이고, 그 실행은 시작되지 않는다. `startRun`의 앞선 검사(슬롯·정지 등, 위 "새 업무를 열어도 되는 조건")를 모두 지나 입력 조건이 거절 사유가 될 때 같은 이름(`input_cancelled`·`input_expired`)을 받고, 앞선 검사가 먼저 걸리면 그 이름(예: `slot_busy`)을 받는다. `admitRun`은 이 검사를 하지 않는다(공유하는 `#admitInput`·`#admit`는 그대로다).
- **실행의 중복 키:** 실행 줄의 `dedupe_key`는 `tool_request:<참조>`다. `runs.dedupe_key`는 소유자와 무관하게 전역 유일이라 부탁의 재시도 키를 그대로 쓰면 다른 소유자의 같은 키와 부딪혀 남의 실행이 돌아온다. 참조는 표 전체에서 유일하므로 이 키는 부탁마다 하나다. 이 키의 실행이 이미 있으면(잇는 연산 밖에서 만든 줄) 그 실행을 잇지 않고 `invariant_violation`이다.

### 이은 뒤의 단계

두 조회는 부탁과 이은 실행 줄을 한 문장(`LEFT JOIN`)으로 읽고, 실행 줄의 지금 상태를 `TOOL_REQUEST_RUN_PHASES`(옮기는 표, `ledger.ts` 한 자리)로 처리기의 단계 이름으로 옮긴다. 실행이 `not_started`면 같은 읽기 안에서 `operator_closures`를 한 번 더 조회해(`#toolRequest`), 관리자 근거가 있으면 표 대신 `failed_stopped`(`OPERATOR_CLOSED_PHASE`)를 낸다. 두 조회는 같은 동기 호출 안이라 그 사이에 이 장부의 쓰기가 끼지 않는다. 처리기의 `PHASES`는 배정 전 대기에 장부의 실행 상태 이름을 그대로 더한 것이라 관리자 닫기 밖에서는 같은 이름이다.

| 실행 상태 | 단계 |
|---|---|
| `queued`·`preparing`·`running`·`stopping`·`unknown_running` | 같은 이름 |
| `checking`·`ready_result`·`failed_stopped`·`cleanup_pending` | 같은 이름 |
| `finalized` | 같은 이름 |
| `not_started` | 관리자 근거(`operator_closures`)가 있으면 `failed_stopped`, 없으면(대기 취소, D-90) 같은 이름 |

- 표는 `Record<LedgerRunState, …>`라 상태가 더해지면 타입 검사가, 상태 목록(`LEDGER_RUN_STATES`)을 읽는 시험(`test/ledger/tool-request-assign.test.ts`)이 실패한다.
- 읽기가 실패하면 `{ known: false }`다(단계를 지어내지 않는다).
- `run_id`가 가리키는 실행 줄이 없거나 그 상태가 장부의 상태가 아니면 `corrupt`로 닫는다(장부가 실패 상태가 된다). 외래 키와 `runs_permanent` 트리거가 막으므로 제약을 지나친 파일에서만 생긴다. 대기로 답하면 본체가 오지 않을 진행을 기다리고, `not_started`로 답하면 실행 중일 수 있는 일을 끝났다고 말하게 된다.
- `recordToolRequest`가 같은 키의 기존 줄을 돌려줄 때도 같은 단계다.

### 이은 부탁의 취소

`cancelToolRequest`는 같은 트랜잭션에서 소유를 다시 보고, 이은 부탁이면 부탁 줄을 바꾸지 않고(줄은 `waiting_assignment`·취소 칸 빔 그대로다: CHECK) 그 실행의 취소를 종료 지시의 기록(`recordStopInstruction`과 같은 `#recordStop`)으로 남긴다.

- 시작 전(`queued`): 지시 없이 `not_started`로 닫는다. 답의 단계는 `not_started`다.
- 시작 뒤(`preparing`·`running`·`unknown_running`은 `stopping`으로, `stopping`은 그대로): `task_cancel` 지시를 적는다. 지시의 요청 ID는 이 취소 호출의 ID(`callId`)이고 정지 세대는 장부의 지금 값이며 본문의 `reason`은 `requested`다(지시 줄에만 적고 답에는 싣지 않는다. 처리기는 세대를 모른다. 정지 기록이 없으면 `stop_unknown`). 답은 `{ ok: true, phase: "stopping", instruction: { runId, requestId, stopGeneration } }`이고, 지시를 보내는 것은 부르는 쪽이다.
- **취소의 접수는 종료가 아니다:** 자리를 놓지 않는다. `stopping`은 슬롯을 쥐고, 그 뒤의 전이는 영수증과 기존 연산의 일이다.
- 종료가 확인됐거나(`stop_receipt_id`가 있음: `checking`·`ready_result`·`failed_stopped`·`cleanup_pending`) 끝난(`finalized`·`not_started`) 실행이면 취소가 바꿀 것이 없어 `transition_denied`다(처리기의 `already_ended`).
- 정지 중에도, 접수가 닫혀도 적는다(쓰기 모드 `continue`).
- 같은 호출 ID로 다시 부른 답은 그때의 실행 상태를 따른다(같은 호출 ID의 응답 재생은 없다). 시작 뒤의 취소를 종료가 아직 확인되지 않았을 때 다시 부르면 같은 요청 ID의 지시가 이미 있어 `invariant_violation`이다. 종료 확인 영수증 뒤에 다시 부르면 `transition_denied`(처리기의 `already_ended`)다. `queued`에서 취소한 뒤 다시 부르면 `transition_denied`다.

**넣지 않는 것:** 목적의 자유 글(`brief`), 원문, 실행기 ID, 계정·자격, 모델 이름, 경로. 세션 ID와 호출 ID는 부탁을 기록·취소한 호출의 기록이고 판단(소유·중복·충돌)에 쓰지 않는다. 이은 부탁의 취소는 부탁 줄에 남지 않는다. 시작 뒤 지시를 적었을 때만 실행의 지시(요청 ID = 호출 ID)로 남고, `queued`에서의 취소는 지시가 없어 그 세션 ID·호출 ID가 지시에도 부탁의 취소 칸에도 남지 않는다. 입력이 그 소유자의 고정된 입력인지(`inputPinned`), 지금 호출권을 가진 세션인지(`liveSession`), 결과(`readResult`)는 이 표가 답하지 않는다.

**배정기와 조립 코드가 지킬 것:**

1. 실행기·자격·기한·예산은 실제로 고른 값만 넘긴다. 맞는 실행기가 없으면 부르지 않고 부탁을 대기로 둔다. 이을 부탁은 `listWaitingToolRequests()`로 읽고, 고르는 쪽은 항목의 `input`(취소·만료)을 먼저 거른다. 장부의 잇기도 같은 조건을 다시 보므로 그 거절(`input_cancelled`·`input_expired`)은 부탁을 대기로 남긴 채 따른다.
2. 배정한 실행의 시작(`startRun`)과 지시의 전송은 배정과 따로다. `assigned`의 실행은 `queued`이고 시작 보장이 아니다.
3. 이은 부탁의 취소가 돌려준 `instruction`을 그 값(요청 ID, 정지 세대)과 `reason: "requested"`로 실은 `task_cancel`로 보낸다. 답을 받지 못한 지시는 `unansweredInstructions()`가 같은 본문으로 다시 낸다(위 "답을 받지 못한 지시"). 다시 보내지 않으면, 보내기 전에 끊긴 실행은 장부를 단순히 다시 열면 `stopping`으로 남고 스케줄러(`nextIntent`)는 답을 기다린 뒤 조회를 낸다. 재시작 복원의 3단계(`markLost`)를 거치면 `unknown_running`이 되고 그 실행의 상태 조회(`statusQueries`)가 바로 나온다. 어느 쪽이든 슬롯은 쥔 채다. 장부는 전달 여부를 적지 않고 맞는 영수증의 유무로만 가른다. 다시 보내는 일(봉투를 만들고 싣는 것)은 조립 코드의 몫이다.
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

**방법.** 장부를 쥔 연결의 `serialize()`로 커밋된 그림을 메모리에 받고, 그 그림을 메모리 DB로 열어 사본 기록을 넣은 뒤(판 6부터는 같은 그림에 사본의 경계 `snapshot_run_bounds`(그 그림의 `runs.queue_seq` 최댓값)도 넣는다. 경계 INSERT가 오류 없이 0줄로 끝나면 `snapshot_unsupported`, 예외를 내면(판의 트리거가 `RAISE(ABORT)`로 막는 때 등) `io`다. 어느 쪽이든 사본 파일은 생기지 않는다), 그 바이트를 임시 이름에 쓰고 fsync하고 `link`로 최종 이름을 붙인다. 사본 기록이 없는 온전한 장부가 디스크에 놓이는 순간이 없다. 다른 연결은 `locking_mode=EXCLUSIVE`인 장부를 읽지도 못하므로(`SQLITE_BUSY`) 장부를 쥔 연결이 만들어야 한다.

**버린 방법.** 파일 복사는 살아 있는 장부의 FD를 열었다 닫아 잠금을 푼다. `VACUUM INTO`는 이미 있는 빈 파일을 덮고 끊어진 링크를 따라가며, 끝난 파일에 사본 기록을 넣기 전까지 원본과 구별되지 않는 파일이 디스크에 남는다. 온라인 백업 API는 `bun:sqlite`에 없다.

| 실패 사유 | 뜻 |
|---|---|
| `target_exists` | 그 경로나 그 곁 파일 자리에 이미 무언가 있다(빈 파일, 링크 포함). 덮지 않는다 |
| `target_refused` | 장부 자신과 그 곁 파일의 자리, 링크가 낀 폴더, 없는 폴더 |
| `too_large` | 장부나 사본이 `maxBytes`보다 크다 |
| `in_transaction` | 열린 트랜잭션 안에서 불렀다. 그 연결의 그림에는 커밋되지 않은 페이지가 보인다 |
| `snapshot_hold` | 대조가 끝나지 않은 장부다. 사본의 출처가 흐려지므로 만들지 않는다 |
| `snapshot_unsupported` | 호출자가 넘긴 판 목록이 사본을 지원하지 않는다: 사본 기록의 표가 없거나, 사본 기록이 최신 미대조 기록으로 들어가지 않거나, 경계의 표가 있는데 경계 INSERT가 오류 없이 0줄로 끝나거나, 판이 사본 표식의 칸(`user_version`)을 쓴다. 사본 기록·경계의 INSERT가 예외를 내면 이 이름이 아니라 `io`다 |
| `ledger_unwritable` | 장부가 닫혔거나 실패했거나, 시계를 읽지 못했거나 그 값을 믿을 수 없다 |
| `io` | 사본 파일을 쓰지 못했다. 장부는 계속 쓸 수 있고 임시 파일은 지운다. 메모리 그림에 사본 기록·경계를 넣는 INSERT가 예외를 낸 때(판의 트리거가 `RAISE(ABORT)`로 막는 때 등)도 이 이름이다: 파일은 생기지 않고 원본 장부에는 아무것도 적지 않는다 |

**쓰기가 막히는 정도.** 동기 호출이라 끝날 때까지 이 프로세스의 쓰기와 읽기가 모두 기다린다. **막히는 시간의 상한은 없다.** 시간은 장부 크기와 디스크에 달려 있고(`fsync`가 늦으면 작은 장부도 그만큼 막힌다) 제한 시간이나 취소가 없다. `maxBytes`가 보장하는 것은 하나다: 장부(그림을 뜨기 전에 검사)나 사본 기록을 넣은 결과(그 뒤에 검사)가 이 크기를 넘으면 사본을 내지 않는다(`too_large`). 실제로 막힌 시간은 성공한 결과의 `blockedMs`로 돌려준다. 메모리는 그림, 메모리 DB, 최종 바이트가 잠시 함께 있어 장부 크기의 최대 세 벌과 런타임의 몫이 더 든다. `maxBytes`는 프로세스 메모리의 상한도 아니다.

**끊겼을 때.** 최종 이름은 fsync 뒤에만 생긴다. 끊기면 `<path>.partial-<UUID>`만 남는다. 쓰다 끊긴 파일은 `corrupt`로 열리지 않고, 끝까지 쓴 임시 파일은 사본 기록이 있어 보류로 뜬다. `link`와 `unlink` 사이에서 끊기면 이름이 둘이라 받지 않는다.

## 사본에서 뜬 장부의 보류

백업에서 복원한 장부는 옛 시점이라 계정 잠금과 영수증이 옛것일 수 있다(D-56). 사본 기록이 있고 대조가 끝나지 않은 파일은 열리지만 새 업무를 열지 않는다.

| 쪽 | 쓰기 | 보류 중 |
|---|---|---|
| 여는 쪽(쓰기 모드 `start`) | `enqueueInput`, `recordToolRequest`, `assignToolRequest`, `admitRun`, `startRun`, `startSession`, `recordPublication`, `recordRenewInstruction`, `markStartDispatch`, `closeUnreceivedRun` | `snapshot_hold`로 거절 |
| 닫는 쪽(`continue`) | `applyStop`, `mergeStop`, `setPause`, `cancelInput`, `cancelToolRequest`, `recordStopInstruction`, `recordFinalizeInstruction`, `markResult`, `markCleanupPending`, `recordBudget`, `markLost`, `markLostFor`, `applyExecutorAnswer`, `holdSlots`, `recordRunSightings`, `recordAnswerSightings`, `clearSlotHold`, `applyReceipt`, `recordReport`, `settleReport`, `setProcessedSeq`, `planRotation`, `settlePublication`, nonce 소비 | 막지 않는다 |
| 근거·풀기(`new`) | `applyRuleCheck`, `releaseStop`, `confirmSnapshotReconciled`, `closeRunByOperator` | 막지 않는다. `releaseStop`은 보류를 풀지 않는다 |

- **읽기:** `snapshotOrigin()`은 원본이면 `null`, 사본에서 떴으면 `snapshotId`, `ledgerId`, `takenAt`, `reconciledAt`, `held`, `mayBeStale`(`account_locks`, `receipts`)을 낸다. 복원 5단계도 같은 값을 `snapshotOrigin`으로 내고, 보류면 `intakeMayOpen: false`, `closedBecause`에 `snapshot_hold`다.
- **요청 예산의 예약도 옛것일 수 있다:** 사본 뒤에 시작한 실행이 없어 `listRuns()`의 예약이 적게 나온다. `mayBeStale`에는 이 이름이 없으니 대조 절차가 따로 확인한다("스케줄러가 쓰는 읽기"의 "요청 예산의 예약").
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
| 2 | 필수 이웃이 정확히 한 번씩 답했는지와 이웃마다 그 이웃의 계약 판·정책(`PeersPort`, 아래 "이웃의 판과 정책")을 보고, 실행기의 점유(`OccupancyPort`)를 실행 ID·세대·지정 실행기·양쪽 상태(끝난 상태 포함)로 장부와 대조. 대기 줄과 장부 밖 실행의 관측은 끝났다는 답이어도 `slot_holds`에 남기고, 이미 시작한 줄은 활동 중이라는 답만 남긴다(끝났다는 답이나 끝난 상태끼리 이름만 다른 답은 불일치 목록에만 나온다. 그 줄이 슬롯을 계속 쥐거나 이미 끝나 있어 다시 시작될 수 없다). 슬롯 종류를 모르는 실행기가 답한 장부 밖 실행은 적을 수 없어 접수를 보류한다. 지정 실행기가 같은 세대로 `not_known` 밖을 답한 항목은 판정과 따로 양성 관측(`run_sightings`)으로 적고, 적지 못하면 이 단계가 실패한다("실행기의 답") | 종료 대상(장부 밖 실행, 장부에서는 끝났는데 실행기가 쥔 실행), 점유 불일치, 남긴 관측, 슬롯 종류를 모르는 실행기, 전체 점유를 확인하지 못한 필수 실행기, 다시 물을 실행, 판이 다른 이웃, 정책이 맞다고 확인되지 않은 이웃, 빠진·겹친 이웃 |
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
  - **시작의 접수 영수증을 받은 뒤에만 갱신을 발급한다.** 배정기는 그 시작의 접수 영수증을 장부가 받은 뒤에만 갱신을 기록·발급한다. 시작을 접수하기 전에 닿은 갱신은 실행기가 모르는 실행으로 거절하고, 장부만 연장된다("갱신 뒤의 임대"의 "가정 넷이 보장하지 않는 것").
  - **작업 기한이 여유 안에 끝나는 실행에는 갱신을 살아 있음의 근거로 삼지 않는다.** 기한이 `발행 시각 + RENEW_MARGIN_MS` 안에 오면 갱신이 실행기에 닿기 전에 기한으로 끝날 수 있다. 기한의 처리는 수명 판단의 기한 길을 따른다.
  - **정책의 갱신 간격은 판단의 지연과 기록부터 송신까지의 시간을 갱신 구간에서 빼고 정한다.** `renewEveryMs = 17000`이면 구간이 0ms라, 정각에 판단·기록해도 싣기까지 1ms가 들면 송신 규칙으로 싣지 않는다(장부에는 발급한 끝이 남는다). 두 시간의 운영 상한은 정해지지 않았다.
  - 계속 실행할 수 있는 상태에서 임대 끝을 모르거나 여유가 없으면 같은 ID를 조회하고, 취소·기한·종료·결과 처리는 실행 상태에 따른다.
- **요청 예산(D-105·D-106 후보, "스케줄러가 쓰는 읽기"의 "요청 예산의 예약"):** 뒤 작업이 지킬 것:
  - **`start_worker` 어댑터:** 같은 요청의 대기 실행이 `request_budget_exceeded`·`budget_exhausted`로 보류될 수 있다. 한도가 찬 요청의 새 부탁을 접수 때 거절할지, 대기로 두고 단계로만 보일지는 그 작업이 정한다(지금 도구 처리기의 거절 목록에 예산 사유가 없다). 요청별 남은 몫은 `listRuns`의 `reservedBudget` 합과 설정의 출처별 한도로 계산하고, 예약을 모르는 줄이 있으면 남은 몫도 모름이다.
  - **D-90 자동 닫기를 부르는 박자:** D-90으로 닫으면 그 실행의 예약이 0으로 돌아와 같은 요청의 다음 작업이 그만큼 더 받는다. 닫기 조건이 감액 없음(`budget_reduced`)을 이미 보므로 새 조건은 없다.
  - **관측만 적는 연산:** 예약은 시작 지시와 D-90 근거로만 정해지므로 관측 기록은 예산에 닿지 않는다. 새 연산이 `instructions`·`unreceived_closures`·`operator_closures`를 쓰면 이 규칙을 다시 본다.
  - **계측:** `recordBudget`을 실제로 부르는 작업은 남은 예산 0을 적으면 같은 요청의 다른 작업도 순번·한도와 무관하게 막힌다(`budget_exhausted`)는 것을 함께 정한다. 작업 하나가 제 예산을 다 쓴 것과 요청 전체가 바닥난 것을 지금 판단은 가르지 않는다.
  - **작업자 자리를 늘리거나 배정 박자를 겹치는 작업:** `startRun`이 요청 한도를 다시 보지 않는 전제가 깨지므로, 시작 트랜잭션이 같은 합을 다시 보게 한다(그때 한도를 장부에 고정하는 판도 함께 본다).
  - **복원·대조 절차:** 대조에서 사본 뒤에 시작한 작업을 찾아도 지금은 그 예약을 장부에 적거나 그 입력을 막는 연산이 없다. 찾았을 때 무엇을 할지(입력 취소, 예약을 적는 연산 등)는 그 절차를 다루는 작업이 정한다.
- **연결 상실 반영(`markLostFor`를 부르는 쪽):** 장부는 언제 끊겼다고 볼지 판정하지 않고, 이 연산을 부르는 순환도 없다. 부르는 쪽이 지킬 것:
  - **끊김을 판정한 그 실행기 이름으로만 부른다.** 이름은 실행 줄의 지정 실행기(`executorId`)와 같은 값이다. 연결 하나의 끊김에 `markLost`(전부 옮기기)를 부르지 않는다. 판정한 뒤 그 실행기의 실행에 갱신을 기록하기 전에 부른다(옮긴 뒤에는 장부가 갱신 기록을 거절한다).
  - **자리를 푸는 근거로 쓰지 않는다.** 연결의 끊김이나 철회(`withdrawn`)는 종료의 증거가 아니다. 끊김은 실행을 `unknown_running`으로만 옮기고 자리는 그대로 쥔다. 작업자는 정리 영수증으로 `finalized`가 된 뒤에야, 세션은 인수의 별도 규칙에 따라 자리를 놓는다(위 "자리와 임대").
  - **답의 실행마다 같은 ID로 조회한다.** 다시 붙으면 답의 `runId`로 조회를 낸다. 그 답은 `applyExecutorAnswer`로 넘긴다(아래 "실행기의 답을 넘기는 쪽"). `not_known`은 종료의 증거가 아니다(위 "실제 연결").
  - **실패하면 다시 부른다.** `ledger_unwritable`이면 옮기지 못한 것이다. 장부는 못 씀이라 새 갱신 기록도 거절하지만, 성공적인 재시도나 후속 증거가 있기 전까지 그 실행은 직전 상태(`running` 등)로 남는다. 재시작 전에도 같은 장부 객체에서 다시 불러 성공할 수 있다. 다시 불러도 이미 옮긴 실행은 세지 않는다.
- **실행기의 답을 넘기는 쪽(`applyExecutorAnswer`를 부르는 쪽):** 장부는 답을 받아 반영할 뿐 언제 받았는지, 어느 조회의 답인지 보지 않는다. 이 연산을 부르는 처리기·순환은 아직 없다.
  - **검증된 봉투의 값만 넘긴다.** `sender`는 답 봉투의 낸 쪽, `answeredAt`은 그 봉투의 `issued_at`, `runs`는 검증된 본문의 `runs` 그대로다. 조회의 답은 감독이 그 연결에 낸 조회와 대조한 것(`status_matched`)만 `partial`로 넘긴다. `full`은 그 연결의 검증된 `hello`만이다. 부분 답을 `full`로 넘기지 않는다: 뒤 조각이 `full`을 "그 실행기가 쥔 전부"로 읽는다. 인사의 `issued_at`은 받은 시각과 다르고 지금의 인사·점유 출력에는 서명된 시각이 남지 않으므로 원 봉투의 값을 따로 전달한다(모르면 `null`로 넘긴다. 그때 `not_known`으로는 임대를 거두지 않는다).
  - **소비하는 때에도 연결을 대조한다.** 같은 주체의 연결 1을 연결 2가 대체한 뒤, 연결 1에서 이미 만들어 전달을 기다리던 답은 그대로 넘기면 장부가 받는다(장부 인자에 연결이 없다). 대기 조회와 소비할 출력을 연결 번호에 묶고, 철회된 연결의 답이 지금 실행의 임대를 바꾸지 못하게 한다. 그 답에 실린 양성 관측은 받을 때 유효했으므로 따로 남긴다(`recordAnswerSightings`, 아래 "관측만 적는 연산을 부르는 쪽").
  - **실패면 같은 답을 먼저 다시 넘긴다.** 실패(`ok: false`)는 아무것도 적지 못한 것이다. `unsavedSightings`가 비어 있지 않으면 그 실행기의 더 새 답보다 먼저 이 답을 같은 값(`coverage`·`runs`·`answeredAt`)으로 다시 넘긴다. 새 답만 넘기면 그 사이에 그 실행을 빼먹은 답이 "안다고 한 적이 있다"를 지운다. 다시 넘길 때 이미 지나간 상태 전이를 나중 답 위에 재생하지 않도록, 처리는 받은 순서대로 한다. 상태 보고는 실행기가 다시 보내지 않으므로 다시 넘길 답은 부르는 쪽이 붙든다. 프로세스가 다시 떠 이 답을 잃은 경우는 아래 D-90의 조건이 막아야 한다.
  - **`deferred`면 같은 ID를 다시 조회한다.** 보류한 실행은 그대로 `preparing`·`running`이다. 시작 영수증이 오면 정상으로 이어지고, 시작 발행 + `RUN_LEASE_MAX_MS` 뒤에 만든 `not_known`이 오면 옮긴다.
  - **자리를 푸는 근거로 쓰지 않는다.** 옮긴 실행은 자리를 쥔 `unknown_running`이고, 답이 돌려준 `outsideLedger`의 세대는 닫는 지시에만 쓴다. 운영 중 `queued` 실행의 양성 관측은 시작을 막지 않는다(복원의 `slot_holds`와 뜻이 다르다). 끊김으로 이미 `unknown_running`이 된 실행은 D-92대로 갱신하지 않고, 종료·정리 뒤 필요하면 새 실행 ID로 맡긴다(누가 언제 다시 맡기는지는 관리자 미결정).
- **관측만 적는 연산을 부르는 쪽(`recordAnswerSightings`. 영수증 처리기와 인사 처리기가 부른다(A6d): `src/supervisor/dispatch/receipts.ts`의 `recordSighting`)이 지킬 것:**
  - **인정이 끝난 연결의 "안다"는 답에만 부른다.** 연결 판단이 지금 연결이 아니라서(`not_current`) 버린 답 가운데, 받을 때 검증·인정을 마친 연결의 답, 곧 소비할 때 그 연결이 대체되었거나 대기 사본이 된 답(조회 답의 `status_not_current`, 밀린 사본의 `not_current`, 인사의 `not_current`)만 넘긴다. 장부는 연결을 보지 않고 `sender`를 그대로 믿으므로 검증되지 않은 봉투나 인정되지 않은 연결의 답을 넘기지 않는다. 값은 `applyExecutorAnswer`를 부르는 쪽과 같이 검증된 봉투의 것 그대로이고, `coverage`도 바꾸지 않는다. 지금 연결의 답은 이 연산이 아니라 `applyExecutorAnswer`로 넘긴다(임대를 거두는 판단은 그쪽에만 있다).
  - **`ok`면 그 답의 사본을 놓아 준다.** 관측은 장부에 있으니 다시 넘기려고 쥐고 있을 까닭이 없다. 그 사본이 그 실행기의 뒤 답을 막고 있었다면 이때 푼다.
  - **실패(`ok: false`)만 오염으로 남긴다.** `unsavedSightings`가 비어 있지 않으면 그 답을 같은 값으로 다시 넘기기 전까지 그 실행기를 D-90 닫기 후보에서 뺀다. 비어 있으면 붙들 관측이 없다. 이 기억은 메모리에만 있으므로, 프로세스가 다시 떠 잃은 경우는 장부의 `sent_by_other_open`(다른 열기의 표식)에 기댄다.
  - **이 답을 닫기의 근거로 쓰지 않는다.** 옛 연결의 `hello`를 `full`로 적어도 이 연산은 목록에 없는 실행을 보지 않는다. 같은 답을 `closeUnreceivedRun`의 `runs`로 넘기지 않는다(그 연산은 지금 연결의 검증된 `hello`만 받는다).
- **D-90 닫기 박자(A6c)가 이 관측을 쓰는 법:** `recordAnswerSightings`가 적은 관측은 닫기 거절 `run_sighted`의 재료다. 장부가 닫는 트랜잭션에서 다시 보므로 박자가 `hasRunSighting`으로 미리 걸러 낼 필요는 없다(걸러도 판정은 같다). 관측 유실로 인한 오염 가운데 박자가 스스로 갖출 것은 이 연산이 실패한 답(위의 오염)과 이 연산을 부르기 전에 버려진 답뿐이다. 그래서 "앞선 답이 버려진 적이 있는 실행기"를 통째로 빼던 범위가 "적기에 실패한 답이 있는 실행기"로 준다(부르는 쪽이 위 규칙대로 부를 때).
  - **처리 대기 중인 양성 답이 있으면 장부만 읽어 닫지 않는다(함정).** 장부는 아직 받지 못한 관측을 모른다. 그 실행기의 양성 답을 받았지만 아직 장부에 넘기지 않았으면(답 줄·대기 사본에 남음, `applyExecutorAnswer`·`recordAnswerSightings`로 저장하기 전) 그 실행기를 닫기 후보에서 뺀다. 예: 시작 표식이 있는 실행 R에 시한 뒤 빈 full을 먼저 반영하고, 같은 현재 연결의 뒤 조회 답(R이 `finalized`인 partial)을 메모리에 둔 채 그 full로 닫으면 `not_started`로 닫힌다. 그 뒤 답을 반영해 관측이 참이 되어도 닫힌 상태는 그대로다. 답을 먼저 반영하면 `run_sighted`다. 대기 사본과 복원 2단계 미완료도 닫기를 보류한다는 조건과 같은 성질이다.
- **D-90의 닫기를 부르는 쪽(판 6의 `markStartDispatch`·`closeUnreceivedRun`. 표식은 `src/supervisor/dispatch/send-gate.ts`가 부르고, 닫기를 부르는 감독 코드는 아직 없다)이 지킬 것:**
  - **시작 봉투는 표식 뒤에만 싣는다.** 모든 최초 송신과 재전송은 같은 장부 객체의 `markStartDispatch`가 성공(`ok`)한 직후에만 `task_start`를 내보낸다. 표식이 거절·실패하면 보내지 않는다. 실제로 보내는 지점이 하나뿐임을 그 조각의 정적 시험으로 고정한다.
  - **후보를 고르는 것은 부르는 쪽이고, 넘기는 답은 그 연결의 검증된 `hello` 원본이다.** 시한이 지난 시작(`unansweredInstructions()`의 시작 항목)의 실행기에서 그 시한 뒤에 만든 검증된 `hello`를 받으면 그 원본의 `sender`·`runs`·`issued_at`·받은 시각을 함께 넘긴다. 양성 답은 받은 순서대로 보존하고, 같은 전체 답을 `applyExecutorAnswer({ coverage: "full" })`에 닫기보다 먼저 반영한다. 부분 답(`status_report`)·오래된(대체된) 연결의 답·`outsideLedger`를 빈 전체 답으로 바꿔 넘기지 않는다. 실행기가 자기 기록만 잃고 프로세스가 남은 경우(R1)는 장부가 막지 못한다: 실행기 저장소의 유실 감사와 프로세스 생존 보증의 몫이다.
  - **거절이면 지금 상태를 유지한다.** 거절된 실행은 자리를 쥔 채이고, 장부의 거절을 우회해 자리를 풀지 않는다. `unknown_running`의 임대는 되살리지 않는다(D-92). 다른 열기의 표식·사본 안·경계 모름·판 이전·예산 감액으로 거절된 실행은 관리자 닫기(D-91)로 간다. D-91은 관리자가 종료 근거를 확인한 뒤 `closeRunByOperator`로 별도 표에 적는다(위 "관리자가 실패로 닫기").
  - **관리자 닫기를 부르는 쪽(관리 진입점·CLI 명령)이 지킬 것:** **새 작업자 파드가 닫을 수 있게 되는 시각(그 실행의 `task_start`·`run_renew` 지시의 발행 최댓값 + 31000ms) 뒤에 떴고, 그 사실을 근거에 남긴 뒤에만 닫는다.** 명령은 "작업자 파드를 지워 새로 띄웠는가"를 사람에게 확인받고(확인 방법은 `pod_replaced` 하나, D-96), **쿠버네티스에서 새 작업자 파드의 이름과 뜬 시각을 함께 읽어 넘기며 지어내지 않는다(D-97).** 넘기는 시각은 그 파드의 실행기가 뜬 시각보다 늦지 않아야 한다(준비가 끝난 시각처럼 실행기가 이미 돌던 뒤의 시각은 안 된다). 초 단위의 시각을 내림해 넘기는 것은 거절 쪽이라 괜찮다. **한도 전에 뜬 파드면 장부가 `pod_started_too_early`로 거절하므로 명령은 "파드를 한 번 더 바꾸세요"로 안내한다.** **"한도까지 기다린 뒤 파드를 교체하고, 새 파드가 뜬 시각을 다시 읽어 닫는다"는 이력이 맞고 시간이 모자란 경우에만 안내한다:** `start_may_launch`는 `now`가 한도 전인 경우(공개 입력이 `podStartedAt ≤ now`를 먼저 요구하므로 그 파드도 한도 전에 떴다. 같은 파드로는 기다려도 닫히지 않는다)와 `task_start`가 없거나 `session_start`가 섞인 이력(지시 줄은 바뀌지 않아 기다려도 풀리지 않는다)을 함께 낸다. 거절 순서상 이른 파드로 한도 전에 부르면 `start_may_launch`가 먼저 나오고, 같은 파드로 한도 뒤에 다시 부르면 `pod_started_too_early`가 나온다. 이름 하나로 원인을 가를 수 없으므로, 명령은 그 실행의 지시 이력(`task_start` 있음, `session_start` 없음)과 한도, 넘긴 파드의 시각을 함께 확인해 시간만 모자랄 때 그 시각을 보이며 그 시각 뒤에 파드를 교체하라고 안내하고, 이력 때문이면 기다려도 닫히지 않는다고 보인다. 장부는 파드가 바뀌었는지, 넘긴 시각이 맞는지 확인하지 못한다: 값이 틀리면 옛 실행기나 새 파드가 아직 띄울 수 있다(위 "관리자가 실패로 닫기"의 "이 판이 막지 못하는 것"). 접수 영수증이 없는 실행을 닫으려 할 때는 "실행기가 다시 답하면 자동으로 풀릴 수 있고, 지금 닫으면 실패로 남아 시작 예산이 같은 요청의 한도에서 빠진 채로 남는다"를 사람에게 보인다(D-94). 장부의 거절 이름을 그대로 관리자에게 보인다(거절이면 자리는 그대로다). 성공 출력은 두 가지를 따로 읽어 보인다: 그 실행이 쥔 자리를 놓았다는 것(닫기의 성공)과 작업자 자리를 실제로 쓸 수 있는지(`slotFree("worker")`, 점유 관측이 있으면 `false`이고 그 관측은 따로 푼다). 파드 이름은 운영 장부에만 남고 로그·공개 출력에 옮기지 않는다. 관리자가 닫은 실행은 이미 돌았을 수 있어 시작 예산 전부가 같은 요청의 한도에서 빠진 채로 남는다(위 "관리자가 실패로 닫기"의 "요청 예산").
  - **경보를 밖으로 낸다(D-127·D-128).** `applyReceipt`의 답에 `alarm: "closed_run_started"`가 있으면 ack와 별도로 관리자에게 전달한다: 영수증 처리기(`src/supervisor/dispatch/receipts.ts`)가 결과의 `alarm`(실행 ID와 함께)으로 옮기고, 조립이 감독 로그 `ledger_alert` 한 줄로 낸다(`src/supervisor/runtime/boot.md` S43). 재전송(`duplicate`)의 경보도 같은 한 줄이다(반복을 줄이는 규칙은 관리자 결정 대기). 경보 칸 때문에 ack를 막지 않는다. 자리는 닫은 뒤 새 시작 영수증 ID를 처음 받을 때마다 장부가 이미 다시 막았고(새 ID마다 경보와 점유를 낸다), `clearSlotHold`는 같은 관측 번호에 대한 종료 확인 뒤에만 쓴다. **경보만으로 자리가 막혔다고 표시하지 않는다:** 닫기 전에 받은 다른 ID의 시작 영수증의 재전송은 경보만 싣고 점유는 적지 않는다. 자리는 `slotFree`·`slotHolds()`로 따로 읽는다. 운영 중 양성 답만 먼저 온 때는 아래 "닫힌 실행이 아직 돈다는 운영 답"대로 경보만이고 자리는 막지 않는다(D-128).
  - **닫힌 실행이 아직 돈다는 운영 답은 경보만 싣는다(D-128).** 닫은 뒤 지정 실행기가 같은 ID·세대를 `running`으로 답하면(`full`·`partial` 모두) `applyExecutorAnswer`는 `ok`에 `moved`·`deferred`·`outsideLedger`가 비고 `alarms`에 `closed_run_running`을 싣는다(위 "실행기의 답"). 양성 관측 한 줄만 남고 점유는 적지 않아 다음 시작은 된다(관리자 결정이 경보만이다. 자리를 다시 막는 것은 늦은 시작 영수증뿐이다). 감독은 E16과 같은 길로 낸다: 영수증 처리기·인사 처리기가 반영 결과(`applied`)의 `alarms`로 옮기고 조립이 `ledger_alert` 한 줄씩으로 낸다. 인정이 끝난 연결의 답(`recordAnswerSightings`)과 복원 2단계의 관측(`recordRunSightings`)은 경보를 싣지 않는다.
- **D-90의 닫기(판 6)가 판 5에서 이어받은 조건:** 양성 관측은 판 5부터 쌓인다. 판 5 전에 받은 답은 표에 없으므로 그 전에 시작한 실행에는 "관측 없음"이 "안다고 한 적 없음"의 증거가 아니다(판 5를 적용하기 전에 받은 답은 어디에도 적히지 않았다. 감독은 배포된 적이 없어 지금 이런 실행은 없다). 닫는 트랜잭션 안에서 `run_sightings`에 그 실행의 줄이 하나도 없음과 그 실행의 영수증·보고가 없음을 다시 본다(`hasRunSighting`의 읽은 값을 넘겨받지 않는다). `full` 답이 그 실행을 빼먹은 것은 이 표에 남지 않으므로(관측은 `not_known` 밖만 적는다) 닫는 근거는 그 조각이 따로 남긴다. 표의 칸·트리거는 바꾸지 않고 쓴다(이관은 병합 뒤 고칠 수 없다. 필요한 표나 칸은 그 조각의 이관이 더한다).
  - **0행만으로 판정하지 않는다.** 0행은 저장에 실패한 관측이 없었을 때만 "본 적 없음"이다. 양성 관측의 저장에 실패한 뒤 프로세스가 다시 떠 원래 답을 다시 넘길 수 없으면 0행이 거짓이 된다. 같은 복원기 객체에서도 양성 답을 받은 뒤 2단계의 실행 목록 읽기가 실패하면 그 답은 붙들리지 않고 사라져 0행이 거짓이 된다. 그 조각은 이 공백(저장 실패, 읽기 실패, 재시작)을 걸친 실행을 자동 해제에서 빼는 조건을 스스로 갖춘다. 판 5 전의 실행, 사본에서 되살린 뒤 확인할 수 없는 기간도 같다.
  - **증거를 한 번에 본다.** 지정 실행기·세대, 영수증·보고 0, 양성 관측 0(위 조건을 갖춘 이력), 시작 재송신 중단, 실행기 시계로 시작 발행 + 30000ms 이후에 만든 전체 답에 그 실행이 없음을 같은 트랜잭션에서 확인하고 닫은 근거를 같은 커밋에 남긴다. 부분 답·`outsideLedger`·읽기 실패에는 해제 권한이 없다.
- **재전송(답을 받지 못한 지시):** 장부는 `unansweredInstructions()`로 지시와 본문 칸을 낼 뿐 보내지 않는다. 다시 보내는 쪽이 지킬 것:
  - **같은 요청 ID·같은 본문을 새 봉투에 담는다.** 실행기는 같은 nonce를 한 번만 받으므로 봉투를 그대로 다시 보내지 않는다. 시작은 장부의 발행 시각으로, 취소·세션 정지·확정은 봉하는 때의 시각으로 봉한다(위 "다시 봉한 봉투"). 재전송은 장부에 새 줄을 쓰지 않는다. 새 요청 ID로 다시 내면 지시 줄이 하나 더 생기고, 그때는 이번 발행 시각을 판단과 같은 시계로 적는다.
  - **항목의 정지 세대가 장부의 지금 세대와 다르면 보내지 않는다.** 실행기가 그 지시를 받는지는 실행기가 적용한 세대에 달렸다. 머리의 정지 세대는 실행기의 값과 정확히 같아야 하고 높은 세대를 받는 것은 비상 정지의 종료(`reason`이 `emergency_stop`)뿐이라, 실행기가 새 세대를 적용한 뒤에는 옛 세대의 지시를 받지 않는다. 적용하기 전이면 받을 수 있고, 그러면 장부가 이미 넘어선 세대의 지시가 실행된다. 그래서 항목의 `stopGeneration`과 결과의 `stopGeneration`(지금 값)이 다르면 송신을 건너뛰고, 실행기와 세대를 맞춘 뒤 종료는 새 세대의 비상 종료로, 확정은 새 세대·새 요청 ID의 확정으로 낸다.
  - **시작은 시한 안에서만 다시 보낸다.** 시작은 장부의 발행 시각을 그대로 실으므로 봉투 시한(발행 + 기본 수명)이 지나면 다시 봉하지 못한다(`too_late_to_send`). 같은 실행에 시작과 종료가 함께 답이 없으면, 시작을 다시 보내면 실행이 열렸다가 곧 닫힌다. 모르는 실행의 종료는 실행기가 아무것도 하지 않으므로 종료만 보내면 답이 없다. 어느 쪽을 보낼지는 부르는 쪽이 정한다.
  - **다시 만들 수 없는 지시(`rebuild: null`)는 보내지 않고 같은 실행 ID의 조회로 돌린다.** 그래서 종료·확정을 적을 때 본문 칸(`reason`, `outcome`·`resultDigest`·`storedAt`)을 **늘** 넘긴다. 빼고 적은 지시는 영영 다시 만들 수 없고, 같은 요청 ID로 나중에 채울 수도 없다(위 "같은 요청 ID로 다시 적기"). 조립 코드의 쓰기 포트는 본문 칸을 필수로 받고, 같은 인자를 처음 봉투와 장부에 넘긴다.
  - **D-90(받은 적 없는 실행의 자리):** 조건 셋 가운데 "접수 영수증이 한 번도 없음"의 판정에 이 읽기만 쓰지 않는다. 이 읽기에 그 실행의 `task_start`가 나오면 장부에 저장된 그 실행의 영수증·보고가 하나도 없다는 뜻일 뿐이다. "그 실행기가 이 실행 ID를 안다고 한 적도 없다"는 결론에는 실행기의 과거 점유 응답(그 실행을 쥐고 있다고 답한 적이 있는가)도 따로 본다: 양성 관측(`run_sightings`, 읽기 `hasRunSighting`)이다. 양성 관측과 충돌하면 자동 해제를 보류하고, 부분 응답을 조건 (3)의 전체 점유 응답으로 쓰지 않는다. "시작 지시를 더 보내지 않고 마지막 봉투의 시한이 지남"의 시각은 이 읽기로 정해진다: 실행 하나의 시작 지시는 하나이고(`startRun`은 `queued`에서만), 그 봉투는 다시 봉해도 장부의 발행 시각을 실어 시한이 모두 항목의 `issuedAt` + 기본 수명이다. "더 보내지 않음"은 시한이 지나면 저절로 참이다(그 뒤에는 유효한 시작 봉투가 없다). "그 뒤의 전체 점유 답에 없음"은 연결이 받은 답을 `closeUnreceivedRun`에 넘겨 장부가 본다. 자리를 푸는 연산은 판 6의 `closeUnreceivedRun` 하나다("받은 적 없는 실행의 닫기").
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
6. 보류 상태에서 관리자가 계정 잠금과 영수증, 요청 예산의 예약("스케줄러가 쓰는 읽기"의 "요청 예산의 예약")을 대조한 뒤 `confirmSnapshotReconciled`를 부르고, 새 복원 시도를 끝까지 마친다.
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
