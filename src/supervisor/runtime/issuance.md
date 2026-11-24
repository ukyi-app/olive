# 발급 문과 종료 차례 (`issuance.ts`)

자격 값 보내기(`dispatch/credential-send.ts`)를 같은 서버·장부·시계로 한 번 만들어 답 줄(`answers.ts`)에 잇고, 순서기의 발급 깃발(`cycle.ts`의 `issuanceOpen`)을 내보내기 포트(`sink.ts`)와 자격 값 보내기의 마지막 확인(`lastCheck`)에 잇고, 감독의 종료를 "발급 닫기 → 서버 닫기" 차례로 하는 조립 하나다. 시계·난수·타이머·소켓을 직접 쓰지 않는다. 이것을 부르는 곳(감독 진입점, N5)은 아직 없다.

## 공개 면

```ts
createIssuance(ports: IssuancePorts): Issuance

Issuance = {
  issuanceOpen: () => boolean     // 내보내기 포트의 issuanceOpen 칸에
  credentials: AnswerCredentials  // 답 줄의 credentials 칸에
  shutdown(): Promise<void>       // closeIssuance() → server.close()
}

IssuancePorts = {
  cycle: Pick<Cycle, "issuanceOpen" | "closeIssuance">  // 박자들과 같은 순서기
  server: Pick<ConnectionServer, "writeFrame" | "close"> // 영수증이 온 그 연결 서버
  restorer: () => 복원기                                  // 서버·내보내기 포트·답 줄과 같은 게시 함수
  ledger: Pick<Ledger, "getRun">                          // 답 줄의 handleForward가 쓴 그 장부 객체
  clock: Clock                                            // 장부와 같은 공유 시계
  files, policy                                           // 계정 파일 포트, 계정 폴더 정책(maxBytes ≤ 16,384)
  observe?: (IssuanceNote) => void                        // 동기 기록기. 던져도 무시
}
```

`IssuanceNote`는 셋이다: `credential`(송신기의 `attempt`·`wiped` 기록 그대로. 이름·연결 번호·실행 ID뿐), `credential_rejected`(송신기가 계약 밖으로 거절된 약속을 냈다), `shutdown`(`issuance_closed`, `server_closed`, `server_close_failed`).

## 잇기의 차례

1. 서버가 영수증 `forward`를 답 줄의 `deliver`로 넘긴다.
2. 답 줄의 `passReceipt`가 `handleForward`를 부른다(장부 쓰기).
3. 결과가 장부가 받아들인 것(`ack`·`applied_without_ack`. 장부의 `delivery`가 `new`든 `duplicate`든)이면 **기록보다 먼저** 같은 `forward`와 결과를 `credentials.onReceipt`에 넘긴다(`answers.ts:277`~`:283`). 거절·실패한 영수증은 넘기지 않는다.
4. `credentials.onReceipt`는 송신기의 `onReceipt`를 부르고 기다리지 않는다. 송신기가 `receipt_accepted`·`task_start`인지, (연결, 실행)마다 처음인지를 고르고, 계정 파일을 읽은 뒤 그 연결로 값 틀 하나를 쓴다. 결과는 `attempt` 기록으로 남는다.

**횟수의 보장:** 장부가 받아들인 접수 영수증마다 `onReceipt`를 부른다. 같은 본문을 같은 연결로 두 번 받으면 `onReceipt`도 두 번이다. 계정 읽기와 값 틀 송신은 (연결, 실행)마다 각각 최대 1회다(송신기가 두 번째를 `already_sent`로 막는다). 훅을 영수증마다 1회로 줄이지 않는 이유: 새 연결에 처음 온 `duplicate`(재접속 뒤의 재전송)까지 빼면 그 연결에서 값을 받을 기회가 없어진다.
5. 결과가 `ack`이면 답 줄이 ack를 봉해 내보내기 포트의 `writeAck`로 그 연결에 쓴다. 값 틀은 계정 파일 읽기(기다림) 뒤라 실제로는 ack 뒤에 나간다.
6. 연결이 철회되면(서버가 인사를 마친 연결을 닫을 때도 `withdrawn`이 온다) 답 줄이 등록부 정리보다 먼저 `credentials.forgetConnection`을 부른다(`answers.ts:533`~`:540`, 이 파일의 `credentials.forgetConnection`).

