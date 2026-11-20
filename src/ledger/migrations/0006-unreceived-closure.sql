-- 실행기가 받은 적 없는 작업자 실행을 "시작하지 않음"(not_started)으로 닫아 자리를 푸는 판(D-90). 여섯 가지를 더한다.
-- 1. 전이 두 줄: 작업자의 preparing → not_started, unknown_running → not_started.
-- 2. start_dispatches(송신 표식): 감독이 시작 봉투를 연결에 싣기 직전에 "이 장부 열기(open_id)가 실었을 수 있다"를 적는다.
-- 3. unreceived_closures(닫기 근거): D-90으로 닫은 실행마다 한 줄. not_started로 가는 queued 밖의 갱신은 이 줄이 있을 때만 된다.
-- 4. starts_before_closure: 이 판을 적용하는 트랜잭션에 이미 있던 시작 지시. 그 뒤로는 줄이 늘지 않는다.
-- 5. snapshots_before_closure: 이 판을 적용하는 트랜잭션에 이미 있던 사본 기록(경계를 모르는 사본). 그 뒤로는 줄이 늘지 않는다.
-- 6. snapshot_run_bounds(사본의 경계): 사본을 만들 때 그 장부의 접수 순번(runs.queue_seq) 최댓값. 이 판 뒤에 만든 사본 기록 하나에 한 줄.
-- 새 표·트리거·전이 줄만 더한다. 기존 표·줄·트리거는 그대로다. 올라간 장부에서 start_dispatches·unreceived_closures·snapshot_run_bounds는
-- 비어 있고(지난 일은 거슬러 적지 않는다), starts_before_closure·snapshots_before_closure에는 적용 때 있던 시작 지시·사본 기록이 모두
-- 들어간다(처음부터 이 판인 장부는 둘 다 빈다).
--
-- NULL을 막는 것: 새 표 다섯의 모든 칸은 NOT NULL이다(기본 키 칸도 적었다). NULL은 이 NOT NULL 제약이 막는다. BEFORE INSERT 트리거는
-- NOT NULL 검사보다 먼저 돌고, 트리거의 검사 가운데 "NOT EXISTS(맞는 줄)"는 비교 값에 NULL이 섞이면 맞는 줄이 없어 막는 쪽으로 가지만
-- "EXISTS(맞는 줄)"은 맞는 줄이 없어 막지 않는 쪽으로 간다. 그래서 트리거만으로 NULL을 막는다고 읽으면 안 된다.
-- 기존 표의 NULL 허용 칸과 비교하는 곳(instructions.budget_left: 판 4 전에 적힌 시작 지시는 NULL)은 IS NOT으로 비교해 NULL을 다름으로 읽는다.
--
-- 다음 판이 바꿀 수 있는 것(이 저장소의 Bun 1.4.4가 묶은 SQLite 3.53.4에서 돌려 본 것): 트리거는 DROP·CREATE로 다시 만든다. 칸은
-- ALTER TABLE ADD COLUMN으로 더한다(0002·0004가 그렇게 했다. NOT NULL 칸은 기본값이 있어야 더해지고 기존 줄은 그 기본값이 된다).
-- 있는 칸의 NOT NULL은 ALTER COLUMN의 SET NOT NULL·DROP NOT NULL로 넣고 뺀다(NULL인 줄이 있으면 SET은 실패한다).
-- 바꿀 수 없는 것: 칸에 이름 없이 단 CHECK는 빼거나 넓히지 못한다(DROP CONSTRAINT는 이름 붙은 제약만 받고, 더 넓은 CHECK를 더해도
-- 옛 CHECK가 그대로 막는다). 기본 키를 더하는 ADD PRIMARY KEY는 구문 오류다. 그래서 늘어날 수 있는 집합(닫을 수 있는 앞 상태)은
-- CHECK에 두지 않고 트리거에 두고, 닫기의 원인은 표로 나눈다: 이 판은 D-90의 표 하나만 두고, 관리자 닫기(D-91)는 다음 판이 자기 표를
-- 더한 뒤 runs_not_started_needs_closure를 "두 표 가운데 하나에 근거가 있으면"으로 다시 만든다.

INSERT INTO run_transitions (kind, from_state, to_state) VALUES
  ('worker', 'preparing', 'not_started'),
  ('worker', 'unknown_running', 'not_started');

