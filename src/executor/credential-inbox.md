# 자격 값 우편함 (`credential-inbox.ts`)

실행기 소켓이 받은 자격 값 틀을 그 실행의 작업자에게 한 번 넘기는 자리다. `CredentialSource`(`profile.ts`)의 구현이다. 소켓은 맞춘 지금 연결에서 받은 값만 넣고(`offer`), 작업자는 접수한 실행의 값을 한 번 꺼낸다(`take`). 값을 쓸지(지문이 바이트와 맞는지, 글로 바꿀 수 있는지)는 작업자가 정한다(`worker.ts`, `credentialMatches`·`credentialText`). 우편함은 머리 글(실행 ID·지문)과 연결 번호만 대조한다.

시계·난수를 쓰지 않는다. 연결 번호는 주입받은 함수로만 읽는다. 값과 실행 ID·지문은 `#` 비공개 필드에만 두어 우편함 객체의 `JSON.stringify`·`Object.keys`·`String()`에 나오지 않는다(시험).

## 공개 면

```ts
createCredentialInbox(options: { epoch: () => number | null }): CredentialInbox

CredentialInbox = CredentialSource & {
  take(runId, digest, signal): Promise<Uint8Array | null>   // CredentialSource
  offer(epoch: number, credential: DecodedCredential): "handed" | "held" | "discarded"
  dropEpoch(epoch: number): void
  forget(runId: string): void
}
```

- `epoch`는 `link.epoch()`다(맞춘 지금 연결의 번호, 없으면 `null`). 던지면 `null`로 본다. `offer`·`take`·`dropEpoch` 안에서만 부르므로 `ExecutorLink`를 우편함과 작업자보다 뒤에 만들어도 된다.
- `offer`가 받은 `DecodedCredential.value`의 소유는 우편함으로 넘어온다. 부른 쪽은 그 배열을 다시 쓰지 않는다. 돌려준 이름은 값을 싣지 않는다.
- `forget`은 `CredentialSource`의 선택 메서드다. 작업자가 실행이 끝날 때마다 부른다.

## 규칙

칸은 하나다. 칸의 값은 받은 연결 번호와 함께 둔다. **실행 ID, 지문(`take`의 지문과 값 틀의 지문 글), 연결 번호(값을 받은 연결, `take`를 부른 때의 연결, 지금 연결) 셋이 모두 같을 때만 내주고**, 내준 뒤에는 칸을 비운다.

| 때 | 하는 일 |
|---|---|
| `offer`: 그 실행이 이미 끝남(내줬음, `take`가 중단·`null`로 끝남, `forget`) | 버린다 |
| `offer`: 받은 연결 번호가 지금 연결의 번호가 아님(옛 연결, 맞춘 연결 없음) | 버린다 |
| `offer`: 기다리는 `take`가 있고 셋이 맞음 | 내준다(`handed`) |
| `offer`: 기다리는 `take`가 있고 다른 실행이거나 지문·연결이 다름 | 버리고, 그 `take`는 계속 기다린다 |
| `offer`: 기다리는 `take`가 없고 칸에 같은 연결·같은 실행의 값이 있음 | 새 값을 버린다(먼저 온 것을 둔다) |
| `offer`: 기다리는 `take`가 없고 그 밖 | 칸의 앞 값을 버리고 새 값을 둔다(`held`) |
| `take`: 칸의 값과 셋이 맞음 | 곧바로 내준다 |
| `take`: 칸에 맞지 않는 값이 있음 | 그 값을 버리고 기다린다 |
| `take`: 이미 중단된 `signal`, 맞춘 연결 없음 | `null`. 그 실행은 끝난 것으로 본다 |
| `take`: 다른 `take`가 기다리는 중 | 뒤 `take`는 곧바로 `null`. 앞 `take`와 칸은 그대로 |
| `take`: 이미 끝난 실행 | `null` |
| `signal` 중단 | 기다리던 `take`는 `null`. 그 실행의 칸 값과 내준 값을 0으로 채운다 |
| `dropEpoch(e)` | 연결 `e`에서 받은 칸 값을 버린다. 연결 `e`에서 기다리던 `take`는 `null`, 그 `take`에 내준 값은 0으로 채운다 |
| `forget(runId)` | 그 실행의 기다림을 `null`로 끝내고 칸 값과 내준 값을 0으로 채운다 |

"버린다"는 늘 그 배열을 0으로 채운 뒤 놓는다.

## 0으로 채우는 자리

| 자리 | 파일 |
|---|---|
| 섞어 받는 디코더가 거절과 함께 돌려준 앞선 정상 값 | `socket.ts` `Wire.take`(거절 step), `Wire.follow`의 끝 알림 |
| 맞추기 전·지금 연결이 아님·연결 번호가 다름 | `socket.ts` `Socket.offer` |
| 같은 step에서 닫힘 이유가 된 값 틀 뒤의 값 | `socket.ts` `Wire.take` |
| 연결의 끝(교체·상대의 끝·`stop` 포함): 그 연결의 칸 값, 그 연결의 `take`에 내준 값 | `Socket.shut` → `dropEpoch` |
| `take`의 `signal` 중단, 중단 뒤 늦게 온 값 | `#closeRun`, `offer`의 첫 검사 |
| 다른 실행의 값이 새로 옴(칸의 앞 값), 같은 실행의 둘째 값, 맞지 않는 값 | `offer`, `take` |
| 실행의 끝 | `worker.ts`의 `finish` → `forget` |
| 작업자가 대조·변환을 마친 뒤(띄우든 띄우지 않든) | `worker.ts` `execute`의 `finally` |

