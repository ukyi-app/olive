# 감독 장부 요약

감독 장부(D-56)의 스키마, 쓰기 규칙, 재시작 복원 순서다. 코드는 `src/ledger/`(공개 면은 `index.ts`), 설계의 기준은 homelab `docs/plans/2026-11-13-olive/supervisor.md` §3·§6·§7·§8이다. 표와 코드가 다르면 코드가 맞고, 이 문서를 고친다.

## 파일과 잠금

- SQLite 파일 하나, 감독 하나만 쓴다. `openLedger(path, { clock, mode })`만 장부를 만든다(`Ledger`는 공개 면에 타입으로만 있고 생성자를 직접 부르면 던진다). 실패하면 장부 객체 없이 이유(`locked`, `corrupt`, `full`, `io`, `too_new`, `migration_mismatch`, `migration_failed`, `not_initialized`, `already_initialized`)를 돌려준다.
- **`mode`는 호출자가 고른다.** `create`는 첫 설치다: 파일이 없거나 비었을 때만 열고 첫 설치 기록(`ledger_identity`)을 적는다. 이미 기록이 있으면 `already_initialized`. `reopen`은 보통의 기동이다: 파일이 없거나 첫 설치 기록이 없으면(빈 볼륨, 빈 대체 파일) 표를 만들지 않고 `not_initialized`로 닫는다. 그래서 장부를 잃은 볼륨이 첫 설치로 착각돼 정지 세대 0을 적는 일이 없다. 사본에서 되살린 장부의 보류는 이 작업 밖이다.
- **잠금:** `locking_mode=EXCLUSIVE`와 빈 `BEGIN IMMEDIATE`로 여는 순간 파일 잠금을 잡고 닫을 때까지 쥔다. 둘째 작성자는 같은 프로세스든 다른 프로세스든 `SQLITE_BUSY`로 `locked`다(`busy_timeout` 0). 프로세스가 죽으면 운영체제가 잠금을 푼다.
- **저널:** `journal_mode=WAL`, `synchronous=FULL`. 커밋마다 WAL을 fsync하므로 커밋을 돌려준 실행 줄은 전원이 나가도 남고, 감독은 실행 줄의 커밋 뒤에만 지시를 내므로 접수 기록이 영수증보다 먼저 남는다. `NORMAL`은 마지막 커밋을 잃을 수 있어 고르지 않았다. EXCLUSIVE라 `-shm` 파일이 없다. 로컬 볼륨 전제다.
- 열 때 `quick_check`로 깨진 파일을 거른다. `foreign_keys=ON`.

## 마이그레이션

`migrations/NNNN-이름.sql`을 번호 순서대로 한 번씩 적용한다. 판 하나는 트랜잭션 하나라 도중에 실패하거나 끊기면 그 판 전체가 되돌려진다. 적용 기록은 `ledger_migrations(version, name, applied_at)`. 번호가 비거나, 이름과 번호가 다르거나, 폴더에 꼴이 다른 파일이 있거나, 장부의 판이 코드보다 높거나, 같은 번호의 이름이 다르면 열지 않는다. 호출자가 `migrations`로 넘긴 목록도 같은 검사를 어떤 판도 적용하기 전에 거친다.

이 장부는 아직 어디에도 배포되지 않아 리뷰 반영을 `0001-core.sql`에 직접 고쳤다. **첫 배포 뒤에는 기존 번호를 고치지 않고 다음 번호로 더한다.**

## 표(0001-core)

