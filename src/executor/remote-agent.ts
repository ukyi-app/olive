// 제어 컨테이너(실행기)가 역할 컨테이너의 대리(src/agent/)를 링크로 부리는 원격 Launcher·ProcessCleanup·RunSpace.
// worker.ts는 이 셋을 지금의 같은 컨테이너 구현(bunLauncher, PidSpace.record)과 똑같이 받는다. 링크의 말은 agent/link.ts 그대로다.
//
// 지키는 것(대조 표와 까닭은 remote-agent.md):
// - survivors()가 0을 돌려주는 때는 하나다: 믿는 연결에서, 시작 응답을 기다리는 중도 실행 중도 아닌 단계(대기, 또는 끝남)에서 새로 보낸
//   count의 답이 보낸 때와 같은 단계에서 replyWaitMs 안에 왔고, 그 count보다 먼저 보낸 가장 최근의 terminate도 replyWaitMs 안에 답했고,
//   그 답이 0이다. 그 밖은 모두 null(모름)이다. "안에"는 받은 때의 주입 단조 시계로 잰다(타이머 콜백이 늦게 돌아도 같다).
// - 실행 중(시작을 보낸 뒤 그 실행이 0으로 닫히기 전) 링크가 끊기거나, 연결이 살아 있는데 두 번째 연결이 오거나, 링크가 계약 밖의 말을
//   하면 이 객체는 대리를 다시 믿지 않는다(잠금). 잠긴 뒤에는 0을 말하지 않고 띄우지도 않는다. 새 hello로 풀리지 않는다.
//   제어는 새 대리의 hello와 옛 공간에 남은 프로세스가 연 연결을 말로 가를 수 없기 때문이다. 회복은 이 파일 밖의 일이다
//   (처음 잠기는 순간 onDistrust로 조립에 알린다. 조립은 파드 전체 재시작을 부른다, runtime.ts).
// - terminated는 0의 증거가 아니다. terminate()는 끝났다는 사실만 알리고 남은 수는 언제나 survivors()가 따로 묻는다.
// - 정리(space().clean)가 true인 때는 하나다: 믿는 연결에서, 대기 단계이고 기다리는 terminate·clean이 없을 때 새로 보낸 clean의 답이
//   보낸 때와 같은 단계에서 replyWaitMs 안에 왔고 남은 항목이 0이다(D-146·D-153). 그 밖은 false이고 요청은 답이나 연결 끝까지 쥔다.
// - 서명하지 않는다. 대리의 답은 서명 없는 사실이고 영수증은 worker가 자기 키로 낸다.
// - 자격 값은 start 바로 뒤의 값 틀 하나에만 싣는다. 오류·관측(state)에는 사유 이름만 둔다. 보낸 뒤 값과 틀의 바이트를 0으로 채운다.
// 시계·타이머는 주입받는다. 소켓을 직접 열지 않는다(연결은 agent-listener.ts가 connect로 넘긴다).
import { createHash } from "node:crypto";
import { AgentDecoder, type AgentMessage, encodeControl, OUTPUT_MAX_BYTES, type RunId, type StartMessage } from "../agent/link.ts";
import { encodeCredentialFrame } from "../transport/framing.ts";
import type { ProcessCleanup } from "./containment.ts";
import { ExitUnconfirmed, LaunchFailed, type Launcher, type LaunchHooks, type LaunchOutcome, type SpawnedChild } from "./launcher.ts";
import type { LaunchPlan } from "./profile.ts";
import type { RunSpace } from "./worker.ts";

// 연결 하나의 쓰기와 닫기. write는 넘긴 버퍼를 돌아온 뒤 쥐지 않는다(다 못 쓴 나머지는 구현이 자기 사본으로 쥔다). 실패하면 던진다.
export interface AgentLinkTransport {
  write(bytes: Uint8Array): void;
  close(): void;
}

