// 링크 메시지의 시험: 두 방향의 꼴, 차례, 크기, 자격 값의 가림.
import { expect, test } from "bun:test";
import {
  type AgentMessage,
  AgentDecoder,
  ControlDecoder,
  CredentialValue,
  encodeAgent,
  encodeControl,
  LinkError,
  OUTPUT_CHUNK_BYTES,
  outputMessages,
} from "../../src/agent/link.ts";
import { CREDENTIAL_MAX_BYTES, encodeCredentialFrame, encodeFrame } from "../../src/transport/framing.ts";
import { RUN, RUN2, SECRET, SECRET_DIGEST, secretBytes, startBytes, startMessage, T0 } from "./support.ts";

const json = (value: unknown) => {
  const encoded = encodeFrame(new TextEncoder().encode(JSON.stringify(value)));
  if (!encoded.ok) throw new Error("encode");
  return encoded.frame;
};
const codeOf = (run: () => unknown) => {
  try {
    run();
    return "ok";
  } catch (error) {
    return error instanceof LinkError ? error.code : "other";
  }
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) out.set(part, (at += part.length) - part.length);
  return out;
};

test("링크(제어 → 대리): 네 메시지가 같은 꼴로 돌아오고, start는 값 틀과 짝을 맞춘 뒤에만 나온다. 한 바이트씩 넣어도 같다", () => {
  const bytes = concat(
    startBytes(),
    encodeControl({ type: "renew", run_id: RUN, lease_until: T0 + 1 }),
    encodeControl({ type: "terminate", seq: 1 }),
    encodeControl({ type: "count", seq: 2 }),
  );
  const decoder = new ControlDecoder();
  const out = [...bytes].flatMap((byte) => decoder.push(new Uint8Array([byte])));
  expect(out.map((message) => message.type)).toEqual(["start", "renew", "terminate", "count"]);
  const start = out[0]!;
  if (start.type !== "start") throw new Error("start");
  const { credential, ...rest } = start;
  expect(rest).toEqual(startMessage());
  // 실패 진단에 값이 실리지 않게 같음은 불리언으로 본다.
  expect(new TextDecoder().decode(credential.take()!) === SECRET).toBe(true);
  // 한 번만 내준다.
  expect(credential.take()).toBeNull();
  expect(decoder.end()).toEqual([]);
});

test("링크(대리 → 제어): 메시지가 같은 꼴로 돌아오고 stdout은 조각을 이어 원 바이트가 된다", () => {
  const stdout = new Uint8Array(OUTPUT_CHUNK_BYTES * 2 + 5).map((_, i) => i % 251);
  const sent: AgentMessage[] = [
    { type: "hello" },
    { type: "spawned", run_id: RUN },
    ...outputMessages(RUN, stdout),
    { type: "exited", run_id: RUN, code: 0, signal: null, overflow: false, stdout_bytes: stdout.length },
    { type: "terminated", seq: 1 },
    { type: "counted", seq: 2, survivors: null },
    { type: "not_spawned", run_id: RUN2, reason: "space_not_clean" },
    { type: "spawned", run_id: RUN },
    { type: "unconfirmed", run_id: RUN },
    { type: "counted", seq: 3, survivors: 0 },
  ];
  const decoder = new AgentDecoder();
  const got = decoder.push(concat(...sent.map(encodeAgent)));
  expect(got).toEqual(sent);
  const joined = Buffer.concat(got.filter((m) => m.type === "output").map((m) => Buffer.from((m as { data: string }).data, "base64")));
  expect(new Uint8Array(joined)).toEqual(stdout);
});

test("링크: 모르는 메시지·다른 판·칸이 더하거나 빠진 메시지는 거절하고, 그 뒤로는 같은 오류만 낸다", () => {
  const cases: [unknown, string][] = [
    [{ v: 1, type: "shutdown" }, "link_unknown_message"],
    [{ v: 2, type: "count", seq: 1 }, "link_unknown_message"],
    [[1, 2], "link_unknown_message"],
    [{ v: 1, type: "count", seq: 1, more: 1 }, "link_bad_message"],
    [{ v: 1, type: "count", seq: 0 }, "link_bad_message"],
    [{ v: 1, type: "renew", run_id: "not-a-uuid", lease_until: 1 }, "link_bad_message"],
    [{ ...startMessage({ program: "relative/path" }), v: 1 }, "link_bad_message"],
    [{ ...startMessage({ env: { OLIVE_CREDENTIAL: "x" } }), v: 1 }, "link_bad_message"],
    [{ ...startMessage({ output_bytes: 10 * 1024 * 1024 }), v: 1 }, "link_bad_message"],
  ];
  for (const [value, code] of cases) {
    const decoder = new ControlDecoder();
    expect(codeOf(() => decoder.push(json(value))), JSON.stringify(value)).toBe(code);
    expect(codeOf(() => decoder.push(encodeControl({ type: "count", seq: 5 })))).toBe(code);
  }
  const agentSide = new AgentDecoder();
  agentSide.push(encodeAgent({ type: "hello" }));
  expect(codeOf(() => agentSide.push(json({ v: 1, type: "exited", run_id: RUN, code: 0, signal: null, overflow: true, stdout_bytes: 3 })))).toBe(
    "link_bad_message",
  );
  // 보내는 쪽도 같은 꼴 검사를 지난다.
  expect(codeOf(() => encodeAgent({ type: "counted", seq: 1, survivors: -1 }))).toBe("link_bad_message");
});

