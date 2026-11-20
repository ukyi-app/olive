# 실행기가 감독에 붙는 소켓 (`socket.ts`)

실행기 쪽 연결의 조립이다. `tls-client.ts`로 감독에 붙고(실행기가 먼저 붙고 듣지 않는다, D-55), `framing.ts`의 틀로 바이트를 자르고 이어, `link.ts`의 `ExecutorLink`에 연결마다 `Transport` 하나로 넘긴다. 끊기면 정책의 간격을 두고 다시 붙는다. 연결의 판단(맞춤, challenge, 정지 세대, `hello`, 재전송)은 `link.ts`·`worker.ts`의 것을 부르고 여기서 다시 만들지 않는다.

소켓과 TLS는 `tls-client.ts`가 연 것만 쓴다. 이 파일은 `node:tls`·`node:net`을 import하지 않는다(`test/executor/static.test.ts`). 타이머와 난수는 주입받는다. 밖으로 던지지 않고 결과는 구별된 사건으로만 알린다. 기록 콜백(`onEvent`)은 기다리지 않고, 그 실패(던짐, 돌려준 약속의 거절)는 무시된다.

## 공개 면

```ts
createExecutorSocket(options: ExecutorSocketOptions): CreateSocketResult

ExecutorSocketOptions = {
  client: Pick<TlsClient, "connect">                  // tls-client.ts. 재료·주소는 부르는 쪽이 만들 때 넣는다
  link: Pick<ExecutorLink, "open" | "isCurrent">      // 이 소켓 하나만 이 link에 연결을 연다
  policy: ReconnectPolicy
  receive: ReceivePolicy
  timer: { set(callback, ms): unknown; clear(handle): void }
  random: () => number                                 // [0, 1). 밖의 값이나 던짐은 0(덜지 않음)으로 본다
  onEvent?: (event: SocketEvent) => void               // 기록용. 기다리지 않는다. 던짐과 돌려준 약속의 거절은 무시한다
}
ReconnectPolicy = {
  initialDelayMs: number   // 1 이상의 정수
  maxDelayMs: number       // initialDelayMs 이상, 2_147_483_647 이하의 정수
  multiplier: number       // 1 이상의 유한수
  jitterRatio: number      // 0 이상 1 미만
}
ReceivePolicy = {
  maxQueuedBytes: number   // 처리를 기다리는 받은 틀 바이트(접두 포함)의 상한. 65,540 이상의 정수
}
CreateSocketResult = { ok: true, socket: ExecutorSocket } | { ok: false, reason: "policy_rejected" }

ExecutorSocket = {
  start(): void            // 처음 한 번만 붙기 시작한다
  stop(): Promise<void>    // 더 붙지 않고, 붙는 중이면 거두고, 열린 소켓을 닫는다. 몇 번째 호출이든 받은 모든 소켓의 close 뒤에 돌아온다
  phase(): "idle" | "connecting" | "open" | "waiting" | "stopped"
}
```

`maxQueuedBytes`의 하한 65,540은 틀 하나의 최대 크기(접두 4바이트 + 계약 v1의 `MAX_MESSAGE_BYTES` 65,536)다. 그보다 작으면 처리 중에 온 정상 틀 하나만으로 연결이 닫힌다. 하한 밖의 값과 정수가 아닌 값은 `policy_rejected`다. 기본값은 없다.

| 사건 (`SocketEvent`) | 뜻 |
|---|---|
| `connecting` + `attempt` | 붙기를 시작했다. `attempt`는 1부터 붙기마다 하나씩 는다 |
| `connected` + `attempt` | 감독 인증서를 확인한 연결을 받아 `link.open`에 넘긴다. 감독이 이 실행기를 받아들였다는 뜻은 아니다(`tls-client.ts` 머리말) |
| `connect_failed` + `attempt`, `reason` | `TlsConnectError`의 `kind`(`no_material`·`peer_rejected`·`tls_error`·`aborted`) 또는 `threw`. 돌려받은 소켓이 이미 끊겼으면 `tls_error`다 |
| `synced` + `attempt` | 그 연결의 맞춤이 끝났다(`link`의 `Connection.state === "synced"`). 다음 다시 붙기의 기준값은 처음 간격이다 |
| `closed` + `attempt`, `reason` | 그 연결이 끝났다. 아래 표 |
| `retry_scheduled` + `delayMs` | 다시 붙기를 걸었다 |
| `retry_unavailable` | 타이머가 던졌다. 기다림 없이 붙지 않으려고 더 붙지 않는다(`phase`는 `waiting`으로 남는다) |
| `stopped` | `stop`이 불렸다 |

