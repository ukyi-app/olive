import { expect, test } from "bun:test";
import { type PeersPort, type OccupancyPort, type RestorePorts, RestoreOrderError, Restorer, RestoreStepError } from "../../../src/ledger/index.ts";
import {
  FrontDoorUnknownError,
  type FrontDoorRecoveryQueries,
  type PublicationReply,
  recoveryPorts,
  type StopLedgerReply,
} from "../../../src/supervisor/frontdoor/recovery.ts";
import { readText } from "../../files.ts";
import { clock, digest, must, NOW, open, ready, tempPath } from "../../ledger/helpers.ts";

const OPTS = { requiredPeers: ["front-door"] };
const FAILURES = [{ kind: "no_response" }, { kind: "timeout" }, { kind: "disconnected" }, { kind: "malformed" }] as const;

// 가짜 현관. 부른 순서와 인자를 남긴다. 실제 현관(인증·선로)은 이 시험에 없다.
function fakeFrontDoor(stop: () => unknown, publication: (jobId: string) => unknown = () => ({ kind: "pending" })) {
  const calls: { stop: number; lookups: string[] } = { stop: 0, lookups: [] };
  const queries = {
    readStopLedger: async () => {
      calls.stop += 1;
      return stop() as StopLedgerReply;
    },
    lookupPublication: async (jobId: string) => {
      calls.lookups.push(jobId);
      return publication(jobId) as PublicationReply;
    },
  } satisfies FrontDoorRecoveryQueries;
  return { queries, calls };
}

// 복원기의 나머지 두 포트는 이 PR의 범위가 아니다. 시험에서만 "판이 맞고 점유 없음"으로 채운다.
const peers: PeersPort = { contracts: async () => [{ peer: "front-door", contract: "olive-control/v1" }] };
const occupancy: OccupancyPort = { occupancy: async () => [] };
function restorePorts(queries: FrontDoorRecoveryQueries): RestorePorts {
  return { ...recoveryPorts(queries), peers, occupancy };
}

async function unknownReason(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    (value) => {
      throw new Error(`모름이어야 하는데 값이 나왔다: ${JSON.stringify(value)}`);
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FrontDoorUnknownError);
  return (error as FrontDoorUnknownError).reason;
}

// ---- 인수 시험 넷 ----

test("정지 원장 무응답은 null이 아니다", async () => {
  for (const failure of FAILURES) {
    const { queries } = fakeFrontDoor(() => failure);
    expect(await unknownReason(recoveryPorts(queries).stopAuthority.latestStop())).toBe(failure.kind);

    // 복원기에 넣어도 1단계가 통과하지 않고 세대를 내지 않는다. 장부에 0이 적히지 않는다.
    const ledger = open(tempPath());
    const restorer = new Restorer(ledger, restorePorts(queries), clock, OPTS);
    const step1 = await restorer.step1().catch((e: unknown) => e);
    expect(step1, failure.kind).toBeInstanceOf(RestoreStepError);
    expect(String((step1 as Error).message)).toContain("권위 정지 기록을 모름");
    expect(restorer.stopGeneration()).toBeNull();
    await expect(restorer.step2()).rejects.toBeInstanceOf(RestoreOrderError);
    expect(ledger.readStop()).toEqual({ known: true, value: null });
  }
  // 주입받은 함수가 던져도 같다.
  const thrown = recoveryPorts({
    readStopLedger: async () => {
      throw new Error("끊김");
    },
    lookupPublication: async () => ({ kind: "pending" }),
  });
  expect(await unknownReason(thrown.stopAuthority.latestStop())).toBe("query_failed");
});

