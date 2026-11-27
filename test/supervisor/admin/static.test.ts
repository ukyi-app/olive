// 관리 통로의 정적 확인: 효과는 시험 작업 넣기(test-job.ts)의 장부 쓰기 recordToolRequest 하나와 자리 풀기(release.ts)의 장부 쓰기 셋
// (closeRunByOperator·abandonResult·releaseSlotHold)뿐이고 송신은 없으며, 도구 처리기의 포트를 다시 쓰지 않고(S42), 관리 진입점은 이 폴더의
// 말과 붙는 쪽만 끌어온다. 실제 조립에서 부른 장부 메서드·장부 파일·송신 수는 admin.test.ts·test-job.test.ts·release.test.ts가 본다.
import { expect, test } from "bun:test";
import { dirname, join, relative } from "node:path";
import { list, readText, root } from "../../files.ts";

// 줄 전체가 주석인 줄은 뺀다.
const strip = (source: string) =>
  source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
const code = async (file: string) => strip(await readText(file));

const ADMIN_DIR = "src/supervisor/admin/";
// 관리 통로 폴더가 꺼낼 수 있는 장부 멤버(부르든 꺼내든). 상태 읽기는 조립이 넘긴 view(복원기의 statusView → Ledger.peekStatus)라 없다.
// test-job.ts는 조립이 담아 넘긴 셋을 꺼낸다: 쓰기 recordToolRequest, 소유자 입력과 대기 부탁이 배정될 수 있는지 볼 읽기 둘.
// release.ts는 조립이 담아 넘긴 다섯을 꺼낸다: 자리 풀기의 쓰기 셋과 고장을 표시하지 않는 읽기 둘(peekHolds, 두 닫기의 앞 상태 peekRunState).
const LEDGER_MEMBERS: Record<string, readonly string[]> = {
  "test-job.ts": ["recordToolRequest", "listInputs", "listWaitingToolRequests"],
  "release.ts": ["closeRunByOperator", "abandonResult", "releaseSlotHold", "peekHolds", "peekRunState"],
};
// 장부 쓰기. 허용한 파일에서도 쓰기마다 정확히 한 자리에서 꺼낸다.
const LEDGER_WRITES = ["recordToolRequest", "closeRunByOperator", "abandonResult", "releaseSlotHold"] as const;
// 장부 포트를 점 접근 밖의 값으로 쓰는 자리. 이것 밖에서 ledger를 값으로 쓰면(구조 분해, 별칭, 인자로 넘기기) 멤버 검사가 그 뒤의 접근을
// 보지 못한다. test-job.ts는 포트 타입, 쓰기를 꺼내려는 별칭 하나, 쓰기를 부를 때의 this 하나만 둔다.
const LEDGER_VALUES: Record<string, readonly string[]> = {
  "test-job.ts": ['readonly ledger: Pick<Ledger, "recordToolRequest" | "listInputs" | "listWaitingToolRequests">;', "const ledger = ports.ledger;", "record.call(ledger, input)"],
  "release.ts": ['readonly ledger: Pick<Ledger, "closeRunByOperator" | "abandonResult" | "releaseSlotHold" | "peekHolds" | "peekRunState">;', "const ledger = ports.ledger;", ".call(ledger, input)"],
};
// 폴더 안에서 import할 수 있는 것. 장부는 상태 읽기(status.ts)만, 그것도 공개 면(index.ts)으로만 본다.
const IMPORTS: Record<string, readonly string[]> = {
  "protocol.ts": [],
  "status.ts": ["../../ledger/index.ts", "./protocol.ts"],
  "commands.ts": ["./protocol.ts", "./release.ts", "./status.ts", "./test-job.ts"],
  "listener.ts": ["./protocol.ts"],
  "client.ts": ["./protocol.ts"],
  // 시험 작업: 장부는 쓰기 입력의 꼴(input.ts)과 타입만, 참조·호출 ID는 envelopes.ts의 newUuid로.
  "test-job.ts": ["../../contract/v1/index.ts", "../../ledger/index.ts", "../../ledger/input.ts", "../dispatch/envelopes.ts", "../dispatch/ports.ts", "./protocol.ts", "./status.ts"],
  // 자리 풀기: 장부는 공개 면의 타입·입력 오류·포기 사유 목록과 입력의 꼴(input.ts)만. holds의 다음 행동은 수명 박자와 같은 확정
  // outcome 식(life-loop.ts의 failedOutcome)을 쓴다. 그 모듈에서 가져오는 런타임 바인딩은 RUNTIME_BINDINGS가 그 하나로 좁힌다.
  "release.ts": ["../../ledger/index.ts", "../../ledger/input.ts", "../dispatch/life-loop.ts", "./protocol.ts", "./status.ts"],
};
// import 경로마다 가져올 수 있는 런타임 바인딩(타입만 가져오는 것은 세지 않는다). 경로 표는 모듈만 보므로, 순수 판정 하나만 쓰는 모듈의
// 박자 실행 함수(lifeTick 등)는 여기서 막는다. 이름공간·기본 import는 무엇이든 꺼낼 수 있어 거절한다.
const RUNTIME_BINDINGS: Record<string, Record<string, readonly string[]>> = {
  "release.ts": { "../dispatch/life-loop.ts": ["failedOutcome"] },
};
function bindingProblems(name: string, source: string): string[] {
  const problems: string[] = [];
  for (const [path, allowed] of Object.entries(RUNTIME_BINDINGS[name] ?? {})) {
    const quoted = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const match of source.matchAll(new RegExp(`\\b(?:import|export)\\s+(type\\s+)?([^;]*?)\\s*from\\s*["']${quoted}["']`, "g"))) {
      if (match[1] !== undefined) continue;
      const clause = match[2]!.trim();
      const brace = clause.indexOf("{");
      const head = (brace < 0 ? clause : clause.slice(0, brace)).replace(/,\s*$/, "").trim();
      if (head.includes("*")) problems.push(`import * from ${path}`);
      else if (head !== "") problems.push(`import default from ${path}`);
      if (brace < 0) continue;
      for (const part of clause.slice(brace + 1, clause.lastIndexOf("}")).split(",")) {
        const spec = part.trim();
        if (spec === "" || spec.startsWith("type ")) continue;
        const imported = spec.split(/\s+as\s+/)[0]!.trim();
        if (!allowed.includes(imported)) problems.push(`import ${imported} from ${path}`);
      }
    }
  }
  return problems;
}
// 효과를 낼 수 있는 글: 연결에 싣기·연결 닫기·내보내기 포트·송신 문·발급·도구 처리기의 포트·nonce 소비·소켓에 붙기.
const EFFECTS = /\bwriteFrame\b|\bcloseConnection\b|\bsink\b|\bsendInstruction\b|\bissuance\b|\bcreateToolPorts\b|tools-adapter|\.tools\s*\(|\bnonceStore\b|\bBun\.connect\b/;

const transpiler = new Bun.Transpiler({ loader: "ts" });

function adminProblems(name: string, source: string): string[] {
  const problems: string[] = [];
  const allowed = IMPORTS[name];
  if (allowed === undefined) return [`표에 없는 파일 ${name}`];
  for (const { path } of transpiler.scanImports(source)) if (!allowed.includes(path)) problems.push(`import ${path}`);
  problems.push(...bindingProblems(name, source));
  const members = LEDGER_MEMBERS[name] ?? [];
  for (const match of source.matchAll(/\bledger\s*\.\s*([\w$]+)/g)) if (!members.includes(match[1]!)) problems.push(`ledger.${match[1]}`);
  // 장부 쓰기는 허용한 파일에서도 정확히 한 자리에서 꺼낸다(멤버 접근을 센다. 타입 Pick<Ledger, "recordToolRequest">는 세지 않는다).
  for (const write of LEDGER_WRITES) {
    const writes = [...source.matchAll(new RegExp(`\\.\\s*${write}\\b`, "g"))].length;
    if (writes !== (members.includes(write) ? 1 : 0)) problems.push(`${write} ${writes}곳`);
  }
  if (/\bledger\s*\[/.test(source)) problems.push("ledger[...]");
  // 문자열(import 경로 등)을 비우고 허용한 자리를 뺀 뒤, 점 접근·괄호 접근이 아닌 ledger는 모두 값으로 쓴 것이다.
  let values = source.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
  for (const allowed of LEDGER_VALUES[name] ?? []) values = values.replace(allowed.replace(/"(?:[^"\\\n]|\\.)*"/g, '""'), "");
  for (const _ of values.matchAll(/\bledger\b(?!\s*(?:\.\s*[\w$]|\[))/g)) problems.push("ledger 값");
  const effect = EFFECTS.exec(source);
  if (effect !== null) problems.push(`효과 ${effect[0]}`);
  const listens = [...source.matchAll(/\bBun\.listen\b/g)].length;
  if (listens !== (name === "listener.ts" ? 1 : 0)) problems.push(`Bun.listen ${listens}곳`);
  return problems;
}

test("정적: 관리 통로 폴더는 장부를 test-job.ts의 recordToolRequest 하나와 읽기 둘, release.ts의 자리 풀기 쓰기 셋과 읽기 하나로만 꺼내고(구조 분해·별칭으로 꺼내는 것도 센다), 연결에 싣거나 도구 처리기의 포트를 쓰는 글이 없으며, 듣는 곳은 listener.ts 하나다", async () => {
  const files = await list(`${ADMIN_DIR}*.ts`);
  expect(files.map((file) => file.slice(ADMIN_DIR.length))).toEqual(Object.keys(IMPORTS).sort());
  for (const file of files) expect(adminProblems(file.slice(ADMIN_DIR.length), await code(file)), file).toEqual([]);
  // 대조군: 확인이 실제로 잡는다.
  const status = await code(`${ADMIN_DIR}status.ts`);
  expect(adminProblems("status.ts", `${status}\nsources.ledger.setPause(null);`)).toEqual(["ledger.setPause"]);
  expect(adminProblems("status.ts", `${status}\nsources.ledger.readStop();`)).toEqual(["ledger.readStop"]);
  expect(adminProblems("commands.ts", `${await code(`${ADMIN_DIR}commands.ts`)}\nimport { createToolPorts } from "../runtime/tools-adapter.ts";`)).toEqual([
    "import ../runtime/tools-adapter.ts",
    "효과 createToolPorts",
  ]);
  expect(adminProblems("client.ts", "const s = await Bun.listen({ unix: path, socket: {} }); server.writeFrame(1);")).toEqual(["효과 writeFrame", "Bun.listen 1곳"]);
  // 대조군: 부르지 않고 꺼내기만 해도, 다른 파일이 같은 쓰기를 꺼내도, 허용한 파일이 다른 쓰기를 꺼내거나 같은 쓰기를 두 번 꺼내도 잡는다.
  expect(adminProblems("status.ts", `${status}\nconst write = sources.ledger.setPause;`)).toEqual(["ledger.setPause"]);
  expect(adminProblems("commands.ts", `${await code(`${ADMIN_DIR}commands.ts`)}\nconst w = ports.ledger.recordToolRequest;`)).toEqual(["ledger.recordToolRequest", "recordToolRequest 1곳"]);
  const job = await code(`${ADMIN_DIR}test-job.ts`);
  expect(adminProblems("test-job.ts", `${job}\nconst w = ports.ledger.admitRun;`)).toEqual(["ledger.admitRun"]);
  expect(adminProblems("test-job.ts", `${job}\nconst again = ports.ledger.recordToolRequest;`)).toEqual(["recordToolRequest 2곳"]);
  // 대조군: 구조 분해·별칭으로 꺼내면 멤버 이름이 점 뒤에 오지 않아도 잡는다. 허용한 파일도 허용한 자리 밖에서는 잡는다.
  expect(adminProblems("commands.ts", `${await code(`${ADMIN_DIR}commands.ts`)}\nconst { recordToolRequest: w } = testJob.ledger;`)).toEqual(["ledger 값"]);
  expect(adminProblems("test-job.ts", `${job}\nconst { ledger: l } = ports;\nl.admitRun(x);`)).toEqual(["ledger 값"]);
  // 대조군: 자리 풀기도 허용한 멤버 밖, 같은 쓰기 두 번, 다른 파일의 같은 쓰기, 구조 분해를 잡는다.
  const release = await code(`${ADMIN_DIR}release.ts`);
  expect(adminProblems("release.ts", `${release}\nconst w = ports.ledger.markResult;`)).toEqual(["ledger.markResult"]);
  expect(adminProblems("release.ts", `${release}\nconst again = ports.ledger.abandonResult;`)).toEqual(["abandonResult 2곳"]);
  expect(adminProblems("release.ts", `${release}\nconst w = ports.ledger.recordToolRequest;`)).toEqual(["ledger.recordToolRequest", "recordToolRequest 1곳"]);
  expect(adminProblems("commands.ts", `${await code(`${ADMIN_DIR}commands.ts`)}\nconst w = release.ledger.closeRunByOperator;`)).toEqual(["ledger.closeRunByOperator", "closeRunByOperator 1곳"]);
  expect(adminProblems("release.ts", `${release}\nconst { closeRunByOperator: w } = ports.ledger;`)).toEqual(["ledger 값"]);
});

// 조립이 관리 통로에 넘기는 묶음(boot.ts의 const admin). 부르는 것은 복원기의 부작용 없는 상태 읽기, 공유 시계의 peek, Object.freeze뿐이다.
// 조립 상태는 변수만 읽는다(끝낼 사유를 붙잡는 look()·박자 유효 문·끝 차례를 부르지 않는다). 장부의 다른 읽기(실패하면 장부를 고장으로
// 표시한다)와 공유 시계의 now·read(하한을 올린다)를 부르지 않는다.
const ADMIN_BLOCK_CALLS = ["Object.freeze", "restorer.statusView", "shared.peek"];
function adminBlockCalls(boot: string): string[] | null {
  const start = boot.indexOf("const admin: AdminSources = Object.freeze({");
  if (start < 0 || boot.indexOf("const admin: AdminSources", start + 1) >= 0) return null;
  const end = boot.indexOf("\n  });\n", start);
  if (end < 0) return null;
  return [...boot.slice(start, end).matchAll(/([\w$.]+)\s*\(/g)].map((match) => match[1]!);
}

test("정적: 조립이 관리 통로에 넘기는 묶음은 복원기의 상태 읽기·공유 시계의 peek만 부르고, 그 묶음이 진입점의 관리 처리기에 그대로 간다", async () => {
  const boot = await code("src/supervisor/runtime/boot.ts");
  expect(adminBlockCalls(boot)).toEqual(ADMIN_BLOCK_CALLS);
  expect(boot).toContain("return { ok: true, running: { stop: () => finish(\"stop\"), done: settled, tools, admin, testJob, release } };");
  // 대조군: 묶음 안에 쓰기 하나를 끼우거나 끝낼 사유를 읽으면 목록이 달라진다.
  expect(adminBlockCalls(boot.replace("view: (cap: number) => restorer.statusView(cap),", "view: (cap: number) => (ledger.setPause(null), restorer.statusView(cap)),"))).toContain("ledger.setPause");
  expect(adminBlockCalls(boot.replace("now: () => shared.peek(),", "now: () => shared.read(),"))).toContain("shared.read");
  expect(adminBlockCalls(boot.replace("view: (cap: number) => restorer.statusView(cap),", "view: (cap: number) => (restorer.intakeOpen(), restorer.statusView(cap)),"))).toContain("restorer.intakeOpen");
  expect(adminBlockCalls(boot.replace("alive: !stopping && exitCode === 0 && halted === null,", "alive: haltReason() === null,"))).toContain("haltReason");
  // 진입점은 관리 처리기를 running.admin, 시험 작업 포트(running.testJob, 꺼져 있으면 null), 자리 풀기 포트(running.release) 하나씩으로 만들고,
  // 도구 처리기의 포트(running.tools)를 관리 통로에 넘기지 않는다(S42).
  const main = await code("src/main/supervisor.ts");
  expect([...main.matchAll(/createAdminHandlers\(([^)]*)\)/g)].map((match) => match[1])).toEqual(["running.admin, running.testJob, running.release"]);
  expect(/\.tools\b/.test(main)).toBe(false);
  // 소유자를 가리지 않는 읽기는 도구 처리기의 포트에 잇지 않는다(S42의 다른 절반).
  expect(/listWaitingToolRequests/.test(await code("src/supervisor/runtime/tools-adapter.ts"))).toBe(false);
});

// 조립이 시험 작업 넣기에 넘기는 묶음(boot.ts의 const testJob). 설정이 켜졌을 때만 만들고, 부르는 것은 장부 쓰기 하나(recordToolRequest)·
// 장부 읽기 둘(listInputs·listWaitingToolRequests)과 박자 기한의 판정·단조 시계뿐이다. 문은 조립의 변수만 읽는다(끝낼 사유를 붙잡는 look()·haltReason()·박자 유효 문·장부 읽기를 부르지 않는다).
const TEST_JOB_HEAD = "  const testJob: TestJobPorts | null =\n    settings.testJobs === true\n";
const TEST_JOB_BLOCK_CALLS = ["Object.freeze", "Object.freeze", "ledger.recordToolRequest", "ledger.listInputs", "ledger.listWaitingToolRequests", "if", "if", "pastLimit", "pastLimit"];
function testJobBlockCalls(boot: string): string[] | null {
  const start = boot.indexOf(TEST_JOB_HEAD);
  if (start < 0 || boot.indexOf(TEST_JOB_HEAD, start + 1) >= 0) return null;
  const end = boot.indexOf("\n      : null;\n", start);
  if (end < 0) return null;
  return [...boot.slice(start + TEST_JOB_HEAD.length, end).matchAll(/([\w$.]+)\s*\(/g)].map((match) => match[1]!);
}

test("정적: 조립이 시험 작업 넣기에 넘기는 묶음은 설정이 켜졌을 때만 있고, 장부 쓰기 recordToolRequest 하나와 래치 없는 문만 담는다", async () => {
  const boot = await code("src/supervisor/runtime/boot.ts");
  expect(testJobBlockCalls(boot)).toEqual(TEST_JOB_BLOCK_CALLS);
  // 대조군: 문이 끝낼 사유를 읽거나, 묶음에 다른 장부 연산을 끼우거나, 설정을 보지 않으면 잡는다.
  expect(testJobBlockCalls(boot.replace("if (stopping || exitCode !== 0 ||", "if (haltReason() !== null || stopping || exitCode !== 0 ||"))).toContain("haltReason");
  expect(testJobBlockCalls(boot.replace("if (stopping || exitCode !== 0 ||", "if (!effectsOpen() || stopping || exitCode !== 0 ||"))).toContain("effectsOpen");
  expect(testJobBlockCalls(boot.replace("=> ledger.recordToolRequest(input)", "=> (ledger.setPause(null), ledger.recordToolRequest(input))"))).toContain("ledger.setPause");
  expect(testJobBlockCalls(boot.replace("settings.testJobs === true\n", "true\n"))).toBeNull();
});

// 조립이 자리 풀기에 넘기는 묶음(boot.ts의 const release). 설정 없이 늘 만들고, 부르는 것은 장부 쓰기 셋·고장을 표시하지 않는 읽기 peekHolds와
// 박자 기한의 판정·단조 시계·기록 한 줄뿐이다. 문은 조립의 변수만 읽는다(끝낼 사유를 붙잡는 look()·haltReason()·박자 유효 문·장부 읽기를 부르지 않는다).
const RELEASE_HEAD = "  const release: ReleasePorts = Object.freeze({\n";
const RELEASE_BLOCK_CALLS = ["Object.freeze", "ledger.closeRunByOperator", "ledger.abandonResult", "ledger.releaseSlotHold", "ledger.peekHolds", "ledger.peekRunState", "if", "if", "if", "pastLimit", "pastLimit", "log"];
function releaseBlockCalls(boot: string): string[] | null {
  const start = boot.indexOf(RELEASE_HEAD);
  if (start < 0 || boot.indexOf(RELEASE_HEAD, start + 1) >= 0) return null;
  const end = boot.indexOf("\n  });\n", start);
  if (end < 0) return null;
  return [...boot.slice(start + RELEASE_HEAD.length, end).matchAll(/([\w$.]+)\s*\(/g)].map((match) => match[1]!);
}

test("정적: 조립이 자리 풀기에 넘기는 묶음은 설정과 무관하게 늘 있고, 장부 쓰기 셋과 고장을 표시하지 않는 읽기 하나, 래치 없는 문, 기록 한 줄만 담는다", async () => {
  const boot = await code("src/supervisor/runtime/boot.ts");
  expect(releaseBlockCalls(boot)).toEqual(RELEASE_BLOCK_CALLS);
  // 묶음은 설정 분기 안에 있지 않다(시험 작업 묶음과 달리 null이 없다).
  expect(boot).toContain("  readonly release: ReleasePorts;\n");
  // 대조군: 문이 끝낼 사유를 읽거나, 다른 장부 연산이나 고장을 표시하는 읽기를 끼우면 잡는다.
  expect(releaseBlockCalls(boot.replace("if (stopping || exitCode !== 0 || halted !== null) return \"closed\";", "if (haltReason() !== null || stopping) return \"closed\";"))).toContain("haltReason");
  expect(releaseBlockCalls(boot.replace("=> ledger.peekHolds(cap)", "=> (ledger.slotHolds(), ledger.peekHolds(cap))"))).toContain("ledger.slotHolds");
  expect(releaseBlockCalls(boot.replace("=> ledger.abandonResult(input)", "=> (ledger.markResult(input as never), ledger.abandonResult(input))"))).toContain("ledger.markResult");
});

// 관리 통로가 닿는 부품 쪽 읽기의 몸통(메서드 머리부터 같은 들여쓰기의 닫는 괄호까지). 머리가 정확히 한 번 있어야 한다.
function body(source: string, head: string): string | null {
  const start = source.indexOf(head);
  if (start < 0 || source.indexOf(head, start + 1) >= 0) return null;
  const indent = /^\n( *)/.exec(head)?.[1] ?? "";
  const end = source.indexOf(`\n${indent}}`, start + head.length);
  return end < 0 ? null : source.slice(start + head.length, end);
}
const LEDGER_PEEK = "\n  peekStatus(cap: number, attempt: RestoreAttempt | null): Read<StatusPeek> {";
const LEDGER_PEEK_HOLDS = "\n  peekHolds(cap: number): Read<HoldsPeek> {";
const LEDGER_SLOT_HELD = "\n  #slotHeld(kind: RunKind): boolean {";
const LEDGER_PEEK_RUN = "\n  peekRunState(runId: string): Read<LedgerRunState | null> {";
const LEDGER_FAILED_FACTS = "\n  #failedFacts(row: RunRow): FailedStop | null {";
const RESTORER_VIEW = "\n  statusView(cap: number): Read<StatusPeek> {";
const CLOCK_PEEK = "\n    peek(): ClockReading {";
// 장부의 고장 표시·허가·시도·쓰기를 바꾸는 글.
const LEDGER_MUTATION = /#fail\b|#write\b|#revokeIntake\b|\.run\(|\.transaction\(|#(grant|broken|attempt|closed|stopEpoch)\s*(\?\?|\+|-)?=(?!=)|\b(INSERT|UPDATE|DELETE|REPLACE)\b/;
const calls = (text: string) => [...text.matchAll(/([\w$.#]+)\s*\(/g)].map((match) => match[1]!);

test("정적: 관리 통로가 닿는 부품 쪽 읽기는 상태를 바꾸지 않는다: 장부 peekStatus·peekHolds는 고장 표시·허가·쓰기를 건드리지 않고, 복원기 statusView는 그것만 부르고, 공유 시계 peek는 하한을 쓰지 않는다", async () => {
  const ledgerSource = await code("src/ledger/ledger.ts");
  const ledger = body(ledgerSource, LEDGER_PEEK);
  const restorer = body(await code("src/ledger/restore.ts"), RESTORER_VIEW);
  const clock = body(await code("src/supervisor/runtime/shared-clock.ts"), CLOCK_PEEK);
  // 자리 풀기의 holds 읽기(peekHolds)와 그것이 부르는 자리 판정(#slotHeld)도 같은 규칙이다.
  const holds = body(ledgerSource, LEDGER_PEEK_HOLDS);
  const slotHeld = body(ledgerSource, LEDGER_SLOT_HELD);
  // 두 닫기의 앞 상태 읽기(peekRunState)와 holds가 부르는 확정 재료 읽기(#failedFacts, failedStop과 같은 식)도 같은 규칙이다.
  const runState = body(ledgerSource, LEDGER_PEEK_RUN);
  const failedFacts = body(ledgerSource, LEDGER_FAILED_FACTS);
  expect([ledger, restorer, clock, holds, slotHeld, runState, failedFacts].map((found) => found !== null)).toEqual([true, true, true, true, true, true, true]);
  expect(LEDGER_MUTATION.exec(ledger!)).toBeNull();
  expect(LEDGER_MUTATION.exec(holds!)).toBeNull();
  expect(LEDGER_MUTATION.exec(slotHeld!)).toBeNull();
  expect(LEDGER_MUTATION.exec(runState!)).toBeNull();
  expect(LEDGER_MUTATION.exec(failedFacts!)).toBeNull();
  expect(calls(holds!).filter((name) => name.startsWith("this.#"))).toEqual(["this.#faults.at", "this.#db.query", "this.#db.query", "this.#db.query", "this.#db.query", "this.#failedFacts", "this.#db.query", "this.#slotHeld"]);
  expect(calls(runState!).filter((name) => name.startsWith("this.#"))).toEqual(["this.#faults.at", "this.#db.query"]);
  expect(calls(failedFacts!).filter((name) => name.startsWith("this.#"))).toEqual(["this.#db.query"]);
  for (const mutated of ["this.#fail(reason);", "this.#grant = null;"]) expect(LEDGER_MUTATION.test(`${runState}\n${mutated}`), mutated).toBe(true);
  for (const mutated of ["this.#fail(reason);", "this.#grant = null;"]) expect(LEDGER_MUTATION.test(`${holds}\n${mutated}`), mutated).toBe(true);
  expect(calls(restorer!)).toEqual(["this.ledger.peekStatus"]);
  expect(/\bfloor\s*=(?!=)|\bjudge\(/.test(clock!)).toBe(false);
  // 대조군: 실패 처리에서 고장을 표시하거나 허가를 버리거나, 시계 peek가 하한을 쓰면 잡는다.
  for (const mutated of ["this.#fail(reason);", "this.#grant = null;", "this.#broken ??= reason;", 'this.#db.query("DELETE FROM x").run();']) expect(LEDGER_MUTATION.test(`${ledger}\n${mutated}`), mutated).toBe(true);
  expect(calls(`${restorer}\nthis.ledger.readStop();`)).toContain("this.ledger.readStop");
  expect(/\bfloor\s*=(?!=)|\bjudge\(/.test(`${clock}\nfloor = at as number;`)).toBe(true);
});

// 진입점에서 import로 닿는 로컬 모듈 전체.
async function reachable(entry: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>();
  const queue = [join(root, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const source = await Bun.file(file).text();
    seen.set(file, source);
    for (const { path } of transpiler.scanImports(source)) {
      if (path.startsWith(".") && path.endsWith(".ts")) queue.push(join(dirname(file), path));
    }
  }
  return seen;
}

test("정적: 관리 진입점에서 닿는 코드는 관리 통로의 말과 붙는 쪽뿐이다(장부·박자·연결 서버를 끌어오지 않고, 듣지 않고, 환경을 읽지 않는다)", async () => {
  const files = await reachable("src/main/admin.ts");
  expect([...files.keys()].map((file) => relative(root, file)).sort()).toEqual(["src/main/admin.ts", "src/supervisor/admin/client.ts", "src/supervisor/admin/protocol.ts"]);
  for (const [file, source] of files) {
    expect(/\bBun\.(serve|listen|udpSocket)\b|\bcreateServer\b|\.listen\(/.test(source), relative(root, file)).toBe(false);
    expect(/\bprocess\.env\b|\bBun\.env\b|import\.meta\.env/.test(strip(source)), relative(root, file)).toBe(false);
  }
});

test("정적: release.ts가 수명 박자 모듈에서 가져오는 런타임 바인딩은 failedOutcome 하나다(박자 실행 함수 lifeTick 등은 거절)", async () => {
  const source = await code(`${ADMIN_DIR}release.ts`);
  expect(adminProblems("release.ts", source)).toEqual([]);
  const probe = `${source}\nimport { lifeTick } from "../dispatch/life-loop.ts";\nexport const tick = lifeTick;`;
  expect(adminProblems("release.ts", probe)).toEqual(["import lifeTick from ../dispatch/life-loop.ts"]);
  // 대조군: 별칭·재수출·이름공간·기본 import도 잡고, 타입만 가져오는 것은 런타임 바인딩이 아니라 통과한다.
  expect(adminProblems("release.ts", `${source}\nimport { failedOutcome as f, lifeTick as t } from "../dispatch/life-loop.ts";`)).toEqual(["import lifeTick from ../dispatch/life-loop.ts"]);
  expect(adminProblems("release.ts", `${source}\nexport { lifeTick } from "../dispatch/life-loop.ts";`)).toEqual(["import lifeTick from ../dispatch/life-loop.ts"]);
  expect(adminProblems("release.ts", `${source}\nimport * as loop from "../dispatch/life-loop.ts";`)).toEqual(["import * from ../dispatch/life-loop.ts"]);
  expect(adminProblems("release.ts", `${source}\nimport loop from "../dispatch/life-loop.ts";`)).toEqual(["import default from ../dispatch/life-loop.ts"]);
  expect(adminProblems("release.ts", `${source}\nimport type { LifeLoopPorts } from "../dispatch/life-loop.ts";\nimport { type RunOutcome } from "../dispatch/life-loop.ts";`)).toEqual([]);
});