| 닫힌 이유 (`CloseReason`) | 뜻 |
|---|---|
| `peer_ended` | 상대가 틀의 경계에서 끝을 알렸다 |
| `socket_error`, `socket_closed` | 소켓의 error·close 사건, 또는 쓰기가 던졌다 |
| `link_closed` | `link`가 그 연결을 닫았다(맞춤 기한, 세대 불일치, 세대 저장 실패, `hello` 보류 등. 이유는 `link`·`worker`가 안다) |
| `open_failed` | `link.open`이 던졌다 |
| `encode_failed` | 보낼 봉투를 정규 직렬화(`canonicalJson`)나 틀로 만들지 못했다 |
| `receive_failed` | 받은 프레임의 처리(`Connection.receive`)가 던졌다. 그 지시의 결과를 모르므로 새 연결에서 다시 맞춘다 |
| `receive_backlog` | 처리를 기다리는 받은 틀의 바이트가 `maxQueuedBytes`를 넘었다 |
| `stopped` | `stop`이 닫았다 |
| `framing.ts`의 거절 이름 | 틀이 거절했다(`frame_empty`·`frame_too_large`·`frame_truncated`·`frame_bad_utf8`·`frame_not_json`·`frame_duplicate_key`·`frame_too_deep`·`frame_after_end`) |

## 보장

### 1. `Transport` 포트의 꼴 그대로, 순서를 지켜 싣고 받는다

- **연결마다 `Wire` 하나가 `Transport`다.** `send`는 봉투를 `canonicalJson` → UTF-8 → `encodeFrame`으로 만들어 그 연결의 소켓에만 쓴다. 판단이 부른 차례가 곧 쓰는 차례다(동기 쓰기, 소켓 스트림이 차례를 지킨다). `close`는 그 연결을 닫는다. 둘 다 던지지 않는다. 만들지 못한 봉투는 그 연결을 닫는다(`encode_failed`).
- **받은 바이트는 연결마다 디코더 하나를 거쳐 프레임 단위로, 받은 순서대로 하나씩 넘긴다.** 앞 프레임의 `receive`가 끝난 뒤에 다음 것을 넘긴다. `receive`는 검증(nonce I/O)과 저장을 기다리므로 겹쳐 부르면 뒤 프레임이 먼저 처리될 수 있다.
- **처리를 기다리는 동안에도 소켓 읽기를 멈추지 않는다.** 멈추면 읽지 않은 바이트 뒤에 있는 상대의 끝 알림이 앞 처리가 풀릴 때까지 오지 않는다. 대신 받았지만 아직 넘기지 않은 틀의 바이트(접두 포함)를 세어 `maxQueuedBytes`를 넘으면 그 연결만 닫는다(`receive_backlog`, 그 줄의 틀은 판단에 닿지 않는다). 연결 하나가 쥐는 받은 바이트는 이 상한, 디코더가 쥐는 미완성 틀(65,540바이트 이하, `framing.ts`), 마지막으로 받은 조각 하나를 더한 만큼이다.
- **틀이 거절한 바이트는 판단에 닿지 않고 그 연결을 닫는다.** 거절이 나온 `push`의 앞쪽 온전한 틀도 넘기지 않는다. 그 연결이 닫히면 `link`도 그 연결의 것을 받지 않으므로 넘겨도 쓰이지 않는다. 거절한 디코더는 다시 동기화하지 않는다(`framing.ts`).
- 시험: `socket.test.ts`의 "싣고 받기" 둘(틀의 경계와 무관하게 셋으로 잘라 쓴 세 프레임이 그 차례로 닿고 답도 그 차례, 동시 처리 1개, 중복 키 틀이 닿지 않고 `frame_duplicate_key`로 닫힘), "받기"(처리를 붙든 채 상한을 넘기면 `receive_backlog`로 그 연결만 닫히고 넘친 틀은 닿지 않음).

