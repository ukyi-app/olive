// 제어(실행기) ↔ 대리(역할 컨테이너의 PID 1) 사이 링크의 메시지와 그 바이트. 양쪽이 이 파일 하나를 import한다.
// 틀은 transport/framing.ts 그대로다: 메시지는 봉투 틀(길이 접두 + UTF-8 JSON), 자격 값은 start 바로 뒤의 값 틀(0x01) 하나.
// 메시지 표와 차례는 agent.md.
//
// 함정: 링크의 말에는 서명이 없다. 누가 보냈는지는 배치(제어만 듣는 소켓, 역할에 읽기 전용인 폴더)가 정하고, 이 파일은 꼴과 차례만 본다.
// 그래서 꼴·차례가 하나라도 어긋나면 디코더는 거절하고 끝난다(다시 동기화하지 않는다). 받는 쪽은 그것을 링크 이상으로 다룬다.
//
// 자격 값은 JSON을 지나지 않는다. 시작(start) 바로 뒤의 값 틀로만 오고, 디코딩한 값은 CredentialValue에 싸여
// JSON.stringify·console.log·오류 메시지에 바이트가 실리지 않는다. 거절 사유는 언제나 이름뿐이다.
import { createHash, timingSafeEqual } from "node:crypto";
import {
  createFrameDecoder,
  createMixedFrameDecoder,
  encodeFrame,
  type FrameDecoder,
  type MixedFrameDecoder,
  type MixedFrameRejectReason,
} from "../transport/framing.ts";

export const LINK_VERSION = 1;

// 역할 프로그램의 stdout을 실을 때 한 메시지의 원 바이트 상한. base64로 4/3배가 되어도 봉투 상한(64KiB) 안에 든다.
export const OUTPUT_CHUNK_BYTES = 32 * 1024;
// start가 고를 수 있는 stdout 상한의 최대. 실행기 기본값(64KiB)의 네 배까지만 받는다.
export const OUTPUT_MAX_BYTES = 256 * 1024;
const ARGV_MAX = 256;
const ENV_MAX = 128;

export type RunId = string;

// 제어 → 대리
export type ControlMessage =
  | {
      readonly type: "start";
      readonly run_id: RunId;
      readonly program: string;
      readonly argv: readonly string[];
      readonly cwd: string;
      // 자격 밖의 고정 환경. 자격 값은 credential_env 이름으로 대리가 넣는다.
      readonly env: Readonly<Record<string, string>>;
      readonly credential_env: string;
      // 뒤따르는 값 틀의 SHA-256(소문자 16진 64자). 디코더가 값과 대조한다.
      readonly credential_digest: string;
      readonly output_bytes: number;
      // 에포크 밀리초.
      readonly deadline_at: number;
      readonly lease_until: number;
    }
  | { readonly type: "renew"; readonly run_id: RunId; readonly lease_until: number }
  | { readonly type: "terminate"; readonly seq: number }
  | { readonly type: "count"; readonly seq: number };

// 대리 → 제어
export type NotSpawnedReason = "aborted" | "cleanup_busy" | "spawn_failed" | "refused" | "expired" | "space_not_clean";
export type AgentMessage =
  | { readonly type: "hello" }
  | { readonly type: "spawned"; readonly run_id: RunId }
  | { readonly type: "output"; readonly run_id: RunId; readonly data: string }
  | {
      readonly type: "exited";
      readonly run_id: RunId;
      readonly code: number | null;
      readonly signal: string | null;
      readonly overflow: boolean;
      // 앞서 보낸 output 조각의 원 바이트 합.
      readonly stdout_bytes: number;
    }
  | { readonly type: "not_spawned"; readonly run_id: RunId; readonly reason: NotSpawnedReason }
  | { readonly type: "unconfirmed"; readonly run_id: RunId }
  | { readonly type: "terminated"; readonly seq: number }
  // 정리 코어의 survivors() 그대로. 0은 확인, null은 모름.
  | { readonly type: "counted"; readonly seq: number; readonly survivors: number | null };

const NOT_SPAWNED: readonly NotSpawnedReason[] = ["aborted", "cleanup_busy", "spawn_failed", "refused", "expired", "space_not_clean"];

export type LinkErrorCode =
  | MixedFrameRejectReason
  // 이름을 모르는 메시지, 또는 판(v)이 다르다.
  | "link_unknown_message"
  // 칸이 빠지거나 더 있거나 꼴이 틀리다.
  | "link_bad_message"
  // 차례가 틀리다(값 틀이 start 바로 뒤가 아님, hello가 처음이 아님 등).
  | "link_out_of_order"
  // 값 틀이 start의 실행 ID·지문과 맞지 않거나 값이 지문과 다르다.
  | "link_credential_mismatch"
  // stdout 조각의 합이 상한을 넘거나 exited가 말하는 합과 다르다.
  | "link_output_mismatch";

