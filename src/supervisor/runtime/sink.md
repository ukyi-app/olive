# 내보내기 포트와 연결 문 (`sink.ts`)

박자 넷(배정·시작, 재전송, 취소, 수명)이 실행기에 지시를 싣는 포트(`dispatch/ports.ts`의 `InstructionSink`)와, 박자 셋이 지시를 만들기 전에 묻는 연결 문(`mayIssue`), 영수증 처리기가 장부 호출마다 묻는 답의 연결 확인(`dispatch/receipts.ts`의 `AnswerLinks`), 그리고 ack 쓰기를 감독 연결 서버의 쓰기 면(`transport/server.md` "틀 쓰기 면") 위에 만든다. 서버에서는 `recognized`와 `writeFrame`만 쓰고 소켓에는 닿지 않는다. 시계·복원기·맡기지 않을 실행기·조회 등록부는 포트로 받는다. 이 포트를 조립하는 곳(박자 순환기, 감독 진입점)은 아직 없다.

## 보장 넷

이 모듈이 주장하는 것은 아래 넷뿐이다. 시험은 `test/supervisor/runtime/sink.test.ts`(가짜 서버)와 `sink-loopback.test.ts`(루프백의 실제 TLS 서버 하나)다.

1. **싣는 순간에 다시 본다. 시간은 쓰기 바로 앞에서 본다.** 정지 세대와, 새 실행을 여는 지시면 접수와 맡기지 않을 실행기를 서버가 자기 확인 뒤에 부르는 `lastCheck` 안에서 본다. 봉투 시한(`expires_at`)과 작업 기한(`deadline_at`)의 여유는 서버가 인정의 재확인까지 마쳐 쓰기로 정한 뒤 `write` 바로 앞에서 부르는 `finalCheck` 안에서 시계를 한 번 읽어 본다. 하나라도 아니면 넘긴 바이트 0이다. 그 앞에서 읽은 값을 쓰지 않는다: `send`를 부른 뒤 `lastCheck`까지 바뀐 세대·접수·집합·시각을 두 확인이 잡는다(시험이 그 사이에 바꾼다). 시계를 `lastCheck`에서 읽으면 그 뒤의 동기 조회(복원기의 세대·접수는 장부를 읽는다, 맡기지 않을 실행기 집합)와 서버의 재확인(세대·게시)에 걸린 시간만큼 실제 쓰기 때의 여유가 약속(11,000ms)보다 준다: 그 사이 1ms만 흘러도 여유 10,999ms인 시작이 실리고 재전송 박자는 `resent`를 적는다. 시험이 집합 읽기, 서버 재확인의 세대 조회, `finalCheck`의 시계 읽기에서 각각 1ms를 흘려 `too_late_to_send`·넘긴 바이트 0을 보고, 실제 재전송 박자(`resendTick → sendInstruction → 이 포트`)가 `resent` 대신 `not_sent`(`delivery: "not_sent"`)를 적는 것을 본다. 맡기지 않을 실행기와 접수는 **새 실행을 여는 지시(`STARTS_RUN`: `task_start`, `session_start`)에만** 건다. 취소·조회까지 막으면 멈춰야 할 실행을 멈추지 못한다.
2. **포트는 동기로 끝난다.** `send` 안에 기다림이 없다: 돌려주는 약속은 돌려줄 때 이미 정해져 있다(시험이 `Bun.peek.status`로 본다). 서버의 `settled`는 비워 둔 함수라 돌아온 뒤 이 포트가 서버를 다시 부르는 길이 없다. 봉투를 쌓거나 저장하지 않는다: 연결이 없어 거절한 봉투는 연결이 생겨도 나가지 않고, 같은 봉투를 다시 넣으면 그때의 판정으로 따로 본다. 그래서 재기동 뒤에 싣는 봉투도 없다.
3. **기다리는 조회(`status_query`)는 쓰기 전에 그 연결 번호와 함께 등록하고, 결과가 `written`이 아니면 그 항목을 거둔다.** 등록은 `recognized`로 고른 연결 번호를 실은 `SentQuery`이고 `writeFrame`보다 먼저다(서버가 `lastCheck`를 부를 때 이미 등록부에 있다). `not_written`, `unknown`, `writeFrame`이 던짐, 꼴이 아닌 결과는 모두 같은 객체를 뺀다(아래 "정한 것" 3).
4. **연결 문과 `AnswerLinks.current`는 부르는 순간의 인정된 연결로 동기 판정한다.** 부를 때마다 `recognized`를 부르고 캐시하지 않는다. 예외는 연결 문의 시계 고장이다: 연결 문은 시계를 먼저 읽고, 읽지 못하면 `recognized`를 묻지 않고 `clock_unavailable`로 답한다(아래 "정한 것" 4). `AnswerLinks.current`는 시계를 읽지 않는다. `recognized`의 번호는 연결을 고르는 데만 쓰고, 실었는지는 `writeFrame`의 결과로만 정한다. ack 쓰기도 같은 `writeFrame`을 지나고 새 실행의 규칙(접수, 맡기지 않을 실행기)은 보지 않는다(ack는 지시가 아니다).