-- 송신 표식. (실행, 열기)마다 한 줄이다. open_id는 장부 객체를 열 때마다 새로 만드는 값이라(ledger.ts) 다시 열면 달라진다.
-- 표식은 "이 열기에서 그 시작을 실었을 수 있다"는 증거이지 실었다는 증거가 아니다: 표식을 커밋한 뒤 실제로 싣기 전에 감독이 죽어도
-- 표식은 남고, 다시 연 장부에서는 다른 열기의 표식이라 자동으로 닫지 않는다(손 닫기로 간다).
-- 표식이 없는 것이 "한 번도 실리지 않았다"인 것은 시작 봉투를 싣는 모든 길이 표식을 커밋한 뒤에만 실을 때(감독 쪽이 지킬 조건,
-- ledger.md "송신 표식"), 그리고 그 시작이 이 판을 적용한 뒤에 낸 것이고(starts_before_closure에 없음) 사본의 경계 밖일 때뿐이다.
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

-- 이 판을 적용할 때 이미 있던 시작 지시. 송신 표식이 없던 판에서 낸 시작이라 표식이 없어도 실리지 않았다고 읽을 수 없다.
-- 적용 시각과 발행 시각의 비교로 가르면 같은 밀리초나 뒤로 간 시계에서 판 이전의 시작이 판 이후로 읽힌다. 그래서 값으로 남긴다.
-- 줄은 바로 아래 INSERT(이 판의 트랜잭션 안)에서만 들어가고, 그 뒤의 INSERT·UPDATE·DELETE는 트리거가 막는다.
CREATE TABLE starts_before_closure (
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  request_id TEXT NOT NULL REFERENCES instructions (request_id),
  PRIMARY KEY (run_id, request_id)
) STRICT, WITHOUT ROWID;

INSERT INTO starts_before_closure (run_id, request_id)
  SELECT run_id, request_id FROM instructions WHERE action IN ('task_start', 'session_start');

CREATE TRIGGER starts_before_closure_sealed BEFORE INSERT ON starts_before_closure
BEGIN
  SELECT RAISE(ABORT, 'starts_before_closure_fixed');
END;

CREATE TRIGGER starts_before_closure_fixed BEFORE UPDATE ON starts_before_closure
BEGIN
  SELECT RAISE(ABORT, 'starts_before_closure_fixed');
END;

CREATE TRIGGER starts_before_closure_permanent BEFORE DELETE ON starts_before_closure
BEGIN
  SELECT RAISE(ABORT, 'starts_before_closure_fixed');
END;

-- 이 판을 적용할 때 이미 있던 사본 기록. 그 사본을 봉할 때는 경계가 없어서 어느 실행이 사본에 들어 있었는지 모른다.
-- 이 집합에 줄이 하나라도 있는 장부에서는 자동으로 닫지 않는다. 아래의 경계 트리거는 이 집합에 든 사본 기록의 경계를 받지 않는다:
-- 옛 사본에서 뜬 장부의 대조 전에는 그 사본의 기록이 "가장 최근의 대조 안 된 기록"이라 새 사본을 봉하는 순간과 행으로 구별되지 않는다.
-- 줄은 바로 아래 INSERT(이 판의 트랜잭션 안)에서만 들어가고, 그 뒤의 INSERT·UPDATE·DELETE는 트리거가 막는다.
CREATE TABLE snapshots_before_closure (
  snapshot_id TEXT NOT NULL PRIMARY KEY REFERENCES ledger_snapshots (snapshot_id)
) STRICT, WITHOUT ROWID;

INSERT INTO snapshots_before_closure (snapshot_id) SELECT snapshot_id FROM ledger_snapshots;

CREATE TRIGGER snapshots_before_closure_sealed BEFORE INSERT ON snapshots_before_closure
BEGIN
  SELECT RAISE(ABORT, 'snapshots_before_closure_fixed');
END;

CREATE TRIGGER snapshots_before_closure_fixed BEFORE UPDATE ON snapshots_before_closure
BEGIN
  SELECT RAISE(ABORT, 'snapshots_before_closure_fixed');
END;

CREATE TRIGGER snapshots_before_closure_permanent BEFORE DELETE ON snapshots_before_closure
BEGIN
  SELECT RAISE(ABORT, 'snapshots_before_closure_fixed');
END;