### 2. 새 연결이면 앞 연결의 것을 버린다

- **연결마다 `link.open`을 한 번 부른다.** 그래서 `link`가 연결마다 새 challenge를 만들고 앞 연결을 닫는다(`link.ts`의 `open`).
- **소켓이 끝나면 그 순간 그 연결의 `Connection.close()`를 부른다.** 앞 프레임의 처리가 멈춰 있어도 읽기를 멈추지 않으므로 상대의 끝(닫기·오류)을 그때 알아채고 다시 붙기를 건다. 기다리는 challenge와 세대 저장 대기는 이때 버려지고, 다시 붙기를 기다리는 동안 남지 않는다.
- **끝난 연결의 아직 처리하지 않은 프레임은 버린다.** 그 연결로는 답을 보낼 수 없다. 끝날 때 이미 처리 중이던 `receive`는 거둘 수 없지만, 늦게 풀려도 `link`가 지금 연결이 아니라며 버리고(`link.ts`의 `isCurrent` 재확인) 이 소켓도 그 결과로 간격을 되돌리지 않는다. 새 연결의 소켓에 쓰지 않고, 새 연결의 맞춤 상태와 걸어 둔 다시 붙기를 바꾸지 않는다.
- **늦은 결과는 그 연결의 것으로만 남는다.** `Wire`는 자기 소켓에만 쓰므로 앞 연결의 `Connection`이 늦게 보내도 새 소켓에 실리지 않고, 닫힌 `Wire`의 보내기는 버린다. 멈춘 뒤나 다른 붙기로 넘어간 뒤에 끝난 붙기의 소켓은 `link`에 열지 않고 닫는다.
- 시험: "새 연결" 둘(앞 연결의 맞춤 답 처리를 붙든 채 끊으면 그 순간 대기값이 `null`, 그 연결에 남은 지시는 닿지 않음, 새 challenge가 다름, 늦게 끝난 앞 처리로 `live`가 되지 않음, 앞 challenge의 답은 새 연결에서 맞춤이 안 됨 / 맞춘 연결에서 조회의 nonce 처리를 붙든 채 감독이 따로 쓴 둘째 조회 뒤 닫으면 앞 처리를 풀기 전에 `peer_ended`와 다시 붙기가 걸리고 감독이 새 맞춤 요청을 받음, 그 뒤 앞 처리를 풀어도 사건·예약·새 연결의 상태·대기값·감독이 받은 것이 그대로), "멈춤"의 붙는 중 사례.

### 3. 다시 붙기에는 상한과 지연이 있다

