// 일찍 낸 갱신의 끝을 그 실행의 임대로 믿는 규칙(D-89 후보). 실제 장부 파일에 적고, 공개 읽기로 수명 판단의 입력을 조립해
// 실제 판단(nextIntent)을 부르고, 판단의 의도를 장부 연산으로 옮긴다. 숫자는 계약의 상수에서 계산한다.
import { expect, test } from "bun:test";
import { limits, type RunStatus } from "../../src/contract/v1/index.ts";
import { type Ledger, type RestorePorts, Restorer } from "../../src/ledger/index.ts";
import { type LifecyclePolicy, type LifecycleView, nextIntent, RENEW_HANDLING_MS, RENEW_MARGIN_MS } from "../../src/supervisor/scheduler/lifecycle.ts";
import { clock, digest, id, must, NOW, open, ready, startedWorker, tempPath, worker } from "./helpers.ts";

const MAX = limits.RUN_LEASE_MAX_MS;
// 기본 갱신 간격(RENEW_INTERVAL_MS)으로 판단한다. 응답 대기는 이 파일의 갱신 판단에 쓰이지 않는다.
const LIFE: LifecyclePolicy = { renewEveryMs: limits.RENEW_INTERVAL_MS, answerTimeoutMs: 30_000 };
// 여유 없이 낼 수 있는 마지막 발행 시각: 시작 임대(NOW, NOW + MAX)의 끝보다 여유만큼 앞.
const LAST_TIMELY = NOW + MAX - RENEW_MARGIN_MS;

// nextIntent의 입력. 장부가 임대 끝을 모르면 lease=null이다. scheduler-reads.test.ts의 조립과 같은 규칙이다.
function lifecycle(ledger: Ledger, runId: string, now: number): LifecycleView {
  const got = ledger.getRun(runId);
  if (!got.known || got.value === null) throw new Error("실행을 읽지 못함");
  const run = got.value;
  const times = ledger.instructionTimes(runId);
  const inputs = ledger.listInputs();
  if (!times.known || times.value === null || !inputs.known) throw new Error("지시나 입력을 읽지 못함");
  const input = inputs.value.find((i) => i.requestId === run.inputRequestId);
  if (run.inputRequestId !== null && input === undefined) throw new Error("연결된 입력이 없다");
  const lease = times.value.lease;
  return {
    run: { runId, kind: run.kind, state: run.state, deadlineAt: run.deadlineAt },
    lease: lease !== null && lease.expiresAt !== "unknown" ? { issuedAt: lease.issuedAt, expiresAt: lease.expiresAt } : null,
    cancelRequested: input?.cancelled === true,
    lastInstructionAt: run.state === "stopping" ? times.value.lastStopAt : times.value.lastFinalizeAt,
    resultSettled: false,
    now,
  };
}

function times(ledger: Ledger, runId: string) {
  const read = ledger.instructionTimes(runId);
  if (!read.known || read.value === null) throw new Error("지시를 읽지 못함");
  return read.value;
}

// 작업자 하나를 NOW에 시작하고 시작 영수증으로 running에 둔다.
function running(ledger: Ledger) {
  const started = startedWorker(ledger);
  must(ledger.applyReceipt({ action: "receipt_started", receiptId: id(), runId: started.runId, instructionRequestId: started.requestId, bodyDigest: digest("started"), now: NOW }, started.from));
  return started;
}

function renew(ledger: Ledger, runId: string, now: number): number {
  return must(ledger.recordRenewInstruction({ runId, requestId: id(), stopGeneration: 0, now })).leaseUntil;
}

// 실행 하나를 NOW에 시작하고 갱신을 주어진 순서로 기록한 뒤 닫았다 다시 연다. 작업자 슬롯이 하나라 사례마다 장부를 따로 둔다.
function renewedThenReopened(renewAts: number[]) {
  const path = tempPath();
  const first = open(path);
  const { runId } = running(first);
  for (const at of renewAts) renew(first, runId, at);
  const before = times(first, runId);
  first.close();
  const ledger = ready(open(path));
  expect(times(ledger, runId)).toEqual(before);
  return { ledger, ...before };
}