-- 사본의 경계: 사본을 만들 때(snapshot.ts의 sealSnapshot, 사본 기록과 같은 그림 안) 그 장부의 runs.queue_seq 최댓값(실행이 없으면 0).
-- queue_seq는 새 실행마다 최댓값 + 1이고(ledger.ts의 admitRun) 실행 줄은 지우거나 순번을 고칠 수 없어(0001의 runs_permanent·runs_evidence)
-- 최댓값이 뒤로 가지 않는다.
-- 그래서 순번이 경계 이하인 실행은 사본에 들어 있던 실행이고, 사본에서 되살린 장부가 새로 만든 실행은 경계보다 크다. 시계를 쓰지 않는다.
-- 사본 기록에 이 줄이 없으면 경계를 모른다: 그 장부에서는 자동으로 닫지 않는다. 이 판을 적용하기 전에 만든 사본 기록은
-- snapshots_before_closure에 값으로 남아 뒤에도 경계를 얻지 못한다.
-- 기존 ledger_snapshots에 칸을 더하지 않은 이유: 더한 칸에는 기존 기록의 "모름"을 기본값(지어낸 숫자)이나 NULL로 적어야 하고, 그 표의
-- 고침 막기 트리거(ledger_snapshots_reconcile_only)는 칸을 이름으로 나열해 더한 칸을 지키지 못한다. 새 표면 "모름"은 줄이 없음으로 드러난다.
CREATE TABLE snapshot_run_bounds (
  snapshot_id TEXT NOT NULL PRIMARY KEY REFERENCES ledger_snapshots (snapshot_id),
  queue_seq_bound INTEGER NOT NULL CHECK (queue_seq_bound BETWEEN 0 AND 9007199254740991)
) STRICT, WITHOUT ROWID;

-- 경계는 가장 최근의 대조 안 된 사본 기록(사본을 봉하는 그 순간의 줄)에만, 한 번, 그 그림의 queue_seq 최댓값 그대로 들어간다.
-- snapshots_before_closure에 든 기록에는 들어가지 않는다. 그래서 이 판 전에 만든 사본의 "모름"은 뒤에 값으로 바뀌지 않고, 이 판 뒤에
-- 봉한 기록은 이미 경계가 있어 두 번째 줄을 받지 않는다. IS NOT이라 NULL도 여기서 막힌다(NOT NULL도 막는다).
CREATE TRIGGER snapshot_run_bounds_sealed BEFORE INSERT ON snapshot_run_bounds
WHEN NOT EXISTS (SELECT 1 FROM ledger_snapshots s WHERE s.snapshot_id = NEW.snapshot_id AND s.reconciled_at IS NULL
    AND s.seq = (SELECT MAX(seq) FROM ledger_snapshots))
  OR EXISTS (SELECT 1 FROM snapshots_before_closure o WHERE o.snapshot_id = NEW.snapshot_id)
  OR EXISTS (SELECT 1 FROM snapshot_run_bounds b WHERE b.snapshot_id = NEW.snapshot_id)
  OR NEW.queue_seq_bound IS NOT (SELECT COALESCE(MAX(queue_seq), 0) FROM runs)
BEGIN
  SELECT RAISE(ABORT, 'snapshot_bound_fixed');
END;

CREATE TRIGGER snapshot_run_bounds_fixed BEFORE UPDATE ON snapshot_run_bounds
BEGIN
  SELECT RAISE(ABORT, 'snapshot_bound_fixed');
END;

CREATE TRIGGER snapshot_run_bounds_permanent BEFORE DELETE ON snapshot_run_bounds
BEGIN
  SELECT RAISE(ABORT, 'snapshot_bound_fixed');
END;

-- D-90 닫기의 근거. 실행마다 한 줄이고 닫는 트랜잭션에서 상태를 not_started로 바꾸기 전에 적는다.
-- - from_state: 닫기 전의 장부 상태. 허용 값은 아래 INSERT 트리거가 본다(칸에 CHECK로 두면 다음 판이 넓히지 못한다).
-- - answer_executor_id·answer_issued_at: 그 실행을 싣지 않은 전체 답(hello)을 낸 실행기와 그 답 봉투의 issued_at(실행기 시계).
-- - answer_received_at: 감독이 그 답을 받은 시각. open_id: 닫은 장부 열기. closed_at: 닫은 시각.
-- 줄은 지우거나 고치지 않는다.
CREATE TABLE unreceived_closures (
  run_id TEXT NOT NULL PRIMARY KEY REFERENCES runs (run_id),
  from_state TEXT NOT NULL,
  answer_executor_id TEXT NOT NULL,
  answer_issued_at INTEGER NOT NULL CHECK (answer_issued_at BETWEEN 1 AND 9007199254740991),
  answer_received_at INTEGER NOT NULL CHECK (answer_received_at BETWEEN 1 AND 9007199254740991),
  open_id TEXT NOT NULL,
  closed_at INTEGER NOT NULL CHECK (closed_at BETWEEN 1 AND 9007199254740991)
) STRICT, WITHOUT ROWID;

