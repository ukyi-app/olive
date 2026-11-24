# 원격 대리 제어 (`remote-agent.ts`, `agent-listener.ts`)

작업자 실행기 파드는 컨테이너 둘이다(D-100). 제어 컨테이너(이 실행기, 키를 가짐)가 다른 uid의 역할 컨테이너에 있는 대리(`src/agent/`, 그 PID 공간의 PID 1)를 링크로 부린다(D-102). 이 두 파일이 제어 쪽이다.

- `remote-agent.ts`: `RemoteAgent`. `worker.ts`가 받는 `Launcher`(`launcher`)·`ProcessCleanup`(`cleanup`)·`RunSpace`(`space(inner)`)를 링크 위에서 구현한다. `worker.ts`의 공개 면은 그대로이고 같은 컨테이너 구현(`bunLauncher`, `PidSpace.record`)과 갈아 끼운다. 링크의 말은 `src/agent/link.ts`의 메시지·디코더(`AgentDecoder`, `encodeControl`) 그대로다.
- `agent-listener.ts`: 실행기가 듣는 단 하나의 자리. 경로 유닉스 소켓 하나를 듣고 연결마다 `RemoteAgent.connect`에 넘긴다. 실제 `Bun.listen({ unix })`는 이 파일의 `bunUnixListen` 하나이고, 시험은 듣는 함수를 바꿔 넣는다.

이 구현을 부르는 진입점은 아직 없다(`src/main/executor.ts`는 그대로다).

## 조립

```ts
const remote = new RemoteAgent({
  credentialEnv: profile.credentialEnv,
  runWindow: (runId) => store.run(runId),       // 시작 메시지의 deadline_at·lease_until
  runtime: { setTimer, now },                   // 주입 타이머(renew 맞춤, 응답 기한, 중단 뒤 끝 기다리기)와 단조 시계(응답 기한의 판정)
  inheritedUnverified,                          // 아래 "뒤 조각"
  replyWaitMs: exitWaitMs,                      // worker에 넘기는 exitWaitMs와 같은 값
});
listenForAgent(remote, { path, mode, chmod });
new WorkerExecutor({ ..., launcher: remote.launcher, cleanup: remote.cleanup, space: remote.space(innerSpace) });
```

- 링크의 실행 ID는 worker의 실행 ID다. `space(inner).prepare(runId)`가 준비를 마친 실행 ID를 남기고 바로 다음 `launcher.run`이 한 번 꺼낸다(worker는 준비 → 자격 → 띄우기 차례로 부른다). 중단된 준비가 늦게 끝나면 남기지 않는다.
- 계획의 환경에서 `credentialEnv`의 값만 떼어 `start` 바로 뒤의 값 틀(`encodeCredentialFrame`)로 보내고, JSON의 `env`에는 싣지 않는다. 두 틀은 한 버퍼로 한 번에 쓴다(사이에 다른 쓰기가 끼지 않는다). 쓴 뒤 값과 틀을 0으로 채운다.
- 실행 중(`starting`·`running`)에는 `renewEveryMs`(기본 1초)마다 `runWindow`의 임대 끝이 늘었는지 보고 늘었으면 `renew`를 보낸다. 대리의 스스로 집행이 worker의 임대를 따라가게 한다.
- 중단(취소·기한·임대)이면 `terminate`를 보내고 `exitWaitMs` 안에 끝(`exited`·`unconfirmed`·`not_spawned`)을 듣지 못하면 `ExitUnconfirmed`로 돌아간다. 그 실행의 단계는 그대로 남아 늦게 온 끝을 받는다.
- 시작을 보낸 뒤 `replyWaitMs` 안에 `spawned`·`not_spawned`가 없으면 `terminate`를 보내고 `ExitUnconfirmed`로 돌아간다. worker는 띄우지 않은 실행으로 세지만 단계가 `starting`이라 계수는 `null`이고 실행은 `unknown_running`이다. 단계는 남아 늦은 답을 받는다. 기한 타이머가 돌기 전에 기한 뒤의 답이 와도 같은 길이다(아래 "증거의 기한").
- 이 모듈은 시계를 직접 읽지 않는다. `runtime.now`는 진입점이 넘기는 단조 시계(예: `performance.now`)이고, `setTimer`와 worker의 상한 타이머(전역 `setTimeout`)와 같은 시간 기준이어야 한다. worker의 `now`(벽시계)를 넘기지 않는다.