test("보장 1: 사슬의 모든 갱신이 앞 임대의 끝보다 여유만큼 앞서 발행됐을 때만 발급한 끝이 임대다", () => {
  expect(RENEW_MARGIN_MS).toBe(limits.DELIVERY_MAX_MS + limits.CLOCK_SKEW_MS + RENEW_HANDLING_MS);

  // 경계: 발행 + 여유 = 앞 임대의 끝이면 믿는다(실행기는 끝 정각부터 거절하고, 전달은 상한 미만이다).
  const edge = renewedThenReopened([LAST_TIMELY]);
  expect(edge.lease).toEqual({ issuedAt: LAST_TIMELY, expiresAt: LAST_TIMELY + MAX });
  expect(edge.renewIssued).toEqual({ issuedAt: LAST_TIMELY, leaseUntil: LAST_TIMELY + MAX });

  // 1ms 늦으면 끝을 믿지 않는다. 발급 기록의 뜻과 값은 그대로다(끝이 숫자로 남는다).
  const late = renewedThenReopened([LAST_TIMELY + 1]);
  expect(late.lease).toEqual({ issuedAt: LAST_TIMELY + 1, expiresAt: "unknown" });
  expect(late.renewIssued).toEqual({ issuedAt: LAST_TIMELY + 1, leaseUntil: LAST_TIMELY + 1 + MAX });

  // 사슬: 첫 갱신이 늦었으면 그 뒤 갱신이 자기 앞 임대보다 충분히 앞서도 모름이다. 실행기는 첫 갱신을 거절하고 시작 임대의 끝에서 닫았을 수 있다.
  const chain = renewedThenReopened([LAST_TIMELY + 1, LAST_TIMELY + 1 + LIFE.renewEveryMs]);
  expect(chain.lease).toEqual({ issuedAt: LAST_TIMELY + 1 + LIFE.renewEveryMs, expiresAt: "unknown" });
  expect(chain.renewIssued).toEqual({ issuedAt: LAST_TIMELY + 1 + LIFE.renewEveryMs, leaseUntil: LAST_TIMELY + 1 + LIFE.renewEveryMs + MAX });

  // 사슬의 뒤 갱신만 늦어도 모름이다: 둘째 갱신의 앞 임대는 첫 갱신이 발급한 끝이다.
  const first = NOW + LIFE.renewEveryMs;
  const tail = renewedThenReopened([first, first + MAX - RENEW_MARGIN_MS + 1]);
  expect(tail.lease).toEqual({ issuedAt: first + MAX - RENEW_MARGIN_MS + 1, expiresAt: "unknown" });

  // 모두 제때인 사슬은 마지막 갱신의 발행 시각과 발급한 끝이다.
  const timely = renewedThenReopened([first, first + MAX - RENEW_MARGIN_MS]);
  expect(timely.lease).toEqual({ issuedAt: first + MAX - RENEW_MARGIN_MS, expiresAt: first + 2 * MAX - RENEW_MARGIN_MS });

  // main이 발급 기록을 모름으로 두는 조건은 그대로 모름이다: 시작보다 이른 갱신, 같은 시각의 두 갱신, 역순으로 기록한 갱신.
  for (const renewAts of [[NOW - 1], [first, first], [NOW + 2 * LIFE.renewEveryMs, first]]) {
    const odd = renewedThenReopened(renewAts);
    expect(odd.lease).toEqual({ issuedAt: Math.max(...renewAts), expiresAt: "unknown" });
    expect(odd.renewIssued).toEqual({ issuedAt: Math.max(...renewAts), leaseUntil: "unknown" });
  }
});