| 묶음 | 표 | 요지 |
|---|---|---|
| 정지·일시 중지 | `stop_state`, `diagnosis_pause` | 정지 세대(0 포함, 줄이 없으면 아직 적지 않음), 정지 여부, 확인 단계, 진단 일시 중지의 끝 |
| 실행·슬롯·예산 | `runs`, `run_epoch`, `run_transitions`, `instructions`, `slot_holds` | 실행 ID·세대·역할·revision 둘·snapshot·실행기·자격 네 칸·기한·남은 예산·상태·영수증 id들. 낸 지시(v1 여섯). 점유 불일치로 막은 슬롯 |
| 입력·대기열 | `inputs` | 요청 ID, 인증된 출처, 원문 참조(`<저장소>/<UUID>`)와 만료, 순번, 취소 |
| 영수증·보고 | `deliveries`, `receipt_conflicts` | 받은 id와 본문 digest, 속한 실행(외래 키), 가리킨 지시, 결과 보고의 저장 자리·digest·반영 시각. 같은 id에 다른 digest의 기록 |
| 세션·인계 | `sessions`, `rule_checks`, `session_takeovers`, `start_permit_uses` | 세션 ID, 세대 표식 digest, 교체 시각, 처리 위치, 인계 참조, 규칙 확인(D-51), 인수 영수증과 확정 시각(D-50), 시작 허가의 한 번 사용 |
| 게시 연결 | `publications` | 현관 작업 ID, 후보 digest, 대기·확정·모름(확정이면 posted·not_posted) |
| nonce | `nonces` | 감독이 받는 봉투의 (낸 쪽, nonce). 계약의 `NonceStore` |

`ledger_identity`(첫 설치 기록)는 마이그레이션이 아니라 `openLedger`의 `create`가 만든다.

**넣지 않는 것:** 원문(요청 글, 모델 출력, 로그)과 자격 값. 원문은 참조와 만료만, 자격은 계정·방식·revision·digest만 둔다. 쓰기 함수는 정해진 칸만 받고(모르는 칸이면 `LedgerInputError`), 칸마다 좁은 꼴만 받는다: 계정은 계약의 별칭 꼴(소문자·숫자·하이픈 32자), 방식은 `subscription`·`api_key`, 실행기는 계약의 실행기 주체 이름, 원문·결과 참조는 `<저장소 이름>/<UUID>`. `test/ledger/static.test.ts`가 스키마의 칸 이름과 쓰기 함수가 실제로 받는 칸(`exact`의 칸 목록, 인라인 인자 타입, 입력 타입)을 막는다.

**정수:** 장부의 정수 칸은 모두 0(또는 1)부터 9007199254740991까지다(STRICT 열의 CHECK, 쓰기 함수의 `Number.isSafeInteger`). 읽은 세대·예산이 안전 정수가 아니면 그 값으로 판단하지 않고 `corrupt`로 닫는다.

## 새 업무를 열어도 되는 조건

새 접수·실행 줄·시작·자격·게시·갱신(`enqueueInput`, `admitRun`, `startRun`, `startSession`, `recordPublication`, `recordRenewInstruction`)은 모두 한 자리(`Ledger`의 쓰기 모드 `start`)의 전제를 거친다.

1. 장부가 건강하다(한 번이라도 쓰기·읽기가 실패했으면 다시 열 때까지 `ledger_unwritable`).
2. 이 연결에서 재시작 복원 5단계가 접수를 열었다. 장부는 열 때마다 닫힌 채 시작하고(`intake_closed`), 풀기(`releaseStop`) 뒤에도 다시 닫힌다.
3. 같은 트랜잭션 안에서 읽은 지금의 정지 기록이 있고(`stop_unknown`) 정지가 아니다(`stopped`).

시작(`startRun`·`startSession`)은 여기에 더해 지시의 정지 세대가 장부의 지금 값과 같고, 실행 줄의 세대가 지금 실행 세대(`run_epoch`)와 같고(`run_generation_stale`), 그 종류에 점유 차단(`slot_holds`)도 자리를 쥔 실행도 없고(`slot_busy`), 기한이 남았을 때만 된다. 작업자는 v1 `task_start`를 만들 수 있는 줄(입력 digest가 있고 예산이 1 이상, 역할과 지정 실행기가 맞음)만 자리를 잡는다(`not_startable`).

종료 기록, 영수증·보고의 반영, 복원 자체의 쓰기, 조회는 이 전제 없이 된다. `Restorer.intakeOpen()`과 `Ledger.intakeOpen()`은 단계 결과가 아니라 지금의 장부(건강, 접수, 정지 기록)를 읽고, 읽지 못하면 `false`다.

## 쓰기 규칙

