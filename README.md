# olive

올리브의 감독과 작업자 실행기다. 감독은 모델이 아닌 프로세스로, 서명된 지시로 역할별 파드의 실행기에 작업자를 띄우게 하고 예산과 동시 실행 상한을 집행한다. 실행기는 감독에 먼저 붙어 연결을 유지하고 그 위로 지시를 받는다. 듣는 쪽은 감독이다.

감독 진입점은 아직 자리다(기능 없이 "아직 구현되지 않았다"를 찍고 0이 아닌 코드로 끝난다). 작업자 실행기의 진입점(제어 컨테이너)과 역할 컨테이너의 대리 진입점은 조립을 갖췄지만, 운영 차트가 그 환경을 아직 다 주지 않아 운영에서는 연결 전에 정한 코드로 끝난다(아래 "작업자 실행기 진입점").

설계와 결정은 homelab 저장소의 `docs/plans/2026-11-13-olive/`에 있다. 저장소 배치는 `spec.md` §4.1, 파드 배치는 `supervisor.md` §1.1, 이 저장소의 첫 일은 `issues/O09-supervisor.md`다.

## 배포

- homelab `apps/`에 등록하지 않는다. 감독은 모델 자격을 모두 쥐므로 main을 자동으로 따라가지 않는다(D-18).
- main에 병합하면 homelab 공용 빌드(`app-build`)가 이미지를 `ghcr.io/ukyi-app/olive`(공개 패키지)에 올린다. 배포 PR은 만들지 않는다.
- 배포는 homelab `platform/`의 값에 이미지 digest를 적는 사람 PR로만 한다.
- main은 PR과 code owner 리뷰로만 바뀐다. `.github/CODEOWNERS`는 `* @ukkiee` 한 줄만 둔다.

## 이미지 계약

- **하나의 이미지, 역할은 명령으로:** 감독과 작업자 실행기가 같은 이미지를 쓴다. 파드는 `command`로 역할을 고른다.
  - 감독: `["bun", "src/main/supervisor.ts"]`
  - 작업자 실행기(제어 컨테이너): `["bun", "src/main/executor.ts"]`
  - 역할 컨테이너의 대리(PID 1): `src/main/role-agent.ts`. 역할 컨테이너는 다른 이미지이고 대리를 init이 놓는다(D-103). 그 실행 파일의 꼴은 아직 정하지 않았다.
  - 기본 명령(`src/main/no-role.ts`)은 역할을 고르라고 찍고 64로 끝난다. 이미지의 `ENTRYPOINT`는 비어 있어 `command`가 그대로 돈다.
- **종료 코드:** 64는 역할을 고르지 않음, 69는 아직 구현되지 않음(감독). 실행기의 81~89와 대리의 75~82는 아래 "작업자 실행기 진입점".
- **사용자와 파일시스템:** 비root uid·gid 65532. 루트 파일시스템은 읽기 전용 전제이고 쓰기는 `/tmp`만 된다(파드가 emptyDir를 붙인다).
- **포트:** 이미지에 듣는 포트를 적지 않는다(`EXPOSE`·`PORT` 없음). 실행기는 TCP 포트를 듣지 않는다. 듣는 곳은 역할 컨테이너의 대리가 붙는 경로 유닉스 소켓 하나(`src/executor/agent-listener.ts`, D-102)뿐이고 abstract 소켓도 쓰지 않는다.
- **들이지 않는 것:** hc 실행 파일, `/etc/claude-code`(관리 설정), 모델 CLI. 앞의 둘은 빌드가 확인한다.
- **기반 이미지:** `oven/bun:<버전>-slim`(설치·시험 단계)과 `oven/bun:<버전>-distroless`(최종 단계, 셸 없음). 둘 다 digest로 고정한다.
- **amd64 단일 빌드:** `app-build`가 `--platform linux/amd64`로 부른다.

### 빌드가 확인하는 것

Dockerfile 단계는 `deps` → `runtime-files` → `image-check` → `test` → 최종 단계다.

- `deps`: 기반 이미지(slim)의 `bun --version`이 `.bun-version`과 같다.
- `image-check`: 최종 이미지의 파일 내용(`runtime-files`)을 셸이 있는 단계에 복사해 본다. distroless 안의 bun이 `.bun-version`과 같고, 이름이 `hc`인 파일이 하나도 없고, `/etc/claude-code`가 없다. 최종 단계는 셸이 없어 `RUN`을 쓸 수 없기 때문이다.
- `test`: `image-check`의 결과 파일을 받아 오므로 그 검사 뒤에만 돈다. 타입 검사(`bun run check`)와 시험(`bun run test`, 아래 "시험")을 돌린다. 공용 빌드가 PR과 main push에서 `--target test`로 이 단계를 돌린다.

## 버전 고정

| 무엇 | 고정하는 자리 |
|---|---|
| Bun | `.bun-version`, Dockerfile의 두 FROM(태그와 digest), `package.json`의 `@types/bun` |
| npm 패키지 | `package.json`의 정확한 버전, `bun.lock` |
| 공용 빌드 | `.github/workflows/build.yaml`의 `app-build-vX.Y.Z` 태그 ref(SHA로 바꾸지 않는다, 파일 주석) |

Renovate가 PR을 연다(자동 병합 없음). Bun 묶음(두 FROM, `.bun-version`, `@types/bun`)은 한 PR로 온다. 손으로 올릴 때는 네 자리를 함께 바꾸고 `bun install`로 `bun.lock`을 맞춘다. digest는 레지스트리에서 태그의 이미지 인덱스 digest를 읽는다. 어긋나면 `test/pins.test.ts`와 빌드의 버전 확인이 실패한다.

`bun.lock`은 lockfile v2라 Bun 1.4.0 미만은 읽지 못하고 의존성을 다시 풀어 버린다. `bun --version`이 `.bun-version`과 같은지 먼저 본다(mise·setup-bun은 이 파일을 읽는다).

## 시험

```bash
bun install
bun run check   # 타입 검사
bun run test    # 시험과 실행된 시험 수 확인(Dockerfile의 test 단계와 같은 명령)
```

