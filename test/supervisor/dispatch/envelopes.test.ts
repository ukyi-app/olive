import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ACTION_SPECS,
  ACTIONS,
  type Envelope,
  executorName,
  limits,
  NONCE,
  sealEnvelope,
  verifyEnvelope,
  type VerifyContext,
} from "../../../src/contract/v1/index.ts";
import type { Run } from "../../../src/ledger/index.ts";
import {
  ackDraft,
  DRAFT_ACTIONS,
  type Draft,
  type Drafted,
  finalizeDraft,
  newUuid,
  renewDraft,
  type SealPorts,
  sealDraft,
  startDraft,
  type StartDraftInput,
  statusQueryDraft,
  stopDraft,
} from "../../../src/supervisor/dispatch/envelopes.ts";
import type { Random, Signer } from "../../../src/supervisor/dispatch/ports.ts";

// 키·실행기 이름·실행 줄은 이 시험이 지어 넣는 자료다. 키는 실행마다 새로 만든다.
const NOW = 1_800_000_000_000;
const STOP_GEN = 3;
const WORKER = executorName("diagnosis", "inst-1", "store-1");
const SESSION = executorName("session", "inst-1", "store-1");
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const REQ_ID = "22222222-2222-4222-8222-222222222222";
const RECEIPT_ID = "33333333-3333-4333-8333-333333333333";
const DIGEST = "a".repeat(64);

const keys = generateKeyPairSync("ed25519");
const signer: Signer = { seal: (input) => sealEnvelope(input, keys.privateKey) };

// 가짜 난수: 부를 때마다 다음 바이트를 낸다. 부른 길이를 적는다.
function fakeRandom(seed = 1): Random & { calls: number[] } {
  let next = seed;
  const calls: number[] = [];
  return {
    calls,
    bytes(length: number) {
      calls.push(length);
      return Uint8Array.from({ length }, () => next++ & 0xff);
    },
  };
}

function ports(seed = 1, s: Signer = signer): SealPorts & { random: ReturnType<typeof fakeRandom> } {
  return { random: fakeRandom(seed), signer: s };
}

const run: StartDraftInput["run"] = {
  runId: RUN_ID,
  runGeneration: 1,
  kind: "worker",
  role: "diagnosis",
  profileRevision: "p1",
  policyRevision: "q1",
  snapshotDigest: DIGEST,
  inputDigest: "b".repeat(64),
  deadlineAt: NOW + 15 * 60_000,
  budgetLeft: 200_000,
  executorId: WORKER,
  credential: { account: "acct-1", method: "subscription", revision: "r1", digest: "c".repeat(64) },
};
const facts = { runId: RUN_ID, runGeneration: 1, executorId: WORKER } satisfies Pick<Run, "runId" | "runGeneration" | "executorId">;

// 받는 실행기의 검증 맥락. 시작 지시는 아직 모르는 실행이고, 나머지는 세대 1의 아는 실행이다.
function ctx(recipient: string, now: number, knows: boolean): VerifyContext {
  const seen = new Set<string>();
  return {
    now,
    expectedRecipient: recipient,
    publicKeyFor: (sender) => (sender === "supervisor" ? keys.publicKey : undefined),
    stopGeneration: STOP_GEN,
    runGeneration: (id) => (knows && id === RUN_ID ? 1 : undefined),
    nonces: { consume: (sender, nonce) => (seen.has(sender + nonce) ? false : (seen.add(sender + nonce), true)) },
  };
}

function ok<A extends Draft["action"]>(drafted: Drafted<A>): Draft<A> {
  if (!drafted.ok) throw new Error(`초안 거절: ${drafted.reason}`);
  return drafted.draft;
}

function sealed(draft: Draft, now: number, p: SealPorts = ports()): Envelope {
  const result = sealDraft(draft, now, p);
  if (!result.ok) throw new Error(`봉하기 거절: ${result.reason}`);
  return result.envelope;
}

