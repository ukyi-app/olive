// 대리 핵심의 시험. 링크는 가짜 Transport, 정리·띄우기·시계는 가짜다. 실제 프로세스는 test/executor/containment.test.ts의 "대리" 사례가 본다.
import { expect, test } from "bun:test";
import { AGENT_EXIT, type AgentParts, type AgentOptions, RoleAgent } from "../../src/agent/agent.ts";
import { encodeControl } from "../../src/agent/link.ts";
import { encodeCredentialFrame, encodeFrame } from "../../src/transport/framing.ts";
import { FakeLauncher, FakeRuntime, FakeSpace, RUN, RUN2, SECRET, SECRET_DIGEST, secretBytes, settle, startBytes, T0, Wire } from "./support.ts";

async function agent(options: AgentOptions = {}, over: Partial<AgentParts> = {}) {
  const runtime = new FakeRuntime();
  const space = new FakeSpace();
  const launcher = new FakeLauncher();
  const wire = new Wire();
  const order: string[] = [];
  const parts: AgentParts = {
    selfPid: 1,
    harden: () => (order.push("harden"), true),
    record: async () => (order.push("record"), space),
    launcher,
    ...over,
  };
  const role = await RoleAgent.prepare(runtime, parts, options);
  role?.attach(wire);
  return { role: role!, runtime, space, launcher, wire, order };
}

const terminate = (seq: number) => encodeControl({ type: "terminate", seq });
const count = (seq: number) => encodeControl({ type: "count", seq });
const lastCounted = (wire: Wire) => wire.messages().findLast((message) => message.type === "counted");

test("대리: harden → PID 1 확인 → 정리 코어 기록 순서로 뜨고 hello 하나만 보낸다. 어느 단계든 실패하면 링크 없이 그 코드로 끝난다", async () => {
  const ok = await agent();
  expect(ok.order).toEqual(["harden", "record"]);
  expect(ok.wire.types()).toEqual(["hello"]);
  expect(ok.runtime.exits).toEqual([]);

  for (const [over, code] of [
    [{ harden: () => false }, AGENT_EXIT.not_hardened],
    [{ selfPid: 2 }, AGENT_EXIT.not_init],
    [
      {
        record: async () => {
          throw new Error("baseline_not_clean");
        },
      },
      AGENT_EXIT.space_unavailable,
    ],
  ] as const) {
    const runtime = new FakeRuntime();
    let recorded = false;
    const parts: AgentParts = { selfPid: 1, harden: () => true, record: async () => ((recorded = true), new FakeSpace()), launcher: new FakeLauncher(), ...over };
    expect(await RoleAgent.prepare(runtime, parts)).toBeNull();
    expect(runtime.exits).toEqual([code]);
    // non-dumpable이 아니거나 PID 1이 아니면 정리 코어를 기록하지도 않는다.
    if (code !== AGENT_EXIT.space_unavailable) expect(recorded).toBe(false);
  }
});

test("대리 정상 길: start → spawned·output·exited, 끝내기 → terminated, 세기 0 → 실행이 닫히고 다음 start를 받는다", async () => {
  const { role, launcher, space, wire, runtime } = await agent();
  role.receive(startBytes());
  await settle();
  // 띄우기 전에 공간이 비었는지 한 번 센다.
  expect(space.countCalls).toBe(1);
  expect(launcher.calls).toHaveLength(1);
  const plan = launcher.calls[0]!.plan;
  // 계획은 start와 자격 값으로만 만든다. 자격 값은 credential_env 하나에만 있다.
  // 실패 진단에 값이 실리지 않게 자격 칸은 불리언으로, 나머지는 값을 뺀 꼴로 비교한다.
  const { OLIVE_CREDENTIAL: credential, ...env } = plan.env;
  expect(credential === SECRET).toBe(true);
  // 다른 칸에 값이 섞였으면 아래 diff에 실리기 전에 여기서 멈춘다.
  expect(JSON.stringify({ ...plan, env }).includes(SECRET)).toBe(false);
  expect({ ...plan, env }).toEqual({ program: "/usr/bin/role", argv: ["--plan"], cwd: "/work", env: { HOME: "/work" } });
  expect(launcher.calls[0]!.hooks.outputBytes).toBe(4_096);
  launcher.finish(0, new TextEncoder().encode('{"ok":true}'));
  await settle();
  // exited와 엇갈려 온 갱신은 실행이 닫히기 전이면 받는다.
  role.receive(encodeControl({ type: "renew", run_id: RUN, lease_until: T0 + 40_000 }));
  role.receive(terminate(1));
  role.receive(count(2));
  await settle();
  const messages = wire.messages();
  expect(messages.map((message) => message.type)).toEqual(["hello", "spawned", "output", "exited", "terminated", "counted"]);
  expect(messages[3]).toEqual({ type: "exited", run_id: RUN, code: 0, signal: null, overflow: false, stdout_bytes: 11 });
  expect(lastCounted(wire)).toEqual({ type: "counted", seq: 2, survivors: 0 });
  expect(space.terminations).toBe(1);
  // 닫힌 실행의 감시 타이머는 남지 않는다.
  expect(runtime.liveTimers()).toBe(0);
  role.receive(startBytes({ run_id: RUN2 }));
  await settle();
  expect(launcher.calls).toHaveLength(2);
  expect(runtime.exits).toEqual([]);
});

