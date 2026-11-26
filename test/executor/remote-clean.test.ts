// 정리 확인(O13-a, D-146·D-153·D-154): 확정(result_finalize)을 받은 실행의 정리 영수증은 대리가 작업 공간을 비우고 센 답(cleaned)의 0으로만 낸다.
// 시험이 대리 자리에서 링크의 말을 직접 정하고, 감독 자리에서 확정과 그 재전송을 보내 worker 전체를 지난다.
import { expect, test } from "bun:test";
import { type AgentMessage, ControlDecoder, encodeAgent, type ReceivedControl } from "../../src/agent/link.ts";
import { createCredentialInbox } from "../../src/executor/credential-inbox.ts";
import type { AgentLinkSession, RemoteAgent } from "../../src/executor/remote-agent.ts";
import { fromSupervisor, type Rig, reconnect, rig, sha256, start, until } from "./support.ts";

// 대리 자리. 끝내기·세기에는 같은 호출 안에서 답한다(남은 0). clean에는 left로 답하고, undefined면 답하지 않는다(시험이 reply로 낸다).
class CleanAgent {
  session: AgentLinkSession | null = null;
  closed = false;
  readonly got: ReceivedControl[] = [];
  left: number | null | undefined = 0;
  private readonly decoder = new ControlDecoder();

  attach(remote: RemoteAgent): void {
    this.session = remote.connect({
      write: (bytes) => {
        if (this.closed) throw new Error("closed");
        for (const message of this.decoder.push(new Uint8Array(bytes))) this.handle(message);
      },
      close: () => {
        this.closed = true;
      },
    });
    this.say({ type: "hello" });
  }

  private handle(message: ReceivedControl): void {
    if (message.type === "start") message.credential.discard();
    this.got.push(message);
    if (message.type === "terminate") this.say({ type: "terminated", seq: message.seq });
    if (message.type === "count") this.say({ type: "counted", seq: message.seq, survivors: 0 });
    if (message.type === "clean" && this.left !== undefined) this.say({ type: "cleaned", seq: message.seq, left: this.left });
  }

  say(message: AgentMessage): void {
    this.session?.receive(encodeAgent(message));
  }

  cleans(): Extract<ReceivedControl, { type: "clean" }>[] {
    return this.got.filter((message): message is Extract<ReceivedControl, { type: "clean" }> => message.type === "clean");
  }

  reply(left: number | null): void {
    this.say({ type: "cleaned", seq: this.cleans().at(-1)!.seq, left });
  }
}

// replyWaitMs = exitWaitMs = 100ms(실제 타이머).
async function make(agent: CleanAgent): Promise<Rig> {
  return rig({ exitWaitMs: 100, remote: { attach: (remote) => agent.attach(remote) } });
}

const result = new TextEncoder().encode(JSON.stringify({ role: "diagnosis", outcome: "completed", summary: "끝", items: [], refs: [] }));

// 띄우고 끝난 실행을 남은 0으로 맺는다(ready_result). 원격 단계는 대기로 돌아온다.
async function finishedRun(r: Rig, agent: CleanAgent): Promise<string> {
  const { runId } = await start(r);
  await until(() => agent.got.some((message) => message.type === "start"));
  agent.say({ type: "spawned", run_id: runId });
  agent.say({ type: "output", run_id: runId, data: Buffer.from(result).toString("base64") });
  agent.say({ type: "exited", run_id: runId, code: 0, signal: null, overflow: false, stdout_bytes: result.length });
  await r.worker.idle();
  expect(r.store.run(runId)?.state).toBe("ready_result");
  expect(r.remote!.state().phase).toBe("idle");
  return runId;
}

// 감독의 확정. 재전송은 같은 요청 ID·같은 본문을 새 봉투(새 nonce)에 담는다.
function finalizer(r: Rig, runId: string) {
  const requestId = crypto.randomUUID();
  const storedAt = r.clock.now();
  return () =>
    fromSupervisor(r.clock, r.worker.name, "result_finalize", { run_id: runId, outcome: "failed", result_digest: null, stored_at: storedAt }, {
      stop_generation: 0,
      run_generation: 1,
      request_id: requestId,
    });
}