`test/`가 지금 지키는 계약: 고정한 버전이 서로 같다(`pins`), Dockerfile에 단계와 확인 줄이 있다(`dockerfile`), 진입점이 정해진 코드로 끝나고 실행기 쪽 코드의 듣는 API는 `agent-listener.ts`의 경로 유닉스 소켓 하나뿐이며 대리 쪽은 듣지 않고 환경을 읽는 곳은 두 진입점뿐이다(`entrypoints`), `CODEOWNERS`·`build.yaml`·Renovate 정책(`repo`), 계약 `olive-control/v1`과 그 fixture(`contract/`), 작업자 실행기의 지시 처리·지속 상태·연결 수명·정리(`executor/`).

**`bun test`가 아니라 `bun run test`다.** `bun test`는 시험이 0개인 파일(빈 파일, 블록 주석으로 감싼 파일)을 결과에서 빼고 0으로 끝난다. `bun run test`는 `test/run.ts`를 돌린다. 이것이 `bun test --reporter=junit`의 결과 파일을 읽어 다음이면 실패한다.

- 시험 파일 이름이 허용 꼴이 아니다. 허용 꼴은 점으로 시작하지 않는 소문자 `*.test.ts` 하나다. Bun은 숨김 파일(`.x.test.ts`)과 대소문자가 다른 이름(`x.TEST.ts`), `.spec`·`_test`·`_spec`도 시험으로 읽는다. 이런 이름의 파일이 있으면 내용과 무관하게 실패한다(빈 파일이면 Bun이 결과에 아무것도 남기지 않아 실행 수로는 잡을 수 없다). 훑는 범위 안의 심링크도 실패다.
- 결과 파일이 없다(Bun은 실행된 시험이 0개면 결과 파일을 쓰지 않는다).
- 실행된 시험이 0개다.
- 허용 꼴의 시험 파일 가운데 실행된 시험이 0개인 파일이 있다.
- skip·todo로 남은 시험이 있다.

훑는 범위는 Bun과 같다. 이름이 점으로 시작하는 폴더와 `node_modules`에는 들어가지 않는다(Bun도 그 안의 시험을 읽지 않는다).

`.only`와 `.if(false)`는 시험을 결과에서 아예 빼므로 위 확인으로 잡히지 않는다. 그래서 `test/repo.test.ts`가 `test/`의 소스에서 이 표시들을 막는다. 일부 시험만 돌리려면 `bun test <이름>`을 쓴다(`bun run test`는 인자를 받지 않는다).

## 계약 `olive-control/v1`

감독, 실행기, 현관이 함께 쓰는 계약(서명 봉투, 지시 여섯, 영수증, 보고, 전송 규칙, 거절 사유)이다. 코드는 `src/contract/v1/`이고 다른 코드는 `index.ts`만 import한다. 요약 표는 `src/contract/v1.md`.

- 입출력이 없는 순수 모듈이다. 시계, 키, 세대, nonce 저장소, 무작위 값은 인자로 받는다. `test/contract/static.test.ts`가 import와 API를 막는다.
- **판 규칙:** main에 병합된 판 안에서 칸, 동작, 받는 쪽 거절 경계(수명 상한, 시계 오차, 맞춤 대기 기한, 임대 상한, 크기·개수 상한, 허용 값, 거절 사유)를 바꾸지 않는다. 바꾸면 새 판을 만든다. `v2`는 현관 계약(아래)의 이름이고, 실행기 계약의 다음 판의 이름은 그때 정한다. 병합 전의 판은 아직 아무도 고정하지 않았으므로 그 PR 안에서 고친다. `limits.ts`에서 "기본값(관리자 미확정)"으로 적은 것은 내는 쪽 기본값(예: 맞춤 봉투의 발급 수명 `STOP_SYNC_TTL_MS`)과 운영 숫자(전달 상한, 갱신·끊김 시간 등)뿐이다. 이것들은 받는 쪽 경계 안에서만 같은 판에서 바꾼다(예: `STOP_SYNC_TTL_MS`는 `STOP_SYNC_TTL_MAX_MS` 15초 이하). 경계와의 관계는 시험이 지킨다.

### fixture

`contracts/fixtures/v1/accept/`와 `reject/`에 사례 하나가 JSON 파일 하나다. 다른 구현(현관 등)은 우리 코드 없이 이 파일만 읽어 자기 검증기를 시험한다.

- 사례의 칸: `keys`(믿는 공개 키, 주체 이름 → Ed25519 32바이트의 base64url), `context`(`now`, `expected_recipient`, `stop_generation`(`null`은 세대 없음), `stop_sync_challenge`(기다리는 정지 세대 맞춤의 `challenge`와 그 요청을 실은 시각 `sent_at`, 없으면 `null`), `run_generations`, `spent_nonces`), `message`(봉투), `expect`(`{ok: true, adopted_stop_generation}` 또는 `{ok: false, reason}`. `adopted_stop_generation`은 받아들이며 올린 정지 세대, 아니면 `null`), `signing_input`(서명한 바이트의 글).
- 거절 사례는 `base`(통과 사례)에서 `changed`에 적은 곳만 다르다. 시험이 이것을 대조한다.
- **개인 키는 저장소에 없다.** `bun run fixtures`가 부를 때마다 주체별 키를 새로 만들어 서명하고 공개 키만 파일에 쓴다. 그래서 사례 하나만 고쳐 다시 서명할 수 없고 늘 전부 다시 만든다(모든 파일의 서명과 키가 바뀐다). 사례를 지웠으면 그 파일도 지운다(시험이 남은 파일을 잡는다).

## 계약 `olive-control/v2` (현관, 후보)

현관과 감독 사이의 계약이다(D-65·D-66·D-68). 실행기 연결은 `olive-control/v1`을 그대로 쓰고, 감독은 연결의 상대마다 판을 대조한다. 코드는 `src/contract/v2/`이고 다른 코드는 `index.ts`만 import한다. 요약은 `src/contract/v2.md`(맨 위에 동작 스물넷의 전체 표).

