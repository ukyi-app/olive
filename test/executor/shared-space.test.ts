// 전용이 아닌 PID 공간을 코어가 스스로 알아챌 수 있는 범위의 시험. 신호는 기록기로만 받는다(실제 신호 없음).
// 코어가 보는 것은 "부모가 이 공간 밖인 프로세스(PPid 0)"뿐이다. 공간을 만들고 독점하는 일은 호출자의 보증이다(README).
import { expect, test } from "bun:test";
import { PidSweep } from "../../src/executor/containment-core.ts";
import { FakeProc, type FakeProcess, SELF } from "./fake-proc.ts";

async function recorded(extra: Record<number, FakeProcess>) {
  const proc = new FakeProc();
  const pod = await PidSweep.establish({ self: SELF, reader: proc, kill: proc.kill }, { graceMs: 20, killMs: 40, pollMs: 1 });
  for (const [pid, entry] of Object.entries(extra)) proc.processes.set(Number(pid), entry);
  return { pod, proc };
}

test("R06 공유 공간: 깨끗한 기준 뒤 밖에서 합류한 프로세스(PPid 0)가 보이면 전체 신호를 보내지 않고 0도 말하지 않는다", async () => {
  const { pod, proc } = await recorded({ 300: { ppid: 0 }, 301: {} });
  await pod.terminate();
  expect(proc.signals).toEqual([]);
  expect(proc.processes.has(301)).toBe(true);
  expect(await pod.survivors()).toBeNull();
  // 합류한 프로세스가 사라져도 이 공간은 전용으로 되돌아가지 않는다.
  proc.processes.delete(300);
  proc.processes.delete(301);
  await pod.terminate();
  expect(proc.signals).toEqual([]);
  expect(await pod.survivors()).toBeNull();
});

test("R06 공유 공간: TERM과 KILL 사이에 합류해도 KILL을 보내지 않는다", async () => {
  const { pod, proc } = await recorded({ 310: { survivesTerm: true } });
  proc.onSignal = (signal) => {
    if (signal === "SIGTERM") proc.processes.set(311, { ppid: 0, survivesTerm: true });
  };
  await pod.terminate();
  expect(proc.signals.map((s) => s.signal)).toEqual(["SIGTERM"]);
  expect(await pod.survivors()).toBeNull();
});

test("R06 공유 공간: 부모가 이 공간 안이거나, 끝나는 중에 잠깐 PPid 0으로 보이거나, 좀비면 합류로 치지 않는다", async () => {
  const normal = await recorded({ 320: { ppid: SELF }, 321: { ppid: 320 } });
  await normal.pod.terminate();
  expect(normal.proc.signals.map((s) => s.signal)).toContain("SIGTERM");
  expect(await normal.pod.survivors()).toBe(0);
  const exiting = await recorded({ 322: { ppidReads: [0, SELF, SELF, SELF, SELF, SELF, SELF, SELF] } });
  await exiting.pod.terminate();
  expect(exiting.proc.signals.map((s) => s.signal)).toContain("SIGTERM");
  const zombie = await recorded({ 323: { state: "Z", ppid: 0 } });
  await zombie.pod.terminate();
  expect(zombie.proc.signals.map((s) => s.signal)).toContain("SIGTERM");
  expect(await zombie.pod.survivors()).toBe(0);
});

// 신호 직전 스캔의 마지막 관측. 첫 공간 확인은 통과하고 그 뒤의 스캔에서만 확인이 실패하게 만든다.

test("F01 불완전한 마지막 관측: 상태를 읽지 못한 항목이 있으면 전체 신호를 보내지 않는다", async () => {
  const { pod, proc } = await recorded({ 330: { statusError: "EIO" } });
  await pod.terminate();
  expect(proc.signals).toEqual([]);
  expect(await pod.survivors()).toBeNull();
});

test("F01 불완전한 마지막 관측: 목록을 읽지 못하면 전체 신호를 보내지 않는다", async () => {
  const { pod, proc } = await recorded({ 331: {} });
  proc.listError = "EIO";
  await pod.terminate();
  expect(proc.signals).toEqual([]);
});

test("F01 불완전한 마지막 관측: 스캔이 끝날 때의 공간 확인이 실패하면 전체 신호를 보내지 않는다", async () => {
  const { pod, proc } = await recorded({ 332: {} });
  const namespace = proc.namespace.bind(proc);
  let reads = 0;
  // 스캔 시작의 확인까지는 통과하고, 목록을 다 읽은 뒤의 확인에서 실패한다.
  proc.pids = async () => {
    reads++;
    proc.namespace = async () => {
      throw Object.assign(new Error("ns"), { code: "EACCES" });
    };
    return [...proc.processes.keys()];
  };
  await pod.terminate();
  proc.namespace = namespace;
  expect(reads).toBeGreaterThan(0);
  expect(proc.signals).toEqual([]);
});

test("F01 불완전한 마지막 관측: 리더가 Z인 항목의 스레드를 읽지 못하면 전체 신호를 보내지 않는다", async () => {
  const { pod, proc } = await recorded({ 333: { state: "Z", threadsError: "EIO" } });
  await pod.terminate();
  expect(proc.signals).toEqual([]);
});

test("F01 합류 의심: PPid 0을 다시 읽지 못한 것을 합류 아님으로 바꾸지 않는다", async () => {
  const { pod, proc } = await recorded({ 334: { ppid: 0, statusReads: [null, "EIO"] } });
  await pod.terminate();
  expect(proc.signals).toEqual([]);
});

