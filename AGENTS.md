# AGENTS.md

올리브(홈랩 봇)의 감독과 작업자 실행기 코드다. 둘은 이미지 하나를 함께 쓰고 역할은 실행 명령으로 고른다. 이미지 계약, 버전 고정, 시험 방법, 폴더 배치는 README.md에 있다. 설계와 결정의 기준은 homelab 저장소의 `docs/plans/2026-11-13-olive/`(`spec.md` §4.1·§5.1, `supervisor.md`, `issues/O09-supervisor.md`)다.

- 이 저장소는 homelab `apps/`에 등록하지 않는다. 이미지는 homelab `platform/` 값에 digest로 고정하고 사람 PR로만 올린다(D-18). main에 병합돼도 배포되지 않는다.
- 공개(public) 저장소다. 시크릿 값, tailnet 이름(`*.ts.net`), Tailscale 주소, 개인 이메일, 운영 지식을 코드·로그·이미지에 두지 않는다. 개발·빌드·시험의 비밀은 `infisical run`으로 환경변수에만 넣는다. 실행 시 작업자 실행기의 키는 경로만 환경에서 읽고 PEM 값은 제어 컨테이너에만 붙인 Secret 파일에서 읽는다(README "공개 저장소").
- 이미지에는 hc와 `/etc/claude-code`가 없다(D-37). Dockerfile의 `image-check` 단계가 빌드마다 확인한다. 실행기는 감독에 먼저 붙는 쪽이고 포트를 열고 듣지 않는다. 예외는 하나다: 역할 컨테이너의 대리가 붙는 경로 유닉스 소켓 하나를 `src/executor/agent-listener.ts`에서만 듣는다(D-102). TCP·abstract 소켓은 듣지 않는다(`test/executor/static.test.ts`).
- 감독이 듣는 곳은 실행기를 받는 TCP(`src/supervisor/transport/tls-server.ts`)와, 예외 하나인 감독 관리 통로의 경로 유닉스 소켓(`src/supervisor/admin/listener.ts`, `/tmp/olive-admin.sock`, 권한 0600)뿐이다. 관리 통로는 읽기 전용이다: 장부의 읽기 넷만 부르고 장부 쓰기·송신·도구 처리기의 포트를 쓰지 않는다(`test/entrypoints.test.ts`, `test/supervisor/admin/static.test.ts`, README "감독 관리 통로").
- 버전은 정확히 고정한다: Bun은 `.bun-version`·Dockerfile 두 FROM·`@types/bun`이 같은 값, npm 패키지는 정확한 버전, 기반 이미지는 digest. 최신 안정판보다 낮게 두면 그 이유를 고정한 자리 옆에 적는다.
- 시험은 `bun run test`로 돌린다. `bun test`는 시험이 0개인 파일을 통과시킨다. `bun run test`(`test/run.ts`)가 JUnit 결과에서 파일마다 실행된 시험 수를 확인한다. 시험 파일 이름은 점으로 시작하지 않는 소문자 `*.test.ts`만 쓴다. Bun이 시험으로 읽는 다른 이름(`.x.test.ts`, `x.TEST.ts`, `*.spec.ts` 등)은 실패한다(README "시험").
- 작업자 실행기(`src/executor/`)는 역할 프로필(프로그램·argv·작업 폴더·환경 이름)로만 띄운다. 지시 본문에서 명령·argv·환경을 읽는 코드, `launcher.ts` 밖의 프로세스 띄우기, `process.env` 읽기를 두지 않는다(`test/executor/static.test.ts`). 종료 확인 영수증은 남은 프로세스 0개를 센 뒤에만 낸다.
- `kill(-1)`이나 음수 PID로 가는 신호를 호스트의 PID 공간에서 실제로 보내는 시험을 쓰지 않는다. 그 호출은 사용자의 모든 프로세스를 끝낸다. 실제 프로세스 사례는 `bwrap` PID namespace 안에서만 돌린다(README "실행기 시험의 실제 프로세스").
- 호스트의 시험은 자기가 띄운 자식에게 그 자식의 핸들로만 신호를 보낸다. 끝난 자식의 숫자 PID에 보내지 않는다. 판정 규칙 시험은 `containment-core.ts`의 `PidSweep.establish`에 가짜 `/proc`·번호·신호 기록기를 함께 준다. 실제 전체 신호 능력은 `containment.ts`의 `PidSpace.record` 한 자리에서만 만들고, `src/`에서 `containment-core.ts`를 import하는 곳은 `containment.ts`뿐이다(`test/executor/static.test.ts`).
- 실행기에서 권한이 필요한 효과는 검증 뒤의 await를 지난 그 직전에 다시 본다. 폴더 준비·자격 요청·spawn은 `launchBlocked`(연결, 정지 세대의 저장, 접수, 취소, 기한, 임대), 임대 연장·폴더 지우기·새 요청의 영수증은 `authorized`(연결, 정지 세대의 저장, 접수)다(`worker.ts`).
- 실행 상태와 그 사건(영수증·보고)은 `store.commit` 한 자리로만 남긴다. 사건은 순번 차례로 적고 실행 기록은 그 뒤에 적는다. 사건을 판단에 쓰는 자리는 `store.validEvents` 하나다(`test/executor/static.test.ts`). 닫는 쪽 효과(프로세스 정리, 연결 닫기)는 저장을 기다리지 않고, 여는 쪽 효과는 실패한 그 연산이 회복된 뒤에만 열린다.
- `.github/CODEOWNERS`는 `* @ukkiee` 한 줄만 둔다. 줄을 더하면 homelab의 자동 배포 조건이 멈춘다.
- `.github/workflows/build.yaml`의 `uses:`는 태그 ref 그대로 둔다(파일 주석).

## Code Review Rules

- Write all review finding titles and descriptions in Korean.
- Write review summaries and explanations in Korean.
- Keep code identifiers, file paths, commands, and quoted code unchanged.
- 리뷰 요약과 모든 리뷰 코멘트(지적 제목·본문·설명)는 한국어로 쓴다.
- P0~P3 우선순위 표시와 그 형식은 그대로 둔다.
