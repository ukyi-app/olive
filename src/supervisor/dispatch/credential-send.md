# 자격 값 보내기 (`credential-send.ts`)

감독이 접수된 작업 시작마다 그 접수 영수증이 온 연결로 자격 값 틀(`src/transport/framing.ts`의 `encodeCredentialFrame`)을 한 번 보낸다. 모델 계정의 토큰 값이 감독 밖으로 나가는 유일한 길이다(D-95: 같은 상호 TLS 연결에 값만 담는 틀, 실행기는 서명된 시작 지시의 지문과 맞을 때만 쓴다). 소켓·시계·계정 파일·장부는 포트로만 닿고, 타이머와 난수를 쓰지 않는다. 연결에 쓰는 것은 감독 연결 서버의 `writeFrame` 하나다(`src/supervisor/transport/server.md` "틀 쓰기 면").

## 보장 넷

이 모듈이 주장하는 것은 아래 넷뿐이다. 시험은 `test/supervisor/dispatch/credential-send.test.ts`(가짜 서버·장부·계정 파일, 그리고 실제 서버의 루프백 하나)와 `test/supervisor/accounts/credential-borrow.test.ts`다.

1. **그 연결에서 검증되고 장부가 받은 접수 영수증(`receipt_accepted`, `instruction: "task_start"`)에만, (연결, 실행)마다 많아야 한 번 보낸다.** 장부의 결과가 `ack`·`applied_without_ack`가 아니거나, 영수증이 `receipt_accepted`가 아니거나, 접수한 지시가 `task_start`가 아니거나, 결과의 영수증 ID가 받은 봉투의 `receipt_id`와 다르면 기억도 읽기도 하지 않는다(`ignored`). (연결, 실행)의 기억에는 계정 파일을 읽기 **전에** 넣는다: 같은 연결의 두 영수증이 읽기를 기다리는 동안 겹쳐도 하나만 읽고 하나만 넘긴다. 그 연결이 지금 그 주체의 인정된 연결인지는 서버가 쓰기 앞에서 본다(아니면 넘긴 바이트 0).
2. **쓰기 바로 앞(`lastCheck`)에서, 계정 파일 읽기의 `await` 뒤에 바뀌었을 수 있는 것을 모두 다시 본다.** 정지 세대(읽기 앞에서 본 값과 같고 `null`이 아님), 접수(`intakeOpen() === true`), 장부 실행 줄(동기로 다시 읽어 지정 실행기가 이 주체, 작업자 실행, `preparing`, 접수 영수증 있음, 종료·정리 영수증과 결과 없음, 지문이 읽은 값의 지문과 같음), 시계와 작업 기한(지금 < `deadlineAt`). 하나라도 아니면 그 이름을 돌려주고 서버는 넘기지 않는다(넘긴 바이트 0). 연결의 인정은 서버가 `lastCheck` 앞뒤로 본다.
3. **값은 계정 파일을 다시 읽어 얻고, 실행 줄의 지문(`credential.digest`)과 같을 때만 보낸다.** 읽기는 `credential-ref.ts`의 `borrowCredentialValue` 하나이고, 참조를 만들 때와 같은 포트·같은 경로 규칙(그 계정 폴더 안의 그 방식의 키)으로 소속을 본다. 상한은 정책의 `maxBytes`이고, 그 값이 `CREDENTIAL_MAX_BYTES`(16,384)보다 크면 읽지 않는다(`limit_above_frame`).
4. **값과 틀 원문은 결과·관측·장부·재전송·예외 메시지에 없고, 넘긴 틀은 `settled` 뒤에 값과 틀을 0으로 채운다.** 넘기지 못한 길에서는 그 자리에서 채운다. 정리는 한 번 가드를 지나 한 번이다. 결과와 관측 타입에는 바이트 칸이 없다(정적 시험). 이 모듈은 던지지 않고 거절된 약속을 내지 않는다(포트가 던진 예외의 문구도 싣지 않는다).

## 공개 면

```ts
createCredentialSender(ports: CredentialSendPorts): CredentialSender

CredentialSender = {
  onReceipt(forward: ForwardInput["forward"], outcome: ReceiptOutcome): Promise<CredentialSendResult>
  forgetConnection(connection: number): void
}

CredentialSendPorts = {
  server: Pick<ConnectionServer, "writeFrame">         // 영수증이 온 그 서버 객체
  ledger: Pick<Ledger, "getRun">                        // handleForward가 쓴 그 장부 객체(동기 읽기)
  gate: Pick<Restorer, "stopGeneration" | "intakeOpen"> // 부르는 순간의 복원기
  clock: Clock                                          // 장부와 같은 시계
  files: CredentialFiles                                // 계정 파일 포트
  policy: CredentialRefPolicy                           // 계정 폴더 정책(maxBytes ≤ 16,384)
  observe?: (note: CredentialSendNote) => void          // 기록. 던져도 무시
}
```

