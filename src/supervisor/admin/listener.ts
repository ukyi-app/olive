// 감독의 두 번째 듣기: 관리 통로의 경로 유닉스 소켓 하나(D-60·D-101). 감독의 다른 듣기는 실행기를 받는 TLS 서버(transport/tls-server.ts)뿐이다.
// TCP·abstract 소켓은 듣지 않는다. 경로는 "/"로 시작해야 하고 NUL을 담지 못한다(abstract 이름은 NUL로 시작한다).
// 연결 하나 = 요청 한 줄 → 답 한 줄 → 닫기. 요청의 뜻은 answer(commands.ts의 answerLine)가 정하고 여기는 바이트·기한·상한·연결 수명까지다.
//
// 함정:
// - 소켓 파일은 bind 때 umask로 권한이 정해지고 chmod는 그 뒤다. 그 틈에 다른 uid가 붙지 못하게 진입점은 umask가 그룹·기타의 쓰기를
//   막는 상태에서 부른다. 차트는 이 경로의 폴더(/tmp emptyDir)를 감독 컨테이너에만 붙인다(README "감독 관리 통로").
// - 경로에 지난 프로세스의 소켓이 남아 있으면(emptyDir는 컨테이너 재시작에도 남는다) 지우고 듣는다. 소켓이 아닌 파일이면 지우지 않고 거절한다.
// - Bun의 socket.write는 다 쓰지 못하면 쓴 만큼만 돌려준다. 나머지는 쥐고 drain에서 이어 쓰며, 다 쓴 뒤에 닫는다.
// - 기한은 연결을 받은 순간에 정하고, 요청 줄을 다 받은 순간의 단조 시각으로 판정한다. 타이머는 쉬는 연결을 깨우는 수단일 뿐이다.
import { ADMIN_LIMITS, encodeReply } from "./protocol.ts";

// 연결 하나의 소켓에서 이 파일이 쓰는 면.
export interface AdminPeer {
  write(bytes: Uint8Array): number;
  end(): void;
}

export interface AdminSocketHandlers {
  open(peer: AdminPeer): void;
  data(peer: AdminPeer, chunk: Uint8Array): void;
  drain(peer: AdminPeer): void;
  close(peer: AdminPeer): void;
}

export interface AdminListening {
  stop(): void;
}

// 경로 유닉스 소켓 하나를 듣는 함수. 시험이 바꿔 넣는 자리이고, 제품은 bunUnixListen이다(내보내지 않는다).
export type AdminUnixListen = (path: string, handlers: AdminSocketHandlers) => AdminListening;

// 경로 하나의 파일 조작. 진입점이 node:fs로 채운다. kind는 링크를 따라가지 않는다(lstat).
export interface AdminFs {
  kind(path: string): "absent" | "socket" | "other";
  unlink(path: string): void;
  chmod(path: string, mode: number): void;
}

export type AdminConnectionNote = "busy" | "late" | "too_long" | "answer_threw" | "reply_too_long" | "write_failed";

export interface AdminListenerOptions {
  path: string;
  mode: number;
  fs: AdminFs;
  monoNow: () => number;
  setTimer: (ms: number, fire: () => void) => () => void;
  // 요청 한 줄(줄바꿈 뺀 것) → 답 한 줄(줄바꿈 포함).
  answer: (line: string) => string;
  listen?: AdminUnixListen;
  // 정상 밖으로 끝난 연결의 갈래. 요청·답의 글은 싣지 않는다.
  note?: (note: AdminConnectionNote) => void;
}

export class AdminListenRefused extends Error {
  constructor(readonly reason: "path_not_absolute" | "bad_mode" | "path_taken" | "stale_unremovable" | "listen_failed") {
    super(reason);
    this.name = "AdminListenRefused";
  }
}

