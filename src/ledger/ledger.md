# 감독 장부 요약

감독 장부(D-56)의 스키마, 쓰기 규칙, 재시작 복원 순서다. 코드는 `src/ledger/`(공개 면은 `index.ts`), 설계의 기준은 homelab `docs/plans/2026-11-13-olive/supervisor.md` §3·§6·§7·§8이다. 표와 코드가 다르면 코드가 맞고, 이 문서를 고친다.

## 파일과 잠금

- SQLite 파일 하나, 감독 하나만 쓴다. `openLedger(path, { clock, mode })`만 장부를 만든다(`Ledger`는 공개 면에 타입으로만 있고 생성자를 직접 부르면 던진다). 실패하면 장부 객체 없이 이유(`locked`, `corrupt`, `full`, `io`, `too_new`, `migration_mismatch`, `migration_failed`, `not_initialized`, `already_initialized`, `foreign_data`, `db_error`)를 돌려준다.
- **`mode`는 호출자가 고른다.** `reopen`은 보통의 기동이다: 파일이 없거나 비었거나 이 설치의 표식이 없거나 첫 설치 기록이 없으면(빈 볼륨, 빈 대체 파일, 다른 파일) 표를 만들지 않고 `not_initialized`로 닫는다. 그래서 장부를 잃은 볼륨이 첫 설치로 착각돼 정지 세대 0을 적는 일이 없다. 사본에서 되살린 장부의 보류는 이 작업 밖이다.
- **`create`는 첫 설치이고, SQLite가 파일이나 WAL을 건드리기 전에 디스크의 모양부터 가른다.** 받는 모양은 셋이다: 새 경로, WAL·SHM·저널의 흔적이 없는 0바이트 파일, 이 설치가 시작했다가 끊긴 파일. 이 설치의 파일은 SQLite 머리의 `application_id`(WAL로 바꾸기 전에 적어 본체 파일에 남는다)로 가르고, 이어 받을 때도 판 기록 없이 표가 있으면 받지 않는다. 비어 있지 않은 낯선 DB, 옛 스키마의 장부, 본체 없이 남은 WAL·SHM은 파일을 바꾸지 않고 `foreign_data`, 첫 설치를 마친 장부는 `already_initialized`, SQLite 머리가 아닌 파일은 `corrupt`다. 완전히 빈 볼륨이 정말 새 설치인지는 파일만으로 가를 수 없어 호출자의 `mode`에 맡긴다.
- **잠금:** `locking_mode=EXCLUSIVE`와 빈 `BEGIN IMMEDIATE`로 여는 순간 파일 잠금을 잡고 닫을 때까지 쥔다. 둘째 작성자는 같은 프로세스든 다른 프로세스든 `SQLITE_BUSY`로 `locked`다(`busy_timeout` 0). 프로세스가 죽으면 운영체제가 잠금을 푼다.
- **저널:** `journal_mode=WAL`, `synchronous=FULL`. 커밋마다 WAL을 fsync하므로 커밋을 돌려준 실행 줄은 전원이 나가도 남고, 감독은 실행 줄의 커밋 뒤에만 지시를 내므로 접수 기록이 영수증보다 먼저 남는다. `NORMAL`은 마지막 커밋을 잃을 수 있어 고르지 않았다. EXCLUSIVE라 `-shm` 파일이 없다. 로컬 볼륨 전제다.
- 열 때 `quick_check`로 깨진 파일을 거른다. `foreign_keys=ON`.

## 마이그레이션

`migrations/NNNN-이름.sql`을 번호 순서대로 한 번씩 적용한다. 판 하나는 트랜잭션 하나라 도중에 실패하거나 끊기면 그 판 전체가 되돌려진다. 적용 기록은 `ledger_migrations(version, name, applied_at)`. 번호가 비거나, 이름과 번호가 다르거나, 폴더에 꼴이 다른 파일이 있거나, 장부의 판이 코드보다 높거나, 같은 번호의 이름이 다르면 열지 않는다. 호출자가 `migrations`로 넘긴 목록도 같은 검사를 파일을 열기 전에 자리마다 거친다(배열의 빈 자리 포함). 적용 시각으로 쓸 시계의 값도 파일을 건드리기 전에 확인한다.

이 장부는 아직 어디에도 배포되지 않아 리뷰 반영을 `0001-core.sql`에 직접 고쳤다. **첫 배포 뒤에는 기존 번호를 고치지 않고 다음 번호로 더한다.**