- **후보다.** `v2.md`의 머리와 모든 표본의 `"status": "candidate"`는 현관(O08)이 이 표본으로 자기 검증기를 독립 검증하기 전이라는 표시이고, 그때까지 표본은 상호 운용의 증거가 아니다. **후보로 표시된 판은 main에 있어도 고칠 수 있고, 현관이 독립 검증해 후보 표시를 떼는 PR에서 굳는다**(관리자 결정 2026-11-20). 굳은 뒤에는 판 규칙(위 v1 절)이 v2에도 같아서, 칸, 동작, 받는 쪽 거절 경계를 바꾸려면 새 판을 만든다. `v2.md`가 값 옆에 적은 "후보"(관리자가 숫자를 따로 정하지 않은 상한)도 받는 쪽 경계면 후보 표시를 뗄 때 함께 굳는다. **후보인 동안에는 이 계약으로 실제 연결을 켜지 않는다.** 실행기 계약 v1의 판 규칙은 이 결정과 무관하게 그대로다.
- **v1과 다른 점.** 정지·실행 세대는 머리가 아니라 효과 동작의 본문에 실려 서명에 묶이고, 받는 쪽이 자기 권위 값과 대조해 옛 세대를 거절한다. 연결은 인사(`handshake`)로 시작해 판과 정책 revision을 대조한다. 정책이 어긋난 연결에서는 뜻이 고정된 사실의 조회와 정지의 준비·확정만 받는다. 효과 요청은 (보낸 쪽, `job_id`)로 가리키는 작업이고, 그 결과는 `job_lookup`·`job_status`로 묻는다. 서명 바이트는 v1 공개 면의 `canonicalJson`·`digestOf`로 만들어 정규화가 한 벌이다.
- **표본.** `contracts/fixtures/v2/frontdoor/accept/`와 `reject/`(통과 46, 거절 93). `bun run fixtures:v2`로 다시 만든다. v1 생성기(`bun run fixtures`)와 따로이고 v1 폴더에는 쓰지 않는다. 개인 키를 남기지 않는 것과 늘 전부 다시 만드는 것은 v1 표본과 같다.

## 폴더

```text
src/main/
├── supervisor.ts   # 감독 진입점(자리)
├── executor.ts     # 작업자 실행기(제어 컨테이너) 진입점: 환경 → 조립(src/executor/runtime.ts)
├── role-agent.ts   # 역할 컨테이너의 대리 진입점: 환경 → prepare → 제어 소켓에 붙음
├── no-role.ts      # 이미지 기본 명령: 역할을 고르지 않으면 실패
└── placeholder.ts  # 자리 진입점이 함께 쓰는 종료 코드와 메시지
src/contract/v1/    # 계약 olive-control/v1(순수 모듈), 요약은 src/contract/v1.md
src/contract/v2/    # 계약 olive-control/v2(현관과 감독, 후보), 요약은 src/contract/v2.md
src/executor/       # 작업자 실행기의 핵심(환경을 읽지 않는다. 실제 파일·시계·소켓은 진입점이 넘긴다)
├── runtime.ts      # 기동 조립: 재료 → 저장소 → worker → 대리 hello → recover → 감독 소켓 하나
├── store.ts        # 지속 상태: 저장소 ID, 정지 세대, nonce, 실행 상태와 사건의 전이(commit), 연산별 저장 장애, 장부 대조와 표식
├── worker.ts       # 지시 처리, 효과 직전 확인, 영수증·결과 보고, 재시작 뒤 대조
├── link.ts         # 연결 하나의 수명: 정지 세대 맞춤 → hello → 재전송
├── profile.ts      # 역할 프로필, 허용 목록 환경, 자격 digest 대조
├── launcher.ts     # 역할 프로그램 띄우기(띄우는 곳은 여기 하나)
├── containment.ts  # 실제 전체 신호 능력을 만드는 제품 입구(PidSpace.record 한 자리)
└── containment-core.ts # PID 공간의 스캔·종료·세기 알고리즘(신호 능력을 스스로 만들지 않는다)
src/ledger/         # 감독 장부(SQLite)와 재시작 복원, 요약은 src/ledger/ledger.md
contracts/fixtures/v1/  # 계약 사례(accept/, reject/)
contracts/fixtures/v2/frontdoor/  # v2 표본(accept/, reject/, 후보)
test/               # 시험(*.test.ts)과 시험 명령(run.ts). test/contract/는 계약 시험과 fixture 생성, test/executor/는 실행기 시험과 가짜 역할 프로그램
```

### 실행기 시험의 실제 프로세스

`test/executor/containment.test.ts`의 실제 프로세스 사례는 `bwrap --unshare-pid --unshare-user`로 만든 PID namespace 안에서만 돈다. 그 안의 `kill(-1)`은 밖에 닿지 않는다. `bwrap`이나 비특권 user namespace가 없으면(이미지의 `test` 단계가 그렇다) 그 사례를 등록하지 않고 이유를 한 줄 찍는다. 개발 기계에서 반드시 돌리려면 `OLIVE_REQUIRE_BWRAP=1 bun run test`로 없을 때 실패하게 한다. 호스트의 PID 공간에서 정리 코드에 진짜 신호를 주는 시험을 쓰지 않는다.

GitHub 검사 `containment`(`.github/workflows/containment.yaml`)는 호스트 러너의 일반 계정으로 이 사례만 돌리고, `test/containment-junit.ts`가 JUnit 결과를 XML 문서로 해석해, 통과한 "실제 프로세스" 사례의 이름 집합이 그 파일의 기대 이름 목록(`EXPECTED`, 29개)과 정확히 같고 skip·todo·실패가 0개일 때만 성공시킨다. 사례를 더하거나 빼거나 이름을 바꾸면 그 목록을 같은 변경에서 고친다. 이 검사는 러너의 일회용 가상 머신에 Ubuntu `apparmor-profiles` 패키지가 주는 bwrap 전용 AppArmor 예외 프로필(`/usr/share/apparmor/extra-profiles/bwrap-userns-restrict`) 하나만 올리고, 머신 전체의 user namespace 제한(`kernel.apparmor_restrict_unprivileged_userns`)은 그대로 둔다. `build / test`는 이미지 빌드 안에서 돌아 bwrap이 없으므로 여전히 이 29개를 돌리지 않는다.

