// 끊긴 첫 설치 시험이 쓰는 두 판. 값은 결정적이어야 한다: 이어 받기가 같은 판을 메모리에 적용해 내용을 대조한다.
export const SPILL_MIGRATIONS = [
  {
    version: 1,
    name: "0001-rows.sql",
    sql: `CREATE TABLE filler (id INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT;
          WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400)
          INSERT INTO filler (id, v) SELECT i, printf('%02000d', i) FROM n;`,
  },
  {
    version: 2,
    name: "0002-spill.sql",
    sql: `PRAGMA cache_size = 4;
          UPDATE filler SET v = printf('%03000d', id);`,
  },
];
