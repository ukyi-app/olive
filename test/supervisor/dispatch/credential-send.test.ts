import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { type Envelope, limits, rawPublicKey, sealEnvelope } from "../../../src/contract/v1/index.ts";
import type { Run } from "../../../src/ledger/index.ts";
import type { CredentialFiles, CredentialRead, CredentialRefPolicy } from "../../../src/supervisor/accounts/credential-ref.ts";
import {
  type CredentialSendNote,
  type CredentialSendPorts,
  type CredentialSendResult,
  createCredentialSender,
} from "../../../src/supervisor/dispatch/credential-send.ts";
import type { ForwardInput, ReceiptOutcome } from "../../../src/supervisor/dispatch/receipts.ts";
import { type ReplyTools } from "../../../src/supervisor/transport/connections.ts";
import { type RegistrySettings, RegistryState } from "../../../src/supervisor/transport/registry.ts";
import {
  type ConnectionServer,
  type SendEnd,
  type ServerNote,
  startConnectionServer,
  type WriteFrameOptions,
  type WriteFrameResult,
} from "../../../src/supervisor/transport/server.ts";
import { createMixedFrameDecoder, type DecodedCredential, encodeFrame } from "../../../src/transport/framing.ts";
import type { RawTlsMaterial } from "../../../src/transport/tls-policy.ts";
import { createTlsClient } from "../../../src/transport/tls-client.ts";
import { list, readText } from "../../files.ts";
import { type Issued, makePki, SUPERVISOR_DNS, SUPERVISOR_URI } from "../../transport/certs.ts";

// 값의 표본. 시험이 지어낸 바이트이고, 이름·사유·UUID·지문 어디에도 나올 수 없는 대문자 꼴이다.
// 새는지는 불리언으로만 단언한다(실패 진단문에 표본이 실리지 않게).
const SAMPLE = "ZQK7-HV2W-MX9P-TRN4-BJ3D";
const sampleBytes = () => new TextEncoder().encode(SAMPLE);
const DIGEST = createHash("sha256").update(sampleBytes()).digest("hex");
const OTHER_DIGEST = "0".repeat(64);

const EXEC = "executor/isolated_reader/r1/s1";
const OTHER_EXEC = "executor/isolated_reader/r2/s2";
const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GEN = 3;
const T0 = 1_800_000_000_000;
const DEADLINE = T0 + 600_000;

const POLICY: CredentialRefPolicy = {
  dir: "/accounts",
  keys: { subscription: "CLAUDE_CODE_OAUTH_TOKEN" },
  maxBytes: 16_384,
  revisionOf: () => "rev-1",
};

// 바이트 그릇(Uint8Array 등 뷰, ArrayBuffer)은 숫자 배열로 펴서 본다. Buffer는 toJSON이 data 배열로 편다.
const SAMPLE_NUMBERS = Array.from(new TextEncoder().encode(SAMPLE)).join(",");
const leaks = (value: unknown): boolean => {
  const text =
    JSON.stringify(value, (_key, v: unknown) =>
      ArrayBuffer.isView(v) ? Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) : v instanceof ArrayBuffer ? Array.from(new Uint8Array(v)) : v,
    ) ?? "";
  return (
    text.includes(SAMPLE) ||
    text.includes(Buffer.from(SAMPLE).toString("hex")) ||
    text.includes(Buffer.from(SAMPLE).toString("base64")) ||
    text.includes(SAMPLE_NUMBERS)
  );
};
// 결과를 허용된 칸과 원시형으로만 옮긴다. 결과 객체를 통째로 견주면 실패 진단에 들어 있던 값이 그대로 찍히므로,
// 다른 칸은 칸 이름 없이 표식으로, 원시형이 아니거나 표본이 든 값은 표식으로 바꾼 사본을 견준다.
const RESULT_FIELDS = new Set(["kind", "reason", "connection", "runId", "refusal"]);
function safe(result: unknown): Record<string, unknown> | "not_an_object" {
  if (typeof result !== "object" || result === null) return "not_an_object";
  const out: Record<string, unknown> = {};
  // Object.keys와 JSON은 심볼 키를 건너뛴다. 결과에 허용된 심볼 칸은 없으므로 있기만 해도 표식이다.
  if (Object.getOwnPropertySymbols(result).length > 0) out["<unexpected_symbol>"] = true;
  for (const key of Object.keys(result)) {
    if (!RESULT_FIELDS.has(key)) {
      out["<unexpected_field>"] = true;
      continue;
    }
    const v = (result as Record<string, unknown>)[key];
    out[key] = v === null || typeof v === "number" || (typeof v === "string" && !leaks(v)) ? v : "<not_allowed_value>";
  }
  return out;
}
const allZero = (bytes: Uint8Array) => bytes.every((b) => b === 0);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

