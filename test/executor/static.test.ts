// 실행기 코드의 정적 확인: 지시 본문에서 명령·argv·환경을 읽는 길이 없고, 띄우는 곳은 한 곳이며, 그 계획은 프로필에서만 온다.
// 듣는 곳은 대리가 붙는 경로 유닉스 소켓 한 파일뿐이고, 실행기 자신의 환경을 쓰지 않는다(연결의 실제 구현은 뒤 작업이다).
import { expect, test } from "bun:test";
import { list, readText } from "../files.ts";

const files = await list("src/executor/**/*.ts");
const code = async (file: string) =>
  (await readText(file))
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

// 실행기가 읽는 본문 칸. 지시(task_start·task_cancel·run_renew·result_finalize·status_query·ack)와 자기가 낸 영수증·보고의 칸뿐이다.
const READABLE = new Set([
  // 지시의 칸
  "run_id",
  "profile_revision",
  "policy_revision",
  "deadline_at",
  "credential",
  "reason",
  "lease_until",
  "run_ids",
  "ids",
  "outcome",
  "result_digest",
  // 자기가 낸 영수증·보고의 칸(재전송 대조, 정리 사실, 성공 확정의 결과 대조)
  "instruction",
  "receipt_id",
  "report_id",
  "instruction_request_id",
  "cleaned_at",
  "result",
]);

function bodyReads(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\bbody\??\.([A-Za-z_$][\w$]*)/g)) if (!READABLE.has(match[1]!)) found.push(`body.${match[1]}`);
  // 이름을 계산해 읽거나, 통째로 펼치거나 풀어 읽는 길도 없다.
  if (/\bbody\??\.?\[/.test(source)) found.push("body[...]");
  if (/\}\s*=\s*[\w.]*\bbody\b/.test(source)) found.push("본문 구조 분해");
  if (/\.\.\.\s*[\w.]*\bbody\b/.test(source)) found.push("본문 펼치기");
  if (/Object\.(entries|keys|values|assign)\([\w.]*\bbody\b/.test(source)) found.push("본문 열거");
  return found;
}

test("정적: 실행기 코드에 지시 본문에서 명령·argv·환경을 읽는 길이 없다(본문은 정한 칸만 이름으로 읽는다)", async () => {
  expect(files.length).toBeGreaterThanOrEqual(6);
  for (const file of files) expect(bodyReads(await code(file)), file).toEqual([]);
  // 대조군: 확인이 실제로 잡는다.
  expect(bodyReads("const a = verified.body.argv; const { env } = verified.body; spawn(...body.command); x = body['image'];")).toEqual([
    "body.argv",
    "body.command",
    "body[...]",
    "본문 구조 분해",
    "본문 펼치기",
  ]);
});

