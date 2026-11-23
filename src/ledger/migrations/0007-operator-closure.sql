-- 종료가 확인되지 않은 작업자 실행(unknown_running·stopping)을, 새 작업자 파드가 닫을 수 있게 되는 시각 뒤에 떴고 그 사실을 근거에
-- 남긴 뒤에만 관리자가 "실패로 끝남"으로 닫아 그 실행이 쥔 작업자 자리를 놓는 판(D-91·D-93·D-94·D-96·D-97). 상태는 not_started이고,
-- 이 판의 근거 줄이 "관리자가 실패로 닫음"을 말한다.
-- 닫는 대상은 실행기가 받았다고 알린 실행(D-91의 글자)보다 넓다: 접수 영수증이 없는 실행, D-90이 자동으로 닫을 수 있는 실행도
-- 받는다(D-94). 관리자가 닫은 실행은 늘 실패로 읽히고 예산은 시작한 줄로 세므로, 같은 실행이라도 D-90과 이 닫기 가운데 먼저 된 쪽에
-- 따라 본체가 보는 단계와 같은 입력의 다음 배정이 다르다. 두 닫기는 서로를 막는다(아래 트리거).
-- 자리를 놓아도 같은 종류의 점유 관측(slot_holds의 holds_slot = 1)이 따로 있으면 작업자 자리는 그대로 막혀 있다. 그 관측은 이 판이
-- 풀지 않는다. 다섯 가지를 더한다.
-- 1. 전이 한 줄: 작업자의 stopping → not_started(unknown_running → not_started는 판 6의 줄을 함께 쓴다).
-- 2. operator_closures(관리자 닫기 근거): 닫은 실행마다 한 줄. 확인 방법, 확인한 파드의 이름과 그 파드가 뜬 시각, 그때의 정지 세대,
--    닫은 시각.
-- 3. operator_closures_close_run: 근거 줄을 넣는 그 SQL 문장 안에서 실행 줄을 not_started로 닫고 그 실행의 미반영 보고를 마친다.
--    근거만 있고 상태는 그대로인 장부는 원 SQL로도 만들 수 없고, 닫는 전이가 거절되면 근거 줄도 함께 들어가지 않는다.
-- 4. unreceived_closures_exclusive: 관리자 근거가 있는 실행에는 D-90 근거가 들어가지 않는다(한 실행에 근거 하나).
-- 5. runs_not_started_needs_closure를 다시 만든다: queued 밖에서 not_started로 가는 갱신은 두 근거 표 가운데 하나에 같은 앞 상태의
--    줄이 먼저 있을 때만 된다.
-- 판 6의 표·칸·다른 트리거·전이 줄은 그대로다. 올라간 장부에서 operator_closures는 비어 있다.
--
-- NULL을 막는 것: 새 표의 모든 칸은 NOT NULL이다. BEFORE INSERT 트리거는 NOT NULL 검사보다 먼저 돌고, INSERT OR IGNORE는 NOT NULL·
-- CHECK 위반을 예외 없이 0줄로 끝낸다. 그래서 아래 트리거는 NULL이 섞인 입력을 칸의 제약에 맡기지 않고 스스로 거절한다. 값의 검사는
-- "(조건) IS NOT 1"·"(조건) IS NOT 0"으로 쓴다: 조건에 NULL이 섞이면 결과가 NULL이고 NULL IS NOT 1·NULL IS NOT 0은 참이라 막는 쪽으로
-- 간다("NOT IN"·"NOT BETWEEN"은 NULL에서 막지 않는다). 다른 표와의 대조는 "NOT EXISTS(= 로 맞는 줄)"로 쓴다: 어느 쪽이 NULL이거나
-- 줄이 없으면 맞는 줄이 없어 막는다("A IS NOT B"는 두 쪽이 모두 NULL이면 거짓이라 통과하므로 대조에 쓰지 않는다).
-- 정수로 바꿀 수 없는 값(빈 문자열 같은 TEXT, 소수 REAL)은 STRICT 표의 형 검사가 트리거보다 먼저 세 INSERT 방식 모두 예외로 막는다
-- (이 저장소의 Bun 1.4.4가 묶은 SQLite 3.53.4에서 돌려 본 것).
-- 트리거가 보지 않는 칸의 범위: closed_at이 9007199254740991 위이면(pod_started_at은 closed_at 이하여야 트리거를 지나므로 그때만
-- pod_started_at도 그 위일 수 있다) 트리거를 지나 칸의 CHECK가 막고, INSERT OR IGNORE면 예외 없이 0줄이다(닫힌 것은 없다). 원 SQL
-- 호출자는 예외만이 아니라 변경 수를 본다.
-- 늘어날 수 있는 집합(닫을 수 있는 앞 상태, 확인 방법의 목록)은 칸의 CHECK가 아니라 트리거에 둔다: 이름 없는 CHECK는 다음 판이
-- 빼거나 넓히지 못하고, 트리거는 DROP·CREATE로 다시 만든다(이관 0006 머리의 주석).

