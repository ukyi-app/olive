import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { limits, type Result, resultDigest } from "../../../src/contract/v1/index.ts";
import { STORED_REF as LEDGER_STORED_REF } from "../../../src/ledger/input.ts";
import {
  type BackendRead,
  type CandidateGate,
  deleteStored,
  listStored,
  type ReadGate,
  readCandidate,
  readStored,
  type ResultBackend,
  resultBody,
  type StoredEntry,
  storeResult,
  sweepStored,
} from "../../../src/supervisor/scheduler/result-store.ts";
import { readText } from "../../files.ts";

// 숫자와 ID는 이 시험이 고른 값이다. 운영값이 아니다. 조각 32KiB와 후보 1MiB는 D-80의 값을 인자로 넘긴다.
const NOW = 1_800_000_000_000;
const CHUNK_MAX = 32 * 1024;
const CONTENT_MAX = 1024 * 1024;
const RUN_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const RUN_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const RUN_C = "cccccccc-0000-4000-8000-00000000000c";
const OWNER = "11111111-0000-4000-8000-000000000001";
const OTHER = "22222222-0000-4000-8000-000000000002";
// 본문에만 있는 표식. 본문 밖의 답·목록·참조에 나오면 샌 것이다.
const SECRET = "SECRET-BODY-7f3a91";

const result = (summary: string): Result => ({
  role: "diagnosis",
  outcome: "completed",
  summary: `${SECRET} ${summary}`,
  items: [{ kind: "finding", text: "원인 후보 하나" }],
  refs: [],
});
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type Op = "putNew" | "read" | "readRange" | "remove" | "has" | "keys";
type Fault = "unknown" | "throw" | "garbage";

// 메모리 안의 가짜 백엔드. 고장을 연산별로 넣는다.
class FakeBackend implements ResultBackend {
  readonly data = new Map<string, Uint8Array>();
  readonly faults: Partial<Record<Op, Fault>> = {};
  readonly calls: { op: Op; key: string }[] = [];
  // remove가 "지웠다"고 답하면서 실제로는 남기는 백엔드.
  lieOnRemove = false;

  #fault<T>(op: Op, key: string): T | null {
    this.calls.push({ op, key });
    const fault = this.faults[op];
    if (fault === "throw") throw new Error(`backend ${op} failed`);
    if (fault === "unknown") return { status: "unknown" } as T;
    if (fault === "garbage") return { status: "ok" } as T;
    return null;
  }
  putNew(key: string, bytes: Uint8Array) {
    const f = this.#fault<{ status: "unknown" }>("putNew", key);
    if (f) return f;
    if (this.data.has(key)) return { status: "exists" as const };
    this.data.set(key, bytes.slice());
    return { status: "stored" as const };
  }
  read(key: string): BackendRead {
    const f = this.#fault<BackendRead>("read", key);
    if (f) return f;
    const bytes = this.data.get(key);
    return bytes === undefined ? { status: "absent" } : { status: "ok", bytes: bytes.slice() };
  }
  readRange(key: string, offset: number, length: number): BackendRead {
    const f = this.#fault<BackendRead>("readRange", key);
    if (f) return f;
    const bytes = this.data.get(key);
    return bytes === undefined ? { status: "absent" } : { status: "ok", bytes: bytes.slice(offset, offset + length) };
  }
  remove(key: string) {
    const f = this.#fault<{ status: "unknown" }>("remove", key);
    if (f) return f;
    if (!this.data.has(key)) return { status: "absent" as const };
    if (!this.lieOnRemove) this.data.delete(key);
    return { status: "removed" as const };
  }
  has(key: string) {
    const f = this.#fault<{ status: "unknown" }>("has", key);
    if (f) return f;
    return this.data.has(key) ? { status: "present" as const } : { status: "absent" as const };
  }
  keys(prefix: string) {
    const f = this.#fault<{ status: "unknown" }>("keys", prefix);
    if (f) return f;
    return { status: "ok" as const, keys: [...this.data.keys()].filter((key) => key.startsWith(prefix)) };
  }
}