test("정적: 띄우는 곳은 launcher.ts 하나이고, 그 계획은 프로필에서만 만든다. 실행기 자신의 환경을 읽지 않는다", async () => {
  for (const file of files) {
    const source = await code(file);
    const spawns = /\bBun\.spawn(Sync)?\b|child_process|\bexecFile\b|\bBun\.\$/.test(source);
    expect(spawns, file).toBe(file === "src/executor/launcher.ts");
    expect(/\bprocess\.env\b|\bBun\.env\b|import\.meta\.env/.test(source), file).toBe(false);
  }
  // launcher와 profile은 계약의 지시 타입을 모른다(profile은 역할 이름의 타입만 쓴다).
  // scanImports는 타입만 쓰는 import를 빼므로 소스의 import 줄을 직접 본다.
  for (const file of ["src/executor/launcher.ts", "src/executor/profile.ts"]) {
    const imports = (await code(file)).split("\n").filter((line) => /^import\b/.test(line) && line.includes("contract"));
    expect(imports, file).toEqual(file.endsWith("profile.ts") ? ['import type { Role } from "../contract/v1/index.ts";'] : []);
  }
  // 핵심은 계획을 고정 프로필로만 만든다.
  const worker = await code("src/executor/worker.ts");
  const calls = [...worker.matchAll(/\blaunchPlan\(([^,]+),/g)].map((m) => m[1]!.trim());
  expect(calls).toEqual(["this.profile"]);
});

test("정적: 실제 전체 신호는 containment.ts의 한 자리에서만 만들고, 신호를 주입하는 알고리즘은 제품 코드가 부를 수 없다", async () => {
  const sources = await list("src/**/*.ts");
  expect(sources).toContain("src/executor/containment-core.ts");
  const signalling: string[] = [];
  const importers: string[] = [];
  for (const file of sources) {
    const source = await code(file);
    signalling.push(...[...source.matchAll(/\bprocess\.kill\b/g)].map(() => file));
    if (/containment-core\.ts/.test(source) && file !== "src/executor/containment-core.ts") importers.push(file);
    expect(/\brecordWith\b/.test(source), file).toBe(false);
  }
  expect(signalling).toEqual(["src/executor/containment.ts"]);
  expect(importers).toEqual(["src/executor/containment.ts"]);
  // 코어는 신호를 스스로 만들지 않는다.
  expect(/\bprocess\./.test(await code("src/executor/containment-core.ts"))).toBe(false);
});

test("정적: 새 종료 확인 영수증을 만드는 곳은 남은 수 0을 본 뒤의 한 곳이고, 실행 기록과 사건은 전이 한 자리로만 남긴다", async () => {
  const worker = await code("src/executor/worker.ts");
  expect([...worker.matchAll(/this\.event\("receipt_stopped"/g)]).toHaveLength(1);
  const count = worker.indexOf("const survivors = await bounded(cleanup.survivors()");
  const issue = worker.indexOf('this.event("receipt_stopped"');
  expect(count).toBeGreaterThan(0);
  expect(worker.slice(count, issue)).toContain("if (survivors !== 0)");
  // worker는 저장소의 낮은 쓰기 함수를 직접 부르지 않는다.
  expect(/\bstore\.(noteRun|addOutbox)\(/.test(worker)).toBe(false);
  // 사건을 판단에 쓰는 자리는 validEvents 하나다. 걸러 낸 사건을 다시 읽는 원본 조회를 쓰지 않는다.
  expect(/\bstore\.(outboxFor|outbox)\(/.test(worker)).toBe(false);
  expect(worker).toContain("store.validEvents(");
});

// 실행기가 듣는 곳은 agent-listener.ts의 경로 유닉스 소켓 하나다(D-102: 역할 컨테이너의 대리가 붙는다). 그 밖의 소켓·듣는 API는 실행기 코드에 없다.
const LISTENER = "src/executor/agent-listener.ts";
const SOCKET_APIS = /\bBun\.(serve|listen|connect|udpSocket)\b|\bcreateServer\b|\.listen\(|node:(net|tls|http|https|http2|dgram)\b|\bfetch\(/;

// 듣는 한 파일이 할 수 없는 것: Bun.listen 말고 다른 소켓 API, 두 번 이상 듣기, unix 밖의 주소(TCP의 hostname·port), abstract 이름을 거르지 않기.
function listenerProblems(source: string): string[] {
  const problems: string[] = [];
  const listens = [...source.matchAll(/\bBun\.listen\b/g)].length;
  if (listens !== 1) problems.push(`Bun.listen ${listens}곳`);
  if (SOCKET_APIS.test(source.replaceAll(/\bBun\.listen\b/g, ""))) problems.push("다른 소켓 API");
  const call = /\bBun\.listen\s*(?:<[^>]*>)?\s*\(\s*\{([\s\S]*?)\bsocket\s*:/.exec(source)?.[1] ?? "";
  if (!/^\s*unix\s*:\s*path\s*,\s*$/.test(call)) problems.push("unix 경로 하나만 넘기지 않는다");
  if (/\b(hostname|port|tls)\s*:/.test(source)) problems.push("TCP·TLS 주소 칸");
  if (!source.includes('if (!path.startsWith("/") || path.includes("\\0"))')) problems.push("abstract·상대 경로를 거르지 않는다");
  return problems;
}

test("정적: 실행기 코드는 agent-listener.ts의 경로 유닉스 소켓 하나만 듣고, 그 밖의 소켓·듣는 API를 쓰지 않는다(TCP·abstract 금지)", async () => {
  expect(files).toContain(LISTENER);
  for (const file of files) if (file !== LISTENER) expect(SOCKET_APIS.test(await code(file)), file).toBe(false);
  expect(listenerProblems(await code(LISTENER))).toEqual([]);
  // 대조군: 확인이 실제로 잡는다(TCP로 듣기, 두 번 듣기, 붙기, 경로 검사 빠짐).
  expect(listenerProblems('Bun.listen({ hostname: "0.0.0.0", port: 9, socket: {} }); Bun.listen({ unix: path, socket: {} }); Bun.connect({ unix: path });')).toEqual([
    "Bun.listen 2곳",
    "다른 소켓 API",
    "unix 경로 하나만 넘기지 않는다",
    "TCP·TLS 주소 칸",
    "abstract·상대 경로를 거르지 않는다",
  ]);
  expect(SOCKET_APIS.test('Bun.listen({ unix: "\\0olive" })')).toBe(true);
});