- **처음 붙기만 바로 한다.** 그 뒤의 붙기는 모두 타이머가 부른 뒤다.
- **간격의 기준값은 점화식으로 는다.** 첫 기준값은 `initialDelayMs`이고, 다시 붙기를 걸 때마다 다음 기준값을 `min(maxDelayMs, ceil(직전 기준값 × multiplier))`로 만든다. 매번 직전 기준값에 곱하고 올리므로 `initialDelayMs × multiplier^n`을 한 번 올린 값과 다를 수 있다(처음 2, 배율 1.25, 상한 12, 덜기 0이면 2·3·4·5ms다). 걸어 두는 간격은 그 기준값에서 `기준값 × jitterRatio × random()`을 덜고 반올림한 값이며 1ms 이상이다.
- **맞춤을 끝낸 연결 뒤에만 기준값이 처음 간격으로 돌아간다.** 그래서 맞춘 연결이 끊긴 뒤의 첫 예약은 **덜기 전 기준값**이 `initialDelayMs`이고, `jitterRatio`가 0보다 크면 그보다 짧을 수 있다(처음 1,000ms, 덜기 비율·난수 각 0.5면 750ms). TLS는 붙었지만 맞추지 못한 연결(감독이 받지 않아 TLS 1.3에서 붙은 뒤에 끊긴 연결, 맞춤 기한이 지난 연결)은 실패로 세어 기준값이 는다.
- **맞춤 처리 안에서 닫히면 맞춘 연결로 세지 않는다.** 기준값은 받은 프레임의 `receive`가 끝난 뒤에 되돌린다. `link`가 맞춘 바로 그 `receive` 안에서 동기로 싣는 `hello`와 받음 확인 못 받은 영수증의 재전송(`worker.ts`의 `resendUnacked`)이 봉투를 만들지 못해 `encode_failed`로 닫으면, 기준값을 되돌리기 전에 그 연결은 이미 닫혀 있다. `synced` 사건은 없고 기준값은 실패처럼 는다.
- **멈추면 더 붙지 않는다.** 걸어 둔 기다림을 거두고, 타이머가 늦게 불러도 붙지 않고, 붙는 중이면 `AbortSignal`로 거두고, 열린 소켓을 닫는다(`link`의 그 연결도 닫힌다). `stop`은 몇 번째 호출이든 진행 중인 붙기가 끝나고, 이 소켓이 받은 모든 소켓(열린 연결, `link`나 상대의 끝으로 이미 닫는 중인 연결, 멈춘 뒤 늦게 돌아와 닫은 소켓)의 `close` 뒤에 돌아온다. 늦게 돌아온 소켓으로 `link.open`을 부르지 않는다. `stop` 뒤의 `start`는 아무 일도 하지 않는다.
- **간격과 받아 둘 양의 숫자는 기본값이 없다.** 실측 전이라 부르는 쪽이 정책으로 넘긴다. 범위 밖이면 `policy_rejected`이고 소켓을 만들지 않는다.
- 시험: "다시 붙기" 둘(100·200·400·400, 덜기 750, 범위 밖 난수는 덜지 않음, 맞춘 연결 뒤에만 처음으로: 100·200·100), "닫기"(link가 닫은 뒤와 처리가 던진 뒤에도 간격을 둠), "멈춤" 넷(열린 중·기다리는 중·붙는 중, 연달아 부른 둘째 `stop`, `link`가 먼저 닫은 직후의 `stop`, 멈춘 뒤 늦게 돌아온 소켓: 셋 다 `stop`이 돌아올 때 `openConnections()`가 0), "정책".

## 계약 v1 "구현이 지킬 것"에서 이 소켓의 몫

- **연결마다 새 128비트 이상 challenge:** `link.ts`의 몫이다(`open`마다 `challenge()`, 기본 `randomBytes(16)`). 이 소켓의 몫은 인증된 연결마다 `link.open`을 정확히 한 번 부르는 것이다.
- **기다리는 challenge를 버리는 때 셋:** (1) 25초 기한은 `link.ts`(`tick`과 받는 순간의 `expireIfDue`)의 몫이고 `tick`을 주기로 부르는 것은 진입점의 몫이다(아래 "뒤 조각이 지켜야 할 것"). (2) 연결이 끝남은 **이 소켓의 몫이다**: 소켓의 끝을 그 순간 `Connection.close()`로 알린다. (3) 맞춤 성공은 `link.ts`의 몫이다.
- **새 정지 세대 적용(원자적, 단조 증가 재확인):** `worker.ts`(`adopt`·`syncTo`)와 `store.ts`(`adoptStopGeneration`)의 몫이다. 이 소켓은 받은 프레임을 겹치지 않고 받은 차례로 넘길 뿐, 세대를 읽거나 적지 않는다.

## 남는 한계

