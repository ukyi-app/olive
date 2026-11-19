import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { rawPublicKey, sealEnvelope, verifyEnvelope } from "../../../src/contract/v1/index.ts";
import * as registry from "../../../src/supervisor/transport/registry.ts";
import {
  type ApplyOutcome,
  DEFAULT_MAX_BYTES,
  type ExecutorPeer,
  REGISTRY_REJECT_REASONS,
  type RegistryRejectReason,
  type RegistrySettings,
  RegistryState,
} from "../../../src/supervisor/transport/registry.ts";

// 대상 표·등록행·키는 운영 자료의 사본이 아니라 이 시험이 지어 넣는 자료다. 키는 실행마다 새로 만든다.
const NOW = 1_800_000_000_000;

interface Keys {
  readonly privateKey: KeyObject;
  readonly raw: string;
}

function newKeys(): Keys {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, raw: rawPublicKey(publicKey) };
}

const settings: RegistrySettings = {
  environment: "home",
  targets: [
    { target: "reader", namespace: "olive-reader", roles: ["isolated_reader"] },
    { target: "diagnosis", namespace: "olive-diagnosis", roles: ["diagnosis"] },
  ],
};

const READER: ExecutorPeer = { kind: "executor", namespace: "olive-reader", target: "reader", uri: "spiffe://olive.internal/ns/olive-reader/executor/reader" };
const DIAGNOSIS: ExecutorPeer = {
  kind: "executor",
  namespace: "olive-diagnosis",
  target: "diagnosis",
  uri: "spiffe://olive.internal/ns/olive-diagnosis/executor/diagnosis",
};

const R1 = "executor/isolated_reader/r1/s1";

interface RowInput {
  target?: unknown;
  role?: unknown;
  instance?: unknown;
  storage?: unknown;
  public_key?: unknown;
  active?: unknown;
}

function row(keys: Keys, over: RowInput = {}): Record<string, unknown> {
  return { target: "reader", role: "isolated_reader", instance: "r1", storage: "s1", public_key: keys.raw, active: true, ...over };
}

function doc(revision: number, executors: unknown[], over: Record<string, unknown> = {}): string {
  return JSON.stringify({ environment: "home", revision, executors, ...over });
}

function content(text: string | Uint8Array) {
  return { kind: "content", content: text } as const;
}

function applied(state: RegistryState, text: string): RegistryState {
  const outcome = state.apply(content(text));
  expect(outcome.kind).toBe("applied");
  return outcome.state;
}

function rejected(outcome: ApplyOutcome): { reason: RegistryRejectReason; row: number | null } {
  expect(outcome.kind).toBe("rejected");
  if (outcome.kind !== "rejected") throw new Error("unreachable");
  expect(outcome.to).toBeNull();
  expect(outcome.state.readout().revision).toBeNull();
  return { reason: outcome.reason, row: outcome.row };
}

// 실행기가 연결의 첫 단계에 보내는 맞춤 요청을 그 키로 서명해, 감독의 실제 verifyEnvelope에 이 판단의 답을 넣는다.
let counter = 0;
async function verifyFrom(state: RegistryState, peer: ExecutorPeer, sender: string, signer: KeyObject) {
  counter += 1;
  const hex = counter.toString(16).padStart(32, "0");
  const envelope = sealEnvelope(
    {
      sender,
      recipient: "supervisor",
      action: "stop_sync_request",
      request_id: `00000000-0000-4000-8000-${hex.slice(20)}`,
      stop_generation: 0,
      run_generation: 0,
      issued_at: NOW,
      nonce: hex,
      body: { challenge: hex },
    },
    signer,
  );
  const result = await verifyEnvelope(JSON.parse(JSON.stringify(envelope)), {
    now: NOW,
    expectedRecipient: "supervisor",
    publicKeyFor: state.publicKeyFor(peer),
    stopGeneration: 0,
    stopSyncChallenge: null,
    runGeneration: () => undefined,
    nonces: { consume: () => true },
  });
  return result.ok ? "ok" : result.reason;
}