test("대리: 끝내기 뒤 남은 수가 0이 아니거나 모름이면 그 값을 그대로 내고, 실행을 닫지 않아 새 start는 계약 밖이다", async () => {
  for (const survivors of [2, null]) {
    const { role, launcher, space, wire, runtime } = await agent();
    role.receive(startBytes());
    await settle();
    launcher.finish(0, new Uint8Array());
    await settle();
    space.counts.push(survivors);
    role.receive(terminate(1));
    role.receive(count(2));
    await settle();
    expect(lastCounted(wire)).toEqual({ type: "counted", seq: 2, survivors });
    expect(runtime.exits).toEqual([]);
    role.receive(startBytes({ run_id: RUN2 }));
    await settle();
    expect(launcher.calls).toHaveLength(1);
    expect(runtime.exits).toEqual([AGENT_EXIT.protocol]);
  }
});

test("대리: 앞 실행의 후손이 남은 공간에서는 띄우지 않고, 자격 값이 다른 칸에 있으면 띄우지 않는다", async () => {
  const dirty = await agent();
  dirty.space.counts.push(1);
  dirty.role.receive(startBytes());
  await settle();
  expect(dirty.launcher.calls).toHaveLength(0);
  expect(dirty.wire.messages().at(-1)).toEqual({ type: "not_spawned", run_id: RUN, reason: "space_not_clean" });

  const leaky = await agent();
  leaky.role.receive(startBytes({ argv: [`--token=${SECRET}`] }));
  await settle();
  expect(leaky.launcher.calls).toHaveLength(0);
  expect(leaky.wire.messages().at(-1)).toEqual({ type: "not_spawned", run_id: RUN, reason: "refused" });

  const late = await agent();
  late.runtime.t = T0 + 30_000;
  late.role.receive(startBytes());
  await settle();
  expect(late.wire.messages().at(-1)).toEqual({ type: "not_spawned", run_id: RUN, reason: "expired" });
});

test("스스로 집행: 링크가 끊기면 실행을 멈추고 정리를 돌린 뒤 link_closed 코드로 끝난다. 그 뒤로는 말하지 않는다", async () => {
  const { role, launcher, space, wire, runtime } = await agent();
  role.receive(startBytes());
  await settle();
  role.linkClosed();
  await settle();
  expect(launcher.calls[0]!.signal.aborted).toBe(true);
  expect(space.terminations).toBe(1);
  expect(wire.closed).toBe(true);
  expect(runtime.exits).toEqual([AGENT_EXIT.link_closed]);
  const before = wire.written.length;
  launcher.finish(0, new Uint8Array([1, 2, 3]));
  role.receive(count(1));
  await settle();
  expect(wire.written.length).toBe(before);
  expect(runtime.exits).toEqual([AGENT_EXIT.link_closed]);
});

test("스스로 집행: 쓰기가 실패하면 링크 끊김으로 끝난다", async () => {
  const { role, wire, runtime } = await agent();
  wire.failWrites = true;
  role.receive(count(1));
  await settle();
  expect(runtime.exits).toEqual([AGENT_EXIT.link_closed]);
});