// 진단에 쓰는 것은 code뿐이다. 받은 바이트·값은 담지 않는다.
export class LinkError extends Error {
  constructor(readonly code: LinkErrorCode) {
    super(code);
  }
}

// 디코딩한 자격 값. 바이트는 비공개 칸에만 있고 열거·직렬화·inspect에 나오지 않는다.
// take()는 한 번만 바이트를 내준다. 받은 쪽이 쓰고 나서 0으로 채운다. 쓰지 않을 값은 discard()로 0으로 채운다.
export class CredentialValue {
  #bytes: Uint8Array | null;
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }
  take(): Uint8Array | null {
    const bytes = this.#bytes;
    this.#bytes = null;
    return bytes;
  }
  discard(): void {
    this.#bytes?.fill(0);
    this.#bytes = null;
  }
  toJSON(): string {
    return "[credential]";
  }
  toString(): string {
    return "[credential]";
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[credential]";
  }
}

export type StartMessage = Extract<ControlMessage, { type: "start" }>;
// 대리 쪽 디코더가 내는 것. start는 값 틀과 짝을 맞춘 뒤에만 나온다.
export type ReceivedControl = Exclude<ControlMessage, StartMessage> | (StartMessage & { readonly credential: CredentialValue });

// ---- 인코딩 ----

const utf8 = new TextEncoder();

function envelope(message: object): Uint8Array {
  const encoded = encodeFrame(utf8.encode(JSON.stringify({ v: LINK_VERSION, ...message })));
  if (!encoded.ok) throw new LinkError("link_bad_message");
  return encoded.frame;
}

// 제어가 보낼 봉투 틀. 보내기 전에 받는 쪽과 같은 꼴 검사를 지난다.
// start 바로 뒤에는 같은 실행 ID·지문의 값 틀(framing.ts의 encodeCredentialFrame)을 이어 보낸다. 이 파일은 값 틀을 만들지 않는다:
// src/에서 값 틀을 만드는 자리는 감독의 credential-send.ts 하나로 묶여 있다(test/supervisor/dispatch/credential-send.test.ts).
// 제어 쪽(O-b)이 값을 대리에게 넘기는 자리를 둘 때 그 규칙을 같은 변경에서 다시 정한다.
export function encodeControl(message: ControlMessage): Uint8Array {
  if (checkControl({ v: LINK_VERSION, ...message }) === null) throw new LinkError("link_bad_message");
  return envelope(message);
}

export function encodeAgent(message: AgentMessage): Uint8Array {
  if (checkAgent({ v: LINK_VERSION, ...message }) === null) throw new LinkError("link_bad_message");
  return envelope(message);
}

// stdout 바이트를 output 메시지들로 자른다. 해석하지 않는다.
export function outputMessages(runId: RunId, stdout: Uint8Array): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let at = 0; at < stdout.length; at += OUTPUT_CHUNK_BYTES) {
    messages.push({ type: "output", run_id: runId, data: Buffer.from(stdout.subarray(at, at + OUTPUT_CHUNK_BYTES)).toString("base64") });
  }
  return messages;
}

export function digestMatches(value: Uint8Array, digest: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(digest)) return false;
  return timingSafeEqual(createHash("sha256").update(value).digest(), Buffer.from(digest, "hex"));
}

// ---- 꼴 검사 ----

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type Fields = Record<string, unknown>;
const isObject = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const keysAre = (value: Fields, keys: readonly string[]) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};
const text = (value: unknown): value is string => typeof value === "string" && !value.includes("\0");
const absolute = (value: unknown) => text(value) && value.startsWith("/");
const epochMs = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const runId = (value: unknown) => typeof value === "string" && RUN_ID.test(value);

