-- O09가 쓰는 묶음(supervisor.md §8 표). 원문과 자격 값은 칸이 없다: 원문은 참조와 만료, 자격은 계정·방식·revision·digest만.
-- 시각은 모두 Unix epoch 밀리초 정수다. 표는 모두 STRICT라 칸의 타입이 어긋나면 쓰기가 실패한다.
-- 정수 칸은 모두 9007199254740991(JS의 안전 정수 상한) 이하다. 넘는 값은 Bun이 number로 읽을 때 정밀도를 잃어
-- 세대·예산의 비교가 틀어진다.
-- TEXT 키의 표는 모두 WITHOUT ROWID다. rowid가 있으면 논리 키가 달라도 rowid 충돌로 증거 행이 교체될 수 있다.

-- 첫 설치 기록(ledger_identity)은 마이그레이션이 아니라 openLedger의 create가 만든다(ledger.ts).

-- 정지·일시 중지. 줄이 없으면 "아직 적지 않음"이다(0과 다르다). 0도 줄로 적는다. 줄은 지울 수 없다(아래 트리거).
CREATE TABLE stop_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 0 AND 9007199254740991),
  stopped INTEGER NOT NULL CHECK (stopped IN (0, 1)),
  -- 확인 단계: supervisor.md §7.3 8(접수, 차단)과 §7.4의 결과 이름. 누가 언제 올리는지는 CLI 작업이 정한다.
  phase TEXT NOT NULL CHECK (phase IN ('none', 'accepted', 'blocked', 'node_unverified', 'node_verified', 'runtime_verified')),
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 1 AND 9007199254740991)
) STRICT;

-- 단조 증가를 저장하는 자리에서 다시 확인한다. 코드의 확인을 지나친 쓰기도 여기서 멈춘다.
-- UPDATE만 막으면 INSERT OR REPLACE(옛 줄을 지우고 넣음)와 DELETE 뒤 INSERT가 빠져나간다. 그래서 세 길을 모두 막는다.
-- REPLACE가 지우는 줄에는 DELETE 트리거가 걸리지 않으므로(recursive_triggers 꺼짐) INSERT 쪽에서 옛 줄과 비교한다.
CREATE TRIGGER stop_generation_monotonic BEFORE UPDATE OF generation ON stop_state
WHEN NEW.generation < OLD.generation
BEGIN
  SELECT RAISE(ABORT, 'stop_generation_lower');
END;

CREATE TRIGGER stop_generation_monotonic_insert BEFORE INSERT ON stop_state
WHEN EXISTS (SELECT 1 FROM stop_state WHERE id = NEW.id AND generation > NEW.generation)
BEGIN
  SELECT RAISE(ABORT, 'stop_generation_lower');
END;

CREATE TRIGGER stop_state_permanent BEFORE DELETE ON stop_state
BEGIN
  SELECT RAISE(ABORT, 'stop_state_permanent');
END;

CREATE TABLE diagnosis_pause (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  until_at INTEGER CHECK (until_at IS NULL OR until_at BETWEEN 1 AND 9007199254740991)
) STRICT;

-- 실행 세대의 지금 값. 새 실행은 이 값을 받고, 시작은 이 값과 같은 세대의 실행만 한다. 올리는 일(§7.6 풀기)은 뒤 작업이다.
CREATE TABLE run_epoch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991)
) STRICT;
INSERT INTO run_epoch (id, generation) VALUES (1, 1);

CREATE TRIGGER run_epoch_monotonic BEFORE UPDATE OF generation ON run_epoch
WHEN NEW.generation < OLD.generation
BEGIN
  SELECT RAISE(ABORT, 'run_epoch_lower');
END;

CREATE TRIGGER run_epoch_monotonic_insert BEFORE INSERT ON run_epoch
WHEN EXISTS (SELECT 1 FROM run_epoch WHERE id = NEW.id AND generation > NEW.generation)
BEGIN
  SELECT RAISE(ABORT, 'run_epoch_lower');
END;

CREATE TRIGGER run_epoch_permanent BEFORE DELETE ON run_epoch
BEGIN
  SELECT RAISE(ABORT, 'run_epoch_permanent');
END;