export interface RemoteAgentRuntime {
  // ms 뒤에 한 번 부른다. 돌려준 함수로 취소한다.
  setTimer(ms: number, fire: () => void): () => void;
  // 단조 시계(ms). 응답 기한은 이 값으로 판정한다. 타이머 콜백은 기한보다 늦게 돌 수 있어 콜백만으로는 늦은 답을 가르지 못한다.
  // 함정: setTimer·worker의 상한 타이머와 같은 시간 기준이어야 하고, 벽시계(Date.now, worker의 now)를 넘기면 시각이 뛸 때 판정이 틀린다.
  now(): number;
}

// 시작 메시지에 실을 그 실행의 기한·임대 끝(에포크 밀리초). 조립은 실행기 저장소의 기록을 그대로 넘긴다.
export interface RunWindow {
  readonly deadline_at: number;
  readonly lease_until: number;
}

export interface RemoteAgentOptions {
  // 역할 프로필의 credentialEnv. 계획의 환경에서 이 이름의 값만 값 틀로 보내고 JSON의 env에서는 뺀다.
  credentialEnv: string;
  runWindow(runId: string): RunWindow | undefined;
  runtime: RemoteAgentRuntime;
  // 장부에 이 프로세스가 뜨기 전부터 끝을 맺지 못한 실행이 있고, 그 실행의 공간이 사라졌다는 따로 된 확인(파드 전체 재시작의 새 세대 표식 등)이
  // 없으면 true. 처음부터 잠근다: 그 실행을 지금 붙은 대리의 0으로 닫지 않는다.
  inheritedUnverified: boolean;
  // terminate·count·시작의 답을 증거로 받는 기한(ms, runtime.now 기준). worker의 exitWaitMs와 같은 값을 넘긴다.
  // 함정: 이보다 worker의 exitWaitMs가 짧으면 worker가 이미 버린 늦은 답을 여기서 증거로 받아 두 판단이 갈라진다.
  replyWaitMs: number;
  // 실행 중 임대 끝을 저장소와 맞춰 대리에게 renew로 보내는 간격.
  renewEveryMs?: number;
  // 처음 잠기는 순간 한 번 부른다(inheritedUnverified로 처음부터 잠근 객체는 부르지 않는다). 조립이 회복(D-104)을 시작하는 자리다.
  // 함정: 받는 처리 안에서 불린다. 이 안에서 원격을 다시 부르지 않는다(받은 쪽은 마이크로태스크로 미룬다).
  onDistrust?: (reason: DistrustReason) => void;
}

// 중단 뒤 끝을 기다리는 상한을 launcher 훅이 주지 않았을 때의 값(bunLauncher와 같다). worker는 언제나 값을 넘긴다.
const DEFAULT_EXIT_WAIT_MS = 10_000;

export type DistrustReason =
  | "inherited_unverified"
  | "second_connection"
  | "link_lost_mid_run"
  | "link_rejected"
  | "out_of_phase"
  | "unknown_reply"
  | "output_over_limit";

// 연결 하나의 받는 입구. 그 연결이 지금 연결이 아니면(닫혔거나 잠금) 받은 것을 버린다.
export interface AgentLinkSession {
  receive(chunk: Uint8Array): void;
  closed(): void;
}

// 관측용. 값·메시지 내용은 담지 않는다.
export interface RemoteAgentState {
  readonly connected: boolean;
  // 받아들인 연결의 수(연결 세대). 잠금으로 닫힌 연결은 세지 않는다.
  readonly generation: number;
  readonly greeted: boolean;
  readonly phase: Phase["kind"];
  readonly distrusted: DistrustReason | null;
}

// 연결이 없거나 잠겼다. terminate()가 이것으로 거절된다(worker와 launcher는 거절을 삼키고 남은 수를 따로 센다).
export class AgentUnavailable extends Error {
  constructor(readonly reason: "no_link" | DistrustReason) {
    super(reason);
  }
}

interface Sink {
  // 시작의 답이 기한 뒤에 왔다. 기한 타이머가 먼저 돈 것과 같게 띄우기를 끝낸다.
  lapsed(): void;
  spawned(): void;
  output(bytes: Uint8Array): void;
  exited(message: Extract<AgentMessage, { type: "exited" }>): void;
  failed(error: Error): void;
}