## 정한 것과 까닭

- **같은 실행의 둘째 값은 버린다.** 감독은 한 실행에 값을 한 번 보낸다. 먼저 온 값이 칸에 있으면 새 값을 버리고, 이미 내줬으면 그 실행의 값은 더 받지 않는다. 다만 먼저 온 값의 지문이 `take`와 다르면 그 값은 `take`가 버리고 그 뒤 첫 일치를 기다린다.
- **기다리는 `take`가 있을 때 다른 실행의 값은 칸에 두지 않고 버린다.** 실행 슬롯이 하나라(`worker.ts`의 `refusesStart`) 한 실행이 값을 기다리는 동안 다른 실행은 접수되지 않았다. 감독은 접수 영수증을 받은 뒤에만 값을 보내므로 그 값은 쓰일 곳이 없다.
- **둘째 `take`는 곧바로 `null`이다.** 슬롯이 하나인 작업자에서는 생기지 않는다. 생기면 배선의 잘못이므로 앞 `take`를 흔들지 않고 뒤 것만 거절한다.
- **값을 더 받지 않는 실행은 마지막 하나만 기억한다.** 기억이 끝없이 자라지 않게 한다. 그보다 앞 실행의 늦은 값은 칸에 들어가 다음 값, 다음 `take`, 그 연결의 끝 가운데 먼저 오는 때에 버려진다.
- **내준 배열도 기억해 두었다가 중단·연결의 끝·`forget`·다음 `take`에 0으로 채운다.** 작업자는 `abortable`로 기다리므로, 우편함이 값을 내준 직후 같은 차례의 다른 일이 `signal`을 끊으면 작업자는 그 값을 받지 못한 채 넘어간다. 그 배열이 0으로 채워지지 않고 남지 않게 한다. 작업자는 받은 뒤 `await` 없이 대조·변환을 마치고 그 배열을 0으로 채우므로, 이 늦은 0 채우기가 쓰는 중인 값을 지우지 않는다.
- **연결 번호를 우편함도 대조한다.** 소켓이 이미 맞춘 지금 연결에서만 넘기지만, 칸에 둔 동안 연결이 바뀌었는지는 `take`의 때에 다시 본다. 작업자는 그 실행을 접수한 연결이 지금 연결일 때만 `take`를 부르므로(`launchBlocked`), `take`를 부른 때의 연결 번호가 그 실행의 연결이다.
- **`forget`은 선택 메서드다.** 값을 쥐지 않는 `CredentialSource`(시험의 가짜)는 할 일이 없다. 우편함은 `forget`이 불리지 않아도 다음 `take`에서 앞 실행의 기록을 치우므로 다음 실행을 막지 않는다.

## 남는 한계

- **작업자가 만든 JavaScript 문자열(환경 변수 값)과 TLS 구현 안의 사본은 0으로 채울 수 없다.** 0으로 채우는 것은 이 우편함과 소켓, 작업자가 쥔 `Uint8Array`뿐이다.
- **값 틀에는 서명·시한·nonce가 없다.** 보낸 쪽은 상호 TLS의 신원이, 쓸 값은 서명된 시작 지시의 지문 대조(`worker.ts`)가 정한다.
- **값은 같은 연결에서 그보다 앞에 받은 봉투의 처리를 기다리지 않는다**(`socket.md`). 감독이 값을 보내기 전에 보낸 취소가 아직 줄에 있으면, 기다리던 `take`가 먼저 값을 받을 수 있다. 그 실행은 취소가 처리될 때 끝난다.

## 뒤 조각이 지켜야 할 것

- **진입점은 우편함 하나를 만들어 소켓(`inbox`)과 작업자(`credentials`)에 함께 넘기고, `epoch`에 같은 `ExecutorLink`의 `epoch()`를 준다.** 둘이 다른 우편함이면 소켓이 넣은 값을 작업자가 꺼내지 못한다.
- **감독은 맞춘 뒤 그 실행의 접수 영수증을 받은 연결에서만, 그 실행에 한 번 값을 보낸다.** 맞추기 전에 보내면 실행기가 그 연결을 닫는다(`credential_not_synced`).

## 시험

`test/executor/credential-inbox.test.ts`(값이 먼저·나중, 다른 실행·다른 지문·옛 연결 번호·맞춘 연결 없음의 값은 내준 수 0이고 0으로 채움, 중단 뒤 늦은 값과 이미 중단된 `signal`, 내준 뒤 중단, 같은 실행의 두 값, 다른 실행의 값이 칸을 바꿈, 연결의 끝, `forget`, 둘째 `take`, 직렬화), `test/executor/socket.test.ts`의 "자격 값" 넷, `test/executor/worker.test.ts`의 "자격"(띄운 실행, 지문이 다른 실행, 받은 직후 연결이 끊긴 실행 모두 받은 배열이 0이고 `forget`이 한 번).
