// 자격 값의 우편함. 소켓이 맞춘 지금 연결에서 받은 값 틀을 넣고(offer), 작업자가 그 실행의 값을 한 번 꺼낸다(take).
// 설명과 규칙의 근거는 credential-inbox.md에 있다.
//
// - 칸은 하나다. 값은 받은 연결 번호와 함께 두고, 실행 ID·지문·연결 번호가 모두 맞을 때만 한 번 내준다.
// - 버리는 값은 모두 그 자리에서 0으로 채운다. 내준 값도 기억해 두었다가 그 실행을 잊을 때·중단될 때·연결이 끝날 때 0으로 채운다
//   (작업자가 쓰고 0으로 채운 뒤라 대개 이미 0이다. 중단과 내주기가 겹쳐 작업자가 받지 못한 값을 남기지 않으려는 것이다).
// - 값과 실행 ID·지문은 # 비공개 필드에만 둔다. TypeScript의 private은 런타임에 보통 속성이라 JSON.stringify·Object.keys에 나온다.
// - 시계·난수를 쓰지 않는다. 연결 번호는 주입받은 함수로만 읽는다.
import type { DecodedCredential } from "../transport/framing.ts";
import type { CredentialSource } from "./profile.ts";

export interface CredentialInboxOptions {
  // 지금 맞춘 연결의 번호(link.epoch()). 맞춘 연결이 없으면 null. 던지면 null로 본다.
  // offer·take·dropEpoch 안에서만 부르므로 link를 우편함보다 뒤에 만들어도 된다.
  readonly epoch: () => number | null;
}

// offer가 값을 어떻게 했는지. 값은 싣지 않는다.
//   handed: 기다리던 take에 내줬다. held: 칸에 두었다. discarded: 0으로 채워 버렸다.
export type OfferOutcome = "handed" | "held" | "discarded";

export interface CredentialInbox extends CredentialSource {
  // 소켓이 맞춘 지금 연결에서 받은 값 틀을 넘긴다. 받은 뒤 그 값의 소유는 우편함에 있다(부른 쪽은 그 배열을 다시 쓰지 않는다).
  offer(epoch: number, credential: DecodedCredential): OfferOutcome;
  // 그 연결이 끝났다. 그 연결에서 받은 값을 버리고, 그 연결에서 기다리던 take는 null로 끝낸다. 던지지 않는다.
  dropEpoch(epoch: number): void;
  // 그 실행이 끝났다. 그 실행의 기다림·칸·내준 값을 버리고, 뒤에 온 그 실행의 값은 곧바로 버린다. 던지지 않는다.
  // 한 실행에 한 번 내주는 것은 작업자가 같은 실행 ID로 다시 take하지 않는다는 전제에 기댄다(credential-inbox.md).
  forget(runId: string): void;
}

export function createCredentialInbox(options: CredentialInboxOptions): CredentialInbox {
  return new Inbox(options.epoch);
}

interface Held {
  readonly runId: string;
  readonly digest: string;
  readonly epoch: number;
  readonly value: Uint8Array;
}

// take 하나. 기다리는 동안 resolve가 있고, 내주거나 null로 끝나면 resolve가 null이다.
interface Taking {
  readonly runId: string;
  readonly digest: string;
  // take를 부른 때의 맞춘 연결. 작업자는 그 실행을 접수한 연결이 지금 연결일 때만 take를 부른다.
  readonly epoch: number;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  resolve: ((value: Uint8Array | null) => void) | null;
  lent: Uint8Array | null;
}

const wipe = (value: Uint8Array | null) => value?.fill(0);

class Inbox implements CredentialInbox {
  readonly #epoch: () => number | null;
  #held: Held | null = null;
  #taking: Taking | null = null;
  // 값을 더 받지 않는 실행(내줬거나, take가 끝났거나, 잊은 실행). 마지막 하나만 기억한다.
  #closedRun: string | null = null;

  constructor(epoch: () => number | null) {
    this.#epoch = epoch;
  }

