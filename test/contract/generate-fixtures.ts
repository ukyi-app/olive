// contracts/fixtures/v1/의 사례 파일을 다시 만든다: `bun run fixtures`.
// 부를 때마다 주체별 Ed25519 키를 새로 만들어 서명하고, 파일에는 공개 키만 쓴다. 개인 키는 이 프로세스가 끝나면 사라진다.
// 그래서 사례 하나만 고쳐 다시 서명할 수 없다. 사례를 바꾸면 전부 다시 만든다(서명과 공개 키가 모든 파일에서 바뀐다).
// 지운 사례의 파일은 남으므로 손으로 지운다. 시험(fixtures.test.ts)이 사례 정의에 없는 파일을 찾아 실패시킨다.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson } from "../../src/contract/v1/canonical.ts";
import { root } from "../files.ts";
import { buildCases, freshKeys } from "./cases.ts";

const FIXTURE_DIR = "contracts/fixtures/v1";

for (const c of buildCases(freshKeys())) {
  const file = join(root, FIXTURE_DIR, `${c.name}.json`);
  mkdirSync(dirname(file), { recursive: true });
  const fixture = { fixture: "olive-control/v1", ...c, signing_input: canonicalJson(c.message.header) };
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
}
console.error(`fixture를 ${FIXTURE_DIR}에 다시 만들었다`);
