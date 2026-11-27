-- 관리자가 자리를 푸는 근거 셋(D-148·D-157·D-158·D-161). 더하기만 한다: runs 표와 이름 없는 CHECK는 다시 만들지 않는다(다시 만들면
-- 표 재작성이고 이름 없는 CHECK는 빼거나 넓히지 못한다, 이관 0006 머리의 주석). 늘어날 수 있는 집합(사유·확인 방법·앞 상태)은
-- 트리거에 둔다. 올라간 장부의 새 표는 비어 있고 기존 줄은 바뀌지 않는다.
-- (가) result_abandons: 종료는 확인됐는데 결과가 끝내 오지 않는 작업자 실행(checking)의 결과를 관리자가 버린다. 근거 줄을 넣는 문장이
--     실행 줄을 failed_stopped로 옮긴다. 확정은 수명 박자가 D-114 그대로 낸다(이 판은 확정을 적지 않는다). 감독이 이미 받아 둔 결과
--     보고가 있거나(D-168) 확정 outcome을 정할 수 없는 실행(D-148)은 버리지 않는다.
--     abandoned_result_reports: 결과를 버린 실행에 뒤늦게 온 결과 보고를 본문 보관 없이 받은 기록(D-169). 감독은 이 줄을 커밋한
--     뒤에 ack한다.
-- (나) operator_closures의 트리거를 넓힌다: 실행기가 영영 돌아오지 않을 때 종료가 확인된 실행(checking·ready_result·
--     failed_stopped)을 저장소 비움(store_reset) 근거로 not_started로 닫는다. 표와 칸은 판 7 그대로다.
-- (다) slot_hold_releases: 점유 관측(slot_holds)을 파드 교체 근거로 푼다(holds_slot = 0). 줄은 남아 그 실행 ID는 계속 시작하지 않는다.
-- 네 표 모두 줄은 고치거나 지울 수 없다. 장부는 사람이 넘긴 사실(결과를 버릴 까닭, 저장소를 비웠는지, 파드를 바꿨는지와 그
-- 시각)을 확인하지 못한다: 근거 줄은 사람이 했다는 기록이다(D-93과 같다).
-- 값의 검사는 판 7과 같은 꼴이다: 정수 칸은 ANY로 받아 트리거가 typeof를 먼저 보고, 값의 검사는 "(조건) IS NOT 1"·"IS NOT 0", 다른
-- 표와의 대조는 "=로 맞는 줄의 NOT EXISTS"로 써서 NULL이 섞이면 막는 쪽으로 간다(까닭은 이관 0007 머리의 "NULL을 막는 것"·"정수
-- 칸의 형"). 칸의 CHECK와 NOT NULL은 BEFORE 트리거 뒤에 돌고 INSERT OR IGNORE에서는 예외 없이 0줄로 끝나므로, 트리거가 스스로 막는다.

-- ---- (가) 결과 포기 ----

-- 실행마다 한 줄(D-157). 자유 메모 칸과 "누가" 칸은 없다(판 7과 같은 까닭).
-- - reason: 관리자가 결과를 버린 까닭. no_answer(실행기가 답하지 않거나 늘 늦음), not_known(실행기가 그 실행을 모른다고 답함),
--   unstorable(실행기는 결과가 있다는데 감독이 보관하지 못함). 목록은 트리거에 있어 뒤의 판이 더할 수 있다.
-- - stop_receipt_id: 버린 것이 "그 종료"의 결과임을 대조하는 값. 실행 줄의 stop_receipt_id와 같아야 들어간다.
-- - stop_generation: 버린 때의 정지 세대(stop_state.generation).
-- - abandoned_at: 버린 시각(감독의 시계). 실행 줄의 updated_at·failed_stopped_at과 마친 결과 보고의 applied_at에도 이 값이 들어가고,
--   그래서 확정의 stored_at이 이 값이다(ledger.ts의 failedStop).
CREATE TABLE result_abandons (
  run_id TEXT NOT NULL PRIMARY KEY REFERENCES runs (run_id),
  reason TEXT NOT NULL,
  stop_receipt_id TEXT NOT NULL,
  stop_generation ANY NOT NULL CHECK (typeof(stop_generation) = 'integer' AND stop_generation BETWEEN 0 AND 9007199254740991),
  abandoned_at ANY NOT NULL CHECK (typeof(abandoned_at) = 'integer' AND abandoned_at BETWEEN 1 AND 9007199254740991)
) STRICT, WITHOUT ROWID;

-- 행으로 다시 보는 확인. 하나라도 맞으면 근거 줄은 들어가지 않는다: 정수 칸 둘 가운데 정수가 아닌 것(NULL 포함), 이미 근거가 있음
-- (INSERT OR REPLACE 포함), 사유가 목록 밖, 실행 줄이 작업자의 checking이 아니거나 종료 영수증이 넘긴 값과 다르거나 결과 digest가
-- 있음, 정지 기록이 없거나 정지 세대가 그 기록과 다름.
-- 앞 상태는 checking 하나다. 판 8 전에 failed_stopped가 되어 확정을 못 내는 줄은 다루지 않는다(D-162, 장부 초기화로 넘긴다).
-- 이 트리거가 보지 않는 것: 장부가 건강한지, 접수 닫힘·사본 보류·정지 중인지(ledger.ts의 abandonResult가 쓰기 모드로 장부 실패만
-- 거절한다). 받아 둔 결과 보고와 확정 outcome은 아래 두 트리거가 따로 본다(직접 SQL에도 까닭이 다른 문구로 보인다).
CREATE TRIGGER result_abandons_proven BEFORE INSERT ON result_abandons
WHEN (typeof(NEW.stop_generation) = 'integer' AND typeof(NEW.abandoned_at) = 'integer') IS NOT 1
  OR EXISTS (SELECT 1 FROM result_abandons a WHERE a.run_id = NEW.run_id)
  OR (NEW.reason IN ('no_answer', 'not_known', 'unstorable')) IS NOT 1
  OR NOT EXISTS (SELECT 1 FROM runs r WHERE r.run_id = NEW.run_id AND r.kind = 'worker' AND r.state = 'checking'
    AND r.stop_receipt_id = NEW.stop_receipt_id AND r.result_digest IS NULL)
  OR NOT EXISTS (SELECT 1 FROM stop_state s WHERE s.id = 1 AND s.generation = NEW.stop_generation)
BEGIN
  SELECT RAISE(ABORT, 'result_abandon_unproven');
END;

-- 그 실행에 받아 두고 판정에 아직 반영하지 않은 결과 보고(applied_at이 빈 report_result 줄)가 있으면 버리지 않는다(D-168). 그 보고의
-- 본문은 감독 보관소에 있고 실행기는 ack를 받았다: 결과가 끝내 오지 않는 실행이 아니라 결과 검사 박자가 ready_result로 판정할 실행이다.
-- 근거·실행 줄·보고는 그대로 남는다.
CREATE TRIGGER result_abandons_report_pending BEFORE INSERT ON result_abandons
WHEN EXISTS (SELECT 1 FROM deliveries d WHERE d.run_id = NEW.run_id AND d.action = 'report_result' AND d.applied_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'result_abandon_report_pending');
END;

-- 버린 뒤 수명 박자가 D-114 확정 본문을 만들 수 없는 실행은 버리지 않는다(D-148). 버린 실행의 exit는 늘 completed다(checking의
-- stop_exit는 completed이거나 판 8 전의 줄이라 비었고, 비면 failed_stopped_at이 있어 completed로 읽는다: ledger.ts의 stopFacts). 그래서
-- outcome을 못 정하는 것은 사유 requested의 취소 지시는 없고 사유 없이 적힌 취소 지시(task_cancel)가 있을 때뿐이다(requested였을 수 있다:
-- life-loop.ts의 failedOutcome). 버리면 그 실행은 확정도 정리도 없이 자리를 쥔 채 남는다.
CREATE TRIGGER result_abandons_outcome_known BEFORE INSERT ON result_abandons
WHEN EXISTS (SELECT 1 FROM instructions i WHERE i.run_id = NEW.run_id AND i.action = 'task_cancel' AND i.reason IS NULL)
  AND NOT EXISTS (SELECT 1 FROM instructions i WHERE i.run_id = NEW.run_id AND i.action = 'task_cancel' AND i.reason = 'requested')
BEGIN
  SELECT RAISE(ABORT, 'result_abandon_outcome_unknown');
END;

-- 근거 줄을 넣는 문장 안에서 실행 줄을 checking → failed_stopped로 옮기고 failed_stopped_at에 버린 시각을 적는다. 이 쓰기는 판 8의
-- runs_failed_stopped_at_fixed가 허락하는 꼴(checking에서 옮기며 updated_at과 같은 값)이고 전이는 판 1의 줄이다. 그래서 failedStop이
-- stoppedAt = abandoned_at, exit = completed(판 8 뒤의 종료 확인이면 칸의 값, 판 8 전이면 칸이 비어 completed로 읽는다)를 내고,
-- 수명 박자가 D-114대로 확정한다(사유 requested의 취소 지시가 있으면 cancelled, 아니면 failed).
-- 보고 줄은 건드리지 않는다: 미반영 결과 보고가 있는 실행은 위 트리거가 이미 막았다.
-- 옮기는 전이가 거절되거나 옮긴 뒤 상태가 다르면 문장 전체가 되돌아가 근거 줄도 남지 않는다.
CREATE TRIGGER result_abandons_fail_run AFTER INSERT ON result_abandons
BEGIN
  UPDATE runs SET state = 'failed_stopped', updated_at = NEW.abandoned_at, failed_stopped_at = NEW.abandoned_at WHERE run_id = NEW.run_id;
  SELECT RAISE(ABORT, 'result_abandon_unproven')
  WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.run_id = NEW.run_id AND r.state = 'failed_stopped' AND r.failed_stopped_at = NEW.abandoned_at);