| `CredentialSendResult` | 뜻 | 계정 파일 | 값 버퍼 |
|---|---|---|---|
| `ignored`(`reason`: `CREDENTIAL_SEND_IGNORED`) | 대상이 아니다 | 읽지 않음 | 없음 |
| `already_sent` | 이 (연결, 실행)은 이미 한 번 시도했다 | 읽지 않음 | 없음 |
| `blocked`(`reason`: `CREDENTIAL_SEND_BLOCKS`) | 읽기 앞의 확인에서 막혔다 | 읽지 않음 | 없음 |
| `unreadable`(`reason`: `CREDENTIAL_BORROW_REFUSALS`) | 값을 얻지 못했다(지문 불일치 `digest_mismatch` 포함) | 읽었을 수 있음 | `borrowCredentialValue`가 0으로 채움 |
| `frame_failed`(`reason`: 틀의 거절 이름) | 틀을 만들지 못했다 | 읽음 | 그 자리에서 0 |
| `not_written`(`reason`: 서버의 `NotWrittenReason` 또는 `write_threw`, `refusal`: `lastCheck`의 이름) | 넘긴 바이트 0 | 읽음 | 그 자리에서 0 |
| `written` | 틀 하나를 통째로 넘겼다. 상대가 받았다는 뜻이 아니다 | 읽음 | `settled`에서 0 |
| `unknown` | 서버의 `write`가 던졌다 | 읽음 | 서버가 돌아오기 전에 부른 `settled`에서 이미 0 |

`CredentialSendNote`는 둘이다: `attempt`(`connection`, `runId`, `outcome`: 결과의 `kind`, `reason`: 사유 이름이나 `null`), `wiped`(`connection`, `runId`, `at`: `settled`의 끝 `flushed`·`failed`·`closed`, 또는 `not_written`·`frame_failed`·`write_threw`). `ignored`는 기록하지 않는다.

## 차례

`onReceipt` 하나가 이 차례로 돈다. `await`는 3의 하나뿐이다(정적 시험이 파일의 `await`를 센다).

1. **고르기.** 장부의 결과와 forward에서 보낼 대상(연결, 주체 = 봉투 머리의 `sender`, 실행 ID)을 꺼낸다. 아니면 `ignored`.
2. **기억 → 읽기 앞의 확인.** `(연결, 실행)`이 기억에 있으면 `already_sent`. 없으면 **넣고**(`credential-send.ts`의 `runs.add`), 그다음 아래 "확인"을 기준 없이 한 번 돌려 정지 세대와 실행 줄의 지문을 기준으로 잡는다. 막히면 `blocked`(계정 파일을 열지 않는다).
3. **`await` 계정 파일 읽기.** `borrowCredentialValue(files, policy, 실행 줄의 credential)`. 거절이면 `unreadable`.
4. **틀 만들기.** `encodeCredentialFrame(실행 ID, 지문, 값)`. 실패(던짐 포함)면 값을 0으로 채우고 `frame_failed`.
5. **`writeFrame(연결, 주체, 틀, { lastCheck, settled })`.** 3과 5 사이에 다른 `await`가 없다. `lastCheck`는 아래 "확인"을 2의 기준과 함께 돌린다.
6. **정리.** `written`이면 `settled`에서, `not_written`이면 반환을 본 자리에서, `unknown`이면 이미 불린 `settled`에서 값과 틀을 0으로 채운다.

**확인**(읽기 앞과 `lastCheck`가 같은 함수를 쓴다. 차례도 같다):

1. 복원기의 `stopGeneration()`과 `intakeOpen()`. 던지면 `gate_failed`, 세대가 `null`이면 `stop_generation_unknown`, 기준과 다르면 `stop_generation_changed`, 접수가 `true`가 아니면 `intake_closed`.
2. 장부 `getRun(실행 ID)`(동기). 모름·던짐 `ledger_unavailable`, 없음 `run_unknown`, 지정 실행기가 다름 `not_assigned`, 세션 실행 `not_worker`, `preparing` 아님 `not_preparing`, 접수 영수증 없음 `not_accepted`, 종료·정리 영수증이나 결과가 있음 `run_ended`, 지문이 기준과 다름 `credential_changed`.
3. 시계. 던지거나 안전 정수가 아니면 `clock_failed`, 작업 기한 정각부터 `deadline_passed`. 시계를 마지막에 읽는다: 기한을 `write`에 가장 가까운 시각으로 본다.

