import type { DatabaseSync } from "node:sqlite";

const PREPARED = "prepared_memory_index";
const CORE_TABLES = [
  ["meta", "key, value"],
  ["files", "path, source, hash, mtime, size"],
  ["chunks", "id, path, source, start_line, end_line, hash, model, text, embedding, updated_at"],
  ["embedding_cache", "provider, model, provider_key, hash, embedding, dims, updated_at"],
] as const;

function virtualSchema(db: DatabaseSync, schema: "main" | typeof PREPARED, table: string) {
  const row = db
    .prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { sql: string | null } | undefined;
  return row?.sql;
}

/** Publish prepared memory data without replacing the file beneath other owner connections. */
export function publishMemoryIndex(params: { db: DatabaseSync; preparedPath: string }): void {
  const { db } = params;
  db.prepare(`ATTACH DATABASE ? AS ${PREPARED}`).run(params.preparedPath);
  let transactionStarted = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    for (const [table, columns] of CORE_TABLES) {
      db.exec(`DELETE FROM main.${table}`);
      db.exec(`INSERT INTO main.${table} (${columns}) SELECT ${columns} FROM ${PREPARED}.${table}`);
    }
    for (const [table, module, columns] of [
      ["chunks_fts", "fts5", "text, id, path, source, model, start_line, end_line"],
      ["chunks_vec", "vec0", "id, embedding"],
    ] as const) {
      const preparedSql = virtualSchema(db, PREPARED, table);
      const currentSql = virtualSchema(db, "main", table);
      // Only host-created, fixed-name memory virtual tables are eligible for publication.
      if (
        preparedSql &&
        !new RegExp(
          `^CREATE\\s+VIRTUAL\\s+TABLE\\s+(?:"${table}"|${table})\\s+USING\\s+${module}\\s*\\(`,
          "iu",
        ).test(preparedSql)
      ) {
        throw new Error(`Unexpected prepared memory virtual schema: ${table}`);
      }
      if (currentSql && currentSql !== preparedSql) {
        db.exec(`DROP TABLE main.${table}`);
      }
      if (!preparedSql) {
        continue;
      }
      if (currentSql !== preparedSql) {
        db.exec(preparedSql);
      } else {
        db.exec(`DELETE FROM main.${table}`);
      }
      db.exec(`INSERT INTO main.${table} (${columns}) SELECT ${columns} FROM ${PREPARED}.${table}`);
    }
    db.exec("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      db.exec("ROLLBACK");
    }
    throw error;
  } finally {
    db.exec(`DETACH DATABASE ${PREPARED}`);
  }
}
