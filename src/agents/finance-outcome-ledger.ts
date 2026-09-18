import { chmodSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import { z } from "zod";
import { applySqliteMigrations, type SqliteMigration } from "../memory/sqlite-migrations.js";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { LCX_ONTOLOGY_FINANCE_EXECUTION_AUTHORITIES } from "../shared/lcx-ontology.js";
import { caseflowFingerprint, readFinanceCaseRun } from "./finance-caseflow.js";
import { calibrateFinanceForecasts } from "./finance-forecast-calibration.js";
import { financeOutcomeLedgerPath } from "./finance-state-dir.js";

const Text = z.string().trim().min(1);
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Observation = z
  .object({
    id: Text,
    source: Text,
    sourceTimestamp: z.string().datetime(),
    field: Text,
    value: z.union([z.number().finite(), Text]),
    unit: Text.optional(),
  })
  .strict();
const Assessment = z
  .object({
    claimId: Text,
    finding: z.enum(["supported", "contradicted", "inconclusive"]),
    evidenceIds: z.array(Text).min(1),
    deviation: Text,
    invalidationConditions: z.array(Text).min(1),
  })
  .strict();
export const FinanceOutcomeInput = z
  .object({
    recordId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u),
    checkpointMonths: z.union([z.literal(3), z.literal(6)]),
    observedAt: z.string().datetime(),
    evidence: z.array(Observation).min(1),
    assessments: z.array(Assessment),
    supersedes: Hash.optional(),
    correctionReason: Text.optional(),
  })
  .strict();
const Entry = z
  .object({
    schemaVersion: z.literal("lcx_finance_outcome_v1"),
    packetRef: Hash,
    caseId: Text,
    runId: Text,
    sequence: z.number().int().positive(),
    previousRef: Hash.nullable(),
    recordedAt: z.string().datetime(),
    dueAt: z.string().datetime(),
    timing: z.enum(["interim", "due_or_later"]),
    status: z.literal("recorded_for_review"),
    executionAuthority: z.enum([...LCX_ONTOLOGY_FINANCE_EXECUTION_AUTHORITIES]),
    input: FinanceOutcomeInput,
    calibration: z.array(z.record(z.string(), z.unknown())).optional(),
    originalClaims: z.array(z.object({ id: Text, text: Text })),
  })
  .strict();
export type FinanceOutcomeEntry = z.infer<typeof Entry> & { ref: string };
/**
 * The ledger file is generation-suffixed (`outcome-ledger_1.sqlite`). `finance-state-dir.ts`
 * owns that name so writers and readers cannot disagree about it.
 */
const databasePath = financeOutcomeLedgerPath;

const OUTCOME_LEDGER_MIGRATION_LEDGER = "finance_outcome_migrations";
const OUTCOME_LEDGER_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    description: "append-only outcome ledger",
    sql: `
      CREATE TABLE IF NOT EXISTS finance_outcomes (
        packet_ref TEXT NOT NULL, record_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        ref TEXT NOT NULL UNIQUE, body TEXT NOT NULL,
        PRIMARY KEY(packet_ref,record_id), UNIQUE(packet_ref,sequence)
      );
      CREATE TRIGGER IF NOT EXISTS finance_outcome_no_update BEFORE UPDATE ON finance_outcomes BEGIN SELECT RAISE(ABORT,'outcomes are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS finance_outcome_no_delete BEFORE DELETE ON finance_outcomes BEGIN SELECT RAISE(ABORT,'outcomes are append-only'); END;
    `,
  },
];

function readRows(
  db: InstanceType<ReturnType<typeof requireNodeSqlite>["DatabaseSync"]>,
  packetRef: string,
): FinanceOutcomeEntry[] {
  const rows = db
    .prepare("SELECT ref, body FROM finance_outcomes WHERE packet_ref=? ORDER BY sequence")
    .all(packetRef);
  let previousRef: string | null = null;
  return rows.map((row, index) => {
    if (typeof row.body !== "string" || typeof row.ref !== "string") {
      throw new Error("invalid outcome record");
    }
    const raw: unknown = JSON.parse(row.body);
    if (caseflowFingerprint(raw) !== row.ref) {
      throw new Error("outcome integrity mismatch");
    }
    const entry = Entry.parse(raw);
    if (
      entry.packetRef !== packetRef ||
      entry.sequence !== index + 1 ||
      entry.previousRef !== previousRef
    ) {
      throw new Error("outcome chain mismatch");
    }
    previousRef = row.ref;
    return { ...entry, ref: row.ref };
  });
}