const stateOf = (r: Rig, runId: string) => r.store.run(runId)?.state;

test("원격 정리 확인: 확정을 받으면 대리에게 clean을 묻고, 기한 안에 남은 항목 0을 들으면 receipt_cleaned를 내고 finalized다", async () => {
  const agent = new CleanAgent();
  const r = await make(agent);
  const runId = await finishedRun(r, agent);
  await r.connection.receive(finalizer(r, runId)());
  expect(agent.got.map((message) => message.type)).toEqual(["start", "terminate", "count", "clean"]);
  expect(stateOf(r, runId)).toBe("finalized");
  expect(r.transport.of("receipt_cleaned")).toHaveLength(1);
  // 제어 쪽 공간(inner)도 지나간다.
  expect(r.space.cleaned).toEqual([runId]);
});

test("원격 정리 남음·모름: left가 0이 아니거나 null이면 영수증 없이 cleanup_pending이고, 확정 재전송이 다시 물어 0이면 처음 의도의 영수증 ID로 finalized다", async () => {
  const agent = new CleanAgent();
  const r = await make(agent);
  const runId = await finishedRun(r, agent);
  const finalize = finalizer(r, runId);
  agent.left = 2;
  await r.connection.receive(finalize());
  expect(stateOf(r, runId)).toBe("cleanup_pending");
  const receiptId = r.store.run(runId)!.cleanup!.receipt_id;
  agent.left = null;
  await r.connection.receive(finalize());
  expect(stateOf(r, runId)).toBe("cleanup_pending");
  expect(r.transport.of("receipt_cleaned")).toHaveLength(0);
  agent.left = 0;
  await r.connection.receive(finalize());
  expect(agent.cleans()).toHaveLength(3);
  expect(stateOf(r, runId)).toBe("finalized");
  expect(r.transport.of("receipt_cleaned").map((envelope) => envelope.body)).toMatchObject([{ receipt_id: receiptId, run_id: runId }]);
});

test("원격 정리 시간 초과: 기한 안에 답이 없으면 cleanup_pending이고 늦은 0은 쓰지 않는다. 답을 기다리는 동안은 다시 묻지 않고, 늦은 답 뒤의 재전송이 새로 묻는다", async () => {
  const agent = new CleanAgent();
  const r = await make(agent);
  const runId = await finishedRun(r, agent);
  const finalize = finalizer(r, runId);
  agent.left = undefined;
  await r.connection.receive(finalize());
  expect(agent.cleans()).toHaveLength(1);
  expect(stateOf(r, runId)).toBe("cleanup_pending");
  // 앞 clean의 답이 아직 오는 중이다. 새로 보내지 않는다.
  await r.connection.receive(finalize());
  expect(agent.cleans()).toHaveLength(1);
  // 기한 뒤의 0은 요청만 놓는다.
  agent.reply(0);
  expect(stateOf(r, runId)).toBe("cleanup_pending");
  expect(r.transport.of("receipt_cleaned")).toHaveLength(0);
  agent.left = 0;
  await r.connection.receive(finalize());
  expect(agent.cleans()).toHaveLength(2);
  expect(stateOf(r, runId)).toBe("finalized");
  expect(r.remote!.state().distrusted).toBeNull();
});

test("원격 정리 끊김: 답을 기다리는 사이 링크가 끊기면 cleanup_pending이고(쉬는 동안의 끊김이라 잠그지 않는다), 새 대리의 0으로 재전송 때 finalized다", async () => {
  const agent = new CleanAgent();
  const r = await make(agent);
  const runId = await finishedRun(r, agent);
  const finalize = finalizer(r, runId);
  agent.left = undefined;
  const handling = r.connection.receive(finalize());
  await until(() => agent.cleans().length === 1);
  agent.session!.closed();
  await handling;
  expect(stateOf(r, runId)).toBe("cleanup_pending");
  expect(r.remote!.state()).toMatchObject({ connected: false, distrusted: null, phase: "idle" });
  const next = new CleanAgent();
  next.attach(r.remote!);
  await r.connection.receive(finalize());
  expect(next.cleans()).toHaveLength(1);
  expect(stateOf(r, runId)).toBe("finalized");
  expect(r.transport.of("receipt_cleaned")).toHaveLength(1);
});

