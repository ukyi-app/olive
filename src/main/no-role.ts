// 이미지의 기본 명령. 역할을 고르지 않은 파드가 조용히 성공하거나 아무 역할로나 뜨지 않게 한다.
import pkg from "../../package.json" with { type: "json" };
import { EXIT_NO_ROLE } from "./placeholder.ts";

console.error(
  `olive ${pkg.version}: 역할을 고르지 않았다. command로 bun src/main/supervisor.ts 또는 bun src/main/executor.ts를 준다`,
);
process.exit(EXIT_NO_ROLE);
