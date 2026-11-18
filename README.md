# olive

올리브의 감독과 작업자 실행기다. 감독은 모델이 아닌 프로세스로, 서명된 지시로 역할별 파드의 실행기에 작업자를 띄우게 하고 예산과 동시 실행 상한을 집행한다. 실행기는 감독에 먼저 붙어 연결을 유지하고 그 위로 지시를 받는다. 듣는 쪽은 감독이다.

지금은 뼈대다. 두 진입점은 기능 없이 "아직 구현되지 않았다"를 찍고 0이 아닌 코드로 끝난다.

설계와 결정은 homelab 저장소의 `docs/plans/2026-11-13-olive/`에 있다. 저장소 배치는 `spec.md` §4.1, 파드 배치는 `supervisor.md` §1.1, 이 저장소의 첫 일은 `issues/O09-supervisor.md`다.

## 배포

- homelab `apps/`에 등록하지 않는다. 감독은 모델 자격을 모두 쥐므로 main을 자동으로 따라가지 않는다(D-18).
- main에 병합하면 homelab 공용 빌드(`app-build`)가 이미지를 `ghcr.io/ukyi-app/olive`(공개 패키지)에 올린다. 배포 PR은 만들지 않는다.
- 배포는 homelab `platform/`의 값에 이미지 digest를 적는 사람 PR로만 한다.
- main은 PR과 code owner 리뷰로만 바뀐다. `.github/CODEOWNERS`는 `* @ukkiee` 한 줄만 둔다.

## 이미지 계약

- **하나의 이미지, 역할은 명령으로:** 감독과 작업자 실행기가 같은 이미지를 쓴다. 파드는 `command`로 역할을 고른다.
  - 감독: `["bun", "src/main/supervisor.ts"]`
  - 작업자 실행기: `["bun", "src/main/executor.ts"]`
  - 기본 명령(`src/main/no-role.ts`)은 역할을 고르라고 찍고 64로 끝난다. 이미지의 `ENTRYPOINT`는 비어 있어 `command`가 그대로 돈다.
- **종료 코드:** 64는 역할을 고르지 않음, 69는 아직 구현되지 않음.
- **사용자와 파일시스템:** 비root uid·gid 65532. 루트 파일시스템은 읽기 전용 전제이고 쓰기는 `/tmp`만 된다(파드가 emptyDir를 붙인다).
- **포트:** 이미지에 듣는 포트를 적지 않는다(`EXPOSE`·`PORT` 없음). 실행기는 듣지 않는다.
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

`test/`가 지금 지키는 계약: 고정한 버전이 서로 같다(`pins`), Dockerfile에 단계와 확인 줄이 있다(`dockerfile`), 진입점이 정해진 코드로 끝나고 실행기 쪽 코드에 듣는 API가 없다(`entrypoints`), `CODEOWNERS`·`build.yaml`·Renovate 정책(`repo`), 계약 `olive-control/v1`과 그 fixture(`contract/`).

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
- **판 규칙:** main에 병합된 판 안에서 칸, 동작, 받는 쪽 거절 경계(수명 상한, 시계 오차, 맞춤 대기 기한, 임대 상한, 크기·개수 상한, 허용 값, 거절 사유)를 바꾸지 않는다. 바꾸면 `v2`를 새로 만든다. 병합 전의 판은 아직 아무도 고정하지 않았으므로 그 PR 안에서 고친다. `limits.ts`에서 "기본값(관리자 미확정)"으로 적은 것은 내는 쪽 기본값(예: 맞춤 봉투의 발급 수명 `STOP_SYNC_TTL_MS`)과 운영 숫자(전달 상한, 갱신·끊김 시간 등)뿐이다. 이것들은 받는 쪽 경계 안에서만 같은 판에서 바꾼다(예: `STOP_SYNC_TTL_MS`는 `STOP_SYNC_TTL_MAX_MS` 15초 이하). 경계와의 관계는 시험이 지킨다.

### fixture

`contracts/fixtures/v1/accept/`와 `reject/`에 사례 하나가 JSON 파일 하나다. 다른 구현(현관 등)은 우리 코드 없이 이 파일만 읽어 자기 검증기를 시험한다.

- 사례의 칸: `keys`(믿는 공개 키, 주체 이름 → Ed25519 32바이트의 base64url), `context`(`now`, `expected_recipient`, `stop_generation`(`null`은 세대 없음), `stop_sync_challenge`(기다리는 정지 세대 맞춤의 `challenge`와 그 요청을 실은 시각 `sent_at`, 없으면 `null`), `run_generations`, `spent_nonces`), `message`(봉투), `expect`(`{ok: true, adopted_stop_generation}` 또는 `{ok: false, reason}`. `adopted_stop_generation`은 받아들이며 올린 정지 세대, 아니면 `null`), `signing_input`(서명한 바이트의 글).
- 거절 사례는 `base`(통과 사례)에서 `changed`에 적은 곳만 다르다. 시험이 이것을 대조한다.
- **개인 키는 저장소에 없다.** `bun run fixtures`가 부를 때마다 주체별 키를 새로 만들어 서명하고 공개 키만 파일에 쓴다. 그래서 사례 하나만 고쳐 다시 서명할 수 없고 늘 전부 다시 만든다(모든 파일의 서명과 키가 바뀐다). 사례를 지웠으면 그 파일도 지운다(시험이 남은 파일을 잡는다).

## 폴더

```text
src/main/
├── supervisor.ts   # 감독 진입점(자리)
├── executor.ts     # 작업자 실행기 진입점(자리)
├── no-role.ts      # 이미지 기본 명령: 역할을 고르지 않으면 실패
└── placeholder.ts  # 자리 진입점이 함께 쓰는 종료 코드와 메시지
src/contract/v1/    # 계약 olive-control/v1(순수 모듈), 요약은 src/contract/v1.md
src/ledger/         # 감독 장부(SQLite)와 재시작 복원, 요약은 src/ledger/ledger.md
contracts/fixtures/v1/  # 계약 사례(accept/, reject/)
test/               # 시험(*.test.ts)과 시험 명령(run.ts). test/contract/는 계약 시험과 fixture 생성
```

## 공개 저장소

tailnet 이름(`*.ts.net`)과 Tailscale 주소를 코드·로그·이미지에 두지 않는다(공용 빌드가 막는다). 시크릿 값은 저장소·로그·이미지에 두지 않고 Infisical에서 환경변수로만 받는다. 파일(`.env` 등)로 만들지 않는다.