## 공개 면

| 이름 | 꼴 |
|---|---|
| `createWireSink(ports)` | `WireSinkPorts` → `WireSink` |
| `WireSink.sink` | `InstructionSink`. 네 박자의 `ports.sink`. 결과는 아래 "옮김 표" |
| `WireSink.links` | `IssueGate`(`mayIssue(executorId, action)`). 박자 셋의 연결 문(`LinkGate`, `ResendLinkGate`, `CancelLinkGate`)이 모두 받는 꼴 |
| `WireSink.answers` | `AnswerLinks`(`current(connection, executorId)`). 영수증 처리기의 `links` |
| `WireSink.writeAck(connection, envelope)` | ack 봉투를 그 영수증이 온 연결에 쓴다. 동기이고 `AckOutcome`을 돌려준다 |
| `AckOutcome` | `sent`, `no_connection`, `too_late_to_send`, `unsendable`(ack가 아니거나 틀로 만들지 못함, 서버를 부르지 않음), `unknown`(송달 모름) |
| `SINK_REFUSALS` | 두 확인이 내는 이름. `finalCheck`: `clock_unavailable`, `too_late`, `deadline`. `lastCheck`: `stop_generation_unknown`, `stop_generation`, `intake_closed`, `withheld`, `withheld_unknown`. 둘 다: `check_threw` |
| `UNSENDABLE` | 서버까지 가지 않은 까닭: `envelope_unreadable`, `frame_empty`, `frame_too_large`, `not_ack`(writeAck에 ack 아닌 봉투), `ack_on_sink`(sink에 ack) |
| `SinkNote` | 기록: `not_sent`(동작·요청 ID·받는 쪽·옮긴 결과·실제 이름), `unsendable`, `delivery_unknown`(`write_unknown`, `port_threw`, `result_malformed`), `query_withdraw_failed` |

받는 포트(`WireSinkPorts`):

| 포트 | 꼴 | 쓰는 곳 |
|---|---|---|
| `server` | `Pick<ConnectionServer, "recognized" \| "writeFrame">` | 연결 고르기, 틀 쓰기, 연결 문, 답의 연결 확인 |
| `restorer` | `() => Pick<Restorer, "stopGeneration" \| "intakeOpen">` | `lastCheck` 안에서 한 번 불러 그 객체의 세대와 (새 실행이면) 접수를 읽는다. 서버에 넘긴 `restorer`와 같은 함수여야 한다 |
| `withheld` | `WithheldSource`(`dispatch/assign-loop.ts`) | 새 실행을 여는 지시의 `lastCheck` |
| `clock` | `Clock`(`dispatch/ports.ts`) | `finalCheck`마다 한 번, `mayIssue`마다 한 번(`lastCheck`에서는 읽지 않는다) |
| `queries` | `QueryBook`(`add`, `remove`, 동기. `remove`는 없는 항목에 던지지 않는다) | 조회의 등록과 거둠 |
| `observe` | `(SinkNote) => void`, 선택 | 기록. 던져도 무시한다. `lastCheck`·`finalCheck` 안에서는 부르지 않는다 |