## 표(0001-core)

| 묶음 | 표 | 요지 |
|---|---|---|
| 정지·일시 중지 | `stop_state`, `diagnosis_pause` | 정지 세대(0 포함, 줄이 없으면 아직 적지 않음), 정지 여부, 확인 단계, 진단 일시 중지의 끝 |
| 실행·슬롯·예산 | `runs`, `run_epoch`, `run_transitions`, `instructions`, `slot_holds` | 실행 ID·세대·역할·revision 둘·snapshot·실행기·자격 네 칸·기한·남은 예산·상태·영수증 id들. 낸 지시(v1 여섯, 적은 뒤 불변). 점유가 맞지 않은 관측: (실행기, 실행, 세대)마다 한 줄이고 관측 번호를 가진다. 줄이 있으면 그 실행 ID를 시작하지 않고, `holds_slot`이면 그 종류의 슬롯도 막는다 |
| 입력·대기열 | `inputs` | 요청 ID, 인증된 출처, 원문 참조(`<저장소>/<UUID>`)와 만료, 순번, 취소 |
| 영수증·보고 | `deliveries`, `receipt_conflicts`, `report_signals` | 받은 id와 본문 digest, 속한 실행(외래 키), 가리킨 지시, 결과 보고의 저장 자리·digest·반영 시각. 같은 id에 다른 digest의 기록. 훅·세션 깨짐 보고의 구조화 칸(사건 종류, `session_id`, 턴 ID, 오류 종류, 원인, 표식 digest, 관측 시각) |
| 세션·인계 | `sessions`, `rule_checks`, `session_takeovers`, `start_permit_uses` | 세션 ID, 시작 순번, 세대 표식 digest, 교체 시각, 처리 위치, 인계 참조, 규칙 확인(D-51)과 낸 쪽, 교체 기록(앞 실행·인수 발신자·표식·허가·확정한 규칙 확인·다음 실행, D-50), 시작 허가의 한 번 사용 |
| 게시 연결 | `publications` | 현관 작업 ID, 후보 digest, 대기·확정·모름(확정이면 posted·not_posted) |
| nonce | `nonces` | 감독이 받는 봉투의 (낸 쪽, nonce). 계약의 `NonceStore` |

`ledger_identity`(첫 설치 기록)는 마이그레이션이 아니라 `openLedger`의 `create`가 만든다.

**넣지 않는 것:** 원문(요청 글, 모델 출력, 로그)과 자격 값. 원문은 참조와 만료만, 자격은 계정·방식·revision·digest만 둔다. 쓰기 함수는 정해진 칸만 받고(모르는 칸이면 `LedgerInputError`), 칸마다 좁은 꼴만 받는다: 계정은 계약의 별칭 꼴(소문자·숫자·하이픈 32자), 방식은 `subscription`·`api_key`, 실행기는 계약의 실행기 주체 이름, 원문·결과 참조는 `<저장소 이름>/<UUID>`. `test/ledger/static.test.ts`가 스키마의 칸 이름과 쓰기 함수가 실제로 받는 칸(`exact`의 칸 목록, 인라인 인자 타입, 입력 타입)을 막는다.

**정수:** 장부 표의 정수 칸은 모두 0(또는 1)부터 9007199254740991까지다(STRICT 열의 CHECK, 쓰기 함수의 `Number.isSafeInteger`). `ledger_migrations`의 판과 적용 시각, `receipt_conflicts.seq`, `slot_holds.observation`도 같다. 예외는 SQLite가 관리하는 내부 표 `sqlite_sequence`뿐이다. 읽은 세대·예산이 안전 정수가 아니면 그 값으로 판단하지 않고 `corrupt`로 닫는다.

## 새 업무를 열어도 되는 조건

새 접수·실행 줄·시작·자격·게시·갱신(`enqueueInput`, `admitRun`, `startRun`, `startSession`, `recordPublication`, `recordRenewInstruction`)은 모두 한 자리(`Ledger`의 쓰기 모드 `start`)의 전제를 거친다.

1. 장부가 건강하다(한 번이라도 쓰기·읽기가 실패했으면 다시 열 때까지 `ledger_unwritable`).
2. 같은 트랜잭션 안에서 읽은 지금의 정지 기록이 있고(`stop_unknown`) 정지가 아니다(`stopped`).
3. 살아 있는 접수 허가가 있다(`intake_closed`).

