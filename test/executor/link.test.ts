// 연결 하나의 수명 시험: 맞춤은 연결마다 한 번 hello보다 먼저, 기한이 되면 challenge를 버림, 새 연결은 앞 연결의 대기값·늦은 결과를 버림.
import { expect, test } from "bun:test";
import { limits } from "../../src/contract/v1/index.ts";
import { FakeTransport, fromSupervisor, rig, start, syncReply } from "./support.ts";

test("맞춤: 연결마다 한 번, hello보다 먼저 보낸다. challenge는 16바이트 소문자 16진이고 sentAt은 실은 시각이다", async () => {
  const r = await rig({ syncTo: null });
  expect(r.transport.actions()).toEqual(["stop_sync_request"]);
  const request = r.transport.sent[0]!;
  expect(request.header.stop_generation).toBe(0);
  expect(r.connection.pending()).toEqual({ challenge: (request.body as { challenge: string }).challenge, sentAt: r.clock.now() });
  // 맞춤 전의 다른 메시지는 처리하지 않는다(hello도 보내지 않는다).
  await r.connection.receive(fromSupervisor(r.clock, r.worker.name, "status_query", { run_ids: ["00000000-0000-4000-8000-000000000001"] }, { stop_generation: 0 }));
  expect(r.transport.actions()).toEqual(["stop_sync_request"]);
  await r.connection.receive(syncReply(r, 2));
  expect(r.transport.actions()).toEqual(["stop_sync_request", "hello"]);
  expect(r.transport.of("hello")[0]!.header.stop_generation).toBe(2);
  expect(r.connection.pending()).toBeNull();
  // 같은 연결의 두 번째 맞춤 답은 처리하지 않는다.
  await r.connection.receive(syncReply(r, 3, (request.body as { challenge: string }).challenge));
  expect(r.store.stopGeneration()).toBe(2);
  expect(r.transport.actions()).toEqual(["stop_sync_request", "hello"]);

  // 기본 challenge는 암호학적 난수 16바이트이고 연결마다 다르다.
  const { ExecutorLink } = await import("../../src/executor/link.ts");
  const real = new ExecutorLink(r.worker, { now: r.clock.now });
  const a = new FakeTransport();
  const b = new FakeTransport();
  real.open(a);
  real.open(b);
  const ca = (a.sent[0]!.body as { challenge: string }).challenge;
  const cb = (b.sent[0]!.body as { challenge: string }).challenge;
  expect(ca).toMatch(/^[0-9a-f]{32}$/);
  expect(ca).not.toBe(cb);
});

test("맞춤: 기한(25초)이 되면 challenge를 버리고 연결을 닫는다. 그 뒤의 답은 거절된다", async () => {
  const control = await rig({ syncTo: null });
  control.clock.advance(limits.STOP_SYNC_WAIT_MS - 1);
  control.link.tick();
  await control.connection.receive(syncReply(control, 1));
  expect(control.link.live()).toBe(true);

  const r = await rig({ syncTo: null });
  const challenge = r.connection.pending()!.challenge;
  r.clock.advance(limits.STOP_SYNC_WAIT_MS);
  r.link.tick();
  expect(r.connection.pending()).toBeNull();
  expect(r.transport.closed).toBe(true);
  await r.connection.receive(syncReply(r, 1, challenge));
  expect(r.link.live()).toBe(false);
  expect(r.store.stopGeneration()).toBeNull();

  // tick이 없어도 받는 순간 기한을 본다.
  const lazy = await rig({ syncTo: null });
  const lazyChallenge = lazy.connection.pending()!.challenge;
  lazy.clock.advance(limits.STOP_SYNC_WAIT_MS);
  await lazy.connection.receive(syncReply(lazy, 1, lazyChallenge));
  expect(lazy.link.live()).toBe(false);
  expect(lazy.store.stopGeneration()).toBeNull();
});

test("맞춤: 새 연결이 열리면 앞 연결의 대기값과 늦게 끝난 처리 결과를 버린다", async () => {
  // 앞 연결의 challenge를 담은 답은 새 연결에서 받지 않는다.
  const r = await rig({ syncTo: null });
  const old = r.connection;
  const oldChallenge = old.pending()!.challenge;
  const next = r.link.open(new FakeTransport());
  expect(old.pending()).toBeNull();
  await old.receive(syncReply(r, 1, oldChallenge));
  await next.receive(syncReply(r, 1, oldChallenge));
  expect(r.link.live()).toBe(false);
  expect(r.store.stopGeneration()).toBeNull();

  // 검증이 끝나기 전에 새 연결이 열렸다: 앞 연결의 맞춤 결과를 쓰지 않는다.
  const s = await rig({ syncTo: null });
  const slow = s.connection.receive(syncReply(s, 4));
  const fresh = s.link.open(new FakeTransport());
  await slow;
  expect(s.link.live()).toBe(false);
  expect(fresh.state).toBe("syncing");

  // 맞춘 연결에서 받은 시작 지시의 검증이 끝나기 전에 새 연결이 열렸다: 실행 0.
  const t = await rig();
  const pendingStart = start(t);
  t.link.open(new FakeTransport());
  await pendingStart;
  await t.worker.idle();
  expect(t.launcher.spawned).toBe(0);
  expect(t.store.runs()).toHaveLength(0);
});

test("맞춤: 맞춘 세대를 저장하지 못하면 그 연결로 일하지 않고 닫는다", async () => {
  const r = await rig({
    syncTo: null,
    io: {
      writeDurable: async () => {
        throw new Error("disk");
      },
    },
  });
  await r.connection.receive(syncReply(r, 3));
  expect(r.link.live()).toBe(false);
  expect(r.transport.closed).toBe(true);
  expect(r.transport.actions()).toEqual(["stop_sync_request"]);
  expect(r.worker.intakeClosed()).toBe("stop_generation_unsaved");
});