// 시작(start)을 보낸 실행의 단계. 대기(idle)로 돌아오는 길은 끝남 단계에서 새로 보낸 count의 0 하나다.
type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "starting"; readonly runId: RunId; readonly limit: number; readonly expiresAt: number; sink: Sink | null }
  | { readonly kind: "running"; readonly runId: RunId; readonly limit: number; bytes: number; sink: Sink | null }
  | { readonly kind: "ended"; readonly runId: RunId };

interface Connection {
  readonly transport: AgentLinkTransport;
  readonly decoder: AgentDecoder;
  greeted: boolean;
}

// 답을 기다리는 요청. 물리적 대기와 증거의 기한을 따로 쥔다:
// - 요청은 답이 오거나 그 연결이 끝날 때만 놓는다. 기한에서 먼저 놓으면 worker의 물리적 정리 예약이 대리 쪽 정리보다 먼저 풀려
//   다음 정리가 앞 정리와 겹친다고 볼 수 없게 된다.
// - 기한(replyWaitMs)이 지나면 late만 표시한다. 그 뒤에 온 답은 요청을 놓을 뿐 0의 근거·단계 전이에 쓰지 않는다.
//   늦음은 타이머 콜백과 받은 때의 시계(expiresAt) 둘로 본다. 콜백이 아직 돌지 않았어도 시계가 기한을 지났으면 늦은 답이다.
// 늦은 답도 이 요청의 답으로만 쓰이고 다른 요청의 답이 되지 않는다(seq가 다르다).
interface Pending {
  readonly kind: "terminate" | "count" | "clean";
  readonly connection: Connection;
  // count·clean: 보낸 때의 단계. 답이 올 때 같은 단계(같은 객체)여야 증거로 쓴다.
  readonly phase: Phase;
  // count만: 이 count보다 먼저 보낸 가장 최근의 terminate. 대리는 차례대로 답하므로 count의 답이 올 때 그 답은 이미 와 있어야 한다.
  readonly after: Pending | null;
  // 보낸 때의 runtime.now() + replyWaitMs. 이 시각 이상에 받은 답은 늦은 답이다.
  readonly expiresAt: number;
  late: boolean;
  // terminate만: 답이 왔다(기한과 무관하게).
  answered: boolean;
  cancelDeadline: () => void;
  readonly settle: (answer: number | null | "done" | AgentUnavailable) => void;
}

const IDLE: Phase = { kind: "idle" };
const utf8 = new TextEncoder();

export class RemoteAgent {
  private connection: Connection | null = null;
  private distrust: DistrustReason | null;
  private phase: Phase = IDLE;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private lastTerminate: Pending | null = null;
  private generation = 0;
  // 다음 띄우기에 쓸 실행 ID. RunSpace.prepare가 넣고 launcher가 한 번 꺼낸다.
  private prepared: RunId | null = null;
  private readonly renewEveryMs: number;

  constructor(private readonly options: RemoteAgentOptions) {
    this.distrust = options.inheritedUnverified ? "inherited_unverified" : null;
    this.renewEveryMs = options.renewEveryMs ?? 1_000;
  }

  state(): RemoteAgentState {
    return {
      connected: this.connection !== null,
      generation: this.generation,
      greeted: this.connection?.greeted ?? false,
      phase: this.phase.kind,
      distrusted: this.distrust,
    };
  }

  // ---- 연결 ----

  // 새 연결. 이미 연결이 있으면 두 번째 연결이므로 둘 다 닫고 잠근다. 잠긴 뒤의 연결은 바로 닫는다.
  connect(transport: AgentLinkTransport): AgentLinkSession | null {
    if (this.distrust !== null) {
      closeQuietly(transport);
      return null;
    }
    if (this.connection !== null) {
      closeQuietly(transport);
      this.lock("second_connection");
      return null;
    }
    const connection: Connection = { transport, decoder: new AgentDecoder(OUTPUT_MAX_BYTES), greeted: false };
    this.connection = connection;
    this.generation++;
    return {
      receive: (chunk) => this.receive(connection, chunk),
      closed: () => {
        if (this.connection !== connection) return;
        // 틀 중간의 끊김은 링크의 말이 잘린 것이다. 쉬는 동안이어도 디코더의 종료 검사를 거쳐 잠근다.
        try {
          connection.decoder.end();
        } catch {
          return this.lock("link_rejected");
        }
        this.drop();
      },
    };
  }