- **실행 줄이 먼저:** `admitRun`이 대기(`queued`)로 실행 줄을 적는다. `startRun`·`startSession`이 자리를 잡고(`preparing`) 시작 지시를 적은 커밋이 끝난 뒤에만 지시를 보낸다. 영수증은 장부에 적힌 지시만 가리킬 수 있다. 같은 중복 키는 같은 실행을 돌려준다.
- **영수증:** `applyReceipt(input, from)`의 `from`은 검증을 마친 봉투의 낸 쪽 주체 이름과 머리의 `run_generation`이다. 낸 쪽이 그 실행의 지정 실행기가 아니면 `sender_mismatch`, 세대가 다르면 `run_generation_mismatch`이고 아무것도 적지 않는다(ack·상태·슬롯이 그대로). 같은 id·같은 digest는 한 번만 반영하고 다시 받으면 `duplicate`(ack는 다시 준다). 같은 id에 다른 digest는 `receipt_conflicts`에 남기고 `receipt_conflict`. 접수 영수증은 원 지시의 이름(`instruction`, v1 여섯 가운데 하나)이 장부의 지시와 같아야 한다. 영수증과 그 상태 전이는 한 트랜잭션이다.
- **증거:** 실행 줄의 영수증 id 칸은 같은 실행이 받은 맞는 종류의 영수증만 가리키고 한 번만 채운다(트리거 `runs_evidence`). 정리 영수증은 그 실행의 `result_finalize` 지시를 가리킨다. 받은 기록, 실행 줄, 시작 허가의 사용은 지우거나 바꿔 넣지 못한다.
- **상태 전이:** `states.ts`의 표만 허용한다. 같은 표가 장부의 `run_transitions`와 트리거에 있다. 종료 확인(`stop_receipt_id`) 없이 `checking`·`ready_result`·`failed_stopped`·`cleanup_pending`이 되지 않는다(CHECK). `not_started`는 지시를 내기 전(`queued`)에서만 간다. 종료 확인 영수증의 `exit`가 `completed`면 `checking`, 그 밖이면 `failed_stopped`다. `checking`에서 `unknown_running`으로 가는 길은 없다.
- **끊김 판정:** `markLost`는 종료 확인이 없는 `preparing`·`running`·`stopping`에만 계약의 `stateAfterLoss`를 쓴다(→ `unknown_running`). 계약의 함수는 종료 증명이 없는 실행기 쪽 상태의 함수라, 장부에서는 `stop_receipt_id`가 없는 줄에만 그대로 쓸 수 있다. 종료 확인이 있는 `checking`은 그대로 두고 결과 검사를 이어 간다.
- **슬롯:** 작업자 하나, 세션 하나(부분 유일 인덱스). `queued`·`finalized`·`not_started` 밖은 모두 자리를 쥔다. 그래서 `unknown_running`·`cleanup_pending`이 있으면 새 실행은 `slot_busy`다. 점유 차단(`slot_holds`)이 있는 종류도 `slot_busy`다.
- **정지:** 0도 줄로 적는다. 낮은 세대로 덮지 않는다(코드와 트리거 둘 다, 트리거는 UPDATE·UPSERT·INSERT OR REPLACE·DELETE 모두). `applyStop`은 합치기다: 같은 세대에서는 한쪽이라도 정지면 정지이고, 확인 단계를 생략하면 이미 적은 단계를 남긴다(새 세대는 `none`). 정지를 푸는 길은 관리자 풀기의 `releaseStop({ generation })` 하나이고 같은 세대만 푼다.
- **지시의 정지 세대:** 종료(`recordStopInstruction`)·확정(`recordFinalizeInstruction`)·갱신 지시도 장부의 지금 정지 세대와 같아야 적힌다(`stop_generation_mismatch`, 기록이 없으면 `stop_unknown`). 종료·확정은 정지 중에도, 접수가 닫혀도, 장부가 실패한 뒤에도 시도한다. 기록이 실패해도 호출자는 최선 노력의 종료를 보낼 수 있지만 그것은 "지금 세대로 발급하도록 기록한 지시"가 아니다.
- **예산:** 남은 예산은 늘지 않는다(트리거만 비교한다).
- **보고:** `recordReport(input, from)`도 지정 실행기와 세대를 본다. 결과 보고는 감독이 결과를 먼저 저장한 자리(`storedRef`)와 결과 digest를 함께 커밋한 뒤에만 ack를 준다. 반영은 `markResult({ …, reportId })`가 같은 트랜잭션에서 적고, 결과 밖의 보고는 `settleReport`. 반영하지 않은 보고는 `pendingReports()`와 복원 3단계에 남는다.
- **게시:** 같은 작업 ID·같은 후보·같은 실행이면 재시도로 성공(`created: false`), 다르면 `publication_conflict`이고 기존 연결은 그대로다. 확정은 다시 바뀌지 않는다(UPDATE·교체·삭제 모두 트리거).
- **세션 인수(D-50·D-51):** 인수 영수증은 장부가 `session_stop`을 지시한 앞 세션에만 받는다. 새 세대 표식이 앞 세션의 표식과 같거나 새 허가가 이미 쓰였으면 거절한다. 같은 표식·허가의 규칙 확인(`rule_present`)이 있으면 그때 확정하고 앞 세션을 끝낸다. 없으면 인수 대기(`confirmed_at` NULL)로 두고 앞 세션의 슬롯을 쥔 채 규칙 확인을 기다린다(도착 순서와 무관). 다음 `startSession`은 확정된 인수가 바로 앞에 연 세션의 교체이고 표식·허가가 규칙 확인과 같은지를 허가의 사용과 한 트랜잭션에서 본다. 인수 하나로 세션 하나만 연다.
- **못 씀:** 쓰기나 읽기가 한 번 실패하면 다시 열 때까지 "쓸 수 없음"이다. 새 업무와 규칙 확인·풀기는 `ledger_unwritable`. 정지·종료·영수증·nonce의 기록은 계속 시도한다. 읽기 실패는 `{ known: false }`이고 `runGeneration`과 nonce 소비는 던진다(장부 밖이나 재사용으로 바꾸지 않는다). "모름"은 그 읽기가 실패했을 때다. 실패한 뒤에도 성공한 읽기는 값을 준다(새 업무는 위 1로 닫혀 있다).

