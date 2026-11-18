import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as publicLedger from "../../src/ledger/index.ts";
import { loadMigrations, openLedger } from "../../src/ledger/index.ts";
import { Ledger } from "../../src/ledger/ledger.ts";
import { clock, NOW, open, tempDir, tempPath } from "./helpers.ts";

test("열기: 같은 장부를 두 번째 작성자가 열면 실패한다(같은 프로세스)", () => {
  const path = tempPath();
  open(path);
  const second = openLedger(path, { clock, mode: "reopen" });
  expect(second).toMatchObject({ ok: false, reason: "locked" });
});

test("열기: 같은 장부를 두 번째 작성자가 열면 실패한다(다른 프로세스)", () => {
  const path = tempPath();
  open(path);
  const script = `
    const { openLedger } = await import(${JSON.stringify(join(import.meta.dir, "../../src/ledger/index.ts"))});
    const r = openLedger(${JSON.stringify(path)}, { clock: () => 1, mode: "reopen" });
    console.log(JSON.stringify({ ok: r.ok, reason: r.reason }));
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script]);
  expect(JSON.parse(child.stdout.toString().trim())).toEqual({ ok: false, reason: "locked" });
});

test("열기: 닫으면 다음 작성자가 열 수 있고 WAL이 남는다", () => {
  const path = tempPath();
  open(path).close();
  const again = openLedger(path, { clock, mode: "reopen" });
  expect(again.ok).toBe(true);
  if (again.ok) again.ledger.close();
  const raw = new Database(path);
  expect(raw.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  raw.close();
});

test("열기: 장부는 openLedger로만 생긴다(공개 면에 생성자가 없고, 직접 만들면 던진다)", () => {
  expect("Ledger" in publicLedger).toBe(false);
  const path = tempPath();
  const raw = new Database(path);
  expect(() => new Ledger(Symbol("openLedger"), raw, clock, { at() {} })).toThrow("openLedger로만");
  raw.close();
});

test("열기: 첫 설치로 연 장부만 정지 기록이 없을 때 0을 적을 수 있고, 첫 설치 기록은 지울 수 없다", () => {
  const path = tempPath();
  const created = openLedger(path, { clock, mode: "create" });
  expect(created).toMatchObject({ ok: true });
  if (created.ok) created.ledger.close();
  const raw = new Database(path);
  expect(raw.query("SELECT COUNT(*) AS n FROM ledger_identity").get()).toEqual({ n: 1 });
  expect(() => raw.run("DELETE FROM ledger_identity")).toThrow("ledger_identity_permanent");
  raw.close();
  expect(open(path).mergeStop(null, NOW)).toMatchObject({ ok: true, source: "initialized", record: { generation: 0, stopped: false } });
});

function migrationDir(files: Record<string, string>): string {
  const dir = join(tempDir(), "migrations");
  mkdirSync(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

function versions(path: string): number[] {
  const raw = new Database(path);
  const rows = raw.query("SELECT version FROM ledger_migrations ORDER BY version").all() as { version: number }[];
  raw.close();
  return rows.map((r) => r.version);
}

test("마이그레이션: 한 번씩만 적용한다", () => {
  const path = tempPath();
  const dir = migrationDir({ "0001-a.sql": "CREATE TABLE a (x INTEGER) STRICT;", "0002-b.sql": "CREATE TABLE b (x INTEGER) STRICT; INSERT INTO b VALUES (1);" });
  const first = openLedger(path, { clock, mode: "create", migrations: loadMigrations(dir) });
  expect(first).toMatchObject({ ok: true, migrated: { from: 0, to: 2 } });
  if (first.ok) first.ledger.close();
  const second = openLedger(path, { clock, mode: "reopen", migrations: loadMigrations(dir) });
  expect(second).toMatchObject({ ok: true, migrated: { from: 2, to: 2 } });
  if (second.ok) second.ledger.close();
  const raw = new Database(path);
  expect(raw.query("SELECT COUNT(*) AS n FROM b").get()).toEqual({ n: 1 });
  raw.close();
  expect(versions(path)).toEqual([1, 2]);
});

test("마이그레이션: 도중 실패는 그 판 전체를 되돌린다", () => {
  const path = tempPath();
  const dir = migrationDir({ "0001-a.sql": "CREATE TABLE a (x INTEGER) STRICT;", "0002-b.sql": "CREATE TABLE b (x INTEGER) STRICT; INSERT INTO nope VALUES (1);" });
  const result = openLedger(path, { clock, mode: "create", migrations: loadMigrations(dir) });
  expect(result).toMatchObject({ ok: false, reason: "migration_failed" });
  expect(versions(path)).toEqual([1]);
  const raw = new Database(path);
  expect(raw.query("SELECT name FROM sqlite_master WHERE name = 'b'").get()).toBeNull();
  raw.close();
});

test("마이그레이션: 장부의 판이 코드보다 높으면 열지 않는다", () => {
  const path = tempPath();
  open(path).close();
  const fewer = loadMigrations().slice(0, 0);
  expect(openLedger(path, { clock, mode: "reopen", migrations: fewer })).toMatchObject({ ok: false, reason: "too_new" });
});

test("마이그레이션: 적용 기록과 이름이 다르면 열지 않는다", () => {
  const path = tempPath();
  open(path, { migrations: loadMigrations(migrationDir({ "0001-a.sql": "CREATE TABLE a (x INTEGER);" })) }).close();
  const other = loadMigrations(migrationDir({ "0001-other.sql": "CREATE TABLE a (x INTEGER);" }));
  expect(openLedger(path, { clock, mode: "reopen", migrations: other })).toMatchObject({ ok: false, reason: "migration_mismatch" });
});

test("마이그레이션: 번호가 비거나 꼴이 다른 파일이 있으면 읽지 않는다", () => {
  expect(() => loadMigrations(migrationDir({ "0001-a.sql": "", "0003-c.sql": "" }))).toThrow("이어지지");
  expect(() => loadMigrations(migrationDir({ "0001-a.sql": "", "notes.txt": "" }))).toThrow("꼴이 다른");
});

test("마이그레이션: 호출자가 넘긴 목록도 어떤 판도 적용하기 전에 번호·이름을 검사한다", () => {
  for (const migrations of [
    [{ version: 2, name: "0002-b.sql", sql: "CREATE TABLE b (x INTEGER);" }],
    [{ version: 1, name: "0002-b.sql", sql: "CREATE TABLE b (x INTEGER);" }],
    [
      { version: 1, name: "0001-a.sql", sql: "CREATE TABLE a (x INTEGER);" },
      { version: 3, name: "0003-c.sql", sql: "CREATE TABLE c (x INTEGER);" },
    ],
    [{ version: 1, name: "a.sql", sql: "CREATE TABLE a (x INTEGER);" }],
  ]) {
    const path = tempPath();
    expect(openLedger(path, { clock, mode: "create", migrations }), JSON.stringify(migrations.map((m) => m.name))).toMatchObject({ ok: false, reason: "migration_mismatch" });
    const raw = new Database(path);
    expect(raw.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
    raw.close();
  }
});