test("보장 1·3의 경계가 같다: 판단이 갱신을 내는 마지막 시각의 갱신을 장부가 믿고, 1ms 뒤에는 판단이 조회하고 장부도 믿지 않는다", () => {
  const ledger = ready(open(tempPath()));
  const { runId } = running(ledger);
  expect(nextIntent(lifecycle(ledger, runId, LAST_TIMELY), LIFE)).toEqual({ intent: "renew_lease", runId, toward: "running" });
  expect(nextIntent(lifecycle(ledger, runId, LAST_TIMELY + 1), LIFE)).toEqual({ intent: "query", runId, toward: "unknown_running" });
  // 같은 두 시각에 기록한 갱신: 앞은 믿고 뒤는 믿지 않는다(작업자 슬롯이 하나라 뒤는 다른 장부다).
  renew(ledger, runId, LAST_TIMELY);
  expect(times(ledger, runId).lease).toEqual({ issuedAt: LAST_TIMELY, expiresAt: LAST_TIMELY + MAX });
  const other = ready(open(tempPath()));
  const late = running(other);
  renew(other, late.runId, LAST_TIMELY + 1);
  expect(times(other, late.runId).lease).toEqual({ issuedAt: LAST_TIMELY + 1, expiresAt: "unknown" });
});

// 갱신이 실행기의 시간 검사(봉투 시한과 앞 임대의 끝)를 통과하기에 충분한 조건의 계산이다. 실행기의 검사를 그대로 옮긴 것이 아니고
// 실행기를 띄우지 않는다. 시각은 감독 시계이고 ahead는 실행기 시계가 감독 시계보다 앞선 양이다. 받을 때 봉투가 not_yet_valid·expired가
// 아니어야 하고(src/contract/v1/envelope.ts의 "시한"), 임대를 검사하는 시각(checked)에도 봉투가 시한 안이어야 하며, 그 시각이 앞 임대의
// 끝 미만이어야 통과로 센다(src/executor/worker.ts의 expire: now >= lease_until이면 닫는다). 실제 실행기는 봉투의 시한을 nonce를
// 저장하기 전에 읽고(src/executor/store.ts의 consume), 저장한 뒤에 업무 기한과 앞 임대를 읽으므로 이 계산이 거절해도 실행기는 통과시킬
// 수 있다. 업무 기한·시작 접수·세대 같은 시간 밖의 전제는 계산하지 않는다(통과해도 적용된다는 뜻이 아니다).
interface Delivery {
  issuedAt: number;
  prevEnd: number;
  expiresAt: number;
  sendHandling: number;
  delivery: number;
  ahead: number;
  receiveHandling: number;
}
function passesTimeChecks(p: Delivery): boolean {
  const received = p.issuedAt + p.sendHandling + p.delivery + p.ahead;
  const checked = received + p.receiveHandling;
  if (p.issuedAt > received + limits.CLOCK_SKEW_MS || p.expiresAt <= received) return false;
  if (p.expiresAt <= checked) return false;
  return checked < p.prevEnd;
}
// 뒤 조각(배정기)이 지킬 송신 규칙(ledger.md "스케줄러"): 싣는 순간 앞 임대의 끝과 봉투 시한 가운데 이른 것까지 여유 이상 남았을 때만 싣는다.
const maySendRenew = (sendAt: number, prevEnd: number, expiresAt: number) => Math.min(prevEnd, expiresAt) - sendAt >= RENEW_MARGIN_MS;