## 한 번의 싣기

1. 봉투를 정규 직렬화(`canonicalJson`)로 한 번 읽어 글로 만들고, 그 글을 다시 푼 사본에서 칸(동작, 요청 ID, 받는 쪽, 정지 세대, 시한, 본문의 `deadline_at`, 조회면 `run_ids`)을 읽는다. 넘기는 바이트는 그 글이다. 그래서 읽을 때마다 다른 값을 내는 접근자가 있어도 확인한 칸과 넘긴 바이트가 같다. 읽지 못하거나 틀로 만들지 못하면(`encodeFrame`) 서버를 부르지 않는다.
2. 문을 가른다. `sink`는 ack가 아닌 것만, `writeAck`는 ack만 싣는다. 시작 규칙을 보지 않는 ack 문으로 지시가 나가지 않게 한다.
3. 연결을 고른다. 지시는 `recognized(받는 쪽)`, ack는 넘겨받은 연결 번호(서버의 `writeFrame`이 그 번호가 그 주체의 인정된 연결인지 다시 본다). 지시인데 `null`이면 `no_connection`이고 `writeFrame`을 부르지 않는다.
4. 조회면 `SentQuery`를 등록한다.
5. `writeFrame(연결, 받는 쪽, 틀, { lastCheck, finalCheck, settled })`를 한 번 부른다. 틀 하나를 통째로 넘긴다. 서버는 자기 확인 → `lastCheck` → 인정의 재확인 → `finalCheck` → `write` 차례로 간다(`transport/server.md` "틀 쓰기 면" 2).
6. 결과를 옮기고, 조회인데 `written`이 아니면 4의 항목을 거둔다.

두 확인의 차례:

| 차례 | 보는 것 | 아니면 |
|---|---|---|
| `lastCheck` 1 | 게시된 복원기를 한 번 부르고 그 `stopGeneration()`이 봉투의 정지 세대와 같다(오름·내림 모두 다름) | 모름·던짐이면 `stop_generation_unknown`, 다르면 `stop_generation` |
| `lastCheck` 2 | (새 실행을 여는 지시만) 같은 복원기 객체의 `intakeOpen()`이 `true` | `intake_closed` |
| `lastCheck` 3 | (새 실행을 여는 지시만) 맡기지 않을 실행기 집합을 한 번 읽고 받는 쪽이 없다 | 있으면 `withheld`, 모름·던짐·꼴이 틀림이면 `withheld_unknown` |
| `finalCheck` 1 | 시계를 한 번 읽는다(던지거나 안전 정수가 아니면) | `clock_unavailable` |
| `finalCheck` 2 | `expires_at − 지금 ≥ 여유`. 여유는 `run_renew`면 `RENEW_MARGIN_MS`(13,000ms), 그 밖은 `DELIVERY_MAX_MS + CLOCK_SKEW_MS`(11,000ms). 남은 시간이 여유와 같으면 싣는다 | `too_late` |
| `finalCheck` 3 | 본문에 `deadline_at`이 있으면 `deadline_at − 지금 ≥ 11,000ms` | `deadline` |

두 확인은 서버를 다시 부르지 않고 기록도 남기지 않는다(`observe`가 서버를 부를 수 있다). 복원 상태를 바꾸지 않고 읽기만 한다. `finalCheck` 안에서는 시계 읽기와 견줌만 한다: 서버가 그 뒤 인정·게시를 다시 보지 않으므로 거기서 포트를 읽으면 그 읽기에 걸린 시간과 그 사이의 변화를 잡을 자리가 없다. `lastCheck`에서 걸리거나 서버의 재확인에서 돌아가면 `finalCheck`는 불리지 않고 시계도 읽지 않는다.

## 옮김 표

