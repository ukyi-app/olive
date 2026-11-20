-- 실행기가 그 실행을 안다고 답한 첫 관측(양성 관측). 실행기가 hello·status_report에서 그 실행을 not_known 밖의 상태로 답하면
-- (실행, 실행기, 세대)마다 처음 받은 답 하나를 남긴다. "실행기가 그 실행을 받았다고 한 적이 한 번도 없다"(D-90의 조건 1)를 장부가 다시
-- 떠도 판정할 재료다. 그래서 줄은 지우거나 고치지 않고, 같은 열쇠의 답을 다시 받아도 첫 줄을 덮지 않는다.
-- - 지정 실행기가 같은 세대로 답한 것만 적는다: (run_id, executor_id, run_generation)이 runs의 그 실행·지정 실행기·실행 세대와 같아야
--   한다(아래 INSERT 트리거). runs의 세 칸은 바뀌지 않으므로(runs_evidence) 적은 뒤에도 맞는다. 장부 밖 실행은 적지 않는다(외래 키).
-- - reported_state: 실행기가 답한 상태. not_known은 "안다"는 답이 아니라 목록에 없다.
-- - last_receipt_id: 답이 실은 그 실행의 마지막 영수증 ID. 적기만 한다(영수증의 반영은 applyReceipt의 몫이다).
-- - answered_at: 답 봉투의 issued_at(실행기 시계). 재시작 복원 2단계의 관측은 포트가 답의 시각을 싣지 않아 NULL이다.
-- - received_at: 감독이 그 답을 장부에 적은 시각(장부 시계). coverage: full(hello의 전체 목록) 또는 partial(조회의 답).
-- CHECK는 정수의 범위, 상태·coverage의 목록, NULL 허용 여부만 본다. 값의 형식(UUID, 실행기 주체 이름)은 장부의 공개 쓰기가 검사한다.
-- 함정: CHECK는 NULL을 통과로 읽는다. NULL을 받는 칸은 answered_at·last_receipt_id 둘이고, 그 밖은 NOT NULL이 막는다.
-- answered_at의 범위 검사는 IS NULL을 따로 적어 NULL이 범위 비교를 통과한 것처럼 읽히지 않게 한다. 트리거의 대조는 NOT EXISTS라
-- 비교 값에 NULL이 섞이면 맞는 실행이 없는 것으로 읽혀 거절된다(통과로 열리지 않는다).
CREATE TABLE run_sightings (
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  executor_id TEXT NOT NULL,
  run_generation INTEGER NOT NULL CHECK (run_generation BETWEEN 1 AND 9007199254740991),
  reported_state TEXT NOT NULL CHECK (reported_state IN (
    'preparing', 'running', 'stopping', 'checking', 'ready_result', 'finalized',
    'not_started', 'failed_stopped', 'unknown_running', 'cleanup_pending'
  )),
  last_receipt_id TEXT,
  answered_at INTEGER CHECK (answered_at IS NULL OR answered_at BETWEEN 1 AND 9007199254740991),
  received_at INTEGER NOT NULL CHECK (received_at BETWEEN 1 AND 9007199254740991),
  coverage TEXT NOT NULL CHECK (coverage IN ('full', 'partial')),
  PRIMARY KEY (run_id, executor_id, run_generation)
) STRICT, WITHOUT ROWID;

-- 지정 실행기·같은 세대의 관측만 들이고, 같은 열쇠의 두 번째 INSERT는 막는다. INSERT OR REPLACE는 옛 줄을 지우고 새 줄을 들이는데
-- REPLACE가 지우는 줄에는 DELETE 트리거가 걸리지 않으므로(recursive_triggers 꺼짐) 기본 키보다 먼저 여기서 막는다.
CREATE TRIGGER run_sightings_first_only BEFORE INSERT ON run_sightings
WHEN NOT EXISTS (SELECT 1 FROM runs r WHERE r.run_id = NEW.run_id AND r.executor_id = NEW.executor_id AND r.run_generation = NEW.run_generation)
  OR EXISTS (SELECT 1 FROM run_sightings s WHERE s.run_id = NEW.run_id AND s.executor_id = NEW.executor_id AND s.run_generation = NEW.run_generation)
BEGIN
  SELECT RAISE(ABORT, 'run_sighting_fixed');
END;

CREATE TRIGGER run_sightings_fixed BEFORE UPDATE ON run_sightings
BEGIN
  SELECT RAISE(ABORT, 'run_sighting_fixed');
END;

CREATE TRIGGER run_sightings_permanent BEFORE DELETE ON run_sightings
BEGIN
  SELECT RAISE(ABORT, 'run_sighting_fixed');
END;