test("가정의 경계(충분조건 계산): 장부가 믿는 마지막 갱신은 전달 상한 1ms 전·시계 오차 상한·처리 허용치 끝에서도 실행기의 시간 검사를 통과하고, 가정을 1ms 넘으면 통과하지 않는다", () => {
  const prevEnd = NOW + MAX;
  const sealed = (issuedAt: number) => issuedAt + limits.MESSAGE_TTL_MAX_MS;
  // 리뷰의 재현 입력: 전달 9999ms, 실행기 시계 +1000ms, 처리 1ms(싣기 전 또는 받은 뒤). 처리 허용치를 넣지 않은 여유의 마지막 시각
  // (앞 끝 - 전달 - 오차)에 낸 갱신은 실행기가 앞 임대의 끝 정각에 검사해 닫는다. 장부는 그 시각의 갱신을 믿지 않는다.
  const oldEdge = prevEnd - limits.DELIVERY_MAX_MS - limits.CLOCK_SKEW_MS;
  const review = { delivery: limits.DELIVERY_MAX_MS - 1, ahead: limits.CLOCK_SKEW_MS };
  for (const [sendHandling, receiveHandling] of [[1, 0], [0, 1]]) {
    expect(passesTimeChecks({ issuedAt: oldEdge, prevEnd, expiresAt: sealed(oldEdge), sendHandling, receiveHandling, ...review })).toBe(false);
  }
  expect(renewedThenReopened([oldEdge]).lease).toEqual({ issuedAt: oldEdge, expiresAt: "unknown" });

  // 장부가 믿는 마지막 발행 시각(LAST_TIMELY)에서는 같은 입력이 실행기의 시간 검사를 통과한다.
  expect(renewedThenReopened([LAST_TIMELY]).lease).toEqual({ issuedAt: LAST_TIMELY, expiresAt: LAST_TIMELY + MAX });
  const at = (p: Partial<Delivery>) => passesTimeChecks({ issuedAt: LAST_TIMELY, prevEnd, expiresAt: sealed(LAST_TIMELY), sendHandling: 0, receiveHandling: 0, ...review, ...p });
  expect(at({ receiveHandling: 1 })).toBe(true);
  // 송신 전 처리는 송신 규칙(싣는 순간의 여유)을 거친다. LAST_TIMELY에 발행하고 싣기까지 1ms라도 걸리면 여유가 RENEW_MARGIN_MS보다
  // 모자라 싣지 않는다. 송신 전 처리가 있는 사례는 발행을 그만큼 앞당겨 싣는 순간을 LAST_TIMELY에 맞추고 두 경계를 함께 확인한다.
  for (const sendHandling of [1, RENEW_HANDLING_MS]) expect(maySendRenew(LAST_TIMELY + sendHandling, prevEnd, sealed(LAST_TIMELY))).toBe(false);
  const sentAtEdge = (sendHandling: number, p: Partial<Delivery> = {}) => {
    const issuedAt = LAST_TIMELY - sendHandling;
    expect(maySendRenew(issuedAt + sendHandling, prevEnd, sealed(issuedAt))).toBe(true);
    return passesTimeChecks({ issuedAt, prevEnd, expiresAt: sealed(issuedAt), sendHandling, receiveHandling: 0, ...review, ...p });
  };
  expect(sentAtEdge(1)).toBe(true);
  // 가정의 끝(처리의 합이 허용치, 실행기 시계가 오차 상한만큼 앞섬이나 뒤짐)에서도 통과한다.
  for (const [sendHandling, receiveHandling] of [[RENEW_HANDLING_MS, 0], [0, RENEW_HANDLING_MS], [RENEW_HANDLING_MS / 2, RENEW_HANDLING_MS / 2]]) {
    expect(sentAtEdge(sendHandling, { receiveHandling })).toBe(true);
    expect(sentAtEdge(sendHandling, { receiveHandling, ahead: -limits.CLOCK_SKEW_MS })).toBe(true);
  }
  // 가정 밖: 받은 뒤의 처리가 허용치를 1ms 넘거나, 전달이 상한에 닿거나, 시계가 오차 상한보다 1ms 더 앞서면 실행기는 앞 임대의 끝
  // 정각에 검사해 닫는다. 장부의 끝은 그래도 LAST_TIMELY + MAX다(남는 한계).
  expect(at({ receiveHandling: RENEW_HANDLING_MS + 1 })).toBe(false);
  // 싣기까지 허용치를 넘긴 갱신은 송신 규칙이 싣지 않는다. 그래도 실으면 앞 임대의 끝 정각에 검사된다.
  expect(maySendRenew(LAST_TIMELY + RENEW_HANDLING_MS + 1, prevEnd, sealed(LAST_TIMELY))).toBe(false);
  expect(at({ sendHandling: RENEW_HANDLING_MS + 1 })).toBe(false);
  expect(at({ receiveHandling: RENEW_HANDLING_MS, delivery: limits.DELIVERY_MAX_MS })).toBe(false);
  expect(at({ receiveHandling: RENEW_HANDLING_MS, ahead: limits.CLOCK_SKEW_MS + 1 })).toBe(false);

  // 봉투 시한: 발행 시각부터 기본 수명 전체로 봉한 봉투는 앞 임대보다 늦게 끝나 걸리지 않는다. 짧게 봉한 봉투(리뷰의 수명 10000)는
  // 앞 임대가 남아 있어도 받을 때 만료될 수 있고, 송신 규칙이 그 봉투를 싣지 않는다.
  expect(sealed(LAST_TIMELY)).toBeGreaterThan(prevEnd);
  expect(maySendRenew(LAST_TIMELY, prevEnd, sealed(LAST_TIMELY))).toBe(true);
  const short = LAST_TIMELY + 10_000;
  expect(at({ expiresAt: short, delivery: limits.DELIVERY_MAX_MS - limits.CLOCK_SKEW_MS })).toBe(false);
  expect(maySendRenew(LAST_TIMELY, prevEnd, short)).toBe(false);
  // 송신 규칙을 통과한 봉투는 받은 뒤의 처리가 허용치 안이면, 싣기까지 얼마가 걸렸든 실행기의 시간 검사를 통과한다.
  for (const sendHandling of [0, 1, RENEW_HANDLING_MS]) {
    const issuedAt = LAST_TIMELY - sendHandling;
    expect(maySendRenew(issuedAt + sendHandling, prevEnd, sealed(issuedAt))).toBe(true);
    expect(passesTimeChecks({ issuedAt, prevEnd, expiresAt: sealed(issuedAt), sendHandling, receiveHandling: RENEW_HANDLING_MS, ...review })).toBe(true);
  }
});

