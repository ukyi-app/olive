-- 오케스트레이터 세션이 start_worker로 낸 작업 부탁. 실행 줄(runs)이 아니다: 맞는 실행기·계정이 없어도 부탁만 적고 같은 참조를 돌려준다
-- (배정 전 대기). 실행기·자격·기한·예산·슬롯은 배정할 때 실행 줄이 갖는다. 원문·자유 글·모델 이름·경로는 칸이 없다.
-- 소유자는 부탁을 낸 논리 요청(inputs의 요청 ID)이다. 재시도 키는 소유자에 묶여 (소유자, 키)마다 한 줄이고, 다른 소유자의 같은 키는
-- 서로 다른 줄이다. 읽기는 소유자가 같은 줄만 본다(ledger.ts의 findToolRequest·readToolRequest).
-- 단계는 배정 전의 것 둘뿐이다: waiting_assignment(대기), not_started(배정 전에 취소돼 시작하지 않음). 배정한 뒤의 단계는 run_id가
-- 가리키는 실행 줄의 상태이고 이 표에 적지 않는다. run_id를 채우는 연산(배정)은 이 판에 없다.
CREATE TABLE tool_requests (
  -- 장부가 돌려주는 불투명 참조(UUID). 배정 뒤에도 같다.
  ref TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES inputs (request_id),
  dedupe_key TEXT NOT NULL,
  -- 재시도 키의 내용. 같은 키에 넷 가운데 하나라도 다르면 충돌이다.
  role TEXT NOT NULL,
  purpose TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  -- 부탁을 기록한 호출. 감사용이고 판단에 쓰지 않는다(같은 부탁은 세션이 바뀌어도 같은 줄이다).
  session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('waiting_assignment', 'not_started')),
  -- 배정기가 이 부탁을 이을 실행. 부탁 하나에 실행 하나이고, 취소된 부탁은 잇지 않는다.
  run_id TEXT UNIQUE REFERENCES runs (run_id),
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 1 AND 9007199254740991),
  cancelled_at INTEGER CHECK (cancelled_at IS NULL OR cancelled_at BETWEEN 1 AND 9007199254740991),
  cancel_session_id TEXT,
  cancel_call_id TEXT,
  UNIQUE (owner, dedupe_key),
  CHECK ((phase = 'not_started') = (cancelled_at IS NOT NULL)),
  CHECK ((cancelled_at IS NULL) = (cancel_session_id IS NULL) AND (cancelled_at IS NULL) = (cancel_call_id IS NULL)),
  CHECK (run_id IS NULL OR phase = 'waiting_assignment')
) STRICT, WITHOUT ROWID;

-- 부탁은 대기로만 태어나고 실행에 이어진 채 태어나지 않는다. 같은 참조나 같은 (소유자, 키)의 INSERT는 REPLACE로 옛 줄을 지우고
-- 새 참조를 들일 수 있으므로(REPLACE가 지우는 줄에는 DELETE 트리거가 걸리지 않는다) 유일 인덱스보다 먼저 여기서 막는다.
CREATE TRIGGER tool_requests_born_waiting BEFORE INSERT ON tool_requests
WHEN NEW.phase <> 'waiting_assignment' OR NEW.run_id IS NOT NULL OR NEW.cancelled_at IS NOT NULL
  OR EXISTS (SELECT 1 FROM tool_requests WHERE ref = NEW.ref OR (owner = NEW.owner AND dedupe_key = NEW.dedupe_key))
BEGIN
  SELECT RAISE(ABORT, 'tool_request_fixed');
END;

-- 지우면 같은 키의 새 부탁이 다른 참조로 생긴다.
CREATE TRIGGER tool_requests_permanent BEFORE DELETE ON tool_requests
BEGIN
  SELECT RAISE(ABORT, 'tool_request_fixed');
END;

-- 소유자·키·내용·기록한 호출은 바뀌지 않는다. 바뀔 수 있는 것은 둘이다: 대기 → not_started(취소 접수, 한 번), 빈 run_id → 실행(배정, 한 번).
-- run_id의 유일 인덱스도 UPDATE OR REPLACE면 다른 부탁의 줄을 지우므로 여기서 먼저 막는다.
CREATE TRIGGER tool_requests_fixed BEFORE UPDATE ON tool_requests
WHEN NEW.ref IS NOT OLD.ref OR NEW.owner IS NOT OLD.owner OR NEW.dedupe_key IS NOT OLD.dedupe_key OR NEW.role IS NOT OLD.role
  OR NEW.purpose IS NOT OLD.purpose OR NEW.source_ref IS NOT OLD.source_ref OR NEW.input_digest IS NOT OLD.input_digest
  OR NEW.session_id IS NOT OLD.session_id OR NEW.call_id IS NOT OLD.call_id OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.phase = 'not_started' AND (NEW.phase IS NOT OLD.phase OR NEW.cancelled_at IS NOT OLD.cancelled_at
    OR NEW.cancel_session_id IS NOT OLD.cancel_session_id OR NEW.cancel_call_id IS NOT OLD.cancel_call_id))
  OR (OLD.run_id IS NOT NULL AND NEW.run_id IS NOT OLD.run_id)
  OR (NEW.run_id IS NOT NULL AND EXISTS (SELECT 1 FROM tool_requests WHERE run_id = NEW.run_id AND ref <> NEW.ref))
BEGIN
  SELECT RAISE(ABORT, 'tool_request_fixed');
END;
