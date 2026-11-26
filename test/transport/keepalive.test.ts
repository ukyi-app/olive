// keepalive.ts의 차례와 실패 닫힘, keepalive-ffi.ts의 실제 넣기·되읽기, 덮어쓰임을 막는 정적 확인.
import { afterEach, expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import * as net from "node:net";
import { libcSocketOptions, type SocketAddress, type SocketOptionName, type SocketOptionPort, type SocketSide } from "../../src/transport/keepalive-ffi.ts";
import {
  enableKeepAlive,
  KEEPALIVE_INITIAL_DELAY_MS,
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_OPTIONS,
  KEEPALIVE_PROBES,
  KEEPALIVE_USER_TIMEOUT_MS,
  type KeepAliveSocket,
} from "../../src/transport/keepalive.ts";
import { list, readText } from "../files.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const NAMES = Object.keys(KEEPALIVE_OPTIONS) as SocketOptionName[];

test("값: 조용한 연결은 약 70초(첫 무응답 탐침부터 만료 검사까지 약 40초)이고 TCP_USER_TIMEOUT은 첫 탐침 지연 + 간격 × 횟수다", () => {
  expect(KEEPALIVE_OPTIONS).toEqual({ SO_KEEPALIVE: 1, TCP_KEEPIDLE: 30, TCP_KEEPINTVL: 10, TCP_KEEPCNT: 4, TCP_USER_TIMEOUT: 70_000 });
  expect(KEEPALIVE_USER_TIMEOUT_MS).toBe(KEEPALIVE_INITIAL_DELAY_MS + KEEPALIVE_INTERVAL_MS * KEEPALIVE_PROBES);
  // 첫 탐침 지연 + 간격 이하이면 첫 탐침 뒤 곧 끊긴다(keepalive.ts 머리말의 함정).
  expect(KEEPALIVE_USER_TIMEOUT_MS).toBeGreaterThan(KEEPALIVE_INITIAL_DELAY_MS + KEEPALIVE_INTERVAL_MS);
  // 커널에는 초로 넘긴다.
  expect(KEEPALIVE_INITIAL_DELAY_MS % 1_000).toBe(0);
  expect(KEEPALIVE_INTERVAL_MS % 1_000).toBe(0);
});

type Call = readonly [string, ...unknown[]];

// 커널 소켓 하나를 흉내 내는 가짜 소켓과 포트. 차례를 calls에 남긴다.
// 커널 쪽 fd 7의 양 끝은 127.0.0.1:40000 → 127.0.0.1:8443이고, 런타임 주소 글도 같은 연결을 가리킨다.
const LOCAL = { address: "00000000000000000000ffff7f000001", port: 40_000 };
const PEER = { address: "00000000000000000000ffff7f000001", port: 8_443 };
function fake(
  over: {
    socket?: Partial<Record<string, unknown>>;
    get?: (name: SocketOptionName, real: number) => unknown;
    set?: (name: SocketOptionName) => unknown;
    address?: (side: SocketSide, real: SocketAddress) => unknown;
  } = {},
) {
  const calls: Call[] = [];
  const kernel: Record<SocketOptionName, number> = { SO_KEEPALIVE: 0, TCP_KEEPIDLE: 7200, TCP_KEEPINTVL: 75, TCP_KEEPCNT: 9, TCP_USER_TIMEOUT: 0 };
  const socket = {
    destroyed: false,
    setKeepAlive(enable: boolean, delay: number) {
      calls.push(["setKeepAlive", enable, delay]);
      kernel.SO_KEEPALIVE = 1;
      kernel.TCP_KEEPIDLE = delay / 1_000;
      kernel.TCP_KEEPINTVL = 1;
      kernel.TCP_KEEPCNT = 10;
    },
    _handle: { fd: 7 },
    localAddress: "127.0.0.1",
    localPort: 40_000,
    remoteAddress: "127.0.0.1",
    remotePort: 8_443,
    ...over.socket,
  };
  const options: SocketOptionPort = {
    get(fd, name) {
      calls.push(["get", fd, name]);
      return (over.get ? over.get(name, kernel[name]) : kernel[name]) as number | null;
    },
    set(fd, name, value) {
      calls.push(["set", fd, name, value]);
      const result = over.set ? over.set(name) : true;
      if (result === true) kernel[name] = value;
      return result as boolean;
    },
    address(fd, side) {
      calls.push(["address", fd, side]);
      const real = side === "local" ? LOCAL : PEER;
      return (over.address ? over.address(side, real) : real) as SocketAddress | null;
    },
  };
  return { socket: socket as unknown as KeepAliveSocket, options, calls, kernel };
}

const sets = (calls: readonly Call[]) => calls.filter((c) => c[0] === "set");

test("차례: setKeepAlive 뒤 fd 하나의 양 끝 주소를 대고, 런타임 값 둘을 되읽고, 셋을 넣고, 다섯을 되읽는다", () => {
  const f = fake();
  expect(enableKeepAlive(f.socket, f.options)).toBe(true);
  expect(f.calls).toEqual([
    ["setKeepAlive", true, 30_000],
    ["address", 7, "local"],
    ["address", 7, "peer"],
    ["get", 7, "SO_KEEPALIVE"],
    ["get", 7, "TCP_KEEPIDLE"],
    ["set", 7, "TCP_KEEPINTVL", 10],
    ["set", 7, "TCP_KEEPCNT", 4],
    ["set", 7, "TCP_USER_TIMEOUT", 70_000],
    ...NAMES.map((name) => ["get", 7, name] as const),
  ]);
  expect(f.kernel).toEqual({ ...KEEPALIVE_OPTIONS });
});

test("이미 끊긴 소켓은 아무것도 부르지 않고 true다(부르는 쪽의 destroyed 확인이 기존 사유로 닫는다). destroyed가 참·거짓이 아니면 false다", () => {
  const gone = fake({ socket: { destroyed: true } });
  expect(enableKeepAlive(gone.socket, gone.options)).toBe(true);
  expect(gone.calls).toEqual([]);
  for (const destroyed of [undefined, null, 0, "false"]) {
    const odd = fake({ socket: { destroyed } });
    expect(enableKeepAlive(odd.socket, odd.options), String(destroyed)).toBe(false);
    expect(odd.calls).toEqual([]);
  }
});

test("fd를 얻지 못하면(_handle 없음·null·읽기가 던짐, fd가 음수·소수·문자열·없음·읽기가 던짐) 포트를 부르지 않고 false다", () => {
  const throwing = (key: string) => Object.defineProperty({}, key, { get: () => { throw new Error("시험: 읽기 실패"); } });
  const handles: unknown[] = [undefined, null, 7, { fd: -1 }, { fd: 1.5 }, { fd: "7" }, { fd: Number.NaN }, {}, throwing("fd")];
  for (const handle of handles) {
    const f = fake({ socket: { _handle: handle } });
    expect(enableKeepAlive(f.socket, f.options), String(handle)).toBe(false);
    expect(f.calls).toEqual([["setKeepAlive", true, 30_000]]);
  }
  const socket = fake();
  Object.defineProperty(socket.socket, "_handle", { get: () => { throw new Error("시험: 읽기 실패"); } });
  expect(enableKeepAlive(socket.socket, socket.options)).toBe(false);
  expect(socket.calls).toEqual([["setKeepAlive", true, 30_000]]);
});

test("setKeepAlive가 던지거나 메서드가 아니면 fd·포트를 보지 않고 false다", () => {
  for (const setKeepAlive of [() => { throw new Error("시험: setsockopt 실패"); }, undefined, 1]) {
    let reads = 0;
    const f = fake({ socket: { setKeepAlive } });
    Object.defineProperty(f.socket, "_handle", { get: () => { reads += 1; return { fd: 7 }; } });
    expect(enableKeepAlive(f.socket, f.options)).toBe(false);
    expect(f.calls).toEqual([]);
    expect(reads).toBe(0);
  }
});

test("넣기 전 되읽기: 런타임 값이 다르거나(켜지지 않음, 다른 지연, 실패, 던짐) 꼴이 다르면 넣지 않고 false다", () => {
  const cases: [SocketOptionName, unknown][] = [
    ["SO_KEEPALIVE", 0],
    ["SO_KEEPALIVE", null],
    ["SO_KEEPALIVE", "1"],
    ["TCP_KEEPIDLE", 20],
    ["TCP_KEEPIDLE", null],
    ["TCP_KEEPIDLE", 30.5],
  ];
  for (const [target, value] of cases) {
    const f = fake({ get: (name, real) => (name === target ? value : real) });
    expect(enableKeepAlive(f.socket, f.options), `${target}=${value}`).toBe(false);
    expect(sets(f.calls)).toEqual([]);
  }
  const thrown = fake({ get: () => { throw new Error("시험: getsockopt 던짐"); } });
  expect(enableKeepAlive(thrown.socket, thrown.options)).toBe(false);
  expect(sets(thrown.calls)).toEqual([]);
});

test("fd의 양 끝 대조: 커널이 준 주소·포트가 하나라도 다르거나 읽지 못하면 되읽기·넣기 없이 false다", () => {
  const other = { address: "00000000000000000000ffff7f000002", port: 40_000 };
  const cases: [string, (side: SocketSide, real: SocketAddress) => unknown][] = [
    ["로컬 주소", (side, real) => (side === "local" ? other : real)],
    ["로컬 포트", (side, real) => (side === "local" ? { ...real, port: 40_001 } : real)],
    ["상대 주소", (side, real) => (side === "peer" ? { ...real, address: other.address } : real)],
    ["상대 포트", (side, real) => (side === "peer" ? { ...real, port: 8_444 } : real)],
    // 같은 연결의 반대쪽 소켓: 넷이 뒤집혀 있다.
    ["반대쪽", (side) => (side === "local" ? PEER : LOCAL)],
    ["로컬 null", (side, real) => (side === "local" ? null : real)],
    ["상대 null", (side, real) => (side === "peer" ? null : real)],
    ["꼴 아님", () => "00000000000000000000ffff7f000001"],
    ["던짐", () => { throw new Error("시험: getsockname 던짐"); }],
  ];
  for (const [label, address] of cases) {
    const f = fake({ address });
    expect(enableKeepAlive(f.socket, f.options), label).toBe(false);
    expect(f.calls.filter((c) => c[0] === "get" || c[0] === "set"), label).toEqual([]);
  }
});

test("fd의 양 끝 대조: 런타임 주소 글·포트를 꼴로 읽지 못하면(없음, 영역이 붙은 IPv6, 틀린 IPv4·IPv6, 포트 밖) 모호한 것으로 보고 false다", () => {
  const bad: Partial<Record<string, unknown>>[] = [
    { localAddress: undefined },
    { remoteAddress: undefined },
    { localPort: undefined },
    { remotePort: undefined },
    { localAddress: "fe80::1%eth0" },
    { localAddress: "127.0.0.1.1" },
    { localAddress: "256.0.0.1" },
    { localAddress: "127.0.0.01" },
    { localAddress: "::ffff:1.2.3" },
    { localAddress: "1::2::3" },
    { localAddress: "1:2:3:4:5:6:7:8:9" },
    { localAddress: "1:2:3:4:5:6:7:8::" },
    { localAddress: "1.2.3.4::" },
    { localAddress: "12345::1" },
    { localAddress: "" },
    { localPort: 0 },
    { localPort: 65_536 },
    { remotePort: 8_443.5 },
    { remotePort: "8443" },
  ];
  for (const socket of bad) {
    const f = fake({ socket });
    expect(enableKeepAlive(f.socket, f.options), JSON.stringify(socket)).toBe(false);
    expect(f.calls.filter((c) => c[0] === "get" || c[0] === "set"), JSON.stringify(socket)).toEqual([]);
  }
});

test("fd의 양 끝 대조: IPv4와 그 매핑 IPv6, 줄인·편 IPv6, 대소문자는 같은 주소다", () => {
  for (const localAddress of ["127.0.0.1", "::ffff:127.0.0.1", "::FFFF:7f00:1", "0:0:0:0:0:ffff:127.0.0.1", "0000:0000:0000:0000:0000:ffff:7f00:0001"]) {
    const f = fake({ socket: { localAddress } });
    expect(enableKeepAlive(f.socket, f.options), localAddress).toBe(true);
  }
  const v6: [string, string][] = [
    ["::1", "00000000000000000000000000000001"],
    ["2001:db8::1", "20010db8000000000000000000000001"],
    ["fd7a:115c:a1e0::1:2", "fd7a115ca1e000000000000000010002"],
    ["1:2:3:4:5:6:7::", "00010002000300040005000600070000"],
  ];
  for (const [text, hex] of v6) {
    const f = fake({ socket: { remoteAddress: text }, address: (side, real) => (side === "peer" ? { ...real, address: hex } : real) });
    expect(enableKeepAlive(f.socket, f.options), text).toBe(true);
  }
});

test("넣기: 하나라도 실패(false·꼴 아닌 값·던짐)하면 그 뒤를 넣지 않고 되읽지 않고 false다", () => {
  for (const [i, target] of (["TCP_KEEPINTVL", "TCP_KEEPCNT", "TCP_USER_TIMEOUT"] as const).entries()) {
    for (const bad of [false, undefined, 0, "throw"]) {
      const f = fake({ set: (name) => { if (name !== target) return true; if (bad === "throw") throw new Error("시험: 던짐"); return bad; } });
      expect(enableKeepAlive(f.socket, f.options), `${target} ${String(bad)}`).toBe(false);
      expect(sets(f.calls).map((c) => c[2])).toEqual(["TCP_KEEPINTVL", "TCP_KEEPCNT", "TCP_USER_TIMEOUT"].slice(0, i + 1));
      expect(f.calls.at(-1)?.[0]).toBe("set");
    }
  }
});

test("넣은 뒤 되읽기: 다섯 값 가운데 하나라도 다르면(다른 값, 실패, 던짐) false다", () => {
  for (const target of NAMES) {
    for (const bad of [KEEPALIVE_OPTIONS[target] + 1, null, "throw"]) {
      let tuned = false;
      const f = fake({
        set: () => { tuned = true; return true; },
        get: (name, real) => {
          if (!tuned || name !== target) return real;
          if (bad === "throw") throw new Error("시험: 던짐");
          return bad;
        },
      });
      expect(enableKeepAlive(f.socket, f.options), `${target} ${String(bad)}`).toBe(false);
      expect(sets(f.calls)).toHaveLength(3);
    }
  }
});

// 실제 커널 소켓: 루프백 TCP 한 쌍(TLS 쪽은 server.test.ts·socket.test.ts가 본다).
async function pair(listen = "127.0.0.1", connect = listen): Promise<{ client: net.Socket; server: net.Socket }> {
  let accepted: net.Socket | null = null;
  const listener = net.createServer((socket) => {
    accepted = socket;
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, listen, resolve);
  });
  cleanup.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
  const port = (listener.address() as net.AddressInfo).port;
  const client = await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ port, host: connect }, () => resolve(socket));
    socket.once("error", reject);
  });
  for (let i = 0; i < 200 && accepted === null; i++) await Bun.sleep(5);
  if (accepted === null) throw new Error("시험: 받은 연결이 없다");
  const server: net.Socket = accepted;
  cleanup.push(() => {
    client.destroy();
    server.destroy();
  });
  return { client, server };
}