test("확인된 부재만 초기화 후보", async () => {
  // 현관이 원장을 읽고 기록이 없다고 확인한 응답만 null이 되고, 첫 설치 장부에서 0을 적게 한다.
  const absent = fakeFrontDoor(() => ({ kind: "confirmed_absent" }));
  expect(await recoveryPorts(absent.queries).stopAuthority.latestStop()).toBeNull();
  const fresh = open(tempPath());
  expect(await new Restorer(fresh, restorePorts(absent.queries), clock, OPTS).step1()).toEqual({ stopGeneration: 0, stopped: false, source: "initialized" });

  // 같은 첫 설치 장부라도 무응답이면 0을 적지 않는다. 두 결과는 다르다.
  const silent = fakeFrontDoor(() => ({ kind: "no_response" }));
  const other = open(tempPath());
  const restorer = new Restorer(other, restorePorts(silent.queries), clock, OPTS);
  await expect(restorer.step1()).rejects.toBeInstanceOf(RestoreStepError);
  expect(other.readStop()).toEqual({ known: true, value: null });
  expect(restorer.stopGeneration()).toBeNull();

  // 기록이 있으면 그 두 칸만 그대로 넘긴다.
  const recorded = fakeFrontDoor(() => ({ kind: "recorded", generation: 7, stopped: true }));
  expect(await recoveryPorts(recorded.queries).stopAuthority.latestStop()).toEqual({ generation: 7, stopped: true });
  const ledger = open(tempPath());
  expect(await new Restorer(ledger, restorePorts(recorded.queries), clock, OPTS).step1()).toEqual({ stopGeneration: 7, stopped: true, source: "authority" });
});

test("게시 시간 초과는 unknown", async () => {
  const ledger = ready(open(tempPath()));
  for (const job of ["job-1", "job-2", "job-3", "job-4"]) must(ledger.recordPublication({ frontJobId: job, candidateDigest: digest(job), runId: null, now: NOW }));
  const replies: Record<string, unknown> = {
    "job-1": { kind: "timeout" },
    "job-2": { kind: "confirmed", outcome: "not_posted" },
    "job-3": { kind: "pending" },
    "job-4": { kind: "disconnected" },
  };
  const { queries } = fakeFrontDoor(
    () => ({ kind: "confirmed_absent" }),
    (job) => replies[job],
  );
  const port = recoveryPorts(queries).publications;
  expect(await unknownReason(port.lookup("job-1"))).toBe("timeout");
  expect(await port.lookup("job-2")).toEqual({ kind: "confirmed", outcome: "not_posted" });
  expect(await port.lookup("job-3")).toEqual({ kind: "pending" });

  const restorer = new Restorer(ledger, restorePorts(queries), clock, OPTS);
  await restorer.step1();
  await restorer.step2();
  await restorer.step3();
  expect(await restorer.step4()).toEqual({ confirmed: ["job-2"], pending: ["job-3"], unknown: ["job-1", "job-4"] });
  expect(ledger.publications()).toMatchObject({
    value: [
      { frontJobId: "job-1", state: "unknown", outcome: null },
      { frontJobId: "job-2", state: "confirmed", outcome: "not_posted" },
      { frontJobId: "job-3", state: "pending", outcome: null },
      { frontJobId: "job-4", state: "unknown", outcome: null },
    ],
  });
  // 게시 모름은 접수를 닫지 않고 그 작업만 남긴다(복원기의 기존 정책).
  expect((await restorer.step5()).intakeMayOpen).toBe(true);
});

test("조회 재시도는 같은 작업 ID", async () => {
  let attempt = 0;
  const { queries, calls } = fakeFrontDoor(
    () => ({ kind: "confirmed_absent" }),
    () => (++attempt === 1 ? { kind: "timeout" } : { kind: "confirmed", outcome: "posted" }),
  );
  const port = recoveryPorts(queries).publications;
  // 어댑터는 스스로 다시 묻지 않는다. 한 번 부르면 한 번 묻는다.
  expect(await unknownReason(port.lookup("job:a/1"))).toBe("timeout");
  expect(calls.lookups).toEqual(["job:a/1"]);
  expect(await port.lookup("job:a/1")).toEqual({ kind: "confirmed", outcome: "posted" });
  expect(calls.lookups).toEqual(["job:a/1", "job:a/1"]);

  // 재시작 두 번: 첫 복원에서 모름이 된 게시를 다음 복원이 같은 작업 ID로 다시 묻는다.
  const ledger = ready(open(tempPath()));
  must(ledger.recordPublication({ frontJobId: "job-7", candidateDigest: digest("c7"), runId: null, now: NOW }));
  let second = false;
  const front = fakeFrontDoor(
    () => ({ kind: "confirmed_absent" }),
    () => (second ? { kind: "confirmed", outcome: "posted" } : { kind: "timeout" }),
  );
  const first = new Restorer(ledger, restorePorts(front.queries), clock, OPTS);
  await first.step1();
  await first.step2();
  await first.step3();
  expect(await first.step4()).toEqual({ confirmed: [], pending: [], unknown: ["job-7"] });
  second = true;
  const again = new Restorer(ledger, restorePorts(front.queries), clock, OPTS);
  await again.step1();
  await again.step2();
  await again.step3();
  expect(await again.step4()).toEqual({ confirmed: ["job-7"], pending: [], unknown: [] });
  expect(front.calls.lookups).toEqual(["job-7", "job-7"]);
  expect(front.calls.stop).toBe(2);
});