| `writeFrame`(또는 그 앞) | `send`의 답 | `writeAck`의 답 | 기록의 이름 |
|---|---|---|---|
| `written` | `"sent"` | `sent` | 없음 |
| `recognized`가 `null`(writeFrame을 부르지 않음) | `"no_connection"` | (ack는 고르지 않는다) | `not_recognized` |
| `not_written`: `not_recognized`, `closed`, `backlog`, `reentered`, `check_failed` | `"no_connection"` | `no_connection` | 서버의 `reason` 그대로 |
| `not_written`: `refused` + `too_late`·`deadline` | `"too_late_to_send"` | `too_late_to_send` | `too_late`·`deadline` |
| `not_written`: `refused` + 그 밖의 이름 | `"no_connection"` | `no_connection` | `SINK_REFUSALS`의 그 이름 |
| `unknown` | 약속 거절. 배정·재전송·수명 박자는 `reason: "send_threw"`, `delivery: "unknown"`으로 적는다. 취소 박자는 `outcome: "delivery_unknown"`, `reason: "send_threw"`를 관측하고 `delivery` 칸이 없다(`dispatch/cancel.ts`). 어느 쪽도 미송신으로 적지 않는다 | `unknown` | `write_unknown` |
| `recognized`·등록부·`writeFrame`이 던짐, 꼴이 아닌 결과 | 약속 거절(위 칸과 같이 적힌다) | `unknown` | `port_threw`·`result_malformed` |

꼴이 아닌 결과는 서버의 결과 타입(`transport/server.ts`의 `WriteFrameResult`)에 없는 답이다: 모르는 `kind`, `not_written`인데 사유가 없거나 `NOT_WRITTEN_REASONS`에 없는 사유, `refusal` 문자열이 없는 `refused`. "넘긴 바이트 0"은 서버가 그 꼴로 답했을 때만 믿는다. 꼴이 아닌 답을 `no_connection`으로 옮기면 박자가 확정 미송신으로 적고 다음 박자에 같은 요청 ID로 다시 낸다.
| 서버까지 가지 않음(`UNSENDABLE`) | 약속 거절 | `unsendable` | 그 이름 |

## 정한 것