test("링크 차례(제어 → 대리): 값 틀은 start 바로 뒤에만 오고, start 뒤에 다른 메시지가 오거나 입력이 끝나면 거절한다", () => {
  const credentialFrame = encodeCredentialFrame(RUN, SECRET_DIGEST, secretBytes());
  if (!credentialFrame.ok) throw new Error("encode");
  const head = startBytes().subarray(0, startBytes().length - credentialFrame.frame.length);
  expect(codeOf(() => new ControlDecoder().push(credentialFrame.frame))).toBe("link_out_of_order");
  expect(codeOf(() => new ControlDecoder().push(concat(head, encodeControl({ type: "count", seq: 1 }))))).toBe("link_out_of_order");
  const waiting = new ControlDecoder();
  expect(waiting.push(head)).toEqual([]);
  expect(codeOf(() => waiting.end())).toBe("link_out_of_order");
  // 다른 실행의 값 틀.
  const other = encodeCredentialFrame(RUN2, SECRET_DIGEST, secretBytes());
  if (!other.ok) throw new Error("encode");
  expect(codeOf(() => new ControlDecoder().push(concat(head, other.frame)))).toBe("link_credential_mismatch");
});

test("링크 차례(대리 → 제어): hello가 처음 한 번이고, 실행의 말이 섞이거나 seq가 되돌아가거나 stdout 합이 다르면 거절한다", () => {
  const hello = encodeAgent({ type: "hello" });
  const cases: [AgentMessage[], string][] = [
    [[{ type: "counted", seq: 1, survivors: 0 }], "link_out_of_order"],
    [[{ type: "hello" }, { type: "hello" }], "link_out_of_order"],
    [[{ type: "hello" }, { type: "output", run_id: RUN, data: "AA==" }], "link_out_of_order"],
    [[{ type: "hello" }, { type: "spawned", run_id: RUN }, { type: "spawned", run_id: RUN2 }], "link_out_of_order"],
    [[{ type: "hello" }, { type: "spawned", run_id: RUN }, { type: "exited", run_id: RUN2, code: 0, signal: null, overflow: false, stdout_bytes: 0 }], "link_out_of_order"],
    [[{ type: "hello" }, { type: "spawned", run_id: RUN }, { type: "not_spawned", run_id: RUN, reason: "aborted" }], "link_out_of_order"],
    [[{ type: "hello" }, { type: "terminated", seq: 2 }, { type: "counted", seq: 2, survivors: 0 }], "link_out_of_order"],
    [
      [{ type: "hello" }, { type: "spawned", run_id: RUN }, { type: "output", run_id: RUN, data: "AAAA" }, { type: "exited", run_id: RUN, code: 0, signal: null, overflow: false, stdout_bytes: 4 }],
      "link_output_mismatch",
    ],
  ];
  for (const [messages, code] of cases) {
    expect(codeOf(() => new AgentDecoder().push(concat(...messages.map(encodeAgent)))), JSON.stringify(messages)).toBe(code);
  }
  // 상한을 넘는 stdout.
  const small = new AgentDecoder(4);
  expect(codeOf(() => small.push(concat(hello, encodeAgent({ type: "spawned", run_id: RUN }), ...outputMessages(RUN, new Uint8Array(5)).map(encodeAgent))))).toBe(
    "link_output_mismatch",
  );
});

test("링크 크기: 봉투 상한을 넘는 접두, 값 상한을 넘는 값 틀은 버퍼를 잡기 전에 거절하고, 제어 쪽은 값 틀을 받지 않는다", () => {
  const tooLarge = new Uint8Array(4);
  new DataView(tooLarge.buffer).setUint32(0, 64 * 1024 + 1, false);
  expect(codeOf(() => new ControlDecoder().push(tooLarge))).toBe("frame_too_large");
  const bigValue = new Uint8Array(4);
  new DataView(bigValue.buffer).setUint32(0, CREDENTIAL_MAX_BYTES + 1, false);
  bigValue[0] = 0x01;
  expect(codeOf(() => new ControlDecoder().push(bigValue))).toBe("frame_credential_too_large");
  const credentialFrame = encodeCredentialFrame(RUN, SECRET_DIGEST, secretBytes());
  if (!credentialFrame.ok) throw new Error("encode");
  const agentSide = new AgentDecoder();
  agentSide.push(encodeAgent({ type: "hello" }));
  expect(codeOf(() => agentSide.push(credentialFrame.frame))).toBe("frame_too_large");
  // 한 메시지에 실리는 stdout 조각은 봉투 상한 안이다.
  expect(encodeAgent(outputMessages(RUN, new Uint8Array(OUTPUT_CHUNK_BYTES))[0]!).length).toBeLessThanOrEqual(4 + 64 * 1024);
});