test("스스로 집행: 모르는 메시지·칸이 틀린 메시지·값 틀만 온 경우·크기 초과는 protocol 코드로 끝난다", async () => {
  const json = (value: unknown) => {
    const encoded = encodeFrame(new TextEncoder().encode(JSON.stringify(value)));
    if (!encoded.ok) throw new Error("encode");
    return encoded.frame;
  };
  const credentialOnly = startBytes().subarray(startBytes().length - (4 + 100 + secretBytes().length));
  const tooLarge = new Uint8Array(4);
  new DataView(tooLarge.buffer).setUint32(0, 64 * 1024 + 1, false);
  for (const bytes of [
    json({ v: 1, type: "shutdown" }),
    json({ v: 2, type: "count", seq: 1 }),
    json({ v: 1, type: "count", seq: 1, extra: true }),
    credentialOnly,
    tooLarge,
    encodeControl({ type: "renew", run_id: RUN, lease_until: T0 + 1 }),
  ]) {
    const { role, space, runtime, wire } = await agent();
    role.receive(bytes);
    await settle();
    expect(runtime.exits).toEqual([AGENT_EXIT.protocol]);
    expect(space.terminations).toBe(1);
    expect(wire.closed).toBe(true);
  }
});

test("스스로 집행: 실행 중에 다른 start가 오면 계약 밖이다(실행은 한 번에 하나)", async () => {
  const { role, launcher, runtime } = await agent();
  role.receive(startBytes());
  await settle();
  role.receive(startBytes({ run_id: RUN2 }));
  await settle();
  expect(launcher.calls).toHaveLength(1);
  expect(launcher.calls[0]!.signal.aborted).toBe(true);
  expect(runtime.exits).toEqual([AGENT_EXIT.protocol]);
});

test("스스로 집행: 임대 끝 + 여유까지 갱신이 없으면 끝나고, 갱신은 그 시각을 미룬다. 기한은 갱신으로 미뤄지지 않는다", async () => {
  const grace = 1_000;
  const idle = await agent({ enforceGraceMs: grace });
  idle.role.receive(startBytes({ lease_until: T0 + 10_000 }));
  await settle();
  idle.runtime.advance(10_000 + grace - 1);
  expect(idle.runtime.exits).toEqual([]);
  idle.runtime.advance(1);
  await settle();
  expect(idle.runtime.exits).toEqual([AGENT_EXIT.lease_expired]);
  expect(idle.launcher.calls[0]!.signal.aborted).toBe(true);

  const renewed = await agent({ enforceGraceMs: grace });
  renewed.role.receive(startBytes({ lease_until: T0 + 10_000, deadline_at: T0 + 50_000 }));
  await settle();
  renewed.runtime.advance(5_000);
  renewed.role.receive(encodeControl({ type: "renew", run_id: RUN, lease_until: T0 + 40_000 }));
  renewed.runtime.advance(10_000 + grace);
  expect(renewed.runtime.exits).toEqual([]);
  // 임대를 기한 뒤로 늘려도 기한 + 여유에서 끝난다.
  renewed.role.receive(encodeControl({ type: "renew", run_id: RUN, lease_until: T0 + 90_000 }));
  renewed.runtime.advance(50_000 + grace - renewed.runtime.t + T0);
  await settle();
  expect(renewed.runtime.exits).toEqual([AGENT_EXIT.lease_expired]);
});