INSERT INTO run_transitions (kind, from_state, to_state) VALUES
  ('worker', 'stopping', 'not_started');

-- 관리자 닫기의 근거. 실행마다 한 줄이고, 이 줄을 넣는 문장이 실행 줄을 함께 닫는다(아래 operator_closures_close_run).
-- - from_state: 닫기 전의 장부 상태(unknown_running·stopping, 아래 트리거).
-- - checked_by: 관리자가 확인한 방법. pod_replaced(작업자 파드가 바뀌었다) 하나다(D-96). 목록은 트리거에 있어 뒤의 판이 더할 수 있다.
-- - pod_name: 관리자가 확인한 파드(바꾼 뒤의 작업자 파드)의 이름. Kubernetes 이름 규칙(DNS 서브도메인: 소문자·숫자·'-'·'.', 253자
--   이하, 라벨마다 영숫자로 시작하고 끝남)만 받는다. 장부는 원문을 넣지 않으므로 자유 메모 칸은 없다. "누가" 칸도 없다: 관리 진입점이
--   넘기는 이름은 검증되지 않는다.
-- - pod_started_at: 그 새 작업자 파드가 뜬 시각(Unix epoch 밀리초, D-97). 닫는 명령이 쿠버네티스에서 읽어 넘기는 클러스터의 시각이다.
--   장부는 그 값을 스스로 확인하지 못한다(사람·명령이 넘긴 값의 기록, D-93과 같다).
-- - stop_generation: 닫은 때의 정지 세대(stop_state.generation).
-- - closed_at: 닫은 시각. 부르는 쪽이 넘긴 시각(감독의 시계)이고, 실행 줄의 updated_at과 마친 보고의 applied_at에도 이 값이 들어간다.
-- 확인은 사람이 했다는 기록이지 장부가 확인한 사실이 아니다. 줄은 지우거나 고치지 않는다.
CREATE TABLE operator_closures (
  run_id TEXT NOT NULL PRIMARY KEY REFERENCES runs (run_id),
  from_state TEXT NOT NULL,
  checked_by TEXT NOT NULL,
  pod_name TEXT NOT NULL,
  pod_started_at INTEGER NOT NULL CHECK (pod_started_at BETWEEN 1 AND 9007199254740991),
  stop_generation INTEGER NOT NULL CHECK (stop_generation BETWEEN 0 AND 9007199254740991),
  closed_at INTEGER NOT NULL CHECK (closed_at BETWEEN 1 AND 9007199254740991)
) STRICT, WITHOUT ROWID;