test("F01 합류 의심: 리더가 Z여도 산 스레드가 있는 합류자는 합류자다", async () => {
  const { pod, proc } = await recorded({ 335: { state: "Z", ppid: 0, threads: { 335: "Z", 336: "S" } } });
  await pod.terminate();
  expect(proc.signals).toEqual([]);
  expect(await pod.survivors()).toBeNull();
});

test("F01 래치: 신호 직전 스캔을 기다리는 사이 다른 계수가 합류자를 봤으면 전체 신호를 보내지 않는다", async () => {
  const { pod, proc } = await recorded({ 337: {} });
  const list = proc.pids.bind(proc);
  let first = true;
  proc.pids = async () => {
    if (first) {
      first = false;
      // 신호 직전 스캔이 목록을 읽는 사이 다른 계수가 합류자를 보고 래치를 세운다. 합류자는 그 뒤 사라져 이 스캔에는 보이지 않는다.
      proc.processes.set(338, { ppid: 0 });
      expect(await pod.survivors()).toBeNull();
      proc.processes.delete(338);
    }
    return list();
  };
  await pod.terminate();
  expect(proc.signals).toEqual([]);
});

test("F01 대조군: 단순한 PID 소멸 경합은 전체 신호를 막지 않는다", async () => {
  const vanished = await recorded({ 340: { statusError: "ESRCH" } });
  await vanished.pod.terminate();
  expect(vanished.proc.signals.map((s) => s.signal)).toContain("SIGTERM");
  // PPid 0으로 보였다가 다시 읽을 때 사라졌다.
  const exited = await recorded({ 341: { ppid: 0, statusReads: [null, "ENOENT"] } });
  await exited.pod.terminate();
  expect(exited.proc.signals.map((s) => s.signal)).toContain("SIGTERM");
  // 리더가 Z인 항목의 스레드 목록이 읽는 사이 사라졌다.
  const leader = await recorded({ 342: { state: "Z", threadsError: "ENOENT" } });
  await leader.pod.terminate();
  expect(leader.proc.signals.map((s) => s.signal)).toContain("SIGTERM");
});

// 프로세스 자체의 소멸과 관측하던 스레드만의 소멸을 가른다. 부모가 공간 밖으로 보인 대상만 스레드 소멸이 신호를 막는다.

test("G01 합류 후보: 스레드 목록이 사라졌는데 프로세스가 남아 있으면 전체 신호를 보내지 않고 0도 말하지 않는다", async () => {
  const { pod, proc } = await recorded({ 350: { state: "Z", ppid: 0, threadsError: "ENOENT" } });
  await pod.terminate();
  expect(proc.signals).toEqual([]);
  expect(await pod.survivors()).toBeNull();
});

test("G01 합류 후보: 열거한 스레드만 사라지고 새 스레드가 도는 프로세스에 전체 신호를 보내지 않는다", async () => {
  const { pod, proc } = await recorded({ 351: { state: "Z", ppid: 0, threads: { 351: "Z", 352: "S" }, threadErrors: { 352: "ESRCH" } } });
  await pod.terminate();
  expect(proc.signals).toEqual([]);
  expect(await pod.survivors()).toBeNull();
});

test("G01 합류 후보: 다시 읽을 때 리더가 Z가 되고 스레드가 사라져도 합류 아님으로 바꾸지 않는다", async () => {
  const { pod, proc } = await recorded({ 353: { ppid: 0, stateReads: ["S", "Z"], threadsError: "ESRCH" } });
  await pod.terminate();
  expect(proc.signals).toEqual([]);
});

test("G01 합류 후보: 스레드 목록이 비어 있으면 생존을 가르지 못한 것이다", async () => {
  const { pod, proc } = await recorded({ 354: { state: "Z", ppid: 0, threads: {} } });
  await pod.terminate();
  expect(proc.signals).toEqual([]);
  expect(await pod.survivors()).toBeNull();
});

test("G01 부모 누락: 처음 읽은 상태에서 PPid를 해석하지 못하면 정상 부모로 치지 않는다", async () => {
  const { pod, proc } = await recorded({ 355: { ppidMissing: true } });
  await pod.terminate();
  expect(proc.signals).toEqual([]);
  expect(await pod.survivors()).toBeNull();
});

test("G01 대조군: 합류 후보라도 프로세스 자체가 사라졌으면 단순 경합이라 전체 신호를 막지 않는다", async () => {
  const { pod, proc } = await recorded({ 356: { state: "Z", ppid: 0, threadsError: "ENOENT", statusReads: [null, "ENOENT"] } });
  await pod.terminate();
  expect(proc.signals.map((s) => s.signal)).toContain("SIGTERM");
});

test("G01 대조군: 정상 부모의 스레드가 읽는 사이 사라져도 전체 신호를 막지 않는다", async () => {
  const listed = await recorded({ 357: { state: "Z", ppid: SELF, threadsError: "ENOENT" } });
  await listed.pod.terminate();
  expect(listed.proc.signals.map((s) => s.signal)).toContain("SIGTERM");
  const single = await recorded({ 358: { state: "Z", ppid: SELF, threads: { 358: "Z", 359: "S" }, threadErrors: { 359: "ESRCH" } } });
  await single.pod.terminate();
  expect(single.proc.signals.map((s) => s.signal)).toContain("SIGTERM");
});