/** Append observations and reproducible scores; provenance remains subject to review. */
export async function appendFinanceOutcome(
  directory: string,
  packetRef: string,
  input: unknown,
): Promise<FinanceOutcomeEntry> {
  const packet = await readFinanceCaseRun(directory, packetRef);
  const data = FinanceOutcomeInput.parse(input);
  const now = new Date().toISOString();
  if (
    Date.parse(data.observedAt) > Date.parse(now) ||
    Date.parse(data.observedAt) < Date.parse(packet.case.asOf)
  ) {
    throw new Error("outcome observation must be between the case date and now");
  }
  if (Boolean(data.supersedes) !== Boolean(data.correctionReason)) {
    throw new Error("correction requires supersedes and correctionReason");
  }
  const evidenceIds = new Set(data.evidence.map((item) => item.id));
  if (evidenceIds.size !== data.evidence.length) {
    throw new Error("duplicate outcome evidence id");
  }
  if (
    data.evidence.some((item) => Date.parse(item.sourceTimestamp) > Date.parse(data.observedAt))
  ) {
    throw new Error("source timestamp exceeds observation date");
  }
  const claims = new Map(packet.packet.claims.map((claim) => [claim.id, claim.text]));
  if (claims.size !== packet.packet.claims.length) {
    throw new Error("ambiguous original claim ids");
  }
  const assessed = new Set<string>();
  const originalClaims = data.assessments.map((item) => {
    const text = claims.get(item.claimId);
    if (!text || assessed.has(item.claimId)) {
      throw new Error("unknown or duplicate original claim");
    }
    assessed.add(item.claimId);
    if (item.evidenceIds.some((id) => !evidenceIds.has(id))) {
      throw new Error("unknown outcome evidence reference");
    }
    return { id: item.claimId, text };
  });
  const followup = packet.packet.followups.find((item) => item.months === data.checkpointMonths);
  if (!followup) {
    throw new Error("checkpoint missing from original packet");
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(databasePath(directory));
  try {
    chmodSync(databasePath(directory), 0o600);
    // auto_vacuum must be set before the first journal_mode=WAL write: switching to WAL
    // initialises the database file and silently freezes auto_vacuum afterwards.
    db.exec(
      `PRAGMA busy_timeout=5000; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`,
    );
    applySqliteMigrations({
      db,
      ledgerTable: OUTCOME_LEDGER_MIGRATION_LEDGER,
      migrations: OUTCOME_LEDGER_MIGRATIONS,
    });
    db.exec("BEGIN IMMEDIATE");
    try {
      const entries = readRows(db, packetRef);
      const existing = entries.find((item) => item.input.recordId === data.recordId);
      if (existing) {
        if (caseflowFingerprint(existing.input) !== caseflowFingerprint(data)) {
          throw new Error("outcome recordId conflict; append a correction");
        }
        db.exec("COMMIT");
        return existing;
      }
      if (data.supersedes) {
        const original = entries.find((item) => item.ref === data.supersedes);
        if (
          !original ||
          original.input.checkpointMonths !== data.checkpointMonths ||
          entries.some((item) => item.input.supersedes === data.supersedes)
        ) {
          throw new Error(
            "correction must reference an unsuperseded record in this packet/checkpoint",
          );
        }
      }
      const entry = Entry.parse({
        schemaVersion: "lcx_finance_outcome_v1",
        packetRef,
        caseId: packet.case.id,
        runId: packet.run.id,
        sequence: entries.length + 1,
        previousRef: entries.at(-1)?.ref ?? null,
        recordedAt: now,
        dueAt: followup.dueAt,
        timing:
          Date.parse(data.observedAt) < Date.parse(followup.dueAt) ? "interim" : "due_or_later",
        status: "recorded_for_review",
        executionAuthority: "none",
        input: data,
        originalClaims,
        ...(packet.packet.forecasts
          ? {
              calibration: calibrateFinanceForecasts({
                forecasts: packet.packet.forecasts,
                checkpointMonths: data.checkpointMonths,
                dueAt: followup.dueAt,
                frozenAt: packet.run.recordedAt,
                observedAt: data.observedAt,
                evidence: data.evidence,
              }),
            }
          : {}),
      });
      const ref = caseflowFingerprint(entry);
      db.prepare(
        "INSERT INTO finance_outcomes(packet_ref,record_id,sequence,ref,body) VALUES (?,?,?,?,?)",
      ).run(packetRef, data.recordId, entry.sequence, ref, JSON.stringify(entry));
      db.exec("COMMIT");
      return { ...entry, ref };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function readFinanceOutcomes(
  directory: string,
  packetRef: string,
): Promise<FinanceOutcomeEntry[]> {
  await readFinanceCaseRun(directory, packetRef);
  try {
    await fs.access(databasePath(directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(databasePath(directory), { readOnly: true });
  try {
    return readRows(db, packetRef);
  } finally {
    db.close();
  }
}