const fdOf = (socket: net.Socket) => (socket as unknown as { _handle: { fd: number } })._handle.fd;
const read = (socket: net.Socket) => Object.fromEntries(NAMES.map((name) => [name, libcSocketOptions.get(fdOf(socket), name)]));

test("실제 소켓: libc로 다섯 값을 넣고 되읽는다. 켜지 않은 상대 소켓은 커널 기본 그대로다", async () => {
  const { client, server } = await pair();
  expect(read(client).SO_KEEPALIVE).toBe(0);
  expect(read(client).TCP_USER_TIMEOUT).toBe(0);
  expect(enableKeepAlive(client)).toBe(true);
  expect(read(client)).toEqual({ ...KEEPALIVE_OPTIONS });
  expect(read(server).SO_KEEPALIVE).toBe(0);
  expect(read(server).TCP_USER_TIMEOUT).toBe(0);
  // 주고받은 뒤에도 남는다.
  const got = new Promise((resolve) => server.once("data", resolve));
  client.write("x");
  await got;
  expect(read(client)).toEqual({ ...KEEPALIVE_OPTIONS });
});

// 런타임 setKeepAlive(true, 30000)만 지난 소켓의 값. 다른 연결의 fd에 쓰면 간격·횟수·TCP_USER_TIMEOUT이 바뀐다.
const RUNTIME_ONLY = { SO_KEEPALIVE: 1, TCP_KEEPIDLE: 30, TCP_KEEPINTVL: 1, TCP_KEEPCNT: 10, TCP_USER_TIMEOUT: 0 };
const swapFd = (socket: net.Socket, fd: number) =>
  Object.defineProperty((socket as unknown as { _handle: object })._handle, "fd", { configurable: true, value: fd });