## 링크 대조 표

제어가 받는 말. "잠금"은 그 객체가 대리를 다시 믿지 않는다는 뜻이다(아래 "모름으로 가는 경우").

| 받은 것 | 그때 단계 | 판정 |
|---|---|---|
| `hello` | 연결의 첫 말 | 그 연결을 쓸 수 있다. 그 전에는 띄우지도 묻지도 않는다 |
| `hello` 두 번째, `hello` 전의 다른 말 | 아무 때 | 디코더 거절 → 잠금(`link_rejected`) |
| `spawned(run)` | `starting`, 같은 실행, 시작 기한 안 | `running`. worker의 `spawned` 훅 |
| `not_spawned(run, 사유)` | `starting`, 같은 실행, 시작 기한 안 | `ended`. `LaunchFailed`(`aborted`·`cleanup_busy`는 그대로, 나머지는 `spawn_failed`) |
| `spawned(run)`·`not_spawned(run)` | `starting`, 같은 실행, 시작 기한 뒤(타이머가 아직 안 돌았어도) | 띄우기는 `ExitUnconfirmed`로 끝나고 `terminate`를 보낸다(시작 상한과 같은 길). 단계는 받은 말대로 `running`·`ended`가 되지만 worker의 훅은 부르지 않는다 |
| `output(run)` | `running`, 같은 실행, 합이 시작의 `output_bytes` 이하 | 모은다. 넘으면 잠금(`output_over_limit`) |
| `exited(run)` | `running`, 같은 실행 | `ended`. 받은 때 worker의 `exited` 훅(제어가 끝을 아는 시각) |
| `unconfirmed(run)` | `running`, 같은 실행 | `ended`. `ExitUnconfirmed` |
| 위 실행의 말이 단계·실행 ID와 어긋남 | 아무 때 | 잠금(`out_of_phase`, 디코더가 먼저 잡으면 `link_rejected`) |
| `terminated(seq)` | 그 seq의 `terminate`를 기다림 | `terminate()`가 풀린다(기한 뒤에 와도 물리적 대기는 여기서 끝난다). **0의 증거가 아니다** |
| `counted(seq, n)` | 그 seq의 `count`를 기다림, 보낸 때와 같은 단계, `replyWaitMs` 안, 앞선 가장 최근의 `terminate`도 `replyWaitMs` 안에 답함 | `survivors()`가 `n`을 돌려준다. `n === 0`이고 `ended`면 `idle`로 닫는다 |
| `counted(seq, n)` | 보낸 뒤 단계가 바뀜, `replyWaitMs` 뒤에 옴, 앞선 `terminate`가 늦었음 | `null`. 요청만 놓고 단계(`ended`)와 연결은 그대로 둔다 |
| 보낸 적 없는(이미 답을 받은) seq, 종류가 다른 답 | 아무 때 | 잠금(`unknown_reply`) |
| 모르는 종류·판, 칸 틀림, 크기 초과, 값 틀 | 아무 때 | 디코더 거절 → 잠금(`link_rejected`) |
| 틀 중간에서 끊김(EOF) | 아무 때(쉬는 동안 포함) | 디코더의 종료 검사 거절 → 잠금(`link_rejected`) |

제어가 묻는 때:

| 호출 | 단계 | 동작 |
|---|---|---|
| `survivors()` | `starting`·`running` | 묻지 않고 `null`(띄우기 보류 중의 0, 프로그램이 끝나기 전의 중간 0은 이 실행의 종료 증거가 아니다) |
| `survivors()` | `idle`·`ended`, 가장 최근의 `terminate`가 이미 기한을 넘김(답을 늦게 받았거나, 아직 답이 없고 시계가 기한을 지남) | 묻지 않고 `null`(그 정리 시도의 계수는 0의 근거가 아니다) |
| `survivors()` | `idle`·`ended` | `count`를 새로 보내고 위 표대로 답을 기다린다 |
| `survivors()`·`terminate()` | 연결 없음, `hello` 전, 잠금 | `null` / `AgentUnavailable`로 거절(worker는 거절을 삼키고 남은 수를 따로 센다) |
| `launcher.run` | `idle`, 쓸 수 있는 연결, 준비된 실행 ID, `runWindow` 있음 | `start` + 값 틀 |
| `launcher.run` | 그 밖 | 보내지 않고 `LaunchFailed`(`aborted`·`cleanup_busy`·`spawn_failed`) |
| `busy()` | 답을 기다리는 `terminate`가 있음 | `true` |