test("스스로 집행: 기존 임대 끝 + 여유가 지난 뒤 갱신이 만료 콜백보다 먼저 와도 그 갱신을 받지 않고 lease_expired로 끝난다", async () => {
  // 기본 여유(25초)에서 기존 집행 시각은 min(90초, 30초) + 25초 = 55초다.
  const late = await agent();
  late.role.receive(startBytes({ lease_until: T0 + 30_000, deadline_at: T0 + 90_000 }));
  await settle();
  const call = late.launcher.calls[0]!;
  call.hooks.spawned({ pid: 7, exited: new Promise(() => {}), signal: () => {} });
  late.runtime.advance(28_000);
  const renew = encodeControl({ type: "renew", run_id: RUN, lease_until: T0 + 58_000 });
  // 시계만 집행 시각 뒤로 옮긴다. 도래한 타이머는 아직 돌지 않았다(갱신이 먼저 처리되는 차례).
  late.runtime.t = T0 + 55_001;
  const before = late.wire.written.length;
  late.role.receive(renew);
  await settle();
  expect(late.runtime.exits).toEqual([AGENT_EXIT.lease_expired]);
  expect(late.wire.closed).toBe(true);
  expect(call.signal.aborted).toBe(true);
  // 그 뒤 역할이 성공으로 끝나고 제어가 끝내기·세기를 보내도 아무 결과도 나가지 않는다.
  late.runtime.advance(1);
  call.resolve({ exit: { code: 0, signal: null }, stdout: new TextEncoder().encode('{"ok":true}'), overflow: false });
  await settle();
  late.role.receive(terminate(1));
  late.role.receive(count(2));
  await settle();
  expect(late.wire.written.length === before).toBe(true);
  expect(late.runtime.exits).toEqual([AGENT_EXIT.lease_expired]);

  // 집행 시각 직전의 갱신은 그대로 받아 감시를 새 임대로 옮긴다.
  const ontime = await agent();
  ontime.role.receive(startBytes({ lease_until: T0 + 30_000, deadline_at: T0 + 90_000 }));
  await settle();
  ontime.runtime.t = T0 + 54_999;
  ontime.role.receive(encodeControl({ type: "renew", run_id: RUN, lease_until: T0 + 58_000 }));
  await settle();
  ontime.runtime.advance(58_000 + 25_000 - 54_999 - 1);
  await settle();
  expect(ontime.runtime.exits).toEqual([]);
  expect(ontime.wire.closed).toBe(false);
  ontime.runtime.advance(1);
  await settle();
  expect(ontime.runtime.exits).toEqual([AGENT_EXIT.lease_expired]);
});

test("스스로 집행: 여유 전에 받은 count의 0이 집행 시각 뒤에 돌아오면 counted를 보내지 않고 lease_expired로 끝난다", async () => {
  let release: (() => void) | null = null;
  class HeldSpace extends FakeSpace {
    hold = false;
    override survivors(): Promise<number | null> {
      if (!this.hold) return super.survivors();
      this.countCalls++;
      return new Promise((resolve) => (release = () => resolve(0)));
    }
  }
  const space = new HeldSpace();
  const { role, launcher, wire, runtime } = await agent({}, { record: async () => space });
  role.receive(startBytes({ lease_until: T0 + 30_000, deadline_at: T0 + 60_000 }));
  await settle();
  launcher.finish(0, new Uint8Array());
  await settle();
  role.receive(terminate(1));
  await settle();
  runtime.advance(54_999);
  space.hold = true;
  role.receive(count(2));
  await settle();
  const before = wire.written.length;
  // 집행 시각(55초)을 지난 뒤 계수가 0으로 돌아온다. 만료 콜백은 그다음 차례다.
  runtime.t = T0 + 55_001;
  release!();
  await settle();
  expect(wire.written.length === before).toBe(true);
  expect(wire.closed).toBe(true);
  expect(runtime.exits).toEqual([AGENT_EXIT.lease_expired]);
  runtime.advance(0);
  await settle();
  expect(runtime.exits).toEqual([AGENT_EXIT.lease_expired]);
});

test("차례: attach 전에 받은 바이트는 디코딩·띄우기 없이 protocol로 끝난다", async () => {
  const runtime = new FakeRuntime();
  const space = new FakeSpace();
  const launcher = new FakeLauncher();
  const role = (await RoleAgent.prepare(runtime, { selfPid: 1, harden: () => true, record: async () => space, launcher }))!;
  const bytes = startBytes();
  const taken: boolean[] = [];
  const original = Uint8Array.prototype.fill;
  // 값 틀을 꺼냈다면 대리나 디코더가 값 배열을 0으로 채운다. 디코딩하지 않았으면 그런 채움이 없다.
  Uint8Array.prototype.fill = function (this: Uint8Array, ...args: Parameters<Uint8Array["fill"]>) {
    if (this.length === secretBytes().length && new TextDecoder().decode(this) === SECRET) taken.push(true);
    return original.apply(this, args);
  };
  try {
    role.receive(bytes);
  } finally {
    Uint8Array.prototype.fill = original;
  }
  await settle();
  expect(launcher.calls).toHaveLength(0);
  expect(taken.length === 0).toBe(true);
  expect(runtime.exits).toEqual([AGENT_EXIT.protocol]);
  // 집행 뒤에 이어진 링크에는 아무 말도 하지 않는다.
  const wire = new Wire();
  role.attach(wire);
  expect(wire.written.length === 0).toBe(true);
});