  private receive(connection: Connection, chunk: Uint8Array): void {
    if (this.connection !== connection) return;
    let messages: AgentMessage[];
    try {
      messages = connection.decoder.push(chunk);
    } catch {
      return this.lock("link_rejected");
    }
    for (const message of messages) {
      if (this.connection !== connection) return;
      this.handle(connection, message);
    }
  }

  private handle(connection: Connection, message: AgentMessage): void {
    const phase = this.phase;
    switch (message.type) {
      case "hello":
        connection.greeted = true;
        return;
      case "spawned":
        if (phase.kind !== "starting" || phase.runId !== message.run_id) return this.lock("out_of_phase");
        this.startLapsed(phase);
        this.phase = { kind: "running", runId: phase.runId, limit: phase.limit, bytes: 0, sink: phase.sink };
        return phase.sink?.spawned();
      case "not_spawned":
        if (phase.kind !== "starting" || phase.runId !== message.run_id) return this.lock("out_of_phase");
        this.startLapsed(phase);
        this.phase = { kind: "ended", runId: phase.runId };
        return phase.sink?.failed(new LaunchFailed(message.reason === "aborted" || message.reason === "cleanup_busy" ? message.reason : "spawn_failed"));
      case "output": {
        if (phase.kind !== "running" || phase.runId !== message.run_id) return this.lock("out_of_phase");
        const bytes = Buffer.from(message.data, "base64");
        phase.bytes += bytes.length;
        if (phase.bytes > phase.limit) {
          bytes.fill(0);
          return this.lock("output_over_limit");
        }
        if (phase.sink === null) return void bytes.fill(0);
        return phase.sink.output(bytes);
      }
      case "exited":
      case "unconfirmed":
        if (phase.kind !== "running" || phase.runId !== message.run_id) return this.lock("out_of_phase");
        this.phase = { kind: "ended", runId: phase.runId };
        if (message.type === "exited") return phase.sink?.exited(message);
        return phase.sink?.failed(new ExitUnconfirmed());
      case "terminated":
      case "counted":
      case "cleaned":
        return this.answer(message);
    }
  }

  // 답의 seq가 기다리는 요청과 종류까지 맞아야 한다. 보낸 적 없는(또는 이미 답을 받은) seq나 종류가 다른 답은 잠근다.
  private answer(message: Extract<AgentMessage, { type: "terminated" | "counted" | "cleaned" }>): void {
    const kind = message.type === "terminated" ? "terminate" : message.type === "counted" ? "count" : "clean";
    const waiting = this.pending.get(message.seq);
    if (waiting === undefined || waiting.kind !== kind) return this.lock("unknown_reply");
    this.pending.delete(message.seq);
    waiting.cancelDeadline();
    // 받은 때의 시계로 늦음을 고정한다. 뒤의 count가 이 terminate의 늦음을 볼 때도 이 판정을 쓴다.
    if (this.options.runtime.now() >= waiting.expiresAt) waiting.late = true;
    if (message.type === "terminated") {
      waiting.answered = true;
      return waiting.settle("done");
    }
    // 늦었거나 그 사이 단계가 바뀐 답은 요청만 놓는다. 보낸 뒤 시작이 나갔으면 그 0은 이 정리의 확인이 아니다.
    if (message.type === "cleaned") return waiting.settle(waiting.late || this.phase !== waiting.phase ? null : message.left);
    // 증거로 쓰지 못하는 답은 요청만 놓는다(물리적 대기의 끝). 단계(ended)와 연결은 그대로 두어, 같은 연결에서 새로 끝내고 센 답만
    // 그 실행을 닫고, 그 전에 끊기면 실행 중 끊김으로 잠근다(drop).
    if (!this.adoptable(waiting)) return waiting.settle(null);
    if (message.survivors === 0 && this.phase.kind === "ended") this.phase = IDLE;
    waiting.settle(message.survivors);
  }