**접수 허가는 "어느 복원 시도가, 어느 정지 세대에서 냈는가"에 묶인 한 자리다.** 장부는 열 때마다 허가 없이 시작하고, 복원 5단계만 허가를 낸다. 아래 가운데 하나가 일어나면 허가는 버려지고, 새 복원 시도가 1~5단계를 끝까지 다시 마칠 때까지 새 업무는 닫혀 있다.

- 정지 기록의 세대나 정지 여부가 바뀐다(`applyStop`, `mergeStop` 모두).
- 관리자가 푼다(`releaseStop`).
- 새 복원 시도가 시작된다(1단계 호출).
- 장부의 쓰기나 읽기가 실패한다.

복원 시도는 1단계에서 정지 기록을 합친 시점의 정지 상태에 고정된다. 그 뒤에 정지가 걸렸다 풀렸으면 그 시도의 5단계는 `stop_changed`로 닫힌다. 앞서 모은 대조가 풀리기 전의 것이기 때문이다. 더 새로운 시도가 시작된 뒤에는 앞 시도의 늦은 응답과 늦은 단계가 `RestoreStepError`로 실패하고 지금의 허가를 바꾸지 못한다.

**일반 기록과 풀기는 다르다.** `applyStop`은 이미 정지인 장부를 풀지 못한다. 세대가 더 높은 해제 값이 와도 세대만 오르고 정지는 남으며, 푸는 길은 `releaseStop` 하나다. 권위 기록을 합치는 `mergeStop`은 더 높은 세대의 해제를 사실로 적지만, 세대가 바뀌므로 허가는 없어지고 복원을 다시 마쳐야 열린다.

시작(`startRun`·`startSession`)은 여기에 더해 지시의 정지 세대가 장부의 지금 값과 같고, 실행 줄의 세대가 지금 실행 세대(`run_epoch`)와 같고(`run_generation_stale`), 그 종류에 슬롯 차단(`slot_holds`의 `holds_slot`)도 자리를 쥔 실행도 없을 때(`slot_busy`)만 된다. 시작 트랜잭션 안에서 이 실행 자체도 다시 본다: 이 실행 ID의 점유 관측이 남아 있으면 `run_blocked`, 연결된 입력이 취소됐으면 `input_cancelled`, 원문이 만료됐으면 `input_expired`, 실행 기한이 지났으면 `deadline_passed`다. 기한과 만료는 호출자가 넘긴 값이 아니라 장부에 주입한 시계로 잰다. 복원 5단계의 후보 목록도 같은 판정을 읽는다. 작업자는 v1 `task_start`를 만들 수 있는 줄(입력 digest가 있고 예산이 1 이상, 역할과 지정 실행기가 맞음)만 자리를 잡는다(`not_startable`).

종료 기록, 영수증·보고의 반영, 복원 자체의 쓰기, 조회는 이 전제 없이 된다. `Restorer.intakeOpen()`과 `Ledger.intakeOpen()`은 단계 결과가 아니라 지금의 장부(건강, 허가, 정지 기록)를 읽고, 읽지 못하면 `false`다. `Restorer.intakeOpen()`은 그 복원기가 낸 허가만 센다. 5단계의 `intakeMayOpen`은 허가를 낸 그 순간의 판정이라, 그 뒤에 정지가 걸리면 값은 `true`로 남아도 `intakeOpen()`은 `false`다.

## 쓰기 규칙