응답 상한은 두 가지를 따로 쥔다.

- **증거의 기한:** `terminate`·`count`·시작의 답은 `replyWaitMs` 안에 와야 증거로 쓴다. 요청마다 보낸 때의 `runtime.now() + replyWaitMs`를 만료 시각으로 쥐고, 답을 받은 때 시계가 그 시각 이상이면 늦은 답이다. 기한 타이머의 콜백은 기한보다 늦게 돌 수 있어(이벤트 루프가 밀리면 100ms 타이머가 100ms를 넘겨 돈다) 콜백만으로는 기한 직후의 답을 가르지 못한다. 만료 시각은 worker가 `bounded`의 타이머를 걸기 전에 잡히므로, 같은 길이(`exitWaitMs`)면 worker가 버린 답을 여기서 받아들이지 않는다. `replyWaitMs`가 worker의 `exitWaitMs`보다 길면 이 보장이 깨진다.
- **물리적 대기:** 요청은 답이 오거나 그 연결이 끝날 때만 놓는다. 기한에서 먼저 놓으면 worker의 물리적 정리 예약이 대리 쪽 정리보다 먼저 풀린다. 늦은 답은 그 요청을 놓을 뿐이고 다른 요청의 답이 되지 않는다(seq가 다르다).

늦은 `count`의 0은 `ended`를 닫지 않는다. 그 실행은 같은 연결에서 새로 끝내고 센 답이 기한 안에 올 때만 `idle`이 되고, 그 전에 연결이 끊기면 실행 중 끊김으로 잠긴다. 그래서 새 연결의 계수가 옛 실행을 닫지 못한다.

## 모름으로 가는 경우

아래는 모두 `survivors()`가 `null`이 되거나 0이 나오지 않아 worker가 `receipt_stopped`를 내지 않고 실행을 슬롯을 쥔 `unknown_running`으로 둔다.

1. **띄우기 보류 중의 계수:** `start`를 보낸 뒤 `spawned`·`not_spawned` 전. 묻지 않는다.
2. **실행 중의 계수:** `spawned` 뒤 끝 전. 묻지 않는다.
3. **실행 중 링크 끊김·쓰기 실패:** `start`를 보낸 뒤 그 실행이 0으로 닫히기 전이면 잠금(`link_lost_mid_run`). 기다리던 요청은 `null`·거절, 띄우는 중이면 `ExitUnconfirmed`.
4. **두 번째 연결:** 연결이 살아 있는데(`hello` 전이라도) 또 연결이 오면 두 연결을 닫고 잠금(`second_connection`). 쉬는 동안이어도 같다.
5. **계약 밖의 말:** 디코더 거절, 틀 중간의 끊김, 단계·실행 ID가 어긋난 실행의 말, 보낸 적 없는 seq, 종류가 다른 답, 출력 상한 초과. 잠금.
6. **상한 안에 답 없음:** 최종 계수가 늦으면 worker의 `bounded`가 `null`로 끝내고, 늦게 온 0은 이 객체에서도 `ended`를 닫지 않는다. `terminate`의 답이 늦으면 그 시도의 계수는 제때 0이어도 쓰지 않는다. 시작의 답이 늦으면 끝내기를 보내고 띄웠는지 모르는 채 돌아간다.
7. **0 아닌 수, 모름:** 대리의 답 그대로(`n`, `null`). 실행은 `ended`로 남아 다음 계수를 받는다.
8. **확인 없이 물려받은 실행:** `inheritedUnverified: true`면 처음부터 잠금(`inherited_unverified`). 그 실행을 지금 붙은 대리의 0으로 닫지 않는다.

**잠금은 풀리지 않는다.** 잠긴 뒤의 연결은 바로 닫고, 새 `hello`를 받지 않고, 띄우지 않는다. 제어는 새 대리의 `hello`와 옛 공간에 남은 프로세스가 연 연결을 말로 가를 수 없다. 쉬는 동안(`idle`) 끊긴 링크는 잠그지 않는다: 그때는 마지막 실행이 0으로 닫혀 공간에 대리 말고 아무것도 없었고, 새 연결의 `hello`는 그 뒤의 새 실행에만 쓰인다.

## 보장