1. **정지·접수 닫힘·맡기지 않을 실행기·시계 모름으로 막은 것은 박자 결과로는 `no_connection`이다.** 실제 이름은 기록(`SinkNote`)에만 있다. `SendOutcome`을 넓히면 네 박자가 모르는 문자열을 `send_answer_malformed`(송달 모름)로 읽으므로 박자와 시험을 함께 고쳐야 한다. 두 이름은 같은 사실("넘긴 바이트 0, 쌓지 않았다")을 말하고, 박자는 둘 다 장부의 요청 ID를 그대로 둔다: 재전송 박자는 `no_connection`·`too_late_to_send`를 `not_sent`(`delivery: "not_sent"`)로 적는다. 다음 박자가 그 항목을 다시 판단해, 여전히 발급할 수 있을 때만 장부의 같은 요청 ID·같은 본문으로 봉한다(`dispatch/resend.md` 첫머리와 "초안은 항목의 값만으로 만든다"). 정지 세대가 오른 시작은 다시 봉하지 않는다: 재전송 박자가 봉하기 전에 시한·세대·접수를 보고 세대가 다르면 `stop_generation_mismatch`로 둔다(세대를 맞춘 뒤의 지시는 다른 조각이 새 요청으로 낸다). 이 포트는 봉투를 고치지 않는다.
2. **서버까지 가지 않은 봉투와 송달 모름은 약속을 거절한다.** 틀을 만들지 못한 봉투를 `no_connection`으로 알리면 박자는 연결이 생기면 실릴 것으로 보고 같은 봉투를 되풀이하며, 고장이 연결 상태에 묻힌다. 거절은 박자에서 `send_threw`(송달 모름)로 보여 실렸을 수 있는 쪽으로 다뤄진다. `writeAck`는 동기로 쓰는 영수증 순환이 부르므로 같은 사실을 값(`unsendable`, `unknown`)으로 돌려준다.
3. **`unknown`이면 조회 등록을 거둔다.** 서버는 `unknown`을 돌려주기 전에 그 연결을 `send_failed`로 닫았고 연결 번호를 다시 쓰지 않는다. 닫힌 연결의 대기열과 늦게 끝난 검증은 판단에 넘기지 않으므로(`server.md` 보장 3) 그 연결 번호로 오는 답은 없다. 남겨 두면 지울 근거가 없는 항목만 쌓인다. 수명 박자는 송달 모름이면 자기 결과의 `pendingQueries`에 그 조회를 넣지만(연결 번호 없음) 그것과 이 등록부는 다르다.
4. **연결 문의 `Link`는 인정된 연결이 있으면 `{ connected, since: 지금, last_seen_at: 지금 }`, 없으면 `{ disconnected, since: 지금 }`이다.** 연결 표에 마지막으로 받은 시각이 없다. 받은 시각으로 채우면 계약 v1에 살아 있음 확인 메시지가 없어 일 없는 실행기가 `DISCONNECT_JUDGE_MS`(30초) 뒤 `lost`로 보이고 시작이 막힌다. `since`는 `connected`일 때 계약의 판정이 읽지 않는다. 시계를 읽지 못하면 `{ ok: false, reason: "clock_unavailable" }`이다(박자는 `no_connection`으로 읽고 만들지 않는다).
5. **정지 세대와 접수는 같은 복원기 객체에서 읽는다.** 복원기와 접수를 따로 받지 않고 게시된 복원기를 돌려주는 함수 하나만 받는다. 서버도 같은 함수를 받으므로 조립이 같은 함수를 두 곳에 넘기면 서버의 인정과 이 확인이 같은 복원기를 본다. 둘을 따로 받으면 서로 다른 객체(다시 복원한 뒤의 옛 객체 등)를 넘길 수 있다.
6. **갱신의 봉투 시한은 13,000ms로 본다.** 수명 박자는 포트를 부르기 직전에 `min(앞 임대의 끝, expires_at) − 지금 ≥ RENEW_MARGIN_MS`를 재고 그 사이에 기다림이 없다. 포트가 `expires_at`에 같은 여유를 다시 걸어 그 판정과 어긋나지 않게 한다. 앞 임대의 끝과 실행의 업무 기한은 봉투에 없어 이 포트가 보지 못한다(아래 "남는 한계").
7. **맡기지 않을 실행기 집합은 `value`를 한 번 읽고, 원소 하나라도 작업자 실행기 주체 이름이 아니거나(빈 문자열, 모르는 역할, 세션 실행기·감독 같은 다른 주체, 문자열 아님) 빈 칸이면 모름이다.** 모름이면 시작을 싣지 않는다. 원소 검사는 배정 박자의 것(`dispatch/assign-loop.ts`의 `isWorkerName`)을 그대로 쓴다: 같은 원천을 두 곳이 다르게 읽으면 배정은 모름으로 멈추는데 송신은 싣는다.
8. **ack에도 공통 규칙(시한, 정지 세대)을 건다.** 시한이 지난 ack는 실행기가 거절하고, 세대를 모르는 동안 낸 ack는 영수증 처리기가 만들지 않는 것과 같은 쪽이다. 새 실행의 규칙은 걸지 않는다: 접수가 닫힌 동안에도 ack가 나가야 실행기가 영수증 재전송을 멈춘다.

## `server.md` "뒤 조각이 지켜야 할 것" 가운데 이 포트에 걸리는 것