-- 입력·대기열. source_ref는 원문이 있는 곳의 참조이고 원문이 아니다.
CREATE TABLE inputs (
  request_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE CHECK (seq BETWEEN 1 AND 9007199254740991),
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_expires_at INTEGER NOT NULL CHECK (source_expires_at BETWEEN 1 AND 9007199254740991),
  received_at INTEGER NOT NULL CHECK (received_at BETWEEN 1 AND 9007199254740991),
  cancelled_at INTEGER CHECK (cancelled_at IS NULL OR cancelled_at BETWEEN 1 AND 9007199254740991)
) STRICT, WITHOUT ROWID;

-- 실행·슬롯·예산. 상태 이름은 supervisor.md §3의 것뿐이다.
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  run_generation INTEGER NOT NULL CHECK (run_generation BETWEEN 1 AND 9007199254740991),
  kind TEXT NOT NULL CHECK (kind IN ('worker', 'session')),
  role TEXT CHECK ((kind = 'worker') = (role IS NOT NULL)),
  queue_seq INTEGER NOT NULL UNIQUE CHECK (queue_seq BETWEEN 1 AND 9007199254740991),
  dedupe_key TEXT UNIQUE,
  input_request_id TEXT REFERENCES inputs (request_id),
  profile_revision TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  snapshot_digest TEXT CHECK ((kind = 'worker') = (snapshot_digest IS NOT NULL)),
  input_digest TEXT,
  executor_id TEXT NOT NULL,
  account TEXT NOT NULL,
  auth_method TEXT NOT NULL CHECK (auth_method IN ('subscription', 'api_key')),
  credential_revision TEXT NOT NULL,
  credential_digest TEXT NOT NULL,
  deadline_at INTEGER NOT NULL CHECK (deadline_at BETWEEN 1 AND 9007199254740991),
  -- 남은 예산(토큰 수). 아래 trigger가 늘리지 못하게 한다(재시도·계정 전환이 예산을 새로 주지 않는다).
  budget_left INTEGER NOT NULL CHECK (budget_left BETWEEN 0 AND 9007199254740991),
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'preparing', 'running', 'stopping', 'checking', 'ready_result', 'finalized',
    'not_started', 'failed_stopped', 'unknown_running', 'cleanup_pending'
  )),
  -- 영수증 id는 deliveries의 줄을 가리킨다. 그 줄이 같은 실행의 맞는 동작인지는 아래 runs_evidence 트리거가 본다.
  accepted_receipt_id TEXT,
  started_receipt_id TEXT,
  -- 종료 확인: 작업자는 receipt_stopped, 세션은 receipt_session_takeover(D-50).
  stop_receipt_id TEXT,
  cleaned_receipt_id TEXT,
  result_digest TEXT,
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 1 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 1 AND 9007199254740991),
  -- 종료 확인 영수증 없이 결과 쪽 상태가 되지 않는다.
  CHECK (state NOT IN ('checking', 'ready_result', 'failed_stopped', 'cleanup_pending') OR stop_receipt_id IS NOT NULL),
  CHECK (state <> 'ready_result' OR result_digest IS NOT NULL),
  CHECK (state <> 'finalized' OR (kind = 'worker' AND cleaned_receipt_id IS NOT NULL) OR (kind = 'session' AND stop_receipt_id IS NOT NULL)),
  CHECK (kind = 'worker' OR state NOT IN ('checking', 'ready_result', 'failed_stopped', 'cleanup_pending'))
) STRICT, WITHOUT ROWID;

-- 슬롯은 작업자 하나, 오케스트레이터(세션) 하나. 대기와 끝난 실행 밖은 모두 자리를 쥔다(unknown_running·cleanup_pending 포함).
CREATE UNIQUE INDEX runs_one_per_slot ON runs (kind) WHERE state NOT IN ('queued', 'finalized', 'not_started');

CREATE TRIGGER runs_budget_never_grows BEFORE UPDATE OF budget_left ON runs
WHEN NEW.budget_left > OLD.budget_left
BEGIN
  SELECT RAISE(ABORT, 'budget_grows');
END;