describe("인수 시험", () => {
  test("미등록 unknown_sender·다른 서명 bad_signature", async () => {
    const a = newKeys();
    const b = newKeys();
    const start = RegistryState.start(settings);
    // 아무 판도 적용하지 않은 감독은 누구의 키도 모른다.
    expect(await verifyFrom(start, READER, R1, a.privateKey)).toBe("unknown_sender");

    const state = applied(start, doc(1, [row(a), row(newKeys(), { instance: "r2", storage: "s2", active: false })]));
    expect(await verifyFrom(state, READER, R1, a.privateKey)).toBe("ok");
    // 등록되지 않은 올바른 이름
    expect(await verifyFrom(state, READER, "executor/isolated_reader/r3/s3", b.privateKey)).toBe("unknown_sender");
    // 등록된 이름에 다른 키의 서명
    expect(await verifyFrom(state, READER, R1, b.privateKey)).toBe("bad_signature");
    // 저장소를 잃어 저장소 ID가 바뀐 같은 인스턴스는 다시 등록하기 전까지 모르는 주체다.
    expect(await verifyFrom(state, READER, "executor/isolated_reader/r1/s9", a.privateKey)).toBe("unknown_sender");
    // 비활성 행의 키는 믿지 않는다.
    expect(await verifyFrom(state, READER, "executor/isolated_reader/r2/s2", a.privateKey)).toBe("unknown_sender");
  });

  test("reader 키의 역할 바꿈 거절", async () => {
    const a = newKeys();
    const d = newKeys();
    const state = applied(
      RegistryState.start(settings),
      doc(1, [row(a), row(d, { target: "diagnosis", role: "diagnosis", instance: "d1", storage: "t1" })]),
    );
    // 같은 reader 키로 다른 역할·다른 인스턴스·다른 저장소를 주장한다.
    for (const sender of ["executor/pr_review/r1/s1", "executor/diagnosis/r1/s1", "executor/isolated_reader/r2/s1", "executor/session/r1/s1"]) {
      expect(await verifyFrom(state, READER, sender, a.privateKey), sender).toBe("unknown_sender");
      expect(state.keyFor(READER, sender), sender).toBeUndefined();
    }
    // 다른 대상의 연결이 reader의 주체를 주장하거나, reader 연결이 진단 실행기의 주체를 주장한다.
    expect(await verifyFrom(state, DIAGNOSIS, R1, a.privateKey)).toBe("unknown_sender");
    expect(await verifyFrom(state, READER, "executor/diagnosis/d1/t1", d.privateKey)).toBe("unknown_sender");
    expect(await verifyFrom(state, DIAGNOSIS, "executor/diagnosis/d1/t1", d.privateKey)).toBe("ok");
    // 대상 표와 네임스페이스가 다른 인증서의 연결
    expect(state.keyFor({ ...READER, namespace: "olive-diagnosis" }, R1)).toBeUndefined();
    expect(state.keyFor({ ...READER, target: "writer" }, R1)).toBeUndefined();
    // 대상 표가 reader에 허용하지 않은 역할의 행은 문서 전체를 거절한다(D-64).
    const review = state.apply(content(doc(2, [row(a), row(newKeys(), { role: "pr_review", instance: "r2", storage: "s2" })])));
    expect(rejected(review)).toEqual({ reason: "role_not_allowed", row: 1 });
    expect(review.state.keyFor(READER, R1)).toBeUndefined();
  });

  test("중복·과거판 거절", () => {
    const a = newKeys();
    const b = newKeys();
    const start = RegistryState.start(settings);
    // 같은 주체 두 행, 같은 인스턴스의 활성 두 행, 같은 키의 두 행(같은 역할·대상 / 다른 역할·대상)
    expect(rejected(start.apply(content(doc(1, [row(a), row(b, { active: false })]))))).toEqual({ reason: "duplicate_identity", row: 1 });
    expect(rejected(start.apply(content(doc(1, [row(a), row(b, { storage: "s2" })]))))).toEqual({ reason: "duplicate_identity", row: 1 });
    expect(rejected(start.apply(content(doc(1, [row(a), row(a, { instance: "r2", storage: "s2" })]))))).toEqual({ reason: "duplicate_key", row: 1 });
    const twoRoles = doc(1, [row(a), row(a, { target: "diagnosis", role: "diagnosis", instance: "d1", storage: "t1" })]);
    expect(rejected(start.apply(content(twoRoles)))).toEqual({ reason: "key_in_two_roles", row: 1 });
    // 저장소를 잃은 인스턴스의 다시 등록: 옛 행은 비활성, 새 저장소·새 키의 행은 활성이면 받는다.
    const reRegistered = applied(start, doc(1, [row(a, { active: false }), row(b, { storage: "s2" })]));
    expect(reRegistered.keyFor(READER, R1)).toBeUndefined();
    expect(reRegistered.keyFor(READER, "executor/isolated_reader/r1/s2")).toBeDefined();

    const v2 = applied(start, doc(2, [row(a)]));
    // 같은 판·같은 내용(행 순서·공백만 다름)은 변화 없음이고 계속 믿는다.
    const same = v2.apply(content(`  ${doc(2, [row(a)])}\n`));
    expect(same.kind).toBe("unchanged");
    expect(same.state.readout()).toMatchObject({ revision: 2, lastAttempt: { outcome: "unchanged", reason: null } });
    expect(same.state.keyFor(READER, R1)).toBeDefined();
    // 낮은 판은 적용하지 않고 닫는다. 지금 판도 더는 믿지 않는다.
    const older = v2.apply(content(doc(1, [row(a), row(b, { instance: "r2", storage: "s2" })])));
    expect(rejected(older)).toEqual({ reason: "not_newer", row: null });
    expect(older.from).toBe(2);
    expect(older.state.keyFor(READER, R1)).toBeUndefined();
    // 같은 판에 다른 내용
    expect(rejected(v2.apply(content(doc(2, [row(b)]))))).toEqual({ reason: "revision_conflict", row: null });
    // 닫힌 뒤에는 마지막 적용판(2)과 같은 사본이 돌아와도 열지 않는다. 더 큰 판만 연다.
    expect(rejected(older.state.apply(content(doc(2, [row(a)]))))).toEqual({ reason: "not_newer", row: null });
    const reopened = older.state.apply(content(doc(3, [row(a)])));
    expect(reopened).toMatchObject({ kind: "applied", from: null, to: 3 });
    expect(reopened.state.keyFor(READER, R1)).toBeDefined();
    // 다른 환경의 문서
    expect(rejected(start.apply(content(doc(1, [row(a)], { environment: "lab" }))))).toEqual({ reason: "wrong_environment", row: null });
  });

  test("빈 승인판으로 기존 연결 무효", async () => {
    const a = newKeys();
    const b = newKeys();
    const v1 = applied(RegistryState.start(settings), doc(1, [row(a), row(b, { instance: "r2", storage: "s2" })]));
    const grantA = v1.keyFor(READER, R1)!;
    const grantB = v1.keyFor(READER, "executor/isolated_reader/r2/s2")!;
    expect(grantA.keyId).not.toBe(grantB.keyId);

    // b만 폐기한 판: 남은 a의 연결은 유효하고 b의 연결은 무효다.
    const v2 = v1.apply(content(doc(2, [row(a)])));
    expect(v2).toMatchObject({ kind: "applied", from: 1, to: 2 });
    expect(v2.state.stillTrusts(READER, R1, grantA.keyId)).toBe(true);
    expect(v2.state.stillTrusts(READER, "executor/isolated_reader/r2/s2", grantB.keyId)).toBe(false);

    // 전부 폐기한 빈 판은 정상으로 적용되고 그 뒤로는 누구도 믿지 않는다.
    const empty = v2.state.apply(content(doc(3, [])));
    expect(empty).toMatchObject({ kind: "applied", from: 2, to: 3 });
    expect(empty.state.readout()).toEqual({
      revision: 3,
      rows: 0,
      activeRows: 0,
      lastAppliedRevision: 3,
      lastAttempt: { outcome: "applied", reason: null, row: null },
    });
    expect(empty.state.stillTrusts(READER, R1, grantA.keyId)).toBe(false);
    expect(empty.state.stillTrusts(READER, R1, undefined as never)).toBe(false);
    expect(v2.state.stillTrusts(READER, R1, undefined as never)).toBe(false);
    expect(empty.state.keyFor(READER, R1)).toBeUndefined();
    expect(await verifyFrom(empty.state, READER, R1, a.privateKey)).toBe("unknown_sender");
    // 옛 값은 바뀌지 않는다. 부르는 쪽이 새 값으로 갈아 쥐어야 끊긴다.
    expect(v2.state.stillTrusts(READER, R1, grantA.keyId)).toBe(true);
    // 빈 판도 판이다. 같은 빈 판은 변화 없음, 폐기 전 사본(낮은 판)은 거절이다.
    expect(empty.state.apply(content(doc(3, []))).kind).toBe("unchanged");
    expect(rejected(empty.state.apply(content(doc(2, [row(a)]))))).toEqual({ reason: "not_newer", row: null });
  });
});