END;

CREATE TRIGGER result_abandons_fixed BEFORE UPDATE ON result_abandons
BEGIN
  SELECT RAISE(ABORT, 'result_abandon_unproven');
END;

CREATE TRIGGER result_abandons_permanent BEFORE DELETE ON result_abandons
BEGIN
  SELECT RAISE(ABORT, 'result_abandon_unproven');
END;

-- 버린 뒤의 취소 지시(D-148). 버린 실행의 확정 outcome은 취소 지시의 사유로만 갈리므로, 사유 requested의 취소 지시가 없는 실행에
-- 사유 없는 취소 지시를 더하면 outcome이 failed에서 "모름"이 되어(failedStop의 requestedCancel이 null) 수명 박자가 이미 낼 수 있던
-- 확정을 보류하고 자리를 쥔다. 버린 뒤의 상태(failed_stopped·cleanup_pending·finalized·not_started)와 무관하게 막는다. 사유가 있는 취소와
-- requested가 이미 있는 실행은 outcome이 정해진 채라 받는다. 같은 요청 ID로 requested 줄을 갈아 끼우는 INSERT OR REPLACE는 판 1의
-- instructions_no_replace가 먼저 막는다.
CREATE TRIGGER instructions_abandoned_outcome_known BEFORE INSERT ON instructions
WHEN NEW.action = 'task_cancel' AND NEW.reason IS NULL
  AND EXISTS (SELECT 1 FROM result_abandons a WHERE a.run_id = NEW.run_id)
  AND NOT EXISTS (SELECT 1 FROM instructions i WHERE i.run_id = NEW.run_id AND i.action = 'task_cancel' AND i.reason = 'requested')
