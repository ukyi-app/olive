-- 실행기가 받은 적 없는 작업자 실행을 "시작하지 않음"(not_started)으로 닫아 자리를 푸는 판(D-90). 세 가지를 더한다.
-- 1. 전이 두 줄: 작업자의 preparing → not_started, unknown_running → not_started.
-- 2. start_dispatches(송신 표식): 감독이 시작 봉투를 연결에 싣기 직전에 "이 장부 열기(open_id)가 실었다"를 적는다.
-- 3. unreceived_closures(닫기 근거): D-90으로 닫은 실행마다 한 줄. not_started로 가는 queued 밖의 갱신은 이 줄이 있을 때만 된다.
-- 새 표·트리거·전이 줄만 더한다. 기존 표·줄·트리거는 그대로이고, 올라간 장부의 두 표는 비어 있다(지난 일은 거슬러 적지 않는다).
-- 함정: 표의 CHECK와 칸 목록은 다음 판에서 바꿀 수 없다(SQLite는 CHECK를 고치지 못하고 이 장부는 표 재생성을 지원하지 않는다).
-- 그래서 늘어날 수 있는 집합(닫을 수 있는 앞 상태, 닫기의 원인)은 CHECK에 두지 않고 트리거에 둔다. 트리거는 다음 판이 DROP·CREATE로
-- 바꿀 수 있다. 닫기의 원인은 표로 나눈다: 이 판은 D-90의 표 하나만 두고, 관리자 닫기(D-91)는 다음 판이 자기 표를 더한 뒤
-- runs_not_started_needs_closure를 "두 표 가운데 하나에 근거가 있으면"으로 다시 만든다. 모든 칸이 NOT NULL이라 NULL이 CHECK를 통과로
-- 읽히는 함정이 없다. 트리거의 대조는 NOT EXISTS·EXISTS라 비교 값에 NULL이 섞이면 맞는 줄이 없는 것으로 읽혀 막는 쪽으로 간다.

INSERT INTO run_transitions (kind, from_state, to_state) VALUES
  ('worker', 'preparing', 'not_started'),
  ('worker', 'unknown_running', 'not_started');