describe("읽지 못함과 적용 실패", () => {
  test("읽지 못한 문서는 성공으로 보이지 않고, 지금 판도 닫는다", () => {
    const a = newKeys();
    const v1 = applied(RegistryState.start(settings), doc(1, [row(a)]));
    const lost = v1.apply({ kind: "unreadable" });
    expect(rejected(lost)).toEqual({ reason: "unreadable", row: null });
    expect(lost.from).toBe(1);
    expect(lost.state.keyFor(READER, R1)).toBeUndefined();
    expect(lost.state.readout()).toEqual({
      revision: null,
      rows: 0,
      activeRows: 0,
      lastAppliedRevision: 1,
      lastAttempt: { outcome: "rejected", reason: "unreadable", row: null },
    });
    // 처음부터 읽지 못한 경우도 같다.
    const never = RegistryState.start(settings).apply({ kind: "unreadable" });
    expect(rejected(never)).toEqual({ reason: "unreadable", row: null });
    expect(never.from).toBeNull();
    expect(never.state.readout().lastAppliedRevision).toBeNull();
    // 타입 밖의 입력도 읽지 못함이다.
    expect(rejected(v1.apply(undefined as never)).reason).toBe("unreadable");
    expect(rejected(v1.apply({ kind: "content", content: 42 } as never)).reason).toBe("unreadable");
  });

  test("한 행이 틀리면 문서 전체를 거절하고 맞는 행도 받지 않는다", () => {
    const a = newKeys();
    const v1 = applied(RegistryState.start(settings), doc(1, [row(a)]));
    const outcome = v1.apply(content(doc(2, [row(a), row(newKeys(), { instance: "r2", storage: "s2", extra: 1 } as RowInput)])));
    expect(rejected(outcome)).toEqual({ reason: "unknown_field", row: 1 });
    expect(outcome.state.keyFor(READER, R1)).toBeUndefined();
    expect(outcome.state.readout()).toMatchObject({ revision: null, rows: 0, lastAppliedRevision: 1 });
  });
});