- **실행 줄이 먼저:** `admitRun`이 대기(`queued`)로 실행 줄을 적는다. `startRun`·`startSession`이 자리를 잡고(`preparing`) 시작 지시를 적은 커밋이 끝난 뒤에만 지시를 보낸다. 영수증은 장부에 적힌 지시만 가리킬 수 있다. 같은 중복 키는 같은 실행을 돌려준다.
- **영수증:** `applyReceipt(input, from)`의 `from`은 검증을 마친 봉투의 낸 쪽 주체 이름과 머리의 `run_generation`이다. 대조 순서는 발신자·실행·세대 → 이미 받은 id의 분류 → 새 id의 원 지시 대조와 효과다. 낸 쪽이 그 실행의 지정 실행기가 아니면 `sender_mismatch`, 세대가 다르면 `run_generation_mismatch`이고 충돌 기록을 포함해 아무것도 적지 않는다(ack·상태·슬롯이 그대로). 같은 id·같은 digest는 한 번만 반영하고 다시 받으면 `duplicate`(ack는 다시 준다). 같은 id에 다른 digest는 원 지시가 달라도 `receipt_conflicts`에 남기고 `receipt_conflict`. 새 접수 영수증은 원 지시의 이름(`instruction`, v1 여섯 가운데 하나)이 장부의 지시와 같아야 한다. 영수증과 그 상태 전이는 한 트랜잭션이다.
- **증거:** 실행 줄의 영수증 id 칸은 같은 실행이 받은 맞는 종류의 영수증만 가리키고 한 번만 채운다(트리거 `runs_evidence`). 정리 영수증은 그 실행의 `result_finalize` 지시를 가리킨다. 받은 기록, 낸 지시, 실행 줄, 규칙 확인, 교체 기록, 시작 허가의 사용은 지우거나 바꿔 넣지 못한다(트리거). TEXT 키의 표는 모두 `WITHOUT ROWID`라 rowid 충돌로 행이 교체되지 않는다.
- **상태 전이:** `states.ts`의 표만 허용한다. 같은 표가 장부의 `run_transitions`와 트리거에 있다. 종료 확인(`stop_receipt_id`) 없이 `checking`·`ready_result`·`failed_stopped`·`cleanup_pending`이 되지 않는다(CHECK). `not_started`는 지시를 내기 전(`queued`)에서만 간다. 종료 확인 영수증의 `exit`가 `completed`면 `checking`, 그 밖이면 `failed_stopped`다. `checking`에서 `unknown_running`으로 가는 길은 없다.
- **끊김 판정:** `markLost`는 종료 확인이 없는 `preparing`·`running`·`stopping`에만 계약의 `stateAfterLoss`를 쓴다(→ `unknown_running`). 계약의 함수는 종료 증명이 없는 실행기 쪽 상태의 함수라, 장부에서는 `stop_receipt_id`가 없는 줄에만 그대로 쓸 수 있다. 종료 확인이 있는 `checking`은 그대로 두고 결과 검사를 이어 간다.
- **슬롯:** 작업자 하나, 세션 하나(부분 유일 인덱스). `queued`·`finalized`·`not_started` 밖은 모두 자리를 쥔다. 그래서 `unknown_running`·`cleanup_pending`이 있으면 새 실행은 `slot_busy`다. 슬롯을 막는 관측(`holds_slot`)이 있는 종류도 `slot_busy`다.
- **점유 관측:** "이 슬롯이 사용 중"과 "이 실행 ID는 다시 시작하면 안 됨"을 따로 둔다. 끝났다고 답한 대기 줄은 슬롯을 막지 않고 그 실행 ID만 막으므로 관계없는 다른 일은 시작한다. 관측을 지우는 `clearSlotHold({ executorId, runId, runGeneration, observation })`은 확인한 그 세대와 번호의 줄만 지운다. 옛 세대의 종료 확인이나 다시 관측되기 전의 확인은 `reference_mismatch`이고 지금의 차단은 그대로다. 자동으로 지우는 경로는 없다.
- **정지:** 0도 줄로 적는다. 낮은 세대로 덮지 않는다(코드와 트리거 둘 다, 트리거는 UPDATE·UPSERT·INSERT OR REPLACE·DELETE 모두). `applyStop`은 합치기다: 이미 정지면 세대가 높아도 정지로 남고, 확인 단계를 생략하면 같은 세대에서는 이미 적은 단계를 남긴다(새 세대는 `none`). 정지를 푸는 길은 관리자 풀기의 `releaseStop({ generation })` 하나이고 같은 세대만 푼다.
- **지시의 정지 세대:** 종료(`recordStopInstruction`)·확정(`recordFinalizeInstruction`)·갱신 지시도 장부의 지금 정지 세대와 같아야 적힌다(`stop_generation_mismatch`, 기록이 없으면 `stop_unknown`). 종료·확정은 정지 중에도, 접수가 닫혀도, 장부가 실패한 뒤에도 시도한다. 기록이 실패해도 호출자는 최선 노력의 종료를 보낼 수 있지만 그것은 "지금 세대로 발급하도록 기록한 지시"가 아니다.
- **예산:** 남은 예산은 늘지 않는다(트리거만 비교한다).
- **보고:** `recordReport(input, from)`도 지정 실행기와 세대를 본다. 결과 보고는 감독이 결과를 먼저 저장한 자리(`storedRef`)와 결과 digest를, 훅·세션 깨짐 보고는 업무를 잇는 구조화 칸(`signal`)을 함께 커밋한 뒤에만 ack를 준다. 원문 로그나 모델 출력은 받지 않는다. `markResult`로 판정하면 그 실행의 미반영 결과 보고는 모두 닫힌다: 같은 digest는 반영이고, 다른 digest는 `receipt_conflicts`에 남긴다. 판정이 끝난 실행에 늦게 온 결과 보고는 ack 전에 갈린다: 같은 결과면 적자마자 마치고, 다른 결과면 충돌을 남기고 `receipt_conflict`, 결과가 없다고 판정했거나 시작하지 않은 실행이면 적지 않고 `transition_denied`다(거절된 보고는 ack가 없어 실행기가 다시 보낸다). 판정 전에 받아 남은 보고는 `markResult({ …, reportId })`가 상태를 되돌리지 않고 그 보고만 마친다. 결과 밖의 보고는 `settleReport`. 반영하지 않은 보고는 `pendingReports()`와 복원 3단계에 남는다.
- **게시:** 같은 작업 ID·같은 후보·같은 실행이면 재시도로 성공(`created: false`), 다르면 `publication_conflict`이고 기존 연결은 그대로다. 확정된 게시는 키·후보·실행·상태·결과가 바뀌지 않는다(UPDATE·교체·삭제·다른 줄의 키 변경 모두 트리거). 갱신 시각만 바뀐다.
- **세션 교체(D-50·D-51):** 교체 기록 하나(`session_takeovers`)가 앞 실행, 인수를 낸 실행기, 새 세대 표식, 시작 허가, 확정한 규칙 확인, 그 인수로 시작한 다음 실행을 묶는다. 인수 영수증은 장부가 `session_stop`을 지시한 앞 세션에만 받고, 낸 쪽은 앞 세션의 지정 실행기이거나 대기 중인 세션 실행의 지정 실행기여야 한다. 새 세대 표식이 앞 세션의 표식과 같거나 새 허가가 이미 쓰였으면 거절한다. 같은 실행기가 낸 같은 표식·허가의 규칙 확인(`rule_present`)이 있으면 그때 확정하고 앞 세션을 끝낸다. 없으면 인수 대기(`confirmed_at` NULL)로 두고 앞 세션의 슬롯을 쥔 채 규칙 확인을 기다린다(도착 순서와 무관). 같은 앞 세션에 인수가 둘이면 먼저 확정한 쪽이 교체이고 나머지는 대기로 남아 시작에 쓰이지 않는다. 같은 인수·규칙 확인의 재전송은 처음 낸 쪽만 ack를 받는다. `startSession`은 규칙 확인과 인수를 낸 쪽이 이 실행의 지정 실행기인지, 인수가 직전 세션(시작 커밋의 순번으로 찾는다)의 교체이고 표식·허가·규칙 확인이 같은지를 허가의 사용과 한 트랜잭션에서 본다. 인수 하나로 세션 하나만 연다. v1의 인수 영수증에는 다음 실행 ID가 없어 교체 대상은 실행기 이름으로 가린다. 같은 실행기에 대기 세션이 둘이면 먼저 시작한 쪽이 인수를 쓴다.
- **인계 참조:** `handoffRef`는 저장소가 낸 불투명 ID 꼴(`<저장소 이름>/<UUID>`)만 받고 `handoffDigest`와 함께 있거나 함께 없다. 인계 저장소의 실제 ID 꼴이 설계에 없어 장부가 받을 수 있는 가장 좁은 꼴로 정했다.
- **못 씀:** 쓰기나 읽기가 한 번 실패하면 다시 열 때까지 "쓸 수 없음"이다. 새 업무와 규칙 확인·풀기는 `ledger_unwritable`. 정지·종료·영수증·nonce의 기록은 계속 시도한다. 읽기 실패는 `{ known: false }`이고 `runGeneration`과 nonce 소비는 던진다(장부 밖이나 재사용으로 바꾸지 않는다). "모름"은 그 읽기가 실패했을 때다. 실패한 뒤에도 성공한 읽기는 값을 준다(새 업무는 위 1로 닫혀 있다).

