// keepalive.ts의 차례와 실패 닫힘, keepalive-ffi.ts의 실제 넣기·되읽기, 덮어쓰임을 막는 정적 확인.
import { afterEach, expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import * as net from "node:net";
import { libcSocketOptions, type SocketOptionName, type SocketOptionPort } from "../../src/transport/keepalive-ffi.ts";
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

test("값: 조용한 연결은 약 70초, 허용 끊김은 약 40초이고 TCP_USER_TIMEOUT은 첫 탐침 지연 + 간격 × 횟수다", () => {
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
function fake(over: { socket?: Partial<Record<string, unknown>>; get?: (name: SocketOptionName, real: number) => unknown; set?: (name: SocketOptionName) => unknown } = {}) {
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
  };
  return { socket: socket as unknown as KeepAliveSocket, options, calls, kernel };
}

const sets = (calls: readonly Call[]) => calls.filter((c) => c[0] === "set");

test("차례: setKeepAlive 뒤 fd 하나에 런타임 값 둘을 되읽고, 셋을 넣고, 다섯을 되읽는다", () => {
  const f = fake();
  expect(enableKeepAlive(f.socket, f.options)).toBe(true);
  expect(f.calls).toEqual([
    ["setKeepAlive", true, 30_000],
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
async function pair(): Promise<{ client: net.Socket; server: net.Socket }> {
  let accepted: net.Socket | null = null;
  const listener = net.createServer((socket) => {
    accepted = socket;
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
  const port = (listener.address() as net.AddressInfo).port;
  const client = await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ port, host: "127.0.0.1" }, () => resolve(socket));
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
