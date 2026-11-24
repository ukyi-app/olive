// 역할 컨테이너의 PID 1로 도는 대리의 진입점. 환경에서 링크 소켓 경로 하나만 읽고, 대리 핵심(src/agent/)을 실제 시계·타이머·끝내기로 띄운다.
// 환경 읽기는 이 파일과 executor.ts에만 둔다. 대리는 듣지 않고 제어가 듣는 경로 유닉스 소켓에 붙는다(반대 방향은 같은 uid의 모델이
// 바꿔치기할 수 있다, agent.md).
//
// 차례: RoleAgent.prepare(non-dumpable → PID 1 → 정리 코어 기록) → 제어 소켓에 붙음 → attach(hello).
// - prepare가 소켓보다 먼저다. 그 앞에 연 것이 없어야 /proc/1을 읽을 틈과 기준 스캔 밖의 자원이 없다. 실패하면 78~80으로 끝난다
//   (상한 정각 이후에 정해진 실패는 82).
// - 제어는 저장소·기동 대조를 마친 뒤에 듣기 시작하므로 처음에는 소켓이 없을 수 있다. 간격(retryMs)을 두고 다시 붙되 상한(connectWaitMs)을
//   넘기면 82로 끝난다. 그동안 띄운 것이 없어 끝나도 잃을 것이 없다. 경과는 단조 시계(monoNow)로 재고, 다시 붙기 직전·붙기가 끝난 때·
//   붙는 중의 기다림 모두에 상한을 건다. prepare와 붙기의 결과는 받아들이는 때의 시각으로 판정한다(untilLimit): 정각 이후면 상한 타이머보다
//   먼저 처리돼도 만료다. 상한 뒤에 늦게 돌아온 연결은 hello 없이 닫는다. runtime.now는 벽시계라 이 상한에 쓰지 않는다.
// - 붙은 뒤 소켓이 닫히거나 오류가 나면 linkClosed()다(대리가 실행을 멈추고 75로 끝난다). runtime.exit은 실제로 프로세스를 끝낸다.
import { type AgentParts, type AgentRuntime, type AgentTransport, productionParts, RoleAgent } from "../agent/agent.ts";

export const ROLE_AGENT_ENV = ["OLIVE_AGENT_SOCKET"] as const;

// 75~80은 대리 핵심(AGENT_EXIT)이 쓴다.
export const ROLE_AGENT_EXIT = {
  // 환경이 없거나 꼴이 틀렸다.
  config: 81,
  // 상한 안에 제어의 소켓에 붙지 못했다.
  unreachable: 82,
} as const;

// 다 못 쓴 바이트를 쥐는 상한. 대리의 말은 작고(봉투 64KiB 이하) 제어가 읽지 않으면 그 링크는 이미 이상하다. 넘으면 링크 끊김으로 다룬다.
const PENDING_MAX_BYTES = 1024 * 1024;

// 붙은 소켓 하나의 쓰기와 닫기. write는 쓴 바이트 수를 돌려주고(다 못 쓸 수 있다) 음수면 실패다.
export interface AgentSocketPort {
  write(bytes: Uint8Array): number;
  end(): void;
}

export interface AgentSocketHandlers {
  data(chunk: Uint8Array): void;
  drain(): void;
  // 붙은 뒤의 닫힘·오류.
  close(): void;
}

// 경로 유닉스 소켓에 붙는다. 붙지 못하면 거절한다. 시험이 바꿔 넣는 자리다.
export type ConnectAgentSocket = (path: string, handlers: AgentSocketHandlers) => Promise<AgentSocketPort>;

export interface RoleAgentEntryOptions {
  readonly socketPath: string;
  readonly runtime: AgentRuntime;
  readonly parts: AgentParts;
  readonly connect: ConnectAgentSocket;
  readonly connectWaitMs: number;
  readonly retryMs: number;
  // 붙기 상한을 재는 단조 시계(ms). runtime.setTimer와 같은 시간 기준이어야 한다.
  readonly monoNow: () => number;
}