const bunUnixListen: AdminUnixListen = (path, handlers) => {
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

const NEWLINE = 0x0a;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const ENCODER = new TextEncoder();

interface Connection {
  readonly peer: AdminPeer;
  readonly limit: number;
  chunks: Uint8Array[];
  bytes: number;
  pending: Uint8Array | null;
  state: "reading" | "writing" | "closed";
  cancel: () => void;
}

export function listenAdmin(options: AdminListenerOptions): AdminListening {
  const path = options.path;
  if (!path.startsWith("/") || path.includes("\0")) throw new AdminListenRefused("path_not_absolute");
  if (!Number.isInteger(options.mode) || options.mode < 0 || options.mode > 0o777) throw new AdminListenRefused("bad_mode");
  const note = (value: AdminConnectionNote) => {
    try {
      options.note?.(value);
    } catch {
      // 기록 실패는 연결 처리에 영향을 주지 않는다.
    }
  };
  // 시각을 읽지 못하면 기한이 지난 것으로 본다(모름을 시간이 남은 것으로 읽지 않는다).
  const pastLimit = (limit: number): boolean => {
    try {
      const at = options.monoNow();
      return !(Number.isFinite(at) && at < limit);
    } catch {
      return true;
    }
  };
  const connections = new Map<AdminPeer, Connection>();

  // 닫은 연결은 close 알림을 기다리지 않고 바로 동시 연결 수에서 뺀다.
  const shut = (connection: Connection) => {
    if (connection.state === "closed") return;
    connection.state = "closed";
    connections.delete(connection.peer);
    connection.chunks = [];
    connection.pending = null;
    try {
      connection.cancel();
    } catch {
      // 취소하지 못한 타이머가 늦게 불려도 닫힌 연결은 다시 열리지 않는다.
    }
    try {
      connection.peer.end();
    } catch {
      // 이미 닫힌 소켓
    }
  };

  // 쥔 바이트를 이어 쓴다. 다 쓰면 닫는다. 쓰기가 음수를 돌려주거나 던지면 끊긴 것이다.
  const flush = (connection: Connection) => {
    const head = connection.pending;
    if (head === null) return shut(connection);
    let wrote: number;
    try {
      wrote = connection.peer.write(head);
    } catch {
      wrote = -1;
    }
    if (wrote < 0) {
      note("write_failed");
      return shut(connection);
    }
    connection.pending = wrote < head.length ? head.subarray(wrote) : null;
    if (connection.pending === null) shut(connection);
  };

  const reply = (connection: Connection, text: string) => {
    const bytes = ENCODER.encode(text);
    if (bytes.length > ADMIN_LIMITS.replyMaxBytes) {
      note("reply_too_long");
      return shut(connection);
    }
    connection.state = "writing";
    try {
      connection.cancel();
    } catch {
      // 기한 타이머가 늦게 불려도 쓰는 중인 연결은 닫지 않는다(state를 본다).
    }
    connection.pending = bytes;
    flush(connection);
  };

  // 받은 바이트에서 요청 한 줄을 찾는다. 줄을 다 받은 순간의 시각으로 기한을 판정한다.
  const take = (connection: Connection) => {
    const all = new Uint8Array(connection.bytes);
    let at = 0;
    for (const chunk of connection.chunks) {
      all.set(chunk, at);
      at += chunk.length;
    }
    const end = all.indexOf(NEWLINE);
    if (end < 0) {
      if (all.length >= ADMIN_LIMITS.requestMaxBytes) {
        note("too_long");
        shut(connection);
      }
      return;
    }
    if (end + 1 > ADMIN_LIMITS.requestMaxBytes) {
      note("too_long");
      return shut(connection);
    }
    if (pastLimit(connection.limit)) {
      note("late");
      return shut(connection);
    }
    // 줄 뒤에 더 온 바이트는 요청 하나의 말이 아니다.
    if (end + 1 !== all.length) return reply(connection, encodeReply({ kind: "refused", reason: "malformed" }));
    let line: string;
    try {
      line = UTF8.decode(all.subarray(0, end));
    } catch {
      return reply(connection, encodeReply({ kind: "refused", reason: "malformed" }));
    }
    let text: string;
    try {
      text = options.answer(line);
    } catch {
      note("answer_threw");
      return shut(connection);
    }
    reply(connection, text);
  };

  const handlers: AdminSocketHandlers = {
    open: (peer) => {
      let limit = Number.NaN;
      try {
        limit = options.monoNow() + ADMIN_LIMITS.serverWaitMs;
      } catch {
        // 시각을 읽지 못한 연결은 기한이 이미 지난 연결이다(NaN은 늘 지난 것으로 판정된다).
      }
      const connection: Connection = { peer, limit, chunks: [], bytes: 0, pending: null, state: "reading", cancel: () => {} };
      if (connections.size >= ADMIN_LIMITS.maxConnections || !Number.isFinite(limit)) {
        if (Number.isFinite(limit)) note("busy");
        else note("late");
        // 넘친 연결은 쥐지 않는다. busy 한 줄을 한 번 써 보고 닫는다(다 못 쓰면 그대로 닫는다).
        try {
          if (Number.isFinite(limit)) peer.write(ENCODER.encode(encodeReply({ kind: "refused", reason: "busy" })));
        } catch {
          // 이미 닫힌 소켓
        }
        connection.state = "closed";
        try {
          peer.end();
        } catch {
          // 이미 닫힌 소켓
        }
        return;
      }
      connections.set(peer, connection);
      const arm = () => {
        let left: number;
        try {
          left = Math.max(1, Math.ceil(limit - options.monoNow()));
          if (!Number.isFinite(left)) throw new RangeError("clock");
        } catch {
          note("late");
          return shut(connection);
        }
        try {
          connection.cancel = options.setTimer(left, () => {
            if (connection.state !== "reading") return;
            if (!pastLimit(limit)) return arm();
            note("late");
            shut(connection);
          });
        } catch {
          note("late");
          shut(connection);
        }
      };
      arm();
    },
    data: (peer, chunk) => {
      const connection = connections.get(peer);
      if (connection === undefined || connection.state !== "reading") return;
      connection.chunks.push(new Uint8Array(chunk));
      connection.bytes += chunk.length;
      take(connection);
    },
    drain: (peer) => {
      const connection = connections.get(peer);
      if (connection?.state === "writing") flush(connection);
    },
    close: (peer) => {
      const connection = connections.get(peer);
      connections.delete(peer);
      if (connection !== undefined) shut(connection);
    },
  };

  let kind: ReturnType<AdminFs["kind"]>;
  try {
    kind = options.fs.kind(path);
  } catch {
    throw new AdminListenRefused("listen_failed");
  }
  if (kind === "other") throw new AdminListenRefused("path_taken");
  if (kind === "socket") {
    try {
      options.fs.unlink(path);
    } catch {
      throw new AdminListenRefused("stale_unremovable");
    }
  }
  let listening: AdminListening;
  try {
    listening = (options.listen ?? bunUnixListen)(path, handlers);
  } catch {
    throw new AdminListenRefused("listen_failed");
  }
  try {
    options.fs.chmod(path, options.mode);
  } catch {
    listening.stop();
    throw new AdminListenRefused("listen_failed");
  }
  return {
    stop: () => {
      listening.stop();
      for (const connection of [...connections.values()]) shut(connection);
      connections.clear();
    },
  };
}