BEGIN
  SELECT RAISE(ABORT, 'result_abandon_outcome_unknown');
END;

-- 결과를 버린 실행에 온 결과 보고의 받은 기록(D-169). 보고마다 한 줄이고 본문과 저장 자리는 없다: 버린 결과라 보관하지 않고, 보관소에
-- 장애가 이어져도(사유 unstorable) 실행기가 ack를 받아 다시 보내기를 멈춘다. 결과 보고의 deliveries 줄은 저장 자리와 결과 digest를
-- 요구해(이관 0001) 거기 적지 못한다.
-- - report_id: 보고 ID. deliveries의 ID와 겹치지 않는다(아래 트리거). 같은 ID의 재전송은 body_digest로 같은 보고인지 가른다(ledger.ts의
--   #redelivery가 두 표를 함께 본다): 같으면 duplicate ack, 다르면 충돌(receipt_conflicts)이고 ack가 없다.
-- - sender·run_generation: 검증된 봉투의 낸 쪽과 실행 세대. 그 실행의 지정 실행기·세대와 같아야 들어간다.
-- - body_digest: 봉투 본문의 digest(소문자 16진 64자).
-- - received_at: 받은 시각(감독의 시계).
CREATE TABLE abandoned_result_reports (
  report_id TEXT NOT NULL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  sender TEXT NOT NULL,
  run_generation ANY NOT NULL CHECK (typeof(run_generation) = 'integer' AND run_generation BETWEEN 0 AND 9007199254740991),
  body_digest TEXT NOT NULL,
  received_at ANY NOT NULL CHECK (typeof(received_at) = 'integer' AND received_at BETWEEN 1 AND 9007199254740991)
) STRICT, WITHOUT ROWID;

-- 행으로 다시 보는 확인. 하나라도 맞으면 들어가지 않는다: 정수 칸 둘 가운데 정수가 아닌 것(NULL 포함), 같은 보고 ID가 이 표나
-- deliveries에 이미 있음(INSERT OR REPLACE 포함), digest가 꼴 밖, 그 실행에 결과 포기 근거가 없거나 낸 쪽·세대가 실행 줄과 다름.
CREATE TRIGGER abandoned_result_reports_proven BEFORE INSERT ON abandoned_result_reports
WHEN (typeof(NEW.run_generation) = 'integer' AND typeof(NEW.received_at) = 'integer') IS NOT 1
  OR EXISTS (SELECT 1 FROM abandoned_result_reports x WHERE x.report_id = NEW.report_id)
  OR EXISTS (SELECT 1 FROM deliveries d WHERE d.id = NEW.report_id)
  OR (length(NEW.body_digest) = 64 AND NEW.body_digest NOT GLOB '*[^0-9a-f]*') IS NOT 1
  OR NOT EXISTS (SELECT 1 FROM result_abandons a JOIN runs r ON r.run_id = a.run_id WHERE a.run_id = NEW.run_id
    AND r.executor_id = NEW.sender AND r.run_generation = NEW.run_generation)
BEGIN
  SELECT RAISE(ABORT, 'abandoned_report_unproven');
END;

CREATE TRIGGER abandoned_result_reports_fixed BEFORE UPDATE ON abandoned_result_reports
BEGIN
  SELECT RAISE(ABORT, 'abandoned_report_unproven');
END;

CREATE TRIGGER abandoned_result_reports_permanent BEFORE DELETE ON abandoned_result_reports
BEGIN
  SELECT RAISE(ABORT, 'abandoned_report_unproven');
END;

-- 반대쪽 순서: 이 표에 이미 있는 보고 ID는 deliveries에 들어가지 않는다(세 INSERT 방식 모두, 문구는 판 1의 deliveries_no_replace와 같다).
-- 이 트리거가 없으면 원 SQL이 같은 ID를 deliveries에 넣을 수 있고, #redelivery가 deliveries를 먼저 읽어 처음 받은 digest를 충돌로,
-- 뒤에 넣은 digest를 duplicate로 가른다. 공개 연산은 #redelivery가 두 표를 먼저 보아 이 트리거에 닿지 않는다.
CREATE TRIGGER deliveries_not_abandoned_report BEFORE INSERT ON deliveries
WHEN EXISTS (SELECT 1 FROM abandoned_result_reports x WHERE x.report_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'delivery_fixed');
END;

-- ---- (나) 저장소 비움 근거의 관리자 닫기 ----

-- 종료가 확인된 작업자 실행을 not_started로 닫는 전이 셋. runs_not_started_needs_closure(판 7)가 같은 앞 상태의 근거 줄을 요구하므로
-- 근거 없이 이 길로 가는 쓰기는 그대로 막힌다.
INSERT INTO run_transitions (kind, from_state, to_state) VALUES
  ('worker', 'checking', 'not_started'),
  ('worker', 'ready_result', 'not_started'),
  ('worker', 'failed_stopped', 'not_started');

-- 확인 방법과 앞 상태의 짝:
-- - pod_replaced(판 7, D-96): unknown_running·stopping, 종료 확인(stop_receipt_id) 없음.
-- - store_reset(D-158): 관리자가 그 실행기 저장소를 비우고 작업자 파드를 새로 띄웠다. checking·ready_result·failed_stopped, 종료
--   확인 있음. 종료가 확인돼 프로세스는 0개이고, 저장소를 비웠으니 실행기가 그 실행의 정리 영수증을 낼 기록도 없다. 정리 영수증을
--   기다리면 자리가 영영 묶이는 실행을 닫는 길이다. 종료가 확인되지 않은 실행에는 받지 않는다(그런 실행은 pod_replaced로 닫는다).
--   failed_stopped는 실패 시각(runs.failed_stopped_at)이 있는 줄만 받는다. 그 칸이 빈 줄은 판 8 전에 실패 상태가 된 줄(원 SQL로 칸 없이
--   옮긴 줄 포함)이고 D-162가 이 판에서 다루지 않기로 한 줄이다(장부 초기화로 넘긴다). 판 8 전에 checking이었다가 판 8 뒤에 결과 없음·
--   결과 포기로 실패 상태가 된 줄은 그 쓰기가 칸을 채워 받는다.
-- 파드 이름·뜬 시각 칸은 새로 띄운 작업자 파드의 값이다. 닫을 수 있게 되는 시각(발행 최댓값 + 31000)과 두 시각의 순서는 두 방법에
-- 같게 본다: 종료가 확인된 실행에는 띄울 시작이 남지 않지만, 같은 식은 닫는 쪽으로만 틀린다.
-- 그 밖의 조건은 판 7의 트리거와 같다(이관 0007의 주석). 판 7의 근거 줄은 그대로 읽힌다.
DROP TRIGGER operator_closures_proven;

CREATE TRIGGER operator_closures_proven BEFORE INSERT ON operator_closures
WHEN (typeof(NEW.pod_started_at) = 'integer' AND typeof(NEW.stop_generation) = 'integer' AND typeof(NEW.closed_at) = 'integer') IS NOT 1
  OR EXISTS (SELECT 1 FROM operator_closures o WHERE o.run_id = NEW.run_id)
  OR EXISTS (SELECT 1 FROM unreceived_closures c WHERE c.run_id = NEW.run_id)
  OR ((NEW.checked_by = 'pod_replaced' AND NEW.from_state IN ('unknown_running', 'stopping'))
    OR (NEW.checked_by = 'store_reset' AND NEW.from_state IN ('checking', 'ready_result', 'failed_stopped'))) IS NOT 1
  OR (length(NEW.pod_name) BETWEEN 1 AND 253) IS NOT 1
  OR (NEW.pod_name GLOB '[a-z0-9]' OR NEW.pod_name GLOB '[a-z0-9]*[a-z0-9]') IS NOT 1
  OR (NEW.pod_name GLOB '*[^a-z0-9.-]*') IS NOT 0
  OR (instr(NEW.pod_name, '..') + instr(NEW.pod_name, '.-') + instr(NEW.pod_name, '-.') + instr(NEW.pod_name, char(0))) IS NOT 0
  OR NOT EXISTS (SELECT 1 FROM runs r WHERE r.run_id = NEW.run_id AND r.kind = 'worker' AND r.state = NEW.from_state
    AND ((NEW.checked_by = 'pod_replaced' AND r.stop_receipt_id IS NULL) OR (NEW.checked_by = 'store_reset' AND r.stop_receipt_id IS NOT NULL)))
  OR (NEW.from_state = 'failed_stopped' AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.run_id = NEW.run_id AND r.failed_stopped_at IS NOT NULL))
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