describe("엄격한 해석", () => {
  const a = newKeys();
  const good = row(a);
  const encoder = new TextEncoder();
  // 정규 표기가 아닌 43자: 마지막 글자의 남는 비트를 켠다.
  const lastIndex = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(a.raw.at(-1)!);
  const nonCanonical = a.raw.slice(0, -1) + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[(lastIndex & ~3) | 1];
  const cases: [string, string | Uint8Array, RegistryRejectReason, number | null][] = [
    ["빈 문서", "", "not_json", null],
    ["JSON 문법 오류", '{"environment":"home",', "not_json", null],
    ["BOM", `﻿${doc(1, [good])}`, "not_json", null],
    ["깨진 UTF-8", new Uint8Array([...encoder.encode('{"environment":"'), 0xff, ...encoder.encode('"}')]), "not_utf8", null],
    ["짝 없는 서로게이트", `{"environment":"\uD800"}`, "not_utf8", null],
    ["최상위 칸 중복", `{"environment":"home","environment":"home","revision":1,"executors":[]}`, "duplicate_member", null],
    ["행 칸 중복", doc(1, [good]).replace('"active":true', '"active":true,"active":false'), "duplicate_member", null],
    ["최상위 배열", "[]", "bad_field", null],
    ["모르는 최상위 칸", doc(1, [good], { comment: "x" }), "unknown_field", null],
    ["__proto__ 칸", doc(1, [good]).replace('{"environment"', '{"__proto__":{},"environment"'), "unknown_field", null],
    ["칸 누락", JSON.stringify({ environment: "home", revision: 1 }), "missing_field", null],
    ["행 칸 누락", doc(1, [{ ...good, active: undefined }]), "missing_field", 0],
    ["판 번호 0", doc(0, [good]), "bad_field", null],
    ["판 번호 소수", doc(1, [good]).replace('"revision":1', '"revision":1.5'), "bad_field", null],
    ["판 번호 문자열", doc(1, [good]).replace('"revision":1', '"revision":"1"'), "bad_field", null],
    ["판 번호 안전 정수 밖", doc(1, [good]).replace('"revision":1', '"revision":9007199254740993'), "bad_field", null],
    ["행 목록이 객체", doc(1, [good]).replace(/"executors":\[.*\]/, '"executors":{}'), "bad_field", null],
    ["행이 배열", doc(1, [[]]), "bad_field", 0],
    ["활성이 문자열", doc(1, [row(a, { active: "true" })]), "bad_field", 0],
    ["인스턴스에 /", doc(1, [row(a, { instance: "r1/x" })]), "bad_field", 0],
    ["인스턴스 대문자", doc(1, [row(a, { instance: "R1" })]), "bad_field", 0],
    ["저장소 빈 값", doc(1, [row(a, { storage: "" })]), "bad_field", 0],
    ["키 42자", doc(1, [row(a, { public_key: a.raw.slice(1) })]), "bad_public_key", 0],
    ["키 비정규 표기", doc(1, [row(a, { public_key: nonCanonical })]), "bad_public_key", 0],
    ["키 표준 base64", doc(1, [row(a, { public_key: Buffer.from(a.raw, "base64url").toString("base64") })]), "bad_public_key", 0],
    ["모르는 역할", doc(1, [row(a, { role: "reader" })]), "unknown_role", 0],
    ["세션 역할", doc(1, [row(a, { role: "session" })]), "unknown_role", 0],
    ["모르는 대상", doc(1, [row(a, { target: "writer" })]), "unknown_target", 0],
    ["깊이 초과", doc(1, [good], { environment: JSON.parse("[".repeat(20) + "]".repeat(20)) }), "not_json", null],
  ];
  for (const [name, text, reason, at] of cases) {
    test(name, () => {
      expect(name !== "키 비정규 표기" || nonCanonical !== a.raw).toBe(true);
      expect(rejected(RegistryState.start(settings).apply(content(text)))).toEqual({ reason, row: at });
    });
  }

  test("크기·행 수 상한과 틀린 설정은 거절한다", () => {
    const text = doc(1, [good, row(newKeys(), { instance: "r2", storage: "s2", active: false })]);
    const bytes = encoder.encode(text).length;
    expect(RegistryState.start({ ...settings, maxBytes: bytes }).apply(content(text)).kind).toBe("applied");
    expect(rejected(RegistryState.start({ ...settings, maxBytes: bytes - 1 }).apply(content(text)))).toEqual({ reason: "too_large", row: null });
    expect(rejected(RegistryState.start(settings).apply(content(" ".repeat(DEFAULT_MAX_BYTES) + "{}")))).toEqual({ reason: "too_large", row: null });
    expect(RegistryState.start({ ...settings, maxRows: 2 }).apply(content(text)).kind).toBe("applied");
    expect(rejected(RegistryState.start({ ...settings, maxRows: 1 }).apply(content(text)))).toEqual({ reason: "too_many_rows", row: null });
    const bad: RegistrySettings[] = [
      { ...settings, maxBytes: DEFAULT_MAX_BYTES + 1 },
      { ...settings, maxBytes: 0 },
      { ...settings, maxRows: -1 },
      { ...settings, environment: "Home" },
      { ...settings, targets: [...settings.targets, { target: "reader", namespace: "olive-reader", roles: [] }] },
      { ...settings, targets: [{ target: "reader", namespace: "olive-reader", roles: ["reader" as never] }] },
      undefined as never,
    ];
    for (const value of bad) expect(rejected(RegistryState.start(value).apply(content(doc(1, [good])))).reason).toBe("bad_settings");
  });
});

