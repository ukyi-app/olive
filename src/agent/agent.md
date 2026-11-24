# 역할 대리 (`src/agent/`)

작업자 실행기 파드는 컨테이너 둘이다(D-100). 제어 컨테이너(지금의 실행기, 키를 가짐)와 다른 uid의 역할 컨테이너. 역할 컨테이너의 PID 1인 이 대리가 역할 프로그램을 띄우고, 끝내고, 남은 프로세스를 지금의 정리 코어로 센다(D-102). 제어와는 유닉스 소켓 하나 위의 링크로 지시와 결과만 주고받는다.

- `link.ts`: 링크 메시지, 인코더, 두 방향의 디코더. 제어 쪽(O-b)도 이 파일을 그대로 import한다.
- `agent.ts`: 대리 핵심(`RoleAgent`)과 제품 조립(`productionParts`).
- `dumpable.ts`: `prctl(PR_SET_DUMPABLE, 0)`(`bun:ffi`로 libc를 연다).

이 대리를 부르는 진입점은 `src/main/role-agent.ts`다. 환경(`OLIVE_AGENT_SOCKET`)을 읽고 `prepare` 뒤에 제어의 경로 유닉스 소켓에 붙는다(README "작업자 실행기 진입점"). 제어 쪽 원격 구현은 `src/executor/remote-agent.ts`다.

## 링크 메시지

틀은 `transport/framing.ts` 그대로다. 메시지는 봉투 틀(길이 접두 4바이트 + UTF-8 JSON, 64KiB 이하), 자격 값은 값 틀(첫 바이트 0x01, 실행 ID·지문·값, 16KiB 이하)이다. 모든 JSON에 `"v": 1`이 있고, 칸은 정확히 아래와 같다(빠지거나 더 있으면 거절).

| 방향 | `type` | 칸 | 뜻 |
|---|---|---|---|
| 제어 → 대리 | `start` | `run_id`, `program`, `argv`, `cwd`, `env`, `credential_env`, `credential_digest`, `output_bytes`, `deadline_at`, `lease_until` | 실행 하나를 연다. **바로 다음 틀은 같은 `run_id`·지문의 값 틀이어야 한다.** 시각은 에포크 밀리초 |
| 제어 → 대리 | `renew` | `run_id`, `lease_until` | 열린 실행의 임대 끝을 바꾼다 |
| 제어 → 대리 | `terminate` | `seq` | 실행을 멈추고 공간을 정리한다(`PidSweep.terminate`). 열린 실행이 없어도 받는다(아래 "열린 실행 밖의 요청") |
| 제어 → 대리 | `count` | `seq` | 남은 수를 묻는다(`PidSweep.survivors`). 열린 실행이 없어도 받는다 |
| 대리 → 제어 | `hello` | 없음 | 링크의 첫 말. non-dumpable·PID 1·기준 기록을 마친 뒤에만 보낸다 |
| 대리 → 제어 | `spawned` | `run_id` | 프로세스가 생겼다 |
| 대리 → 제어 | `output` | `run_id`, `data`(base64) | stdout 조각(디코딩한 원 바이트 32KiB 이하). 넘는 조각은 양쪽 모두 거절한다: 봉투가 크기 검사를 통과하면 보내는 쪽·받는 쪽 모두 `link_bad_message`, 봉투 자체가 64KiB를 넘으면 받는 쪽은 길이 접두만 보고 `frame_too_large`(보내는 쪽은 `link_bad_message`). 해석하지 않는다 |
| 대리 → 제어 | `exited` | `run_id`, `code`, `signal`, `overflow`, `stdout_bytes` | 프로그램이 끝났다. `stdout_bytes`는 앞선 `output` 합, 초과면 0 |
| 대리 → 제어 | `not_spawned` | `run_id`, `reason` | 띄우지 않았다: `aborted`·`cleanup_busy`·`spawn_failed`·`refused`(자격 값이 다른 칸에 있음 등)·`expired`·`space_not_clean` |
| 대리 → 제어 | `unconfirmed` | `run_id` | 띄웠지만 끝을 확인하지 못했다(`ExitUnconfirmed`) |
| 대리 → 제어 | `terminated` | `seq` | `terminate`의 정리가 끝났다 |
| 대리 → 제어 | `counted` | `seq`, `survivors` | 정리 코어의 답 그대로. `0`은 확인, 수는 그 수, `null`은 모름 |

## 차례와 디코더

