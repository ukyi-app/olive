# 올리브 이미지 계약(감독과 작업자 실행기가 이 이미지 하나를 쓰고, 역할은 실행 명령으로 고른다):
# - amd64 단일 빌드. app-build가 --platform linux/amd64로 부른다. 아키텍처별 파일을 받아야 하면
#   ARG TARGETARCH를 기본값 없이 선언한다. 기본값이 있으면 그것이 플랫폼 인자를 이긴다.
# - test 단계가 있어야 한다. app-build가 --target test로 시험을 돌린다. 공용 빌드는 마지막 단계를 이미지로 낸다.
# - 비root uid 65532. 루트 파일시스템은 읽기 전용이고 쓰기는 /tmp만 된다. 듣는 포트를 이미지에 적지 않는다.
# - hc 실행 파일과 /etc/claude-code가 없다(D-37). 모델 CLI를 넣지 않는다.
# - 들이는 실행 파일은 대리 하나다: /opt/olive/olive-agent(src/main/role-agent.ts를 컴파일한 glibc 동적 링크 파일, D-107).
#   이 이미지에서는 돌지 않고, init 컨테이너가 bun src/main/agent-install.ts로 공유 볼륨에 놓아 역할 컨테이너(glibc 계열)가 돌린다(D-103).
# 기반 이미지는 digest로 고정하고 Renovate가 올린다. 두 FROM, .bun-version, @types/bun은 같은 Bun 버전이다.

# 셸이 있는 slim 단계. 고정 파일과 기반 이미지 안의 실제 Bun 버전이 다르면 여기서 멈춘다.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS deps
WORKDIR /app
COPY .bun-version package.json bun.lock ./
RUN test "$(bun --version)" = "$(cat .bun-version)" \
  && bun install --frozen-lockfile --production

# 역할 컨테이너의 대리를 Bun 런타임째 파일 하나로 만든다. deps가 이미 대조한 bun을 쓰므로 내장 판이 .bun-version과 같다.
# - --target=bun-linux-x64: 빌드 호스트와 같은 대상이라 이 bun 자신을 담고 내려받지 않는다. musl 대상은 런타임을 내려받고,
#   dumpable.ts가 libc.so.6을 열어 musl에서는 prepare가 실패한다. 그래서 역할 이미지는 glibc 계열로 한정한다(D-107).
# - autoload 끔: 컴파일 파일은 기본으로 실행 폴더의 .env와 bunfig.toml(preload 포함)을 읽는다. 대리는 역할 컨테이너의 작업 폴더에서
#   prepare 전에 뜨므로, 끄지 않으면 그 폴더에 파일을 둘 수 있는 쪽이 대리의 환경을 바꾸거나 코드를 먼저 돌릴 수 있다.
FROM deps AS agent-build
COPY src ./src
RUN bun build --compile --target=bun-linux-x64 --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
  src/main/role-agent.ts --outfile /out/olive-agent

# 최종 이미지의 파일 내용. 마지막 단계는 이 위에 실행 설정만 얹는다.
FROM oven/bun:1.4.4-distroless@sha256:153a951ae40106e125898103e6e990ee0f38e6aee7f561029e26cf9fbed23470 AS runtime-files
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY --from=agent-build /out/olive-agent /opt/olive/olive-agent

# distroless에는 셸이 없어 최종 단계에서 RUN을 쓸 수 없다. 그래서 최종 이미지의 파일 내용을 셸이 있는 단계로 통째로
# 복사해 검사한다. 최종 단계는 runtime-files에 실행 설정(USER·ENTRYPOINT·CMD)만 더하므로 파일 내용은 같다.
# - Bun 버전: distroless의 bun을 직접 실행한다. 심링크면 /rootfs 밖(이 단계의 bun)을 가리킬 수 있어 일반 파일인지 먼저 본다.
# - hc: 이름이 hc인 것은 종류와 위치를 가리지 않고 하나도 없어야 한다(감독·작업자 파드에 hc가 없다, O09 완료 조건).
# - /etc/claude-code: 관리 설정이 있으면 옛 작성 어댑터가 시작을 거절한다(supervisor.md §5.1). 깨진 심링크도 막으려고 -L도 본다.
# - 대리: 일반 실행 파일이고, BUN_BE_BUN=1이면 대리 대신 내장 bun으로 돌아 그 판을 찍는다(제어와 같은 판인지).
#   이 단계는 glibc라 실제로 뜨므로, 환경 없이 띄우면 대리 진입점의 "환경 없음" 81로 끝나는지 본다(묶음이 진입점을 타는지).
FROM deps AS image-check
COPY --from=runtime-files / /rootfs/
RUN test -f /rootfs/usr/local/bin/bun && test ! -L /rootfs/usr/local/bin/bun \
  && test "$(env -i /rootfs/usr/local/bin/bun --version)" = "$(cat /app/.bun-version)" \
  && test -z "$(find /rootfs -name hc -print -quit)" \
  && test ! -e /rootfs/etc/claude-code && test ! -L /rootfs/etc/claude-code \
  && test -f /rootfs/opt/olive/olive-agent && test ! -L /rootfs/opt/olive/olive-agent && test -x /rootfs/opt/olive/olive-agent \
  && test "$(env -i BUN_BE_BUN=1 /rootfs/opt/olive/olive-agent --version)" = "$(cat /app/.bun-version)" \
  && { env -i /rootfs/opt/olive/olive-agent; test "$?" -eq 81; } \
  && touch /image-check.ok

# 위 검사 결과 파일을 받아 오는 것이 test가 image-check를 기다리게 하는 장치다. BuildKit은 목표 단계가 기대지 않는
# 단계를 건너뛴다. app-build의 push job은 test job 뒤에 같은 커밋·같은 digest로 다시 빌드한다.
FROM deps AS test
COPY --from=image-check /image-check.ok /tmp/image-check.ok
RUN bun install --frozen-lockfile
COPY . .
# `bun test`를 바로 부르지 않는다. 시험이 0개인 파일이 있어도 0으로 끝나기 때문이다. `bun run test`(test/run.ts)는
# JUnit 결과에서 파일마다 실제로 실행된 시험 수를 확인하고, 결과가 없거나 0개인 파일이 있으면 실패한다.
RUN bun run check && bun run test

# 역할을 고르지 않으면 실패하는 진입점을 기본으로 둔다. 파드는 command로 역할을 고른다(README "이미지 계약").
# ENTRYPOINT를 비워 command가 그대로 돌게 한다. 기반 이미지의 ENTRYPOINT(bun)에 기대지 않는다.
FROM runtime-files
USER 65532:65532
ENTRYPOINT []
CMD ["bun", "src/main/no-role.ts"]
