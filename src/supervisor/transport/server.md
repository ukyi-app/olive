# 감독 연결 서버 (`server.ts`)

감독이 실행기의 연결을 받는 서버다. `tls-server.ts`가 상호 TLS로 인증해 넘긴 연결마다 바이트 틀 디코더(`src/transport/framing.ts`) 하나와 대기열 하나를 두고, 받은 봉투를 연결 판단(`connections.ts`)의 `check` → `step`으로 넘기고, 판단이 낸 것을 실행하거나 부르는 쪽에 넘긴다. 판단은 여기서 다시 만들지 않는다. 소켓은 `tls-server.ts`가 연 것만 쓴다(실행기는 듣지 않는다, D-55). 시계·nonce 저장소·서명·복원기·등록표는 주입받는다. 타이머가 없다: 시간이 흘러 생기는 판단은 부르는 쪽이 `tick()`을 불러야 일어난다. 밖으로 던지지 않는다(시작 실패도 구별된 결과로 돌려준다).

## 보장 넷

이 모듈이 주장하는 것은 아래 넷뿐이다. 시험은 `test/supervisor/transport/server.test.ts`이고 루프백(127.0.0.1, 빈 포트)의 실제 TLS로 돈다.

1. **봉투는 받은 순서대로, 받은 시각과 함께, 검증을 기다린 뒤 판단에 넘긴다.** 연결마다 디코더는 하나다. 받은 시각은 그 봉투의 마지막 바이트가 온 `data` 사건에서 주입받은 시계를 읽은 값이고, 검증을 기다리며 줄을 선 동안 흐른 시간은 들지 않는다. 한 연결에서는 앞 봉투의 `check`가 끝나고 `step`이 돈 뒤에 다음 봉투의 `check`를 시작한다. `step`은 `await` 뒤의 지금 연결 표에 건다(검증을 시작한 때의 표에 걸면 그 사이 다른 연결이 바꾼 상태가 되돌아간다). 틀이 거절한 바이트(길이 0, 크기 상한, 깨진 UTF-8, JSON 문법, 중복 키, 깊이)는 판단에 닿지 않고(nonce도 쓰지 않는다) 그 연결을 닫는다. 답을 싣기 전에 받은 봉투가 답을 실은 뒤에 차례가 오면 판단에 넘기지 않고 닫는다(아래 "정한 것" 1).
2. **답은 기한 안에만 싣고, 실은 순간을 판단에 알린다.** 판단의 `send_reply`는 시계를 읽어 그 값이 `deadline` 미만일 때만 틀로 싸서 소켓에 싣고, 같은 동기 구간에서 그 시각으로 `reply_sent`를 넣는다. 정각이거나 지났으면 싣지 않고 `tick`을 넣어 판단이 그 연결을 `answer_late`로 닫게 한다. 소켓이 이미 닫혔거나 쓰기가 던졌거나 봉투를 틀로 만들지 못하면 실은 것으로 치지 않고(`reply_sent`를 넣지 않고) 그 연결을 닫는다.
3. **닫힘과 교체.** 판단이 `close`를 내면 소켓을 닫고 `closed`를 판단에 넣는다. 상대가 끊었거나(`end`, `close`) 소켓 오류로 닫혀도 `closed`를 넣는다. 연결마다 한 번이다. 닫힌 연결의 대기열은 버리고, 닫힌 뒤 늦게 끝난 `check`의 결과는 판단에 넘기지 않는다(`late_dropped`). 그 결과가 다른 연결이나 같은 실행기의 새 연결의 상태를 바꾸지 않는다. 연결 번호는 다시 쓰지 않으므로 판단도 지운 행의 결과를 쓰지 않는다: 이 서버의 버림은 그 위의 두 번째 겹이다.
4. **등록표가 바뀌면 판단에 알리고, 더는 믿지 않는 연결을 끊는다.** `applyRegistry`는 받은 바이트를 복사해 지금 판의 `apply`에 넘기고, 결과의 상태를 지금 판으로 삼고, `registry` 사건을 넣는다. 판단이 `stillTrusts`가 거짓인 연결에 낸 `close`를 그 자리에서 실행한다. 적용에 실패하면(아무도 믿지 않는 판) 맞춘 연결이 모두 닫힌다. 봉투마다 `check`를 부르는 순간의 판을 넘기므로 공개 키는 봉투마다 지금 판에서 새로 얻는다(연결을 맺을 때의 판이나 키를 쥐지 않는다).

## 공개 면