- **반쯤 열린 연결은 알아채지 못한다.** 상대가 사라졌는데 소켓이 끝을 알리지 않으면 그 연결은 열린 채 남는다. 맞춤 전이면 `link.tick`의 맞춤 기한이 닫지만, 맞춘 뒤의 조용한 연결을 닫는 방법(keepalive, 받음 기한)과 시간은 정하지 않았다.
- **처리가 멈추면 그 연결의 뒤 프레임은 넘기지 않는다.** 상대의 끝은 알아채고, 상대가 더 보내 줄이 상한을 넘으면 닫는다. 하지만 상대가 연결을 연 채 더 보내지 않으면 멈춘 처리에는 기한이 없다. 세대 저장의 멈춤만 `link`의 상한이 닫는다. 끝을 알아챈 뒤에도 멈춘 `receive`의 약속은 남아 그 연결의 객체를 쥐고 있다.
- **쓰기 버퍼에 상한이 없다.** 상대가 읽지 않으면 실은 바이트가 메모리에 쌓인다. 실행기가 내는 양은 영수증·보고·답으로 묶이지만 바이트 상한은 두지 않았다.
- **보낼 수 없는 봉투가 되풀이되면 맞춤마다 닫힌다.** 그 봉투가 재전송 대상이면 연결마다 맞춤 → 재전송 → `encode_failed`가 되풀이된다. 맞춤 처리 안에서 닫히므로 기준값이 되돌아가지 않고, 간격은 실패처럼 늘어 `maxDelayMs`까지 간다. 계약의 크기 상한 안의 봉투면 생기지 않는다.
- **`no_material`도 간격을 두고 계속 다시 붙는다.** `TlsClient`의 재료는 만들 때 한 번 받으므로 재료가 만료되면 새 클라이언트를 만들기 전까지 실패가 되풀이된다(상한 간격으로).
- **감독 인증서의 만료(`peerNotAfter`) 전에 다시 붙지 않는다.** 아래 "이 PR에 없는 것".

## 이 PR에 없는 것

실행기 진입점과 기동 순서(저장소 열기 → 프로필·키 → 기동 대조 → `recover` → 연결), 자격의 값을 받는 일, 인증서 재료가 바뀐 뒤의 재인증과 `peerNotAfter` 전 재연결, 감독 쪽 서버 조립, `link.tick`·`worker.tick`을 주기로 부르는 일, 반쯤 열린 연결의 감지, 쓰기 버퍼의 상한, 간격과 받아 둘 양의 운영 값.

## 뒤 조각이 지켜야 할 것

- **진입점이 저장소·프로필·키·기동 대조·복구(`recover`)를 마친 뒤 한 `ExecutorLink`에 소켓 하나만 붙인다.** 둘이 같은 `link`에 열면 서로의 연결을 닫는다.
- **진입점이 `link.tick()`과 `worker.tick()`을 주기로 부른다.** 25초 맞춤 기한과 세대 저장 대기는 `link`가 처리한다. `link.tick`을 부르지 않으면 감독이 맞춤에 답하지 않는 연결이 기한 뒤에도 닫히지 않아(받는 프레임이 없으면 `expireIfDue`가 돌지 않는다) 다시 붙지 않는다. 맞춘 뒤 일반 조회의 처리가 멈추는 것에는 이 tick이 기한을 주지 않는다.
- **진입점이 `TlsClient`를 만들고 그 재료 오류를 처리하고, 끝낼 때 `stop()`을 기다린 뒤 클라이언트를 닫는다.** `createTlsClient`는 재료가 틀리면 던진다(`TlsMaterialError`). 이 소켓은 `connect`만 부르고 클라이언트를 닫지 않는다. `stop()`이 돌아오면 이 소켓이 받은 소켓의 `close`는 모두 끝났다.
- **`onEvent`는 기록만 한다.** 그 안에서 `start`·`stop`이나 `link`를 부르지 않는다. 이 소켓은 기록을 기다리지 않고 그 실패(던짐, 돌려준 약속의 거절)를 무시하므로, 비동기 기록의 실패를 알아야 하면 콜백 안에서 스스로 처리한다.
- **정책의 숫자는 임시값으로 진입점이 주입한다.** 다시 붙기의 간격(`ReconnectPolicy`)과 받아 둘 양의 상한(`ReceivePolicy.maxQueuedBytes`, 65,540 이상) 모두 기본값이 없다. 간격은 감독의 재접속 제한(`connections.ts`의 `reconnect`, 미확정)과 함께 정하고, 처음 간격은 0이 될 수 없다.
- **타이머는 실제 시간이 지난 뒤 콜백을 부르고 난수는 [0, 1)이다.** 타이머가 콜백을 동기로 부르면 기다림 없이 붙는다.
- **후속 설계 범위로 남는다:** 반쯤 열린 연결의 감지, 감독 인증서 만료 전 재연결, 쓰기 버퍼의 상한. 실제 네트워크의 지연·손실, 장기 메모리 사용량, 운영 정책값은 **미확인**이다.
