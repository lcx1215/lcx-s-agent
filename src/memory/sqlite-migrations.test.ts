import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  applySqliteMigrations,
  checksumMigration,
  type SqliteMigration,
} from "./sqlite-migrations.js";

const LEDGER = "test_migrations";

function coreTable(): SqliteMigration {
  return {
    version: 1,
    description: "core",
    sql: `CREATE TABLE IF NOT EXISTS things (id TEXT PRIMARY KEY, body TEXT NOT NULL);`,
  };
}

function openDb(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function ledgerRows(
  db: DatabaseSync,
): Array<{ version: number; checksum: string; success: number }> {
  return db
    .prepare(`SELECT version, checksum, success FROM ${LEDGER} ORDER BY version`)
    .all() as Array<{
    version: number;
    checksum: string;
    success: number;
  }>;
}

describe("sqlite migration ledger", () => {
  it("applies a migration once and records it in the ledger", () => {
    const db = openDb();
    const run = applySqliteMigrations({ db, ledgerTable: LEDGER, migrations: [coreTable()] });

    expect(run).toEqual({ ledgerTable: LEDGER, applied: [1], currentVersion: 1 });
    expect(ledgerRows(db)).toEqual([
      { version: 1, checksum: checksumMigration(coreTable()), success: 1 },
    ]);
    expect(
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='things'`).get(),
    ).toBeTruthy();

    const second = applySqliteMigrations({ db, ledgerTable: LEDGER, migrations: [coreTable()] });
    expect(second.applied).toEqual([]);
    expect(second.currentVersion).toBe(1);
  });

  it("baselines a database that predates the ledger without losing data", () => {
    const db = openDb();
    db.exec(`CREATE TABLE IF NOT EXISTS things (id TEXT PRIMARY KEY, body TEXT NOT NULL);`);
    db.prepare(`INSERT INTO things (id, body) VALUES (?, ?)`).run("keep", "me");

    const run = applySqliteMigrations({ db, ledgerTable: LEDGER, migrations: [coreTable()] });

    expect(run.applied).toEqual([1]);
    expect(db.prepare(`SELECT body FROM things WHERE id=?`).get("keep")).toEqual({ body: "me" });
  });

  it("reports an edited migration instead of re-applying it", () => {
    const db = openDb();
    applySqliteMigrations({ db, ledgerTable: LEDGER, migrations: [coreTable()] });
    const edited: SqliteMigration = { ...coreTable(), sql: `${coreTable().sql}\n-- edited` };

    expect(() =>
      applySqliteMigrations({ db, ledgerTable: LEDGER, migrations: [edited] }),
    ).toThrowError(/migration 1 \(core\) changed after it was applied/u);
  });

  it("applies only new versions and rejects duplicate version numbers", () => {
    const db = openDb();
    const v2: SqliteMigration = {
      version: 2,
      description: "add index",
      sql: `CREATE INDEX IF NOT EXISTS idx_things_body ON things(body);`,
    };
    applySqliteMigrations({ db, ledgerTable: LEDGER, migrations: [coreTable()] });

    const run = applySqliteMigrations({ db, ledgerTable: LEDGER, migrations: [coreTable(), v2] });
    expect(run.applied).toEqual([2]);
    expect(run.currentVersion).toBe(2);

    expect(() =>
      applySqliteMigrations({
        db,
        ledgerTable: LEDGER,
        migrations: [coreTable(), { ...coreTable(), description: "duplicate version" }],
      }),
    ).toThrowError(/versions must be unique and ascending/u);
  });

  it("rolls the migration back when its SQL fails", () => {
    const db = openDb();
    const broken: SqliteMigration = {
      version: 1,
      description: "broken",
      sql: `CREATE TABLE ok_so_far (id TEXT); THIS IS NOT SQL;`,
    };

    expect(() =>
      applySqliteMigrations({ db, ledgerTable: LEDGER, migrations: [broken] }),
    ).toThrow();
    expect(ledgerRows(db)).toEqual([]);
  });
});