  // count의 답을 증거로 쓸 수 있는가: 기한 안에 왔고, 보낸 뒤 단계가 바뀌지 않았고(그 사이 시작을 보냈거나 실행이 닫히지 않았고),
  // 앞선 가장 최근의 terminate가 기한 안에 답했다(그 정리가 늦게 끝났으면 뒤의 계수는 그 시도의 종료 증거가 아니다).
  private adoptable(waiting: Pending): boolean {
    if (waiting.late || this.phase !== waiting.phase) return false;
    const before = waiting.after;
    return before === null || (before.answered && !before.late);
  }

  // 기한이 지났는가. 답을 받은 요청은 받은 때의 판정(late)이고, 아직 기다리는 요청은 지금 시계로 본다.
  private lapsed(waiting: Pending): boolean {
    return waiting.late || (!waiting.answered && this.options.runtime.now() >= waiting.expiresAt);
  }

  // 시작의 답이 시작 기한 뒤에 왔으면 그 답으로 띄우기를 이어 가지 않는다(sink가 풀린다). 단계 전이는 받은 말대로 한다.
  private startLapsed(phase: Extract<Phase, { kind: "starting" }>): void {
    if (phase.sink !== null && this.options.runtime.now() >= phase.expiresAt) phase.sink.lapsed();
  }

  // 지금 연결을 닫는다. 시작을 보낸 뒤 0으로 닫히기 전이면 그 실행을 모름으로 두고 잠근다.
  private drop(): void {
    const connection = this.connection;
    if (connection === null) return;
    this.connection = null;
    closeQuietly(connection.transport);
    this.failPending(connection, new AgentUnavailable("no_link"));
    if (this.phase.kind !== "idle") this.lock("link_lost_mid_run");
  }

  // 한 번 잠그면 풀지 않는다. 첫 사유를 남긴다. 알림은 띄우기 실패와 연결 닫기를 마친 뒤에 한 번 부른다.
  private lock(reason: DistrustReason): void {
    const first = this.distrust === null;
    this.distrust ??= reason;
    const phase = this.phase;
    if ((phase.kind === "starting" || phase.kind === "running") && phase.sink !== null) {
      const sink = phase.sink;
      phase.sink = null;
      sink.failed(new ExitUnconfirmed());
    }
    if (this.connection !== null) this.drop();
    if (first) this.options.onDistrust?.(reason);
  }

  private failPending(connection: Connection, error: AgentUnavailable): void {
    for (const [seq, waiting] of this.pending) {
      if (waiting.connection !== connection) continue;
      this.pending.delete(seq);
      waiting.cancelDeadline();
      waiting.settle(waiting.kind === "terminate" ? error : null);
    }
  }

  private usable(): Connection | null {
    const connection = this.connection;
    return this.distrust === null && connection !== null && connection.greeted ? connection : null;
  }

  // 쓰기 실패는 연결 끊김과 같다.
  private write(connection: Connection, bytes: Uint8Array): boolean {
    try {
      connection.transport.write(bytes);
      return true;
    } catch {
      if (this.connection === connection) this.drop();
      return false;
    }
  }

  private request(kind: Pending["kind"]): Promise<number | null | "done" | AgentUnavailable> {
    const connection = this.usable();
    if (connection === null) return Promise.resolve(new AgentUnavailable(this.distrust ?? "no_link"));
    const seq = ++this.seq;
    const phase = this.phase;
    return new Promise((resolve) => {
      const waiting: Pending = {
        kind,
        connection,
        phase,
        after: kind === "count" ? this.lastTerminate : null,
        expiresAt: this.options.runtime.now() + this.options.replyWaitMs,
        late: false,
        answered: false,
        cancelDeadline: () => {},
        settle: resolve,
      };
      // 쓰기 전에 건다: 같은 호출 안에서 답이 오면 그때 취소한다. worker의 bounded보다 먼저 걸리므로 같은 길이면 먼저 울린다.
      waiting.cancelDeadline = this.options.runtime.setTimer(this.options.replyWaitMs, () => {
        waiting.late = true;
      });
      if (kind === "terminate") this.lastTerminate = waiting;
      this.pending.set(seq, waiting);
      // 쓰기에 실패하면 drop()이 이 요청을 거둔다.
      this.write(connection, encodeControl(kind === "terminate" ? { type: "terminate", seq } : kind === "count" ? { type: "count", seq } : { type: "clean", seq }));
    });
  }