- harness(`containment-harness.ts`)는 실제 신호를 쓰기 전에 bwrap이 만든 공간 안인지 스스로 확인한다(시험이 넣는 `--setenv` 표식, 자기 번호 1·2, 호스트가 아닌 `uid_map`). 아니면 신호 없이 끝난다.
- `python3`(`/usr/bin/python3`)가 없으면 `nondumpable`·`zombieleader`·`tighthop` 사례만 등록하지 않고 이유를 찍는다. `nsenter`(`/usr/bin/nsenter`)가 없으면 `foreign` 사례만 등록하지 않는다.
- `foreign` 사례는 시험이 bwrap 공간 밖에서 프로세스 하나를 합류시켜, 전체 신호가 나가지 않고 후손이 살아남는 것을 본다. `latespawn`·`nondumpable`은 해당 조건이 실제로 성립했는지 그 프로세스가 증인 파일에 직접 적는다(`latespawn`은 TERM 처리 중 새로 뜬 후손 자신이 적는다).
- 일반 실행기 시험(`worker`·`ordering`·`recovery`·`hardening`·`evidence`)이 띄운 역할 프로그램은 그 자식의 핸들(`SpawnedChild`)로만 끝낸다. 끝난 자식의 숫자 PID에 신호를 보내지 않는다(번호가 재사용되면 무관한 프로세스가 맞는다).

### PID 공간 정리가 증명하는 것과 기대는 것

`kill(-1)`은 호출자의 PID 공간 전체에 간다. 그 공간이 전용인지는 코어가 다 증명할 수 없어 둘을 나눈다.

**코어가 스스로 확인한다(`containment-core.ts`):**

- 기록할 때 자기와 PID 1 밖의 프로세스가 없고, 기준 스캔이 경합하지 않았다.
- 스캔과 신호마다 PID namespace와 `/proc`이 기록한 그대로다. 다르면 신호를 보내지 않고 남은 수를 `null`로 답한다.
- 전체 신호는 바로 앞 스캔의 확인이 완전할 때만 보낸다. 공간 동일성·목록·상태·부모·합류 여부를 확인하지 못했으면 보내지 않고 슬롯을 미확인으로 둔다. 부모가 공간 밖으로 보인 프로세스가 남아 있는데 스레드만 읽는 사이 사라져 생존을 가를 수 없는 경우도 같다. 프로세스 자체가 사라졌거나 부모가 공간 안인 프로세스의 스레드가 사라진 단순 경합은 막지 않는다(fork 연쇄를 끝낼 수단이 이 신호다).
- 그 스캔에 부모가 공간 밖인 살아 있는 프로세스(PPid 0, 공간의 init과 자기 제외. 리더가 Z여도 산 스레드가 있으면 살아 있다)가 보이거나 다른 계수가 이미 그것을 봤으면 신호를 보내지 않는다. 그 뒤로는 다시 보내지 않고 0도 말하지 않는다.

**호출자의 보증에 기댄다(`dedicated: true`):**

- 이 공간을 전용으로 만들고 독점하는 쪽이 따로 있다. `dedicated: true`는 그 보증이고 코어는 증명하지 못한다.
- 합류한 프로세스의 부모가 먼저 끝나면 공간의 init 밑으로 옮겨져 PPid 0이 사라진다. 스캔과 신호 사이에 들어온 프로세스도 볼 수 없다.

**조립(U3b)이 지킬 조건:** 전용 PID 공간 안에서만 `PidSpace.record({ dedicated: true })`를 부르고, 그 공간에 다른 작업을 합류시키지 않는다(`exec` 류의 진입 포함). 제품 코드는 `containment-core.ts`를 직접 import하지 않는다(`static.test.ts`가 막는다). 전용 공간을 누가 만들고 독점하는지는 U3b와 배포 쪽이 정한다. 실행기만 다시 뜨고 같은 공간에 앞 작업의 후손이 남으면 기준 스캔이 `baseline_not_clean`으로 거부해 `recover`에 정리 능력을 넘길 수 없으므로, U3b는 파드·컨테이너 재시작 때의 공간 수명을 정하고, 거부되면 슬롯을 보류한 채 그 공간의 종료를 밖에서 확인한다.

### 알려진 결함

아래는 이 코드가 **아직 보장하지 않는 것**이고, 조립하는 쪽이 지킬 조건이다. 조립(`src/executor/runtime.ts`)은 저장소의 낮은 쓰기 입구를 부르지 않고(상태와 사건은 `WorkerExecutor`로만 만든다), `recover`가 거절되면 연결 전에 87로 끝나며, 연결 뒤 지시 처리가 던지면 그 `WorkerExecutor`를 버리고 89로 끝나 컨테이너 재시작에 맡긴다(아래 "작업자 실행기 진입점").

- **저장소의 낮은 쓰기 입구:** `beginRun`과 `addOutbox`는 상태의 전제와 사건 ID의 중복을 대조하지 않고 쓰고 `commit`은 새 사건의 실행·세대와 배치 안의 ID 중복을 보지 않으므로, 이 입구에 임의의 기록이나 사건을 넘기면 전제 없는 상태가 적히거나 기존 사건 파일이 덮인다. 닫는 조건(조립): 실행 상태와 사건은 `WorkerExecutor`로만 만들고, 임의의 `RunRecord`, 원시 outbox 사건, 다른 실행의 사건을 섞은 배치를 저장소에 넘기지 않는다.
- **첫 접수 영수증의 서명 실패:** 시작 기록을 적은 뒤 첫 `receipt_accepted`의 서명이 예외를 던지면 사건 없는 `preparing` 기록이 슬롯을 쥔 채 남아, 서명이 회복돼도 재시작 전까지 새 시작을 받지 못하고 같은 ID의 재전송에도 답하지 못한다. 닫는 조건(조립): 첫 사건을 예약하기 전에 로컬 서명이 실패하면 그 `WorkerExecutor`를 계속 쓰지 않고 버린 뒤, 서명이 회복되면 기동 순서대로 다시 연다.
- **끝난 실행의 재정리 중 종료 영수증 서명 실패:** 이미 끝난(도는 실행이 아닌) `unknown_running`을 취소로 다시 정리하다 남은 수 0을 보고 `checking`을 예약한 뒤 그 `receipt_stopped`의 서명이 실패하면, 그 실행은 `checking`에 남아 재시작 전까지 슬롯을 쥐고 서명이 회복돼도 후속 취소가 그것을 다시 정리하지 않는다. 닫는 조건(조립): 지시 처리(`Connection.receive`)나 `recover`가 로컬 서명 예외로 거절되면 그 `WorkerExecutor`를 버리고, 서명이 회복되면 기동 순서대로 다시 연다(기동 복원이 `checking`을 다시 센다).