-- 실행 줄은 대기로만 태어나고 증거 칸은 비어 있다. 지울 수 없다(지우면 그 실행의 영수증이 장부 밖이 된다).
-- 이미 있는 줄과 키가 겹치는 INSERT는 REPLACE로 옛 줄을 지울 수 있으므로 여기서 막는다.
CREATE TRIGGER runs_born_queued BEFORE INSERT ON runs
WHEN NEW.state <> 'queued' OR NEW.accepted_receipt_id IS NOT NULL OR NEW.started_receipt_id IS NOT NULL
  OR NEW.stop_receipt_id IS NOT NULL OR NEW.cleaned_receipt_id IS NOT NULL OR NEW.result_digest IS NOT NULL
  OR EXISTS (SELECT 1 FROM runs WHERE run_id = NEW.run_id OR queue_seq = NEW.queue_seq OR dedupe_key = NEW.dedupe_key)
BEGIN
  SELECT RAISE(ABORT, 'run_evidence_mismatch');
END;

CREATE TRIGGER runs_permanent BEFORE DELETE ON runs
BEGIN
  SELECT RAISE(ABORT, 'runs_permanent');
END;

-- 증거 칸은 한 번만 채우고, 같은 실행이 받은 맞는 종류의 영수증만 가리킨다. CHECK는 비었는지만 보므로
-- 없는 id, 다른 실행의 영수증, 다른 종류의 영수증을 여기서 막는다.
CREATE TRIGGER runs_evidence BEFORE UPDATE ON runs
WHEN (NEW.stop_receipt_id IS NOT OLD.stop_receipt_id AND (OLD.stop_receipt_id IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM deliveries d WHERE d.id = NEW.stop_receipt_id AND d.run_id = NEW.run_id
          AND d.action = CASE NEW.kind WHEN 'worker' THEN 'receipt_stopped' ELSE 'receipt_session_takeover' END)))
  OR (NEW.cleaned_receipt_id IS NOT OLD.cleaned_receipt_id AND (OLD.cleaned_receipt_id IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM deliveries d JOIN instructions i ON i.request_id = d.instruction_request_id
        WHERE d.id = NEW.cleaned_receipt_id AND d.run_id = NEW.run_id AND d.action = 'receipt_cleaned' AND i.action = 'result_finalize')))
  OR (NEW.accepted_receipt_id IS NOT OLD.accepted_receipt_id AND (OLD.accepted_receipt_id IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM deliveries d WHERE d.id = NEW.accepted_receipt_id AND d.run_id = NEW.run_id AND d.action = 'receipt_accepted')))
  OR (NEW.started_receipt_id IS NOT OLD.started_receipt_id AND (OLD.started_receipt_id IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM deliveries d WHERE d.id = NEW.started_receipt_id AND d.run_id = NEW.run_id AND d.action = 'receipt_started')))
  OR NEW.run_id IS NOT OLD.run_id OR NEW.kind IS NOT OLD.kind OR NEW.run_generation IS NOT OLD.run_generation OR NEW.executor_id IS NOT OLD.executor_id
BEGIN
  SELECT RAISE(ABORT, 'run_evidence_mismatch');
END;

-- 실행기의 점유가 장부와 맞지 않은 관측(재시작 복원 2단계). 장부 밖 실행은 실행 줄로 올리지 않고 여기에만 남는다.
-- 줄 하나가 사실 둘을 따로 말한다: 이 실행 ID는 다시 시작하면 안 되고(줄이 있으면 항상), holds_slot이 1이면 그 종류의 슬롯도 사용 중이다.
-- 관측은 (실행기, 실행, 세대)마다 한 줄이다. 같은 관측을 다시 보면 새 번호를 받으므로, 앞선 번호로 늦게 온 해제는 지금의 관측을 지우지 못한다.
-- AUTOINCREMENT: 지운 번호를 다시 쓰면 옛 해제가 새 관측에 맞아 버린다. 재대조·종료 증명으로 줄을 지우는 쪽은 실제 연결 작업이다.
CREATE TABLE slot_holds (
  observation INTEGER PRIMARY KEY AUTOINCREMENT CHECK (observation BETWEEN 1 AND 9007199254740991),
  executor_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('worker', 'session')),
  run_generation INTEGER NOT NULL CHECK (run_generation BETWEEN 1 AND 9007199254740991),
  holds_slot INTEGER NOT NULL CHECK (holds_slot IN (0, 1)),
  why TEXT NOT NULL CHECK (why IN ('outside_ledger', 'ended_in_ledger', 'state', 'executor', 'generation')),
  held_at INTEGER NOT NULL CHECK (held_at BETWEEN 1 AND 9007199254740991),
  UNIQUE (executor_id, run_id, run_generation)
) STRICT;
CREATE INDEX slot_holds_run ON slot_holds (run_id);