test("보장 2: 기본 간격으로 임대 길이의 두 배를 넘게 연달아 갱신하고 조회로 빠지지 않으며, 다시 열어도 같은 답이다", () => {
  const path = tempPath();
  let ledger = open(path);
  const { runId } = running(ledger);
  const renewedAt: number[] = [];
  const seen = new Set<string>();
  // 1초마다 판단을 부르고 의도를 장부 연산으로 옮긴다. 갱신을 기록할 때마다 닫았다 다시 열고 같은 판단이 나오는지 본다.
  for (let now = NOW; now <= NOW + 2 * MAX + LIFE.renewEveryMs; now += 1_000) {
    const intent = nextIntent(lifecycle(ledger, runId, now), LIFE);
    seen.add(intent.intent);
    if (intent.intent !== "renew_lease") continue;
    expect(renew(ledger, runId, now)).toBe(now + MAX);
    renewedAt.push(now);
    const view = lifecycle(ledger, runId, now + 1);
    ledger.close();
    ledger = ready(open(path));
    expect(lifecycle(ledger, runId, now + 1)).toEqual(view);
    expect(times(ledger, runId).lease).toEqual({ issuedAt: now, expiresAt: now + MAX });
  }
  expect([...seen].sort()).toEqual(["renew_lease", "wait"]);
  expect(renewedAt.length).toBeGreaterThanOrEqual(6);
  expect(renewedAt.at(-1) as number).toBeGreaterThan(NOW + 2 * MAX);
  expect(renewedAt).toEqual(Array.from({ length: renewedAt.length }, (_, i) => NOW + (i + 1) * LIFE.renewEveryMs));
});

