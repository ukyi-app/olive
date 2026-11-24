// 감독의 발급 문과 종료 차례. 자격 값 보내기(dispatch/credential-send.ts)를 같은 서버·장부·시계로 만들어 답 줄에 잇고, 순서기의 발급
// 깃발(cycle.ts의 issuanceOpen)을 내보내기 포트와 자격 값 보내기의 마지막 확인(lastCheck)에 잇고, 종료를 "발급 닫기 → 서버 닫기"
// 차례로 한다. 설명 문서는 issuance.md다.
//
// 이 파일이 지키는 것:
// 1. 답 줄이 넘긴 영수증(장부가 받은 것)은 그대로 송신기의 onReceipt로, 철회는 forgetConnection으로 간다. 송신기는 이 객체가 하나만 만든다.
// 2. 깃발이 서면 자격 값의 읽기 앞 확인과 lastCheck가 접수 닫힘(intake_closed)으로 막는다. 깃발을 읽는 것은 읽기뿐이다(상태를 쓰지 않는다).
// 3. shutdown()은 closeIssuance()가 돌아온 뒤에만 server.close()를 부른다. 몇 번 불러도 닫기는 한 번이다.
// 시계·난수·타이머·소켓을 직접 쓰지 않는다. 모두 포트로 받는다.
import type { CredentialFiles, CredentialRefPolicy } from "../accounts/credential-ref.ts";
import { type CredentialSendGate, type CredentialSendLedger, type CredentialSendNote, type CredentialSendServer, createCredentialSender } from "../dispatch/credential-send.ts";
import type { Clock } from "../dispatch/ports.ts";
import type { ConnectionServer } from "../transport/server.ts";
import type { AnswerCredentials } from "./answers.ts";
import type { Cycle } from "./cycle.ts";
import type { PublishedRestorer } from "./sink.ts";

export interface IssuancePorts {
  // 그 순서기. 박자들과 같은 객체다.
  readonly cycle: Pick<Cycle, "issuanceOpen" | "closeIssuance">;
  // 영수증이 온 그 연결 서버. 자격 값 틀의 쓰기와 종료의 닫기에 쓴다.
  readonly server: CredentialSendServer & Pick<ConnectionServer, "close">;
  // 서버·내보내기 포트·답 줄에 넘긴 그 복원기 게시 함수. 부를 때마다 지금 게시된 복원기를 읽는다.
  readonly restorer: PublishedRestorer;
  // 답 줄(handleForward)이 쓴 그 장부 객체의 동기 읽기.
  readonly ledger: CredentialSendLedger;
  // 장부와 같은 공유 시계.
  readonly clock: Clock;
  readonly files: CredentialFiles;
  // 계정 폴더 정책(maxBytes ≤ CREDENTIAL_MAX_BYTES).
  readonly policy: CredentialRefPolicy;
  // 기록용. 동기 기록기여야 한다. 던져도 무시한다. 값과 틀은 싣지 않는다(이름·연결 번호·실행 ID뿐).
  readonly observe?: (note: IssuanceNote) => void;
}

export type IssuanceNote =
  // 송신기의 기록 그대로(attempt, wiped).
  | { readonly kind: "credential"; readonly note: CredentialSendNote }
  // 송신기가 계약 밖으로 거절된 약속을 냈다. 값 버퍼의 정리는 송신기의 일이라 여기서는 알 수 없다.
  | { readonly kind: "credential_rejected"; readonly connection: number }
  | { readonly kind: "shutdown"; readonly step: "issuance_closed" | "server_closed" | "server_close_failed" };

export interface Issuance {
  // 내보내기 포트(sink.ts)의 issuanceOpen 칸에 넘긴다.
  readonly issuanceOpen: () => boolean;
  // 답 줄(answers.ts)의 credentials 칸에 넘긴다.
  readonly credentials: AnswerCredentials;
  // 발급을 닫고(진행 중인 박자가 돌아오기를 기다린다) 그다음 서버를 닫는다. 박자 안의 포트에서 기다리면 그 박자가 끝나지 않는다.
  shutdown(): Promise<void>;
}

export function createIssuance(ports: IssuancePorts): Issuance {
  const record = (note: IssuanceNote): void => {
    try {
      ports.observe?.(note);
    } catch {
      // 기록이 던져도 보내기와 종료는 그대로다.
    }
  };

  // 깃발은 순서기에서만 읽는다. 읽다 던지면 닫힌 것으로 본다(모름을 열림으로 읽지 않는다).
  const issuanceOpen = (): boolean => {
    try {
      return ports.cycle.issuanceOpen() === true;
    } catch {
      return false;
    }
  };

  // 송신기의 복원기 문. 정지 세대는 게시된 복원기 그대로, 접수는 깃발이 내려가면 닫힘이다. 깃발을 먼저 본다: 닫혔으면 복원기를 읽지 않는다.
  const gate: CredentialSendGate = {
    stopGeneration: () => ports.restorer().stopGeneration(),
    intakeOpen: () => issuanceOpen() && ports.restorer().intakeOpen() === true,
  };

  const sender = createCredentialSender({
    server: ports.server,
    ledger: ports.ledger,
    gate,
    clock: ports.clock,
    files: ports.files,
    policy: ports.policy,
    observe: (note) => record({ kind: "credential", note }),
  });

  const credentials: AnswerCredentials = {
    onReceipt(forward, outcome) {
      // 기다리지 않는다. 결과는 송신기의 attempt 기록으로 남는다. 송신기는 거절하지 않지만, 거절이 처리되지 않은 채 남지 않게 받아 둔다.
      sender.onReceipt(forward, outcome).catch(() => record({ kind: "credential_rejected", connection: forward.connection }));
    },
    forgetConnection(connection) {
      sender.forgetConnection(connection);
    },
  };

  let closing: Promise<void> | null = null;
  const close = async (): Promise<void> => {
    // closeIssuance는 첫 기다림 전에 깃발을 세우므로, 이 줄이 돌면 그 뒤의 lastCheck는 모두 막힌다. 돌아오는 것은 진행 중인 박자가 끝난 뒤다.
    await ports.cycle.closeIssuance();
    record({ kind: "shutdown", step: "issuance_closed" });
    try {
      await ports.server.close();
    } catch (error) {
      record({ kind: "shutdown", step: "server_close_failed" });
      throw error;
    }
    record({ kind: "shutdown", step: "server_closed" });
  };

  return {
    issuanceOpen,
    credentials,
    shutdown(): Promise<void> {
      if (closing === null) closing = close();
      return closing;
    },
  };
}
