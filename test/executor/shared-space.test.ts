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