test("실제 소켓: 같은 런타임 값을 켠 다른 연결(다른 연결, 같은 연결의 반대쪽)의 fd를 받으면 그 fd에 쓰지 않고 false다", async () => {
  const a = await pair();
  const b = await pair();
  a.client.setKeepAlive(true, KEEPALIVE_INITIAL_DELAY_MS);
  a.server.setKeepAlive(true, KEEPALIVE_INITIAL_DELAY_MS);
  expect(read(a.client)).toEqual(RUNTIME_ONLY);
  expect(read(a.server)).toEqual(RUNTIME_ONLY);
  const own = fdOf(b.client);
  swapFd(b.client, fdOf(a.client));
  expect(enableKeepAlive(b.client)).toBe(false);
  expect(read(a.client)).toEqual(RUNTIME_ONLY);
  swapFd(a.client, fdOf(a.server));
  expect(enableKeepAlive(a.client)).toBe(false);
  expect(read(a.server)).toEqual(RUNTIME_ONLY);
  // 제 fd로 되돌리면 넣는다.
  swapFd(b.client, own);
  expect(enableKeepAlive(b.client)).toBe(true);
  expect(read(b.client)).toEqual({ ...KEEPALIVE_OPTIONS });
});

test("실제 소켓: libc 포트의 address는 getsockname·getpeername을 런타임 주소·포트와 같은 꼴로 돌려주고, 소켓이 아닌 fd는 null이다", async () => {
  const { client, server } = await pair();
  const loopback = "00000000000000000000ffff7f000001";
  expect(libcSocketOptions.address(fdOf(client), "local")).toEqual({ address: loopback, port: client.localPort! });
  expect(libcSocketOptions.address(fdOf(client), "peer")).toEqual({ address: loopback, port: client.remotePort! });
  expect(libcSocketOptions.address(fdOf(server), "local")).toEqual({ address: loopback, port: client.remotePort! });
  expect(libcSocketOptions.address(fdOf(server), "peer")).toEqual({ address: loopback, port: client.localPort! });
  const plain = openSync(import.meta.path, "r");
  cleanup.push(() => closeSync(plain));
  expect(libcSocketOptions.address(plain, "local")).toBeNull();
  expect(libcSocketOptions.address(-1, "peer")).toBeNull();
  expect(libcSocketOptions.address(fdOf(client), "nope" as SocketSide)).toBeNull();
});