// ---- 꼴이 틀린 응답은 모름이다 ----

const BAD_STOP: [string, unknown][] = [
  ["undefined", undefined],
  ["null", null],
  ["빈 객체", {}],
  ["배열", [{ kind: "confirmed_absent" }]],
  ["문자열", "confirmed_absent"],
  ["알 수 없는 kind", { kind: "absent" }],
  ["kind 대소문자", { kind: "Confirmed_absent" }],
  ["부재에 남는 칸", { kind: "confirmed_absent", generation: 0 }],
  ["세대 빠짐", { kind: "recorded", stopped: false }],
  ["정지 여부 빠짐", { kind: "recorded", generation: 3 }],
  ["음수 세대", { kind: "recorded", generation: -1, stopped: false }],
  ["정수가 아닌 세대", { kind: "recorded", generation: 1.5, stopped: false }],
  ["문자열 세대", { kind: "recorded", generation: "3", stopped: false }],
  ["NaN 세대", { kind: "recorded", generation: Number.NaN, stopped: false }],
  ["큰 세대", { kind: "recorded", generation: 2 ** 53, stopped: false }],
  ["문자열 정지 여부", { kind: "recorded", generation: 3, stopped: "false" }],
  ["null 정지 여부", { kind: "recorded", generation: 3, stopped: null }],
  ["기록에 남는 칸", { kind: "recorded", generation: 3, stopped: false, extra: 1 }],
  ["실패의 알 수 없는 kind", { kind: "refused" }],
];

test("꼴이 틀린 정지 원장 응답은 기록 없음이 아니라 모름이다", async () => {
  for (const [name, reply] of BAD_STOP) {
    const { queries } = fakeFrontDoor(() => reply);
    expect(await unknownReason(recoveryPorts(queries).stopAuthority.latestStop()), name).toBe("invalid_reply");
  }
});

const BAD_PUBLICATION: [string, unknown][] = [
  ["undefined", undefined],
  ["null", null],
  ["빈 객체", {}],
  ["배열", [{ kind: "pending" }]],
  ["알 수 없는 kind", { kind: "not_posted" }],
  ["결과 빠짐", { kind: "confirmed" }],
  ["알 수 없는 결과", { kind: "confirmed", outcome: "failed" }],
  ["대기에 남는 칸", { kind: "pending", outcome: "posted" }],
  ["확정에 남는 칸", { kind: "confirmed", outcome: "posted", at: 1 }],
];

test("꼴이 틀린 게시 응답은 게시 안 됨이 아니라 모름이다", async () => {
  for (const [name, reply] of BAD_PUBLICATION) {
    const { queries } = fakeFrontDoor(
      () => ({ kind: "confirmed_absent" }),
      () => reply,
    );
    expect(await unknownReason(recoveryPorts(queries).publications.lookup("job-1")), name).toBe("invalid_reply");
  }
  for (const failure of FAILURES) {
    const { queries } = fakeFrontDoor(
      () => ({ kind: "confirmed_absent" }),
      () => failure,
    );
    expect(await unknownReason(recoveryPorts(queries).publications.lookup("job-1"))).toBe(failure.kind);
  }
});

// ---- 응답은 자체 데이터 칸의 한 스냅샷으로만 읽는다 ----

// 원래 오류의 글이 어댑터 밖(메시지·cause·복원 단계의 메시지)으로 새는지 보는 표식.
const MARK = "바깥-표식-91c2";

