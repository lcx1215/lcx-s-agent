import fs from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { listFinanceCases } from "../finance-caseflow.js";
import { readFinanceOutcomes, type FinanceOutcomeEntry } from "../finance-outcome-ledger.js";
import { financeOutcomeLedgerPath } from "../finance-state-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

export const FINANCE_OUTCOME_LEDGER_READ_SCHEMA_VERSION =
  "lcx_finance_outcome_ledger_read_v1" as const;

const DEFAULT_CASE_LIMIT = 20;
const MAX_CASE_LIMIT = 200;

const FinanceOutcomeLedgerReadSchema = Type.Object({
  caseDirectory: Type.String({
    description:
      "Directory holding the finance case files (the caseflow directory). Required: this ledger is partitioned per case and has no single default location.",
  }),
  packetRef: Type.Optional(
    Type.String({
      description:
        "Case reference to read in detail. Omit to inventory every case in the directory.",
    }),
  ),
  includeOutcomes: Type.Optional(
    Type.Boolean({
      description:
        "With packetRef, include the full outcome chain instead of only its latest record.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Maximum cases to inventory when packetRef is omitted (default ${DEFAULT_CASE_LIMIT}).`,
    }),
  ),
});

type FindingCounts = { supported: number; contradicted: number; inconclusive: number };

/**
 * Why a case cannot produce an outcome yet, or `null` when it can.
 *
 * An outcome measures recorded observations against a claim. The two reasons a claim can be
 * missing lead to opposite next actions, so they are named apart:
 *   - `case_has_unresolved_gaps` — the run did reach a diagnosis, and the diagnosis was that
 *     something upstream failed (read `gapKinds` for what).
 *   - `case_has_no_claims` — the run simply never produced one.
 * Collapsing both into "no claims" would let a data-collection or model-configuration failure read
 * as "nothing has run yet", which is the reading that gets acted on wrongly.
 *
 * Named after the gaps rather than after the case `status` on purpose: a case can carry unresolved
 * gaps without its status being `blocked` (`needs_review` is the other way this lands), and the
 * reason an outcome cannot be produced is the gaps, not the label.
 */
export function financeOutcomeAssessmentBlockedBy(entry: {
  claimCount: number;
  gapCount: number;
}): "case_has_unresolved_gaps" | "case_has_no_claims" | null {
  if (entry.claimCount > 0) {
    return null;
  }
  return entry.gapCount > 0 ? "case_has_unresolved_gaps" : "case_has_no_claims";
}

function countFindings(entry: FinanceOutcomeEntry): FindingCounts {
  const counts: FindingCounts = { supported: 0, contradicted: 0, inconclusive: 0 };
  for (const assessment of entry.input.assessments) {
    counts[assessment.finding] += 1;
  }
  return counts;
}

function summarizeOutcome(entry: FinanceOutcomeEntry) {
  return {
    ref: entry.ref,
    sequence: entry.sequence,
    recordId: entry.input.recordId,
    checkpointMonths: entry.input.checkpointMonths,
    observedAt: entry.input.observedAt,
    dueAt: entry.dueAt,
    timing: entry.timing,
    status: entry.status,
    recordedAt: entry.recordedAt,
    assessmentCount: entry.input.assessments.length,
    // What the recorded observations said about the original claims. This is the half of the
    // ledger that answers "was the call right", so it is reported before the raw chain.
    findings: countFindings(entry),
    calibrationCount: entry.calibration?.length ?? 0,
    supersedes: entry.input.supersedes ?? null,
  };
}

/**
 * Read-only view of the outcome ledger — what was assessed against the original calls.
 *
 * The position ledger answers "what do I hold". This one answers the other half of the same
 * question: "were the calls I made any good". Before it, the outcome ledger was write-only from
 * the agent's side: `appendFinanceOutcome` could be driven by operator scripts, and
 * `calibrateFinanceForecasts` computed scores, but no tool could read either — so the agent
 * could not reason about its own track record at all.
 *
 * Two facts this tool exists to state precisely:
 *   - An empty outcome ledger means *no forecast has been assessed yet*, which is not the same as
 *     "every forecast was right". The tempting reading is the wrong one, so it is named.
 *   - A case with no claims cannot be assessed at all: an outcome measures observations against a
 *     claim, so `assessmentBlockedBy: "case_has_no_claims"` says why a case can never produce one.
 *
 * It reports where it read from, and it refuses rather than guessing a directory: unlike the
 * position ledger, this ledger is partitioned per case and has no single default location.
 */