describe("판 번호의 원문", () => {
  const a = newKeys();
  const withRevision = (token: string) => doc(1, [row(a)]).replace('"revision":1', `"revision":${token}`);

  test("7판 뒤 원문 7.9999999999999999는 거절이고 마지막 성공판은 7, 뒤이은 실제 8판은 적용된다", async () => {
    const b = newKeys();
    const v7 = applied(RegistryState.start(settings), doc(7, [row(a)]));
    const rounded = v7.apply(content(doc(7, [row(a)]).replace('"revision":7', '"revision":7.9999999999999999')));
    expect(rejected(rounded)).toEqual({ reason: "bad_field", row: null });
    expect(rounded.state.readout()).toEqual({
      revision: null,
      rows: 0,
      activeRows: 0,
      lastAppliedRevision: 7,
      lastAttempt: { outcome: "rejected", reason: "bad_field", row: null },
    });
    expect(rounded.state.keyFor(READER, R1)).toBeUndefined();
    const real = rounded.state.apply(content(doc(8, [row(b)])));
    expect(real).toMatchObject({ kind: "applied", from: null, to: 8 });
    expect(await verifyFrom(real.state, READER, R1, b.privateKey)).toBe("ok");
  });

  for (const token of ["8.0", "8e0", "8E0", "80e-1", "0.8e1", "-0", "8.5", "7.9999999999999999", "9007199254740992"]) {
    test(`판 번호 원문 ${token}`, () => {
      expect(rejected(RegistryState.start(settings).apply(content(withRevision(token))))).toEqual({ reason: "bad_field", row: null });
    });
  }

  test("앞의 0은 JSON 문법 오류다", () => {
    expect(rejected(RegistryState.start(settings).apply(content(withRevision("08"))))).toEqual({ reason: "not_json", row: null });
  });

  test("정수 원문은 공백·칸 순서·이름의 이스케이프와 무관하게 받는다", () => {
    const good = JSON.stringify(row(a));
    for (const text of [
      withRevision("9007199254740991"),
      `{ "revision" : 8 , "environment":"home","executors":[${good}]}`,
      `{"executors":[${good}],"environment":"home","rev\\u0069sion":8}`,
    ]) {
      const outcome = RegistryState.start(settings).apply(content(text));
      expect(outcome.kind, text).toBe("applied");
      expect(outcome.state.keyFor(READER, R1), text).toBeDefined();
    }
  });

  // 글 전체에서 "revision"을 찾으면 앞쪽의 안쪽 칸이나 문자열 속 글자를 판 번호로 읽는다. 최상위 칸만 봐야 문서 단위의 bad_field가 난다.
  test("원문 검색이 속는 입력", () => {
    const good = JSON.stringify(row(a));
    // 원문에는 "r1\"revision\":1"로 실린다.
    const quoted = JSON.stringify(row(a, { instance: 'r1"revision":1' }));
    for (const text of [
      `{"executors":[{"revision":1}],"environment":"home","revision":1.0}`,
      `{"executors":[${quoted}],"environment":"home","revision":1.0}`,
      `{"environment":"home","executors":[${good}],"rev\\u0069sion":1.0}`,
    ]) {
      expect(rejected(RegistryState.start(settings).apply(content(text))), text).toEqual({ reason: "bad_field", row: null });
    }
  });
});