  // ---- ProcessCleanup ----

  readonly cleanup: ProcessCleanup = {
    terminate: async () => {
      const answer = await this.request("terminate");
      if (answer instanceof AgentUnavailable) throw answer;
    },
    survivors: async () => {
      // 시작 응답을 기다리는 중이거나 실행 중이면 묻지 않는다. 대리가 띄우기 전 사전 계수를 기다리는 사이의 0, 프로그램이 끝나기 전의 중간 0은
      // 이 실행의 종료 증거가 아니다(대리가 그 뒤에 띄울 수 있고, 중간 0 뒤에 76으로 닫힐 수 있다).
      if (this.phase.kind === "starting" || this.phase.kind === "running") return null;
      // 가장 최근의 terminate가 이미 기한을 넘겼으면 이 시도의 계수는 0의 근거가 되지 못한다. 묻지 않는다.
      if (this.lastTerminate !== null && this.lapsed(this.lastTerminate)) return null;
      const answer = await this.request("count");
      return typeof answer === "number" || answer === null ? answer : null;
    },
    busy: () => [...this.pending.values()].some((waiting) => waiting.kind === "terminate"),
  };

  private sweeping(): boolean {
    return [...this.pending.values()].some((waiting) => waiting.kind === "clean");
  }

  // 대리에게 작업 공간을 비우고 세게 한다. 실행 중이거나 끝을 맺지 못한 단계(starting·running·ended)면 묻지 않는다: 그 실행의 파일을
  // 지우면 안 되고, 끝내기의 답을 기다리는 중이면 그 정리가 끝나기 전이다. 기다리는 clean이 있으면 새로 보내지 않는다(그 답이 아직 오는 중이다).
  // 기한(replyWaitMs)에 false로 돌아간다: worker는 이 호출에 상한을 걸지 않고 정리 슬롯을 쥐므로, 여기서 끊어야 감독의 확정 재전송이 다시 부른다.
  private async sweep(): Promise<boolean> {
    if (this.phase.kind !== "idle" || this.cleanup.busy() || this.sweeping()) return false;
    let cancel: () => void = () => {};
    const lapsed = new Promise<null>((resolve) => (cancel = this.options.runtime.setTimer(this.options.replyWaitMs, () => resolve(null))));
    const answer = await Promise.race([this.request("clean"), lapsed]);
    cancel();
    return answer === 0;
  }

  // ---- RunSpace ----

  // 제어 쪽 폴더 준비·지우기는 inner가 한다. 준비가 끝난 실행 ID를 다음 띄우기의 링크 실행 ID로 남긴다(worker는 준비 → 자격 → 띄우기 차례로 부른다).
  // 지우기는 inner가 끝난 뒤 대리의 작업 공간 정리(sweep)까지 확인돼야 true다.
  space(inner: RunSpace): RunSpace {
    return {
      prepare: async (runId, signal) => {
        await inner.prepare(runId, signal);
        // 중단된 준비가 늦게 끝나면 다른 실행의 ID를 덮지 않는다.
        if (!signal.aborted) this.prepared = runId;
      },
      clean: async (runId) => (await inner.clean(runId)) && (await this.sweep()),
    };
  }

  // ---- Launcher ----

  readonly launcher: Launcher = {
    run: (plan, signal, hooks) => this.launch(plan, signal, hooks),
  };