| 조건 | 지킨 자리 |
|---|---|
| `lastCheck`는 동기이고 그 안에서 기다리거나 서버를 다시 부르거나 복원 상태를 바꾸지 않는다 | `judge`: 복원기·집합의 읽기만 있고 시계·서버·`observe`를 부르지 않는다. 파일에 기다림이 없다(정적 시험) |
| 세대·접수·맡기지 않을 실행기는 `lastCheck`에서 보고 그 앞에서 본 값을 믿지 않는다 | `judge`가 `lastCheck` 안에서 모두 읽는다. 시험 "앞에서 본 값을 믿지 않는다", "차례" |
| 시한·작업 기한의 여유는 `finalCheck`에서 시계를 한 번 읽어 보고, 그 안에서는 견줌만 한다 | `timeVerdict`: 시계 한 번과 두 뺄셈뿐이다. 시험 "시간은 쓰기 바로 앞(finalCheck)에서 본다" |
| `recognized`의 번호는 후보를 고르는 데만 쓰고 실었는지는 `writeFrame`의 결과로 정한다 | `deliver`: `written`일 때만 `sent` |
| 조회는 쓰기 전에 연결 번호에 묶고 쓰지 못하면 거둔다 | `deliver`의 등록과 `finally`의 거둠 |
| `settled` 뒤에만 정리하고, `unknown`이면 정리를 두 번 하지 않는다 | 봉투에는 정리할 비밀이 없어 `settled`를 비워 두고, 반환을 보고 하는 정리도 없다 |
| 틀은 한 호출에 하나를 통째로 넘긴다 | `writeFrame` 한 번에 `encodeFrame`의 틀 전체 |
| 결과를 구분해 옮긴다(시한 거절은 `too_late_to_send`, 연결 없음·닫힘·상한은 `no_connection`, `unknown`은 송달 모름) | 위 "옮김 표" |
| `written`·`flushed`는 접수가 아니다 | `sent`만 돌려주고 장부·접수를 적지 않는다 |
| 맞춤이 끝나기 전의 연결에 쓰지 않는다 | 소켓에 닿지 않고 `writeFrame`만 부른다(서버가 인정된 연결에만 쓴다) |
| `restorer`는 박자에 넘기는 그 복원기 객체를 돌려준다 | 서버와 같은 게시 함수를 받는다(정한 것 5). 같은 함수를 넘기는 것은 조립의 일 |

## 정적 시험

`sink.test.ts`의 "정적" 묶음이 소스를 읽어 본다. `src/`에서 `writeFrame`을 부르는 파일은 이 파일(한 자리)과 자격 값 보내기(`dispatch/credential-send.ts`)뿐이다(선언은 세지 않는다). 이 파일에는 `startDraft`, `task_start` 문자열, `markStartDispatch`, `sendInstruction`, 봉하기 호출이 없다: 시작 봉투를 내는 새 길은 `sendInstruction`을 지나고 이 포트는 받은 봉투만 싣는다. 기다림·미룸(`await`, `async`, `.then(`, `queueMicrotask`, 타이머)과 시계·난수·환경·파일의 직접 사용이 없다. 이 파일은 송신 모양(`dispatch/start-send.test.ts`의 목록)을 쓰지 않으므로 그 목록이 바뀌지 않는다: 포트 메서드는 선언(`send(envelope: Envelope): ...`)으로만 있다.

## 남는 한계

- **끊긴 줄 모르는 연결에도 지시가 나갈 수 있다.** 상대가 FIN·RST 없이 사라진 연결은 서버가 닫을 때까지 인정되므로 연결 문은 `connected`, 포트는 `sent`다. 그 지시는 실행기에 닿지 않는다. 지시마다 다루는 길이 다르다.
  - **받은 적 없는 작업자 시작**만 "받은 적 없음" 규칙(D-90)의 대상이다. 감독은 재전송 한도까지 같은 요청 ID로 다시 보내고, 한도가 지나면 재전송 박자는 `start_expired`를 낸다. 그것만으로 자리를 풀지 않는다: 접수 영수증이 한 번도 없었고 그 뒤 전체 점유 답에도 그 실행이 없어야 D-90이 닫는다(`dispatch/resend.md` "뒤 조각이 지킬 것", `ledger/ledger.md` "D-90").
  - **그 밖의 지시(갱신·조회·취소·확정)**는 D-90으로 다루지 않는다. 재전송 박자가 다시 내는 취소·확정은 발급할 수 있는 동안 같은 요청 ID로 다시 낸다. 진행 중인 실행의 갱신이 유실되면 수명 박자가 임대의 끝과 여유를 보고 상태 조회로 옮긴다(`scheduler/lifecycle.ts`의 판정).
  - 반쯤 열린 연결의 감지는 뒤 조각이다(`server.md` "이 모듈에 없는 것"). FIN·RST가 없는 실제 유실을 재현한 시험은 없다.
