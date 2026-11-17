# 올리브 이미지 계약(감독과 작업자 실행기가 이 이미지 하나를 쓰고, 역할은 실행 명령으로 고른다):
# - amd64 단일 빌드. app-build가 --platform linux/amd64로 부른다. 아키텍처별 파일을 받아야 하면
#   ARG TARGETARCH를 기본값 없이 선언한다. 기본값이 있으면 그것이 플랫폼 인자를 이긴다.
# - test 단계가 있어야 한다. app-build가 --target test로 시험을 돌린다. 공용 빌드는 마지막 단계를 이미지로 낸다.
# - 비root uid 65532. 루트 파일시스템은 읽기 전용이고 쓰기는 /tmp만 된다. 듣는 포트를 이미지에 적지 않는다.
# - hc 실행 파일과 /etc/claude-code가 없다(D-37). 모델 CLI를 넣지 않는다.
# 기반 이미지는 digest로 고정하고 Renovate가 올린다. 두 FROM, .bun-version, @types/bun은 같은 Bun 버전이다.

# 셸이 있는 slim 단계. 고정 파일과 기반 이미지 안의 실제 Bun 버전이 다르면 여기서 멈춘다.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS deps
WORKDIR /app
COPY .bun-version package.json bun.lock ./
RUN test "$(bun --version)" = "$(cat .bun-version)" \
  && bun install --frozen-lockfile --production

# 최종 이미지의 파일 내용. 마지막 단계는 이 위에 실행 설정만 얹는다.
FROM oven/bun:1.4.4-distroless@sha256:153a951ae40106e125898103e6e990ee0f38e6aee7f561029e26cf9fbed23470 AS runtime-files
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# distroless에는 셸이 없어 최종 단계에서 RUN을 쓸 수 없다. 그래서 최종 이미지의 파일 내용을 셸이 있는 단계로 통째로
# 복사해 검사한다. 최종 단계는 runtime-files에 실행 설정(USER·ENTRYPOINT·CMD)만 더하므로 파일 내용은 같다.
# - Bun 버전: distroless의 bun을 직접 실행한다. 심링크면 /rootfs 밖(이 단계의 bun)을 가리킬 수 있어 일반 파일인지 먼저 본다.
# - hc: 이름이 hc인 것은 종류와 위치를 가리지 않고 하나도 없어야 한다(감독·작업자 파드에 hc가 없다, O09 완료 조건).
# - /etc/claude-code: 관리 설정이 있으면 옛 작성 어댑터가 시작을 거절한다(supervisor.md §5.1). 깨진 심링크도 막으려고 -L도 본다.
FROM deps AS image-check
COPY --from=runtime-files / /rootfs/
RUN test -f /rootfs/usr/local/bin/bun && test ! -L /rootfs/usr/local/bin/bun \
  && test "$(env -i /rootfs/usr/local/bin/bun --version)" = "$(cat /app/.bun-version)" \
  && test -z "$(find /rootfs -name hc -print -quit)" \
  && test ! -e /rootfs/etc/claude-code && test ! -L /rootfs/etc/claude-code \
  && touch /image-check.ok

# 위 검사 결과 파일을 받아 오는 것이 test가 image-check를 기다리게 하는 장치다. BuildKit은 목표 단계가 기대지 않는
# 단계를 건너뛴다. app-build의 push job은 test job 뒤에 같은 커밋·같은 digest로 다시 빌드한다.
FROM deps AS test
COPY --from=image-check /image-check.ok /tmp/image-check.ok
RUN bun install --frozen-lockfile
COPY . .
RUN bun run check && bun test

# 역할을 고르지 않으면 실패하는 진입점을 기본으로 둔다. 파드는 command로 역할을 고른다(README "이미지 계약").
# ENTRYPOINT를 비워 command가 그대로 돌게 한다. 기반 이미지의 ENTRYPOINT(bun)에 기대지 않는다.
FROM runtime-files
USER 65532:65532
ENTRYPOINT []
CMD ["bun", "src/main/no-role.ts"]