### 작업자 실행기가 감독 쪽에 기대는 것

v1을 바꾸지 않고 실행기가 정한 동작이다. 감독 작업은 이것을 전제로 한다.

- **첫 임대:** `task_start`에는 임대 칸이 없어 첫 임대는 `issued_at + RUN_LEASE_MAX_MS`(30초)다. 늦게 받아도 도착 때부터 새로 주지 않는다. 그보다 작은 `run_renew`는 임대를 줄이지 않는다(늘리기만 한다). 이미 끝난 임대는 갱신으로 되살리지 않는다.
- **시작을 받지 않을 때는 답하지 않는다:** 슬롯을 쥔 실행이 있거나, revision이 다르거나, 접수가 닫혔거나, 확정되지 않은 실행이 `STATUS_MAX_RUNS`(8)개에 이르면 영수증 없이 버린다. 감독은 같은 ID를 `status_query`로 다시 묻고, `not_known`을 종료나 새 실행 허가로 해석하지 않는다. 확정(`result_finalize`)이 실행기의 장부를 비운다. 사건이 하나도 없고 마지막 영수증도 없는 `preparing` 기록은 재시작 뒤 접수로 치지 않는다(`not_known`으로 답하고 복구하지 않는다). 그 파일은 볼륨에 남지만 점유 수에 들어가지 않는다.
- **결과 모양 검사:** 역할 프로그램의 결과는 `report_result` 본문 검사로 모양·크기를 본다. 그 실행의 자격 값 원문 전체가 결과의 한 글(값이나 이름)에 그대로 들어 있으면 원문 없이 `outcome: "failed"`의 고정 결과를 보낸다. 일부만 쓴 값, base64 같은 변환, 여러 값으로 나눈 조각은 이 대조의 보장 밖이다.
- **임대 만료는 `exit: "failed"`다:** 감독은 `failed`만으로 취소·정리·소멸을 추정하지 않는다. 소멸은 `receipt_stopped`(남은 0)로만 안다. 제때 끝난 프로그램은 stdout을 읽는 사이 임대 시각이 지나도 끝난 시각으로 판정한다.
- **영수증은 요청마다:** 같은 `request_id`·같은 본문의 재전송에는 쓰는 중이어도 같은 영수증(재시작 뒤에도 같은 ID)을, 다른 `request_id`의 후속 취소·확정에는 그 요청의 영수증을 낸다. 새 요청의 영수증은 지금 세대·지금 연결이고 접수가 열려 있을 때만 낸다(멈추는 효과는 그와 무관하게 난다). 같은 `request_id`에 본문이 다르면 답하지 않고 마지막 영수증도 다시 보내지 않는다. 아는 실행의 `task_start`는 처음 접수한 지시와 본문이 같을 때만 답한다. 끝나지 않은 정리 의도의 요청은 바뀌지 않는다: 다른 요청이 지우기를 이어도 정리 영수증은 처음 요청의 예약 ID로 남고, 그 요청은 정리가 확정된 뒤 자기 영수증을 따로 받는다. 이미 끝난 효과(종료, 지우기)는 반복하지 않는다.
- **성공 확정은 결과 digest를 대조한다:** `result_finalize(outcome=succeeded)`의 `result_digest`가 실행기가 보낸 `report_result`의 결과와 다르면 정리 전·중·후 어느 때든 지우지도 답하지도 않는다. 새 요청의 영수증은 지금 세대·지금 연결에서만 낸다.
- **상태는 사건 뒤에 말한다:** `status_report`·`hello`의 상태와 `last_receipt_id`는 파일에 적힌 것이다. `ready_result`는 종료 영수증과 결과가, `finalized`는 종료·정리 영수증이, `failed_stopped`·`not_started`·`cleanup_pending`은 종료 영수증이 본문까지 검증돼 있을 때만 그 상태로 답한다. 기동 대조가 저장된 사건의 본문 검사에 닿기 전에 실패하면(시계·이름 등 로컬 실패) `WorkerExecutor`를 만들지 않으므로 `recover`도 연결도 시작하지 않고, 그 로컬 오류를 이유로 손상 표식을 만들지 않는다(앞서 입증된 손상의 표식은 남는다). 실패가 사라진 뒤 다시 열면 대조가 처음부터 돈다. 지우는 중인 실행은 `cleanup_pending`으로 보이고 슬롯을 쥔다. `store.commit`을 지나는 전이는 쓰기 전에 그 상태의 전제와 정리 예약 영수증 ID의 소유를 대조하고, 어긋나면 쓰지 않고 그 실행을 보류한다(저장소의 다른 쓰기 입구와 새 사건의 소유는 위 "알려진 결함"). 재시작 대조는 마지막 영수증을 검증된 사건으로 다시 맞추며, 남은 수가 양수이거나 모름이어도 그렇다. 시작 영수증 없이 종료 영수증만 남은 실행은 띄우지 않았다는 증거가 없으므로 `failed_stopped`로 맺는다.
- **저장 장애는 로컬에서 가른다:** nonce·영수증·실행 기록을 적지 못하면 그 봉투는 `replayed`로 거절되거나 영수증을 보내지 않고, 실행기는 실패한 그 연산이 실제로 회복될 때까지 새 접수를 닫는다. 실행 기록 쓰기의 장애는 그 경로에 같은 내용을 다시 써 본 뒤에 풀린다. 장애가 남은 동안에는 이미 적은 영수증·보고도 보내지 않고 회복한 뒤 저장된 같은 본문을 보낸다(상태 조회의 응답은 파일에 적힌 상태만 말하므로 계속 답한다). 프로세스 정리와 재맞춤은 저장을 기다리지 않는다. 첫 종료든 재정리든 프로세스 정리가 끝나 남은 수가 양수나 모름으로 메모리에 반영되면, 그 결과의 기록이 멈춰도 그 뒤에 처리되는 검증된 취소는 종료를 다시 시도한다(정리의 백엔드가 아직 끝나지 않았으면 거기에 합류하고, 다른 실행이 도는 동안에는 옛 실행의 이름으로 정리하지 않는다). wire에 새 거절 사유는 없다(감독에는 응답 없음으로 보인다).
- **nonce 기록 장애는 연결을 끊고 실행을 닫는다:** 거절한 봉투가 비상 종료였을 수 있어 그 연결을 닫고, 진행 중인 준비·자격 요청을 거두고, 실행 중인 작업을 `exit: "failed"`로 끝낸다. 이미 끝난 것을 본 프로그램의 종료와 결과는 그대로 두고 남은 후손만 끝낸다. 거절한 봉투의 세대·요청 ID는 적용하지 않고 답하지도 않는다. 감독은 새 연결의 맞춤 뒤 같은 실행을 `status_query`로 묻는다.
- **세대가 어긋나면 연결을 닫는다:** 맞춘 연결에서 서명이 맞는 정지 세대 불일치가 오거나 정지 세대를 저장하지 못하면 실행기가 연결을 닫는다. 세대를 디스크에 쓰는 동안에는 그 세대로 서명한 재전송을 내보내지 않는다. 감독은 새 연결의 맞춤으로 다시 받는다.
- **설명할 수 없는 장부는 쓰지 않는다:** 저장소 ID를 잃었거나(`storage_id_lost`), 기동 때 센 점유·보류 실행이 `STATUS_MAX_RUNS`를 넘거나(`over_capacity`), 실행 기록을 잃은 사건이 있거나 실행 기록 폴더를 잃은(`run_missing`, `dir_missing`) 장부는 세대만 맞추고 `hello` 없이 연결을 닫는다. v1의 `hello`는 8건까지만 싣고 기록을 잃은 실행은 목록에 올릴 수 없으므로 감독은 그 장부의 실행을 끝내 알 수 없고, 운영자가 대조해야 한다. 사건도 마지막 영수증도 없는 `preparing` 기록은 이 점유 수에 넣지 않는다. 기동 뒤에는 점유·보류가 8건에 이른 동안 점유하지 않던 실행의 `result_finalize`에 정리를 예약하지 않고 답하지도 않는다(이미 점유 중인 실행의 정리 재시도는 받는다. 감독은 자리가 난 뒤 같은 확정을 다시 보낸다). 그래도 인사할 때마다 지금의 점유·보류 실행을 다시 세어, 실행 중에 선 보류나 저장소의 낮은 쓰기 입구로 8건을 넘는 동안은 일부만 담은 `hello`를 보내지 않고 연결을 닫으며(표식은 남기지 않는다) 8건 이하로 줄면 다음 연결에서 인사한다. 이미 적힌 `over_capacity` 표식은 저절로 지우지 않는다. 일부 사건만 설명할 수 없으면(`outbox_body`, 세대가 어긋난 `run_missing`, `receipt_missing`, `receipt_mismatch` 등) 접수를 닫고, 그 사건이 속한 실행이나 상태의 전제 사건·포인터가 어긋난 실행은 상태·사건·정리 승인을 함께 보류한다. 그 실행은 `unknown_running`으로 답하고, 마지막 영수증을 말하지 않고, 사건을 보내지 않고, 폴더를 지우지 않는다. 프로세스를 끝내고 세는 일은 계속하지만 그 결과로 새 영수증이나 완료 상태를 맺지 않는다. `outbox_body`는 저장된 본문이 계약에 맞지 않을 때만 세운다. 저장한 사건을 다시 서명할 때 키·시계·서명기가 실패하면 장부의 손상이 아니라서 그 송신만 미룬다. 첫 접수 영수증의 서명 실패는 여기에 들지 않는다(위 "알려진 결함"). 판정은 볼륨의 `ledger-hold` 표식으로 다음 기동에도 남고, 운영자가 장부를 대조한 뒤 이 파일을 지워야 풀린다. 장부를 바꾸기 전에 표식의 지속을 확인한다: 기동 때 표식을 적지 못하면 저장소를 열지 않고, 실행 중이면 세대·상태 쓰기를 멈춘다. 판정이 서면 이미 시작한 파일 작업 하나만 끝나고, 그 뒤의 쓰기와 재확인 파일의 삭제는 표식이 적힌 것을 확인한 뒤에 시작한다.