// 판정 포트. readable이 정한 값을 답하고, 물어본 것을 남긴다.
function gates(readable: boolean | Fault = true, candidates: Record<string, string> = {}, candidateFault?: Fault) {
  const asked: StoredEntry[] = [];
  const gate: ReadGate = {
    readable(entry) {
      asked.push(entry);
      if (readable === "throw") throw new Error("gate failed");
      if (readable === "unknown") return { known: false };
      if (readable === "garbage") return { known: true, value: "yes" } as never;
      return { known: true, value: readable };
    },
  };
  const candidate: CandidateGate = {
    candidate(digest) {
      if (candidateFault === "throw") throw new Error("candidate failed");
      if (candidateFault === "unknown") return { known: false };
      if (candidateFault === "garbage") return { known: true, value: { ref: "../../etc/passwd" } };
      const ref = candidates[digest];
      return { known: true, value: ref === undefined ? null : { ref } };
    },
  };
  return { gate, candidates: candidate, asked };
}

function stored(backend: FakeBackend, run: string, owner: string, r: Result, now = NOW) {
  const body = resultBody(r);
  const answer = storeResult(backend, { runId: run, owner, digest: resultDigest(r), body, now });
  if (answer.status !== "stored") throw new Error(`보관 실패: ${answer.status}`);
  return { ref: answer.ref, body, digest: resultDigest(r) };
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

describe("인수 시험", () => {
  test("본문 저장 뒤 커밋 전 중단: 같은 결과를 다시 보관해도 한 벌이고 같은 참조다", () => {
    const backend = new FakeBackend();
    const r = result("첫 결과");
    const first = storeResult(backend, { runId: RUN_A, owner: OWNER, digest: resultDigest(r), body: resultBody(r), now: NOW });
    expect(first).toEqual({ status: "stored", ref: expect.stringMatching(/^results\//), created: true });
    // 장부에 적기 전에 감독이 멈췄다. 실행기가 같은 보고를 다시 보낸다(늦은 시각).
    const again = storeResult(backend, { runId: RUN_A, owner: OWNER, digest: resultDigest(r), body: resultBody(r), now: NOW + 5_000 });
    expect(again).toEqual({ status: "stored", ref: (first as { ref: string }).ref, created: false });
    expect(backend.data.size).toBe(1);
    // 보관 시각은 처음 것이다(고아의 나이를 다시 세지 않는다).
    const listed = listStored(backend);
    expect(listed).toEqual({ status: "ok", entries: [{ ref: (first as { ref: string }).ref, state: "stored", runId: RUN_A, storedAt: NOW }] });
  });

  test("확정된 결과 재조회: 소유자가 맞으면 전체와 조각이 같은 바이트다", () => {
    const backend = new FakeBackend();
    const r = result("확정된 결과");
    const { ref, body, digest } = stored(backend, RUN_A, OWNER, r);
    expect(ref).toMatch(LEDGER_STORED_REF);
    const { gate, asked } = gates(true);

    const whole = readStored({ backend, gate }, { ref, owner: OWNER, digest });
    if (whole.status !== "ok") throw new Error(whole.status);
    expect(whole.bytes).toEqual(body);
    expect(whole.digest).toBe(resultDigest(r));
    expect(whole.total).toBe(body.length);
    expect(JSON.parse(new TextDecoder().decode(whole.bytes))).toEqual(r);

    const step = 7;
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < body.length; offset += step) {
      const part = readStored({ backend, gate }, { ref, owner: OWNER, digest, range: { offset, length: step } });
      if (part.status !== "ok") throw new Error(part.status);
      expect(part.offset).toBe(offset);
      parts.push(part.bytes);
    }
    expect(concat(parts)).toEqual(body);
    // 판정 포트는 참조·실행·보관 시각만 받는다.
    expect(asked[0]).toEqual({ ref, runId: RUN_A, storedAt: NOW });
  });

  test("만료·잊기 뒤 접근 차단: 판정이 막으면 closed, 지운 뒤에는 없음, 남의 참조는 없는 참조와 같은 답", () => {
    const backend = new FakeBackend();
    const { ref, digest } = stored(backend, RUN_A, OWNER, result("만료될 결과"));
    const closed = gates(false);
    expect(readStored({ backend, gate: closed.gate }, { ref, owner: OWNER, digest })).toEqual({ status: "closed" });
    expect(readStored({ backend, gate: closed.gate }, { ref, owner: OWNER, digest, range: { offset: 0, length: 4 } })).toEqual({ status: "closed" });

    const open = gates(true);
    const foreign = readStored({ backend, gate: open.gate }, { ref, owner: OTHER, digest });
    const missingRef = ref.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    const missing = readStored({ backend, gate: open.gate }, { ref: missingRef, owner: OWNER, digest });
    expect(foreign).toEqual({ status: "absent" });
    expect(missing).toEqual(foreign);
    // 남의 참조로는 판정 포트까지 가지 않는다.
    expect(open.asked).toEqual([]);

    expect(deleteStored(backend, ref)).toEqual({ status: "deleted" });
    expect(readStored({ backend, gate: open.gate }, { ref, owner: OWNER, digest })).toEqual({ status: "absent" });
    expect(deleteStored(backend, ref)).toEqual({ status: "absent" });
    expect(backend.data.size).toBe(0);
  });

  test("결과 저장소 장애는 모름: 넣기·읽기·판정의 장애가 성공도 없음도 아니다", () => {
    const r = result("장애");
    const input = { runId: RUN_A, owner: OWNER, digest: resultDigest(r), body: resultBody(r), now: NOW };
    for (const fault of ["unknown", "throw", "garbage"] as const) {
      const backend = new FakeBackend();
      backend.faults.putNew = fault;
      // 참조 칸이 아예 없다: 부르는 쪽이 장부에 적거나 ACK할 거리가 없다.
      expect(storeResult(backend, input)).toEqual({ status: "unknown" });
    }
    // 이미 있다고 답했는데 확인 읽기가 안 되면 "보관됨"이 아니다.
    {
      const backend = new FakeBackend();
      stored(backend, RUN_A, OWNER, r);
      backend.faults.read = "unknown";
      expect(storeResult(backend, input)).toEqual({ status: "unknown" });
    }
    for (const fault of ["unknown", "throw", "garbage"] as const) {
      const backend = new FakeBackend();
      const { ref, digest } = stored(backend, RUN_A, OWNER, r);
      backend.faults.read = fault;
      expect(readStored({ backend, gate: gates(true).gate }, { ref, owner: OWNER, digest })).toEqual({ status: "unknown" });
    }
    for (const fault of ["unknown", "throw", "garbage"] as const) {
      const backend = new FakeBackend();
      const { ref, digest } = stored(backend, RUN_A, OWNER, r);
      expect(readStored({ backend, gate: gates(fault).gate }, { ref, owner: OWNER, digest })).toEqual({ status: "unknown" });
    }
    for (const fault of ["unknown", "throw"] as const) {
      const backend = new FakeBackend();
      const { ref } = stored(backend, RUN_A, OWNER, r);
      backend.faults.remove = fault;
      expect(deleteStored(backend, ref)).toEqual({ status: "unknown" });
    }
    {
      // 지웠다고 답했는데 아직 있으면 지운 것이 아니다.
      const backend = new FakeBackend();
      const { ref } = stored(backend, RUN_A, OWNER, r);
      backend.lieOnRemove = true;
      expect(deleteStored(backend, ref)).toEqual({ status: "unknown" });
    }
    {
      const backend = new FakeBackend();
      stored(backend, RUN_A, OWNER, r);
      backend.faults.keys = "throw";
      expect(listStored(backend)).toEqual({ status: "unknown" });
      expect(sweepStored(backend, { keep: [], before: NOW + 1 })).toEqual({ status: "unknown" });
      expect(backend.data.size).toBe(1);
    }
  });
});

describe("보관의 거절", () => {
  test("digest 불일치: 받은 digest가 본문의 것이 아니면 백엔드를 부르지 않고 거절한다", () => {
    const backend = new FakeBackend();
    const r = result("본문");
    const answer = storeResult(backend, { runId: RUN_A, owner: OWNER, digest: resultDigest(result("다른 본문")), body: resultBody(r), now: NOW });
    expect(answer).toEqual({ status: "rejected", reason: "digest_mismatch" });
    expect(backend.calls).toEqual([]);
  });

  test("크기 초과: 계약 v1 결과 상한까지 받고, 한 바이트라도 넘으면 거절한다", () => {
    const backend = new FakeBackend();
    const at = new Uint8Array(limits.RESULT_MAX_BYTES).fill(0x61);
    expect(storeResult(backend, { runId: RUN_A, owner: OWNER, digest: sha(at), body: at, now: NOW }).status).toBe("stored");
    const over = new Uint8Array(limits.RESULT_MAX_BYTES + 1).fill(0x61);
    expect(storeResult(backend, { runId: RUN_B, owner: OWNER, digest: sha(over), body: over, now: NOW })).toEqual({ status: "rejected", reason: "too_large" });
    expect(backend.data.size).toBe(1);
  });

  test("본문 digest는 계약 v1의 resultDigest와 같다", () => {
    const r = result("digest");
    expect(sha(resultBody(r))).toBe(resultDigest(r));
  });

  test("충돌: 같은 실행의 다른 digest나 다른 소유자는 덮어쓰지 않고 구별해 답한다", () => {
    const backend = new FakeBackend();
    const first = stored(backend, RUN_A, OWNER, result("앞의 것"));
    const other = result("뒤의 것");
    expect(storeResult(backend, { runId: RUN_A, owner: OWNER, digest: resultDigest(other), body: resultBody(other), now: NOW })).toEqual({ status: "conflict" });
    expect(storeResult(backend, { runId: RUN_A, owner: OTHER, digest: first.digest, body: first.body, now: NOW })).toEqual({ status: "conflict" });
    expect(backend.data.size).toBe(1);
    const read = readStored({ backend, gate: gates(true).gate }, { ref: first.ref, owner: OWNER, digest: first.digest });
    expect(read.status === "ok" && read.bytes).toEqual(first.body);
    // 뒤의 것의 digest로 같은 참조를 읽으면 그 내용은 여기 없다.
    expect(readStored({ backend, gate: gates(true).gate }, { ref: first.ref, owner: OWNER, digest: resultDigest(other) })).toEqual({ status: "absent" });
  });

  test("꼴이 틀린 입력은 백엔드를 부르지 않는다(키는 이 모듈만 만든다)", () => {
    const backend = new FakeBackend();
    const r = result("꼴");
    const good = { runId: RUN_A, owner: OWNER, digest: resultDigest(r), body: resultBody(r), now: NOW };
    for (const bad of [
      { ...good, runId: "../../etc" },
      { ...good, owner: "owner" },
      { ...good, digest: "X".repeat(64) },
      { ...good, body: new Uint8Array(0) },
      { ...good, body: "text" as never },
      { ...good, now: 1.5 },
      { ...good, extra: 1 } as never,
    ]) {
      expect(storeResult(backend, bad)).toEqual({ status: "rejected", reason: "invalid_input" });
    }
    const { gate } = gates(true);
    for (const ref of ["results/../x", "other/aaaaaaaa-0000-4000-8000-00000000000a", "result/aaaaaaaa-0000-4000-8000-00000000000a"]) {
      expect(readStored({ backend, gate }, { ref, owner: OWNER, digest: good.digest })).toEqual({ status: "invalid" });
      expect(deleteStored(backend, ref)).toEqual({ status: "invalid" });
    }
    expect(backend.calls).toEqual([]);
    stored(backend, RUN_A, OWNER, r);
    for (const key of backend.data.keys()) expect(key).toMatch(/^result\/[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("손상", () => {
  test("본문이나 머리가 바뀐 기록은 내주지 않는다", () => {
    const backend = new FakeBackend();
    const { ref, digest } = stored(backend, RUN_A, OWNER, result("손상"));
    const [key, bytes] = [...backend.data.entries()][0]!;
    const { gate } = gates(true);

    const body = bytes.slice();
    body[body.length - 2] ^= 0x01;
    backend.data.set(key, body);
    expect(readStored({ backend, gate }, { ref, owner: OWNER, digest })).toEqual({ status: "corrupt" });
    expect(readStored({ backend, gate }, { ref, owner: OWNER, digest, range: { offset: 0, length: 1 } })).toEqual({ status: "corrupt" });
    // 손상된 자리는 "이미 보관됨"을 입증하지 못한다.
    const r = result("손상");
    expect(storeResult(backend, { runId: RUN_A, owner: OWNER, digest, body: resultBody(r), now: NOW })).toEqual({ status: "unknown" });

    const head = bytes.slice();
    head[6] = 0x00;
    backend.data.set(key, head);
    expect(readStored({ backend, gate }, { ref, owner: OWNER, digest })).toEqual({ status: "corrupt" });

    // 다른 실행의 기록이 이 자리에 있으면(옮겨진 기록) 손상이다.
    const elsewhere = new FakeBackend();
    stored(elsewhere, RUN_B, OWNER, result("손상"));
    backend.data.set(key, [...elsewhere.data.values()][0]!);
    expect(readStored({ backend, gate }, { ref, owner: OWNER, digest })).toEqual({ status: "corrupt" });
  });
});

describe("고아 정리", () => {
  test("목록은 참조·실행·보관 시각만 싣고, 정리는 장부 밖의 오래된 것과 손상된 것만 지운다", () => {
    const backend = new FakeBackend();
    const kept = stored(backend, RUN_A, OWNER, result("장부에 있음"), NOW);
    const orphan = stored(backend, RUN_B, OWNER, result("고아"), NOW);
    const young = stored(backend, RUN_C, OWNER, result("아직 장부에 적는 중"), NOW + 10_000);
    backend.data.set("result/ffffffff-0000-8000-8000-00000000000f", new Uint8Array([0, 0, 0, 200, 1, 2]));
    backend.data.set("elsewhere/kept", new Uint8Array([1]));

    const listed = listStored(backend);
    if (listed.status !== "ok") throw new Error(listed.status);
    const text = JSON.stringify(listed);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(kept.digest);
    expect(text).not.toContain(OWNER);
    for (const entry of listed.entries) {
      expect(Object.keys(entry).sort()).toEqual(entry.state === "stored" ? ["ref", "runId", "state", "storedAt"] : ["ref", "state"]);
    }
    expect(listed.entries.filter((e) => e.state === "damaged").map((e) => e.ref)).toEqual(["results/ffffffff-0000-8000-8000-00000000000f"]);

    const swept = sweepStored(backend, { keep: [kept.ref], before: NOW + 1 });
    expect(swept).toEqual({ status: "ok", deleted: expect.arrayContaining([orphan.ref, "results/ffffffff-0000-8000-8000-00000000000f"]), failed: [] });
    expect(swept.status === "ok" ? swept.deleted : []).toHaveLength(2);
    const { gate } = gates(true);
    expect(readStored({ backend, gate }, { ref: orphan.ref, owner: OWNER, digest: orphan.digest })).toEqual({ status: "absent" });
    expect(readStored({ backend, gate }, { ref: kept.ref, owner: OWNER, digest: kept.digest }).status).toBe("ok");
    expect(readStored({ backend, gate }, { ref: young.ref, owner: OWNER, digest: young.digest }).status).toBe("ok");
    // 이 모듈의 키가 아닌 것은 건드리지 않는다.
    expect(backend.data.has("elsewhere/kept")).toBe(true);
  });

  test("머리를 읽지 못한 기록은 지우지 않고 실패로 남긴다", () => {
    const backend = new FakeBackend();
    const orphan = stored(backend, RUN_B, OWNER, result("고아"), NOW);
    backend.faults.readRange = "unknown";
    expect(sweepStored(backend, { keep: [], before: NOW + 1 })).toEqual({ status: "ok", deleted: [], failed: [orphan.ref] });
    expect(backend.data.size).toBe(1);
    expect(sweepStored(backend, { keep: [], before: Number.NaN })).toEqual({ status: "invalid" });
  });
});

describe("digest로 읽기(현관 후보)", () => {
  test("판정이 허락한 digest만 조각으로 읽고, 답할 수 없음과 모름을 구별한다", () => {
    const backend = new FakeBackend();
    const { ref, body, digest } = stored(backend, RUN_A, OWNER, result("후보 본문"));
    const allowed = gates(true, { [digest]: ref });
    const ports = { backend, gate: allowed.gate, candidates: allowed.candidates };
    const query = { digest, offset: 0, length: CHUNK_MAX, maxChunkBytes: CHUNK_MAX, maxContentBytes: CONTENT_MAX };

    const whole = readCandidate(ports, query);
    expect(whole.status === "ok" && whole.bytes).toEqual(body);
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < body.length; offset += 50) {
      const part = readCandidate(ports, { ...query, offset, length: 50 });
      if (part.status !== "ok") throw new Error(part.status);
      expect(part.total).toBe(body.length);
      parts.push(part.bytes);
    }
    expect(concat(parts)).toEqual(body);

    // 후보가 아닌 digest: 답할 수 없음.
    const notCandidate = gates(true, {});
    expect(readCandidate({ backend, gate: notCandidate.gate, candidates: notCandidate.candidates }, query)).toEqual({ status: "unavailable" });
    // 만료로 막힘: 답할 수 없음.
    const expired = gates(false, { [digest]: ref });
    expect(readCandidate({ backend, gate: expired.gate, candidates: expired.candidates }, query)).toEqual({ status: "unavailable" });
    // 판정 포트의 장애: 모름.
    for (const fault of ["unknown", "throw", "garbage"] as const) {
      const broken = gates(true, { [digest]: ref }, fault);
      expect(readCandidate({ backend, gate: broken.gate, candidates: broken.candidates }, query)).toEqual({ status: "unknown" });
    }
    // 판정 포트가 다른 내용의 자리를 가리키면 그 바이트를 내주지 않는다.
    const elsewhere = stored(backend, RUN_B, OWNER, result("다른 내용"));
    const wrong = gates(true, { [digest]: elsewhere.ref });
    expect(readCandidate({ backend, gate: wrong.gate, candidates: wrong.candidates }, query)).toEqual({ status: "unknown" });
    // 조각 상한을 넘는 길이, 끝을 넘는 위치.
    expect(readCandidate(ports, { ...query, length: CHUNK_MAX + 1 })).toEqual({ status: "invalid" });
    expect(readCandidate(ports, { ...query, offset: body.length })).toEqual({ status: "invalid" });
    // 지운 뒤에는 답할 수 없음.
    deleteStored(backend, ref);
    expect(readCandidate(ports, query)).toEqual({ status: "unavailable" });
  });
});

describe("새는 길", () => {
  test("참조와 실패의 답에 본문·소유자·실행 ID·digest가 없다", () => {
    const backend = new FakeBackend();
    const r = result("새는 길");
    const { ref, digest } = stored(backend, RUN_A, OWNER, r);
    for (const value of [SECRET, OWNER, RUN_A, digest, RUN_A.replaceAll("-", "")]) expect(ref).not.toContain(value);
    backend.faults.read = "throw";
    const answers = [
      readStored({ backend, gate: gates(true).gate }, { ref, owner: OWNER, digest }),
      storeResult(backend, { runId: RUN_A, owner: OWNER, digest: resultDigest(result("x")), body: resultBody(r), now: NOW }),
      storeResult(backend, { runId: RUN_A, owner: OWNER, digest, body: resultBody(r), now: NOW }),
    ];
    for (const answer of answers) expect(JSON.stringify(answer)).not.toContain(SECRET);
  });

  test("모듈에 시계·난수·환경·파일·타이머·모듈 수준 가변 상태가 없다", async () => {
    const source = await readText("src/supervisor/scheduler/result-store.ts");
    const code = source.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/Date\.now|new Date|performance\.|Math\.random|randomUUID|getRandomValues|randomBytes|process\.|setTimeout|setInterval|Bun\.(file|write|spawn)|node:fs|node:net|node:os|console\./);
    expect(code).not.toMatch(/^(let|var) /m);
    expect(code).not.toMatch(/^const \w+ = new (Map|Set|Array|WeakMap)\b/m);
    expect(code).not.toMatch(/contract\/v2/);
  });
});