## 재시작 복원(`Restorer`)

`new Restorer(ledger, ports, clock, { requiredPeers })`. 열린 장부(잠금을 잡은 상태)와 포트 넷, 응답을 반드시 받아야 하는 이웃 이름의 목록을 받는다. 목록에서 계약의 실행기 주체 이름인 항목은 필수 실행기다. 단계는 순서대로만 부르고, 앞 단계가 끝나지 않았거나 겹쳐 부르면 `RestoreOrderError`다. 단계가 실패하면 `RestoreStepError`이고 같은 단계를 다시 부를 수 있다. 더 새로운 복원 시도가 시작된 복원기의 단계는 실패한다. 단계 결과는 복사본이라 호출자가 바꿔도 뒤 단계의 판단이 바뀌지 않는다. 지시는 보내지 않고 목록을 돌려준다.

| 단계 | 하는 일 | 돌려주는 것 |
|---|---|---|
| 1 | 복원 시도를 새로 연다(앞 허가가 끝난다). 권위 기록(`StopAuthorityPort`)을 받아 정수·불리언 꼴을 확인하고, 장부를 다시 읽어 한 트랜잭션에서 합친다(`mergeStop`, 같은 세대는 정지가 이김). 첫 설치 장부에서 둘 다 없으면 0을 적는다. 둘 중 하나라도 모르면 실패 | 정지 세대, 정지 여부, 출처. 끝나기 전 `stopGeneration()`은 `null`, 끝난 뒤에는 지금의 장부 값(장부가 실패했으면 `null`) |
| 2 | 필수 이웃이 정확히 한 번씩 답했는지와 계약 판(`PeersPort`)을 보고, 실행기의 점유(`OccupancyPort`)를 실행 ID·세대·지정 실행기·양쪽 상태(끝난 상태 포함)로 장부와 대조. 맞지 않는 관측은 `slot_holds`에 남긴다 | 종료 대상(장부 밖 실행, 장부에서는 끝났는데 실행기가 쥔 실행), 점유 불일치, 남긴 관측, 슬롯 종류를 모르는 실행기, 전체 점유를 확인하지 못한 필수 실행기, 다시 물을 실행, 판이 다른 이웃, 빠진·겹친 이웃 |
| 3 | 종료 확인이 없는 진행 중 실행을 `unknown_running`에 둔다. 새 실행을 만들지 않는다 | 실행기별 상태 조회(같은 실행 ID, 8개씩, 종료 확인이 있는 실행은 2단계에서 어긋난 것만), 옮긴 실행, 결과 검사를 이을 실행(`checking`), 반영하지 않은 보고(훅·세션 깨짐은 `signal` 포함), 자리를 쥔 실행 |
| 4 | 확정되지 않은 게시를 현관(`PublicationPort`)에 작업 ID로 묻는다. 던지면(시간 초과 포함) `unknown` | 확정·대기·모름의 작업 ID |
| 5 | 일시 중지·대기열·예산·입력을 읽고 접수를 열어도 되는지 낸다. 판정, 장부의 허가, 완료 표시, 반환값을 한 동기 구간에서 정한다 | 정지가 아니고, 1단계 뒤 정지가 바뀌지 않았고, 판이 맞고, 필수 이웃이 모두 한 번씩 답했고, 필수 실행기의 전체 점유를 확인했고, 슬롯 종류를 모르는 점유가 없고, 장부를 쓸 수 있을 때만 `intakeMayOpen: true`. 시작해도 되는 대기 실행(시작 트랜잭션과 같은 판정), 옛 세대·입력 취소·만료·점유 관측으로 빠진 대기 실행, 처리 위치 뒤의 입력(대기·취소·만료) |

