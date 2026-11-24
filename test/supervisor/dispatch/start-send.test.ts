// 정적: 시작 봉투(task_start)가 내보내기 포트에 닿는 자리는 send-gate.ts의 sendInstruction 하나다. 소스를 읽어 센다(send-gate.md "정적 시험").
// 장부의 D-90 자동 닫기는 "송신 표식이 없는 실행은 실린 적이 없다"에 기대므로, 표식을 지나지 않는 송신 자리가 생기면 이 시험이 먼저 잡는다.
// 보는 것: src/의 모든 .ts에서 송신처럼 보이는 자리(메서드 호출 .send(, 꺼낸 함수의 호출, Reflect.apply, .send.call/apply/bind,
// 이름을 문자열로 쓴 접근, send 꺼내기)와 시작 봉투를 만들 수 있는 자리(startDraft 호출, task_start 문자열, 서명 포트·계약의 봉하기 호출).
// 보지 못하는 것: 실행 중에 만든 이름("se" + "nd"), 중괄호가 겹친 구조 분해·함수 매개변수의 구조 분해, await 낱말 없이 .then(으로 미룬 포트 호출,
// 다른 이름으로 감싼 포트를 넘겨받아 부르는 함수, eval·new Function, src/ 밖의 코드.
import { expect, test } from "bun:test";
import { list, readText } from "../../files.ts";

const GATE = "src/supervisor/dispatch/send-gate.ts";

// 줄 전체가 주석인 줄은 뺀다. 줄 끝 주석에 걸린 모양은 자리로 세어 실패한다(닫는 쪽).
const code = async (file: string) =>
  (await readText(file))
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

