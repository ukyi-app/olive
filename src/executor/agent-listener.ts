// 실행기가 듣는 단 하나의 자리: 공유 폴더의 경로 유닉스 소켓 하나에 역할 컨테이너의 대리가 붙는다(D-102). 실행기의 다른 연결은 모두 나가는 쪽이다.
// TCP·abstract 소켓은 쓰지 않는다. 경로는 "/"로 시작해야 하고 NUL을 담지 못한다(abstract 이름은 NUL로 시작한다).
// 연결의 판단(두 번째 연결, 끊김, 링크의 말)은 remote-agent.ts가 한다. 여기는 바이트와 연결의 수명, 다 못 쓴 바이트의 보관까지다.
//
// 함정:
// - 소켓 파일은 bind 때 umask로 권한이 정해지고 chmod는 그 뒤다. 그 틈에 다른 uid가 붙지 못하게 조립은 umask가 그룹·기타의 쓰기를 막는 상태에서
//   부르고, 링크 폴더는 역할 컨테이너에 읽기 전용으로만 붙인다. 붙는 데는 소켓 파일의 쓰기 권한이 필요하고 폴더의 읽기 전용과 무관하다.
// - 경로에 파일이 이미 있으면 듣지 못한다(지우지 않는다). 지난 실행의 소켓을 지우는 일은 조립이 정한다.
// - Bun의 socket.write는 다 쓰지 못하면 쓴 만큼만 돌려준다. 나머지는 이 파일의 사본으로 쥐고 drain에서 이어 쓰며, 다 쓴 사본은 0으로 채운다
//   (값 틀이 섞여 있을 수 있다). 쥔 양이 상한을 넘으면 그 연결을 닫는다.
import type { AgentLinkSession, AgentLinkTransport, RemoteAgent } from "./remote-agent.ts";

// 다 못 쓴 바이트를 쥐는 상한. 링크의 말은 작고(봉투 64KiB, 값 틀 16KiB) 대리가 읽지 않으면 그 연결은 이미 이상하다.
const PENDING_MAX_BYTES = 256 * 1024;

// 연결 하나의 소켓에서 이 파일이 쓰는 면.
export interface UnixPeer {
  write(bytes: Uint8Array): number;
  end(): void;
}

export interface UnixHandlers {
  open(peer: UnixPeer): void;
  data(peer: UnixPeer, chunk: Uint8Array): void;
  drain(peer: UnixPeer): void;
  close(peer: UnixPeer): void;
}

export interface UnixListening {
  stop(): void;
}

// 경로 유닉스 소켓 하나를 듣는 함수. 시험이 바꿔 넣는 자리이고, 제품은 bunUnixListen이다.
export type UnixListen = (path: string, handlers: UnixHandlers) => UnixListening;

export interface AgentListenerOptions {
  // 절대 경로. abstract 이름과 상대 경로는 받지 않는다.
  path: string;
  // 듣기 시작한 뒤 소켓 파일에 줄 권한(예: 0o660). 대리의 uid가 그룹으로 붙을 수 있어야 한다.
  mode: number;
  chmod(path: string, mode: number): void;
  listen?: UnixListen;
}

export const bunUnixListen: UnixListen = (path, handlers) => {
  const listener = Bun.listen<undefined>({
    unix: path,
    socket: {
      open: (socket) => handlers.open(socket),
      data: (socket, chunk) => handlers.data(socket, chunk),
      drain: (socket) => handlers.drain(socket),
      close: (socket) => handlers.close(socket),
      error: (socket) => handlers.close(socket),
    },
  });
  return { stop: () => listener.stop(true) };
};

export class AgentListenerRefused extends Error {
  constructor(readonly reason: "path_not_absolute" | "bad_mode" | "listen_failed") {
    super(reason);
  }
}

interface Peer {
  readonly socket: UnixPeer;
  session: AgentLinkSession | null;
  pending: Uint8Array[];
  pendingBytes: number;
  open: boolean;
}

// 듣기 시작한다. 경로가 절대 경로가 아니거나 NUL을 담으면 열기 전에 거절한다.
export function listenForAgent(agent: RemoteAgent, options: AgentListenerOptions): UnixListening {
  const path = options.path;
  if (!path.startsWith("/") || path.includes("\0")) throw new AgentListenerRefused("path_not_absolute");
  if (!Number.isInteger(options.mode) || options.mode < 0 || options.mode > 0o777) throw new AgentListenerRefused("bad_mode");
  const peers = new Map<UnixPeer, Peer>();

  const shut = (peer: Peer) => {
    if (!peer.open) return;
    peer.open = false;
    for (const chunk of peer.pending) chunk.fill(0);
    peer.pending = [];
    peer.pendingBytes = 0;
    try {
      peer.socket.end();
    } catch {
      // 이미 닫힌 소켓
    }
    const session = peer.session;
    peer.session = null;
    session?.closed();
  };

  const flush = (peer: Peer): boolean => {
    while (peer.pending.length > 0) {
      const head = peer.pending[0]!;
      const wrote = peer.socket.write(head);
      if (wrote < 0) return false;
      if (wrote < head.length) {
        peer.pending[0] = copyOf(head.subarray(wrote));
        peer.pendingBytes -= wrote;
        head.fill(0);
        return true;
      }
      peer.pending.shift();
      peer.pendingBytes -= head.length;
      head.fill(0);
    }
    return true;
  };

  const transportOf = (peer: Peer): AgentLinkTransport => ({
    write: (bytes) => {
      if (!peer.open) throw new Error("closed");
      if (peer.pending.length === 0) {
        const wrote = peer.socket.write(bytes);
        if (wrote < 0) throw new Error("closed");
        if (wrote === bytes.length) return;
        peer.pending.push(copyOf(bytes.subarray(wrote)));
        peer.pendingBytes += bytes.length - wrote;
      } else {
        peer.pending.push(copyOf(bytes));
        peer.pendingBytes += bytes.length;
      }
      if (peer.pendingBytes > PENDING_MAX_BYTES) throw new Error("backlog");
    },
    close: () => shut(peer),
  });

  const handlers: UnixHandlers = {
    open: (socket) => {
      const peer: Peer = { socket, session: null, pending: [], pendingBytes: 0, open: true };
      peers.set(socket, peer);
      peer.session = agent.connect(transportOf(peer));
      if (peer.session === null) shut(peer);
    },
    data: (socket, chunk) => {
      const peer = peers.get(socket);
      if (peer?.open) peer.session?.receive(chunk);
      chunk.fill(0);
    },
    drain: (socket) => {
      const peer = peers.get(socket);
      if (peer?.open && !flush(peer)) shut(peer);
    },
    close: (socket) => {
      const peer = peers.get(socket);
      peers.delete(socket);
      if (peer !== undefined) shut(peer);
    },
  };

  let listening: UnixListening;
  try {
    listening = (options.listen ?? bunUnixListen)(path, handlers);
  } catch {
    throw new AgentListenerRefused("listen_failed");
  }
  try {
    options.chmod(path, options.mode);
  } catch {
    listening.stop();
    throw new AgentListenerRefused("listen_failed");
  }
  return {
    stop: () => {
      listening.stop();
      for (const peer of [...peers.values()]) shut(peer);
      peers.clear();
    },
  };
}

function copyOf(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}