-- 허용된 상태 전이. 코드(src/ledger/states.ts)와 같은 표이고 시험이 대조한다.
CREATE TABLE run_transitions (
  kind TEXT NOT NULL CHECK (kind IN ('worker', 'session')),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  PRIMARY KEY (kind, from_state, to_state)
) STRICT, WITHOUT ROWID;

INSERT INTO run_transitions (kind, from_state, to_state) VALUES
  ('worker', 'queued', 'preparing'),
  ('worker', 'queued', 'not_started'),
  ('worker', 'preparing', 'running'),
  ('worker', 'preparing', 'stopping'),
  ('worker', 'preparing', 'unknown_running'),
  ('worker', 'preparing', 'checking'),
  ('worker', 'preparing', 'failed_stopped'),
  ('worker', 'running', 'stopping'),
  ('worker', 'running', 'unknown_running'),
  ('worker', 'running', 'checking'),
  ('worker', 'running', 'failed_stopped'),
  ('worker', 'stopping', 'unknown_running'),
  ('worker', 'stopping', 'checking'),
  ('worker', 'stopping', 'failed_stopped'),
  ('worker', 'unknown_running', 'stopping'),
  ('worker', 'unknown_running', 'checking'),
  ('worker', 'unknown_running', 'failed_stopped'),
  ('worker', 'checking', 'ready_result'),
  ('worker', 'checking', 'failed_stopped'),
  ('worker', 'ready_result', 'finalized'),
  ('worker', 'ready_result', 'cleanup_pending'),
  ('worker', 'failed_stopped', 'finalized'),
  ('worker', 'failed_stopped', 'cleanup_pending'),
  ('worker', 'cleanup_pending', 'finalized'),
  ('session', 'queued', 'preparing'),
  ('session', 'queued', 'not_started'),
  ('session', 'preparing', 'running'),
  ('session', 'preparing', 'stopping'),
  ('session', 'preparing', 'unknown_running'),
  ('session', 'running', 'stopping'),
  ('session', 'running', 'unknown_running'),
  ('session', 'stopping', 'unknown_running'),
  ('session', 'stopping', 'finalized'),
  ('session', 'unknown_running', 'stopping'),
  ('session', 'unknown_running', 'finalized');

CREATE TRIGGER runs_transition_allowed BEFORE UPDATE OF state ON runs
WHEN NEW.state <> OLD.state
  AND NOT EXISTS (SELECT 1 FROM run_transitions WHERE kind = OLD.kind AND from_state = OLD.state AND to_state = NEW.state)
BEGIN
  SELECT RAISE(ABORT, 'run_transition_denied');
END;

-- 감독이 낸 지시. 실행 줄이 먼저 있어야 적힌다(외래 키). 접수 영수증은 여기 적힌 지시만 가리킬 수 있다.
CREATE TABLE instructions (
  request_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  action TEXT NOT NULL CHECK (action IN ('session_start', 'session_stop', 'task_start', 'task_cancel', 'run_renew', 'result_finalize')),
  stop_generation INTEGER NOT NULL CHECK (stop_generation BETWEEN 0 AND 9007199254740991),
  issued_at INTEGER NOT NULL CHECK (issued_at BETWEEN 1 AND 9007199254740991)
) STRICT, WITHOUT ROWID;
CREATE INDEX instructions_run ON instructions (run_id);

-- 영수증이 가리키는 지시는 적은 뒤 바뀌지 않는다. 영수증을 받을 때 대조한 실행과 동작이 나중에 달라지면 증거의 뜻이 바뀐다.
CREATE TRIGGER instructions_fixed BEFORE UPDATE ON instructions
BEGIN
  SELECT RAISE(ABORT, 'instruction_fixed');