-- 송신 표식. (실행, 열기)마다 한 줄이다. open_id는 장부 객체를 열 때마다 새로 만드는 값이라(ledger.ts) 다시 열면 달라진다.
-- 표식이 없으면 그 실행의 시작 봉투는 한 번도 실리지 않았다: 시작 봉투를 싣는 모든 길은 표식을 커밋한 뒤에만 싣는다(감독 쪽이 지킬 조건,
-- ledger.md "송신 표식"). 다른 열기의 표식이 있으면 그 열기가 실은 뒤 받은 관측을 이 열기가 잃었을 수 있어 자동으로 닫지 않는다.
-- request_id는 그 실행의 시작 지시(task_start) 줄이어야 한다(아래 INSERT 트리거). marked_at은 표식을 적은 때의 시각이다.
-- 줄은 지우거나 고치지 않는다.
CREATE TABLE start_dispatches (
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  request_id TEXT NOT NULL REFERENCES instructions (request_id),
  open_id TEXT NOT NULL,
  marked_at INTEGER NOT NULL CHECK (marked_at BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (run_id, open_id)
) STRICT, WITHOUT ROWID;

-- 그 실행의 시작 지시를 가리키는 표식만 들이고, 같은 (실행, 열기)의 두 번째 INSERT는 막는다. INSERT OR REPLACE는 옛 줄을 지우고
-- 새 줄을 들이는데 REPLACE가 지우는 줄에는 DELETE 트리거가 걸리지 않으므로(recursive_triggers 꺼짐) 기본 키보다 먼저 여기서 막는다.
CREATE TRIGGER start_dispatches_start_only BEFORE INSERT ON start_dispatches
WHEN NOT EXISTS (SELECT 1 FROM instructions i WHERE i.request_id = NEW.request_id AND i.run_id = NEW.run_id AND i.action = 'task_start')
  OR EXISTS (SELECT 1 FROM start_dispatches s WHERE s.run_id = NEW.run_id AND s.open_id = NEW.open_id)
BEGIN
  SELECT RAISE(ABORT, 'start_dispatch_fixed');
END;

CREATE TRIGGER start_dispatches_fixed BEFORE UPDATE ON start_dispatches
BEGIN
  SELECT RAISE(ABORT, 'start_dispatch_fixed');
END;

CREATE TRIGGER start_dispatches_permanent BEFORE DELETE ON start_dispatches
BEGIN
  SELECT RAISE(ABORT, 'start_dispatch_fixed');
END;

-- D-90 닫기의 근거. 실행마다 한 줄이고 닫는 트랜잭션에서 상태를 not_started로 바꾸기 전에 적는다.
-- - from_state: 닫기 전의 장부 상태. 허용 값은 아래 INSERT 트리거가 본다(CHECK에 두면 다음 판이 바꿀 수 없다).
-- - answer_executor_id·answer_issued_at: 그 실행을 싣지 않은 전체 답(hello)을 낸 실행기와 그 답 봉투의 issued_at(실행기 시계).
-- - answer_received_at: 감독이 그 답을 받은 시각. open_id: 닫은 장부 열기. closed_at: 닫은 시각.
-- 줄은 지우거나 고치지 않는다.
CREATE TABLE unreceived_closures (
  run_id TEXT PRIMARY KEY REFERENCES runs (run_id),
  from_state TEXT NOT NULL,
  answer_executor_id TEXT NOT NULL,
  answer_issued_at INTEGER NOT NULL CHECK (answer_issued_at BETWEEN 1 AND 9007199254740991),
  answer_received_at INTEGER NOT NULL CHECK (answer_received_at BETWEEN 1 AND 9007199254740991),
  open_id TEXT NOT NULL,
  closed_at INTEGER NOT NULL CHECK (closed_at BETWEEN 1 AND 9007199254740991)
) STRICT, WITHOUT ROWID;

-- DB 수준의 이중 확인: 코드의 검사가 빠져도 받은 적이 있다는 흔적이 있는 실행의 근거 줄은 들어가지 않는다. 막는 것:
-- 이미 근거가 있음(INSERT OR REPLACE 포함), 작업자가 아님, 지금 상태가 from_state가 아니거나 preparing·unknown_running이 아님,
-- 종료 확인이 있음, 답을 낸 쪽이 지정 실행기가 아님, 그 실행의 영수증·보고(deliveries)·양성 관측(run_sightings)·점유 관측(slot_holds)이
-- 한 줄이라도 있음, 시작 지시가 없음, 답의 시각이 어느 시작 지시의 발행 + 30000ms(계약 v1의 RUN_LEASE_MAX_MS·MESSAGE_TTL_MAX_MS)보다
-- 이름(정각은 받는다), 근거 줄의 열기가 아닌 열기의 송신 표식이 있음, 시작 지시의 발행이 이 판의 적용 시각보다 이름, 실행의 생성이나
-- 시작 지시의 발행이 사본 기록의 시각 이하임. 열기가 지금 장부 객체의 것인지, 장부가 건강한지, 사본 보류·정지인지는 코드만 본다.
CREATE TRIGGER unreceived_closures_proven BEFORE INSERT ON unreceived_closures
WHEN EXISTS (SELECT 1 FROM unreceived_closures c WHERE c.run_id = NEW.run_id)
  OR NEW.from_state NOT IN ('preparing', 'unknown_running')
  OR NOT EXISTS (SELECT 1 FROM runs r WHERE r.run_id = NEW.run_id AND r.kind = 'worker' AND r.state = NEW.from_state
    AND r.stop_receipt_id IS NULL AND r.executor_id = NEW.answer_executor_id)
  OR EXISTS (SELECT 1 FROM deliveries d WHERE d.run_id = NEW.run_id)
  OR EXISTS (SELECT 1 FROM run_sightings s WHERE s.run_id = NEW.run_id)
  OR EXISTS (SELECT 1 FROM slot_holds h WHERE h.run_id = NEW.run_id)
  OR NOT EXISTS (SELECT 1 FROM instructions i WHERE i.run_id = NEW.run_id AND i.action = 'task_start')
  OR EXISTS (SELECT 1 FROM instructions i WHERE i.run_id = NEW.run_id AND i.action IN ('task_start', 'session_start')
    AND NOT (NEW.answer_issued_at >= i.issued_at + 30000))
  OR EXISTS (SELECT 1 FROM start_dispatches m WHERE m.run_id = NEW.run_id AND m.open_id <> NEW.open_id)
  OR NOT EXISTS (SELECT 1 FROM ledger_migrations g WHERE g.version = 6 AND g.name = '0006-unreceived-closure.sql')
  OR EXISTS (SELECT 1 FROM instructions i, ledger_migrations g WHERE i.run_id = NEW.run_id AND i.action = 'task_start'
    AND g.version = 6 AND NOT (i.issued_at >= g.applied_at))
  OR EXISTS (SELECT 1 FROM ledger_snapshots p, runs r WHERE r.run_id = NEW.run_id AND NOT (r.created_at > p.taken_at))
  OR EXISTS (SELECT 1 FROM ledger_snapshots p, instructions i WHERE i.run_id = NEW.run_id AND i.action = 'task_start'
    AND NOT (i.issued_at > p.taken_at))
BEGIN
  SELECT RAISE(ABORT, 'unreceived_closure_unproven');
END;

CREATE TRIGGER unreceived_closures_fixed BEFORE UPDATE ON unreceived_closures
BEGIN
  SELECT RAISE(ABORT, 'unreceived_closure_unproven');
END;

CREATE TRIGGER unreceived_closures_permanent BEFORE DELETE ON unreceived_closures
BEGIN
  SELECT RAISE(ABORT, 'unreceived_closure_unproven');
END;

-- queued 밖에서 not_started로 가는 갱신은 그 실행의 닫기 근거 줄이 같은 앞 상태로 먼저 있을 때만 된다. 전이표의 두 줄은 아무 쓰기나
-- 그 길로 가게 하므로 여기서 근거에 묶는다. 대기 실행의 취소(queued → not_started)는 그대로다.
CREATE TRIGGER runs_not_started_needs_closure BEFORE UPDATE OF state ON runs
WHEN NEW.state = 'not_started' AND OLD.state NOT IN ('queued', 'not_started')
  AND NOT EXISTS (SELECT 1 FROM unreceived_closures c WHERE c.run_id = NEW.run_id AND c.from_state = OLD.state)
BEGIN
  SELECT RAISE(ABORT, 'run_closure_unproven');
END;