| 이름 | 꼴 |
|---|---|
| `startConnectionServer(options)` | `ConnectionServerOptions` → `Promise<StartResult>`. 실패는 `bad_settings`(연결 판단이 받지 않는 설정), `no_material`(자기 TLS 재료, 사유 그대로), `listen_failed` |
| `ConnectionServer` | `port`, `table()`(지금의 연결 표: `get`·`candidates`·`occupancy`를 읽는다), `registry()`(지금 판), `applyRegistry(input)`(적용 결과 그대로), `tick()`, `close()` |
| `Delivered` | 부르는 쪽에 넘기는 출력 넷(`occupancy`·`candidate`·`withdrawn`·`forward`), 연결 판단의 `Output` 그대로 |
| `ServerNote` | 기록용: `opened`, `rejected_tls`(TLS 판정 사유), `closed`(`cause`, 틀 거절이면 `frame`), `reply_not_sent`(`deadline`, `at`), `late_dropped` |
| `LINK_CLOSE_CAUSES` | `judgment`, `peer`, `frame`, `before_reply`, `check_failed`, `judgment_failed`, `write_failed`, `reply_late`, `deliver_failed`, `clock_failed`, `shutdown` |

서버가 받는 포트(`ConnectionServerOptions`):

| 포트 | 꼴 | 쓰는 곳 |
|---|---|---|
| `host`, `port`, `material` | `tls-server.ts`의 것 그대로 | 상호 TLS 수신 |
| `clock` | `() => number` | 받은 시각(`check`의 `now`), 실은 시각(`reply_sent`의 `at`), 판단 시각(`step`의 `now`), TLS 상대 인증서의 기간. 이 모듈 안에서 던지면 그 연결을 `clock_failed`로 닫는다(열기 전이면 판단에 열지 않고 소켓만 닫는다) |
| `registry` | `RegistryState` | 시작할 때 믿는 판. 이후 `applyRegistry`만 바꾼다. `check`·`step`에 그때의 판을 넘긴다 |
| `restorer` | `() => StopGenerationSource` | `check`·`step`마다 부르는 순간의 복원기. 던지면 세대를 모르는 복원기(`stopGeneration() === null`)로 넘긴다 |
| `runGeneration` | `(runId) => number \| undefined` | `check`(hello·status_report의 실행 세대 대조) |
| `nonces` | `NonceStore` | `check`. 던지거나 거절된 약속이면 그 연결을 `check_failed`로 닫는다 |
| `reply` | `ReplyTools` | `step`(맞춤 답 서명, 요청 ID, nonce) |
| `settings` | `ConnectionSettings` | `Connections.start`에 그대로(동시 연결 상한, 재접속 제한, hello 대기) |
| `deliver` | `(Delivered) => void` | 아래 표. 던지면 그 연결을 `deliver_failed`로 닫는다 |
| `observe` | `(ServerNote) => void` | 기록. 던져도 무시한다 |

판단의 출력:

| 출력 | 누가 | 하는 일 |
|---|---|---|
| `send_reply` | 서버 | 기한 정각 전이면 틀로 싣고 `reply_sent`. 아니면 싣지 않고 `tick` |
| `close` | 서버 | 소켓을 닫고 `closed`를 한 번 |
| `occupancy` | 부르는 쪽 | `full`은 `dispatch/hello-answers.ts`의 `passHelloAnswer`가 받는 꼴. `partial`(status_report)의 처리는 뒤 조각 |
| `candidate` | 부르는 쪽 | 배정 후보 표시(권한 아님). 끊김 박자의 기억에 더하는 것은 `dispatch/link-loss.md`의 조건 |
| `withdrawn` | 부르는 쪽 | 그 연결의 주체가 후보에서 빠짐 |
| `forward` | 부르는 쪽 | `dispatch/receipts.ts`의 `handleForward` |

서버가 판단에 넣는 사건: 인증된 연결마다 `open`, 봉투마다 `check` → `envelope`, 답을 실은 뒤 `reply_sent`, `tick()`과 늦은 답마다 `tick`, 닫힘마다 `closed`, `applyRegistry`마다 `registry`.

## 정한 것

1. **답을 싣기 전에 받은 봉투는 닫는다.** 연결 판단은 받은 시각이 답을 실은 시각과 같은 hello를 소켓 사건의 순서에 맡긴다(`connections.ts`의 hello 주석). 이 서버는 답을 실을 때까지 받은 봉투의 수를 적어 두고, 그보다 먼저 받은 봉투가 답을 실은 뒤 차례가 오면 판단에 넘기지 않고 `before_reply`로 닫는다. 계약의 순서에서는 맞춤 요청 뒤 답을 받기 전에 실행기가 보낼 것이 없다(`src/executor/link.ts`).
2. **틀이 거절하면 같은 조각에서 앞서 자른 봉투와 대기열도 버린다.** 그 연결은 닫히므로 판단은 그 봉투들을 쓰지 않는다.
3. **늦은 답은 판단의 `tick`으로 다룬다.** `reply_sent`를 지어 넣지 않는다. `tick` 뒤에도 그 연결이 답을 기다리는 단계면 서버가 `reply_late`로 닫는다(판단은 그렇게 두지 않으므로 방어다).
4. **"실었다"는 열린 소켓의 `write`가 던지지 않고 받은 것이다.** 쓰기 버퍼가 차서 `false`를 돌려줘도 소켓이 받은 것이라 실은 것으로 센다. 전달 완료를 기다리지 않는다: 기다리면 `reply_sent`가 같은 동기 구간을 벗어나 위 1의 순서를 지킬 수 없다. 그 뒤 쓰기가 실패하면 소켓 오류로 닫히고 `closed`가 간다.
5. **판단이 던지면 닫는다.** 연결 하나의 사건(`envelope`, `reply_sent`, `closed`)이면 그 연결, `tick`·`registry`면 열린 연결 전부(`judgment_failed`). 결과를 모르는 판단을 쓰지 않는다.
6. **반쪽 닫힘(`end`)도 닫힘이다.** 상대가 보내기만 끝내도 그 자리에서 닫고 `closed`를 넣는다.