END;

CREATE TRIGGER instructions_permanent BEFORE DELETE ON instructions
BEGIN
  SELECT RAISE(ABORT, 'instruction_fixed');
END;

CREATE TRIGGER instructions_no_replace BEFORE INSERT ON instructions
WHEN EXISTS (SELECT 1 FROM instructions WHERE request_id = NEW.request_id)
BEGIN
  SELECT RAISE(ABORT, 'instruction_fixed');
END;

-- 받은 영수증·보고. 같은 id는 한 번만 반영하고, 같은 id에 다른 본문 digest는 receipt_conflicts에 남긴다.
-- 실행에 속한 것은 그 실행을 가리키고(외래 키), 실행에 속하지 않는 규칙 확인 보고만 run_id가 NULL이다.
-- 결과 보고(report_result)는 감독이 결과를 먼저 저장한 자리(stored_ref)와 그 digest를 함께 적고, 결과 검사에 반영하면
-- applied_at을 채운다. 그래서 ack 뒤에 끊겨도 반영하지 않은 결과를 장부에서 다시 꺼낸다.
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN (
    'receipt_accepted', 'receipt_started', 'receipt_stopped', 'receipt_cleaned', 'receipt_session_takeover',
    'report_result', 'report_session_broken', 'report_hook_event', 'report_rule_check'
  )),
  run_id TEXT REFERENCES runs (run_id),
  instruction_request_id TEXT REFERENCES instructions (request_id),
  body_digest TEXT NOT NULL,
  stored_ref TEXT,
  result_digest TEXT,
  received_at INTEGER NOT NULL CHECK (received_at BETWEEN 1 AND 9007199254740991),
  applied_at INTEGER CHECK (applied_at IS NULL OR applied_at BETWEEN 1 AND 9007199254740991),
  CHECK ((action = 'report_rule_check') = (run_id IS NULL)),
  CHECK ((action IN ('receipt_accepted', 'receipt_started', 'receipt_cleaned')) = (instruction_request_id IS NOT NULL)),
  CHECK ((action = 'report_result') = (stored_ref IS NOT NULL) AND (action = 'report_result') = (result_digest IS NOT NULL)),
  CHECK (applied_at IS NULL OR action IN ('report_result', 'report_session_broken', 'report_hook_event'))
) STRICT, WITHOUT ROWID;

-- 접수·시작·정리 영수증이 가리키는 지시는 같은 실행의 것이고 종류가 맞아야 한다.
CREATE TRIGGER deliveries_instruction_same_run BEFORE INSERT ON deliveries
WHEN NEW.instruction_request_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM instructions i WHERE i.request_id = NEW.instruction_request_id AND i.run_id = NEW.run_id
    AND (NEW.action <> 'receipt_started' OR i.action IN ('task_start', 'session_start'))
    AND (NEW.action <> 'receipt_cleaned' OR i.action = 'result_finalize'))
BEGIN
  SELECT RAISE(ABORT, 'run_evidence_mismatch');
END;

-- 받은 기록은 바꾸거나 지우지 않는다(반영 표시 applied_at만 한 번 채운다).
CREATE TRIGGER deliveries_fixed BEFORE UPDATE ON deliveries
WHEN NEW.id IS NOT OLD.id OR NEW.action IS NOT OLD.action OR NEW.run_id IS NOT OLD.run_id
  OR NEW.instruction_request_id IS NOT OLD.instruction_request_id OR NEW.body_digest IS NOT OLD.body_digest
  OR NEW.stored_ref IS NOT OLD.stored_ref OR NEW.result_digest IS NOT OLD.result_digest OR NEW.received_at IS NOT OLD.received_at
  OR (OLD.applied_at IS NOT NULL AND NEW.applied_at IS NOT OLD.applied_at)
BEGIN
  SELECT RAISE(ABORT, 'delivery_fixed');
END;

CREATE TRIGGER deliveries_permanent BEFORE DELETE ON deliveries
BEGIN
  SELECT RAISE(ABORT, 'delivery_fixed');
END;

