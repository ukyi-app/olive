// 감독의 서명 키 하나로 박자·답 줄의 Signer(dispatch/ports.ts)와 연결 서버의 ReplyTools(connections.ts)를 만든다. 설명 문서는 boot.md다.
// 키는 진입점이 한 번 읽은 PEM 바이트로 받아 여기서 KeyObject로 바꾸고, 그 객체는 이 모듈의 닫힘 안에만 둔다(내보내지 않는다).
// 요청 ID·nonce는 주입받은 CSPRNG(Random)에서만 만든다. 난수를 직접 부르지 않는다.
import { createPrivateKey, type KeyObject } from "node:crypto";
import { sealEnvelope } from "../../contract/v1/index.ts";
import { newUuid } from "../dispatch/envelopes.ts";
import type { Random, Signer } from "../dispatch/ports.ts";
import type { ReplyTools } from "../transport/connections.ts";

export class SigningKeyError extends Error {
  constructor(readonly reason: "unreadable" | "not_ed25519" | "not_private") {
    super(`감독 서명 키를 쓸 수 없다(${reason})`);
    this.name = "SigningKeyError";
  }
}

export interface SupervisorSigning {
  readonly signer: Signer;
  readonly reply: ReplyTools;
}

const NONCE_BYTES = 16;
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// 서명 키의 꼴을 기동 때 한 번 본다. 틀린 키로 서버를 열면 맞춤 답의 봉하기가 연결마다 실패하고 실행기는 다시 붙기를 되풀이한다.
export function createSigning(privateKeyPem: string, random: Random): SupervisorSigning {
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new SigningKeyError("unreadable");
  }
  if (key.type !== "private") throw new SigningKeyError("not_private");
  if (key.asymmetricKeyType !== "ed25519") throw new SigningKeyError("not_ed25519");
  const signer: Signer = { seal: (input) => sealEnvelope(input, key) };
  const reply: ReplyTools = {
    seal: (input) => sealEnvelope(input, key),
    // 난수를 얻지 못하면 던진다. 연결 판단이 그 맞춤에 답하지 않는다(지어낸 ID로 대신하지 않는다).
    requestId() {
      const id = newUuid(random);
      if (id === null) throw new Error("random_unavailable");
      return id;
    },
    nonce() {
      const bytes = random.bytes(NONCE_BYTES);
      if (!(bytes instanceof Uint8Array) || bytes.length !== NONCE_BYTES) throw new Error("random_unavailable");
      return hex(bytes);
    },
  };
  return { signer, reply };
}