## 작업자 실행기 진입점

작업자 실행기 파드는 컨테이너 둘이다(D-100). 제어 컨테이너는 `bun src/main/executor.ts`(키·TLS·저장소를 가짐), 역할 컨테이너는 대리 `src/main/role-agent.ts`가 PID 1이다(D-102). 환경을 읽는 곳은 이 두 파일뿐이고(`test/entrypoints.test.ts`), 조립(`src/executor/runtime.ts`)은 값과 주입받은 파일·시계·타이머·소켓으로만 돈다.

### 기동 순서와 종료 코드

제어(`runtime.ts`의 `startExecutor`). 어느 단계든 실패하면 감독에 붙기 전에 그 코드로 끝난다.

1. 환경 읽기(`executor.ts`의 `settingsFromEnv`). 없거나 빈 값이거나 틀리면 **81**, 그 이름 하나를 찍는다. 연결 전에 거를 수 있는 꼴은 여기서 본다: 역할은 v1 역할 이름, 인스턴스는 실행기 이름(`executor/<역할>/<인스턴스>/<저장소 ID>`)의 칸(계약의 `parsePrincipal`), 정책 revision은 v1 revision 꼴, 주소는 `IPv4:포트`, 감독 DNS 이름은 RFC 1123 소문자 호스트 이름, 감독 URI는 `parseIdentityUri`의 감독 신원. 저장소를 만들기 전이다.
2. 재료 읽기: 역할 프로필 JSON(칸이 `RoleProfile`과 정확히 같고 `role`이 `OLIVE_ROLE`과 같음, `revision`은 v1 revision 꼴, 대리 링크의 `start`에 실림: argv 256개·고정 env 128개 이하이고 틀 크기 상한 안), 효과 서명 개인 키(Ed25519 PEM), 감독 공개 키(Ed25519, 공개 형식 PEM `PUBLIC KEY`만. 개인 키·인증서 PEM은 거절), TLS 인증서·키·신뢰 묶음. **82**.
3. 저장소 열기. **83**.
4. `WorkerExecutor`(기동 대조). **84**.
5. 대리 소켓 듣기: 지난 기동의 소켓 파일은 지우고(소켓이 아닌 파일이면 거절), bind 동안 umask `0177`, 듣기 뒤 `0606`. **85**.
6. 대리의 `hello`를 기다린다(상한 30초). hello는 받은 때(단조 시계)와 그 연결 세대로 판정한다: 상한 뒤에 받은 hello는 확인이 밀려도 늦은 것이고, 상한 전에 받은 hello는 확인이 밀려도 제때다. 없거나 늦거나 그 전에 두 번째 연결로 잠기면 **86**. 4의 기동 대조를 지난 장부에 끝을 맺지 못한 실행(`preparing`·`running`·`stopping`·`checking`·`unknown_running`)이 있거나 장부가 보류됐으면 원격을 처음부터 잠그고(`inheritedUnverified`) 기다리지 않는다. 잠긴 원격은 어떤 `hello`도 받지 않아, 기다리면 감독에게 그 실행을 알릴 길이 없다. 사건도 마지막 영수증도 없는 최초 `preparing`은 기동 대조가 접수가 아니라고 거르므로 잠금에 들지 않는다.
7. `recover`. 거절되면(로컬 서명 실패 등) **87**. 그 사이 대리 연결이 바뀌었으면(인사한 세대가 끊기고 새 세대가 붙음) 6의 상한에 남은 시간 안에서 지금 세대의 `hello`를 다시 기다린다. 없으면 **86**. 여기부터 감독 소켓 `start`까지 기다림이 없다.
8. `ExecutorLink` 하나, TLS 클라이언트, 감독 소켓 하나 `start`. 클라이언트(재료)나 소켓(정책)을 만들지 못하면 **88**.
9. `link.tick`·`worker.tick`을 1초마다 부른다.
10. 붙은 뒤 지시 처리(`Connection.receive`)가 던지거나(첫 접수·재정리 종료 영수증의 로컬 서명 실패 등) tick이 던지거나 다음 tick·다시 붙기 타이머를 걸지 못하면, 그 `WorkerExecutor`를 더 쓰지 않고 **89**로 끝나 컨테이너 재시작에 맡긴다. 지시 처리의 거절은 연결이 먼저 닫혔어도(상대가 끊음 등) 끝내기로 이어지고, 그 순간부터 새 연결을 열지 않는다. 끝내기는 타이머에 기대지 않고, 멈춤 상한을 걸 타이머가 고장 났으면 `stop()`을 기다리지 않고 TLS 클라이언트와 대리 소켓을 닫는다. 프로세스 안에서 다시 열지 않는다(같은 저장소를 두 객체가 쥐지 않는다).
11. SIGTERM·SIGINT면 **0**. 처리기는 기동 전에 건다(이 프로세스가 컨테이너의 PID 1이면 커널은 처리기 없는 신호를 버린다). 기동을 마친 뒤면 소켓 `stop()`을 기다린 뒤(상한 10초) TLS 클라이언트와 대리 소켓을 닫는다. 기동 중(2~7, hello 대기 포함)이면 그 기다림이 끝나는 대로 기동을 멈추고 감독에 붙지 않으며, 연 대리 소켓을 닫는다. 연 저장소는 닫는 입구가 없어 프로세스 종료에 맡긴다.

