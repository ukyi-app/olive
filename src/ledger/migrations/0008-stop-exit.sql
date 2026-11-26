-- 종료 확인 영수증(receipt_stopped)의 exit를 작업자 실행 줄에 남긴다(D-124). 칸 하나(runs.stop_exit)와 트리거 하나를 더한다.
-- 실행 줄이 failed_stopped가 된 장부 시각도 칸 하나(runs.failed_stopped_at)와 트리거 하나로 남긴다(D-114의 stored_at). 아래 둘째 묶음.
-- 까닭: 상태만으로는 exit가 completed(checking으로 간다)인지 그 밖(곧바로 failed_stopped로 간다)인지만 남는다. 곧바로 failed_stopped가
-- 된 실행의 확정 outcome은 exit가 cancelled면 cancelled, deadline·failed면 failed라(D-114) exit 값이 있어야 정한다.
-- 값은 계약 v1의 exit 넷(completed·cancelled·deadline·failed) 가운데 하나이고, 그 실행의 첫 종료 확인(stop_receipt_id)을 적는 같은
-- UPDATE에서만 들어가며 그 뒤로는 바뀌지 않는다(아래 트리거).
-- NULL은 장부가 그 exit를 모른다는 뜻이다: 종료 확인이 아직 없는 줄, 세션 줄, 이 판을 적용하기 전에 종료 확인을 받은 줄. 칸만 더하고
-- 기존 줄의 값은 바꾸지 않으며 나중에 채우지 않는다(트리거가 종료 확인이 이미 있는 줄에 넣는 것을 막는다).
-- SQL이 막지 않는 것: 이 판 뒤에도 원 SQL로 exit 없이 종료 확인만 적은 줄은 만들 수 있다. 장부의 코드는 종료 확인 영수증을 반영하는
-- 쓰기에서 둘을 늘 함께 적는다(ledger.ts의 receipt_stopped). 그 줄의 exit는 모름(NULL)이지만 확정되지 않는다는 뜻은 아니다: 판 8 전의
-- 줄과 같이 사유 requested의 취소 지시로, 또는 뒤의 결과 없음 판정이 적은 실패 시각(아래 둘째 묶음)으로 확정 outcome이 정해질 수
-- 있다(ledger.ts의 failedStop, life-loop.ts의 failedOutcome).
-- 값의 목록은 칸의 CHECK가 아니라 트리거에 둔다: 이름 없는 CHECK는 다음 판이 빼거나 넓히지 못하고, 트리거는 DROP·CREATE로 다시
-- 만든다(이관 0006 머리의 주석). 칸의 CHECK에는 바뀌지 않을 조건(작업자 줄이고 종료 확인이 있음)만 둔다. ADD COLUMN의 CHECK는 기존
-- 줄에도 걸리고, 기존 줄은 모두 NULL이라 지난다.

ALTER TABLE runs ADD COLUMN stop_exit TEXT
  CHECK (stop_exit IS NULL OR (kind = 'worker' AND stop_receipt_id IS NOT NULL));

-- exit는 첫 종료 확인과 같은 UPDATE에서만, 목록의 값으로, 그 영수증이 옮기는 상태(completed는 checking, 그 밖은 failed_stopped)와 맞을
-- 때만 들어간다. 들어간 값은 바꾸거나 비우지 못한다. 상태 대조는 "(조건) IS NOT 1"로 쓴다: 목록 밖의 값이면 CASE가 NULL이고
-- NULL IS NOT 1은 참이라 막는 쪽으로 간다.
CREATE TRIGGER runs_stop_exit_fixed BEFORE UPDATE ON runs
WHEN NEW.stop_exit IS NOT OLD.stop_exit AND (
  OLD.stop_exit IS NOT NULL OR OLD.stop_receipt_id IS NOT NULL OR NEW.stop_receipt_id IS NULL
  OR (NEW.state = CASE NEW.stop_exit WHEN 'completed' THEN 'checking' WHEN 'cancelled' THEN 'failed_stopped'
        WHEN 'deadline' THEN 'failed_stopped' WHEN 'failed' THEN 'failed_stopped' END) IS NOT 1)
BEGIN
  SELECT RAISE(ABORT, 'run_evidence_mismatch');
END;

-- 실패 상태가 된 시각. 까닭: updated_at은 상태와 무관한 뒤 쓰기(recordBudget)도 바꿔, failed_stopped가 된 시각으로 읽으면 확정의
-- stored_at이 틀린다. 값은 failed_stopped로 옮기는 같은 UPDATE에서 그 UPDATE의 updated_at으로만 들어가고 그 뒤로는 바뀌지 않는다.
-- NULL은 장부가 그 시각을 칸으로 모른다는 뜻이다: failed_stopped가 된 적 없는 줄, 이 판 전에 failed_stopped가 된 줄(나중에 채우지
-- 않는다), 원 SQL로 이 칸 없이 옮긴 줄. 그 줄은 updated_at이 종료 확인 영수증을 받은 시각과 같을 때만 그 시각으로 읽는다(ledger.ts의
-- failedStop).
-- exit 없이 이 칸을 적는 것은 checking에서 옮길 때(결과 없음 판정)뿐이다. 그래서 exit가 NULL이고 이 칸이 있는 줄은 completed로
-- checking이 된 줄이다(판 8 전에 종료 확인을 받고 판 8 뒤에 판정된 줄). 그 밖에서 옮기는 쓰기는 exit를 함께 적는 첫 종료 확인뿐이다.

ALTER TABLE runs ADD COLUMN failed_stopped_at INTEGER
  CHECK (failed_stopped_at IS NULL OR (kind = 'worker' AND stop_receipt_id IS NOT NULL));

CREATE TRIGGER runs_failed_stopped_at_fixed BEFORE UPDATE ON runs
WHEN NEW.failed_stopped_at IS NOT OLD.failed_stopped_at AND (
  OLD.failed_stopped_at IS NOT NULL OR OLD.state IS 'failed_stopped' OR NEW.state IS NOT 'failed_stopped'
  OR NEW.failed_stopped_at IS NOT NEW.updated_at
  OR (OLD.state IS NOT 'checking' AND (OLD.stop_receipt_id IS NOT NULL OR NEW.stop_exit IS NULL)))
BEGIN
  SELECT RAISE(ABORT, 'run_evidence_mismatch');
END;