  take(runId: string, digest: string, signal: AbortSignal): Promise<Uint8Array | null> {
    // 실행 슬롯은 하나라 기다리는 take도 하나다. 둘째는 곧바로 null이고 앞 take와 칸을 건드리지 않는다.
    if (this.#taking?.resolve) return Promise.resolve(null);
    // 한 실행에는 한 번만 내준다.
    if (runId === this.#closedRun) return Promise.resolve(null);
    this.#retire();
    const epoch = this.#current();
    if (signal.aborted || epoch === null) {
      this.#closeRun(runId);
      return Promise.resolve(null);
    }
    const held = this.#held;
    if (held !== null) {
      this.#held = null;
      if (held.runId === runId && held.digest === digest && held.epoch === epoch) {
        this.#lend(runId, digest, epoch, signal, held.value);
        return Promise.resolve(held.value);
      }
      // 이 실행의 것이 아니거나 지문·연결이 다르다. 지금 실행 슬롯 아래에서는 쓰일 곳이 없다.
      wipe(held.value);
    }
    return new Promise((resolve) => {
      const taking: Taking = { runId, digest, epoch, signal, onAbort: () => this.#abortTaking(taking), resolve, lent: null };
      this.#taking = taking;
      signal.addEventListener("abort", taking.onAbort, { once: true });
    });
  }

  offer(epoch: number, credential: DecodedCredential): OfferOutcome {
    const { runId, digest, value } = credential;
    if (runId === this.#closedRun || epoch !== this.#current()) return this.#discard(value);
    const taking = this.#taking;
    if (taking?.resolve) {
      // 기다리는 실행의 첫 일치만 쓴다. 다른 실행의 값은 지금 실행 슬롯 아래에서 쓰일 곳이 없고,
      // 같은 실행이라도 지문·연결이 다르면 버리고 계속 기다린다.
      if (runId !== taking.runId || digest !== taking.digest || epoch !== taking.epoch) return this.#discard(value);
      const resolve = taking.resolve;
      taking.resolve = null;
      taking.lent = value;
      this.#closedRun = runId;
      resolve(value);
      return "handed";
    }
    const held = this.#held;
    // 같은 연결에서 같은 실행의 값이 이미 칸에 있으면 먼저 온 것을 둔다.
    if (held !== null && held.runId === runId && held.epoch === epoch) return this.#discard(value);
    // 다른 실행의 값(또는 옛 연결의 값)이 새로 오면 앞 것을 버린다.
    wipe(held?.value ?? null);
    this.#held = { runId, digest, epoch, value };
    return "held";
  }

  dropEpoch(epoch: number): void {
    if (this.#held?.epoch === epoch) {
      wipe(this.#held.value);
      this.#held = null;
    }
    if (this.#taking?.epoch === epoch) this.#closeRun(this.#taking.runId);
  }

  forget(runId: string): void {
    this.#closeRun(runId);
    if (this.#taking?.runId === runId) this.#retire();
  }

  // 그 실행의 값을 더 받지 않는다: 기다리던 take를 null로 끝내고, 칸과 내준 값을 0으로 채운다.
  #closeRun(runId: string): void {
    this.#closedRun = runId;
    if (this.#held?.runId === runId) {
      wipe(this.#held.value);
      this.#held = null;
    }
    const taking = this.#taking;
    if (taking === null || taking.runId !== runId) return;
    const resolve = taking.resolve;
    taking.resolve = null;
    wipe(taking.lent);
    resolve?.(null);
  }

  // 칸의 값을 내준다. 중단·연결의 끝·잊기에 그 배열을 다시 0으로 채우도록 기억한다.
  #lend(runId: string, digest: string, epoch: number, signal: AbortSignal, value: Uint8Array): void {
    const taking: Taking = { runId, digest, epoch, signal, onAbort: () => this.#abortTaking(taking), resolve: null, lent: value };
    this.#taking = taking;
    this.#closedRun = runId;
    signal.addEventListener("abort", taking.onAbort, { once: true });
  }

  // 중단 콜백은 자기를 설치한 take가 아직 지금 기록일 때만 닫는다. 치운 뒤 떼지 못한 옛 콜백이 늦게 불려
  // #closedRun을 덮으면, 앞서 닫은 다음 실행의 늦은 값이 칸에 들어가 그 뒤 실행의 값을 밀어낸다.
  #abortTaking(taking: Taking): void {
    if (this.#taking === taking) this.#closeRun(taking.runId);
  }

  // 끝난 take의 기록을 치운다(내준 값은 0으로). 기다리는 take는 치우지 않는다.
  // forget이 주입받은 것을 부르는 자리는 이 리스너 떼기뿐이라, 정리를 마친 뒤에 두고 그 던짐을 삼킨다: forget은 던지지 않고
  // 정리를 끝낸다.
  #retire(): void {
    const taking = this.#taking;
    if (taking === null || taking.resolve !== null) return;
    wipe(taking.lent);
    this.#taking = null;
    try {
      taking.signal.removeEventListener("abort", taking.onAbort);
    } catch {
      // 떼지 못한 리스너는 늦게 불려도 이 기록이 지금 #taking이 아니므로 아무 상태도 바꾸지 않는다(#abortTaking).
      // 이 take의 내준 값은 이미 0이다
    }
  }

  #discard(value: Uint8Array): OfferOutcome {
    wipe(value);
    return "discarded";
  }

  #current(): number | null {
    try {
      return this.#epoch();
    } catch {
      return null;
    }
  }
}