대리(`role-agent.ts`): 환경이 없거나 절대 경로가 아니면 **81**. `RoleAgent.prepare`(non-dumpable 78, PID 1 79, 정리 코어 기록 80)가 소켓보다 먼저다. 제어가 아직 듣지 않으면 0.5초마다 다시 붙고 60초 안에 못 붙으면 **82**. 60초는 단조 시계로 재고 다시 붙기 직전·붙기가 끝난 때·붙는 중의 기다림에 모두 건다. 상한 뒤에 늦게 돌아온 연결은 hello 없이 닫는다. 붙으면 `hello`. 붙은 뒤 소켓이 닫히면 `linkClosed()`로 실행을 멈추고 75로 끝난다(76·77은 `src/agent/agent.md`).

같은 응답 상한(10초, `limits.STOP_GRACE_MS` 5초 + 5초) 하나를 worker의 `exitWaitMs`와 원격의 `replyWaitMs`에 넘기고, 원격의 `runtime.now`에는 worker의 상한 타이머(전역 `setTimeout`)와 시간 기준이 같은 `performance.now`를 넘긴다. worker·link·저장소·TLS의 시계는 벽시계다. 대리의 `runtime.now`도 벽시계다(`start`의 기한·임대 끝과 바로 견준다).

운영 숫자는 `executor.ts`의 임시값이다: hello 상한 30초, tick 1초, 멈춤 상한 10초, 다시 붙기 1초에서 30초까지 2배씩(흔들림 20%), 받아 둘 양 1MiB. 실측 뒤 바꾼다.

### 환경

제어 컨테이너. 빈 값은 없는 것과 같다. 경로 칸은 절대 경로여야 한다. 꼴이 틀린 값도 81이다(위 1).