const startIssuedAt = NOW - 2_000;
const drafts = (): Record<(typeof DRAFT_ACTIONS)[number], { draft: Draft; recipient: string; knows: boolean }> => ({
  task_start: { draft: ok(startDraft({ run, requestId: REQ_ID, stopGeneration: STOP_GEN, issuedAt: startIssuedAt })), recipient: WORKER, knows: false },
  run_renew: {
    draft: ok(renewDraft({ run: facts, requestId: REQ_ID, stopGeneration: STOP_GEN, now: NOW - 1_000, leaseUntil: NOW - 1_000 + limits.RUN_LEASE_MAX_MS })),
    recipient: WORKER,
    knows: true,
  },
  task_cancel: { draft: ok(stopDraft({ action: "task_cancel", run: facts, requestId: REQ_ID, stopGeneration: STOP_GEN, reason: "requested" })), recipient: WORKER, knows: true },
  session_stop: {
    draft: ok(stopDraft({ action: "session_stop", run: { ...facts, executorId: SESSION }, requestId: REQ_ID, stopGeneration: STOP_GEN, reason: "daily_rotation" })),
    recipient: SESSION,
    knows: true,
  },
  result_finalize: {
    draft: ok(finalizeDraft({ run: facts, requestId: REQ_ID, stopGeneration: STOP_GEN, outcome: "succeeded", resultDigest: DIGEST, storedAt: NOW - 500 })),
    recipient: WORKER,
    knows: true,
  },
  status_query: { draft: ok(statusQueryDraft({ recipient: WORKER, stopGeneration: STOP_GEN, runIds: [RUN_ID] }, fakeRandom(200))), recipient: WORKER, knows: true },
  ack: { draft: ok(ackDraft({ recipient: WORKER, stopGeneration: STOP_GEN, ids: [RECEIPT_ID] }, fakeRandom(210))), recipient: WORKER, knows: true },
});

describe("보장 1: 봉투의 시각은 장부의 기록과 같다", () => {
  test("시작 봉투의 issued_at은 장부의 발행 시각이고 봉하는 때의 now가 아니다", () => {
    const envelope = sealed(drafts().task_start.draft, NOW);
    expect(envelope.header.issued_at).toBe(startIssuedAt);
    expect(envelope.header.expires_at).toBe(startIssuedAt + limits.MESSAGE_TTL_MS);
  });

  test("갱신 봉투는 기록에 넘긴 now를 issued_at에, 돌려받은 leaseUntil을 lease_until에 싣는다", () => {
    const recordedNow = NOW - 1_000;
    const leaseUntil = recordedNow + limits.RUN_LEASE_MAX_MS;
    const draft = ok(renewDraft({ run: facts, requestId: REQ_ID, stopGeneration: STOP_GEN, now: recordedNow, leaseUntil }));
    const envelope = sealed(draft, NOW);
    expect(envelope.header.issued_at).toBe(recordedNow);
    expect(envelope.body).toEqual({ run_id: RUN_ID, lease_until: leaseUntil });
  });

  test("서명 포트가 다른 시각을 실으면 내보내지 않는다(signer_mismatch)", () => {
    const shifty: Signer = { seal: (input) => sealEnvelope({ ...input, issued_at: input.issued_at + 1 }, keys.privateKey) };
    expect(sealDraft(drafts().task_start.draft, NOW, ports(1, shifty))).toEqual({ ok: false, reason: "signer_mismatch" });
  });
});