async function unknownError(promise: Promise<unknown>): Promise<FrontDoorUnknownError> {
  const error = await promise.then(
    (value) => {
      throw new Error(`모름이어야 하는데 값이 나왔다: ${String(value)}`);
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FrontDoorUnknownError);
  return error as FrontDoorUnknownError;
}

// 원래 오류 객체도 그 글도 싣지 않는다.
function expectNoOutside(error: Error) {
  expect(error.cause).toBeUndefined();
  expect(Object.hasOwn(error, "cause")).toBe(false);
  expect(error.message).not.toContain(MARK);
}

// 부를 때마다 새 응답을 만든다(getter의 상태가 다른 호출로 새지 않게).
const TRICKY_STOP: [string, () => unknown][] = [
  ["부재에 열거 불가 칸", () => Object.defineProperty({ kind: "confirmed_absent" }, "error", { value: "timeout", enumerable: false })],
  ["부재에 심벌 칸", () => ({ kind: "confirmed_absent", [Symbol("error")]: "timeout" })],
  ["부재의 kind가 열거 불가", () => Object.defineProperty({}, "kind", { value: "confirmed_absent", enumerable: false })],
  ["부재의 kind가 getter", () => ({ get kind() { return "confirmed_absent"; } })],
  ["읽을 때마다 바뀌는 kind", () => {
    let reads = 0;
    return { get kind() { return ++reads === 1 ? "confirmed_absent" : "timeout"; } };
  }],
  ["키 열거가 던지는 Proxy", () => new Proxy({ kind: "confirmed_absent" }, { ownKeys() { throw new Error(MARK); } })],
  ["칸 설명자 판독이 던지는 Proxy", () => new Proxy({ kind: "confirmed_absent" }, { getOwnPropertyDescriptor() { throw new Error(MARK); } })],
  ["throw하는 getter", () => ({ get kind() { throw new Error(MARK); } })],
  ["일반 객체가 아닌 프로토타입의 부재", () => Object.assign(Object.create({ error: "timeout" }), { kind: "confirmed_absent" })],
  ["클래스 인스턴스의 부재", () => new (class { kind = "confirmed_absent"; })()],
  ["프로토타입에서만 물려받은 부재", () => Object.create({ kind: "confirmed_absent" })],
  ["함수", () => Object.assign(() => {}, { kind: "confirmed_absent" })],
  ["자체 __proto__ 칸", () => JSON.parse('{"kind":"confirmed_absent","__proto__":{"kind":"timeout"}}')],
  ["세대 음의 영", () => ({ kind: "recorded", generation: -0, stopped: false })],
  ["세대가 getter", () => ({ kind: "recorded", get generation() { return 7; }, stopped: true })],
  ["기록에 열거 불가 칸", () => Object.defineProperty({ kind: "recorded", generation: 7, stopped: true }, "note", { value: 1, enumerable: false })],
];

for (const [name, make] of TRICKY_STOP) {
  test(`정지 원장 ${name}: 모름이고 첫 설치 장부에 정지 행을 남기지 않는다`, async () => {
    const { queries } = fakeFrontDoor(make);
    const error = await unknownError(recoveryPorts(queries).stopAuthority.latestStop());
    expect(error.reason, name).toBe("invalid_reply");
    expectNoOutside(error);

    const ledger = open(tempPath());
    const restorer = new Restorer(ledger, restorePorts(queries), clock, OPTS);
    const step1 = await restorer.step1().catch((e: unknown) => e);
    expect(step1, name).toBeInstanceOf(RestoreStepError);
    expect((step1 as Error).message, name).not.toContain(MARK);
    expect(restorer.stopGeneration(), name).toBeNull();
    expect(ledger.readStop(), name).toEqual({ known: true, value: null });
  });
}

test("정지 원장 대조군: 정확한 부재(null 프로토타입 포함)는 initialized, 정상 +0 기록은 authority", async () => {
  for (const make of [() => ({ kind: "confirmed_absent" }), () => Object.assign(Object.create(null), { kind: "confirmed_absent" })]) {
    const absent = fakeFrontDoor(make);
    expect(await recoveryPorts(absent.queries).stopAuthority.latestStop()).toBeNull();
    const fresh = open(tempPath());
    expect(await new Restorer(fresh, restorePorts(absent.queries), clock, OPTS).step1()).toEqual({ stopGeneration: 0, stopped: false, source: "initialized" });
  }
  const zero = fakeFrontDoor(() => ({ kind: "recorded", generation: 0, stopped: false }));
  const value = await recoveryPorts(zero.queries).stopAuthority.latestStop();
  expect(value).toEqual({ generation: 0, stopped: false });
  expect(Object.is(value?.generation, 0)).toBe(true);
  const ledger = open(tempPath());
  expect(await new Restorer(ledger, restorePorts(zero.queries), clock, OPTS).step1()).toEqual({ stopGeneration: 0, stopped: false, source: "authority" });
});

const TRICKY_PUBLICATION: [string, () => unknown][] = [
  ["대기에 열거 불가 칸", () => Object.defineProperty({ kind: "pending" }, "error", { value: "timeout", enumerable: false })],
  ["대기에 심벌 칸", () => ({ kind: "pending", [Symbol("error")]: "timeout" })],
  ["대기의 kind가 getter", () => ({ get kind() { return "pending"; } })],
  ["읽을 때마다 바뀌는 kind", () => {
    let reads = 0;
    return { get kind() { return ++reads === 1 ? "pending" : "timeout"; } };
  }],
  ["확정의 결과가 getter", () => ({ kind: "confirmed", get outcome() { return "not_posted"; } })],
  ["확정에 열거 불가 칸", () => Object.defineProperty({ kind: "confirmed", outcome: "not_posted" }, "error", { value: "timeout", enumerable: false })],
  ["키 열거가 던지는 Proxy", () => new Proxy({ kind: "confirmed", outcome: "not_posted" }, { ownKeys() { throw new Error(MARK); } })],
  ["throw하는 getter", () => ({ kind: "confirmed", get outcome() { throw new Error(MARK); } })],
  ["일반 객체가 아닌 프로토타입의 확정", () => Object.assign(Object.create({ error: "timeout" }), { kind: "confirmed", outcome: "not_posted" })],
  ["프로토타입에서만 물려받은 대기", () => Object.create({ kind: "pending" })],
];

for (const [name, make] of TRICKY_PUBLICATION) {
  test(`게시 ${name}: 모름이고 장부에 unknown으로 남는다`, async () => {
    const { queries } = fakeFrontDoor(() => ({ kind: "confirmed_absent" }), make);
    const error = await unknownError(recoveryPorts(queries).publications.lookup("job-t"));
    expect(error.reason, name).toBe("invalid_reply");
    expectNoOutside(error);

    const ledger = ready(open(tempPath()));
    must(ledger.recordPublication({ frontJobId: "job-t", candidateDigest: digest("job-t"), runId: null, now: NOW }));
    const restorer = new Restorer(ledger, restorePorts(queries), clock, OPTS);
    await restorer.step1();
    await restorer.step2();
    await restorer.step3();
    expect(await restorer.step4(), name).toEqual({ confirmed: [], pending: [], unknown: ["job-t"] });
    expect(ledger.publications()).toMatchObject({ value: [{ frontJobId: "job-t", state: "unknown", outcome: null }] });
  });
}

test("주입 함수의 오류는 고정 사유 query_failed가 되고 원래 오류를 싣지 않는다", async () => {
  const throwing = () => {
    throw new Error(MARK);
  };
  const rejecting = () => Promise.reject(new Error(MARK));
  for (const call of [throwing, rejecting]) {
    const ports = recoveryPorts({ readStopLedger: call, lookupPublication: call });
    for (const promise of [ports.stopAuthority.latestStop(), ports.publications.lookup("job-1")]) {
      const error = await unknownError(promise);
      expect(error.reason).toBe("query_failed");
      expectNoOutside(error);
    }
    const ledger = open(tempPath());
    const restorer = new Restorer(ledger, { ...ports, peers, occupancy }, clock, OPTS);
    const step1 = await restorer.step1().catch((e: unknown) => e);
    expect(step1).toBeInstanceOf(RestoreStepError);
    expect((step1 as Error).message).not.toContain(MARK);
    expect(ledger.readStop()).toEqual({ known: true, value: null });
  }
});

// ---- 소스의 경계 ----

test("정적: latestStop이 null을 내는 길은 확인된 부재 하나이고, 어댑터는 시계·타이머·연결을 쓰지 않는다", async () => {
  const source = await readText("src/supervisor/frontdoor/recovery.ts");
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  // null을 값으로 내는 줄(return, 화살표의 결과, 삼항·?? 의 값)을 모두 센다. === null 같은 비교만 뺀다.
  const nulls = code.split("\n").filter((line) => /\bnull\b/.test(line.replaceAll(/[!=]==? null\b/g, "")));
  expect(nulls).toHaveLength(1);
  expect(nulls[0]).toMatch(/^\s*if \(kind === "confirmed_absent" && hasExactly\(reply, \["kind"\]\)\) return null;$/);
  expect(/\b(setTimeout|setInterval|Date|performance|Math\.random|process|Bun|fetch|WebSocket|crypto)\b/.test(code)).toBe(false);
  const imports = [...code.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  expect(imports).toEqual(["../../ledger/index.ts"]);
});
