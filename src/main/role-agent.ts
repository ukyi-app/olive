// 역할 컨테이너의 PID 1로 도는 대리의 진입점. 환경에서 링크 소켓 경로 하나만 읽고, 대리 핵심(src/agent/)을 실제 시계·타이머·끝내기로 띄운다.
// 환경 읽기는 이 파일과 executor.ts에만 둔다. 대리는 듣지 않고 제어가 듣는 경로 유닉스 소켓에 붙는다(반대 방향은 같은 uid의 모델이
// 바꿔치기할 수 있다, agent.md).
//
// 차례: RoleAgent.prepare(non-dumpable → PID 1 → 정리 코어 기록) → 제어 소켓에 붙음 → attach(hello).
// - prepare가 소켓보다 먼저다. 그 앞에 연 것이 없어야 /proc/1을 읽을 틈과 기준 스캔 밖의 자원이 없다. 실패하면 prepare가 78~80으로 끝낸다.
// - 제어는 저장소·기동 대조를 마친 뒤에 듣기 시작하므로 처음에는 소켓이 없을 수 있다. 간격(retryMs)을 두고 다시 붙되 상한(connectWaitMs)을
//   넘기면 82로 끝난다. 그동안 띄운 것이 없어 끝나도 잃을 것이 없다.
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

// prepare → 붙기 → attach. 붙어서 hello를 보냈으면 그 대리를, 끝내는 길이면(runtime.exit을 부른 뒤) null을 돌려준다.
export async function runRoleAgent(options: RoleAgentEntryOptions): Promise<RoleAgent | null> {
  const { runtime } = options;
  const agent = await RoleAgent.prepare(runtime, options.parts);
  if (agent === null) return null;
  let transport: ReturnType<typeof bufferedTransport> | null = null;
  const handlers: AgentSocketHandlers = {
    data: (chunk) => {
      agent.receive(chunk);
      // 제어가 보낸 바이트에는 자격 값 틀이 있다. 디코더가 사본을 쥐었으므로 받은 조각은 바로 0으로 채운다.
      chunk.fill(0);
    },
    drain: () => {
      try {
        transport?.flush();
      } catch {
        agent.linkClosed();
      }
    },
    close: () => agent.linkClosed(),
  };
  const limit = runtime.now() + options.connectWaitMs;
  for (;;) {
    try {
      transport = bufferedTransport(await options.connect(options.socketPath, handlers));
      break;
    } catch {
      if (runtime.now() + options.retryMs > limit) {
        runtime.exit(ROLE_AGENT_EXIT.unreachable);
        return null;
      }
      await new Promise<void>((resolve) => runtime.setTimer(options.retryMs, resolve));
    }
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
  await runRoleAgent({ socketPath, runtime, parts: productionParts(), connect: connectUnix, connectWaitMs: 60_000, retryMs: 500 });
}

if (import.meta.main) await main();