## 재시작 복원(`Restorer`)

`new Restorer(ledger, ports, clock, { requiredPeers })`. 열린 장부(잠금을 잡은 상태)와 포트 넷, 응답을 반드시 받아야 하는 이웃 이름의 목록을 받는다. 단계는 순서대로만 부르고, 앞 단계가 끝나지 않았거나 겹쳐 부르면 `RestoreOrderError`다. 단계가 실패하면 `RestoreStepError`이고 같은 단계를 다시 부를 수 있다. 단계 결과는 복사본이라 호출자가 바꿔도 뒤 단계의 판단이 바뀌지 않는다. 지시는 보내지 않고 목록을 돌려준다.

| 단계 | 하는 일 | 돌려주는 것 |
|---|---|---|
| 1 | 권위 기록(`StopAuthorityPort`)을 받아 정수·불리언 꼴을 확인하고, 장부를 다시 읽어 한 트랜잭션에서 합친다(`mergeStop`, 같은 세대는 정지가 이김). 첫 설치 장부에서 둘 다 없으면 0을 적는다. 둘 중 하나라도 모르면 실패 | 정지 세대, 정지 여부, 출처. 끝나기 전 `stopGeneration()`은 `null`, 끝난 뒤에는 지금의 장부 값 |
| 2 | 필수 이웃이 정확히 한 번씩 답했는지와 계약 판(`PeersPort`)을 보고, 실행기의 점유(`OccupancyPort`)를 실행 ID·세대·지정 실행기·양쪽 상태로 장부와 대조. 맞지 않는 점유는 그 종류의 슬롯을 `slot_holds`에 막는다 | 종료 대상(장부 밖 실행, 장부에서는 끝났는데 실행기가 쥔 실행), 점유 불일치, 막은 슬롯, 슬롯 종류를 모르는 실행기, 판이 다른 이웃, 빠진·겹친 이웃 |
| 3 | 종료 확인이 없는 진행 중 실행을 `unknown_running`에 둔다. 새 실행을 만들지 않는다 | 실행기별 상태 조회(같은 실행 ID, 8개씩, 종료 확인이 있는 실행은 빼고), 옮긴 실행, 결과 검사를 이을 실행(`checking`), 반영하지 않은 보고, 자리를 쥔 실행 |
| 4 | 확정되지 않은 게시를 현관(`PublicationPort`)에 작업 ID로 묻는다. 던지면(시간 초과 포함) `unknown` | 확정·대기·모름의 작업 ID |
| 5 | 일시 중지·대기열·예산·입력을 읽고 접수를 열어도 되는지 낸다. 열어도 되면 장부의 접수를 연다 | 정지가 아니고, 판이 맞고, 필수 이웃이 모두 한 번씩 답했고, 슬롯 종류를 모르는 점유가 없고, 장부를 쓸 수 있을 때만 `intakeMayOpen: true`. 시작해도 되는 대기 실행(지금 실행 세대, 입력 취소 없음, 점유 불일치 없음), 옛 세대·입력 취소된 대기 실행, 처리 위치 뒤의 입력(대기·취소·만료) |