test("보장 3: 판단은 여유 없이 갱신을 내지 않고, 정책 검증은 제때 낸 갱신에 여유가 남지 않는 간격을 거절한다", () => {
  const base = { cancelRequested: false, lastInstructionAt: null, resultSettled: false, now: NOW };
  const run = { runId: "r", kind: "worker" as const, state: "running" as const, deadlineAt: NOW + 600_000 };
  const query = { intent: "query", runId: "r", toward: "unknown_running" } as const;
  expect(nextIntent({ ...base, run, lease: { issuedAt: NOW - MAX + RENEW_MARGIN_MS, expiresAt: NOW + RENEW_MARGIN_MS } }, LIFE).intent).toBe("renew_lease");
  expect(nextIntent({ ...base, run, lease: { issuedAt: NOW - MAX + RENEW_MARGIN_MS - 1, expiresAt: NOW + RENEW_MARGIN_MS - 1 } }, LIFE)).toEqual(query);
  // 갱신 주기가 아직이어도 여유가 없으면 기다리지 않고 조회한다.
  expect(nextIntent({ ...base, run, lease: { issuedAt: NOW - 1_000, expiresAt: NOW + RENEW_MARGIN_MS - 1 } }, LIFE)).toEqual(query);
  expect(nextIntent({ ...base, run, lease: { issuedAt: NOW - 1_000, expiresAt: NOW + RENEW_MARGIN_MS } }, LIFE).intent).toBe("wait");

  // 정책: 기본값은 통과하고, renewEveryMs + 여유가 임대 상한을 넘으면 거절한다.
  const view: LifecycleView = { ...base, run, lease: null };
  expect(() => nextIntent(view, { ...LIFE, renewEveryMs: limits.RENEW_INTERVAL_MS })).not.toThrow();
  expect(() => nextIntent(view, { ...LIFE, renewEveryMs: MAX - RENEW_MARGIN_MS })).not.toThrow();
  expect(() => nextIntent(view, { ...LIFE, renewEveryMs: MAX - RENEW_MARGIN_MS + 1 })).toThrow(TypeError);

  // 판단을 거치지 않았거나 판단 뒤 시각을 다시 읽어 늦은 갱신을 기록해도 장부는 그 끝을 믿지 않고, 판단은 그 뒤로 같은 ID를 조회한다.
  const path = tempPath();
  const first = open(path);
  const { runId } = running(first);
  expect(nextIntent(lifecycle(first, runId, LAST_TIMELY + 1), LIFE).intent).toBe("query");
  expect(renew(first, runId, LAST_TIMELY + 1)).toBe(LAST_TIMELY + 1 + MAX);
  first.close();
  const ledger = ready(open(path));
  expect(times(ledger, runId).lease).toEqual({ issuedAt: LAST_TIMELY + 1, expiresAt: "unknown" });
  for (const now of [NOW + MAX, LAST_TIMELY + 1 + LIFE.renewEveryMs]) {
    expect(nextIntent(lifecycle(ledger, runId, now), LIFE)).toEqual({ intent: "query", runId, toward: "unknown_running" });
  }
});

// 믿은 임대(NOW + 10초에 낸 갱신, 끝 NOW + 40초)가 남아 있는 NOW + 20초에 갱신 주기가 돈다. 반대 증거가 없으면 갱신이다.
const RENEWED_AT = NOW + LIFE.renewEveryMs;
const CHECK_AT = RENEWED_AT + LIFE.renewEveryMs;

function trusted() {
  const ledger = ready(open(tempPath()));
  const started = running(ledger);
  renew(ledger, started.runId, RENEWED_AT);
  expect(times(ledger, started.runId).lease).toEqual({ issuedAt: RENEWED_AT, expiresAt: RENEWED_AT + MAX });
  expect(CHECK_AT).toBeLessThan(RENEWED_AT + MAX - RENEW_MARGIN_MS);
  return { ledger, ...started };
}

function ports(runs: RunStatus[], executorId: string): RestorePorts {
  return {
    stopAuthority: { latestStop: async () => null },
    peers: { contracts: async () => [{ peer: "front-door", contract: "olive-control/v2", policy: "match" }] },
    occupancy: { occupancy: async () => [{ executorId, coverage: "partial", runs }] },
    publications: { lookup: async () => ({ kind: "pending" as const }) },
  };
}