-- ---- (다) 점유 관측 풀기 ----

-- 관측(slot_holds의 관측 번호)마다 한 줄. 관측 번호는 AUTOINCREMENT라 다시 쓰이지 않고, 같은 (실행기, 실행, 세대)를 다시 관측하면
-- 새 번호를 받으므로 앞 번호의 풀기는 새 관측을 풀지 못한다. slot_holds는 다시 관측할 때 옛 줄을 지우고 새로 적어(ledger.ts의
-- #hold) 외래 키로 묶지 않는다.
-- - checked_by: 관리자가 확인한 방법. pod_replaced(그 실행기의 파드를 지워 새로 띄웠다) 하나다. 목록은 트리거에 있다.
-- - pod_name·pod_started_at: 새로 띄운 파드의 이름(Kubernetes 이름 규칙)과 뜬 시각(Unix epoch 밀리초, 클러스터의 시계).
-- - released_at: 푼 시각(감독의 시계).
-- 네 정수 칸은 ANY로 선언하고 CHECK에 typeof = 'integer'를 둔다(판 7과 같은 까닭).
CREATE TABLE slot_hold_releases (
  observation ANY NOT NULL PRIMARY KEY CHECK (typeof(observation) = 'integer' AND observation BETWEEN 1 AND 9007199254740991),
  executor_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  run_generation ANY NOT NULL CHECK (typeof(run_generation) = 'integer' AND run_generation BETWEEN 1 AND 9007199254740991),
  checked_by TEXT NOT NULL,
  pod_name TEXT NOT NULL,
  pod_started_at ANY NOT NULL CHECK (typeof(pod_started_at) = 'integer' AND pod_started_at BETWEEN 1 AND 9007199254740991),
  released_at ANY NOT NULL CHECK (typeof(released_at) = 'integer' AND released_at BETWEEN 1 AND 9007199254740991)
) STRICT, WITHOUT ROWID;

-- 행으로 다시 보는 확인: 정수 칸 넷 가운데 정수가 아닌 것(NULL 포함), 같은 관측의 풀기가 이미 있음, 방법이 목록 밖, 파드 이름이
-- 규칙 밖(판 7과 같은 검사), 그 관측 번호의 줄이 없거나 실행기·실행·세대가 다르거나 이미 자리를 막지 않거나 파드가 그 관측을
-- 적은 시각(held_at) 전에 떴음, 파드가 뜬 시각이 푼 시각 뒤.
-- 파드가 뜬 시각 ≥ 관측을 적은 시각: 관측 뒤에 파드를 바꿨다는 근거다. 그 전에 뜬 파드면 관측한 것이 바로 그 파드의 실행기였을 수
-- 있어 교체의 근거가 되지 않는다. held_at은 감독의 시계라 클러스터의 시계와 같다는 전제다(홈랩은 한 머신이라 시계가 하나다).
-- 쿠버네티스의 시각은 초 단위라 내림해 넘기면 실제보다 이르게 적혀 거절 쪽으로 간다.
-- 이 트리거가 막지 못하는 것: 파드를 정말 바꿨는지, 그 실행기가 바뀐 파드 밖에서 그 실행을 아직 쥐고 있는지.
CREATE TRIGGER slot_hold_releases_proven BEFORE INSERT ON slot_hold_releases
WHEN (typeof(NEW.observation) = 'integer' AND typeof(NEW.run_generation) = 'integer' AND typeof(NEW.pod_started_at) = 'integer'
    AND typeof(NEW.released_at) = 'integer') IS NOT 1
  OR EXISTS (SELECT 1 FROM slot_hold_releases x WHERE x.observation = NEW.observation)
  OR (NEW.checked_by IN ('pod_replaced')) IS NOT 1
  OR (length(NEW.pod_name) BETWEEN 1 AND 253) IS NOT 1
  OR (NEW.pod_name GLOB '[a-z0-9]' OR NEW.pod_name GLOB '[a-z0-9]*[a-z0-9]') IS NOT 1
  OR (NEW.pod_name GLOB '*[^a-z0-9.-]*') IS NOT 0
  OR (instr(NEW.pod_name, '..') + instr(NEW.pod_name, '.-') + instr(NEW.pod_name, '-.') + instr(NEW.pod_name, char(0))) IS NOT 0
  OR NOT EXISTS (SELECT 1 FROM slot_holds h WHERE h.observation = NEW.observation AND h.executor_id = NEW.executor_id
    AND h.run_id = NEW.run_id AND h.run_generation = NEW.run_generation AND h.holds_slot = 1 AND h.held_at <= NEW.pod_started_at)
  OR (NEW.pod_started_at <= NEW.released_at) IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'slot_hold_release_unproven');
END;

-- 근거 줄을 넣는 문장 안에서 그 관측의 자리 막기를 내린다. 풀린 뒤 상태가 다르면 문장 전체가 되돌아가 근거 줄도 남지 않는다.
CREATE TRIGGER slot_hold_releases_release AFTER INSERT ON slot_hold_releases
BEGIN
  UPDATE slot_holds SET holds_slot = 0 WHERE observation = NEW.observation;
  SELECT RAISE(ABORT, 'slot_hold_release_unproven')
  WHERE NOT EXISTS (SELECT 1 FROM slot_holds h WHERE h.observation = NEW.observation AND h.holds_slot = 0);
END;

CREATE TRIGGER slot_hold_releases_fixed BEFORE UPDATE ON slot_hold_releases
BEGIN
  SELECT RAISE(ABORT, 'slot_hold_release_unproven');
END;

CREATE TRIGGER slot_hold_releases_permanent BEFORE DELETE ON slot_hold_releases
BEGIN
  SELECT RAISE(ABORT, 'slot_hold_release_unproven');
END;
