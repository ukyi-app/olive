// 봉투의 낸 쪽·받는 쪽 이름. 키는 주체마다 다르다(현관, 감독, 실행기 인스턴스마다).
//   supervisor
//   front-door
//   executor/<session|역할>/<인스턴스 ID>/<저장소 ID>
// 실행기 이름에 저장소 ID를 넣는 이유: 실행기의 저장소(nonce 기록 포함)가 새로 만들어지면 저장소 ID가 바뀌어,
// 옛 저장소 앞으로 낸 지시는 nonce 기록이 비어 있어도 받는 쪽이 달라 거절된다.
// 실행기 이름에 역할을 넣는 이유: task_start의 역할이 실행기의 고정 역할과 다르면 서명이 맞아도 거절한다.
import { type Role, isRole } from "./role.ts";

const SEGMENT = "[a-z0-9][a-z0-9-]{0,62}";
const EXECUTOR = new RegExp(`^executor/(session|[a-z_]+)/(${SEGMENT})/(${SEGMENT})$`);

export type Principal =
  | { kind: "supervisor" }
  | { kind: "front_door" }
  | { kind: "session_executor"; instance: string; storage: string }
  | { kind: "worker_executor"; role: Role; instance: string; storage: string };

export type PartyKind = Principal["kind"];

export function parsePrincipal(name: unknown): Principal | undefined {
  if (name === "supervisor") return { kind: "supervisor" };
  if (name === "front-door") return { kind: "front_door" };
  if (typeof name !== "string") return undefined;
  const match = EXECUTOR.exec(name);
  if (!match) return undefined;
  const [, slot, instance, storage] = match as unknown as [string, string, string, string];
  if (slot === "session") return { kind: "session_executor", instance, storage };
  return isRole(slot) ? { kind: "worker_executor", role: slot, instance, storage } : undefined;
}

export function executorName(slot: "session" | Role, instance: string, storage: string): string {
  const name = `executor/${slot}/${instance}/${storage}`;
  if (!parsePrincipal(name)) throw new Error(`실행기 이름이 계약의 꼴이 아니다: ${name}`);
  return name;
}