function runRow(over: Partial<Run> = {}): Run {
  return {
    runId: RUN,
    runGeneration: 1,
    kind: "worker",
    role: "isolated_reader",
    queueSeq: 1,
    dedupeKey: null,
    inputRequestId: null,
    profileRevision: "profile-1",
    policyRevision: "policy-1",
    snapshotDigest: null,
    inputDigest: null,
    executorId: EXEC,
    credential: { account: "main", method: "subscription", revision: "rev-1", digest: DIGEST },
    deadlineAt: DEADLINE,
    budgetLeft: 1,
    state: "preparing",
    acceptedReceiptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    startedReceiptId: null,
    stopReceiptId: null,
    cleanedReceiptId: null,
    resultDigest: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

let ids = 0;
const uuid = () => `00000000-0000-4000-8000-${(++ids).toString(16).padStart(12, "0")}`;

// handleForward에 넘긴 forward와 그 결과의 꼴. 계약 검증과 장부는 이미 지났다고 본다.
function receipt(over: { connection?: number; sender?: string; runId?: string; instruction?: string; outcome?: ReceiptOutcome["outcome"]; action?: string } = {}) {
  const receiptId = uuid();
  const action = over.action ?? "receipt_accepted";
  const sender = over.sender ?? EXEC;
  const body = { receipt_id: receiptId, run_id: over.runId ?? RUN, instruction_request_id: uuid(), instruction: over.instruction ?? "task_start" };
  const forward = {
    connection: over.connection ?? 1,
    verified: { ok: true, action, header: { action, sender, recipient: "supervisor" }, body, sender, recipient: "supervisor", adoptedStopGeneration: GEN },
  } as unknown as ForwardInput["forward"];
  const kind = over.outcome ?? "ack";
  const outcome = (
    kind === "ack"
      ? { outcome: "ack", action, id: receiptId, delivery: "new", ack: {} }
      : kind === "applied_without_ack"
        ? { outcome: "applied_without_ack", action, id: receiptId, delivery: "duplicate", reason: "stop_generation_unknown" }
        : kind === "ledger_refused"
          ? { outcome: "ledger_refused", action, id: receiptId, reason: "sender_mismatch" }
          : { outcome: "ledger_failed", action, id: receiptId, failure: "threw" }
  ) as unknown as ReceiptOutcome;
  return [forward, outcome] as const;
}

interface Hold {
  release(): void;
}

// 계정 파일. 읽을 때마다 새 버퍼를 돌려주고 그 버퍼를 남긴다(0으로 채워졌는지 본다).
function fakeFiles() {
  const lent: Uint8Array[] = [];
  const calls: { maxBytes: number }[] = [];
  let next: (() => CredentialRead) | null = null;
  let gate: Promise<void> | null = null;
  const files: CredentialFiles = {
    async read(_location, maxBytes) {
      calls.push({ maxBytes });
      const wait = gate;
      if (wait) await wait;
      const make = next;
      if (make) return make();
      const bytes = sampleBytes();
      lent.push(bytes);
      return { kind: "bytes", bytes };
    },
  };
  return {
    files,
    lent,
    calls,
    answer(make: () => CredentialRead) {
      next = make;
    },
    // 다음 읽기들을 release까지 붙든다.
    hold(): Hold {
      let release!: () => void;
      gate = new Promise<void>((resolve) => (release = resolve));
      return {
        release: () => {
          gate = null;
          release();
        },
      };
    },
  };
}

interface Handed {
  readonly connection: number;
  readonly frame: Uint8Array;
  // 넘긴 순간의 바이트 사본.
  readonly copy: Uint8Array;
  readonly settled: (end: SendEnd) => void;
}

type Mode = "normal" | "unknown" | "throw" | "throw_after" | "null" | "bad_reason";

// 서버의 쓰기 면을 흉내 낸다: 인정 → lastCheck → 인정 재확인 → 넘김. 인정은 주체마다 연결 하나.
function fakeServer() {
  const recognized = new Map<string, number>([[EXEC, 1]]);
  const handed: Handed[] = [];
  // 입구에서 받은 틀. handed는 넘긴 틀만 남기므로, 넘기지 않은 길의 틀 소거는 이것으로 본다.
  const entered: Uint8Array[] = [];
  const checks: (string | null)[] = [];
  let duringCheck: (() => void) | null = null;
  // throw: 받기 전에 던짐. throw_after: 틀을 받은 뒤 완료를 알리지 않고 던짐. null: 넘기지 않고 꼴이 아닌 답.
  // bad_reason: 넘기지 않았다며 사유 목록 밖의 글자(표본)를 줌. 모두 서버 계약 밖이다.
  let mode: Mode = "normal";
  const server = {
    writeFrame(connection: number, principal: string, frame: Uint8Array, options: WriteFrameOptions): WriteFrameResult {
      entered.push(frame);
      if (mode === "throw") throw new Error("write path failed");
      if (recognized.get(principal) !== connection) return { kind: "not_written", reason: "not_recognized" };
      const verdict = options.lastCheck();
      checks.push(verdict);
      duringCheck?.();
      if (verdict !== null) return { kind: "not_written", reason: "refused", refusal: verdict };
      if (recognized.get(principal) !== connection) return { kind: "not_written", reason: "not_recognized" };
      if (mode === "null") return null as unknown as WriteFrameResult;
      if (mode === "bad_reason") return { kind: "not_written", reason: SAMPLE } as unknown as WriteFrameResult;
      handed.push({ connection, frame, copy: frame.slice(), settled: options.settled });
      if (mode === "throw_after") throw new Error(`write failed near ${SAMPLE}`);
      if (mode === "unknown") {
        options.settled("failed");
        return { kind: "unknown" };
      }
      return { kind: "written" };
    },
  };
  return {
    server,
    recognized,
    handed,
    entered,
    checks,
    set duringCheck(fn: (() => void) | null) {
      duringCheck = fn;
    },
    set mode(value: Mode) {
      mode = value;
    },
  };
}

function setup(over: Partial<CredentialSendPorts> = {}) {
  const rows = new Map<string, Run>([
    [RUN, runRow()],
    [RUN_B, runRow({ runId: RUN_B, executorId: OTHER_EXEC })],
  ]);
  const state = { generation: GEN as number | null, open: true, now: T0 };
  const files = fakeFiles();
  const fake = fakeServer();
  const notes: CredentialSendNote[] = [];
  const ports: CredentialSendPorts = {
    server: fake.server,
    ledger: { getRun: (runId: string) => ({ known: true, value: rows.get(runId) ?? null }) },
    gate: { stopGeneration: () => state.generation, intakeOpen: () => state.open },
    clock: { now: () => state.now },
    files: files.files,
    policy: POLICY,
    observe: (note) => notes.push(note),
    ...over,
  };
  const sender = createCredentialSender(ports);
  return { sender, rows, state, files, fake, notes };
}

// 넘긴 틀을 실행기 쪽 섞어 받는 디코더로 푼다.
function decode(bytes: Uint8Array): DecodedCredential {
  const step = createMixedFrameDecoder().push(bytes);
  expect(step.rejected).toBeNull();
  expect(step.frames.length).toBe(1);
  const frame = step.frames[0]!;
  if (frame.kind !== "credential") throw new Error("값 틀이 아니다");
  return frame.credential;
}

const wipes = (notes: CredentialSendNote[]) => notes.filter((n) => n.kind === "wiped");

describe("보장 1: 검증되고 장부가 받은 task_start 접수 영수증에만, (연결, 실행)마다 많아야 한 번", () => {
  test("정상: 그 연결로 값 틀 하나를 넘기고, 실행기 쪽 디코더가 같은 실행 ID·지문·값으로 받는다", async () => {
    const t = setup();
    const result = await t.sender.onReceipt(...receipt());
    expect(safe(result)).toEqual({ kind: "written", connection: 1, runId: RUN });
    expect(t.fake.handed.length).toBe(1);
    const got = decode(t.fake.handed[0]!.copy);
    expect(got.runId).toBe(RUN);
    expect(got.digest).toBe(DIGEST);
    expect(same(got.value, sampleBytes())).toBe(true);
    expect(t.files.calls).toEqual([{ maxBytes: POLICY.maxBytes }]);
  });

  test("applied_without_ack(장부가 받음, delivery duplicate)에도 보낸다", async () => {
    const t = setup();
    expect((await t.sender.onReceipt(...receipt({ outcome: "applied_without_ack" }))).kind).toBe("written");
    expect(t.fake.handed.length).toBe(1);
  });

  test("장부가 거절했거나 던진 영수증, run_renew 접수, 다른 영수증 종류에는 읽지도 보내지도 않는다", async () => {
    const t = setup();
    const cases: [Parameters<typeof receipt>[0], string][] = [
      [{ outcome: "ledger_refused" }, "ledger_not_accepted"],
      [{ outcome: "ledger_failed" }, "ledger_not_accepted"],
      [{ instruction: "run_renew" }, "not_task_start"],
      [{ instruction: "run_cancel" }, "not_task_start"],
      [{ action: "receipt_started" }, "not_accepted_receipt"],
    ];
    for (const [over, reason] of cases) {
      expect(safe(await t.sender.onReceipt(...receipt(over)))).toEqual({ kind: "ignored", reason } as CredentialSendResult);
    }
    expect(t.files.calls.length).toBe(0);
    expect(t.fake.handed.length).toBe(0);
  });

  test("결과의 영수증 ID가 받은 봉투와 다르면 보내지 않는다", async () => {
    const t = setup();
    const [forward] = receipt();
    const [, otherOutcome] = receipt();
    expect(safe(await t.sender.onReceipt(forward, otherOutcome))).toEqual({ kind: "ignored", reason: "outcome_mismatch" });
    expect(t.fake.handed.length).toBe(0);
  });

  test("다른 연결에서 온 영수증(그 주체의 인정된 연결이 아님): 넘긴 바이트 0이고 값과 틀은 0", async () => {
    const t = setup();
    t.fake.recognized.set(EXEC, 2);
    const result = await t.sender.onReceipt(...receipt({ connection: 1 }));
    expect(safe(result)).toEqual({ kind: "not_written", connection: 1, runId: RUN, reason: "not_recognized", refusal: null });
    expect(t.fake.handed.length).toBe(0);
    expect(t.files.lent.every(allZero)).toBe(true);
  });

  test("다른 실행(실행 줄의 지정 실행기가 이 주체가 아님): 계정 파일을 읽지 않고 보내지 않는다", async () => {
    const t = setup();
    const result = await t.sender.onReceipt(...receipt({ runId: RUN_B }));
    expect(safe(result)).toEqual({ kind: "blocked", connection: 1, runId: RUN_B, reason: "not_assigned" });
    expect(t.files.calls.length).toBe(0);
    expect(t.fake.handed.length).toBe(0);
  });

  test("같은 연결의 같은 영수증 두 번: 한 번만 읽고 한 번만 넘긴다", async () => {
    const t = setup();
    const pair = receipt();
    expect((await t.sender.onReceipt(...pair)).kind).toBe("written");
    expect(safe(await t.sender.onReceipt(...pair))).toEqual({ kind: "already_sent", connection: 1, runId: RUN });
    // 장부가 duplicate로 다시 받은 같은 실행의 새 영수증도 같다.
    expect((await t.sender.onReceipt(...receipt({ outcome: "applied_without_ack" }))).kind).toBe("already_sent");
    expect(t.files.calls.length).toBe(1);
    expect(t.fake.handed.length).toBe(1);
  });

  test("같은 연결의 두 영수증이 계정 파일 읽기를 기다리는 동안 겹쳐도 한 번", async () => {
    const t = setup();
    const hold = t.files.hold();
    const first = t.sender.onReceipt(...receipt());
    const second = t.sender.onReceipt(...receipt());
    await Bun.sleep(0);
    hold.release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.kind).toBe("written");
    expect(secondResult.kind).toBe("already_sent");
    expect(t.files.calls.length).toBe(1);
    expect(t.fake.handed.length).toBe(1);
  });

  test("forgetConnection 뒤에는 그 연결 번호의 기억이 없다(다른 연결의 기억은 남는다)", async () => {
    const t = setup();
    expect((await t.sender.onReceipt(...receipt({ connection: 1 }))).kind).toBe("written");
    t.fake.recognized.set(EXEC, 2);
    expect((await t.sender.onReceipt(...receipt({ connection: 2 }))).kind).toBe("written");
    t.sender.forgetConnection(1);
    // 연결 1의 기억은 지워져 다시 시도한다(서버가 인정하지 않아 넘기지는 않는다). 연결 2는 그대로 막힌다.
    expect((await t.sender.onReceipt(...receipt({ connection: 1 }))).kind).toBe("not_written");
    expect((await t.sender.onReceipt(...receipt({ connection: 2 }))).kind).toBe("already_sent");
    expect(t.files.calls.length).toBe(3);
  });
});

describe("보장 2: 읽기의 await 뒤에 바뀐 것을 lastCheck에서 다시 본다", () => {
  const changes: [string, (t: ReturnType<typeof setup>) => void, string][] = [
    ["정지 세대가 오름", (t) => (t.state.generation = GEN + 1), "stop_generation_changed"],
    ["정지 세대를 모르게 됨", (t) => (t.state.generation = null), "stop_generation_unknown"],
    ["접수가 닫힘", (t) => (t.state.open = false), "intake_closed"],
    ["실행 상태가 running으로", (t) => t.rows.set(RUN, runRow({ state: "running" })), "not_preparing"],
    ["실행 상태가 failed_stopped로", (t) => t.rows.set(RUN, runRow({ state: "failed_stopped" })), "not_preparing"],
    ["종료 영수증이 적힘", (t) => t.rows.set(RUN, runRow({ stopReceiptId: uuid() })), "run_ended"],
    ["지정 실행기가 바뀜", (t) => t.rows.set(RUN, runRow({ executorId: OTHER_EXEC })), "not_assigned"],
    ["실행 줄의 지문이 바뀜", (t) => t.rows.set(RUN, runRow({ credential: { account: "main", method: "subscription", revision: "rev-2", digest: OTHER_DIGEST } })), "credential_changed"],
    ["작업 기한 정각이 됨", (t) => (t.state.now = DEADLINE), "deadline_passed"],
  ];
  for (const [name, change, reason] of changes) {
    test(`${name} → 넘긴 바이트 0, 값과 틀은 0`, async () => {
      const t = setup();
      const hold = t.files.hold();
      const pending = t.sender.onReceipt(...receipt());
      await Bun.sleep(0);
      change(t);
      hold.release();
      const result = await pending;
      expect(safe(result)).toEqual({ kind: "not_written", connection: 1, runId: RUN, reason: "refused", refusal: reason });
      expect(t.fake.handed.length).toBe(0);
      expect(t.files.lent.length).toBe(1);
      expect(allZero(t.files.lent[0]!)).toBe(true);
      expect(wipes(t.notes).map((n) => n.kind === "wiped" && n.at)).toEqual(["not_written"]);
    });
  }

  test("연결이 인정을 잃음(다른 연결이 인정됨) → 넘긴 바이트 0, 값은 0", async () => {
    const t = setup();
    const hold = t.files.hold();
    const pending = t.sender.onReceipt(...receipt());
    await Bun.sleep(0);
    t.fake.recognized.set(EXEC, 9);
    hold.release();
    expect(safe(await pending)).toEqual({ kind: "not_written", connection: 1, runId: RUN, reason: "not_recognized", refusal: null });
    expect(t.fake.handed.length).toBe(0);
    expect(allZero(t.files.lent[0]!)).toBe(true);
  });

  test("lastCheck 도중 인정을 잃으면 서버가 넘기지 않고 값은 0", async () => {
    const t = setup();
    t.fake.duringCheck = () => t.fake.recognized.delete(EXEC);
    expect((await t.sender.onReceipt(...receipt())).kind).toBe("not_written");
    expect(t.fake.handed.length).toBe(0);
    expect(allZero(t.files.lent[0]!)).toBe(true);
  });

  test("읽기 앞에서 이미 막히면 계정 파일을 읽지 않는다", async () => {
    const t = setup();
    t.state.open = false;
    expect(safe(await t.sender.onReceipt(...receipt()))).toEqual({ kind: "blocked", connection: 1, runId: RUN, reason: "intake_closed" });
    expect(t.files.calls.length).toBe(0);
  });

  test("시계가 읽기 앞에서 던지면 막히고, lastCheck에서 던지면 이름을 낸다(던지지 않는다)", async () => {
    let fail = true;
    const t = setup({
      clock: {
        now: () => {
          if (fail) throw new Error("clock down");
          return T0;
        },
      },
    });
    expect(safe(await t.sender.onReceipt(...receipt()))).toEqual({ kind: "blocked", connection: 1, runId: RUN, reason: "clock_failed" });
    t.sender.forgetConnection(1);
    fail = false;
    const hold = t.files.hold();
    const pending = t.sender.onReceipt(...receipt());
    await Bun.sleep(0);
    fail = true;
    hold.release();
    expect(safe(await pending)).toEqual({ kind: "not_written", connection: 1, runId: RUN, reason: "refused", refusal: "clock_failed" });
    expect(t.fake.handed.length).toBe(0);
  });
});

describe("보장 3: 계정 파일을 다시 읽고 실행 줄의 지문과 같을 때만", () => {
  test("지문 불일치: 넘기지 않고 읽은 버퍼는 0", async () => {
    const t = setup();
    t.rows.set(RUN, runRow({ credential: { account: "main", method: "subscription", revision: "rev-1", digest: OTHER_DIGEST } }));
    expect(safe(await t.sender.onReceipt(...receipt()))).toEqual({ kind: "unreadable", connection: 1, runId: RUN, reason: "digest_mismatch" });
    expect(t.fake.handed.length).toBe(0);
    expect(t.files.lent.length).toBe(1);
    expect(allZero(t.files.lent[0]!)).toBe(true);
  });

  test("읽기 상한 초과·포트가 상한을 어긴 바이트·읽기 실패·포트가 던짐: 넘기지 않는다", async () => {
    const big = new Uint8Array(POLICY.maxBytes + 1).fill(0x41);
    const answers: [() => CredentialRead, string][] = [
      [() => ({ kind: "too_large" }), "too_large"],
      [() => ({ kind: "bytes", bytes: big }), "too_large"],
      [() => ({ kind: "failed" }), "read_failed"],
      [() => ({ kind: "missing" }), "missing"],
      [() => ({ kind: "outside_account" }), "outside_account"],
      [
        () => {
          throw new Error(`read failed near ${SAMPLE}`);
        },
        "read_failed",
      ],
    ];
    for (const [answer, reason] of answers) {
      const t = setup();
      t.files.answer(answer);
      const result = await t.sender.onReceipt(...receipt());
      expect(safe(result)).toEqual({ kind: "unreadable", connection: 1, runId: RUN, reason } as CredentialSendResult);
      expect(t.fake.handed.length).toBe(0);
      expect(leaks(result)).toBe(false);
      expect(leaks(t.notes)).toBe(false);
    }
    expect(allZero(big)).toBe(true);
  });

  test("정책의 maxBytes가 값 틀 상한보다 크면 읽지 않는다", async () => {
    const t = setup({ policy: { ...POLICY, maxBytes: 16_385 } });
    expect(safe(await t.sender.onReceipt(...receipt()))).toEqual({ kind: "unreadable", connection: 1, runId: RUN, reason: "limit_above_frame" });
    expect(t.files.calls.length).toBe(0);
  });
});

describe("보장 4: 값과 틀은 결과·관측·예외에 없고, settled 뒤에만 0으로 채운다", () => {
  test("settled 전에는 값과 틀이 그대로이고, settled 뒤에는 0이며 정리는 한 번", async () => {
    const t = setup();
    expect((await t.sender.onReceipt(...receipt())).kind).toBe("written");
    const handed = t.fake.handed[0]!;
    expect(same(handed.frame, handed.copy)).toBe(true);
    expect(same(t.files.lent[0]!, sampleBytes())).toBe(true);
    expect(wipes(t.notes).length).toBe(0);
    handed.settled("flushed");
    expect(allZero(handed.frame)).toBe(true);
    expect(allZero(t.files.lent[0]!)).toBe(true);
    handed.settled("closed");
    expect(wipes(t.notes).map((n) => n.kind === "wiped" && n.at)).toEqual(["flushed"]);
  });

  test("unknown: 서버가 돌아오기 전에 부른 settled에서 한 번 정리하고 반환 뒤 다시 정리하지 않는다", async () => {
    const t = setup();
    t.fake.mode = "unknown";
    expect(safe(await t.sender.onReceipt(...receipt()))).toEqual({ kind: "unknown", connection: 1, runId: RUN, reason: "server_unknown" });
    expect(allZero(t.fake.handed[0]!.frame)).toBe(true);
    expect(allZero(t.files.lent[0]!)).toBe(true);
    expect(wipes(t.notes).map((n) => n.kind === "wiped" && n.at)).toEqual(["failed"]);
  });

  // 서버 계약 밖의 답은 넘겼는지 알 수 없으므로 not_written(넘긴 바이트 0)이라고 하지 않는다. 버퍼는 그 자리에서 채운다.
  for (const [mode, reason, handed] of [
    ["throw", "write_threw", 0],
    ["throw_after", "write_threw", 1],
    ["null", "write_result_malformed", 0],
    ["bad_reason", "write_result_malformed", 0],
  ] as const) {
    test(`서버가 계약 밖의 답(${mode}): 송달 모름(unknown/${reason})이고 값과 틀은 0, 결과·거절에 표본이 없다`, async () => {
      const t = setup();
      t.fake.mode = mode;
      const settled = await t.sender.onReceipt(...receipt()).then(
        (result) => ({ resolved: true, result, text: "" }),
        (error: unknown) => ({ resolved: false, result: null, text: String((error as Error)?.message ?? error) }),
      );
      expect(settled.resolved).toBe(true);
      expect(leaks(settled.text)).toBe(false);
      expect(leaks(settled.result)).toBe(false);
      expect(safe(settled.result)).toEqual({ kind: "unknown", connection: 1, runId: RUN, reason });
      expect(t.fake.handed.length).toBe(handed);
      expect(t.files.lent.length).toBe(1);
      expect(allZero(t.files.lent[0]!)).toBe(true);
      expect(t.fake.entered.length).toBe(1);
      expect(allZero(t.fake.entered[0]!)).toBe(true);
      if (handed === 1) expect(allZero(t.fake.handed[0]!.frame)).toBe(true);
      expect(wipes(t.notes).map((n) => n.kind === "wiped" && n.at)).toEqual([reason]);
      expect(leaks(t.notes)).toBe(false);
    });
  }

  test("실행 줄의 credential 접근자가 표본을 담아 던져도 이름으로 끝나고 결과·거절에 표본이 없다", async () => {
    const t = setup();
    const row = runRow();
    Object.defineProperty(row, "credential", {
      get() {
        throw new Error(`row broken near ${SAMPLE}`);
      },
    });
    t.rows.set(RUN, row);
    const settled = await t.sender.onReceipt(...receipt()).then(
      (result) => ({ resolved: true, result, text: "" }),
      (error: unknown) => ({ resolved: false, result: null, text: String((error as Error)?.message ?? error) }),
    );
    expect(settled.resolved).toBe(true);
    expect(leaks(settled.text)).toBe(false);
    expect(safe(settled.result)).toEqual({ kind: "blocked", connection: 1, runId: RUN, reason: "ledger_unavailable" });
    expect(t.files.calls.length).toBe(0);
    expect(leaks(t.notes)).toBe(false);
  });

  test("유출 판정은 문자열·hex·base64와 Uint8Array·숫자 배열·Buffer·ArrayBuffer 꼴을 모두 잡는다", () => {
    const bytes = sampleBytes();
    for (const carrier of [SAMPLE, Buffer.from(SAMPLE).toString("hex"), Buffer.from(SAMPLE).toString("base64"), bytes, Array.from(bytes), Buffer.from(bytes), bytes.buffer]) {
      expect(leaks({ nested: [{ carrier }] })).toBe(true);
    }
    expect(leaks({ kind: "written", connection: 1, runId: RUN })).toBe(false);
  });

  test("사본 비교는 자체 심볼 칸을 키와 값 없이 표식으로 바꾼다", () => {
    const wanted = { kind: "written", connection: 1, runId: RUN };
    const copy = safe({ ...wanted, [Symbol("extra")]: sampleBytes() });
    expect(copy !== "not_an_object" && copy["<unexpected_symbol>"] === true).toBe(true);
    expect(leaks(copy)).toBe(false);
    expect(safe(wanted)).toEqual(wanted);
  });

  test("결과·관측 어디에도 값의 표본이 없다(모든 길)", async () => {
    const results: CredentialSendResult[] = [];
    const notes: CredentialSendNote[] = [];
    const run = async (prepare: (t: ReturnType<typeof setup>) => void, over: Parameters<typeof receipt>[0] = {}) => {
      const t = setup();
      prepare(t);
      results.push(await t.sender.onReceipt(...receipt(over)));
      results.push(await t.sender.onReceipt(...receipt(over)));
      t.fake.handed[0]?.settled("flushed");
      notes.push(...t.notes);
    };
    for (const mode of ["normal", "unknown", "throw", "throw_after", "null"] as const) await run((t) => (t.fake.mode = mode));
    await run(() => {}, { outcome: "ledger_refused" });
    await run((t) => (t.state.open = false));
    await run((t) => t.rows.set(RUN, runRow({ credential: { account: "main", method: "subscription", revision: "rev-1", digest: OTHER_DIGEST } })));
    await run((t) =>
      t.files.answer(() => {
        throw new Error(`read failed near ${SAMPLE}`);
      }),
    );
    // 실행 ID가 UUID 꼴이 아니면 인코더가 틀을 거절한다(frame_failed).
    await run((t) => t.rows.set("run-not-a-uuid", runRow({ runId: "run-not-a-uuid" })), { runId: "run-not-a-uuid" });
    await run((t) => t.fake.recognized.set(EXEC, 2));
    // 종류 이름을 그대로 견주면 실패 진단에 칸의 글자가 찍힌다. 있음과 수만 본다.
    const kinds = new Set<string>(results.map((r) => r.kind));
    const wantedKinds = ["ignored", "already_sent", "blocked", "unreadable", "frame_failed", "not_written", "written", "unknown"];
    for (const kind of wantedKinds) expect(kinds.has(kind)).toBe(true);
    expect(kinds.size).toBe(wantedKinds.length);
    expect(leaks(results)).toBe(false);
    expect(leaks(notes)).toBe(false);
    expect(notes.some((n) => Object.values(n).some((v: unknown) => v instanceof Uint8Array))).toBe(false);
    expect(results.every((r) => !/<(unexpected_field|unexpected_symbol|not_allowed_value)>|not_an_object/.test(JSON.stringify(safe(r))))).toBe(true);
  });

  test("관측이 던져도 보내기와 정리는 그대로다", async () => {
    const t = setup({
      observe: () => {
        throw new Error("observer down");
      },
    });
    expect((await t.sender.onReceipt(...receipt())).kind).toBe("written");
    t.fake.handed[0]!.settled("flushed");
    expect(allZero(t.files.lent[0]!)).toBe(true);
  });
});

describe("정적", () => {
  const strip = (source: string) =>
    source
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");

  // 선언은 첫 줄부터 다음 최상위 줄(들여쓰지 않은 줄) 앞까지다. 갈래 안의 ";"에서 끊지 않는다.
  const declarationOf = (source: string, name: string): string | null => {
    const lines = source.split("\n");
    const start = lines.findIndex((line) => line.startsWith(`export type ${name} =`));
    if (start === -1) return null;
    let end = start + 1;
    while (end < lines.length && (lines[end]!.trim() === "" || /^\s/.test(lines[end]!))) end++;
    return lines.slice(start, end).join("\n").trimEnd();
  };

  test("결과·관측 타입에 Uint8Array 칸이 없다", async () => {
    const source = strip(await readText("src/supervisor/dispatch/credential-send.ts"));
    for (const name of ["CredentialSendResult", "CredentialSendNote", "CredentialSendUnknown"]) {
      const declaration = declarationOf(source, name);
      expect(declaration === null ? "missing" : "found").toBe("found");
      // 끝까지 읽었는지: 선언은 ";"로 끝나고 중괄호가 맞는다.
      expect(declaration!.endsWith(";")).toBe(true);
      expect((declaration!.match(/\{/g) ?? []).length).toBe((declaration!.match(/\}/g) ?? []).length);
      expect(/Uint8Array|ArrayBuffer|Buffer\b|DataView/.test(declaration!)).toBe(false);
    }
    // 결과의 갈래는 여덟이다(갈래를 더하면 이 수와 위 검사를 함께 본다).
    expect((declarationOf(source, "CredentialSendResult")!.match(/readonly kind: "/g) ?? []).length).toBe(8);
  });

  test("재전송 박자·장부·내보내기 포트는 이 모듈을 import하지 않는다", async () => {
    const files = ["src/supervisor/dispatch/resend.ts", ...(await list("src/ledger/**/*.ts")), ...(await list("src/supervisor/runtime/sink.ts"))];
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) expect(/credential-send/.test(await readText(file)), file).toBe(false);
  });

  test("src/에서 encodeCredentialFrame을 부르는 파일은 credential-send.ts 하나다", async () => {
    const users: string[] = [];
    for (const file of await list("src/**/*.ts")) {
      if (file === "src/transport/framing.ts") continue;
      if (/\bencodeCredentialFrame\b/.test(strip(await readText(file)))) users.push(file);
    }
    expect(users).toEqual(["src/supervisor/dispatch/credential-send.ts"]);
  });

  test("src/에서 writeFrame을 부르는 파일은 credential-send.ts와 runtime/sink.ts뿐이다", async () => {
    const allowed = new Set(["src/supervisor/dispatch/credential-send.ts", "src/supervisor/runtime/sink.ts"]);
    const users: string[] = [];
    for (const file of await list("src/**/*.ts")) {
      const source = strip(await readText(file));
      // 정의(server.ts의 메서드·인터페이스)는 점 없이 이름으로 시작한다. 부르는 꼴과 꺼내는 꼴을 센다.
      if (/\.\s*writeFrame\b|\[\s*["'`]writeFrame["'`]\s*\]|\{[^}]*\bwriteFrame\b[^}]*\}\s*=/.test(source)) users.push(file);
    }
    expect(users.every((file) => allowed.has(file))).toBe(true);
    expect(users).toContain("src/supervisor/dispatch/credential-send.ts");
  });

  test("계정 파일 읽기의 await와 writeFrame 사이에 다른 await가 없다", async () => {
    const source = strip(await readText("src/supervisor/dispatch/credential-send.ts"));
    const from = source.indexOf("await borrowCredentialValue(");
    const to = source.indexOf("ports.server.writeFrame(");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const between = source.slice(from + "await borrowCredentialValue(".length, to);
    expect(/\bawait\b|\.then\(|queueMicrotask|setTimeout|setImmediate|nextTick/.test(between)).toBe(false);
    expect((source.match(/\bawait\b/g) ?? []).length).toBe(1);
  });
});

// ---- 루프백: 실제 서버(127.0.0.1, 빈 포트, 상호 TLS)로 보낸 값 틀을 실행기 쪽 섞어 받는 디코더가 받는다 ----

const HOST = "127.0.0.1";
const pki = makePki();
const material = (leaf: Issued): RawTlsMaterial => ({ certificatePem: leaf.pem, privateKeyPem: leaf.keyPem, trustBundlePem: pki.ca.pem });
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

// 소켓 사건을 기다린다. 시각을 맞추려는 것이 아니라 상태가 오기를 기다린다(오지 않으면 실패).
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("기다리던 상태가 오지 않았다");
    await Bun.sleep(5);
  }
}

interface Keys {
  readonly privateKey: KeyObject;
  readonly raw: string;
}
function newKeys(): Keys {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, raw: rawPublicKey(publicKey) };
}
const SUP = newKeys();
const K1 = newKeys();
const hex32 = () => (++ids).toString(16).padStart(32, "0");
function seal(keys: Keys, action: string, generation: number, at: number, body: unknown): Envelope {
  return sealEnvelope(
    { sender: EXEC, recipient: "supervisor", action, request_id: uuid(), stop_generation: generation, run_generation: 0, issued_at: at, nonce: hex32(), body } as never,
    keys.privateKey,
  );
}
const toFrame = (envelope: Envelope) => {
  const encoded = encodeFrame(new TextEncoder().encode(JSON.stringify(envelope)));
  if (!encoded.ok) throw new Error(encoded.reason);
  return encoded.frame;
};

test("루프백: 실제 서버로 보낸 값 틀 하나를 실행기 쪽 섞어 받는 디코더가 같은 실행 ID·지문·값으로 받는다", async () => {
  const settings: RegistrySettings = { environment: "home", targets: [{ target: "reader", namespace: "olive-reader", roles: ["isolated_reader"] }] };
  const doc = new TextEncoder().encode(
    JSON.stringify({ environment: "home", revision: 1, executors: [{ target: "reader", role: "isolated_reader", instance: "r1", storage: "s1", public_key: K1.raw, active: true }] }),
  );
  const applied = RegistryState.start(settings).apply({ kind: "content", content: doc });
  if (applied.kind !== "applied") throw new Error("시험 등록표가 적용되지 않았다");
  const clock = { t: Date.now() };
  const restorer = { stopGeneration: () => GEN };
  const notes: ServerNote[] = [];
  const reply: ReplyTools = { seal: (input) => sealEnvelope(input, SUP.privateKey), requestId: uuid, nonce: hex32 };
  const started = await startConnectionServer({
    host: HOST,
    port: 0,
    material: material(pki.supervisor()),
    clock: () => clock.t,
    registry: applied.state,
    restorer: () => restorer,
    runGeneration: () => undefined,
    nonces: { consume: () => true },
    reply,
    deliver: () => {},
    observe: (note) => notes.push(note),
    maxPendingWriteBytes: limits.MAX_MESSAGE_BYTES,
  });
  if (!started.ok) throw new Error(`서버가 시작하지 않았다: ${started.failure.kind}`);
  const server: ConnectionServer = started.server;
  cleanup.push(() => server.close());

  const client = createTlsClient({ address: HOST, port: server.port, supervisorDnsName: SUPERVISOR_DNS, supervisorUri: SUPERVISOR_URI, material: material(pki.executor()), now: Date.now });
  cleanup.push(() => client.close());
  const socket = (await client.connect()).socket;
  socket.on("error", () => {});
  const decoder = createMixedFrameDecoder();
  const envelopes: unknown[] = [];
  const credentials: DecodedCredential[] = [];
  let rejected: string | null = null;
  socket.on("data", (chunk: Buffer) => {
    const step = decoder.push(new Uint8Array(chunk));
    if (step.rejected !== null) rejected = step.rejected;
    for (const frame of step.frames) {
      if (frame.kind === "envelope") envelopes.push(frame.envelope.value);
      else credentials.push(frame.credential);
    }
  });
  await until(() => notes.some((n) => n.kind === "opened"));
  const connection = (notes.find((n) => n.kind === "opened") as Extract<ServerNote, { kind: "opened" }>).connection;
  socket.write(toFrame(seal(K1, "stop_sync_request", 0, clock.t, { challenge: hex32() })));
  await until(() => envelopes.length === 1);
  socket.write(toFrame(seal(K1, "hello", GEN, clock.t, { profile_revision: "profile-1", policy_revision: "policy-1", runs: [], unacked_ids: [] })));
  await until(() => server.recognized(EXEC) === connection);

  const lent: Uint8Array[] = [];
  const sendNotes: CredentialSendNote[] = [];
  const row = runRow({ deadlineAt: clock.t + 600_000 });
  const sender = createCredentialSender({
    server,
    ledger: { getRun: (runId: string) => ({ known: true, value: runId === RUN ? row : null }) },
    gate: { stopGeneration: () => GEN, intakeOpen: () => true },
    clock: { now: () => clock.t },
    files: {
      async read() {
        const bytes = sampleBytes();
        lent.push(bytes);
        return { kind: "bytes", bytes };
      },
    },
    policy: POLICY,
    observe: (note) => sendNotes.push(note),
  });
  const result = await sender.onReceipt(...receipt({ connection }));
  expect(safe(result)).toEqual({ kind: "written", connection, runId: RUN });
  await until(() => credentials.length === 1);
  await until(() => sendNotes.some((n) => n.kind === "wiped"));
  expect(rejected).toBeNull();
  const got = credentials[0]!;
  expect(got.runId).toBe(RUN);
  expect(got.digest).toBe(DIGEST);
  expect(same(got.value, sampleBytes())).toBe(true);
  expect(sendNotes.filter((n) => n.kind === "wiped").map((n) => n.kind === "wiped" && n.at)).toEqual(["flushed"]);
  expect(allZero(lent[0]!)).toBe(true);
  got.value.fill(0);
  socket.destroy();
});
