// contracts/fixtures/v2/frontdoor/의 사례 파일을 다시 만든다: `bun run fixtures:v2`. v2만 만든다(v1 폴더에는 쓰지 않는다).
// 부를 때마다 두 당사자의 Ed25519 키를 새로 만들어 서명하고, 파일에는 공개 키만 쓴다. 개인 키는 이 프로세스가 끝나면 사라진다.
// 사례를 바꾸면 전부 다시 만든다(서명과 공개 키가 모든 파일에서 바뀐다). 지운 사례의 파일은 남으므로 `git rm`으로 지운다.
// 시험(fixtures.test.ts)이 사례 정의에 없는 파일을 찾아 실패시킨다.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { canonicalJson } from "../../../src/contract/v1/index.ts";
import { root } from "../../files.ts";
import { buildCases, FIXTURE_DIR, FIXTURE_TAG } from "./cases.ts";
import { freshKeys } from "./support.ts";

const base = join(root, FIXTURE_DIR);
for (const c of buildCases(freshKeys())) {
  const file = join(base, `${c.name}.json`);
  if (relative(base, file).startsWith("..")) throw new Error(`표본 폴더 밖이다: ${c.name}`);
  mkdirSync(dirname(file), { recursive: true });
  const fixture = { fixture: FIXTURE_TAG, ...c, signing_input: canonicalJson(c.message.header) };
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
}
console.error(`fixture를 ${FIXTURE_DIR}에 다시 만들었다`);