// IPv6을 끈 커널(/proc/net/tcp6 없음)에서는 ::1을 듣지 못한다. 그때는 그 실패가 주소 계열 오류인지만 보고 IPv6 쪽 단언을 하지 않는다
// (IPv6 주소 글의 읽기는 위 가짜 포트 시험이 본다). 건너뛰기 표시는 test/repo.test.ts가 막는다.
async function ipv6Unavailable(): Promise<string | null> {
  const listener = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "::1", resolve);
    });
    return null;
  } catch (error) {
    return String((error as NodeJS.ErrnoException).code);
  } finally {
    listener.close();
  }
}

test("실제 소켓: IPv6 루프백과 이중 스택에 IPv4로 붙은 연결(받은 쪽 주소는 ::ffff: 매핑)도 양 끝을 대고 넣는다", async () => {
  const unavailable = await ipv6Unavailable();
  if (unavailable !== null) {
    expect(["EADDRNOTAVAIL", "EAFNOSUPPORT"]).toContain(unavailable);
    return;
  }
  const six = await pair("::1");
  const mapped = await pair("::", "127.0.0.1");
  for (const socket of [six.client, six.server, mapped.client, mapped.server]) {
    expect(enableKeepAlive(socket), `${socket.localAddress} → ${socket.remoteAddress}`).toBe(true);
    expect(read(socket)).toEqual({ ...KEEPALIVE_OPTIONS });
  }
  expect(libcSocketOptions.address(fdOf(six.client), "peer")).toEqual({ address: "00000000000000000000000000000001", port: six.client.remotePort! });
  expect(libcSocketOptions.address(fdOf(mapped.server), "local")?.address).toBe("00000000000000000000ffff7f000001");
});

