// 마이그레이션: migrations/ 폴더의 `NNNN-이름.sql`을 번호 순서대로 한 번씩만 적용한다.
// - 판 하나는 트랜잭션 하나다. 도중에 실패하면(끊김 포함) 그 판의 표와 적용 기록이 함께 되돌려진다.
// - 적용 기록(ledger_migrations)은 판 번호와 파일 이름이다. 장부의 판이 코드보다 높거나, 같은 번호의 이름이 다르면 열지 않는다.
// - 적용된 파일은 고치지 않는다. 바꿀 것은 다음 번호의 파일로 더한다. 묶음마다 자기 마이그레이션을 더하는 쪽은 ledger.md에 있다.
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { classify, describe, type Faults, LedgerUnavailableError } from "./errors.ts";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS_DIR = join(import.meta.dir, "migrations");
const FILE = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.sql$/;

// 번호는 1부터 빈틈없이 이어져야 한다. 폴더에 꼴이 다른 파일이 있으면 실패한다(빠뜨린 판을 조용히 건너뛰지 않게).
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const out: Migration[] = [];
  for (const file of readdirSync(dir).sort()) {
    const match = FILE.exec(file);
    if (!match) throw new Error(`마이그레이션 폴더에 꼴이 다른 파일: ${file}`);
    out.push({ version: Number(match[1]), name: file, sql: readFileSync(join(dir, file), "utf8") });
  }
  out.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error(`마이그레이션 번호가 이어지지 않는다: ${migration.name}`);
  });
  return out;
}

const BOOTSTRAP = "CREATE TABLE IF NOT EXISTS ledger_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT";

function applied(db: Database): { version: number; name: string }[] {
  const exists = db.query("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'ledger_migrations'").get();
  if (!exists) return [];
  return db.query("SELECT version, name FROM ledger_migrations ORDER BY version").all() as { version: number; name: string }[];
}

export function migrate(db: Database, migrations: readonly Migration[], now: number, faults: Faults): { from: number; to: number } {
  const done = applied(db);
  const latest = migrations.length;
  if (done.length > 0 && done[done.length - 1].version > latest) {
    throw new LedgerUnavailableError("too_new", `장부의 판 ${done[done.length - 1].version} > 코드의 판 ${latest}`);
  }
  done.forEach((row, index) => {
    const code = migrations[index];
    if (row.version !== index + 1 || code === undefined || code.name !== row.name) {
      throw new LedgerUnavailableError("migration_mismatch", `적용 기록 ${row.version} ${row.name} ≠ 코드 ${code?.name ?? "없음"}`);
    }
  });
  for (const migration of migrations.slice(done.length)) {
    try {
      db.transaction(() => {
        db.run(BOOTSTRAP);
        db.run(migration.sql);
        db.query("INSERT INTO ledger_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(migration.version, migration.name, now);
        faults.at(`migration:${migration.version}`);
      }).immediate();
    } catch (error) {
      const reason = classify(error);
      throw new LedgerUnavailableError(reason === "db_error" ? "migration_failed" : reason, `${migration.name}: ${describe(error)}`);
    }
  }
  return { from: done.length, to: latest };
}