## 발급 깃발이 닿는 자리

| 발급 | 깃발을 보는 곳 | 깃발 뒤의 결과 |
|---|---|---|
| 지시(박자 넷의 `sink.send`) | 내보내기 포트 `lastCheck`의 맨 앞(`sink.ts:263`~`:270`) | 서버가 넘기지 않음(`refused`), 박자에는 `no_connection`, 기록은 `issuance_closed` |
| ack(`writeAck`) | 같은 자리 | `no_connection`, 기록은 `issuance_closed` |
| 자격 값 | 송신기 복원기 문의 `intakeOpen`. 읽기 앞의 확인과 `lastCheck`가 같은 함수를 쓴다 | 읽기 앞이면 `blocked`(계정 파일을 열지 않음), 읽는 동안 섰으면 `not_written`(값은 그 자리에서 0). 이름은 대개 `intake_closed`이지만 송신기가 정지 세대를 먼저 보므로 세대 모름·바뀜이 겹치면 `stop_generation_unknown`·`stop_generation_changed`가 앞선다(아래) |

깃발을 읽다 던지면 닫힌 것으로 본다(모름을 열림으로 읽지 않는다). 깃발 읽기는 순서기의 불리언 하나를 읽을 뿐 상태를 쓰지 않는다(조립 조건 B1).

자격 값 쪽은 송신기를 고치지 않고 송신기가 받는 복원기 문을 감쌌다: 정지 세대는 게시된 복원기 그대로, 접수는 "깃발이 열림 **그리고** 게시된 복원기의 접수가 열림"이다. 접수 함수 안에서 깃발을 먼저 보고, 닫혔으면 복원기의 접수를 읽지 않는다. 건너뛰는 것은 이 접수 읽기뿐이다: 송신기의 확인은 문의 `stopGeneration()`(게시된 복원기의 세대)을 먼저 읽고 `intakeOpen()`을 읽은 뒤, 거절 이름을 `gate_failed`(읽다 던짐) → `stop_generation_unknown` → `stop_generation_changed`(읽기 앞에 잡은 세대와 다름) → `intake_closed` 차례로 고른다(`dispatch/credential-send.ts`의 `check`). 그래서 깃발 뒤의 값 거절은 대개 `intake_closed`이지만, 세대를 모르거나 바뀐 때는 그 이름이 먼저 보인다. 어느 쪽이든 값은 나가지 않는다.

## 종료 차례

`shutdown()`(`issuance.ts`의 `close`와 `shutdown`):

1. 공유할 완료 약속을 먼저 게시하고, 같은 호출 안에서 `cycle.closeIssuance()`를 부른다. 깃발은 그 호출의 첫 기다림 전에 선다(`shutdown()`이 돌아올 때 이미 서 있다). 이 순간부터 위 세 자리가 모두 막는다. 진행 중인 박자 함수 안의 발급도 내보내기 포트에서 막힌다.
2. 진행 중인 박자가 돌아오기를 기다린다(`closeIssuance()`가 돌아올 때까지). 돌아오면 `issuance_closed`를 기록한다. **이 기록은 깃발이 선 시점이 아니라 대기가 끝난 시점이다.** 그래서 깃발 뒤, 이 기록보다 먼저 `intake_closed` 시도나 내보내기 포트의 `issuance_closed` 거절이 기록될 수 있다.
3. 그 뒤에만 `server.close()`를 부른다. 거절되면 `server_close_failed`를 기록하고, `shutdown()`은 메시지가 `server_close_failed`인 새 `Error`로 거절된다. 포트의 오류 원문은 메시지로도 `cause`로도 건네지 않는다(무엇이 실렸는지 이 조립은 모른다).