test("실제 소켓: libc 포트는 실패를 던지지 않고 null·false로 돌려준다(소켓이 아닌 fd, 음수·int32 밖, 커널이 거절하는 값, 모르는 이름)", async () => {
  const { client } = await pair();
  const fd = fdOf(client);
  // 읽기 전용으로 연 이 시험 파일의 fd: 소켓이 아니어서 ENOTSOCK으로 실패한다.
  const plain = openSync(import.meta.path, "r");
  cleanup.push(() => closeSync(plain));
  expect(libcSocketOptions.get(plain, "TCP_KEEPCNT")).toBeNull();
  expect(libcSocketOptions.set(plain, "TCP_KEEPCNT", 4)).toBe(false);
  expect(libcSocketOptions.get(-1, "SO_KEEPALIVE")).toBeNull();
  expect(libcSocketOptions.set(-1, "SO_KEEPALIVE", 1)).toBe(false);
  expect(libcSocketOptions.get(2 ** 31, "SO_KEEPALIVE")).toBeNull();
  expect(libcSocketOptions.set(fd, "TCP_KEEPCNT", 2 ** 31)).toBe(false);
  expect(libcSocketOptions.set(fd, "TCP_KEEPCNT", 4.5)).toBe(false);
  expect(libcSocketOptions.get(fd, "SO_NOPE" as SocketOptionName)).toBeNull();
  expect(libcSocketOptions.set(fd, "SO_NOPE" as SocketOptionName, 1)).toBe(false);
  // 커널이 거절하는 값(TCP_KEEPCNT는 1~127).
  expect(libcSocketOptions.set(fd, "TCP_KEEPCNT", 0)).toBe(false);
  expect(libcSocketOptions.get(fd, "TCP_KEEPCNT")).not.toBe(0);
  expect(Object.isFrozen(libcSocketOptions)).toBe(true);
});

