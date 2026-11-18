// 장부 시험의 공용 도구. 장부 파일은 시험마다 임시 폴더에 만들고 지운다(저장소에 남기지 않는다).
import { afterEach } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AdmitRunInput, type EnvelopeFrom, type Ledger, openLedger, type OpenOptions } from "../../src/ledger/index.ts";
import { RESTORE_KEY } from "../../src/ledger/ledger.ts";

const dirs: string[] = [];
const ledgers: Ledger[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "olive-ledger-"));
  dirs.push(dir);
  return dir;
}

export function tempPath(): string {
  return join(tempDir(), "ledger.db");
}

export const NOW = 1_800_000_000_000;
export const clock = () => NOW;

// 파일이 없으면 첫 설치(create), 있으면 재개방(reopen)으로 연다. 열기의 구분 자체를 보는 시험은 openLedger를 직접 부른다.
export function open(path: string, options: Partial<OpenOptions> = {}): Ledger {
  const result = openLedger(path, { clock, mode: existsSync(path) ? "reopen" : "create", ...options });
  if (!result.ok) throw new Error(`열지 못함: ${result.reason} ${result.detail}`);
  ledgers.push(result.ledger);
  return result.ledger;
}

export const id = () => randomUUID();
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function worker(overrides: Partial<AdmitRunInput> = {}): AdmitRunInput {
  return {
    kind: "worker",
    runId: id(),
    dedupeKey: null,
    inputRequestId: null,
    role: "diagnosis",
    snapshotDigest: digest("snapshot"),
    inputDigest: digest("input"),
    profileRevision: "profile-1",
    policyRevision: "policy-1",
    executorId: "executor/diagnosis/0/store-a",
    credential: { account: "acct-a", method: "subscription", revision: "cred-3", digest: digest("credential bytes") },
    deadlineAt: NOW + 600_000,
    budgetLeft: 50_000,
    now: NOW,
    ...overrides,
  };
}

export function session(overrides: Partial<AdmitRunInput> = {}): AdmitRunInput {
  return { ...worker(), kind: "session", role: null, snapshotDigest: null, executorId: "executor/session/0/store-s", ...overrides };
}

// 재시작 복원을 다 거친 장부처럼 만든다: 정지 기록이 없으면 0(정지 아님)을 적고 접수를 연다.
// 복원의 단계 자체를 보는 시험은 Restorer를 쓴다. 이 도우미는 쓰기 규칙만 보는 시험이 복원을 매번 돌리지 않게 한다.
export function ready(ledger: Ledger): Ledger {
  if (ledger.readStop().known && (ledger.readStop() as { value: unknown }).value === null) must(ledger.applyStop({ generation: 0, stopped: false, now: NOW }));
  grant(ledger);
  return ledger;
}

// 복원 시도 하나를 건너뛰어 접수 허가만 낸다(정지 중이면 허가가 나지 않는다).
export function grant(ledger: Ledger): boolean {
  const attempt = ledger.beginRestore(RESTORE_KEY);
  ledger.pinRestore(RESTORE_KEY, attempt);
  return ledger.grantIntake(RESTORE_KEY, attempt);
}

export function from(run: { executorId: string; runGeneration: number }): EnvelopeFrom {
  return { sender: run.executorId, runGeneration: run.runGeneration };
}

export const WORKER_EXECUTOR = "executor/diagnosis/0/store-a";
export const SESSION_EXECUTOR = "executor/session/0/store-s";

// 정지 세대 0(정지 아님)을 적고 작업자 실행을 preparing까지 올린다.
export function startedWorker(ledger: Ledger, overrides: Partial<AdmitRunInput> = {}) {
  ready(ledger);
  const admitted = ledger.admitRun(worker(overrides));
  if (!admitted.ok) throw new Error(`admit: ${admitted.reason}`);
  const requestId = id();
  const started = ledger.startRun({ runId: admitted.run.runId, requestId, stopGeneration: 0, now: NOW });
  if (!started.ok) throw new Error(`start: ${started.reason}`);
  return { runId: admitted.run.runId, requestId, from: from(admitted.run) };
}

export function must<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`실패: ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}
