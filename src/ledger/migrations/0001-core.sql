-- O09가 쓰는 묶음(supervisor.md §8 표). 원문과 자격 값은 칸이 없다: 원문은 참조와 만료, 자격은 계정·방식·revision·digest만.
-- 시각은 모두 Unix epoch 밀리초 정수다. 표는 모두 STRICT라 칸의 타입이 어긋나면 쓰기가 실패한다.

-- 정지·일시 중지. 줄이 없으면 "모름"이다(0과 다르다). 0도 줄로 적는다.
CREATE TABLE stop_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  stopped INTEGER NOT NULL CHECK (stopped IN (0, 1)),
  -- 확인 단계: supervisor.md §7.3 8(접수, 차단)과 §7.4의 결과 이름. 누가 언제 올리는지는 CLI 작업이 정한다.
  phase TEXT NOT NULL CHECK (phase IN ('none', 'accepted', 'blocked', 'node_unverified', 'node_verified', 'runtime_verified')),
  updated_at INTEGER NOT NULL
) STRICT;

-- 단조 증가를 저장하는 자리에서 다시 확인한다. 코드의 확인을 지나친 쓰기도 여기서 멈춘다.
CREATE TRIGGER stop_generation_monotonic BEFORE UPDATE OF generation ON stop_state
WHEN NEW.generation < OLD.generation
BEGIN
  SELECT RAISE(ABORT, 'stop_generation_lower');
END;

CREATE TABLE diagnosis_pause (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  until_at INTEGER CHECK (until_at IS NULL OR until_at > 0)
) STRICT;

-- 실행 세대의 지금 값. 새 실행은 이 값을 받는다. 올리는 일(§7.6 풀기)은 뒤 작업이다.
CREATE TABLE run_epoch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL CHECK (generation >= 1)
) STRICT;
INSERT INTO run_epoch (id, generation) VALUES (1, 1);

CREATE TRIGGER run_epoch_monotonic BEFORE UPDATE OF generation ON run_epoch
WHEN NEW.generation < OLD.generation
BEGIN
  SELECT RAISE(ABORT, 'run_epoch_lower');
END;

-- 입력·대기열. source_ref는 원문이 있는 곳의 참조이고 원문이 아니다.
CREATE TABLE inputs (
  request_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE CHECK (seq >= 1),
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_expires_at INTEGER NOT NULL CHECK (source_expires_at > 0),
  received_at INTEGER NOT NULL,
  cancelled_at INTEGER
) STRICT;

-- 실행·슬롯·예산. 상태 이름은 supervisor.md §3의 것뿐이다.
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  run_generation INTEGER NOT NULL CHECK (run_generation >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('worker', 'session')),
  role TEXT CHECK ((kind = 'worker') = (role IS NOT NULL)),
  queue_seq INTEGER NOT NULL UNIQUE CHECK (queue_seq >= 1),
  dedupe_key TEXT UNIQUE,
  input_request_id TEXT REFERENCES inputs (request_id),
  profile_revision TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  snapshot_digest TEXT CHECK ((kind = 'worker') = (snapshot_digest IS NOT NULL)),
  input_digest TEXT,
  executor_id TEXT NOT NULL,
  account TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  credential_revision TEXT NOT NULL,
  credential_digest TEXT NOT NULL,
  deadline_at INTEGER NOT NULL CHECK (deadline_at > 0),
  -- 남은 예산(토큰 수). 아래 trigger가 늘리지 못하게 한다(재시도·계정 전환이 예산을 새로 주지 않는다).
  budget_left INTEGER NOT NULL CHECK (budget_left >= 0),
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'preparing', 'running', 'stopping', 'checking', 'ready_result', 'finalized',
    'not_started', 'failed_stopped', 'unknown_running', 'cleanup_pending'
  )),
  accepted_receipt_id TEXT,
  started_receipt_id TEXT,
  -- 종료 확인: 작업자는 receipt_stopped, 세션은 receipt_session_takeover(D-50).
  stop_receipt_id TEXT,
  cleaned_receipt_id TEXT,
  result_digest TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- 종료 확인 영수증 없이 결과 쪽 상태가 되지 않는다.
  CHECK (state NOT IN ('checking', 'ready_result', 'failed_stopped', 'cleanup_pending') OR stop_receipt_id IS NOT NULL),
  CHECK (state <> 'ready_result' OR result_digest IS NOT NULL),
  CHECK (state <> 'finalized' OR (kind = 'worker' AND cleaned_receipt_id IS NOT NULL) OR (kind = 'session' AND stop_receipt_id IS NOT NULL)),
  CHECK (kind = 'worker' OR state NOT IN ('checking', 'ready_result', 'failed_stopped', 'cleanup_pending'))
) STRICT;