test("원격 정리 연결 교체: 대리의 답을 기다리는 사이 감독 연결이 바뀌면 그 0으로 첫 영수증을 기록하지 않고(의도·cleanup_pending 보존), 새 연결의 확정 재전송 뒤에만 처음 의도의 영수증 ID로 낸다", async () => {
  const agent = new CleanAgent();
  // 연결을 바꾸는 동안 대리 답의 기한(replyWaitMs)이 지나지 않게 넉넉히 둔다.
  const r = await rig({ exitWaitMs: 5_000, remote: { attach: (remote) => agent.attach(remote) } });
  const runId = await finishedRun(r, agent);
  const finalize = finalizer(r, runId);
  agent.left = undefined;
  const handling = r.connection.receive(finalize());
  await until(() => agent.cleans().length === 1);
  const intent = r.store.run(runId)!.cleanup!;
  await reconnect(r, 0);
  // 확정을 보낸 연결은 끝났다. 대리는 제때 0을 답한다.
  agent.reply(0);
  await handling;
  await r.worker.idle();
  expect(stateOf(r, runId)).toBe("cleanup_pending");
  expect(r.store.run(runId)!.cleanup).toEqual(intent);
  expect(r.store.outboxFor(runId).filter((entry) => entry.action === "receipt_cleaned")).toHaveLength(0);
  expect(r.transport.of("receipt_cleaned")).toHaveLength(0);
  // 지금 연결의 재전송이 다시 지우고 확인한 뒤에야 낸다.
  agent.left = 0;
  await r.connection.receive(finalize());
  expect(agent.cleans()).toHaveLength(2);
  expect(stateOf(r, runId)).toBe("finalized");
  expect(r.transport.of("receipt_cleaned").map((envelope) => envelope.body)).toMatchObject([{ receipt_id: intent.receipt_id, run_id: runId }]);
});

test("원격 정리: 시작 응답을 기다리는 중(실행 중 단계)에는 대리에게 묻지 않고 false다", async () => {
  const agent = new CleanAgent();
  const r = await make(agent);
  const { runId } = await start(r);
  await until(() => agent.got.some((message) => message.type === "start"));
  expect(r.remote!.state().phase).toBe("starting");
  const space = r.remote!.space({ prepare: async () => {}, clean: async () => true });
  expect(await space.clean(runId)).toBe(false);
  expect(agent.cleans()).toHaveLength(0);
});

test("정리 영수증 직전에 우편함이 그 실행의 값을 0으로 채운다(D-153 셋째): 실행이 끝난 뒤 다시 온 그 실행의 값 틀도 남지 않는다", async () => {
  const agent = new CleanAgent();
  const r = await make(agent);
  const runId = await finishedRun(r, agent);
  // 재시작한 프로세스의 우편함처럼 그 실행을 모르는 우편함에 같은 실행의 값이 다시 왔다.
  const inbox = createCredentialInbox({ epoch: () => 1 });
  const value = new TextEncoder().encode("late-credential-for-this-run");
  expect(inbox.offer(1, { runId, digest: sha256(value), value })).toBe("held");
  const receiptsAtForget: number[] = [];
  r.credentials.forget = (id: string) => {
    receiptsAtForget.push(r.transport.of("receipt_cleaned").length);
    inbox.forget(id);
  };
  await r.connection.receive(finalizer(r, runId)());
  expect(stateOf(r, runId)).toBe("finalized");
  expect(value.every((byte) => byte === 0)).toBe(true);
  // 영수증보다 먼저 부른다.
  expect(receiptsAtForget).toEqual([0]);
});
