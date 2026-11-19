// 효과 동작의 정지 세대·실행 세대 규칙과 그 판정. 세대는 머리가 아니라 본문 맨 위의 정해진 칸에 있고(body_digest로 서명에 묶인다),
// 받는 쪽이 문맥으로 주는 권위 값과 공통 검증기가 대조한다. 오래된 세대는 서명이 맞아도 거절한다(설계 §9.1).
// 인사와 조회는 세대를 싣지 않는다: 복원 1단계처럼 받는 쪽이 세대를 아직 모를 때도 오가야 하기 때문이다.
import type { RejectReason } from "./errors.ts";
import { generation, isPlainObject, type Parser } from "./schema.ts";

export const GENERATION_KINDS = ["stop", "execution"] as const;
export type GenerationKind = (typeof GENERATION_KINDS)[number];

// 세대 값이 실리는 본문 맨 위 칸. 묶음의 본문 해석기도 이 이름으로 받아야 한다(effectBody의 shape에 generation으로 넣는다).
export const GENERATION_FIELDS: Readonly<Record<GenerationKind, string>> = Object.freeze({
  stop: "stop_generation",
  execution: "execution_generation",
});

// 고를 수 있는 규칙의 닫힌 목록. 어느 동작이 어느 규칙인지는 묶음이 정한다. 목록에 없는 전이가 필요하면 여기에 더한다(후보).
// - not_applicable: 이 세대와 무관한 동작. 칸을 싣지 않는다(실으면 body_malformed: 검사되지 않는 세대 값이 처리기에 가지 않게).
// - current: 받는 쪽의 지금 세대와 같아야 한다. 일반 효과.
// - next: 지금 세대 + 1이어야 한다. 새 세대를 여는 준비(예: 새 정지의 준비).
// - newer: 지금 세대보다 커야 한다. 건너뛴 세대를 허용하는 준비.
// - prepared: 받는 쪽이 받아 둔 준비의 세대와 같아야 한다. 준비에 묶인 확정. 받아 둔 준비가 없으면 거절한다.
export const GENERATION_RULES = ["not_applicable", "current", "next", "newer", "prepared"] as const;
export type GenerationRule = (typeof GENERATION_RULES)[number];

// 효과 동작이 등록할 때 반드시 두는 선언. 두 세대 각각에 규칙 하나.
export type GenerationRules = Readonly<Record<GenerationKind, GenerationRule>>;

// 받는 쪽이 아는 권위 값. 모르면 { known: false }다(예: 감독이 복원 1단계를 끝내기 전의 정지 세대).
// prepared는 받아 두고 아직 확정하지 않은 준비의 세대, 없으면 null.
export type GenerationAuthority = { known: false } | { known: true; current: number; prepared: number | null };
export type GenerationAuthorities = Readonly<Record<GenerationKind, GenerationAuthority>>;

export function isGenerationRules(value: unknown): value is GenerationRules {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== GENERATION_KINDS.length || !GENERATION_KINDS.every((kind) => keys.includes(kind))) return false;
  return GENERATION_KINDS.every((kind) => (GENERATION_RULES as readonly unknown[]).includes(value[kind]));
}

// 규칙이 요구하는 세대 칸의 해석기. 묶음은 effectBody({ ...업무 칸, ...generationShape(rules) })로 본문 해석기를 만든다.
// 규칙과 해석기의 칸이 어긋나면 그 동작은 늘 거절되므로(칸이 없으면 generation_missing, 남으면 unknown_field) 묶음의 통과 시험이 잡는다.
export function generationShape(rules: GenerationRules): Record<string, Parser<number>> {
  const shape: Record<string, Parser<number>> = {};
  for (const kind of GENERATION_KINDS) if (rules[kind] !== "not_applicable") shape[GENERATION_FIELDS[kind]] = generation;
  return shape;
}

const isGeneration = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

// 칸의 있고 없음과 꼴. 받는 쪽의 상태가 필요 없어서 만들 때(seal)도 쓴다.
export function generationFieldFault(rules: GenerationRules, body: Record<string, unknown>): RejectReason | null {
  for (const kind of GENERATION_KINDS) {
    const field = GENERATION_FIELDS[kind];
    const present = Object.hasOwn(body, field);
    if (rules[kind] === "not_applicable") {
      if (present) return "body_malformed";
      continue;
    }
    if (!present) return "generation_missing";
    if (!isGeneration(body[field])) return "body_malformed";
  }
  return null;
}

// 권위 값과의 대조. generationFieldFault가 null인 본문에만 부른다. 필요한 세대를 받는 쪽이 모르면 닫는다(generation_unknown).
export function generationMismatch(rules: GenerationRules, body: Record<string, unknown>, authority: GenerationAuthorities): RejectReason | null {
  for (const kind of GENERATION_KINDS) {
    const rule = rules[kind];
    if (rule === "not_applicable") continue;
    const known = authority[kind];
    if (!known.known) return "generation_unknown";
    const value = body[GENERATION_FIELDS[kind]] as number;
    if (!satisfies(rule, value, known)) return "generation_mismatch";
  }
  return null;
}

function satisfies(rule: Exclude<GenerationRule, "not_applicable">, value: number, known: { current: number; prepared: number | null }): boolean {
  switch (rule) {
    case "current":
      return value === known.current;
    case "next":
      return value === known.current + 1;
    case "newer":
      return value > known.current;
    case "prepared":
      return known.prepared !== null && value === known.prepared;
  }
}
