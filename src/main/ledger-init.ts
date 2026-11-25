// 장부 초기화 진입점(D-110). 감독을 처음 켜기 전에 관리자가 같은 이미지로 한 번 돌린다: `bun src/main/ledger-init.ts`(인자 없음).
// 감독은 장부를 reopen으로만 열어 빈 볼륨이면 94로 끝난다(boot.md S20). 장부를 create로 여는 곳은 src/에서 이 파일 하나다.
// 환경은 감독과 같은 이름 하나(ledger-path.ts의 OLIVE_LEDGER_DIR)만 읽는다. 듣지 않고 어디에도 붙지 않는다.
// 무엇을 받고 거절할지는 openLedger의 create가 판정한다(src/ledger/ledger.md "create가 받는 것은 둘뿐이다"). 첫 설치를 마친 장부는
// 파일을 바꾸지 않는 판정에서 already_initialized로 거절되므로, 감독이 그 장부를 쥐고 있어도 잠금에 닿기 전에 90으로 끝난다.
// 다만 감독의 체크포인트 도중의 본체를 읽으면 다른 사유의 94일 수 있다. 어느 쪽도 파일을 바꾸지 않는다.
import { isAbsolute, join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { type OpenOptions, type OpenResult, openLedger } from "../ledger/index.ts";
import { LEDGER_DIR_ENV, LEDGER_FILE } from "./ledger-path.ts";

// 91·94는 감독 진입점과 같은 뜻(환경, 장부 열기), 64는 관리 진입점의 사용법과 같다. 90은 감독 진입점이 쓰지 않는 값이다.
export const LEDGER_INIT_EXIT = {
  created: 0,
  usage: 64,
  // 첫 설치를 마친 장부가 이미 있다. 아무것도 바꾸지 않았다.
  exists: 90,
  config: 91,
  // 그 밖의 거절과 실패(다른 파일이 그 자리에 있음, 폴더 없음, 잠김, 닫기 실패 등). 사유를 한 줄 찍는다.
  ledger: 94,
} as const;

export interface LedgerInitDeps {
  readonly openLedger: (path: string, options: OpenOptions) => OpenResult;
  readonly wallNow: () => number;
}

export interface LedgerInitResult {
  readonly code: (typeof LEDGER_INIT_EXIT)[keyof typeof LEDGER_INIT_EXIT];
  readonly line: string;
}

export type LedgerTarget = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly problem: "missing" | "invalid" };

// 감독의 settingsFromEnv와 같은 규칙이다: 빈 값은 없는 것, 상대 경로는 틀림.
export function ledgerTarget(env: Readonly<Record<string, string | undefined>>): LedgerTarget {
  const dir = env[LEDGER_DIR_ENV] ?? "";
  if (dir === "") return { ok: false, problem: "missing" };
  if (!isAbsolute(dir)) return { ok: false, problem: "invalid" };
  return { ok: true, path: join(dir, LEDGER_FILE) };
}

const say = (code: LedgerInitResult["code"], text: string): LedgerInitResult => ({ code, line: `olive ledger-init ${pkg.version}: ${text}\n` });
const failed = (reason: string) => say(LEDGER_INIT_EXIT.ledger, `장부를 만들지 못했다(${reason})`);

// 사유만 찍고 openLedger의 detail은 싣지 않는다(SQLite 오류 글에 경로가 섞일 수 있다).
export function initLedger(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, deps: LedgerInitDeps): LedgerInitResult {
  if (argv.length !== 0) return say(LEDGER_INIT_EXIT.usage, "사용법: bun src/main/ledger-init.ts (인자 없음)");
  let target: LedgerTarget;
  try {
    target = ledgerTarget(env);
  } catch {
    target = { ok: false, problem: "invalid" };
  }
  if (!target.ok) return say(LEDGER_INIT_EXIT.config, `환경 ${LEDGER_DIR_ENV}이(가) ${target.problem === "missing" ? "없다" : "틀렸다"}`);
  // 효과(create 열기) 직전: 포트를 먼저 얻는다. 문(인자 없음·환경이 맞음)은 위에서 정해졌고, 아래 호출과 사이에 다른 코드를 두지 않는다.
  let open: LedgerInitDeps["openLedger"];
  let clock: LedgerInitDeps["wallNow"];
  try {
    open = deps.openLedger;
    clock = deps.wallNow;
  } catch {
    return failed("deps:threw");
  }
  let opened: OpenResult;
  try {
    opened = open(target.path, { clock, mode: "create" });
  } catch {
    return failed("open:threw");
  }
  try {
    if (!opened.ok) {
      if (opened.reason === "already_initialized") return say(LEDGER_INIT_EXIT.exists, "장부가 이미 있다. 아무것도 바꾸지 않았다");
      return failed(`open:${opened.reason}`);
    }
  } catch {
    return failed("open:unreadable");
  }
  try {
    // 함정: 여기서 닫기가 실패해도 장부는 이미 만들어졌다. 다시 돌리면 90이다.
    opened.ledger.close();
  } catch {
    return failed("close:threw");
  }
  return say(LEDGER_INIT_EXIT.created, "장부를 만들었다");
}

async function main(): Promise<never> {
  const result = initLedger(process.argv.slice(2), process.env, { openLedger, wallNow: Date.now });
  // 출력을 다 쓴 뒤에 끝낸다(파이프에 쓰는 도중 exit로 잘리지 않게).
  await Bun.write(Bun.stderr, result.line);
  process.exit(result.code);
}

if (import.meta.main) await main();
