// 모델 대신 도는 고정 역할 프로그램(시험용). 첫 인자가 동작을, 둘째 인자가 결과의 역할을 고른다.
// 띄운 후손은 시험이 끝낼 수 있게 pid를 stderr가 아닌 파일(FAKE_ROLE_PIDS, 있을 때만)에 적는다.
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv[2];
const role = process.argv[3] ?? "diagnosis";
const result = { role, outcome: "completed", summary: "가짜 역할 프로그램이 끝났다", items: [], refs: [] };
const done = () => process.stdout.write(JSON.stringify(result));
const forever = () => setInterval(() => {}, 1_000);

function descendant(stdio: "ignore" | "inherit"): void {
  const child = spawn("/usr/bin/sleep", ["300"], { detached: true, stdio: ["ignore", stdio, "ignore"] });
  const pids = process.env.FAKE_ROLE_PIDS;
  if (pids !== undefined && child.pid !== undefined) appendFileSync(pids, `${child.pid}\n`);
  child.unref();
}

switch (mode) {
  case "complete":
    done();
    break;
  case "fail":
    process.exitCode = 3;
    break;
  case "garbage":
    process.stdout.write("결과가 아니다");
    break;
  case "hang":
    forever();
    break;
  case "ignore-term":
    process.on("SIGTERM", () => {});
    forever();
    break;
  case "leave-descendant":
    descendant("ignore");
    done();
    break;
  case "hold-stdout":
    descendant("inherit");
    done();
    break;
  case "echo-credential": {
    // 받은 자격을 결과의 모든 글 칸에 되쓴다(결과로 자격이 새는 길의 시험용).
    const value = process.env.OLIVE_CREDENTIAL ?? "";
    process.stdout.write(
      JSON.stringify({
        role,
        outcome: "completed",
        summary: `요약 ${value}`,
        items: [{ kind: "finding", text: `항목 ${value}` }],
        refs: [{ kind: "path", ref: value, digest: null }],
      }),
    );
    break;
  }
  case "print-env":
    // 받은 환경을 그대로 작업 폴더에 적는다(허용 목록 확인용).
    writeFileSync(join(process.cwd(), "received-env.json"), JSON.stringify(process.env));
    done();
    break;
  default:
    process.exitCode = 64;
}
