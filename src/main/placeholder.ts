import pkg from "../../package.json" with { type: "json" };

// 종료 코드는 sysexits의 뜻을 빌린다. 0으로 끝나면 배포된 파드가 "떴다"로 읽히므로 자리 진입점은 늘 0이 아니다.
export const EXIT_NO_ROLE = 64;
export const EXIT_NOT_IMPLEMENTED = 69;

export type Role = "supervisor" | "executor";

export function exitNotImplemented(role: Role): never {
  console.error(`olive ${role} ${pkg.version} (bun ${Bun.version}): 아직 구현되지 않았다`);
  process.exit(EXIT_NOT_IMPLEMENTED);
}