- **대리가 받는 쪽(`ControlDecoder`)**: 값 틀은 `start` 바로 뒤에만 온다. 실행 ID·지문이 다르거나 값의 SHA-256이 지문과 다르면 `link_credential_mismatch`. `start` 뒤에 다른 틀이 오거나 입력이 끝나면 `link_out_of_order`. `terminate`·`count`는 `seq` 하나를 함께 쓰고 오름차순이다. 같거나 작은 `seq`는 효과(정리, 답) 전에 `link_out_of_order`.
- **제어가 받는 쪽(`AgentDecoder`)**: 봉투만 받는다(값 틀은 `frame_too_large`). `hello`가 처음 한 번. 실행 하나의 말은 `spawned → output* → exited|unconfirmed` 또는 `not_spawned` 하나이고 다른 실행의 말과 섞이지 않는다. `output` 합은 상한 이하이고 `exited.stdout_bytes`와 같다. `terminated`·`counted`의 `seq`는 오름차순이다.
- 둘 다 거절하면 `LinkError(code)`를 던지고 그 뒤로는 같은 오류만 낸다. 오류에는 사유 이름만 있다.
- 두 인코더도 보내기 전에 받는 쪽과 같은 꼴 검사를 지난다. 타입 밖의 종류는 `link_unknown_message`, 꼴 틀림은 `link_bad_message`로 던진다.
- 실행의 차례(실행 중의 두 번째 `start`, 열린 실행이 없거나 다른 실행의 `renew`)는 대리의 상태라 `agent.ts`가 본다.
- `seq`가 어느 요청의 답인지(없는 요청, 늦은 답)는 요청을 아는 제어가 본다.

## 대리의 차례

1. `harden`: 자기를 non-dumpable로 만들고 다시 읽어 0인지 본다. 아니면 78로 끝난다. 다른 무엇보다 먼저다. exec마다 dumpable로 돌아가므로 대리 프로세스 자신이 부른다.
2. 자기 번호가 1인지 본다. 아니면 79로 끝난다(PID 1이 아니면 대리가 끝나도 공간이 비지 않는다).
3. `PidSpace.record({ dedicated: true })`: 기준은 자기뿐이다. 거부되면 80으로 끝난다.
4. `attach`: 링크에 `hello`. 그 전에 받은 바이트는 디코딩하지 않고 77로 끝난다.
5. `start`: 값 틀의 값으로 계획을 만들고 값 배열을 0으로 채운다. 기한·임대가 지났거나 공간에 남은 프로세스가 있으면(`survivors() !== 0`) 띄우지 않는다. 그 확인 뒤 `bunLauncher.run`까지 await가 없다.
6. 실행은 `start`로 열리고, 프로그램이 끝난(또는 띄우지 못한) 뒤 `count`에 0을 답한 때 닫힌다. 닫히기 전의 `start`는 계약 밖이다.

### 열린 실행 밖의 요청

`terminate`·`count`는 열린 실행이 없을 때도 받아 공간 전체를 정리하고 센다. 띄우지 않으므로 여는 쪽 효과는 없다. 받는 까닭:

- `count`: 제어는 `start`를 보내기 전에 멈춘 실행(띄우지 않은 실행)도 세어 0을 확인한 뒤에만 종료 영수증을 낸다(`worker.ts`의 `notStarted` → `confirmStopped`의 `survivors`). 대리에게는 열린 실행이 없고, 그 실행의 시작 응답(`spawned`·`not_spawned`)은 영영 오지 않는다. 그래서 그 실행의 근거는 그 실행의 정리 단계에서 새로 보낸 `count`의 답이다(아래 "뒤 조각이 지켜야 할 것").
- `terminate`: 제어가 상한 안에 `counted`를 받지 못해 실행을 모름으로 둔 뒤 회수(`reclaim`)하면, 늦게 온 0으로 대리 쪽 실행은 이미 닫혔을 수 있다. 거절하면 대리가 끝나 그 회수가 늘 모름이 된다.

이 둘의 답은 공간 전체의 사실이고 어느 실행의 것인지는 말하지 않는다. 어느 요청의 답으로 쓸지는 제어가 정한다(아래 "뒤 조각이 지켜야 할 것").

## 스스로 집행 (실패 쪽 닫힘)

다음이면 링크를 닫고, 실행을 멈추고, 정리를 상한(`enforceWaitMs`)까지 기다린 뒤 끝난다.

| 원인 | 종료 코드 |
|---|---|
| 링크가 끊김(`linkClosed`), 쓰기 실패 | 75 |
| 열린 실행이 `min(deadline_at, lease_until) + enforceGraceMs`(기본 25초)를 지나도 닫히지 않음. 그 시각이 지난 뒤 `renew`나, 프로그램이 끝난 실행(`run.ended`)을 0으로 닫을 계수 완료가 만료 콜백보다 먼저 처리돼도 같다(기존 시각으로 판단, 그 갱신은 받지 않고 그 최종 0의 `counted`는 보내지 않음). 프로그램이 끝나기 전의 중간 0은 억제하지 않고 그대로 나간 뒤 76으로 닫힐 수 있으므로, 중간 계수로는 종료를 확정할 수 없다 | 76 |
| 디코더 거절(같거나 작은 `seq` 포함), `attach` 전의 수신, 실행 중의 `start`, 맞지 않는 `renew`, 두 번째 `attach`(그 포트의 닫기가 실패해도) | 77 |

