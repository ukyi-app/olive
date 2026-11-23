-- 종료가 확인되지 않은 작업자 실행(unknown_running·stopping)을 관리자가 확인한 뒤 "실패로 끝남"으로 닫아 그 실행이 쥔 작업자 자리를
-- 놓는 판(D-91·D-93·D-94). 상태는 not_started이고, 이 판의 근거 줄이 "관리자가 실패로 닫음"을 말한다.
-- 닫는 대상은 실행기가 받았다고 알린 실행(D-91의 글자)보다 넓다: 접수 영수증이 없는 실행, D-90이 자동으로 닫을 수 있는 실행도
-- 받는다(D-94). 관리자가 닫은 실행은 늘 실패로 읽히고 예산은 시작한 줄로 세므로, 같은 실행이라도 D-90과 이 닫기 가운데 먼저 된 쪽에
-- 따라 본체가 보는 단계와 같은 입력의 다음 배정이 다르다. 두 닫기는 서로를 막는다(아래 트리거).
-- 자리를 놓아도 같은 종류의 점유 관측(slot_holds의 holds_slot = 1)이 따로 있으면 작업자 자리는 그대로 막혀 있다. 그 관측은 이 판이
-- 풀지 않는다. 다섯 가지를 더한다.
-- 1. 전이 한 줄: 작업자의 stopping → not_started(unknown_running → not_started는 판 6의 줄을 함께 쓴다).
-- 2. operator_closures(관리자 닫기 근거): 닫은 실행마다 한 줄. 확인 방법, 확인한 파드의 이름, 그때의 정지 세대, 닫은 시각.
-- 3. operator_closures_close_run: 근거 줄을 넣는 그 SQL 문장 안에서 실행 줄을 not_started로 닫는다. 근거만 있고 상태는 그대로인
--    장부는 원 SQL로도 만들 수 없고, 닫는 전이가 거절되면 근거 줄도 함께 들어가지 않는다.
-- 4. unreceived_closures_exclusive: 관리자 근거가 있는 실행에는 D-90 근거가 들어가지 않는다(한 실행에 근거 하나).
-- 5. runs_not_started_needs_closure를 다시 만든다: queued 밖에서 not_started로 가는 갱신은 두 근거 표 가운데 하나에 같은 앞 상태의
--    줄이 먼저 있을 때만 된다.
-- 판 6의 표·칸·다른 트리거·전이 줄은 그대로다. 올라간 장부에서 operator_closures는 비어 있다.
--
-- NULL을 막는 것: 새 표의 모든 칸은 NOT NULL이다. BEFORE INSERT 트리거는 NOT NULL 검사보다 먼저 돌므로, 아래 트리거는 값의 검사를
-- "(조건) IS NOT 1"·"(조건) IS NOT 0"으로 쓴다: 조건에 NULL이 섞이면 결과가 NULL이고 NULL IS NOT 1·NULL IS NOT 0은 참이라 막는 쪽으로
-- 간다("NOT IN"·"NOT BETWEEN"은 NULL에서 막지 않는다). 대조는 NOT EXISTS(맞는 줄이 없으면 막음)와 IS NOT(정지 세대)으로 쓴다.
-- 늘어날 수 있는 집합(닫을 수 있는 앞 상태, 확인 방법의 목록)은 칸의 CHECK가 아니라 트리거에 둔다: 이름 없는 CHECK는 다음 판이
-- 빼거나 넓히지 못하고, 트리거는 DROP·CREATE로 다시 만든다(이관 0006 머리의 주석).

INSERT INTO run_transitions (kind, from_state, to_state) VALUES
  ('worker', 'stopping', 'not_started');

-- 관리자 닫기의 근거. 실행마다 한 줄이고, 이 줄을 넣는 문장이 실행 줄을 함께 닫는다(아래 operator_closures_close_run).
-- - from_state: 닫기 전의 장부 상태(unknown_running·stopping, 아래 트리거).
-- - checked_by: 관리자가 확인한 방법. pod_replaced(작업자 파드가 바뀌었다)·process_absent(작업자 프로세스가 없다) 둘 가운데 하나.
-- - pod_name: 관리자가 확인한 파드의 이름. Kubernetes 이름 규칙(DNS 서브도메인: 소문자·숫자·'-'·'.', 253자 이하, 라벨마다 영숫자로
--   시작하고 끝남)만 받는다. 장부는 원문을 넣지 않으므로 자유 메모 칸은 없다. "누가" 칸도 없다: 관리 진입점이 넘기는 이름은 검증되지 않는다.
-- - stop_generation: 닫은 때의 정지 세대(stop_state.generation).
-- - closed_at: 닫은 시각. 부르는 쪽이 넘긴 시각(감독의 시계)이고, 실행 줄의 updated_at에도 이 값이 들어간다.
-- 확인은 사람이 했다는 기록이지 장부가 확인한 사실이 아니다. 줄은 지우거나 고치지 않는다.
CREATE TABLE operator_closures (
  run_id TEXT NOT NULL PRIMARY KEY REFERENCES runs (run_id),
  from_state TEXT NOT NULL,
  checked_by TEXT NOT NULL,
  pod_name TEXT NOT NULL,
  stop_generation INTEGER NOT NULL CHECK (stop_generation BETWEEN 0 AND 9007199254740991),
  closed_at INTEGER NOT NULL CHECK (closed_at BETWEEN 1 AND 9007199254740991)
) STRICT, WITHOUT ROWID;

