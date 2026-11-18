// 장부를 쓸 수 없는 이유. 이 가운데 하나라도 나면 장부는 새 접수·새 실행·자격 발급의 근거를 주지 않는다.
export const UNAVAILABLE_REASONS = [
  "locked", // 다른 작성자가 잡고 있다
  "corrupt", // 깨진 파일(SQLite가 아닌 파일 포함)
  "full", // 디스크 가득
  "io", // 열기·읽기·쓰기의 입출력 오류
  "too_new", // 장부의 판이 코드보다 높다
  "migration_mismatch", // 적용 기록이 코드의 마이그레이션 폴더와 다르다
  "migration_failed", // 마이그레이션 도중 실패(그 판 전체를 되돌렸다)
  "closed", // 닫은 장부
  "db_error", // 그 밖의 DB 오류
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

// 읽기가 실패했을 때 던진다. "기록 없음"(null·undefined)으로 바꾸지 않기 위해서다.
export class LedgerUnavailableError extends Error {
  constructor(
    readonly reason: UnavailableReason,
    detail: string,
  ) {
    super(`ledger unavailable (${reason}): ${detail}`);
    this.name = "LedgerUnavailableError";
  }
}

// SQLite 오류 코드(bun:sqlite의 SQLiteError.code, 예: "SQLITE_BUSY")를 이유로 바꾼다. Bun 1.4.4·SQLite 3.53.4에서
// 잠긴 장부는 SQLITE_BUSY, max_page_count를 넘으면 SQLITE_FULL, SQLite가 아닌 파일은 SQLITE_NOTADB였다.
export function classify(error: unknown): UnavailableReason {
  if (error instanceof LedgerUnavailableError) return error.reason;
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || code.startsWith("SQLITE_BUSY_") || code.startsWith("SQLITE_LOCKED_")) return "locked";
  if (code === "SQLITE_FULL") return "full";
  if (code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT" || code.startsWith("SQLITE_CORRUPT_")) return "corrupt";
  if (code.startsWith("SQLITE_IOERR") || code.startsWith("SQLITE_CANTOPEN") || code.startsWith("SQLITE_READONLY") || code === "SQLITE_PERM") return "io";
  if (error instanceof Error && /closed database/i.test(error.message)) return "closed";
  return "db_error";
}

export function describe(error: unknown): string {
  if (error instanceof Error) return `${(error as { code?: string }).code ?? error.name}: ${error.message}`;
  return String(error);
}

// 시험이 끊김과 오류를 넣는 자리. 운영에서는 아무것도 하지 않는다. 지점 이름은 ledger.md "끊김 지점"에 있다.
export interface Faults {
  at(point: string): void;
}
export const NO_FAULTS: Faults = { at() {} };