describe("보장 2: 같은 지시에서 다시 만든 봉투는 같은 요청이다", () => {
  for (const action of DRAFT_ACTIONS) {
    test(`${action}: 요청 ID·본문 digest가 같고 nonce·issued_at·expires_at만 다르다`, () => {
      const first = drafts()[action];
      const again = drafts()[action];
      // 같은 기록(같은 입력과 같은 난수)에서 만든 초안은 같다.
      expect(again.draft).toEqual(first.draft);
      const a = sealed(first.draft, NOW, ports(1));
      const b = sealed(first.draft, NOW + 5_000, ports(100));
      const { nonce: na, issued_at: ia, expires_at: ea, ...restA } = a.header;
      const { nonce: nb, issued_at: ib, expires_at: eb, ...restB } = b.header;
      expect(restB).toEqual(restA);
      expect(b.body).toEqual(a.body);
      expect(nb).not.toBe(na);
      // 시작·갱신은 장부의 발행 시각에 묶여 다시 봉해도 시각이 같다. 나머지는 봉하는 때의 now다.
      const pinned = action === "task_start" || action === "run_renew";
      expect(ib === ia).toBe(pinned);
      expect(eb - ib).toBe(ea - ia);
      // 다시 봉한 봉투도 받는 쪽이 받는다(같은 맥락에서 연달아: nonce가 달라 replayed가 아니다).
      return (async () => {
        const c = ctx(first.recipient, NOW + 5_000, first.knows);
        const vb = await verifyEnvelope(b, c);
        expect(vb.ok).toBe(true);
        if (pinned) {
          // 시각이 같으므로 시한도 같다: 첫 봉투가 지금 받아들여질 수 있으면 같은 시한 안이다.
          expect((await verifyEnvelope(a, c)).ok).toBe(true);
        }
      })();
    });
  }

  test("시작 지시의 재전송은 장부 발행 시각의 시한 안에서만 된다(시한을 앞으로 옮기지 않는다)", () => {
    const draft = drafts().task_start.draft;
    const lastSendable = startIssuedAt + limits.MESSAGE_TTL_MS - limits.DELIVERY_MAX_MS;
    expect(sealDraft(draft, lastSendable, ports()).ok).toBe(true);
    expect(sealDraft(draft, lastSendable + 1, ports())).toEqual({ ok: false, reason: "too_late_to_send" });
  });
});

