-- 실행기가 받았다고 알린 뒤(또는 D-90이 닫지 않아) 종료가 확인되지 않은 작업자 실행을, 관리자가 확인한 뒤 "실패로 끝남"으로 닫아
-- 자리를 푸는 판(D-91·D-93). 상태는 not_started이고, 이 판의 근거 줄이 "관리자가 실패로 닫음"을 말한다. 네 가지를 더한다.
-- 1. 전이 한 줄: 작업자의 stopping → not_started(unknown_running → not_started는 판 6의 줄을 함께 쓴다).
-- 2. operator_closures(관리자 닫기 근거): 닫은 실행마다 한 줄. 확인 방법, 확인한 파드의 이름, 그때의 정지 세대, 닫은 시각.
-- 3. unreceived_closures_exclusive: 관리자 근거가 있는 실행에는 D-90 근거가 들어가지 않는다(한 실행에 근거 하나).
-- 4. runs_not_started_needs_closure를 다시 만든다: queued 밖에서 not_started로 가는 갱신은 두 근거 표 가운데 하나에 같은 앞 상태의
--    줄이 먼저 있을 때만 된다.
-- 판 6의 표·칸·다른 트리거·전이 줄은 그대로다. 올라간 장부에서 operator_closures는 비어 있다.
--
-- NULL을 막는 것: 새 표의 모든 칸은 NOT NULL이다. BEFORE INSERT 트리거는 NOT NULL 검사보다 먼저 돌므로, 아래 트리거는 값의 검사를
-- "(조건) IS NOT 1"로 쓴다: 조건에 NULL이 섞이면 결과가 NULL이고 NULL IS NOT 1은 참이라 막는 쪽으로 간다("NOT IN"·"NOT BETWEEN"은
-- NULL에서 막지 않는다). 대조는 NOT EXISTS(맞는 줄이 없으면 막음)와 IS NOT(정지 세대)으로 쓴다.
-- 늘어날 수 있는 집합(닫을 수 있는 앞 상태, 확인 방법의 목록)은 칸의 CHECK가 아니라 트리거에 둔다: 이름 없는 CHECK는 다음 판이
-- 빼거나 넓히지 못하고, 트리거는 DROP·CREATE로 다시 만든다(이관 0006 머리의 주석).

INSERT INTO run_transitions (kind, from_state, to_state) VALUES
  ('worker', 'stopping', 'not_started');

-- 관리자 닫기의 근거. 실행마다 한 줄이고 닫는 트랜잭션에서 상태를 not_started로 바꾸기 전에 적는다.
-- - from_state: 닫기 전의 장부 상태(unknown_running·stopping, 아래 트리거).
-- - checked_by: 관리자가 확인한 방법. pod_replaced(작업자 파드가 바뀌었다)·process_absent(작업자 프로세스가 없다) 둘 가운데 하나.
-- - pod_name: 관리자가 확인한 파드의 이름. Kubernetes 이름 규칙(DNS 서브도메인: 소문자·숫자·'-'·'.', 253자 이하, 라벨마다 영숫자로
--   시작하고 끝남)만 받는다. 장부는 원문을 넣지 않으므로 자유 메모 칸은 없다. "누가" 칸도 없다: 관리 진입점이 넘기는 이름은 검증되지 않는다.
-- - stop_generation: 닫은 때의 정지 세대(stop_state.generation). closed_at: 닫은 시각(장부 시계).
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
-- 지금의 정지 기록과 다르거나 정지 기록이 없음.
-- 파드 이름의 GLOB: 첫·끝 글자가 영숫자이고, 영숫자·'-'·'.' 밖의 글자가 없고, '..'·'.-'·'-.'가 없다(라벨이 비거나 '-'로 시작·끝남).
-- 이 트리거가 보지 않는 것: 장부가 건강한지, 접수·사본 보류·정지 여부. 이것들은 ledger.ts의 closeRunByOperator가 정한다.
CREATE TRIGGER operator_closures_proven BEFORE INSERT ON operator_closures
WHEN EXISTS (SELECT 1 FROM operator_closures o WHERE o.run_id = NEW.run_id)
  OR EXISTS (SELECT 1 FROM unreceived_closures c WHERE c.run_id = NEW.run_id)
  OR (NEW.from_state IN ('unknown_running', 'stopping')) IS NOT 1
  OR (NEW.checked_by IN ('pod_replaced', 'process_absent')) IS NOT 1
  OR (length(NEW.pod_name) BETWEEN 1 AND 253) IS NOT 1
  OR (NEW.pod_name GLOB '[a-z0-9]' OR NEW.pod_name GLOB '[a-z0-9]*[a-z0-9]') IS NOT 1
  OR (NEW.pod_name GLOB '*[^a-z0-9.-]*') IS NOT 0
  OR (instr(NEW.pod_name, '..') + instr(NEW.pod_name, '.-') + instr(NEW.pod_name, '-.')) IS NOT 0
  OR NOT EXISTS (SELECT 1 FROM runs r WHERE r.run_id = NEW.run_id AND r.kind = 'worker' AND r.state = NEW.from_state
    AND r.stop_receipt_id IS NULL)
  OR NEW.stop_generation IS NOT (SELECT s.generation FROM stop_state s WHERE s.id = 1)
BEGIN
  SELECT RAISE(ABORT, 'operator_closure_unproven');
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
-- 판 6의 unreceived_closures_proven은 그대로 두고 트리거를 하나 더한다(같은 표의 BEFORE INSERT 트리거는 모두 돈다).
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