대리는 공간의 PID 1이라 끝나면 커널이 공간의 나머지를 SIGKILL로 끝낸다. 그래서 정리가 멈춰도 상한 뒤에는 공간이 빈다. 끝난 뒤에는 아무 말도 하지 않으므로 제어는 그 실행의 남은 수를 모른다.

## 보장

- 대리는 서명하지 않고 키를 보지 않는다. 내는 것은 서명 없는 사실이다.
- `counted`는 정리 코어의 답을 바꾸지 않는다. 0이 아니거나 모름이면 그대로 내고, 실행을 닫지 않는다(임대 감시가 이어진다).
- 역할 프로그램에게서 받는 것은 stdout 바이트뿐이고 해석하지 않는다.
- 자격 값은 JSON을 지나지 않는다. 디코딩한 값은 `CredentialValue`에 싸여 직렬화·문자열·inspect에 나오지 않고, 한 번 꺼내 쓴 뒤 0으로 채운다. 값이 `program`·`cwd`·`argv`·다른 환경 값에 들어 있으면 띄우지 않는다(`not_spawned(refused)`).
- **가림의 보장은 `CredentialValue`와 `LinkError`까지다.** 계약을 어긴 제어가 같은 바이트를 `start`의 다른 칸에 넣으면, 디코딩한 `start` 전체를 직렬화·inspect하면 그 바이트가 보인다. 그래서 받은 `start` 전체는 진단(로그·inspect·직렬화)에 넘기지 않는다. 대리 코드에는 그런 출력 자리가 없다(`test/agent/static.test.ts`). 디코더가 모든 칸과 대조해 거절하지 않은 까닭: 실행 ID·지문·수 칸은 짧은 값과 우연히 겹칠 수 있어 "전체에 없음"을 약속할 수 없고, 띄우기 거절은 이미 `planFor`가 한다.
- 띄우기는 `bunLauncher`, 신호와 `/proc`은 `PidSpace.record`가 만든 정리 코어로만 한다. 대리 코드는 소켓을 열거나 듣지 않고, 시계·타이머·끝내기는 주입받는다(`test/agent/static.test.ts`).

## 대리가 믿는 전제

- 대리가 역할 컨테이너 PID 공간의 PID 1이다(`shareProcessNamespace` 없음). 대리가 이것을 확인하는 것은 자기 번호 1과 기준 스캔뿐이다.
- 그 공간에 다른 작업이 합류하지 않는다(exec·디버그 컨테이너·exec 프로브 금지). 합류가 보이면 정리 코어가 전체 신호를 멈추고 0을 말하지 않는다.
- 대리 실행 파일과 이미지는 읽기 전용 루트에 있다. 역할 프로그램이 대리 코드를 바꿀 수 없다.
- 링크의 상대는 제어 하나다. 소켓은 제어가 듣고, 그 폴더는 역할 컨테이너에 읽기 전용이다.
- 기반 이미지에 glibc의 `libc.so.6`이 있다(없으면 harden이 실패해 대리가 뜨지 않는다).

## 남는 위험

- **"0"을 모델과 같은 uid의 대리가 센다.** 신호 보호(공간의 init은 같은 공간에서 온 처리기 없는 신호를 받지 않음)와 non-dumpable이 막지만, 커널이나 대리 코드의 버그가 있으면 거짓 0이 나갈 수 있다. 제어는 그 0을 독립으로 확인할 수단이 없다.
- **좀비가 실행마다 쌓인다.** 대리가 PID 1인 Bun이라 고아가 된 후손을 회수하지 않는다. 정리 뒤 살아 있는 후손은 0이어도 좀비는 공간에 남고(세지 않는다), 같은 대리에서 실행할 때마다 늘어 PID 자원과 다음 스캔의 대상에 남는다. 고아 회수(`waitpid(-1)`류)를 그냥 넣으면 Bun이 자기 자식(`bunLauncher`가 띄운 역할 프로그램)을 기다리는 것과 겹쳐 그 종료 상태를 빼앗을 수 있어 설계가 필요하다. 회수 방식이나 대리 교체 조건(몇 번 실행 뒤 파드 재시작 등)은 아직 정하지 않았다. 장기간의 지연·PID 한도 도달은 확인하지 않았다.
- 계획 문자열(자격 값이 든 환경)은 대리의 메모리에 남는다. 같은 uid의 `/proc/1/mem` 읽기는 non-dumpable이 막는다.
- 대리가 보낸 `exited`의 시각은 싣지 않는다. 제어는 받은 시각으로 기한·임대를 대조하므로 실제보다 늦게 본다(완료가 아닌 쪽으로 기운다).