test("실제 소켓: 파기한 소켓은 런타임이 _handle을 바로 비운다. enableKeepAlive는 아무것도 하지 않고 true다(부르는 쪽 destroyed 확인의 몫)", async () => {
  const { client } = await pair();
  client.destroy();
  expect((client as unknown as { _handle: unknown })._handle).toBeNull();
  expect(enableKeepAlive(client)).toBe(true);
});

const code = async (file: string) =>
  (await readText(file))
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

// 런타임의 setKeepAlive를 이 뒤 다른 지연으로 다시 부르면 간격 1초·10회로 되돌아간다. 그래서 src/에서 setKeepAlive·keepAlive 생성 옵션·_handle을
// 쓰는 곳은 keepalive.ts 하나이고, 연결마다 enableKeepAlive를 부르는 곳은 감독 서버와 실행기 소켓에 한 번씩, 인자 하나(실제 libc 포트)다.
test("정적: setKeepAlive·_handle은 keepalive.ts에만 있고, enableKeepAlive는 server.ts·socket.ts에서 한 번씩 소켓 하나로 부른다", async () => {
  const touches: string[] = [];
  const calls: string[] = [];
  const ffiImporters: string[] = [];
  for (const file of await list("src/**/*.ts")) {
    const source = await code(file);
    if (/\bsetKeepAlive\b|\bkeepAlive\b|\b_handle\b/.test(source)) touches.push(file);
    for (const match of source.matchAll(/\benableKeepAlive\(([^()]*)\)/g)) calls.push(`${file} ${match[1]}`);
    if (/keepalive-ffi\.ts/.test(source)) ffiImporters.push(file);
  }
  expect(touches).toEqual(["src/transport/keepalive.ts"]);
  expect(calls.filter((call) => !call.startsWith("src/transport/keepalive.ts "))).toEqual([
    "src/executor/socket.ts verified.socket",
    "src/supervisor/transport/server.ts socket",
  ]);
  expect(ffiImporters).toEqual(["src/transport/keepalive.ts"]);
  const own = await code("src/transport/keepalive.ts");
  expect([...own.matchAll(/\bsetKeepAlive\(true, /g)]).toHaveLength(1);
  expect([...own.matchAll(/\._handle\b/g)]).toHaveLength(1);
});
