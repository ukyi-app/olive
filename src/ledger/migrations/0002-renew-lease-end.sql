-- 갱신 지시(run_renew)로 감독이 발급한 임대의 끝. 그 지시 본문의 lease_until과 같은 값(발행 시각 + RUN_LEASE_MAX_MS)이다.
-- 실행기가 그 끝을 적용했다는 근거는 아니다(앞 임대가 끝난 뒤에 받은 갱신은 연장하지 않고 닫는다).
-- NULL은 장부가 그 끝을 갖지 않는다는 뜻이다: 이 판을 적용하기 전에 적힌 줄, 갱신이 아닌 지시, 그리고 같은 실행의 앞 임대 지시
-- (시작·갱신)보다 늦지 않은 발행 시각으로 적힌 갱신(ledger.ts의 recordRenewInstruction). 칸만 더하고 기존 줄의 값은 바꾸지 않는다.
-- 지시는 적은 뒤 바뀌지 않으므로(instructions_fixed) 나중에 채우지 않는다.
ALTER TABLE instructions ADD COLUMN lease_until INTEGER
  CHECK (lease_until IS NULL OR (action = 'run_renew' AND lease_until > issued_at AND lease_until <= 9007199254740991));