- **막힌 이유가 박자 결과에는 "연결 없음"으로 보인다.** 정지·접수 닫힘·맡기지 않을 실행기·시계 모름도 박자에는 `no_connection`이고 실제 이름은 기록에만 있다.
- **갱신의 앞 임대 끝과 실행의 업무 기한은 싣는 순간에 다시 보지 못한다.** 봉투에 없다. 수명 박자가 포트를 부르기 직전에 재고, 그 뒤 싣기까지는 이 포트와 서버가 기다리지 않는다는 것으로만 지킨다. 그 사이의 선점과 서버의 동기 확인에 걸린 시간은 재지 못한다(`dispatch/life-loop.md` "뒤 조각이 지킬 것"의 `notAfter`).
- **`finalCheck`의 시계 읽기와 `write` 호출 사이의 선점은 막지 못한다.** 그 사이에 외부 코드는 없고 서버 자기 기록의 확인뿐이다(서버의 "틀 쓰기 면" 2와 같다). 실행기가 받는 시각까지의 전달은 여유 11,000ms(전달 10,000ms + 시계 차 1,000ms)가 맡는다.
- **서버를 닫는 동안의 새 발급은 막지 않는다.** `close()`가 연결을 하나씩 닫는 사이 아직 닫히지 않은 연결에는 쓸 수 있다. 먼저 막는 것은 조립의 일이다.

## 이 모듈에 없는 것

자격 값 보내기(같은 쓰기 면의 다른 조각), 박자 순환기와 감독 진입점(이 포트를 만들고 넘기는 곳), 조회 등록부의 구현과 수명, 반쯤 열린 연결의 감지, `notAfter`(갱신의 "이 시각 뒤에는 싣지 않음") 칸.

## 뒤 조각이 지켜야 할 것

- **같은 복원기 게시 함수·같은 시계를 넘긴다.** 서버의 `restorer`와 이 포트의 `restorer`는 같은 함수다. 시계는 장부와 박자의 시계와 같다(`dispatch/ports.ts`의 `Clock`).
- **`server`는 `finalCheck`를 인정의 재확인 뒤, `write` 바로 앞에서 부르는 서버다(`transport/server.ts`).** 이 포트는 시한·작업 기한을 `finalCheck`에서만 보므로, `finalCheck`를 부르지 않는 쓰기 면에 넘기면 시간을 보지 않고 싣는다.
- **맡기지 않을 실행기는 배정 박자와 같은 원천을 넘긴다.** 인사 처리기의 `withhold`를 모은 그 `WithheldSource`다(`dispatch/assign-loop.md` "뒤 조각이 지킬 것").
- **박자의 장부 포트는 박자가 읽는 그 장부 객체다.** 이 포트는 장부를 쥐지 않는다. 시작의 송신 표식은 `sendInstruction`이 그 장부 객체로 적는다.
- **조회 등록부는 서버 객체와 수명을 같이한다.** 서버를 새로 시작하면 연결 번호가 1부터이므로 옛 서버의 연결 번호로 묶인 항목을 함께 버린다. 연결이 철회·교체되면 그 연결의 항목을 끝낸다(`dispatch/receipts.md` "뒤 조각이 지킬 것"). 영수증 처리기의 `pendingQueries`는 이 등록부에서 읽는다.
- **서버를 닫기 시작하면 새 발급(지시·ack·값)을 먼저 막고 그다음 `close()`를 부른다.**
- **ack는 `writeAck`로 그 영수증이 온 연결(`forward.connection`)에 쓴다.** 영수증 처리기가 낸 초안을 봉한 봉투다. `sink`에 넣으면 거절한다.
- **`maxPendingWriteBytes`는 같은 박자에 한 연결로 나가는 틀(ack, 지시, 값)을 담을 만큼 둔다.** 작으면 그 연결이 `send_backlog`로 닫히고 이 포트는 `no_connection`(`backlog`)을 낸다.