describe("Ed25519 공개 키의 점", () => {
  const a = newKeys();
  const keyOf = (hex: string) => Buffer.from(hex, "hex").toString("base64url");
  // 작은 위수(1·2·4·8)의 여덟 점의 정규 인코딩. 구현의 목록과 따로 적는다.
  const smallOrder = [
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000080",
    "0100000000000000000000000000000000000000000000000000000000000000",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  ];
  const unusable: [string, string][] = [
    ["ff 32바이트", "ff".repeat(32)],
    ["00 32바이트", "00".repeat(32)],
    ["y = p", `ed${"ff".repeat(30)}7f`],
    ["y = p + 1", `ee${"ff".repeat(30)}7f`],
    ["y = 2^255 - 1", `${"ff".repeat(31)}7f`],
    ["곡선 위에 없는 y = 2", `02${"00".repeat(31)}`],
    ["x = 0에 부호 비트 1", `01${"00".repeat(30)}80`],
    ...smallOrder.map((hex, i): [string, string] => [`작은 위수 점 ${i}`, hex]),
    // 기준점 B의 1·7·5배에 위수 8·4·2의 점을 더한 혼합 위수 점. 곡선 위에 있고 작은 위수가 아니지만 주 부분군 밖이다.
    ["혼합 위수 점(B + 위수 8)", "da99e28ba529cdde35a25fba9059e78ecaee239f99755b9b1aa4f65df00803e2"],
    ["혼합 위수 점(7B + 위수 4)", "d7fcf1f00e29dd947529006e74d779973e3c1a1bad96b7807ab8644b5604ee50"],
    ["혼합 위수 점(5B + 위수 2)", "003789297ce02defa2f4bc7635d1d7ce99b96d76eb91d31f905101674ddab720"],
  ];

  test("시험에서 새로 만든 정상 키 64개는 한 판에서 모두 적용되고 각자 서명이 통한다", async () => {
    const keys = Array.from({ length: 64 }, () => newKeys());
    const state = applied(
      RegistryState.start(settings),
      doc(
        1,
        keys.map((k, i) => row(k, { instance: `r${i}`, storage: `s${i}` })),
      ),
    );
    for (const [i, k] of keys.entries()) expect(await verifyFrom(state, READER, `executor/isolated_reader/r${i}/s${i}`, k.privateKey)).toBe("ok");
  });

  for (const [name, hex] of unusable) {
    test(`정상 행과 함께 든 ${name}은 문서 전체를 거절한다`, () => {
      const v7 = applied(RegistryState.start(settings), doc(7, [row(a)]));
      const outcome = v7.apply(content(doc(8, [row(a), row(newKeys(), { instance: "r2", storage: "s2", public_key: keyOf(hex) })])));
      expect(rejected(outcome)).toEqual({ reason: "bad_public_key", row: 1 });
      expect(outcome.state.keyFor(READER, R1)).toBeUndefined();
      expect(outcome.state.keyFor(READER, "executor/isolated_reader/r2/s2")).toBeUndefined();
      expect(outcome.state.readout()).toMatchObject({ revision: null, lastAppliedRevision: 7 });
    });
  }
});