-- 행으로 다시 보는 확인: 코드의 검사가 빠져도 아래 중 하나라도 맞으면 근거 줄은 들어가지 않는다.
-- 이미 관리자 근거가 있음(INSERT OR REPLACE 포함), D-90 근거가 있음, 앞 상태가 unknown_running·stopping이 아님, 확인 방법이
-- pod_replaced가 아님, 파드 이름이 이름 규칙 밖, 작업자가 아니거나 지금 상태가 from_state가 아니거나 종료 확인(stop_receipt_id)이 있음,
-- 정지 기록이 없거나 정지 세대가 그 기록과 같지 않음(입력이 NULL이면 같지 않다), 그 실행의 task_start 지시가 없음, 그 실행의
-- session_start 지시가 있음, 닫은 시각이나 파드가 뜬 시각이 닫을 수 있게 되는 시각 전, 파드가 뜬 시각이 닫은 시각 뒤.
-- 파드 이름의 검사: 길이 1–253, 첫·끝 글자가 영숫자, 영숫자·'-'·'.' 밖의 글자가 없음, '..'·'.-'·'-.'가 없음(라벨이 비거나 '-'로
-- 시작·끝남), U+0000이 없음. length와 GLOB은 TEXT 안의 U+0000에서 읽기를 멈춰 그 뒤를 보지 않는다(이 저장소의 Bun 1.4.4가 묶은
-- SQLite 3.53.4에서 돌려 본 것). instr(이름, char(0))은 그 뒤까지 보고 U+0000의 자리(1부터)를 낸다.
-- 확인 방법이 pod_replaced 하나인 까닭(D-96): 관리자는 닫기 전에 작업자 파드를 지워 새로 띄운다. 옛 실행기 프로세스가 끝나므로, 그
-- 실행기가 쥐고 있던 시작 권한(임대)은 장부가 그 갱신을 알든 모르든(사본에서 되살린 장부) 함께 사라지고, 마지막 임대 검사를 이미
-- 통과한 옛 실행기가 뒤늦게 띄우는 일도 없다. 장부는 파드가 바뀌었는지 확인하지 못한다: 근거 줄은 사람이 했다는 기록이다.
-- 닫을 수 있게 되는 시각: 그 실행의 task_start·run_renew 지시의 발행 시각 최댓값 + 31000ms(정각은 받는다). closed_at과
-- pod_started_at이 모두 이 시각 이후여야 하고, pod_started_at ≤ closed_at이어야 한다(D-97). 감독은 시작을 다시 보내도 장부의 발행
-- 시각을 그대로 싣고 발행 + 19000ms까지만 봉한다(src/supervisor/dispatch/resend.ts). 실행기는 발행 + MESSAGE_TTL_MAX_MS 뒤로는 시작을
-- 받지 않고(봉투의 시한), 발행 + RUN_LEASE_MAX_MS부터는(정각 포함) 준비·자격·띄우기 직전의 검사에서 멈춘다(src/executor/worker.ts의
-- launchBlocked). 띄우기 전(preparing)에 받은 갱신은 임대 끝을 그 갱신의 발행 + RUN_LEASE_MAX_MS까지 늘릴 수 있다(계약 v1이 갱신의
-- 끝을 그 값 이하로 막는다). 그래서 발행 최댓값 + 30000(두 시한의 큰 쪽)부터 실행기 시계로 받기와 그 검사가 막히고, 시계 오차
-- (계약의 CLOCK_SKEW_MS 1000ms)를 더한다.
-- pod_started_at의 조건이 막는 것: 새 파드의 실행기가 감독이 다시 보낸 시작을 받아 띄우는 길. 그 실행기는 파드가 뜬 뒤에 시작하므로
-- 무엇이든 파드가 뜬 시각 뒤에 받고, 그 시각이 한도 뒤면 그 실행의 시작은 이미 시한이 지났다. 갱신은 그 실행을 이미 받은
-- 실행기에만 늘릴 임대가 있어, 새 파드에는 task_start의 발행만으로 족하다. 같은 식(갱신 포함)을 쓰면 더 기다릴 뿐이라 닫는 쪽으로만
-- 틀린다. 그래서 장부가 모르는 갱신(사본에서 되살린 장부)도 새 파드에는 늘릴 임대가 없다. 파드를 한도 전에 바꿨으면 거절되고,
-- 관리자는 파드를 한 번 더 바꾼다. closed_at의 조건은 그대로 둔다(파드가 뜬 시각 ≤ 닫은 시각이라 함께 맞는다).
-- 두 시계: pod_started_at은 클러스터(쿠버네티스)의 시계, 발행 시각과 closed_at은 감독의 시계, 시작을 받는 것은 실행기의 시계다.
-- 그 차이를 계약의 시계 오차 1000ms가 덮는다는 전제다(홈랩은 한 머신이라 시계가 하나다). 쿠버네티스의 시각은 초 단위라 부르는 쪽이
-- 내림해 넘기면 실제보다 이르게 적혀 거절 쪽으로 간다.
-- session_start 지시가 있는 실행은 닫지 않는다: 작업자 실행의 정상 이력에는 없고(ledger.ts의 startRun은 task_start만 적고
-- startSession은 지시를 적지 않는다), 섞이면 그 시작이 무엇을 언제까지 띄울 수 있는지 이 식이 세지 않는다. task_start가 없는 실행도
-- 시간의 근거가 없어 막는다.
-- 새 파드의 실행기가 저장소에서 그 실행을 되살려 띄우는 길은 없다: 다시 뜬 실행기의 복원(src/executor/worker.ts의 recover·reconcile)은
-- 사건·상태를 맞추고 남은 프로세스를 정리할 뿐 띄우지 않고, 기록이 이미 있는 실행의 시작 지시는 사건만 다시 보낸다(onStart).
-- 이 판이 막지 못하는 것: (ㄱ) 사람·명령이 넘긴 값이 틀리면 닫힌다: 파드를 바꾸지 않았거나(장부가 모르는 갱신의 임대가 남았거나
-- 마지막 검사를 지난 옛 실행기가 띄우는 중일 수 있다), 넘긴 파드의 시각이 그 파드의 실행기가 뜬 시각보다 늦은 경우. (ㄴ) 시계
-- 전제가 깨져 클러스터·실행기의 시계가 감독의 시계보다 1000ms 넘게 뒤처지면, 한도 뒤로 적힌 새 파드의 실행기가 다시 보낸 시작을
-- 받아 띄울 수 있다. 이때 장부가 남기는 신호는 닫은 뒤 처음 받는 유효한 새 시작 영수증 하나다: 그 영수증에서만 답의 경보와 그 종류의
-- 자리 다시 막기가 함께 생긴다(판 6과 같은 처리, ledger.ts의 applyReceipt). 닫기 전에 받아 실행 줄에 연결된 첫 시작 영수증의
-- 재전송은 경보·점유가 없고, 닫기 전에 받은 다른 시작 영수증의 재전송은 경보만 있고 점유는 없다. 장부는 사람이 언제 확인했는지
-- 모른다: 두 시각이 한도 뒤라는 것만 본다.
-- 이 트리거가 보지 않는 것: 장부가 건강한지, 접수 닫힘·사본 보류·정지 중인지(닫기는 이것들과 상관없이 받는다. ledger.ts의
-- closeRunByOperator가 쓰기 모드로 장부 실패만 거절한다).
CREATE TRIGGER operator_closures_proven BEFORE INSERT ON operator_closures
WHEN EXISTS (SELECT 1 FROM operator_closures o WHERE o.run_id = NEW.run_id)
  OR EXISTS (SELECT 1 FROM unreceived_closures c WHERE c.run_id = NEW.run_id)
  OR (NEW.from_state IN ('unknown_running', 'stopping')) IS NOT 1
  OR (NEW.checked_by IN ('pod_replaced')) IS NOT 1
  OR (length(NEW.pod_name) BETWEEN 1 AND 253) IS NOT 1
  OR (NEW.pod_name GLOB '[a-z0-9]' OR NEW.pod_name GLOB '[a-z0-9]*[a-z0-9]') IS NOT 1
  OR (NEW.pod_name GLOB '*[^a-z0-9.-]*') IS NOT 0
  OR (instr(NEW.pod_name, '..') + instr(NEW.pod_name, '.-') + instr(NEW.pod_name, '-.') + instr(NEW.pod_name, char(0))) IS NOT 0
  OR NOT EXISTS (SELECT 1 FROM runs r WHERE r.run_id = NEW.run_id AND r.kind = 'worker' AND r.state = NEW.from_state
    AND r.stop_receipt_id IS NULL)
  OR NOT EXISTS (SELECT 1 FROM stop_state s WHERE s.id = 1 AND s.generation = NEW.stop_generation)
  OR NOT EXISTS (SELECT 1 FROM instructions i WHERE i.run_id = NEW.run_id AND i.action = 'task_start')
  OR EXISTS (SELECT 1 FROM instructions i WHERE i.run_id = NEW.run_id AND i.action = 'session_start')
  OR (NEW.closed_at >= (SELECT MAX(i.issued_at) FROM instructions i WHERE i.run_id = NEW.run_id
    AND i.action IN ('task_start', 'run_renew')) + 31000) IS NOT 1
  OR (NEW.pod_started_at >= (SELECT MAX(i.issued_at) FROM instructions i WHERE i.run_id = NEW.run_id
    AND i.action IN ('task_start', 'run_renew')) + 31000) IS NOT 1
  OR (NEW.pod_started_at <= NEW.closed_at) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'operator_closure_unproven');