- `survivors()`가 0을 돌려주는 길은 하나다: 잠기지 않은, `hello`를 한 연결에서, `idle`이나 `ended` 단계에 새로 보낸 `count`의 답이 보낸 때와 같은 단계에서 `replyWaitMs` 안에 왔고, 그 `count`보다 먼저 보낸 가장 최근의 `terminate`도 `replyWaitMs` 안에 답했고, 그 값이 0이다. "안에"는 받은 때의 주입 단조 시계로 잰다.
- `terminated`는 0으로 쓰이지 않는다. `terminate()`는 값을 돌려주지 않는다.
- 서명하지 않는다. 대리의 답은 서명 없는 사실이고 영수증은 worker가 자기 키로 낸다.
- 자격 값은 값 틀 하나에만 실린다. `state()`·`AgentUnavailable`·`AgentListenerRefused`에는 사유 이름만 있다.
- 듣는 곳은 `agent-listener.ts`의 경로 유닉스 소켓 하나다. 경로는 `/`로 시작해야 하고 NUL을 담지 못한다(abstract 이름 거절). TCP·다른 소켓 API는 실행기 코드에 없다(`test/executor/static.test.ts`).
- 다 못 쓴 바이트는 리스너가 사본으로 쥐었다가 `drain`에서 이어 쓰고, 다 쓴 사본은 0으로 채운다. 쥔 양이 256KiB를 넘거나 이어 쓰기가 실패하면(음수 반환, 예외) 그 연결을 닫고 사본을 지운다(끊김으로 다룬다).
- 실제 bind(`bunUnixListen`)는 내보내지 않는다. 듣기는 경로·권한 검사를 지나는 `listenForAgent`로만 열린다.

## 남는 위험

- **0은 역할 컨테이너의 대리가 센다.** 제어는 그 0을 독립으로 확인하지 못한다. 대리 쪽 보호(PID 1의 신호 보호, non-dumpable)를 깨는 커널·대리 버그가 있으면 거짓 0이 이 구현을 지나간다(대리 쪽 `src/agent/agent.md` "남는 위험").
- **잠금은 회복 길이 없다.** 이 PR에서 잠긴 실행기는 재시작 전까지 0을 말하지 않고 새 실행을 띄우지 않는다. 잠금 뒤의 실행은 `unknown_running`으로 슬롯을 쥔다.
- **끝의 시각이 늦다.** 링크에는 "끝났다, stdout은 아직"이라는 말이 없어 제어는 `exited`를 받은 때 끝을 안다. 그 사이 기한·임대가 지나면 0으로 끝난 프로그램도 `completed`가 아니다(완료가 아닌 쪽).
- **쉬는 동안의 링크 끊김은 잠그지 않는다.** 그 사이 역할 컨테이너에 다른 프로세스가 들어와(exec 등, 배포 규칙 위반) 먼저 연결하면 그것을 대리로 받는다. 띄우기 전 사전 계수와 두 번째 연결 잠금이 일부를 잡지만 막지 못하는 경우가 있다.
- **역할 컨테이너 안의 무엇이든 소켓에 붙을 수 있다.** 붙으려면 소켓 파일의 쓰기 권한만 있으면 되고 폴더의 읽기 전용과 무관하다. 대리가 붙어 있는 동안 두 번째 연결은 잠금으로 끝난다(실패 쪽 닫힘이지만 그 뒤 회복이 필요하다).
- 소켓 파일의 권한은 bind 뒤 `chmod`로 준다. 그 틈의 권한은 프로세스의 umask가 정한다.
- **버퍼의 수명은 Bun에 기댄다.** 시작 틀(값 틀 포함)은 `socket.write`가 돌아온 즉시 0으로 채운다. 이것은 Bun이 돌려준 뒤 그 버퍼를 더 참조하지 않는다는 전제에 기댄다(다 못 쓴 나머지는 리스너가 자기 사본으로 쥔다). 고정한 Bun 1.4.4의 같은 uid 경로 소켓에서만 확인했다. 런타임을 올리면 다시 본다.
- **실제 배치의 검증 범위.** 시험은 한 프로세스 안의 스크래치 경로 소켓(같은 uid)까지다. 서로 다른 uid의 두 컨테이너, bind 전후의 실제 권한, 차트, 감독까지의 종단 간 실행은 확인하지 않았다.

## 뒤 조각이 지켜야 할 것