// 송신처럼 보이는 자리. 메서드 선언(send(envelope: Envelope): ...)은 빼고 센다.
const SEND_SHAPES: readonly [string, RegExp][] = [
  ["method_call", /\.send\s*\(/g],
  ["read", /\.send\b(?!\s*\()/g],
  ["bare_call", /(?<![\w$.])send\s*\((?![^)\n]*\)\s*:)/g],
  ["reflect", /\bReflect\s*\.\s*apply\s*\(/g],
  ["computed", /\[\s*["'`]send["'`]\s*\]/g],
  // 중괄호 안에 다른 중괄호가 없는 구조 분해. 여러 줄과 별칭({ send: forward })도 잡는다.
  ["destructure", /\{[^{}]*\bsend\b[^{}]*\}\s*=[^=>]/g],
];

function sendSites(source: string): string[] {
  const found: string[] = [];
  for (const [name, shape] of SEND_SHAPES) for (const _ of source.matchAll(shape)) found.push(name);
  return found.sort();
}

// 시작 봉투를 만들 수 있는 자리. 정의(function startDraft)는 빼고 호출만 센다.
const startDraftCalls = (source: string) => [...source.matchAll(/(?<!function\s)\bstartDraft\s*\(/g)].length;
const startLiterals = (source: string) => [...source.matchAll(/["'`]task_start["'`]/g)].length;
const sealCalls = (source: string) => [...source.matchAll(/\.seal\s*\(|\bsealEnvelope\s*\(/g)].length;

const files = await list("src/**/*.ts");
const sources = new Map(await Promise.all(files.map(async (file) => [file, await code(file)] as const)));
const src = (file: string) => sources.get(file) as string;

test("정적: src/의 송신 자리는 이 목록뿐이다. 새 송신 자리를 더하면 이 목록과 시작 봉투가 닿는 길을 함께 다시 본다", () => {
  const inventory = Object.fromEntries(files.map((file) => [file, sendSites(src(file))]).filter(([, sites]) => sites.length > 0));
  expect(inventory).toEqual({
    // 시작 봉투가 포트에 닿는 한 자리(표식 → 마지막 확인 → 호출). read는 표식 전에 수신 객체의 send를 얻는 자리다.
    [GATE]: ["read", "reflect"],
    // 취소·갱신·조회·확정을 내는 박자. 시작 봉투를 만들 수 없음을 아래 시험이 본다.
    "src/supervisor/dispatch/cancel.ts": ["method_call"],
    "src/supervisor/dispatch/life-loop.ts": ["method_call", "method_call", "method_call"],
    // 실행기 → 감독 연결. 감독 모듈을 import하지 않음을 아래 시험이 본다.
    "src/executor/link.ts": ["method_call", "method_call"],
    "src/executor/worker.ts": ["method_call", "method_call"],
    // 박자 순서기가 만들 때 쥔 박자 함수를 그 수신자로 부르는 한 자리(함수의 name·length를 읽지 않으려고 bind 대신 쓴다).
    // 송신 포트를 받거나 시작 봉투를 만들 수 없음을 아래 시험이 본다.
    "src/supervisor/runtime/cycle.ts": ["reflect"],
  });
});

// 박자 함수만 부르는 모듈이 시작 봉투를 만들거나(초안·task_start·봉하기) 송신 포트를 받거나 부를(공유 함수·내보내기 포트) 수 있는 글자.
const CANNOT_SEND: readonly [string, RegExp][] = [
  ["startDraft", /\bstartDraft\b/],
  ["task_start", /task_start/],
  ["seal", /\.seal\s*\(|\bsealEnvelope\b/],
  ["sendInstruction", /\bsendInstruction\b/],
  ["sink", /sink/i],
  ["send-gate", /send-gate/],
];
const sendCapable = (source: string) => [
  ...CANNOT_SEND.filter(([, shape]) => shape.test(source)).map(([name]) => name),
  ...source
    .split("\n")
    .filter((line) => /\bReflect\s*\.\s*apply\b/.test(line))
    .map((line) => line.trim())
    .filter((line) => line !== "return ((...args: unknown[]) => Reflect.apply(fn, beats, args)) as CycleBeats[K];"),
];
const CYCLE = "src/supervisor/runtime/cycle.ts";

test("정적: 박자 순서기의 Reflect.apply는 쥔 박자 함수를 부르는 한 줄이고, 그 파일은 시작 봉투를 만들거나 송신 포트를 받지 않는다", () => {
  expect(sendCapable(src(CYCLE))).toEqual([]);
});

test("대조군: 박자 순서기에 시작 봉투·송신 포트의 글자나 다른 Reflect.apply를 넣으면 위 단언이 잡는다", () => {
  for (const [snippet, expected] of [
    ["const d = startDraft({ run });", ["startDraft"]],
    ['if (kind === "task_start") return;', ["task_start"]],
    ["const e = ports.signer.seal(d);", ["seal"]],
    ["await sendInstruction(ports, e);", ["sendInstruction"]],
    ["readonly sink: InstructionSink;", ["sink"]],
    ['import { x } from "../dispatch/send-gate.ts";', ["send-gate"]],
    ["Reflect.apply(send, target, [envelope]);", ["Reflect.apply(send, target, [envelope]);"]],
  ] as const) {
    expect([snippet, sendCapable(`${src(CYCLE)}\n${snippet}`)]).toEqual([snippet, [...expected]]);
  }
});

test("정적: 시작 봉투를 만드는 모듈은 배정·시작 박자와 재전송 박자뿐이고, 둘 다 포트를 직접 부르지 않고 sendInstruction을 한 번 부른다", () => {
  // 자격 값 보내기는 task_start 글자를 쓰지만 시작 봉투를 만들거나 봉하거나 싣거나 송신 표식을 적는 자리가 될 수 없다.
  const credentialSend = src("src/supervisor/dispatch/credential-send.ts");
  expect([
    startDraftCalls(credentialSend),
    sealCalls(credentialSend),
    sendSites(credentialSend),
    [...credentialSend.matchAll(/\bmarkStartDispatch\b/g)].length,
  ]).toEqual([0, 0, [], 0]);
  // task_start 글자는 받은 영수증의 instruction 칸을 견주는 한 줄에만 있다. 초안을 펼쳐 action·recipient를 손으로 꾸미는 함수는 이 글자를 더 써야 하므로 여기서 걸린다.
  expect([
    startLiterals(credentialSend),
    credentialSend
      .split("\n")
      .filter((line) => /["'`]task_start["'`]/.test(line))
      .map((line) => line.trim()),
  ]).toEqual([1, ['if (body.instruction !== "task_start") return "not_task_start";']]);
  const drafting = files.filter((file) => startDraftCalls(src(file)) > 0);
  expect(drafting).toEqual(["src/supervisor/dispatch/assign-loop.ts", "src/supervisor/dispatch/resend.ts"]);
  for (const file of drafting) {
    expect([file, sendSites(src(file))]).toEqual([file, []]);
    expect([file, [...src(file).matchAll(/\bsendInstruction\s*\(/g)].length]).toEqual([file, 1]);
  }
  // task_start를 문자열로 쓰는 모듈(초안을 손으로 꾸밀 수 있는 자리)도 정한 다섯뿐이다. 초안 모듈 자체는 포트를 부르지 않는다.
  // credential-send.ts는 받은 영수증의 instruction 칸을 견주기만 하고 초안을 꾸미지 않는다(이 시험 첫머리의 단언).
  expect(files.filter((file) => startLiterals(src(file)) > 0 && !file.startsWith("src/contract/") && !file.startsWith("src/ledger/") && !file.startsWith("src/executor/"))).toEqual([
    "src/supervisor/dispatch/credential-send.ts",
    "src/supervisor/dispatch/envelopes.ts",
    "src/supervisor/dispatch/resend.ts",
    GATE,
    // D-90 닫기 박자. 장부 읽기 항목의 action 칸을 견주어 시작 지시만 후보로 고를 뿐 초안을 꾸미거나 싣지 않는다(아래 "D-90 닫기 박자" 시험).
    UNRECEIVED,
  ]);
  expect(sendSites(src("src/supervisor/dispatch/envelopes.ts"))).toEqual([]);
  // 감독 안에서 봉투에 서명하는 자리는 봉투 모듈과 정지 동기화의 답(stop_sync_reply만 받는 포트)뿐이다.
  const sealing = files.filter((file) => file.startsWith("src/supervisor/") && sealCalls(src(file)) > 0);
  expect(sealing).toEqual(["src/supervisor/dispatch/envelopes.ts", "src/supervisor/transport/connections.ts"]);
  expect(src("src/supervisor/transport/connections.ts")).toContain('seal(input: SealInput<"stop_sync_reply">): Envelope;');
});

const UNRECEIVED = "src/supervisor/dispatch/unreceived.ts";
// D-90 닫기 박자가 시작 봉투에 닿을 수 있는 글자. task_start 글자는 항목을 고르는 한 줄에만 있어야 한다: 초안을 손으로 꾸미려면
// action·recipient를 적는 줄에 그 글자를 더 써야 하므로 여기서 걸린다.
const unreceivedReach = (source: string): string[] => [
  ...(startDraftCalls(source) > 0 ? ["startDraft"] : []),
  ...(sealCalls(source) > 0 || /\bsealDraft\b/.test(source) ? ["seal"] : []),
  ...sendSites(source),
  ...(/\bmarkStartDispatch\b/.test(source) ? ["markStartDispatch"] : []),
  ...(/\bsendInstruction\b|send-gate|envelopes|sink/i.test(source) ? ["send_import"] : []),
  ...source
    .split("\n")
    .filter((line) => /["'`]task_start["'`]/.test(line))
    .map((line) => line.trim())
    .filter((line) => line !== 'if (action !== "task_start") return null;'),
];

test("정적: D-90 닫기 박자는 task_start를 항목 고르기 한 줄에만 쓰고, 시작 봉투를 만들거나 봉하거나 싣거나 표식을 적을 수 없다", () => {
  expect(unreceivedReach(src(UNRECEIVED))).toEqual([]);
  expect(startLiterals(src(UNRECEIVED))).toBe(1);
});

test("대조군: D-90 닫기 박자에 시작 봉투·송신·표식의 글자나 다른 task_start 줄을 넣으면 위 단언이 잡는다", () => {
  for (const [snippet, expected] of [
    ["const d = startDraft({ run });", ["startDraft"]],
    ["const e = sealDraft(d, signer);", ["seal"]],
    ["await ports.sink.send(e);", ["method_call", "send_import"]],
    ["ledger.markStartDispatch({ runId, requestId, now });", ["markStartDispatch"]],
    ['import { sendInstruction } from "./send-gate.ts";', ["send_import"]],
    ['const body = { action: "task_start", recipient };', ['const body = { action: "task_start", recipient };']],
  ] as const) {
    expect([snippet, unreceivedReach(`${src(UNRECEIVED)}\n${snippet}`)]).toEqual([snippet, [...expected]]);
  }
});

test("정적: 공유 함수 밖의 송신 자리는 시작 봉투를 만들 수 없는 모듈에 있다", () => {
  for (const file of files) {
    if (file === GATE || sendSites(src(file)).length === 0) continue;
    const source = src(file);
    expect([file, startDraftCalls(source), sealCalls(source)]).toEqual([file, 0, file.startsWith("src/executor/") ? sealCalls(source) : 0]);
    if (file.startsWith("src/executor/")) {
      // 실행기는 자기 키로 봉하고 감독의 초안·서명 포트를 import하지 않는다.
      expect([file, /from\s+["'][^"']*\/supervisor\//.test(source)]).toEqual([file, false]);
    } else {
      expect([file, startLiterals(source)]).toEqual([file, 0]);
    }
  }
});

test("정적: 표식은 공유 함수에서만 적고, 그 함수 안의 차례는 표식 → 마지막 확인 → 포트 호출이다", () => {
  const marking = files.filter((file) => !file.startsWith("src/ledger/") && /\bmarkStartDispatch\s*\(/.test(src(file)));
  expect(marking).toEqual([GATE]);
  const gate = src(GATE);
  const body = gate.slice(gate.indexOf("export async function sendInstruction"));
  const at = (needle: string) => body.indexOf(needle);
  expect([at("send = (target as InstructionSink).send"), at("mark(envelope, start)"), at("start.lastCheck?.()"), at("Reflect.apply(")].every((index) => index >= 0)).toBe(true);
  expect(at("send = (target as InstructionSink).send")).toBeLessThan(at("mark(envelope, start)"));
  expect(at("mark(envelope, start)")).toBeLessThan(at("start.lastCheck?.()"));
  expect(at("start.lastCheck?.()")).toBeLessThan(at("Reflect.apply("));
  // 표식과 포트 호출 사이에 기다림이 없다(첫 await가 포트 호출이다). 뒤에 줄바꿈이 오는 await도 낱말로 찾는다.
  // .then( 콜백으로 포트 호출을 미루는 것처럼 await 낱말이 없는 양보는 보지 못한다(send-gate.md "정적 시험").
  expect(body.search(/\bawait\b/)).toBe(at("await Reflect.apply("));
  // 공유 함수는 시계·난수를 직접 부르지 않는다.
  for (const banned of ["Date.now", "new Date", "performance.now", "Math.random", "randomUUID", "getRandomValues", "setTimeout", "setInterval", "node:", "bun:", "Bun.", "process."]) {
    expect([banned, gate.includes(banned)]).toEqual([banned, false]);
  }
});

test("대조군: 송신 자리의 모양을 실제로 잡는다", () => {
  expect(
    sendSites(
      [
        "await ports.sink.send(envelope);",
        "const f = ports.sink.send;",
        "await send(envelope);",
        "Reflect.apply(fn, sink, [envelope]);",
        'ports.sink["send"](envelope);',
        "const { send } = ports.sink;",
        "const {\n  send: forward,\n} = sink;",
        "ports.sink.send.call(ports.sink, envelope);",
        "  send(envelope: Envelope): Promise<SendOutcome>;",
      ].join("\n"),
    ),
  ).toEqual(["bare_call", "computed", "destructure", "destructure", "method_call", "read", "read", "reflect"]);
  expect(startDraftCalls("export function startDraft(input) {}\nconst d = startDraft({ run });")).toBe(1);
});