  private launch(plan: LaunchPlan, signal: AbortSignal, hooks: LaunchHooks): Promise<LaunchOutcome> {
    if (signal.aborted) return Promise.reject(new LaunchFailed("aborted"));
    if (hooks.busy() || this.sweeping()) return Promise.reject(new LaunchFailed("cleanup_busy"));
    const runId = this.prepared;
    this.prepared = null;
    const connection = this.usable();
    const window = runId === null ? undefined : this.options.runWindow(runId);
    if (runId === null || connection === null || this.phase.kind !== "idle" || window === undefined) return Promise.reject(new LaunchFailed("spawn_failed"));
    const frames = this.startFrames(runId, plan, hooks.outputBytes, window);
    if (frames === null) return Promise.reject(new LaunchFailed("spawn_failed"));

    return new Promise<LaunchOutcome>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      let finished = false;
      let giveUp: (() => void) | undefined;
      let cancelStartWait: () => void = () => {};
      let cancelRenew: () => void = () => {};
      let markExited!: () => void;
      const exited = new Promise<void>((done) => (markExited = done));
      // 시작 기한은 쓰기 전에 잡는다: 쓰는 동안 같은 호출 안에서 온 답도 이 기한으로 판정한다.
      const phase: Extract<Phase, { kind: "starting" }> = {
        kind: "starting",
        runId,
        limit: hooks.outputBytes,
        expiresAt: this.options.runtime.now() + this.options.replyWaitMs,
        sink: null,
      };
      const finish = (outcome: LaunchOutcome | Error) => {
        if (finished) return;
        finished = true;
        giveUp?.();
        cancelStartWait();
        cancelRenew();
        signal.removeEventListener("abort", stop);
        const current = this.phase;
        if ((current.kind === "starting" || current.kind === "running") && current.runId === runId) current.sink = null;
        for (const chunk of chunks) chunk.fill(0);
        if (outcome instanceof Error) reject(outcome);
        else resolve(outcome);
      };
      // 원격 자식에는 이 컨테이너의 번호가 없다. 실수로 신호 함수에 넘겨도 던지게 NaN이다. 개별 신호는 보내지 않는다(끝내기는 terminate 하나).
      const child: SpawnedChild = { pid: Number.NaN, exited, signal: () => {} };
      // 시작의 답이 기한 안에 없었다: 끝내기를 보내고(중단으로 이미 보냈으면 다시 보내지 않는다) 띄웠는지 모르는 채 돌아간다.
      // 끝내기는 마이크로태스크로 미룬다: 받는 처리(handle) 안에서 불리면 그 안에서 링크에 다시 쓰게 되기 때문이다.
      const lapse = () => {
        if (giveUp === undefined) queueMicrotask(() => void hooks.terminate().catch(() => {}));
        finish(new ExitUnconfirmed());
      };
      phase.sink = {
        lapsed: lapse,
        spawned: () => hooks.spawned(child),
        output: (bytes) => {
          chunks.push(bytes);
          total += bytes.length;
        },
        exited: (message) => {
          markExited();
          hooks.exited?.();
          const stdout = new Uint8Array(message.overflow ? 0 : total);
          let offset = 0;
          if (!message.overflow) for (const chunk of chunks) stdout.set(chunk, (offset += chunk.length) - chunk.length);
          finish({ exit: { code: message.code, signal: message.signal }, stdout, overflow: message.overflow });
        },
        failed: (error) => finish(error),
      };
      // 중단되면 대리에게 끝내기를 보내고, 상한(exitWaitMs) 안에 끝을 듣지 못하면 확인하지 못한 채 돌아간다. 그 실행의 단계는 그대로 남는다.
      const stop = () => {
        void hooks.terminate().catch(() => {});
        giveUp ??= this.options.runtime.setTimer(hooks.exitWaitMs ?? DEFAULT_EXIT_WAIT_MS, () => finish(new ExitUnconfirmed()));
      };
      this.phase = phase;
      const written = this.write(connection, frames);
      frames.fill(0);
      if (!written) return finish(new ExitUnconfirmed());
      // 쓰는 동안 같은 호출 안에서 답이 와 이미 끝났을 수 있다(동기로 전달하는 상대). 그때는 감시를 걸지 않는다.
      if (finished) return;
      // 시작의 답(spawned·not_spawned)도 replyWaitMs 안에 와야 한다. 넘으면 끝내기를 보내고 띄웠는지 모르는 채 돌아간다
      // (worker는 띄우지 않은 실행으로 세고, 단계가 starting이라 계수는 null이다). 단계는 남아 늦은 답을 받는다.
      // 콜백이 늦게 돌아도 기한 뒤의 답은 startLapsed가 같은 길로 보낸다.
      // 함정: 타이머는 소수 밀리초를 내림해 기한 직전에 돌 수 있다. 콜백에서 시계를 다시 보고 기한 전이면 남은 시간을 올림해 다시 건다
      // (그대로 포기하면 기한 안에 온 정상 응답을 버린다). 올림이라 다시 거는 기다림은 1ms 이상이다.
      const watchStart = () => {
        if (this.phase !== phase) return;
        const left = phase.expiresAt - this.options.runtime.now();
        if (left > 0) cancelStartWait = this.options.runtime.setTimer(Math.ceil(left), watchStart);
        else lapse();
      };
      cancelStartWait = this.options.runtime.setTimer(Math.max(0, Math.ceil(phase.expiresAt - this.options.runtime.now())), watchStart);
      cancelRenew = this.renewLoop(runId, window.lease_until);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    });
  }

  // start 봉투 틀 + 값 틀을 한 버퍼로 만든다(두 틀 사이에 다른 쓰기가 끼지 않는다). 만들지 못하면 null이고 값은 0으로 채운다.
  private startFrames(runId: RunId, plan: LaunchPlan, outputBytes: number, window: RunWindow): Uint8Array | null {
    const name = this.options.credentialEnv;
    const credential = Object.hasOwn(plan.env, name) ? plan.env[name] : undefined;
    if (typeof credential !== "string") return null;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(plan.env)) if (key !== name) env[key] = value;
    const value = utf8.encode(credential);
    const digest = createHash("sha256").update(value).digest("hex");
    const start: StartMessage = {
      type: "start",
      run_id: runId,
      program: plan.program,
      argv: [...plan.argv],
      cwd: plan.cwd,
      env,
      credential_env: name,
      credential_digest: digest,
      output_bytes: outputBytes,
      deadline_at: window.deadline_at,
      lease_until: window.lease_until,
    };
    try {
      const envelope = encodeControl(start);
      const encoded = encodeCredentialFrame(runId, digest, value);
      if (!encoded.ok) return null;
      const frames = new Uint8Array(envelope.length + encoded.frame.length);
      frames.set(envelope, 0);
      frames.set(encoded.frame, envelope.length);
      encoded.frame.fill(0);
      return frames;
    } catch {
      return null;
    } finally {
      value.fill(0);
    }
  }

  // 시작 응답 전과 실행 중에만 저장소의 임대 끝이 늘면 renew로 보낸다.
  // 함정: 대리는 끝난 실행을 count의 0으로 닫고, 닫힌 실행의 renew를 계약 밖으로 본다(77). count는 끝남·대기 단계에서만 보내고(survivors)
  // renew는 그 전 단계에서만 보내므로, 링크의 차례상 renew가 count보다 뒤에 닿는 일이 없다.
  private renewLoop(runId: RunId, initialLease: number): () => void {
    let lease = initialLease;
    let cancel: () => void = () => {};
    const tick = () => {
      const phase = this.phase;
      if ((phase.kind !== "starting" && phase.kind !== "running") || phase.runId !== runId) return;
      const connection = this.usable();
      const window = this.options.runWindow(runId);
      if (connection !== null && window !== undefined && window.lease_until > lease) {
        lease = window.lease_until;
        if (!this.write(connection, encodeControl({ type: "renew", run_id: runId, lease_until: lease }))) return;
      }
      cancel = this.options.runtime.setTimer(this.renewEveryMs, tick);
    };
    cancel = this.options.runtime.setTimer(this.renewEveryMs, tick);
    return () => cancel();
  }
}

function closeQuietly(transport: AgentLinkTransport): void {
  try {
    transport.close();
  } catch {
    // 닫기 실패는 판단을 바꾸지 않는다(그 연결은 이미 믿지 않는다).
  }
}