test("링크 차례(제어 → 대리): terminate·count는 seq 하나를 함께 쓰고, 같거나 작은 seq는 거절한다", () => {
  const terminate = (seq: number) => encodeControl({ type: "terminate", seq });
  const count = (seq: number) => encodeControl({ type: "count", seq });
  expect(new ControlDecoder().push(concat(count(1), terminate(2), count(5))).map((message) => message.type)).toEqual(["count", "terminate", "count"]);
  for (const [first, second] of [
    [count(7), terminate(7)],
    [terminate(7), count(7)],
    [terminate(3), terminate(2)],
  ]) {
    const decoder = new ControlDecoder();
    expect(decoder.push(first!)).toHaveLength(1);
    expect(codeOf(() => decoder.push(second!))).toBe("link_out_of_order");
  }
  // 갱신은 seq를 쓰지 않는다.
  expect(new ControlDecoder().push(concat(count(1), encodeControl({ type: "renew", run_id: RUN, lease_until: T0 }), terminate(2)))).toHaveLength(3);
});

test("링크 크기(대리 → 제어): output 한 조각의 원 바이트는 OUTPUT_CHUNK_BYTES 이하이고, 보내는 쪽과 받는 쪽이 같은 경계로 거절한다", () => {
  const output = (bytes: number) => ({ type: "output" as const, run_id: RUN, data: Buffer.from(new Uint8Array(bytes)).toString("base64") });
  const opened = () => {
    const decoder = new AgentDecoder();
    decoder.push(concat(encodeAgent({ type: "hello" }), encodeAgent({ type: "spawned", run_id: RUN })));
    return decoder;
  };
  expect(opened().push(encodeAgent(output(OUTPUT_CHUNK_BYTES)))).toHaveLength(1);
  // 덧붙임이 1·2개인 길이에서도 원 바이트로 센다.
  expect(opened().push(encodeAgent(output(OUTPUT_CHUNK_BYTES - 1)))).toHaveLength(1);
  expect(opened().push(encodeAgent(output(OUTPUT_CHUNK_BYTES - 2)))).toHaveLength(1);
  expect(codeOf(() => encodeAgent(output(OUTPUT_CHUNK_BYTES + 1)))).toBe("link_bad_message");
  expect(codeOf(() => opened().push(json({ v: 1, ...output(OUTPUT_CHUNK_BYTES + 1) })))).toBe("link_bad_message");
});

test("링크 인코더: 타입 밖의 종류는 두 인코더 모두 받는 쪽과 같은 사유로 거절한다", () => {
  expect(codeOf(() => encodeControl({ type: "outside" } as never))).toBe("link_unknown_message");
  expect(codeOf(() => encodeAgent({ type: "outside" } as never))).toBe("link_unknown_message");
  expect(codeOf(() => encodeControl({ type: "count" } as never))).toBe("link_bad_message");
});

test("자격: 디코딩한 값과 거절·오류의 진단에 값의 글이 실리지 않는다(직렬화·문자열·inspect)", () => {
  const decoder = new ControlDecoder();
  const [start] = decoder.push(startBytes());
  for (const shown of [JSON.stringify(start), String((start as { credential: CredentialValue }).credential), Bun.inspect(start)]) {
    expect(shown.includes(SECRET)).toBe(false);
  }
  // 지문과 다른 값(값의 글을 앞머리로 품은 값): 받는 쪽 오류에 값이 없다.
  const errors: unknown[] = [];
  try {
    new ControlDecoder().push(startBytes({}, new TextEncoder().encode(`${SECRET}-other`)));
  } catch (error) {
    errors.push(error);
  }
  expect(errors).toHaveLength(1);
  for (const error of errors) {
    expect(error instanceof LinkError).toBe(true);
    expect((error as LinkError).code).toBe("link_credential_mismatch");
    for (const shown of [String(error), JSON.stringify(error), Bun.inspect(error), (error as Error).stack ?? ""]) expect(shown.includes(SECRET)).toBe(false);
  }
  // 거절과 같은 step에서 앞서 짝지은 start의 값은 내보내지 않고 0으로 채운다.
  const mixed = new ControlDecoder();
  expect(codeOf(() => mixed.push(concat(startBytes(), json({ v: 1, type: "nope" }))))).toBe("link_unknown_message");
});
