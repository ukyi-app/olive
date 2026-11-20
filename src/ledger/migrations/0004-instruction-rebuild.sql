-- 지시의 본문을 다시 만들 칸. 감독이 지시를 적고 실행기에 보내기 전에 끊기면, 다시 뜬 감독은 같은 요청 ID·같은 본문을 새 봉투에 담아
-- 다시 보낸다. 실행기는 그 재전송을 멱등으로 처리하지만 같은 요청 ID에 본문이 다르면 답하지 않으므로 본문의 값이 처음과 같아야 한다.
-- 실행 줄에서 읽을 수 있고 시작 뒤에 바뀌지 않는 값(역할·revision 둘·snapshot·입력 digest·기한·지정 실행기·자격 네 칸·실행 세대)은
-- 복사하지 않는다. 여기 두는 것은 실행 줄에 없거나 시작 뒤에 바뀌는 값뿐이다.
-- - budget_left: 시작 지시(task_start) 본문의 budget_tokens. 실행 줄의 남은 예산은 시작 뒤 줄어들 수 있다(recordBudget).
-- - reason: 종료 지시(task_cancel·session_stop) 본문의 reason. 허용 값은 계약 v1의 목록과 같다(시험이 대조한다).
-- - outcome·result_digest·stored_at: 확정 지시(result_finalize) 본문의 같은 이름 칸. outcome과 stored_at은 함께 있거나 함께 없고,
--   result_digest는 outcome이 succeeded일 때만, 그리고 그때는 반드시 있다(계약의 parseResultFinalize와 같은 규칙).
-- NULL은 장부가 그 지시의 본문을 다시 만들 수 없다는 뜻이다: 이 판을 적용하기 전에 적힌 줄, 칸을 넘기지 않고 적힌 줄, 이 칸을 쓰지 않는
-- 동작(갱신은 lease_until을 쓰고, 세션 시작은 적히지 않는다). 칸만 더하고 기존 줄의 값은 바꾸지 않는다.
-- 지시는 적은 뒤 바뀌지 않으므로(instructions_fixed) 나중에 채우지 않는다.
ALTER TABLE instructions ADD COLUMN budget_left INTEGER
  CHECK (budget_left IS NULL OR (action = 'task_start' AND budget_left BETWEEN 1 AND 9007199254740991));
ALTER TABLE instructions ADD COLUMN reason TEXT
  CHECK (reason IS NULL
    OR (action = 'task_cancel' AND reason IN ('requested', 'deadline', 'budget', 'emergency_stop'))
    OR (action = 'session_stop' AND reason IN ('daily_rotation', 'session_broken', 'emergency_stop', 'account_switch')));
ALTER TABLE instructions ADD COLUMN outcome TEXT
  CHECK (outcome IS NULL OR (action = 'result_finalize' AND outcome IN ('succeeded', 'failed', 'cancelled')));
ALTER TABLE instructions ADD COLUMN result_digest TEXT
  CHECK (result_digest IS NULL OR outcome = 'succeeded');
ALTER TABLE instructions ADD COLUMN stored_at INTEGER
  CHECK ((stored_at IS NULL) = (outcome IS NULL)
    AND (stored_at IS NULL OR stored_at BETWEEN 1 AND 9007199254740991)
    AND (outcome IS NOT 'succeeded' OR result_digest IS NOT NULL));