END;

-- 근거 줄을 넣는 문장 안에서 실행 줄을 닫고 그 실행의 미반영 보고를 마친다. AFTER 트리거의 갱신이나 그 뒤의 확인이 거절되면 근거
-- 줄을 넣은 문장 전체가 되돌아가 근거도 남지 않는다. 실행 줄의 갱신은 runs의 전이·근거 트리거(runs_transition_allowed,
-- runs_not_started_needs_closure)를 그대로 지난다. 위의 BEFORE 트리거가 같은 문장 안에서 앞 상태와 종료 확인 없음을 이미 봤으므로,
-- 근거와 전이 사이에 종료 영수증이 끼어들 틈이 없다.
-- 보고: 그 실행의 결과·세션 깨짐·훅 보고 가운데 applied_at이 빈 줄을 반영하지 않고 마친다(applied_at = closed_at). 닫힌 뒤 처음 온
-- 보고를 받은 자리에서 마치는 것(ledger.ts의 recordReport)과 같은 끝이라 처리 목록(pendingReports)과 복원 3단계에 남지 않는다. 원 SQL
-- 한 문장으로 닫아도, 공개 연산으로 닫아도 같다. 다른 실행의 보고는 건드리지 않는다.
CREATE TRIGGER operator_closures_close_run AFTER INSERT ON operator_closures
BEGIN
  UPDATE runs SET state = 'not_started', updated_at = NEW.closed_at WHERE run_id = NEW.run_id;
  SELECT RAISE(ABORT, 'operator_closure_unproven')
  WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.run_id = NEW.run_id AND r.state = 'not_started');
  UPDATE deliveries SET applied_at = NEW.closed_at
  WHERE run_id = NEW.run_id AND applied_at IS NULL AND action IN ('report_result', 'report_session_broken', 'report_hook_event');