function envOk(value: unknown, credentialEnv: string): boolean {
  if (!isObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= ENV_MAX && entries.every(([name, v]) => ENV_NAME.test(name) && name !== credentialEnv && text(v));
}

// 꼴이 맞으면 v를 뺀 메시지, 아니면 null. 이름을 모르면 "unknown".
function checkControl(raw: unknown): ControlMessage | "unknown" | null {
  if (!isObject(raw) || raw.v !== LINK_VERSION) return "unknown";
  const m = raw;
  switch (m.type) {
    case "start":
      if (!keysAre(m, ["v", "type", "run_id", "program", "argv", "cwd", "env", "credential_env", "credential_digest", "output_bytes", "deadline_at", "lease_until"])) return null;
      if (!runId(m.run_id) || !absolute(m.program) || !absolute(m.cwd)) return null;
      if (!Array.isArray(m.argv) || m.argv.length > ARGV_MAX || !m.argv.every(text)) return null;
      if (typeof m.credential_env !== "string" || !ENV_NAME.test(m.credential_env) || !envOk(m.env, m.credential_env)) return null;
      if (typeof m.credential_digest !== "string" || !DIGEST.test(m.credential_digest)) return null;
      if (!positive(m.output_bytes) || m.output_bytes > OUTPUT_MAX_BYTES || !epochMs(m.deadline_at) || !epochMs(m.lease_until)) return null;
      return strip(m) as ControlMessage;
    case "renew":
      return keysAre(m, ["v", "type", "run_id", "lease_until"]) && runId(m.run_id) && epochMs(m.lease_until) ? (strip(m) as ControlMessage) : null;
    case "terminate":
    case "count":
      return keysAre(m, ["v", "type", "seq"]) && positive(m.seq) ? (strip(m) as ControlMessage) : null;
    default:
      return "unknown";
  }
}

function checkAgent(raw: unknown): AgentMessage | "unknown" | null {
  if (!isObject(raw) || raw.v !== LINK_VERSION) return "unknown";
  const m = raw;
  switch (m.type) {
    case "hello":
      return keysAre(m, ["v", "type"]) ? (strip(m) as AgentMessage) : null;
    case "spawned":
    case "unconfirmed":
      return keysAre(m, ["v", "type", "run_id"]) && runId(m.run_id) ? (strip(m) as AgentMessage) : null;
    case "output":
      return keysAre(m, ["v", "type", "run_id", "data"]) && runId(m.run_id) && typeof m.data === "string" && m.data.length > 0 && BASE64.test(m.data)
        ? (strip(m) as AgentMessage)
        : null;
    case "exited":
      return keysAre(m, ["v", "type", "run_id", "code", "signal", "overflow", "stdout_bytes"]) &&
        runId(m.run_id) &&
        (m.code === null || Number.isSafeInteger(m.code)) &&
        (m.signal === null || (typeof m.signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(m.signal))) &&
        typeof m.overflow === "boolean" &&
        Number.isSafeInteger(m.stdout_bytes) &&
        (m.stdout_bytes as number) >= 0 &&
        (!m.overflow || m.stdout_bytes === 0)
        ? (strip(m) as AgentMessage)
        : null;
    case "not_spawned":
      return keysAre(m, ["v", "type", "run_id", "reason"]) && runId(m.run_id) && NOT_SPAWNED.includes(m.reason as NotSpawnedReason)
        ? (strip(m) as AgentMessage)
        : null;
    case "terminated":
      return keysAre(m, ["v", "type", "seq"]) && positive(m.seq) ? (strip(m) as AgentMessage) : null;
    case "counted":
      return keysAre(m, ["v", "type", "seq", "survivors"]) &&
        positive(m.seq) &&
        (m.survivors === null || (Number.isSafeInteger(m.survivors) && (m.survivors as number) >= 0))
        ? (strip(m) as AgentMessage)
        : null;
    default:
      return "unknown";
  }
}

function strip(m: Fields): Fields {
  const { v: _, ...rest } = m;
  return rest;
}

// ---- 디코딩 ----

// 대리가 받는 쪽(제어 → 대리). 차례 규칙: start 바로 다음 틀은 그 start의 값 틀이어야 하고, 값 틀은 그 자리 밖에 오지 않는다.
// 실행의 차례(실행 중의 start, 실행이 없는 renew)는 대리의 상태라 agent.ts가 본다.
export class ControlDecoder {
  private readonly frames: MixedFrameDecoder = createMixedFrameDecoder();
  private pending: StartMessage | null = null;
  private failed: LinkError | null = null;

  // 조각을 넣고 완성된 메시지를 받는다. 거절하면 LinkError를 던지고, 그 뒤로는 같은 오류를 던진다.
  push(chunk: Uint8Array): ReceivedControl[] {
    return this.take(() => this.frames.push(chunk));
  }

  // 입력의 끝. 틀의 중간이거나 start가 값 틀을 기다리는 중이면 거절이다.
  end(): ReceivedControl[] {
    const out = this.take(() => this.frames.end());
    if (this.pending !== null) {
      this.fail("link_out_of_order", out);
      throw this.failed!;
    }
    return out;
  }

  private take(read: () => ReturnType<MixedFrameDecoder["push"]>): ReceivedControl[] {
    if (this.failed) throw this.failed;
    const step = read();
    const out: ReceivedControl[] = [];
    for (const frame of step.frames) {
      if (this.failed) {
        if (frame.kind === "credential") frame.credential.value.fill(0);
        continue;
      }
      if (frame.kind === "credential") {
        const start = this.pending;
        this.pending = null;
        const { runId: id, digest, value } = frame.credential;
        if (start === null) this.fail("link_out_of_order", out, value);
        else if (id !== start.run_id || digest !== start.credential_digest || !digestMatches(value, digest)) this.fail("link_credential_mismatch", out, value);
        else out.push({ ...start, credential: new CredentialValue(value) });
        continue;
      }
      if (this.pending !== null) {
        this.fail("link_out_of_order", out);
        continue;
      }
      const message = checkControl(frame.envelope.value);
      if (message === "unknown") this.fail("link_unknown_message", out);
      else if (message === null) this.fail("link_bad_message", out);
      else if (message.type === "start") this.pending = message;
      else out.push(message);
    }
    if (!this.failed && step.rejected !== null) this.fail(step.rejected, out);
    if (this.failed) throw this.failed;
    return out;
  }

  // 거절과 함께 이미 꺼낸 값도 버린다(앞선 정상 start의 값이 거절된 step에 섞여 새지 않게).
  private fail(code: LinkErrorCode, out: ReceivedControl[], value?: Uint8Array): void {
    value?.fill(0);
    for (const message of out) if (message.type === "start") message.credential.discard();
    out.length = 0;
    this.pending = null;
    this.failed = new LinkError(code);
  }
}

// 제어가 받는 쪽(대리 → 제어). 값 틀은 받지 않는다(봉투만 받는 디코더라 값 틀은 frame_too_large로 거절된다).
// 차례 규칙: hello가 맨 처음 한 번. 실행 하나의 말은 spawned → output* → exited|unconfirmed, 또는 not_spawned 하나이고,
// 한 실행의 말이 끝나기 전에 다른 실행의 말이 섞이지 않는다. output 합은 maxOutputBytes 이하이고 exited의 stdout_bytes와 같다.
// terminated·counted의 seq는 오름차순이다. 어느 요청의 답인지(늦은 답, 없는 요청의 답)는 요청을 아는 제어가 따로 본다.
export class AgentDecoder {
  private readonly frames: FrameDecoder = createFrameDecoder();
  private greeted = false;
  private running: { runId: RunId; bytes: number } | null = null;
  private lastSeq = 0;
  private failed: LinkError | null = null;

  constructor(private readonly maxOutputBytes: number = OUTPUT_MAX_BYTES) {}

  push(chunk: Uint8Array): AgentMessage[] {
    return this.take(() => this.frames.push(chunk));
  }

  end(): AgentMessage[] {
    return this.take(() => this.frames.end());
  }

  private take(read: () => ReturnType<FrameDecoder["push"]>): AgentMessage[] {
    if (this.failed) throw this.failed;
    const step = read();
    const out: AgentMessage[] = [];
    for (const { value } of step.envelopes) {
      const message = checkAgent(value);
      const problem = message === "unknown" ? "link_unknown_message" : message === null ? "link_bad_message" : this.order(message);
      if (problem !== null) {
        this.failed = new LinkError(problem);
        throw this.failed;
      }
      out.push(message as AgentMessage);
    }
    if (step.rejected !== null) {
      this.failed = new LinkError(step.rejected);
      throw this.failed;
    }
    return out;
  }

  private order(message: AgentMessage): LinkErrorCode | null {
    if (message.type === "hello") {
      if (this.greeted) return "link_out_of_order";
      this.greeted = true;
      return null;
    }
    if (!this.greeted) return "link_out_of_order";
    switch (message.type) {
      case "terminated":
      case "counted":
        if (message.seq <= this.lastSeq) return "link_out_of_order";
        this.lastSeq = message.seq;
        return null;
      case "spawned":
        if (this.running !== null) return "link_out_of_order";
        this.running = { runId: message.run_id, bytes: 0 };
        return null;
      case "not_spawned":
        return this.running !== null ? "link_out_of_order" : null;
      case "output": {
        if (this.running?.runId !== message.run_id) return "link_out_of_order";
        this.running.bytes += Buffer.from(message.data, "base64").length;
        return this.running.bytes > this.maxOutputBytes ? "link_output_mismatch" : null;
      }
      case "exited":
      case "unconfirmed": {
        if (this.running?.runId !== message.run_id) return "link_out_of_order";
        const bytes = this.running.bytes;
        this.running = null;
        return message.type === "exited" && message.stdout_bytes !== bytes ? "link_output_mismatch" : null;
      }
    }
  }
}