export function createFinanceOutcomeLedgerReadTool(): AnyAgentTool {
  return {
    label: "Finance Outcome Ledger Read",
    name: "finance_outcome_ledger_read",
    description:
      "Read the outcome ledger: which finance cases exist, whether any of them has had its original claims assessed, and how the recorded observations scored against those claims (supported / contradicted / inconclusive). Use this before claiming a track record, a hit rate, or that a prior call worked out. Read-only: it never appends an outcome, places an order, or touches a venue.",
    parameters: FinanceOutcomeLedgerReadSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const caseDirectory = readStringParam(params, "caseDirectory");
      const packetRef = readStringParam(params, "packetRef");
      const includeOutcomes = params.includeOutcomes === true;
      const requestedLimit = readNumberParam(params, "limit");
      const limit =
        requestedLimit === undefined
          ? DEFAULT_CASE_LIMIT
          : Math.max(1, Math.min(Math.trunc(requestedLimit), MAX_CASE_LIMIT));

      const notTouched = [
        "trading_execution",
        "order_placement",
        "provider_config",
        "external_channel_sender",
        "protected_memory",
      ] as const;

      if (caseDirectory === undefined || caseDirectory.trim().length === 0) {
        return jsonResult({
          ok: false,
          schemaVersion: FINANCE_OUTCOME_LEDGER_READ_SCHEMA_VERSION,
          boundary: "finance_outcome_ledger_read_only",
          status: "absent",
          reason: "finance_outcome_case_directory_required",
          action:
            "Pass caseDirectory: the caseflow directory holding the case files. Unlike the position " +
            "ledger this one is partitioned per case and has no single default location, so it is " +
            "refused rather than guessed. This is not evidence that no forecast has been assessed.",
          notTouched,
        });
      }

      const directory = caseDirectory.trim();
      const databasePath = financeOutcomeLedgerPath(directory);

      let directoryPresent = true;
      try {
        await fs.access(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          directoryPresent = false;
        } else {
          throw error;
        }
      }

      if (!directoryPresent) {
        return jsonResult({
          ok: false,
          schemaVersion: FINANCE_OUTCOME_LEDGER_READ_SCHEMA_VERSION,
          boundary: "finance_outcome_ledger_read_only",
          status: "absent",
          reason: "finance_outcome_case_directory_absent",
          caseDirectory: directory,
          databasePath,
          action:
            "No caseflow directory exists at this path, so this is not evidence that nothing has " +
            "been assessed. Point caseDirectory at the directory that holds the case JSON files.",
          notTouched,
        });
      }

      const cases = await listFinanceCases(directory);
      if (cases.length === 0) {
        return jsonResult({
          ok: true,
          schemaVersion: FINANCE_OUTCOME_LEDGER_READ_SCHEMA_VERSION,
          boundary: "finance_outcome_ledger_read_only",
          status: "no_cases",
          caseDirectory: directory,
          databasePath,
          databasePresent: await fs
            .access(databasePath)
            .then(() => true)
            .catch(() => false),
          caseCount: 0,
          listedCaseCount: 0,
          truncated: false,
          totalOutcomeCount: 0,
          casesWithOutcomes: 0,
          emptyReason: "this directory holds no finance cases, so there is nothing to assess yet",
          cases: [],
          notTouched,
        });
      }

      const selected =
        packetRef === undefined
          ? cases.slice(0, limit)
          : cases.filter((item) => item.ref === packetRef);

      if (packetRef !== undefined && selected.length === 0) {
        return jsonResult({
          ok: false,
          schemaVersion: FINANCE_OUTCOME_LEDGER_READ_SCHEMA_VERSION,
          boundary: "finance_outcome_ledger_read_only",
          status: "absent",
          reason: "finance_outcome_packet_ref_unknown",
          caseDirectory: directory,
          packetRef,
          knownRefs: cases.map((item) => item.ref),
          action:
            "No case in this directory has that reference, so this is not evidence that nothing was " +
            "assessed for it. Read the inventory (omit packetRef) to get the known references.",
          notTouched,
        });
      }

      const databasePresent = await fs
        .access(databasePath)
        .then(() => true)
        .catch(() => false);

      const summaries = [];
      for (const item of selected) {
        let outcomes: readonly FinanceOutcomeEntry[] = [];
        let readError: string | null = null;
        try {
          outcomes = await readFinanceOutcomes(directory, item.ref);
        } catch (error) {
          // A broken chain or an integrity mismatch is a real finding about the book, not an
          // absence of one, so it is carried per case instead of failing the whole read.
          readError = error instanceof Error ? error.message : String(error);
        }
        const latest = outcomes.at(-1);
        summaries.push({
          caseId: item.caseId,
          ref: item.ref,
          status: item.status,
          adopted: item.adopted,
          claimCount: item.claimCount,
          gapCount: item.gapCount,
          gapKinds: item.gapKinds,
          followupMonths: item.followups.map((followup) => followup.months),
          asOf: item.asOf,
          recordedAt: item.recordedAt,
          outcomeCount: outcomes.length,
          latest: latest === undefined ? null : summarizeOutcome(latest),
          assessmentBlockedBy: financeOutcomeAssessmentBlockedBy(item),
          readError,
          ...(includeOutcomes && packetRef !== undefined
            ? { outcomes: outcomes.map(summarizeOutcome) }
            : {}),
        });
      }

      const totalOutcomeCount = summaries.reduce((total, item) => total + item.outcomeCount, 0);

      return jsonResult({
        ok: true,
        schemaVersion: FINANCE_OUTCOME_LEDGER_READ_SCHEMA_VERSION,
        boundary: "finance_outcome_ledger_read_only",
        status: totalOutcomeCount > 0 ? "ready" : "empty",
        caseDirectory: directory,
        databasePath,
        databasePresent,
        caseCount: cases.length,
        listedCaseCount: summaries.length,
        truncated: packetRef === undefined && cases.length > limit,
        totalOutcomeCount,
        casesWithOutcomes: summaries.filter((item) => item.outcomeCount > 0).length,
        blockedCaseCount: summaries.filter((item) => item.status === "blocked").length,
        casesWithoutClaims: summaries.filter((item) => item.claimCount === 0).length,
        // The tempting reading of an empty ledger is the wrong one, so it is named here rather
        // than left to inference. A gap on the case is the more specific explanation when present:
        // it means the run did reach a diagnosis, and the diagnosis was "something upstream
        // failed", which is a different next action from "nothing has run yet".
        emptyReason:
          totalOutcomeCount > 0
            ? null
            : summaries.some((item) => item.gapCount > 0)
              ? "no outcome has been recorded, and the cases carry unresolved gaps: read gapKinds " +
                "per case for the upstream failure that kept a claim from being produced"
              : "no outcome has been recorded for these cases, so nothing here says a forecast was " +
                "right; check assessmentBlockedBy per case for why one cannot be recorded yet",
        cases: summaries,
        notTouched,
      });
    },
  };
}