// 다 못 쓴 나머지를 사본으로 쥐었다가 drain에서 이어 쓴다. 쓰기 실패와 상한 초과는 던져 대리가 링크 끊김으로 다루게 한다.
function bufferedTransport(port: AgentSocketPort): AgentTransport & { flush(): void } {
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let closed = false;
  const writeOnce = (bytes: Uint8Array): Uint8Array | null => {
    const wrote = port.write(bytes);
    if (wrote < 0) throw new Error("write_failed");
    return wrote < bytes.length ? bytes.subarray(wrote) : null;
  };
  return {
    write(bytes) {
      if (closed) throw new Error("closed");
      const rest = pending.length === 0 ? writeOnce(bytes) : bytes;
      if (rest === null) return;
      if (pendingBytes + rest.length > PENDING_MAX_BYTES) throw new Error("backlog");
      pending.push(rest.slice());
      pendingBytes += rest.length;
    },
    close() {
      closed = true;
      pending = [];
      pendingBytes = 0;
      port.end();
    },
    flush() {
      while (!closed && pending.length > 0) {
        const head = pending[0]!;
        const rest = writeOnce(head);
        if (rest !== null) {
          pending[0] = rest.slice();
          pendingBytes -= head.length - rest.length;
          return;
        }
        pending.shift();
        pendingBytes -= head.length;
      }
    },
  };
}

type Waited<T> = { readonly kind: "done"; readonly value: T } | { readonly kind: "failed"; readonly error: unknown } | { readonly kind: "lapsed" };

// 기한(limit, 단조 시계)이 있는 기다림 하나. 판정은 시각이 한다: 결과(성공·거절)를 받아들이는 때 정각 이후면 콜백 차례와 상관없이 lapsed다.
// 타이머는 깨우는 수단이라 정각 전에 불리면 시각을 다시 보고 남은 시간으로 다시 건다(올림, 최소 1ms).
function untilLimit<T>(work: Promise<T>, limit: number, options: Pick<RoleAgentEntryOptions, "monoNow" | "runtime">): Promise<Waited<T>> {
  return new Promise((resolve) => {
    let ended = false;
    let cancel: () => void = () => {};
    const end = (outcome: Waited<T>) => {
      if (ended) return;
      ended = true;
      cancel();
      resolve(outcome);
    };
    const accept = (outcome: Waited<T>) => end(options.monoNow() >= limit ? { kind: "lapsed" } : outcome);
    const arm = () => {
      cancel = options.runtime.setTimer(Math.max(1, Math.ceil(limit - options.monoNow())), () => (options.monoNow() >= limit ? end({ kind: "lapsed" }) : arm()));
    };
    work.then(
      (value) => accept({ kind: "done", value }),
      (error: unknown) => accept({ kind: "failed", error }),
    );
    arm();
  });
}

