// 장부 시험의 공용 도구. 장부 파일은 시험마다 임시 폴더에 만들고 지운다(저장소에 남기지 않는다).
import { afterEach } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AdmitRunInput, type Ledger, openLedger, type OpenOptions } from "../../src/ledger/index.ts";

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

export function open(path: string, options: Partial<OpenOptions> = {}): Ledger {
  const result = openLedger(path, { clock, ...options });
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

// 정지 세대 0(정지 아님)을 적고 작업자 실행을 preparing까지 올린다.
export function startedWorker(ledger: Ledger, overrides: Partial<AdmitRunInput> = {}) {
  if (ledger.readStop().known && (ledger.readStop() as { value: unknown }).value === null) ledger.applyStop({ generation: 0, stopped: false, now: NOW });
  const admitted = ledger.admitRun(worker(overrides));
  if (!admitted.ok) throw new Error(`admit: ${admitted.reason}`);
  const requestId = id();
  const started = ledger.startRun({ runId: admitted.run.runId, requestId, stopGeneration: 0, now: NOW });
  if (!started.ok) throw new Error(`start: ${started.reason}`);
  return { runId: admitted.run.runId, requestId };
}

export function must<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`실패: ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}