-- 슬롯은 작업자 하나, 오케스트레이터(세션) 하나. 대기와 끝난 실행 밖은 모두 자리를 쥔다(unknown_running·cleanup_pending 포함).
CREATE UNIQUE INDEX runs_one_per_slot ON runs (kind) WHERE state NOT IN ('queued', 'finalized', 'not_started');

CREATE TRIGGER runs_budget_never_grows BEFORE UPDATE OF budget_left ON runs
WHEN NEW.budget_left > OLD.budget_left
BEGIN
  SELECT RAISE(ABORT, 'budget_grows');
END;

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
  ('worker', 'checking', 'unknown_running'),
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
  action TEXT NOT NULL CHECK (action IN ('session_start', 'session_stop', 'task_start', 'task_cancel', 'result_finalize')),
  stop_generation INTEGER NOT NULL CHECK (stop_generation >= 0),
  issued_at INTEGER NOT NULL
) STRICT;
CREATE INDEX instructions_run ON instructions (run_id);

-- 받은 영수증·보고. 같은 id는 한 번만 반영하고, 같은 id에 다른 본문 digest는 receipt_conflicts에 남긴다.
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  run_id TEXT,
  body_digest TEXT NOT NULL,
  received_at INTEGER NOT NULL
) STRICT;

CREATE TABLE receipt_conflicts (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL,
  first_digest TEXT NOT NULL,
  other_digest TEXT NOT NULL,
  received_at INTEGER NOT NULL
) STRICT;

-- 세션·인계.
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs (run_id),
  generation_marker_digest TEXT NOT NULL,
  takeover_receipt_id TEXT,
  rule_check_id TEXT NOT NULL,
  handoff_ref TEXT,
  handoff_digest TEXT,
  processed_seq INTEGER NOT NULL DEFAULT 0 CHECK (processed_seq >= 0),
  rotation_planned_at INTEGER,
  rotated_at INTEGER
) STRICT;

CREATE TABLE rule_checks (
  report_id TEXT PRIMARY KEY,
  outcome TEXT NOT NULL CHECK (outcome IN ('rule_present', 'rule_missing')),
  first_marker_digest TEXT NOT NULL,
  restarted_marker_digest TEXT,
  start_permit_id TEXT,
  checked_at INTEGER NOT NULL
) STRICT;

CREATE TABLE session_takeovers (
  receipt_id TEXT PRIMARY KEY,
  previous_run_id TEXT NOT NULL REFERENCES runs (run_id),
  new_generation_marker_digest TEXT NOT NULL,
  start_permit_id TEXT NOT NULL,
  taken_over_at INTEGER NOT NULL
) STRICT;

-- 시작 허가는 한 번만 쓴다. 쓰인 줄은 지우지 않는다(지우면 같은 허가를 다시 쓸 수 있다).
CREATE TABLE start_permit_uses (
  start_permit_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs (run_id),
  used_at INTEGER NOT NULL
) STRICT;

-- 게시 연결. 승인과 게시의 최종 상태는 현관이 가진다. 여기는 무엇을 물어야 하는지다.
CREATE TABLE publications (
  front_job_id TEXT PRIMARY KEY,
  candidate_digest TEXT NOT NULL,
  run_id TEXT REFERENCES runs (run_id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'unknown')),
  outcome TEXT CHECK ((state = 'confirmed') = (outcome IS NOT NULL) AND (outcome IS NULL OR outcome IN ('posted', 'not_posted'))),
  updated_at INTEGER NOT NULL
) STRICT;

-- 확정된 게시는 다시 대기·모름으로 돌아가지 않는다.
CREATE TRIGGER publications_confirmed_final BEFORE UPDATE ON publications
WHEN OLD.state = 'confirmed' AND (NEW.state <> 'confirmed' OR NEW.outcome IS NOT OLD.outcome)
BEGIN
  SELECT RAISE(ABORT, 'publication_confirmed');
END;

-- 감독이 받는 봉투의 nonce(계약의 NonceStore). 같은 (낸 쪽, nonce)는 한 번만 들어간다.
CREATE TABLE nonces (
  sender TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (sender, nonce)
) STRICT, WITHOUT ROWID;
CREATE INDEX nonces_expiry ON nonces (expires_at);