-- 행으로 다시 보는 확인: 코드의 검사가 빠져도 아래 중 하나라도 맞으면 근거 줄은 들어가지 않는다.
-- 이미 관리자 근거가 있음(INSERT OR REPLACE 포함), D-90 근거가 있음, 앞 상태가 unknown_running·stopping이 아님, 확인 방법이 목록 밖,
-- 파드 이름이 이름 규칙 밖, 작업자가 아니거나 지금 상태가 from_state가 아니거나 종료 확인(stop_receipt_id)이 있음, 정지 세대가
-- 지금의 정지 기록과 다르거나 정지 기록이 없음, 닫은 시각이 "실행기가 그 실행을 새로 띄울 수 있는 마지막 시각"을 지나지 않음.
-- 파드 이름의 검사: 길이 1–253, 첫·끝 글자가 영숫자, 영숫자·'-'·'.' 밖의 글자가 없음, '..'·'.-'·'-.'가 없음(라벨이 비거나 '-'로
-- 시작·끝남), U+0000이 없음. length와 GLOB은 TEXT 안의 U+0000에서 읽기를 멈춰 그 뒤를 보지 않는다(이 저장소의 Bun 1.4.4가 묶은
-- SQLite 3.53.4에서 돌려 본 것). instr(이름, char(0))은 그 뒤까지 보고 U+0000의 자리(1부터)를 낸다.
-- 띄울 수 있는 마지막 시각: 실행기는 프로세스를 띄우기 직전에 자기 시계로 "지금 < 임대 끝"을 다시 보고, 그 사이에 await가 없다
-- (src/executor/worker.ts의 launchBlocked). 임대 끝은 시작 지시의 발행 + RUN_LEASE_MAX_MS이고, 띄우기 전(preparing)에 받은 갱신이
-- 그 갱신의 발행 + RUN_LEASE_MAX_MS까지 늘릴 수 있다(계약 v1이 갱신의 끝을 그 값 이하로 막는다). 시작은 발행 + MESSAGE_TTL_MAX_MS
-- 뒤로는 받지 않고, 다시 보내도 장부의 발행 시각을 그대로 싣는다. 그래서 그 실행의 시작·갱신 지시의 발행 시각 최댓값 + 30000ms
-- (RUN_LEASE_MAX_MS·MESSAGE_TTL_MAX_MS의 큰 쪽)가 실행기 시계로 띄울 수 없게 되는 때다. closed_at은 감독의 시계라 실행기 시계가
-- 뒤처질 수 있는 만큼(CLOCK_SKEW_MS 1000ms)을 더해, closed_at >= 최댓값 + 31000일 때만 받는다(정각은 받는다). 시작 지시가 없으면
-- 최댓값이 NULL이라 막는다. 장부는 사람이 언제 확인했는지 모른다: 이 시각 뒤의 닫기라는 것만 본다.
-- 이 트리거가 보지 않는 것: 장부가 건강한지, 접수 닫힘·사본 보류·정지 중인지(닫기는 이것들과 상관없이 받는다. ledger.ts의
-- closeRunByOperator가 쓰기 모드로 장부 실패만 거절한다).
CREATE TRIGGER operator_closures_proven BEFORE INSERT ON operator_closures
WHEN EXISTS (SELECT 1 FROM operator_closures o WHERE o.run_id = NEW.run_id)
  OR EXISTS (SELECT 1 FROM unreceived_closures c WHERE c.run_id = NEW.run_id)
  OR (NEW.from_state IN ('unknown_running', 'stopping')) IS NOT 1
  OR (NEW.checked_by IN ('pod_replaced', 'process_absent')) IS NOT 1
  OR (length(NEW.pod_name) BETWEEN 1 AND 253) IS NOT 1
  OR (NEW.pod_name GLOB '[a-z0-9]' OR NEW.pod_name GLOB '[a-z0-9]*[a-z0-9]') IS NOT 1
  OR (NEW.pod_name GLOB '*[^a-z0-9.-]*') IS NOT 0
  OR (instr(NEW.pod_name, '..') + instr(NEW.pod_name, '.-') + instr(NEW.pod_name, '-.') + instr(NEW.pod_name, char(0))) IS NOT 0
  OR NOT EXISTS (SELECT 1 FROM runs r WHERE r.run_id = NEW.run_id AND r.kind = 'worker' AND r.state = NEW.from_state
    AND r.stop_receipt_id IS NULL)
  OR NEW.stop_generation IS NOT (SELECT s.generation FROM stop_state s WHERE s.id = 1)
  OR (NEW.closed_at >= (SELECT MAX(i.issued_at) FROM instructions i WHERE i.run_id = NEW.run_id
    AND i.action IN ('task_start', 'session_start', 'run_renew')) + 31000) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'operator_closure_unproven');
END;

-- 근거 줄을 넣는 문장 안에서 실행 줄을 닫는다. AFTER 트리거의 갱신이나 그 뒤의 확인이 거절되면 근거 줄을 넣은 문장 전체가 되돌아가
-- 근거도 남지 않는다. 갱신은 runs의 전이·근거 트리거(runs_transition_allowed, runs_not_started_needs_closure)를 그대로 지난다.
-- 위의 BEFORE 트리거가 같은 문장 안에서 앞 상태와 종료 확인 없음을 이미 봤으므로, 근거와 전이 사이에 종료 영수증이 끼어들 틈이 없다.
CREATE TRIGGER operator_closures_close_run AFTER INSERT ON operator_closures
BEGIN
  UPDATE runs SET state = 'not_started', updated_at = NEW.closed_at WHERE run_id = NEW.run_id;
  SELECT RAISE(ABORT, 'operator_closure_unproven')
  WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.run_id = NEW.run_id AND r.state = 'not_started');
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
-- 기대지 않고 따로 막는다. 판 6의 트리거는 그대로 두고 하나를 더한다(같은 표의 BEFORE INSERT 트리거는 모두 돈다).
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
