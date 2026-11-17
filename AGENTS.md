# AGENTS.md

올리브(홈랩 봇)의 감독과 작업자 실행기 코드다. 둘은 이미지 하나를 함께 쓰고 역할은 실행 명령으로 고른다. 이미지 계약, 버전 고정, 시험 방법, 폴더 배치는 README.md에 있다. 설계와 결정의 기준은 homelab 저장소의 `docs/plans/2026-11-13-olive/`(`spec.md` §4.1·§5.1, `supervisor.md`, `issues/O09-supervisor.md`)다.

- 이 저장소는 homelab `apps/`에 등록하지 않는다. 이미지는 homelab `platform/` 값에 digest로 고정하고 사람 PR로만 올린다(D-18). main에 병합돼도 배포되지 않는다.
- 공개(public) 저장소다. 시크릿 값, tailnet 이름(`*.ts.net`), Tailscale 주소, 개인 이메일, 운영 지식을 코드·로그·이미지에 두지 않는다. 비밀은 `infisical run`으로 환경변수에만 넣는다.
- 이미지에는 hc와 `/etc/claude-code`가 없다(D-37). Dockerfile의 `image-check` 단계가 빌드마다 확인한다. 실행기는 감독에 먼저 붙는 쪽이고 포트를 열고 듣지 않는다.
- 버전은 정확히 고정한다: Bun은 `.bun-version`·Dockerfile 두 FROM·`@types/bun`이 같은 값, npm 패키지는 정확한 버전, 기반 이미지는 digest. 최신 안정판보다 낮게 두면 그 이유를 고정한 자리 옆에 적는다.
- 시험은 `bun run test`로 돌린다. `bun test`는 시험이 0개인 파일을 통과시킨다. `bun run test`(`test/run.ts`)가 JUnit 결과에서 파일마다 실행된 시험 수를 확인한다(README "시험").
- `.github/CODEOWNERS`는 `* @ukkiee` 한 줄만 둔다. 줄을 더하면 homelab의 자동 배포 조건이 멈춘다.
- `.github/workflows/build.yaml`의 `uses:`는 태그 ref 그대로 둔다(파일 주석).

## Code Review Rules

- Write all review finding titles and descriptions in Korean.
- Write review summaries and explanations in Korean.
- Keep code identifiers, file paths, commands, and quoted code unchanged.
- 리뷰 요약과 모든 리뷰 코멘트(지적 제목·본문·설명)는 한국어로 쓴다.
- P0~P3 우선순위 표시와 그 형식은 그대로 둔다.