**점유 응답의 세 모양.** `OccupancyPort`의 행은 `coverage`로 가른다. `full`은 그 실행기가 쥔 실행 전부를 이번 복원에서 답한 것이고(빈 `runs`는 "쥔 것 없음"), `partial`은 특정 실행만 물은 답이다. 행이 없으면 모름이다. 필수 실행기는 `full`이 정확히 하나 있어야 확인된 것으로 세고, 아니면 `occupancy_unconfirmed`로 접수를 닫는다.

**접수를 닫지 않는 예외(합의한 정책).** 아래는 "앞 단계가 모두 맞을 때만"의 예외로, 접수는 열고 그 자리만 막는다.

- 장부 안의 `unknown_running`·`cleanup_pending`: 그 실행이 슬롯을 쥐고 있어 같은 종류의 새 실행은 `slot_busy`다.
- 장부 밖·불일치 점유: 실행 줄로 올리지 않고 `slot_holds`로 그 실행 ID와(활동 중이면) 그 종류의 슬롯만 막는다. 슬롯 종류를 알 수 없으면(실행기 주체 이름이 아님) 이 예외에 들지 않고 접수를 보류한다.
- 게시 조회의 모름: 그 작업 ID를 `unknown`으로 남겨 다시 내지 않는다.

## 뒤 작업이 알아야 할 것