- **진입점(O-c):** 대리의 `hello`를 기다린 뒤에 감독에 연결한다(상한 안에 없으면 연결 전에 정한 코드로 끝난다). 장부에 기동 전부터 끝을 맺지 못한 실행(`preparing`·`running`·`stopping`·`checking`·`unknown_running`)이 있고 그 공간이 사라졌다는 따로 된 확인이 없으면 `inheritedUnverified: true`로 만든다. 소켓 경로·권한·umask, 지난 소켓 파일의 처리, 실제 타이머를 여기서 정한다. `replyWaitMs`는 worker의 `exitWaitMs`와 같은 값으로 넘기고(다르게 조립하면 worker가 포기한 정리의 늦은 계수를 여기서 받아 두 판단이 갈라진다), `runtime.now`에는 worker의 상한 타이머와 같은 시간 기준의 단조 시계를 함께 넘긴다(벽시계를 넘기면 시각이 뛸 때 기한 판정이 worker와 갈라진다). 두 값은 설정 한 곳에서 두 객체에 같이 넘긴다. 환경 읽기는 진입점에만 둔다.
- **차트(H-split):** 역할 컨테이너는 자기 PID 공간을 가진다(`shareProcessNamespace` 없음). 링크 폴더는 제어에 쓰기, 역할에 읽기 전용. 키·TLS·저장소 볼륨은 제어 컨테이너에만. 역할 컨테이너에 exec·프로브를 두지 않는다. 역할 uid ≠ 제어 uid.
- **회복(D-104, 이 PR에 없음):** 실행 중 링크가 끊긴 실행, 잠금 뒤의 실행은 파드 전체 재시작과 init의 새 세대 표식으로 스스로 정리하고, 안 되면 관리자 닫기로 간다. 그 확인이 생기면 기동 때 `inheritedUnverified: false`로 넘긴다. 새 `hello`만으로 그 실행을 닫지 않는다.
- 값 틀을 만드는 자리는 `credential-send.ts`와 이 파일 둘이다(`test/supervisor/dispatch/credential-send.test.ts`). 세 번째를 더하지 않는다.

## 시험

- `test/executor/remote-agent.test.ts`: 시험이 대리 자리에서 링크의 말을 직접 정해 worker 전체를 지난다. 대조군(0 → `receipt_stopped`), 띄우기 보류, 대리 죽음과 새 `hello`, 늦은 답과 `terminated`만의 답, 늦은 끝내기, 늦은 최종 계수(원격 단계·연결 세대까지), 응답 시각(시계만 기한을 넘기고 타이머는 돌지 않은 계수·끝내기·시작의 답, 기한 직전 대조군), 두 번째 연결(계수 대기 중, 쉬는 동안), 0 아닌 수·모름, 순서 틀림·모르는 말 다섯, 출력 상한, 시작 응답 상한, 잘린 틀, 끝의 시각, 깊은 결과(R16)·끝난 뒤 임대(R11)·nonce 장애(F10), 확인 없는 기동, 자격 값의 자리, renew 맞춤.
- `test/executor/agent-listener.test.ts`: 스크래치 경로 소켓에 실제 대리 핵심(`RoleAgent`, 가짜 launcher·정리 코어)을 붙여 `hello → start → exited → terminate → count 0`이 `receipt_stopped`의 0까지 닿는 것, 실제 대리의 끝내기 응답만·최종 계수만 늦은 경우, 실제 소켓의 두 번째 연결, 경로·권한 거절, 다 못 쓴 바이트의 이어 쓰기와 0 채우기, 이어 쓰기 예외의 정리, 공개 면.
- `test/executor/remote-{worker,ordering,recovery,hardening,evidence}.test.ts`: 기존 실행기 시험 파일을 원격 구현과 가짜 대리(`fake-agent.ts`)로 한 번 더 돌린다. 링크로 옮길 수 없는 가짜 launcher를 전제한 넷(`support.ts`의 `DIRECT_ONLY`: 끝을 drain 전에 알리는 셋, 출력 상한을 넘기는 하나)만 등록하지 않고 그 이름을 대조한다. 그 넷이 지키던 보장 가운데 링크로 옮길 수 있는 것(깊은 결과의 종료 증거, 끝난 뒤 임대, nonce 장애 뒤의 완료)은 `remote-agent.test.ts`가 제어가 끝을 관측한 뒤를 기준으로 다시 본다. drain 중 임대 만료의 `completed`만 링크에서 성립하지 않는다("끝의 시각").