| 이름 | 뜻 | 출처 | 없을 때 |
|---|---|---|---|
| `OLIVE_ROLE` | v1 역할 이름(계약의 역할 다섯 중 하나). 대상 ID가 아니다: 읽기 대상 `reader` → `isolated_reader`, `diagnosis` → `diagnosis` | 차트(지금 차트는 대상 ID를 넘긴다. H-split이 역할 이름으로 바꾼다) | 81 |
| `OLIVE_SUPERVISOR_ADDR` | 감독 주소 `IPv4:포트` | 차트 | 81 |
| `OLIVE_SUPERVISOR_SERVER_NAME` | 감독 인증서의 DNS SAN | 차트 | 81 |
| `OLIVE_SUPERVISOR_URI` | 감독 인증서의 URI SAN | 차트 | 81 |
| `OLIVE_STORE_DIR` | 저장소 폴더(실행기마다의 PVC 아래, D-75) | 차트 | 81 |
| `OLIVE_TLS_DIR` | 그 안의 `tls.crt`·`tls.key` | 차트(PKI가 켜진 때만) | 81, 파일이 없으면 82 |
| `OLIVE_TRUST_DIR` | 그 안의 `ca-bundle.pem`·`supervisor-signing.pub`(감독 공개 키) | 차트(신뢰 ConfigMap. 공개 키 파일은 차트 값이 있을 때만) | 81, 파일이 없으면 82 |
| `OLIVE_SIGNING_KEY_FILE` | 효과 서명 개인 키 파일(D-73, 제어 컨테이너에만) | 미정(Infisical → Secret 마운트, 차트 PR-B) | 81, 파일이 없으면 82 |
| `OLIVE_PROFILE_FILE` | 역할 프로필 JSON 파일 | 미정(O11·O12) | 81, 파일이 없으면 82 |
| `OLIVE_INSTANCE` | 실행기 이름의 인스턴스 칸 | 미정 | 81 |
| `OLIVE_POLICY_REVISION` | 정책 revision | 미정 | 81 |
| `OLIVE_AGENT_SOCKET` | 대리가 붙는 경로 유닉스 소켓(링크 폴더 안) | 미정(차트 분할 H-split) | 81 |

역할 컨테이너는 `OLIVE_AGENT_SOCKET` 하나를 읽는다(제어와 같은 경로, 미정, 없으면 81).

### 뒤 조각이 지켜야 할 것

- **차트 분할(H-split):** 컨테이너 둘, `shareProcessNamespace` 없음, 역할 uid ≠ 제어 uid. 링크 폴더(emptyDir)는 제어에 쓰기, 역할에 읽기 전용이고 두 컨테이너의 `OLIVE_AGENT_SOCKET`이 그 안의 같은 경로다. 소켓 파일은 `0606`이다: D-103으로 역할 컨테이너가 제어의 그룹에 들지 않아 기타 권한으로 붙는다. 공유 보조 그룹을 쓰기로 바꾸면 `executor.ts`의 값을 `0660`으로 좁힌다. init이 이 이미지의 대리를 역할 컨테이너에 놓는다(D-103, 실행 파일의 꼴 미정). 환경 이름은 위 표에 맞춘다. 키·TLS·저장소 볼륨은 제어에만, 역할 컨테이너에 exec·프로브를 두지 않는다.
- **역할 값(H-split):** 차트는 `OLIVE_ROLE`에 대상 ID가 아니라 v1 역할 이름을 넘긴다(대상 `reader` → `isolated_reader`, `diagnosis` → `diagnosis`). 지금 차트처럼 대상 ID를 그대로 넘기면 읽기 실행기는 81로 끝난다. 실행기는 대상 ID를 역할로 옮기지 않는다: 한 대상에 여러 역할이 붙을 수 있다(D-64).
- **서명 키(PR-B, H-split 뒤):** `OLIVE_SIGNING_KEY_FILE`이 가리키는 Ed25519 PEM을 제어 컨테이너에만 붙인 Secret 파일로 준다(TLS 키와 같은 꼴). 환경에는 경로만 둔다(아래 "공개 저장소").
- **감독 공개 키·인스턴스 이름·정책 revision·역할 프로필:** 공개 키는 신뢰 ConfigMap의 `supervisor-signing.pub`를 읽는다(차트 값이 비면 파일이 없어 82, 공개 형식 PEM이 아니면 82). 차트도 공개 형식만 넣어야 한다: 실행기는 이미 잘못 배포된 개인 키의 노출을 되돌리지 못한다. 인스턴스 이름과 정책 revision의 출처, 역할 프로필의 자리(O11·O12)는 정하지 않았다. 값은 위 1·2의 꼴(v1 revision, 실행기 이름 칸, 링크가 싣는 argv·env 크기)에 맞춘다.
- **회복 길(D-104, 이 진입점에 없음):** 실행 중 링크가 끊기면 지금은 원격이 잠기고 그 실행은 슬롯을 쥔 `unknown_running`으로 남는다(프로세스는 끝나지 않는다). D-104의 정한 코드로 끝나 파드 전체를 다시 띄우고 init의 새 세대 표식을 본 뒤 `inheritedUnverified: false`로 넘기는 길은 뒤 조각이다. 그 전에는 물려받은 실행이 있는 기동마다 원격이 잠겨 새 실행을 띄우지 않는다.
- **작업 폴더(O13):** 제어 컨테이너는 실행마다 만드는 폴더가 없어 `RunSpace`(`noRunFiles`)는 준비하지 않고, 지우기는 확인할 수 없어 언제나 "지우지 못함"(false)으로 답한다. 그래서 확정(`result_finalize`)을 받은 실행은 `cleanup_pending`으로 슬롯을 쥔 채 남고 `receipt_cleaned`는 나가지 않는다(감독은 그 실행의 슬롯을 풀지 않는다). **O13 전에는 실행기 하나가 작업 하나를 확정받은 뒤 새 `task_start`를 받지 않는다**(슬롯을 쥔 실행이 있으면 답하지 않는다, 위 "작업자 실행기가 감독 쪽에 기대는 것"). 재시작해도 그 기록은 남는다. 역할 컨테이너의 작업 폴더를 실행마다 지우고 그것을 확인한 뒤에만 `true`를 돌려주는 일은 O13이 이 자리를 바꿔 정한다.

## 공개 저장소

tailnet 이름(`*.ts.net`)과 Tailscale 주소를 코드·로그·이미지에 두지 않는다(공용 빌드가 막는다). 시크릿 값은 저장소·로그·이미지에 두지 않는다. 개발·빌드·시험의 비밀은 Infisical에서 환경변수로만 받고 파일(`.env` 등)로 만들지 않는다. 실행 시의 키는 다르다: 작업자 실행기는 키 **경로**만 환경에서 읽고, PEM **값**(효과 서명 개인 키, TLS 키)은 제어 컨테이너에만 붙인 Secret 파일에서 읽는다(D-73·D-100).