// prepare → 붙기 → attach. 붙어서 hello를 보냈으면 그 대리를, 끝내는 길이면(runtime.exit을 부른 뒤) null을 돌려준다.
export async function runRoleAgent(options: RoleAgentEntryOptions): Promise<RoleAgent | null> {
  const { runtime } = options;
  // 붙기 상한은 prepare 전부터 잰다. 정리 코어 기록(prepare)이 돌아오지 않으면 hello도 종료도 없는 대리가 남아, 제어는 86으로 다시 뜨기를
  // 거듭하고 역할 컨테이너는 그대로 멈춰 있게 된다.
  const limit = options.monoNow() + options.connectWaitMs;
  // prepare 동안의 종료 코드는 이 한 자리에서 고른다. prepare는 실패하면(78~80) 받은 runtime의 exit을 안에서 바로 부르므로 그 exit을 감싸
  // 받는다. 정각 이후에 정해진 종료는 실패여도 82다: 기한이 먼저 지났는데 정리 코어 기록 실패(80)로 알리면 관리자가 엉뚱한 원인을 찾는다.
  // 한 번 정한 뒤 늦게 온 종료(상한의 82 뒤에 끝난 기록 실패)는 버린다. prepare를 마친 대리의 종료(75~77)는 그대로 넘긴다.
  let preparing = true;
  let decided = false;
  const finishPrepare = (code: number): null => {
    if (!decided) {
      decided = true;
      runtime.exit(options.monoNow() >= limit ? ROLE_AGENT_EXIT.unreachable : code);
    }
    return null;
  };
  const agentRuntime: AgentRuntime = {
    now: () => runtime.now(),
    setTimer: (ms, fire) => runtime.setTimer(ms, fire),
    exit: (code) => (preparing ? void finishPrepare(code) : runtime.exit(code)),
  };
  const prepared = await untilLimit(RoleAgent.prepare(agentRuntime, options.parts), limit, options);
  if (prepared.kind === "lapsed") return finishPrepare(ROLE_AGENT_EXIT.unreachable);
  if (prepared.kind === "failed") throw prepared.error;
  const agent = prepared.value;
  // null이면 prepare가 실패해 위 finishPrepare로 이미 끝냈다.
  if (agent === null) return null;
  preparing = false;
  let transport: ReturnType<typeof bufferedTransport> | null = null;
  // 상한을 넘겨 버린 연결. 그 연결의 받은 바이트·닫힘은 대리에 넘기지 않는다(늦게 열린 연결을 닫을 때의 닫힘이 linkClosed가 되지 않게).
  let abandoned = false;
  const handlers: AgentSocketHandlers = {
    data: (chunk) => {
      if (!abandoned) agent.receive(chunk);
      // 제어가 보낸 바이트에는 자격 값 틀이 있다. 디코더가 사본을 쥐었으므로 받은 조각은 바로 0으로 채운다.
      chunk.fill(0);
    },
    drain: () => {
      if (abandoned) return;
      try {
        transport?.flush();
      } catch {
        agent.linkClosed();
      }
    },
    close: () => {
      if (!abandoned) agent.linkClosed();
    },
  };
  const unreachable = (): null => {
    runtime.exit(ROLE_AGENT_EXIT.unreachable);
    return null;
  };
  for (;;) {
    if (options.monoNow() >= limit) return unreachable();
    let attempt: Promise<AgentSocketPort>;
    try {
      attempt = options.connect(options.socketPath, handlers);
    } catch (error) {
      attempt = Promise.reject(error);
    }
    const outcome = await untilLimit(attempt, limit, options);
    if (outcome.kind === "done") {
      transport = bufferedTransport(outcome.value);
      break;
    }
    if (outcome.kind === "lapsed") {
      // 상한을 넘겼다. 늦게 돌아온(또는 앞으로 돌아올) 연결은 쓰지 않고 닫는다.
      abandoned = true;
      void attempt.then(
        (port) => port.end(),
        () => {},
      );
      return unreachable();
    }
    if (options.monoNow() + options.retryMs > limit) return unreachable();
    await new Promise<void>((resolve) => runtime.setTimer(options.retryMs, resolve));
  }
  agent.attach(transport);
  return agent;
}

// 실제 Bun 경로 유닉스 소켓. 붙기 전의 닫힘·오류는 거절로만 알리고(다시 붙는다) 대리에게 넘기지 않는다.
export const connectUnix: ConnectAgentSocket = async (path, handlers) => {
  let opened = false;
  const socket = await Bun.connect<undefined>({
    unix: path,
    socket: {
      open: () => {
        opened = true;
      },
      data: (_socket, chunk) => handlers.data(chunk),
      drain: () => handlers.drain(),
      close: () => {
        if (opened) handlers.close();
      },
      error: () => {
        if (opened) handlers.close();
      },
    },
  });
  return { write: (bytes) => socket.write(bytes), end: () => socket.end() };
};

async function main(): Promise<void> {
  const socketPath = process.env.OLIVE_AGENT_SOCKET ?? "";
  if (!socketPath.startsWith("/") || socketPath.includes("\0")) {
    console.error(`olive role-agent: 환경 OLIVE_AGENT_SOCKET이(가) ${socketPath === "" ? "없다" : "틀렸다"}`);
    process.exit(ROLE_AGENT_EXIT.config);
  }
  const runtime: AgentRuntime = {
    // 벽시계여야 한다: 대리는 이 값을 start의 deadline_at·lease_until(에포크 밀리초)과 바로 견준다.
    now: Date.now,
    setTimer: (ms, fire) => {
      const handle = setTimeout(fire, ms);
      return () => clearTimeout(handle);
    },
    exit: (code) => process.exit(code),
  };
  await runRoleAgent({ socketPath, runtime, parts: productionParts(), connect: connectUnix, connectWaitMs: 60_000, retryMs: 500, monoNow: () => performance.now() });
}

if (import.meta.main) await main();