END;

CREATE TRIGGER operator_closures_fixed BEFORE UPDATE ON operator_closures
BEGIN
  SELECT RAISE(ABORT, 'operator_closure_unproven');
END;

CREATE TRIGGER operator_closures_permanent BEFORE DELETE ON operator_closures
BEGIN
  SELECT RAISE(ABORT, 'operator_closure_unproven');
END;

-- 한 실행에 근거 하나: 관리자 근거가 먼저 있는 실행에는 D-90 근거가 들어가지 않는다. 반대 방향은 operator_closures_proven이 막는다.
-- 관리자 근거가 들어간 실행은 같은 문장에서 not_started가 되어 판 6의 unreceived_closures_proven도 막지만, 그 트리거의 앞 상태 검사에
-- 기대지 않고 따로 막는다. 판 6의 트리거는 그대로 두고 하나를 더한다: 두 트리거 가운데 어느 하나가 거절하면 문장 전체가 거절된다
-- (두 트리거의 실행 순서에 기대지 않는다).
CREATE TRIGGER unreceived_closures_exclusive BEFORE INSERT ON unreceived_closures
WHEN EXISTS (SELECT 1 FROM operator_closures o WHERE o.run_id = NEW.run_id)
BEGIN
  SELECT RAISE(ABORT, 'unreceived_closure_unproven');
END;

-- queued 밖에서 not_started로 가는 갱신은 그 실행의 근거 줄(D-90 또는 관리자)이 같은 앞 상태로 먼저 있을 때만 된다. 전이표의 줄은
-- 아무 쓰기나 그 길로 가게 하므로 여기서 근거에 묶는다. 대기 실행의 취소(queued → not_started)는 그대로다.
DROP TRIGGER runs_not_started_needs_closure;

CREATE TRIGGER runs_not_started_needs_closure BEFORE UPDATE OF state ON runs
WHEN NEW.state = 'not_started' AND OLD.state NOT IN ('queued', 'not_started')
  AND NOT EXISTS (SELECT 1 FROM unreceived_closures c WHERE c.run_id = NEW.run_id AND c.from_state = OLD.state)
  AND NOT EXISTS (SELECT 1 FROM operator_closures o WHERE o.run_id = NEW.run_id AND o.from_state = OLD.state)
BEGIN
  SELECT RAISE(ABORT, 'run_closure_unproven');
END;