**접수를 닫지 않는 예외(합의한 정책).** 아래는 "앞 단계가 모두 맞을 때만"의 예외로, 접수는 열고 그 자리만 막는다.

- 장부 안의 `unknown_running`·`cleanup_pending`: 그 실행이 슬롯을 쥐고 있어 같은 종류의 새 실행은 `slot_busy`다.
- 장부 밖·불일치 점유: 실행 줄로 올리지 않고 `slot_holds`로 그 종류의 슬롯만 막는다. 슬롯 종류를 알 수 없으면(실행기 주체 이름이 아님) 이 예외에 들지 않고 접수를 보류한다.
- 게시 조회의 모름: 그 작업 ID를 `unknown`으로 남겨 다시 내지 않는다.

## 뒤 작업이 알아야 할 것

- **실제 연결:** 영수증·보고는 봉투 검증을 마친 낸 쪽 주체 이름과 머리의 `run_generation`을 `from`으로 넘긴다. 세션 인수 영수증의 낸 쪽은 앞 세션의 지정 실행기이거나 장부에 지정된 끝나지 않은 세션 실행의 실행기여야 한다. `slot_holds`를 지우는 `clearSlotHold`는 그 실행기가 그 실행을 더는 쥐지 않는다고 재대조했거나 종료를 증명했을 때 부른다. 무엇을 증명으로 볼지(`not_known`은 종료의 증거가 아니다)는 그 작업이 정한다. 맞춤 답의 세대는 `Restorer.stopGeneration()`(지금의 장부 값)이다.
- **스케줄러:** 새 업무는 `Restorer.intakeOpen()`이 true일 때만 시도하고, 장부의 거절(`intake_closed`, `stopped`, `slot_busy`, `run_generation_stale`, `not_startable`)을 그대로 따른다. 복원 5단계의 `queued`만 시작 후보다. 재시작 뒤 결과 검사는 3단계의 `resumeChecks`·`pendingReports`에서 다시 꺼낸다. 새 세션은 5단계의 `inputs.pending`을 순서대로 한 번씩 전한다.
- **CLI 풀기(§7.6):** 장부 쪽은 `releaseStop({ generation })` 하나다. 풀면 접수가 닫히고 복원을 다시 거쳐야 열린다. 새 실행 세대를 적는 연산은 아직 없다. 세대를 올리면 옛 세대의 대기 실행은 시작되지 않고(`run_generation_stale`, 5단계 `staleQueued`) 종료 기록만 된다. 확인 단계(`phase`)는 `applyStop`의 `phase`로 같은 세대에 덧붙인다.
- **현관:** 권위 정지 기록의 답은 `{ generation, stopped }` 두 칸이어야 하고 다른 꼴은 모름이다. 게시 연결은 같은 작업 ID에 다른 후보를 다시 연결하지 않는다.
- **열기:** 운영의 보통 기동은 `mode: "reopen"`이다. `not_initialized`면 장부를 잃은 것이고 첫 설치로 넘어가지 않는다(사본 복원과 보류는 D-56의 남은 일).

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