## 이 모듈에 없는 것

- 반쯤 열린 조용한 연결(상대가 FIN·RST 없이 사라짐)을 알아채 닫는 유휴 시간. 계약 v1에 살아 있음 확인 메시지가 없어 받은 바이트로만 재면 일 없는 실행기를 끊는다. 정책 인자 자리도 두지 않았다(뒤 조각).
- 재접속 빈도·주체별 요청 빈도·동시 처리의 제한. 연결 판단의 `maxConnections`·`reconnect`를 `settings`로 넘길 수 있을 뿐이고 기본은 둘 다 `null`(제한 없음)이다. 숫자는 설계와 계약에 없다.
- 복원기와의 묶음, 복원 전의 맞춤 거절, 인증서 교체 뒤 재인증, 세션 실행기의 연결.

## 뒤 조각이 지켜야 할 것

- **`restorer`는 박자에 넘기는 그 복원기 객체를 돌려준다.** 다시 복원하면 이 포트와 박자의 것을 함께 바꾼다. 후보는 `table().candidates(지금의 복원기)`로만 읽는다.
- **복원 1단계 전에는 그 복원기의 `stopGeneration()`이 `null`이어야 한다.** 그래야 판단이 맞춤에 답하지 않는다(계약 v1 "구현이 지킬 것").
- **`tick()`을 박자마다 부른다.** 이 서버에는 타이머가 없다. 부르지 않으면 hello 대기(`hello_late`)와 복원기가 바뀐 연결(`restore_changed`)이 다음 사건이 올 때까지 닫히지 않는다. 늦은 답을 싣지 않는 것은 `tick` 없이도 지켜진다.
- **재접속·빈도·동시 처리의 제한을 정한다(계약 v1 구현 인수 조건 2).** 숫자를 정하면 `settings`로 넘기고, 주체별 요청 빈도·동시 검증 수·연결마다 대기열의 상한은 새로 둔다.
- **반쯤 열린 연결의 감지를 정한다.** TCP keepalive나 계약의 확인 메시지와 유휴 시간을 정한 뒤 `closed`로 이어지게 한다.
- **`deliver`는 던지지 않는다.** 던지면 그 연결이 닫힌다. `forward`는 `handleForward`로, `occupancy`(`full`)는 `passHelloAnswer`로 잇는다.
- **서버를 새로 시작하면 연결 번호가 1부터다.** 연결 번호로 묶은 기다리는 조회·밀린 사본은 서버 객체와 함께 버린다.
- **`nonces`는 동시에 불려도 한 번만 성공한다.** `reply`의 요청 ID·nonce는 암호학적 난수이고 `seal`은 키를 내주지 않는다(계약 v1 구현 인수 조건 2).
- **키 유출 때의 순서(정지 → 폐기 판 → `registry().readout().revision` 대조 → 옛 연결 차단 확인 → 풀기)는 런북의 일이다.** 이 서버는 `applyRegistry`가 돌아오기 전에 믿지 않는 연결을 닫는다.

## 남는 한계

- 한 연결이 검증을 기다리는 동안 쌓이는 봉투 수에 상한이 없다. 인증된 실행기가 많이 보내면 메모리가 그 양을 따라 는다. 받은 시각을 지키려고 읽기를 멈추지 않는다(멈추면 받은 시각이 늦어진다).
- 받은 시각은 프로세스가 바이트를 읽은 시각이다. 커널·TLS 버퍼에 머문 시간과 이벤트 루프의 지연은 들지 않는다.
- 늦게 끝난 검증의 결과를 버리는 서버 쪽 가드를 지워도 효과는 같다(판단이 지운 행의 결과를 쓰지 않는다). 시험은 그 가드를 `late_dropped` 기록으로만 가른다.
- 등록표 바이트의 복사는 시험으로 가르지 못했다. 지금의 `apply`는 동기로 해석하고 바이트를 쥐지 않으므로 복사가 없어도 결과가 같다.
- `tls-server.ts`는 같은 시계를 감싸지 않고 부른다. 시계가 던지면 그 모듈의 연결 처리에서 예외가 난다(이 PR은 그 파일을 고치지 않는다).
- 연결 판단이 주체마다 맞춤 답을 서명한 가장 나중 연결 번호를 지우지 않고 쌓는다(등록된 주체 수로 묶인다). 연결 번호는 서버 객체가 사는 동안 늘기만 한다.