**이 PR이 남긴 세 가지.** 장부는 아래가 채워져야 실제로 보호가 성립한다.

1. **실제 연결이 `from`을 서명 검증 결과에서 뽑는다.** 장부의 `from`은 평범한 값이라 그 출처를 스스로 증명하지 못한다. `applyReceipt`·`recordReport`·`applyRuleCheck`에는 봉투 검증을 통과한 낸 쪽 주체와 머리의 `run_generation`만 넘긴다. 실행기별 전체 점유(`coverage: "full"`)의 출처와 신선도, 종료 증명의 수집도 이 작업이 정한다.
2. **기동이 `reopen`을 고르고 필수 이웃을 설정한다.** 운영의 보통 기동은 `mode: "reopen"`이다. `not_initialized`면 장부를 잃은 것이고 첫 설치로 넘어가지 않는다. `requiredPeers`에 현관·관측 중계·실행기를 실제로 넣어야 빠진 응답이 접수를 닫는다.
3. **사본과 현관.** 장부의 사본·R2 전송·사본 복원의 보류(D-56의 남은 일)와 현관 계약의 감독 쪽은 이 PR에 없다.

- **실제 연결:** 세션 인수 영수증의 낸 쪽은 앞 세션의 지정 실행기이거나 대기 중인 세션 실행의 지정 실행기여야 한다. 규칙 확인은 `applyRuleCheck(input, { sender })`로 낸 쪽을 함께 넘긴다. 훅·세션 깨짐 보고는 `recordReport`의 `signal`에 v1 본문의 구조화 칸을 옮겨 넣는다. `clearSlotHold`는 그 실행기가 그 세대의 그 실행을 더는 쥐지 않는다고 재대조했거나 종료를 증명했을 때, `slotHolds()`나 2단계가 돌려준 세대와 관측 번호를 함께 넘겨 부른다. 무엇을 증명으로 볼지(`not_known`은 종료의 증거가 아니다)는 그 작업이 정한다. 맞춤 답의 세대는 `Restorer.stopGeneration()`이고 `null`이면 맞춤에 답하지 않는다.
- **스케줄러:** 새 업무는 `Restorer.intakeOpen()`이 true일 때만 시도하고, 장부의 거절(`intake_closed`, `stopped`, `slot_busy`, `run_blocked`, `input_cancelled`, `input_expired`, `deadline_passed`, `run_generation_stale`, `not_startable`)을 그대로 따른다. 복원 5단계의 `queued`만 시작 후보다. 허가가 버려졌으면(`intake_closed`) 새 `Restorer`로 1단계부터 다시 복원한다. 재시작 뒤 결과 검사는 3단계의 `resumeChecks`·`pendingReports`에서 다시 꺼낸다. 새 세션은 5단계의 `inputs.pending`을 순서대로 한 번씩 전한다.
- **CLI 풀기(§7.6):** 장부 쪽은 `releaseStop({ generation })` 하나다. 풀면 접수가 닫히고 새 복원 시도가 끝까지 마쳐야 열린다. 새 실행 세대를 적는 연산은 아직 없다. 세대를 올리면 옛 세대의 대기 실행은 시작되지 않고(`run_generation_stale`, 5단계 `staleQueued`) 종료 기록만 된다. 확인 단계(`phase`)는 `applyStop`의 `phase`로 같은 세대에 덧붙인다.
- **현관:** 권위 정지 기록의 답은 `{ generation, stopped }` 두 칸이어야 하고 다른 꼴은 모름이다. 게시 연결은 같은 작업 ID에 다른 후보를 다시 연결하지 않는다.

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