## 뒤 조각이 지켜야 할 것

- **제어(O-b)**: 두 번째 연결, 디코더 거절, 늦은 답·없는 요청의 답, 상한 안에 없는 답, 실행 중 끊김을 모두 "모름"(`null`·`unknown_running`)으로 다룬다. 두 번째 연결을 본 역할 컨테이너 세대는 다시 믿지 않는다. **새 `hello`로 끊긴 실행을 닫지 않는다**(새 hello는 그 뒤의 새 실행에만 쓴다. 끊긴 실행의 회복은 파드 재시작 관문이나 관리자 닫기다).
- **제어(O-b)**: **띄우기가 보류된 동안의 0은 종료 증거가 아니다.** `start`를 보낸 뒤 `spawned`·`not_spawned`가 오기 전에는 대리가 사전 계수를 기다리는 중일 수 있고, 그때의 `count`는 빈 공간의 0을 답하지만 그 뒤 같은 실행이 뜰 수 있다. 시작 응답이 미결일 때 받은 `counted`를 영수증으로 승격하지 않고, 실행·요청·단계가 맞는 최종 계수만 쓴다. `start`를 보낸 실행은 시작 응답과 `exited`·`unconfirmed`·`not_spawned` 뒤의 종료 단계에서 보낸 계수다. `start`를 보내지 않았고 앞으로도 보내지 않을 실행은 시작 응답을 기다리지 않고, 그 실행의 정리 단계에서 새로 보낸 계수를 쓴다. 열린 실행 밖의 `terminated`·`counted`도 공간 전체의 사실일 뿐이므로 같은 규칙으로 고른다.
- **제어(O-b)**: 값 틀을 만드는 자리가 하나 는다. `src/`에서 `encodeCredentialFrame`을 부르는 곳을 `credential-send.ts` 하나로 묶은 정적 규칙(`test/supervisor/dispatch/credential-send.test.ts`)을 같은 변경에서 다시 정한다. 링크 쓰기 자리가 `.send(` 꼴이면 송신 자리 목록(`start-send.test.ts`)에도 걸린다.
- **제어(O-b)**: 듣는 소켓은 경로 유닉스 소켓 하나다(TCP·abstract 금지). 대리 쪽 소켓을 대리가 듣는 반대 방향은 쓰지 않는다(같은 uid의 모델이 바꿔치기할 수 있다).
- **진입점(`src/main/role-agent.ts`)**: `RoleAgent.prepare`를 소켓 연결보다 먼저 부른다. 환경 읽기와 소켓은 진입점에만 두고, 소켓이 닫히거나 오류가 나면 `linkClosed()`를 부른다. `runtime.exit`은 실제로 프로세스를 끝내야 한다. `runtime.now`는 벽시계다(`start`의 `deadline_at`·`lease_until`과 바로 견준다). 이 차례와 끊김의 종료는 `test/agent/role-agent.test.ts`가 본다. 대리 진입점에서 닿는 코드에 듣는 API가 없다는 것은 `test/entrypoints.test.ts`가 본다.
- **차트(H-split)**: 역할 컨테이너는 자기 PID 공간을 가진다(`shareProcessNamespace` 없음). 링크 폴더는 역할 컨테이너에 읽기 전용, 키·TLS·저장소 볼륨은 제어 컨테이너에만. 역할 컨테이너에 exec·프로브를 두지 않는다.
- `test/containment-junit.ts`의 기대 목록이 29개가 됐다. README "실행기 시험의 실제 프로세스"의 개수(23)를 다음에 README를 고치는 변경에서 맞춘다.

## 시험

- `test/agent/link.test.ts`: 두 방향의 꼴, 차례, 크기, 자격 값의 가림.
- `test/agent/agent.test.ts`: 가짜 링크·정리·띄우기·시계로 정상 길, 차례(`attach` 전 수신, 열린 실행 밖의 요청, 공유 `seq`), 스스로 집행(끊김·쓰기 실패·계약 밖·임대 끝·집행 시각 뒤의 갱신과 계수 완료·두 번째 `attach`·정리 멈춤), 0이 아닌 수·모름을 그대로 냄.
- `test/agent/static.test.ts`: 대리 코드의 금지 API(진단 출력 포함).
- `test/executor/containment.test.ts`의 "실제 프로세스 대리 …" 6개: bwrap 공간에서 harness 프로세스가 대리로 PID 1이 되고, 같은 프로세스의 가짜 제어가 링크 바이트로만 지시한다(후손 셋, 자식의 신호, 링크 끊김, non-dumpable).
