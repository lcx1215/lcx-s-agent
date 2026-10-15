import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applySqliteMigrations } from "../memory/sqlite-migrations.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import type { FinanceMarketCollectionReceipt } from "./finance-market-collection-registry.js";

export const FINANCE_FUNDAMENTAL_DATABASE = "fundamental-store_1.sqlite";
const digest = (body: string) => createHash("sha256").update(body).digest("hex");
const instant = (value: string) => {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error("invalid fundamental observation time");
  }
  return ms;
};

/** Immutable collection snapshots retain revisions, incomplete rows and failed attempts. */
export function appendFinanceFundamentalSnapshot(input: {
  directory: string;
  sourceId: string;
  capturedAt: string;
  receipt: FinanceMarketCollectionReceipt;
}): string {
  const captured = instant(input.capturedAt);
  const asOf = instant(input.receipt.request.asOf);
  const body = JSON.stringify({
    sourceId: input.sourceId,
    capturedAt: input.capturedAt,
    receipt: input.receipt,
  });
  const id = digest(body);
  fs.mkdirSync(input.directory, { recursive: true, mode: 0o700 });
  const filename = path.join(input.directory, FINANCE_FUNDAMENTAL_DATABASE);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(filename);
  try {
    fs.chmodSync(filename, 0o600);
    db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    applySqliteMigrations({
      db,
      ledgerTable: "fundamental_migrations",
      migrations: [
        {
          version: 1,
          description: "immutable source collection snapshots with knowledge time",
          sql: `CREATE TABLE IF NOT EXISTS fundamental_snapshots (
        id TEXT PRIMARY KEY, instrument TEXT NOT NULL, asset_class TEXT NOT NULL,
        collection TEXT NOT NULL, source_id TEXT NOT NULL, as_of INTEGER NOT NULL,
        captured_at INTEGER NOT NULL, record_count INTEGER NOT NULL, body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fundamental_lookup ON fundamental_snapshots
        (instrument, asset_class, collection, source_id, captured_at DESC);`,
        },
      ],
    });
    db.prepare(`INSERT OR IGNORE INTO fundamental_snapshots
      (id, instrument, asset_class, collection, source_id, as_of, captured_at, record_count, body)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id,
      input.receipt.request.instrument,
      input.receipt.request.assetClass,
      input.receipt.request.collection,
      input.sourceId,
      asOf,
      captured,
      input.receipt.records.length,
      body,
    );
    return id;
  } finally {
    db.close();
  }
}

/** Read-only, bounded knowledge-time lookup. A later revision cannot enter an earlier replay. */
export function readFinanceFundamentalSnapshot(input: {
  directory: string;
  instrument: string;
  assetClass: string;
  collection: string;
  sourceId: string;
  asOf: string;
  knownBy: string;
  maxAgeMs: number;
}) {
  const asOf = instant(input.asOf);
  const knownBy = instant(input.knownBy);
  if (!Number.isFinite(input.maxAgeMs) || input.maxAgeMs < 0) {
    throw new Error("invalid fundamental reuse age");
  }
  const filename = path.join(input.directory, FINANCE_FUNDAMENTAL_DATABASE);
  if (!fs.existsSync(filename)) {
    return undefined;
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const row = db
      .prepare(`SELECT id, body FROM fundamental_snapshots
      WHERE instrument=? AND asset_class=? AND collection=? AND source_id=?
      AND as_of<=? AND captured_at<=? AND captured_at>=? AND record_count>0
      ORDER BY captured_at DESC, id DESC LIMIT 1`)
      .get(
        input.instrument,
        input.assetClass,
        input.collection,
        input.sourceId,
        asOf,
        knownBy,
        knownBy - input.maxAgeMs,
      );
    if (!row) {
      return undefined;
    }
    if (typeof row.body !== "string" || digest(row.body) !== row.id) {
      throw new Error("fundamental snapshot checksum mismatch");
    }
    const parsed = JSON.parse(row.body) as {
      sourceId: string;
      capturedAt: string;
      receipt: FinanceMarketCollectionReceipt;
    };
    // Verify the indexed identity as well as the payload before returning it to a decision.
    if (
      parsed.sourceId !== input.sourceId ||
      parsed.receipt.request.instrument !== input.instrument ||
      parsed.receipt.request.assetClass !== input.assetClass ||
      parsed.receipt.request.collection !== input.collection ||
      instant(parsed.receipt.request.asOf) > asOf ||
      instant(parsed.capturedAt) > knownBy ||
      instant(parsed.capturedAt) < knownBy - input.maxAgeMs
    ) {
      throw new Error("fundamental snapshot index mismatch");
    }
    return { ...parsed, snapshotId: String(row.id) };
  } finally {
    db.close();
  }
}
