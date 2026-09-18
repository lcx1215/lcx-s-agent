import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Ordered, checksummed schema migrations for the process-local SQLite stores.
 *
 * Mirrors the contract the Codex harness uses for its own SQLite files: every
 * store carries a ledger of the migrations it has applied, so the database can
 * report which generation it is on, and an edited migration is detected instead
 * of being silently re-applied on top of an incompatible shape.
 *
 * Migrations must stay additive and idempotent (`CREATE TABLE IF NOT EXISTS`),
 * because a store created before the ledger existed is baselined by executing
 * the same SQL as a no-op and then recording the row.
 */
export type SqliteMigration = {
  version: number;
  description: string;
  sql: string;
};

export type SqliteMigrationRun = {
  ledgerTable: string;
  applied: number[];
  currentVersion: number;
};

export function checksumMigration(migration: SqliteMigration): string {
  return createHash("sha256").update(migration.sql).digest("hex");
}

export function applySqliteMigrations(params: {
  db: DatabaseSync;
  ledgerTable: string;
  migrations: readonly SqliteMigration[];
}): SqliteMigrationRun {
  const { db, ledgerTable, migrations } = params;
  const ordered = migrations.toSorted((left, right) => left.version - right.version);
  ordered.forEach((migration, index) => {
    const previous = ordered[index - 1];
    if (previous && previous.version >= migration.version) {
      throw new Error(`${ledgerTable}: migration versions must be unique and ascending`);
    }
  });

  db.exec(
    `CREATE TABLE IF NOT EXISTS ${ledgerTable} (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      checksum TEXT NOT NULL,
      success INTEGER NOT NULL,
      installed_on INTEGER NOT NULL,
      execution_time_ms INTEGER NOT NULL
    );`,
  );

  const recorded = new Map<number, string>();
  const rows = db.prepare(`SELECT version, checksum FROM ${ledgerTable}`).all() as Array<{
    version: number;
    checksum: string;
  }>;
  for (const row of rows) {
    recorded.set(row.version, row.checksum);
  }

  const applied: number[] = [];
  let currentVersion = 0;
  for (const migration of ordered) {
    const expected = checksumMigration(migration);
    const recordedChecksum = recorded.get(migration.version);
    if (recordedChecksum !== undefined) {
      if (recordedChecksum !== expected) {
        throw new Error(
          `${ledgerTable}: migration ${migration.version} (${migration.description}) changed after it was applied; add a new migration instead of editing an applied one`,
        );
      }
      currentVersion = Math.max(currentVersion, migration.version);
      continue;
    }

    const startedAt = Date.now();
    const ownsTransaction = !db.isTransaction;
    if (ownsTransaction) {
      db.exec("BEGIN IMMEDIATE");
    }
    try {
      db.exec(migration.sql);
      db.prepare(
        `INSERT INTO ${ledgerTable} (version, description, checksum, success, installed_on, execution_time_ms)
         VALUES (?, ?, ?, 1, ?, ?)`,
      ).run(migration.version, migration.description, expected, startedAt, Date.now() - startedAt);
      if (ownsTransaction) {
        db.exec("COMMIT");
      }
    } catch (error) {
      if (ownsTransaction) {
        try {
          db.exec("ROLLBACK");
        } catch {}
      }
      throw error;
    }
    applied.push(migration.version);
    currentVersion = Math.max(currentVersion, migration.version);
  }

  return { ledgerTable, applied, currentVersion };
}