## 0으로 채우는 자리

| 자리 | 채우는 것 | 언제 |
|---|---|---|
| `borrowCredentialValue`의 `finally` | 포트가 준 버퍼 | 빈 값, 상한 초과, 지문 불일치(빌려주지 않은 모든 길) |
| `frame_failed` | 값 | 틀을 만들지 못한 그 자리 |
| `settled` | 값과 틀 | 서버가 넘긴 틀의 끝을 알린 때(`flushed`·`failed`·`closed`) |
| `not_written` | 값과 틀 | 서버가 넘기지 않았다고 돌려준 그 자리 |
| `write_threw` | 값과 틀 | 서버가 계약 밖으로 던진 그 자리 |

다섯 자리 가운데 아래 셋은 한 번 가드(`wiped`)를 지난다. `unknown`은 서버가 돌아오기 전에 `settled`를 불렀으므로 반환을 보고 다시 정리하지 않는다. 지우는 것은 이 버퍼들뿐이다: 서버·런타임·TLS 안의 사본, 커널 버퍼, 해시 객체의 내부 상태는 지운다고 주장하지 않는다.

## 서버의 "뒤 조각이 지켜야 할 것"을 지키는 자리

| 조건(`server.md`) | 이 모듈 |
|---|---|
| `lastCheck`는 동기이고 기다리거나 서버를 다시 부르거나 복원 상태를 바꾸지 않는다 | `lastCheck`는 복원기의 두 읽기, 장부의 동기 읽기, 시계만 부른다. 서버 포트는 `writeFrame` 하나만 받는다 |
| 그 앞에서 본 값을 믿지 않는다 | 정지 세대·접수·실행 줄·시계를 `lastCheck`에서 다시 읽는다. 앞에서 본 것은 견줄 기준(세대, 지문)으로만 쓴다 |
| 자격 값은 접수된 그 연결·그 실행과 지금의 실행 상태를 `lastCheck`에서 본다 | 연결은 영수증이 온 `forward.connection`으로만 쓴다. 실행 줄은 `lastCheck`에서 다시 읽는다 |
| `recognized`의 번호는 후보를 고르는 데만 | `recognized`를 부르지 않는다. 실었는지는 `writeFrame`의 결과로 정한다 |
| 틀은 한 호출에 하나를 통째로 | 값 틀 하나를 한 번의 `writeFrame`으로 넘긴다 |
| 넘긴 틀과 값은 `settled` 뒤에만 0으로(`not_written`이면 그 자리에서), `unknown`은 다시 정리하지 않는다 | 위 "0으로 채우는 자리" |
| `settled`는 던지지 않게 | `settled`는 `fill`과 기록뿐이고 기록의 예외는 잡는다 |
| `written`은 접수가 아니다 | `written`을 장부·영수증에 기록하지 않는다. 결과로 돌려줄 뿐이다 |
| 결과를 구분해 옮긴다 | `not_written`의 서버 사유와 `refused`의 이름을 그대로 싣는다 |

## 정한 것