test("보장 4: 믿은 임대가 남아 있어도 종료 영수증·연결 상실 표시·복원의 상태 보고 뒤에는 running의 임대로 다루지 않는다", async () => {
  // 대조군: 반대 증거가 없으면 갱신이다.
  const control = trusted();
  expect(nextIntent(lifecycle(control.ledger, control.runId, CHECK_AT), LIFE).intent).toBe("renew_lease");

  // 종료 확인 영수증(정상 종료): 결과 검사(checking)로 가고 갱신·조회를 내지 않는다.
  for (const [exit, state, intent] of [
    ["completed", "checking", "wait"],
    ["failed", "failed_stopped", "finalize"],
  ] as const) {
    const c = trusted();
    must(c.ledger.applyReceipt({ action: "receipt_stopped", receiptId: id(), runId: c.runId, exit, bodyDigest: digest(exit), now: RENEWED_AT + 1 }, c.from));
    expect(times(c.ledger, c.runId).lease).toEqual({ issuedAt: RENEWED_AT, expiresAt: RENEWED_AT + MAX });
    expect(c.ledger.getRun(c.runId)).toMatchObject({ known: true, value: { state } });
    expect(nextIntent(lifecycle(c.ledger, c.runId, CHECK_AT), LIFE).intent).toBe(intent);
    // 영수증 뒤에는 갱신 기록 자체가 거절된다.
    expect(c.ledger.recordRenewInstruction({ runId: c.runId, requestId: id(), stopGeneration: 0, now: CHECK_AT })).toEqual({ ok: false, reason: "transition_denied" });
  }

  // 연결 상실 표시(markLost): unknown_running이 되고 같은 ID를 조회한다.
  const lost = trusted();
  expect(lost.ledger.markLost(RENEWED_AT + 1)).toEqual({ ok: true, runIds: [lost.runId] });
  expect(nextIntent(lifecycle(lost.ledger, lost.runId, CHECK_AT), LIFE)).toEqual({ intent: "query", runId: lost.runId, toward: "unknown_running" });

  // 복원에서 실행기가 그 실행을 끝났다고(finalized) 또는 모른다고(not_known) 답했다: 3단계가 unknown_running으로 두고 조회한다.
  for (const reported of ["finalized", "not_known"] as const) {
    const r = trusted();
    const generation = r.ledger.runGeneration(r.runId) as number;
    const status: RunStatus =
      reported === "not_known"
        ? { run_id: r.runId, state: "not_known", run_generation: null, last_receipt_id: null }
        : { run_id: r.runId, state: "finalized", run_generation: generation, last_receipt_id: id() };
    const restorer = new Restorer(r.ledger, ports([status], r.from.sender), clock, { requiredPeers: ["front-door"] });
    await restorer.step1();
    await restorer.step2();
    const s3 = await restorer.step3();
    expect(s3.markedUnknown).toEqual([r.runId]);
    expect(nextIntent(lifecycle(r.ledger, r.runId, CHECK_AT), LIFE)).toEqual({ intent: "query", runId: r.runId, toward: "unknown_running" });
  }
});

test("슬롯: 믿은 임대가 지난 뒤에도 종료 확인 전에는 slot_busy", () => {
  // 장부의 시계도 임대의 끝을 지나게 한다(시작·기한 판정은 장부 시계로 잰다).
  let at = NOW;
  const ledger = ready(open(tempPath(), { clock: () => at }));
  const { runId } = running(ledger);
  renew(ledger, runId, RENEWED_AT);
  const end = RENEWED_AT + MAX;
  expect(times(ledger, runId).lease).toEqual({ issuedAt: RENEWED_AT, expiresAt: end });
  at = end + 1;
  expect(nextIntent(lifecycle(ledger, runId, at), LIFE)).toEqual({ intent: "query", runId, toward: "unknown_running" });
  const next = must(ledger.admitRun(worker({ now: at }))).run;
  expect(ledger.slotFree("worker")).toEqual({ known: true, value: false });
  expect(ledger.startRun({ runId: next.runId, requestId: id(), stopGeneration: 0, now: at })).toEqual({ ok: false, reason: "slot_busy" });
});