describe("보장 3: 난수와 시각은 포트와 인자에서만 온다", () => {
  test("nonce는 난수 포트의 16바이트를 소문자 16진으로 쓴 값이다", () => {
    const p = ports(0x10);
    const envelope = sealed(drafts().task_cancel.draft, NOW, p);
    expect(p.random.calls).toEqual([16]);
    expect(envelope.header.nonce).toBe(Array.from({ length: 16 }, (_, i) => (0x10 + i).toString(16).padStart(2, "0")).join(""));
    expect(NONCE.test(envelope.header.nonce)).toBe(true);
  });

  test("조회·ack의 요청 ID는 난수 포트에서 온 UUID이고 다른 난수면 다르다", () => {
    const a = ok(statusQueryDraft({ recipient: WORKER, stopGeneration: STOP_GEN, runIds: [RUN_ID] }, fakeRandom(1)));
    const b = ok(statusQueryDraft({ recipient: WORKER, stopGeneration: STOP_GEN, runIds: [RUN_ID] }, fakeRandom(2)));
    expect(a.requestId).toBe(newUuid(fakeRandom(1)) as string);
    expect(a.requestId).not.toBe(b.requestId);
    expect(a.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("난수 포트가 길이가 다른 값을 주면 만들지 않는다", () => {
    const short: Random = { bytes: (n) => new Uint8Array(n - 1) };
    expect(newUuid(short)).toBeNull();
    expect(sealDraft(drafts().task_cancel.draft, NOW, { random: short, signer })).toEqual({ ok: false, reason: "random_unavailable" });
    expect(ackDraft({ recipient: WORKER, stopGeneration: STOP_GEN, ids: [RECEIPT_ID] }, short)).toEqual({ ok: false, reason: "random_unavailable" });
  });

  test("모듈은 시계·난수를 직접 부르지 않는다", () => {
    for (const file of ["envelopes.ts", "ports.ts"]) {
      // 주석은 실제 구현의 조건(CSPRNG 등)을 이름으로 적으므로 빼고 본다.
      const source = readFileSync(new URL(`../../../src/supervisor/dispatch/${file}`, import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
      expect(source).not.toMatch(/Date\.now|new Date|performance\.now|Math\.random|randomUUID|randomBytes\(|getRandomValues|from "node:crypto"|from "node:fs"|from "node:net"|from "node:tls"/);
      expect(source).not.toMatch(/ledger\/ledger\.ts|contract\/v1\/(?!index\.ts)/);
    }
  });
});

describe("보장 4: 만든 봉투는 계약 v1의 검증기를 통과한다", () => {
  test("감독이 내는 v1 동작 가운데 만들지 않는 것은 session_start와 stop_sync_reply뿐이다", () => {
    const fromSupervisor = ACTIONS.filter((a) => (ACTION_SPECS[a].from as readonly string[]).includes("supervisor"));
    expect<string[]>([...fromSupervisor].sort()).toEqual([...DRAFT_ACTIONS, "session_start", "stop_sync_reply"].sort());
  });

  for (const action of DRAFT_ACTIONS) {
    test(`${action}: 받는 실행기의 verifyEnvelope가 통과시킨다`, async () => {
      const { draft, recipient, knows } = drafts()[action];
      const envelope = sealed(draft, NOW);
      const verified = await verifyEnvelope(envelope, ctx(recipient, NOW, knows));
      expect(verified).toMatchObject({ ok: true, action });
    });
  }

  test("남은 시한이 전달 지연 상한보다 짧으면 too_late_to_send, 같으면 만든다", () => {
    const draft = drafts().task_cancel.draft;
    const issued = NOW;
    expect(sealDraft({ ...draft, issuedAt: issued }, issued + limits.MESSAGE_TTL_MS - limits.DELIVERY_MAX_MS, ports()).ok).toBe(true);
    expect(sealDraft({ ...draft, issuedAt: issued }, issued + limits.MESSAGE_TTL_MS - limits.DELIVERY_MAX_MS + 1, ports())).toEqual({ ok: false, reason: "too_late_to_send" });
  });

  test("갱신: 임대 끝을 모르면 lease_unknown, 계약 경계 밖이면 lease_out_of_range", () => {
    const base = { run: facts, requestId: REQ_ID, stopGeneration: STOP_GEN, now: NOW };
    expect(renewDraft({ ...base, leaseUntil: null })).toEqual({ ok: false, reason: "lease_unknown" });
    expect(renewDraft({ ...base, leaseUntil: undefined })).toEqual({ ok: false, reason: "lease_unknown" });
    expect(renewDraft({ ...base, leaseUntil: NOW })).toEqual({ ok: false, reason: "lease_out_of_range" });
    expect(renewDraft({ ...base, leaseUntil: NOW + limits.RUN_LEASE_MAX_MS + 1 })).toEqual({ ok: false, reason: "lease_out_of_range" });
    expect(renewDraft({ ...base, leaseUntil: NOW + limits.RUN_LEASE_MAX_MS }).ok).toBe(true);
  });

  test("시작: 모자란 입력과 기한의 경계는 구별된 거절이다", () => {
    const base = { run, requestId: REQ_ID, stopGeneration: STOP_GEN, issuedAt: startIssuedAt };
    expect(startDraft({ ...base, issuedAt: null })).toEqual({ ok: false, reason: "issued_at_unknown" });
    expect(startDraft({ ...base, run: { ...run, snapshotDigest: null } })).toEqual({ ok: false, reason: "missing_field", field: "snapshotDigest" });
    expect(startDraft({ ...base, run: { ...run, inputDigest: null } })).toEqual({ ok: false, reason: "missing_field", field: "inputDigest" });
    expect(startDraft({ ...base, run: { ...run, kind: "session" } })).toEqual({ ok: false, reason: "not_worker_run" });
    expect(startDraft({ ...base, run: { ...run, role: "code_author" } })).toEqual({ ok: false, reason: "role_mismatch" });
    expect(startDraft({ ...base, run: { ...run, executorId: SESSION } })).toEqual({ ok: false, reason: "recipient_invalid" });
    expect(startDraft({ ...base, run: { ...run, budgetLeft: 0 } })).toEqual({ ok: false, reason: "budget_exhausted" });
    expect(startDraft({ ...base, run: { ...run, deadlineAt: startIssuedAt } })).toEqual({ ok: false, reason: "deadline_not_after_issue" });
    const late = ok(startDraft({ ...base, run: { ...run, deadlineAt: NOW } }));
    expect(sealDraft(late, NOW, ports())).toEqual({ ok: false, reason: "deadline_passed" });
    expect(sealDraft(late, NOW - 1, ports())).toEqual({ ok: false, reason: "deadline_too_close" });
  });

  test("발행 시각이 지금보다 늦으면 issued_in_future, 시각이 정수가 아니면 bad_time", () => {
    const draft = drafts().task_start.draft;
    expect(sealDraft(draft, startIssuedAt - 1, ports())).toEqual({ ok: false, reason: "issued_in_future" });
    expect(sealDraft(draft, Number.NaN, ports())).toEqual({ ok: false, reason: "bad_time" });
  });

  test("계약이 거절할 본문은 서명하지 않고 seal_refused로 계약 사유를 낸다", () => {
    const bad = ok(startDraft({ run: { ...run, credential: { ...run.credential, method: "password" } }, requestId: REQ_ID, stopGeneration: STOP_GEN, issuedAt: startIssuedAt }));
    expect(sealDraft(bad, NOW, ports())).toEqual({ ok: false, reason: "seal_refused", sealReason: "body_malformed" });
    const mismatch = ok(finalizeDraft({ run: facts, requestId: REQ_ID, stopGeneration: STOP_GEN, outcome: "failed", resultDigest: DIGEST, storedAt: NOW }));
    expect(sealDraft(mismatch, NOW, ports())).toEqual({ ok: false, reason: "seal_refused", sealReason: "body_malformed" });
  });

  test("조회·ack·종료의 꼴 거절", () => {
    expect(statusQueryDraft({ recipient: WORKER, stopGeneration: STOP_GEN, runIds: [] }, fakeRandom())).toEqual({ ok: false, reason: "run_ids_invalid" });
    expect(statusQueryDraft({ recipient: WORKER, stopGeneration: STOP_GEN, runIds: [RUN_ID, RUN_ID] }, fakeRandom())).toEqual({ ok: false, reason: "run_ids_invalid" });
    const nine = Array.from({ length: limits.STATUS_MAX_RUNS + 1 }, (_, i) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`);
    expect(statusQueryDraft({ recipient: WORKER, stopGeneration: STOP_GEN, runIds: nine }, fakeRandom())).toEqual({ ok: false, reason: "run_ids_invalid" });
    expect(statusQueryDraft({ recipient: "supervisor", stopGeneration: STOP_GEN, runIds: [RUN_ID] }, fakeRandom())).toEqual({ ok: false, reason: "recipient_invalid" });
    expect(ackDraft({ recipient: WORKER, stopGeneration: STOP_GEN, ids: [] }, fakeRandom())).toEqual({ ok: false, reason: "ids_invalid" });
    expect(stopDraft({ action: "task_cancel", run: { ...facts, executorId: SESSION }, requestId: REQ_ID, stopGeneration: STOP_GEN, reason: "requested" })).toEqual({
      ok: false,
      reason: "recipient_invalid",
    });
  });
});

describe("보낼 수 있다고 낸 봉투는 전달 상한 안에서 받는 쪽이 받는다", () => {
  test("작업 기한까지 전달 상한만큼 남지 않은 시작은 봉하지 않는다(deadline_too_close)", async () => {
    const base = { run, requestId: REQ_ID, stopGeneration: STOP_GEN, issuedAt: NOW };
    // 기한 T+1을 T에 봉하면 1ms 뒤 받는 쪽이 deadline_passed로 거절한다.
    const oneMs = ok(startDraft({ ...base, run: { ...run, deadlineAt: NOW + 1 } }));
    expect(sealDraft(oneMs, NOW, ports())).toEqual({ ok: false, reason: "deadline_too_close" });
    const short = ok(startDraft({ ...base, run: { ...run, deadlineAt: NOW + limits.DELIVERY_MAX_MS - 1 } }));
    expect(sealDraft(short, NOW, ports())).toEqual({ ok: false, reason: "deadline_too_close" });
    // 정확히 상한만큼 남으면 봉한다. 전달은 상한 미만이라 가장 늦게 받는 시각은 NOW + DELIVERY_MAX_MS - 1이다.
    const exact = ok(startDraft({ ...base, run: { ...run, deadlineAt: NOW + limits.DELIVERY_MAX_MS } }));
    const envelope = sealed(exact, NOW);
    expect(await verifyEnvelope(envelope, ctx(WORKER, NOW + limits.DELIVERY_MAX_MS - 1, false))).toMatchObject({ ok: true, action: "task_start" });
  });

  test("발행 시각이 빈 시작·갱신 초안은 봉하는 때의 now로 채우지 않고 거절한다", () => {
    // T에 발행하고 기한이 T+900000인 시작 초안의 issuedAt을 비워 T+31000에 봉하면 새 발행 시각의 시작이 되던 입력이다.
    const start = ok(startDraft({ run: { ...run, deadlineAt: NOW + 900_000 }, requestId: REQ_ID, stopGeneration: STOP_GEN, issuedAt: NOW }));
    for (const empty of [null, undefined]) {
      expect(sealDraft({ ...start, issuedAt: empty } as unknown as Draft, NOW + 31_000, ports())).toEqual({ ok: false, reason: "issued_at_unknown" });
    }
    // 발행 시각을 지킨 초안은 시한이 지나 다시 봉해지지 않는다.
    expect(sealDraft(start, NOW + 31_000, ports())).toEqual({ ok: false, reason: "too_late_to_send" });
    const renew = ok(renewDraft({ run: facts, requestId: REQ_ID, stopGeneration: STOP_GEN, now: NOW, leaseUntil: NOW + limits.RUN_LEASE_MAX_MS }));
    expect(sealDraft({ ...renew, issuedAt: null } as unknown as Draft, NOW + 1_000, ports())).toEqual({ ok: false, reason: "issued_at_unknown" });
    expect(sealDraft(renew, NOW + 31_000, ports())).toEqual({ ok: false, reason: "too_late_to_send" });
  });

  test("타입도 시작·갱신 초안의 발행 시각을 요구한다", () => {
    const start = drafts().task_start.draft as Draft<"task_start">;
    const renew = drafts().run_renew.draft as Draft<"run_renew">;
    // @ts-expect-error 시작 초안의 issuedAt은 number다.
    const startEmpty: Draft<"task_start"> = { ...start, issuedAt: null };
    // @ts-expect-error 갱신 초안의 issuedAt은 number다.
    const renewEmpty: Draft<"run_renew"> = { ...renew, issuedAt: null };
    expect(sealDraft(startEmpty, NOW, ports())).toEqual({ ok: false, reason: "issued_at_unknown" });
    expect(sealDraft(renewEmpty, NOW, ports())).toEqual({ ok: false, reason: "issued_at_unknown" });
  });

  test("실행 지시의 실행 세대 0은 초안에서 거절한다(run_generation_invalid)", () => {
    // 실행 세대 0인 시작은 받는 쪽이 처음 보는 실행이어도 run_generation_mismatch로 거절한다.
    const refused = { ok: false, reason: "run_generation_invalid" } as const;
    const zero = { ...facts, runGeneration: 0 };
    const base = { requestId: REQ_ID, stopGeneration: STOP_GEN };
    expect(startDraft({ ...base, run: { ...run, runGeneration: 0 }, issuedAt: startIssuedAt })).toEqual(refused);
    expect(renewDraft({ ...base, run: zero, now: NOW, leaseUntil: NOW + 1 })).toEqual(refused);
    expect(stopDraft({ ...base, action: "task_cancel", run: zero, reason: "requested" })).toEqual(refused);
    expect(stopDraft({ ...base, action: "session_stop", run: { ...zero, executorId: SESSION }, reason: "daily_rotation" })).toEqual(refused);
    expect(finalizeDraft({ ...base, run: zero, outcome: "succeeded", resultDigest: DIGEST, storedAt: NOW })).toEqual(refused);
  });

  test("공개 초안을 직접 봉해도 세대의 꼴을 본다", () => {
    const all = drafts();
    const refused = { ok: false, reason: "run_generation_invalid" } as const;
    for (const action of ["task_start", "run_renew", "task_cancel", "session_stop", "result_finalize"] as const) {
      expect(sealDraft({ ...all[action].draft, runGeneration: 0 }, NOW, ports())).toEqual(refused);
    }
    // 실행에 묶이지 않은 조회·ack는 0이어야 한다.
    expect(sealDraft({ ...all.status_query.draft, runGeneration: 1 }, NOW, ports())).toEqual(refused);
    expect(sealDraft({ ...all.ack.draft, runGeneration: 1 }, NOW, ports())).toEqual(refused);
    for (const bad of [-1, 0.5, 2 ** 53, "3"]) {
      expect(sealDraft({ ...all.task_cancel.draft, stopGeneration: bad as number }, NOW, ports())).toEqual({ ok: false, reason: "stop_generation_invalid" });
    }
    expect(sealDraft({ ...all.task_cancel.draft, stopGeneration: 0 }, NOW, ports()).ok).toBe(true);
  });

  test("서명 포트가 받은 본문을 고쳐 서명해도 대조의 기준과 초안은 바뀌지 않는다(signer_mismatch)", () => {
    // 갱신의 발급 끝 T+30000을 포트가 T+20000으로 고쳐 같은 키로 서명하는 입력이다.
    const leaseUntil = NOW + limits.RUN_LEASE_MAX_MS;
    const draft = ok(renewDraft({ run: facts, requestId: REQ_ID, stopGeneration: STOP_GEN, now: NOW, leaseUntil }));
    const tamper: Signer = {
      seal: (input) => {
        (input.body as unknown as { lease_until: number }).lease_until = NOW + 20_000;
        return sealEnvelope(input, keys.privateKey);
      },
    };
    expect(sealDraft(draft, NOW, ports(1, tamper))).toEqual({ ok: false, reason: "signer_mismatch" });
    expect(draft.body).toEqual({ run_id: RUN_ID, lease_until: leaseUntil });
    expect(sealed(draft, NOW).body).toEqual({ run_id: RUN_ID, lease_until: leaseUntil });
  });

  test("서명 포트가 돌려준 머리의 계약 판·여분 칸, 봉투의 여분 칸, 본문도 대조한다", () => {
    const draft = drafts().task_cancel.draft;
    const altered = (change: (e: Envelope) => unknown): Signer => ({ seal: (input) => change(sealEnvelope(input, keys.privateKey)) as Envelope });
    const cases = [
      altered((e) => ({ ...e, header: { ...e.header, contract: "olive-control/v0" } })),
      altered((e) => ({ ...e, header: { ...e.header, extra: 1 } })),
      altered((e) => ({ ...e, extra: 1 })),
      altered((e) => ({ ...e, body: { run_id: RUN_ID, reason: "budget" } })),
    ];
    for (const s of cases) expect(sealDraft(draft, NOW, ports(1, s))).toEqual({ ok: false, reason: "signer_mismatch" });
  });

  test("돌려준 봉투의 본문을 고쳐도 보존한 초안은 그대로다", () => {
    const draft = drafts().task_cancel.draft;
    const first = sealed(draft, NOW);
    (first.body as { reason: string }).reason = "budget";
    const second = sealed(draft, NOW + 1_000, ports(50));
    expect(second.header.body_digest).toBe(first.header.body_digest);
    expect(second.body).toEqual({ run_id: RUN_ID, reason: "requested" });
  });

  test("모양이 틀린 입력은 예외 대신 input_malformed로 거절한다", () => {
    const base = { requestId: REQ_ID, stopGeneration: STOP_GEN };
    expect(startDraft({ ...base, run: null, issuedAt: NOW } as never)).toEqual({ ok: false, reason: "input_malformed", field: "run" });
    expect(stopDraft({ ...base, action: "none", run: facts, reason: "requested" } as never)).toEqual({ ok: false, reason: "input_malformed", field: "action" });
    expect(renewDraft(null as never)).toEqual({ ok: false, reason: "input_malformed", field: "input" });
    expect(finalizeDraft({ ...base, run: null } as never)).toEqual({ ok: false, reason: "input_malformed", field: "run" });
    expect(statusQueryDraft(null as never, fakeRandom())).toEqual({ ok: false, reason: "input_malformed", field: "input" });
    expect(ackDraft(null as never, fakeRandom())).toEqual({ ok: false, reason: "input_malformed", field: "input" });
    expect(sealDraft(null as never, NOW, ports())).toEqual({ ok: false, reason: "input_malformed", field: "draft" });
    expect(sealDraft({ ...drafts().task_cancel.draft, action: "none" } as never, NOW, ports())).toEqual({ ok: false, reason: "input_malformed", field: "action" });
  });
});