1. **공개 면은 `onReceipt(forward, outcome)`다.** 보낼 대상인지(장부가 받았는지, `receipt_accepted`·`task_start`인지, 결과와 봉투가 같은 영수증인지)를 이 모듈이 `handleForward`의 결과에서 직접 고른다. 조립은 모든 영수증 결과 뒤에 이 함수를 부르면 되고, 거르는 조건을 따로 지킬 필요가 없다.
2. **`delivery`가 `duplicate`여도 보낸다.** 같은 연결의 `duplicate`는 (연결, 실행) 기억이 막는다. 새 연결의 `duplicate`에 보낸 값은 실행기가 쓰지 않는다: 실행기는 그 실행을 받은 연결의 번호(`active.epoch`)가 지금 연결과 다르면 자격을 요청하기 앞뒤의 확인에서 띄우지 않는다(`src/executor/worker.ts`의 `launchBlocked`, `this.outlet.epoch() !== active.epoch`). 같은 실행의 시작이 다시 와도 새로 접수하지 않고 같은 영수증을 다시 보낼 뿐이다(`onStart`의 `resendFor`). 값은 같은 주체의 상호 TLS 연결로만 가고 실행기 쪽 받기가 쓰지 않은 값을 0으로 채운다. 그래서 `delivery`를 가르지 않는다.
3. **(연결, 실행)마다 한 번 시도한다.** 못 보냈어도(읽기 실패, `lastCheck` 거절, 서버가 넘기지 않음) 기억을 지우지 않는다. 같은 연결에서 같은 실행의 영수증이 다시 와도 다시 읽지 않는다.
4. **기억의 수명.** 메모리에만 둔다. `forgetConnection(연결)`이 그 연결의 기억을 통째로 지운다(연결이 `withdrawn`·닫힘일 때 조립이 부른다). 연결 번호는 서버 객체가 사는 동안 다시 쓰이지 않으므로 지운 번호의 영수증은 다시 오지 않는다. 서버를 새로 시작하면 번호가 1부터이므로 **이 객체를 서버 객체와 함께 새로 만든다**(조립의 책임, 아래). 감독이 다시 뜨면 기억과 연결이 함께 사라진다.
5. **revision은 대조하지 않는다.** 값의 정체는 지문이 정하고 실행기도 지문으로만 대조한다. 계정·방식으로 고른 파일의 소속은 `borrowCredentialValue`가 본다.
6. **관측의 이름.** `attempt`와 `wiped` 둘이고 사유 이름·연결 번호·실행 ID만 싣는다.

## 이 모듈에 없는 것

- 이 모듈을 부르는 곳(박자 순환기, 감독 진입점). 지금 `src/`에서 `createCredentialSender`를 부르는 곳은 없다.
- 실행기 쪽 받기(섞어 받는 디코더를 실행기 소켓에 붙이기, `CredentialSource.take`의 구현).
- 서버를 닫는 동안 새 발급을 막는 것(조립의 일, `server.md`).

## 뒤 조각이 지켜야 할 것

- **`handleForward`의 결과 뒤에 그 forward와 결과를 그대로 `onReceipt`에 넘긴다.** 같은 `deliver`의 `forward` 출력과 그 결과다. 결과를 바꾸거나 다른 forward와 섞지 않는다. 기다리지 않아도 된다(던지지 않고 거절된 약속을 내지 않는다).
- **`withdrawn`(그리고 서버가 연결을 닫은 때)에 `forgetConnection(연결)`을 부른다.** 부르지 않으면 기억이 연결 수만큼 남는다(정확성에는 영향이 없다: 번호를 다시 쓰지 않는다).
- **서버 객체를 새로 만들면 이 객체도 새로 만든다.** 옛 객체의 기억이 새 서버의 같은 번호를 막는다.
- **같은 장부 객체, 같은 시계, 같은 복원기 게시.** `ledger`는 `handleForward`가 쓴 장부 객체, `clock`은 장부와 같은 시계, `gate`는 서버의 `restorer` 포트가 돌려주는 그 복원기를 부르는 순간에 읽는 객체다.
- **계정 폴더 정책의 `maxBytes`는 16,384 이하.** 넘으면 이 모듈은 모든 실행에 `limit_above_frame`으로 보내지 않는다.
- **`observe`의 기록을 값과 섞지 않는다.** 기록은 이름과 번호뿐이지만, 기록하는 쪽이 결과·틀·값 객체를 함께 직렬화하지 않는다.

## 남는 한계

- **감독이 다시 뜨는 순간 막 시작하던 작업은 띄워지지 않는다.** 값을 보내기 전에 감독이 다시 뜨면 실행기는 연결이 바뀐 그 실행을 띄우지 않고(위 "정한 것" 2), 그 작업은 실패로 끝난다.
- **못 보낸 실행은 그 연결에서 다시 보내지 않는다.** 실행기는 값을 받지 못하고 그 실행은 실행기 쪽의 기한·임대로 끝난다.
- **`lastCheck`와 `write` 사이의 선점, 넘긴 뒤 망에서 늦는 것은 막지 못한다**(`server.md` "남는 한계"). 실행기는 받은 값을 쓰기 직전에 자기 쪽 상태를 다시 본다.
- **조용히 멈춘 연결에 넘긴 값 틀은 `settled`가 올 때까지 0으로 채워지지 않는다**(`server.md` "남는 한계"). 반쯤 열린 연결의 감지는 뒤 조각이다.
- `settled` 뒤에 런타임이 넘겨받은 바이트를 다시 읽지 않는지는 확인하지 않았다(`server.md`와 같다). 루프백 시험은 `settled` 뒤 0으로 채운 상태에서 상대가 같은 값을 받은 것을 본다.