몇 번 불러도 닫기는 한 번이다(같은 약속을 돌려준다). 약속을 닫기 시작 전에 게시하므로, 닫기 포트(`closeIssuance()` 안)에서 `shutdown()`을 동기로 다시 불러도 같은 약속이고 `server.close()`는 한 번이다. 진행 중인 자격 값 보내기(계정 파일 읽기를 기다리는 것)는 기다리지 않는다: 깃발 뒤의 `lastCheck`가 막고, 서버가 이미 닫혔으면 서버가 넘기지 않는다. 어느 쪽이든 넘긴 바이트 0이고 값은 그 자리에서 0으로 채워진다.

## 지킨 조건

번호는 설계 조사의 조건 번호다.

| 번호 | 조건 | 지킨 자리 | 시험 |
|---|---|---|---|
| C36 | 서버를 닫기 시작하면 새 발급(지시·ack·값)을 먼저 막고, 그다음 `close()` | 깃발: `sink.ts:263`~`:270`, 이 파일의 복원기 문(`gate.intakeOpen`). 차례: `close`·`shutdown` | `issuance.test.ts` "발급 닫기와 종료 차례" 여섯, 루프백 |
| C50 | `handleForward`의 결과 뒤에 같은 `forward`와 결과를 그대로 `onReceipt`에 | `answers.ts:277`~`:283`(장부가 받아들인 것만, 기록 전), 이 파일의 `credentials.onReceipt` | "자격 값 잇기" 다섯, 루프백 |
| C51 (B1) | 시계·복원기 읽기·장부 읽기·서버의 인정 재확인이 실행 상태를 쓰거나 다른 처리를 부르지 않게 | 이 조립이 더한 읽기는 깃발 하나(`issuance.ts`의 `issuanceOpen`)이고 순서기의 불리언을 읽기만 한다. 장부는 N5가 넘기는 실제 장부의 동기 `getRun`, 시계는 공유 시계 | (조립 조건. 루프백이 실제 장부·서버로 돈다) |
| C52 (B2) | `observe`는 동기 기록기 | 송신기의 `observe`는 이 객체의 `record`(동기, 예외를 삼킴)이고 N5의 `observe`도 동기여야 한다(`IssuancePorts.observe`) | (조립 조건) |
| C53 (B3) | 빌려준 값 버퍼를 `settled` 전에 옮기거나 다시 쓰지 않음 | 이 조립은 값 버퍼에 닿지 않는다. 계정 파일 포트(N5)가 지킨다 | 루프백이 `settled` 뒤 빌린 버퍼가 0인 것을 본다 |
| C54 | `withdrawn`·닫힘에 `forgetConnection`, 새 서버면 송신기도 새로 | `answers.ts:533`~`:540`. 송신기는 이 객체가 만들므로 새 서버면 `createIssuance`를 다시 부른다(아래) | "연결 철회마다", 루프백(철회·닫힘 두 번) |
| C55 | 기록을 값과 섞어 직렬화하지 않음 | `IssuanceNote`에는 송신기 기록(이름·번호·실행 ID)과 단계 이름뿐이다. 닫기 실패도 고정된 이름의 오류로만 알린다 | 단위 시험이 기록 전체와 닫기 오류에 표본이 없음을 불리언으로 보고, 관측 이름의 단언은 허용된 이름만 실패 진단에 올린다 |

## 바뀐 기존 공개 면

- **`sink.ts`의 `WireSinkPorts`에 `issuanceOpen?: () => boolean` 하나, `SINK_REFUSALS`에 `issuance_closed` 하나.** ack도 발급이라 새 실행 규칙(접수)만 보는 기존 확인으로는 막을 수 없었다. 복원기 게시 함수를 감싸 세대를 `null`로 내게 하는 길은 서버의 인정과 인사의 판단까지 바꾸고 C37(같은 게시 함수)을 어긴다. 칸을 선택으로 둔 것은 기존 시험의 조립이 타입 검사를 지나게 하려는 것이다. 빠지면 늘 열린 것으로 보므로 감독의 조립은 이 객체의 `issuanceOpen`을 늘 넘긴다.
- **`answers.ts`의 `AnswerLinePorts`에 `credentials?: AnswerCredentials` 하나.** 답 줄은 동기라 송신기의 약속을 다루지 않는다. 약속은 이 조립이 받는다.
- `cycle.ts`, `credential-send.ts`, `server.ts`는 바꾸지 않았다.