CREATE TRIGGER deliveries_no_replace BEFORE INSERT ON deliveries
WHEN EXISTS (SELECT 1 FROM deliveries WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'delivery_fixed');
END;

CREATE TABLE receipt_conflicts (
  seq INTEGER PRIMARY KEY CHECK (seq BETWEEN 1 AND 9007199254740991),
  id TEXT NOT NULL,
  first_digest TEXT NOT NULL,
  other_digest TEXT NOT NULL,
  received_at INTEGER NOT NULL CHECK (received_at BETWEEN 1 AND 9007199254740991)
) STRICT;

-- 훅 보고·세션 깨짐 보고를 ack한 뒤에도 어떤 사건이었는지 이어 가는 데 필요한 칸만 둔다(v1이 허용한 값만, 원문 없음).
-- turn_id는 v1 훅 보고의 prompt_id(턴을 잇는 UUID)다. 원문 칸을 이름으로 막는 정적 시험에 걸리지 않게 이름을 달리 둔다.
CREATE TABLE report_signals (
  report_id TEXT PRIMARY KEY REFERENCES deliveries (id),
  hook_event TEXT CHECK (hook_event IS NULL OR hook_event IN ('UserPromptSubmit', 'Stop', 'StopFailure')),
  session_id TEXT,
  turn_id TEXT,
  stop_failure TEXT CHECK (stop_failure IS NULL OR stop_failure IN (
    'rate_limit', 'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error', 'overloaded',
    'server_error', 'invalid_request', 'model_not_found', 'max_output_tokens', 'cloud_credential_error', 'unknown'
  )),
  broken_cause TEXT CHECK (broken_cause IS NULL OR broken_cause IN ('main_exited', 'main_restarted_alone', 'relay_lost')),
  marker_digest TEXT,
  observed_at INTEGER NOT NULL CHECK (observed_at BETWEEN 1 AND 9007199254740991),
  CHECK ((hook_event IS NOT NULL) = (session_id IS NOT NULL) AND (hook_event IS NOT NULL) = (turn_id IS NOT NULL)),
  CHECK (COALESCE(hook_event = 'StopFailure', 0) = (stop_failure IS NOT NULL)),
  CHECK ((broken_cause IS NOT NULL) = (marker_digest IS NOT NULL)),
  CHECK ((hook_event IS NOT NULL) <> (broken_cause IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE TRIGGER report_signals_fixed BEFORE UPDATE ON report_signals
BEGIN
  SELECT RAISE(ABORT, 'delivery_fixed');
END;

CREATE TRIGGER report_signals_permanent BEFORE DELETE ON report_signals
BEGIN
  SELECT RAISE(ABORT, 'delivery_fixed');
END;

CREATE TRIGGER report_signals_no_replace BEFORE INSERT ON report_signals
WHEN EXISTS (SELECT 1 FROM report_signals WHERE report_id = NEW.report_id)
BEGIN
  SELECT RAISE(ABORT, 'delivery_fixed');
END;

-- 세션·인계. sender는 검증된 봉투의 낸 쪽이다: 규칙 확인과 인수가 같은 교체 실행기의 것인지 여기서 가린다.
CREATE TABLE rule_checks (
  report_id TEXT PRIMARY KEY,
  sender TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('rule_present', 'rule_missing')),
  first_marker_digest TEXT NOT NULL,
  restarted_marker_digest TEXT,
  start_permit_id TEXT,
  checked_at INTEGER NOT NULL CHECK (checked_at BETWEEN 1 AND 9007199254740991)
) STRICT, WITHOUT ROWID;

-- 규칙 확인은 교체 기록이 기대는 증거다. 적은 뒤 바뀌지 않는다.
CREATE TRIGGER rule_checks_fixed BEFORE UPDATE ON rule_checks
BEGIN
  SELECT RAISE(ABORT, 'rule_check_fixed');
END;

CREATE TRIGGER rule_checks_permanent BEFORE DELETE ON rule_checks
BEGIN
  SELECT RAISE(ABORT, 'rule_check_fixed');
END;

CREATE TRIGGER rule_checks_no_replace BEFORE INSERT ON rule_checks
WHEN EXISTS (SELECT 1 FROM rule_checks WHERE report_id = NEW.report_id)
BEGIN
  SELECT RAISE(ABORT, 'rule_check_fixed');
END;

-- 교체 기록 하나: 앞 실행, 인수를 낸 교체 실행기(sender), 새 세대 표식, 시작 허가, 확정한 규칙 확인, 그 인수로 시작한 다음 실행.
-- confirmed_at이 NULL이면 아직 대조하지 못해 앞 세션을 끝내지 않은 인수 대기다(그 규칙 확인이 늦게 올 수 있다).
CREATE TABLE session_takeovers (
  receipt_id TEXT PRIMARY KEY REFERENCES deliveries (id),
  previous_run_id TEXT NOT NULL REFERENCES runs (run_id),
  sender TEXT NOT NULL,
  new_generation_marker_digest TEXT NOT NULL,
  start_permit_id TEXT NOT NULL UNIQUE,
  taken_over_at INTEGER NOT NULL CHECK (taken_over_at BETWEEN 1 AND 9007199254740991),
  confirmed_at INTEGER CHECK (confirmed_at IS NULL OR confirmed_at BETWEEN 1 AND 9007199254740991),
  rule_check_id TEXT REFERENCES rule_checks (report_id),
  next_run_id TEXT UNIQUE REFERENCES runs (run_id),
  CHECK ((confirmed_at IS NULL) = (rule_check_id IS NULL)),
  CHECK (next_run_id IS NULL OR confirmed_at IS NOT NULL)
) STRICT, WITHOUT ROWID;

-- 앞 세션 하나를 끝내는 인수는 하나다. 같은 앞 세션에 인수가 둘 와도 먼저 확정한 쪽만 교체가 된다.
CREATE UNIQUE INDEX session_takeovers_one_confirmed ON session_takeovers (previous_run_id) WHERE confirmed_at IS NOT NULL;

-- 교체 기록의 관계는 적은 뒤 바뀌지 않는다. 확정과 다음 실행은 비어 있을 때 한 번만 채운다.
CREATE TRIGGER session_takeovers_fixed BEFORE UPDATE ON session_takeovers
WHEN NEW.receipt_id IS NOT OLD.receipt_id OR NEW.previous_run_id IS NOT OLD.previous_run_id OR NEW.sender IS NOT OLD.sender
  OR NEW.new_generation_marker_digest IS NOT OLD.new_generation_marker_digest OR NEW.start_permit_id IS NOT OLD.start_permit_id
  OR NEW.taken_over_at IS NOT OLD.taken_over_at
  OR (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NOT OLD.confirmed_at)
  OR (OLD.rule_check_id IS NOT NULL AND NEW.rule_check_id IS NOT OLD.rule_check_id)
  OR (OLD.next_run_id IS NOT NULL AND NEW.next_run_id IS NOT OLD.next_run_id)
BEGIN
  SELECT RAISE(ABORT, 'takeover_fixed');
END;

CREATE TRIGGER session_takeovers_permanent BEFORE DELETE ON session_takeovers
BEGIN
  SELECT RAISE(ABORT, 'takeover_fixed');
END;

CREATE TRIGGER session_takeovers_no_replace BEFORE INSERT ON session_takeovers
WHEN EXISTS (SELECT 1 FROM session_takeovers WHERE receipt_id = NEW.receipt_id OR start_permit_id = NEW.start_permit_id)
BEGIN
  SELECT RAISE(ABORT, 'takeover_fixed');
END;

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs (run_id),
  -- 시작 커밋의 순번. 직전 세션은 접수 순번이 아니라 이 값으로 찾는다(접수한 순서대로 시작한다는 제약이 없다).
  start_seq INTEGER NOT NULL UNIQUE CHECK (start_seq BETWEEN 1 AND 9007199254740991),
  generation_marker_digest TEXT NOT NULL,
  -- 인수 하나로 세션 하나만 연다.
  takeover_receipt_id TEXT UNIQUE REFERENCES session_takeovers (receipt_id),
  rule_check_id TEXT NOT NULL REFERENCES rule_checks (report_id),
  handoff_ref TEXT,
  handoff_digest TEXT,
  processed_seq INTEGER NOT NULL DEFAULT 0 CHECK (processed_seq BETWEEN 0 AND 9007199254740991),
  rotation_planned_at INTEGER CHECK (rotation_planned_at IS NULL OR rotation_planned_at BETWEEN 1 AND 9007199254740991),
  rotated_at INTEGER CHECK (rotated_at IS NULL OR rotated_at BETWEEN 1 AND 9007199254740991),
  CHECK ((handoff_ref IS NULL) = (handoff_digest IS NULL))
) STRICT, WITHOUT ROWID;

-- 시작 허가는 한 번만 쓴다. 쓰인 줄은 지우거나 바꾸지 않는다(그러면 같은 허가를 다시 쓸 수 있다).
CREATE TABLE start_permit_uses (
  start_permit_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs (run_id),
  used_at INTEGER NOT NULL CHECK (used_at BETWEEN 1 AND 9007199254740991)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER start_permit_uses_fixed BEFORE UPDATE ON start_permit_uses
BEGIN
  SELECT RAISE(ABORT, 'permit_used');
END;

CREATE TRIGGER start_permit_uses_permanent BEFORE DELETE ON start_permit_uses
BEGIN
  SELECT RAISE(ABORT, 'permit_used');
END;

CREATE TRIGGER start_permit_uses_no_replace BEFORE INSERT ON start_permit_uses
WHEN EXISTS (SELECT 1 FROM start_permit_uses WHERE start_permit_id = NEW.start_permit_id OR run_id = NEW.run_id)
BEGIN
  SELECT RAISE(ABORT, 'permit_used');
END;

-- 게시 연결. 승인과 게시의 최종 상태는 현관이 가진다. 여기는 무엇을 물어야 하는지다.
CREATE TABLE publications (
  front_job_id TEXT PRIMARY KEY,
  candidate_digest TEXT NOT NULL,
  run_id TEXT REFERENCES runs (run_id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'unknown')),
  outcome TEXT CHECK ((state = 'confirmed') = (outcome IS NOT NULL) AND (outcome IS NULL OR outcome IN ('posted', 'not_posted'))),
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 1 AND 9007199254740991)
) STRICT, WITHOUT ROWID;