describe("값과 공개 면", () => {
  test("명단을 채우는 길은 apply 하나다(hello·인증서 지문으로 채우는 함수가 없다)", () => {
    expect(Object.keys(registry).sort()).toEqual(["DEFAULT_MAX_BYTES", "REGISTRY_FIELDS", "REGISTRY_REJECT_REASONS", "ROW_FIELDS", "RegistryState"]);
    expect(Object.getOwnPropertyNames(RegistryState.prototype).sort()).toEqual(["apply", "constructor", "keyFor", "publicKeyFor", "readout", "stillTrusts"]);
    expect(Object.getOwnPropertyNames(RegistryState).filter((name) => typeof (RegistryState as unknown as Record<string, unknown>)[name] === "function")).toEqual(["start"]);
    expect(REGISTRY_REJECT_REASONS).toContain("unreadable");
  });

  test("상태·결과·읽기를 통째로 내보내도 키·저장소·인스턴스 값이 실리지 않는다", () => {
    const a = newKeys();
    const start = RegistryState.start(settings);
    const outcomes = [
      start.apply(content(doc(1, [row(a, { storage: "secret-storage", instance: "secret-inst" })]))),
      start.apply(content(doc(1, [row(a, { storage: "secret-storage", instance: "secret-inst" }), row(a, { storage: "secret-storage", instance: "secret-inst" })]))),
    ];
    for (const outcome of outcomes) {
      const dumped = JSON.stringify(outcome) + JSON.stringify(outcome.state.readout()) + String(outcome.state) + Bun.inspect(outcome);
      for (const value of [a.raw, "secret-storage", "secret-inst"]) expect(dumped).not.toContain(value);
    }
  });

  test("읽기 결과와 주입한 표를 바꿔도 상태는 바뀌지 않는다", () => {
    const a = newKeys();
    const targets = [{ target: "reader", namespace: "olive-reader", roles: ["isolated_reader"] as ("isolated_reader" | "pr_review")[] }];
    const state = applied(RegistryState.start({ environment: "home", targets }), doc(1, [row(a)]));
    targets[0]!.roles.push("pr_review");
    targets[0]!.namespace = "olive-diagnosis";
    expect(state.keyFor(READER, R1)).toBeDefined();
    expect(rejected(state.apply(content(doc(2, [row(a, { role: "pr_review" })])))).reason).toBe("role_not_allowed");
    const readout = state.readout();
    expect(() => {
      (readout.lastAttempt as { outcome: string }).outcome = "rejected";
    }).toThrow();
    expect(state.readout().lastAttempt?.outcome).toBe("applied");
  });
});