## 이 모듈에 없는 것

감독 진입점(이 조립을 부르고 객체를 넘기는 곳), 도구 어댑터, D-90 닫기 박자, 반쯤 열린 연결의 감지, 계정 파일 포트의 구현.

## 뒤 조각이 지켜야 할 것

- **N5: 감독이 끝날 때 이 객체의 `shutdown()`을 부르고, 서버의 `close()`를 따로 부르지 않는다.** 박자 안의 포트(박자 함수, 서버 tick, 기록기)에서 `shutdown()`을 기다리지 않는다: 자기 박자를 기다려 끝나지 않는다. 부르기만 하는 것은 된다.
- **N5: 같은 객체를 넘긴다.** `cycle`은 박자를 부르는 그 순서기, `server`는 답 줄·내보내기 포트가 쓰는 그 서버, `restorer`는 서버·내보내기 포트·답 줄에 넘긴 그 게시 함수, `ledger`는 답 줄의 `ledger`·`results.ledger`와 같은 장부 객체, `clock`은 장부·서버·내보내기 포트에 넘긴 그 공유 시계다.
- **N5: 내보내기 포트에 `issuanceOpen`을, 답 줄에 `credentials`를 이 객체의 것으로 넘긴다.** 내보내기 포트를 이 칸 없이 만들면 종료 중에도 지시·ack가 나간다.
- **N5: 서버를 새로 시작하면(재개방) 이 객체를 새로 만든다.** 순서기도 깃발을 되돌리는 면이 없으므로 새로 만든다. 옛 송신기의 기억이 새 서버의 같은 번호를 막고, 옛 순서기의 깃발이 새 서버의 발급을 막는다.
- **N5: `observe`는 동기 기록기이고 값과 섞어 직렬화하지 않는다.** `maxBytes`는 16,384 이하(넘으면 모든 실행이 `limit_above_frame`).

## 남는 한계

- **진행 중인 박자 함수가 깃발 전에 이미 넘긴 발급은 되돌리지 못한다.** 깃발은 그 뒤의 `lastCheck`만 막는다.
- **`lastCheck`와 `write` 사이의 선점, 넘긴 뒤 망에서 늦는 것은 막지 못한다**(`transport/server.md` "남는 한계"). 깃발이 그 사이에 서면 그 틀은 나간다.
- **종료는 진행 중인 자격 값 보내기의 끝을 기다리지 않는다.** 계정 파일 읽기가 멈춘 채면 그 약속은 감독이 끝날 때까지 남는다. 넘긴 바이트는 0이다(위 "종료 차례").
- **깃발 뒤에 온 영수증도 장부에는 적힌다.** ack가 나가지 않으므로 실행기는 영수증을 다시 보내고, 다음 감독이 받는다.
- **자격 값 쪽의 깃발 거절 이름은 `intake_closed`다(세대 모름·바뀜이 겹치면 그 이름이 앞선다).** 송신기의 거절 목록에 깃발 이름이 없어서다. 진짜 접수 닫힘과 기록만으로는 가르지 못한다. `shutdown` 기록의 차례로도 가를 수 없다: 깃발은 `shutdown()`을 부른 순간 서고 `issuance_closed` 기록은 진행 중인 박자를 기다린 뒤에 남으므로, 그 사이의 `intake_closed`는 어느 쪽 원인이든 `issuance_closed`보다 먼저 보인다. 원인을 가르려면 `shutdown()`을 부른 시점을 부르는 쪽(N5)이 따로 남긴다.
- **`sink.md`·`cycle.md`의 해당 문구는 이 조립 전의 상태를 적고 있다**(`sink.md` "남는 한계"의 "서버를 닫는 동안의 새 발급은 막지 않는다", 포트 표, `cycle.md`의 "그 전까지 진행 중이던 박자 함수 안의 발급은 포트가 막지 않는다"). 이 문서가 지금의 동작이다.