-- 행으로 다시 보는 확인: 코드의 검사가 빠져도 아래 중 하나라도 맞으면 근거 줄은 들어가지 않는다.
-- 이미 근거가 있음(INSERT OR REPLACE 포함), 작업자가 아님, 지금 상태가 from_state가 아니거나 preparing·unknown_running이 아님,
-- 종료 확인이 있음, 답을 낸 쪽이 지정 실행기가 아님, 그 실행의 영수증·보고(deliveries)·양성 관측(run_sightings)·점유 관측(slot_holds)이
-- 한 줄이라도 있음, 시작 지시가 없음, 답의 시각이 어느 시작 지시의 발행 + 30000ms(계약 v1의 RUN_LEASE_MAX_MS·MESSAGE_TTL_MAX_MS)보다
-- 이름(정각은 받는다), 시작 지시에 고정된 예산(budget_left)과 실행의 지금 남은 예산이 다름(시작 뒤 감액이 적힘. 닫으면 그 감액이
-- 다음 실행의 상한에서 빠진다), 근거 줄의 열기가 아닌 열기의 송신 표식이 있음, 그 실행의 시작이 starts_before_closure에 있음,
-- 이 판의 적용 기록이 없거나 시작 지시의 발행이 그 적용 시각보다 이름, snapshots_before_closure에 줄이 하나라도 있음, 경계 없는 사본
-- 기록이 하나라도 있음, 실행의 순번이 어느 사본의 경계 이하임, 실행의 생성이나 시작 지시의 발행이 사본 기록의 시각 이하임.
-- 판 이전의 시작과 사본 안의 실행은 위의 값(starts_before_closure, snapshots_before_closure, 사본의 경계)으로 가른다. 함께 보는 시각의
-- 두 비교(적용 시각, 사본 시각)는 그 값 밖의 실행을 더 막기만 하는 보조이고, 같은 밀리초를 다르게 다룬다. 적용 시각: 발행 < 적용이면
-- 막는다(같은 밀리초는 받는다). 사본 시각: 생성 ≤ 사본 시각이거나 발행 ≤ 사본 시각이면 막는다(같은 밀리초도 막는다). 그래서 시계가
-- 뒤로 가지 않은 장부에서도 사본과 같은 밀리초에 만든(runs.created_at: 접수 때 부르는 쪽이 넘긴 시각) 또는 발행한(장부 시계) 새 실행은
-- 닫지 않는다. 그 시각은 고정 값이라 기다려도 풀리지 않고 손 닫기로 간다.
-- 이 트리거가 보지 않는 것: 근거 줄의 open_id가 지금 장부 객체의 것인지, 답의 실행 목록에 그 실행이 없는지(근거 줄에 목록이 없다),
-- 시작 지시가 정확히 하나인지, 장부가 건강한지, 사본 보류·정지·접수 허가. 이것들은 ledger.ts의 closeUnreceivedRun만 본다.
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
  OR EXISTS (SELECT 1 FROM instructions i, runs r WHERE i.run_id = NEW.run_id AND i.action = 'task_start' AND r.run_id = NEW.run_id
    AND i.budget_left IS NOT r.budget_left)
  OR EXISTS (SELECT 1 FROM start_dispatches m WHERE m.run_id = NEW.run_id AND m.open_id <> NEW.open_id)
  OR EXISTS (SELECT 1 FROM starts_before_closure b WHERE b.run_id = NEW.run_id)
  OR NOT EXISTS (SELECT 1 FROM ledger_migrations g WHERE g.version = 6 AND g.name = '0006-unreceived-closure.sql')
  OR EXISTS (SELECT 1 FROM instructions i, ledger_migrations g WHERE i.run_id = NEW.run_id AND i.action = 'task_start'
    AND g.version = 6 AND NOT (i.issued_at >= g.applied_at))
  OR EXISTS (SELECT 1 FROM snapshots_before_closure)
  OR EXISTS (SELECT 1 FROM ledger_snapshots p WHERE NOT EXISTS (SELECT 1 FROM snapshot_run_bounds b WHERE b.snapshot_id = p.snapshot_id))
  OR EXISTS (SELECT 1 FROM snapshot_run_bounds b, runs r WHERE r.run_id = NEW.run_id AND NOT (r.queue_seq > b.queue_seq_bound))
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