-- 확정된 게시는 키·후보·실행·상태·결과가 그대로다(갱신 시각만 바뀐다). UPDATE, INSERT OR REPLACE, DELETE 뒤 INSERT,
-- 다른 줄의 키를 확정된 키로 바꾸는 UPDATE OR REPLACE 모두 막는다.
CREATE TRIGGER publications_confirmed_final BEFORE UPDATE ON publications
WHEN OLD.state = 'confirmed' AND (NEW.front_job_id IS NOT OLD.front_job_id OR NEW.candidate_digest IS NOT OLD.candidate_digest
  OR NEW.run_id IS NOT OLD.run_id OR NEW.state IS NOT OLD.state OR NEW.outcome IS NOT OLD.outcome)
BEGIN
  SELECT RAISE(ABORT, 'publication_confirmed');
END;

CREATE TRIGGER publications_confirmed_key BEFORE UPDATE OF front_job_id ON publications
WHEN NEW.front_job_id IS NOT OLD.front_job_id AND EXISTS (SELECT 1 FROM publications WHERE front_job_id = NEW.front_job_id AND state = 'confirmed')
BEGIN
  SELECT RAISE(ABORT, 'publication_confirmed');
END;

CREATE TRIGGER publications_confirmed_final_insert BEFORE INSERT ON publications
WHEN EXISTS (SELECT 1 FROM publications WHERE front_job_id = NEW.front_job_id AND state = 'confirmed')
BEGIN
  SELECT RAISE(ABORT, 'publication_confirmed');
END;

CREATE TRIGGER publications_confirmed_permanent BEFORE DELETE ON publications
WHEN OLD.state = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'publication_confirmed');
END;

-- 감독이 받는 봉투의 nonce(계약의 NonceStore). 같은 (낸 쪽, nonce)는 한 번만 들어간다.
CREATE TABLE nonces (
  sender TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (sender, nonce)
) STRICT, WITHOUT ROWID;
CREATE INDEX nonces_expiry ON nonces (expires_at);