test("차례: 열린 실행이 없을 때의 terminate·count는 공간 전체의 정리·세기로 답하고 띄우지 않는다(agent.md 표의 조건)", async () => {
  const { role, launcher, space, wire, runtime } = await agent();
  role.receive(terminate(1));
  role.receive(count(2));
  await settle();
  expect(wire.messages()).toEqual([{ type: "hello" }, { type: "terminated", seq: 1 }, { type: "counted", seq: 2, survivors: 0 }]);
  expect(space.terminations).toBe(1);
  expect(launcher.calls).toHaveLength(0);
  expect(runtime.exits).toEqual([]);
});

test("차례: terminate·count가 함께 쓰는 seq가 같거나 줄면 효과 전에 protocol로 끝난다", async () => {
  for (const [first, second] of [
    [count(7), terminate(7)],
    [terminate(3), count(2)],
    [count(4), count(4)],
  ] as const) {
    const { role, space, wire, runtime } = await agent();
    role.receive(first);
    await settle();
    const terminations = space.terminations;
    const written = wire.written.length;
    role.receive(second);
    await settle();
    expect(runtime.exits).toEqual([AGENT_EXIT.protocol]);
    expect(wire.closed).toBe(true);
    // 두 번째 요청의 답은 없고, 정리는 집행의 한 번만 더 돈다.
    expect(wire.written.length === written).toBe(true);
    expect(space.terminations === terminations + 1).toBe(true);
  }
});

test("스스로 집행: 두 번째 attach의 닫기가 던져도 예외를 내보내지 않고 첫 실행을 protocol로 집행한다", async () => {
  const { role, launcher, space, wire, runtime } = await agent();
  role.receive(startBytes());
  await settle();
  launcher.calls[0]!.hooks.spawned({ pid: 7, exited: new Promise(() => {}), signal: () => {} });
  let thrown = false;
  try {
    role.attach({
      write() {},
      close() {
        throw new Error("close failed");
      },
    });
  } catch {
    thrown = true;
  }
  await settle();
  expect(thrown).toBe(false);
  expect(wire.closed).toBe(true);
  expect(launcher.calls[0]!.signal.aborted).toBe(true);
  expect(space.terminations).toBe(1);
  expect(runtime.exits).toEqual([AGENT_EXIT.protocol]);
});

test("스스로 집행: 정리가 끝나지 않아도 상한 뒤에는 끝난다(PID 1의 끝이 나머지를 끝낸다)", async () => {
  const { role, space, runtime } = await agent({ enforceWaitMs: 500 });
  space.hangTerminate = true;
  role.linkClosed();
  await settle();
  expect(runtime.exits).toEqual([]);
  runtime.advance(500);
  expect(runtime.exits).toEqual([AGENT_EXIT.link_closed]);
});

test("자격: 값 틀이 start의 지문과 다르면 띄우지 않고 protocol로 끝난다. 쓴 값의 바이트는 0으로 채운다", async () => {
  const { role, launcher, runtime } = await agent();
  const head = startBytes().subarray(0, startBytes().length - (4 + 100 + secretBytes().length));
  const other = encodeCredentialFrame(RUN, SECRET_DIGEST, new TextEncoder().encode("another-value"));
  if (!other.ok) throw new Error("encode");
  role.receive(new Uint8Array([...head, ...other.frame]));
  await settle();
  expect(launcher.calls).toHaveLength(0);
  expect(runtime.exits).toEqual([AGENT_EXIT.protocol]);

  // 정상 start에서 대리가 쓴 값 배열은 계획을 만든 뒤 0으로 채워진다.
  const ok = await agent();
  const filled: Uint8Array[] = [];
  const original = Uint8Array.prototype.fill;
  Uint8Array.prototype.fill = function (this: Uint8Array, ...args: Parameters<Uint8Array["fill"]>) {
    if (this.length === secretBytes().length && new TextDecoder().decode(this) === SECRET) filled.push(this);
    return original.apply(this, args);
  };
  try {
    ok.role.receive(startBytes());
  } finally {
    Uint8Array.prototype.fill = original;
  }
  await settle();
  expect(ok.launcher.calls).toHaveLength(1);
  expect(filled.length).toBeGreaterThan(0);
  expect(filled.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
});
