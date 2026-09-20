import fs from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import {
  financeThesisLedgerPath,
  resolveFinanceStateDir,
  type FinanceStateDirSource,
} from "../finance-state-dir.js";
import { readFinanceThesisLedger, type FinanceThesis } from "../finance-thesis-ledger.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

export const FINANCE_THESIS_LEDGER_READ_SCHEMA_VERSION =
  "lcx_finance_thesis_ledger_read_v1" as const;

const FinanceThesisLedgerReadSchema = Type.Object({
  directory: Type.Optional(
    Type.String({
      description:
        "Ledger directory to read. Defaults to LCX_FINANCE_STATE_DIR, then <workspace>/state/finance.",
    }),
  ),
  asOf: Type.Optional(
    Type.String({
      description:
        "ISO datetime for a point-in-time view. Only records at or before this instant are replayed, so a thesis closed later reads as still active.",
    }),
  ),
  thesisId: Type.Optional(
    Type.String({
      description: "Read one thesis in detail. Omit to list every thesis in the book.",
    }),
  ),
  includeTransitions: Type.Optional(
    Type.Boolean({
      description:
        "Include each thesis's transition chain (why it was invalidated or realised) instead of only its current state.",
    }),
  ),
});

const NOT_TOUCHED = [
  "trading_execution",
  "order_placement",
  "provider_config",
  "external_channel_sender",
  "protected_memory",
] as const;

function summarize(thesis: FinanceThesis, includeTransitions: boolean) {
  return {
    thesisId: thesis.thesisId,
    instrument: thesis.instrument,
    claim: thesis.claim,
    rationale: thesis.rationale,
    state: thesis.state,
    openedAt: thesis.openedAt,
    closedAt: thesis.closedAt,
    // The conditions the owner said would prove this wrong. They are the reason a thesis is
    // worth storing at all, so they are reported with the thesis rather than behind a flag.
    invalidationConditions: thesis.invalidationConditions,
    evidenceCount: thesis.evidence.length,
    transitionCount: thesis.transitions.length,
    ...(includeTransitions ? { evidence: thesis.evidence, transitions: thesis.transitions } : {}),
  };
}

/**
 * Read-only view of the agent's own theses.
 *
 * The position ledger answers "what do I hold" and the behaviour profile answers "how do I
 * trade". This one answers the third question: "what did I actually believe, and is it still
 * standing". Before it, the thesis ledger was write-only from the agent's side — operator
 * scripts could open and close a thesis, but no tool could read one back, so every answer about
 * prior reasoning was stateless.
 *
 * Two readings this tool exists to prevent:
 *   - An empty book means **no thesis has ever been recorded**, which is not "no thesis is
 *     currently active" and certainly not "every thesis was wrong". The book is only written by
 *     the operator entry, so an empty book is usually a book nobody has written to.
 *   - A closed thesis is not a failed thesis: `invalidated` and `realised` are different
 *     outcomes and they are reported apart.
 *
 * It reports where it read from, because reading the wrong directory is silent — an absent book
 * and a book nobody has written to look identical.
 */
export function createFinanceThesisLedgerReadTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  return {
    label: "Finance Thesis Ledger Read",
    name: "finance_thesis_ledger_read",
    description:
      "Read the durable thesis book: every claim the owner recorded about an instrument, the conditions that would invalidate it, and whether it is still active, invalidated or realised. Use this before answering anything that depends on what was previously believed or on whether that belief was borne out. Read-only: it never opens or closes a thesis, places an order, or touches a venue.",
    parameters: FinanceThesisLedgerReadSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const directory = readStringParam(params, "directory");
      const asOf = readStringParam(params, "asOf");
      const thesisId = readStringParam(params, "thesisId");
      const includeTransitions = params.includeTransitions === true;

      const state = resolveFinanceStateDir({
        workspaceDir: options?.workspaceDir,
        ...(directory === undefined ? {} : { directory }),
      });
      const databasePath: string = financeThesisLedgerPath(state.directory);
      const resolvedFrom: FinanceStateDirSource = state.source;

      if (asOf !== undefined && !Number.isFinite(Date.parse(asOf))) {
        return jsonResult({
          ok: false,
          reason: "finance_thesis_ledger_as_of_invalid",
          asOf,
          action: "Pass asOf as an ISO datetime, or omit it for the current book.",
        });
      }

      const databasePresent = await fs
        .access(databasePath)
        .then(() => true)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            return false;
          }
          throw error;
        });

      if (!databasePresent) {
        return jsonResult({
          ok: false,
          schemaVersion: FINANCE_THESIS_LEDGER_READ_SCHEMA_VERSION,
          boundary: "finance_thesis_ledger_read_only",
          status: "absent",
          reason: "finance_thesis_ledger_absent",
          ledgerDirectory: state.directory,
          resolvedFrom,
          databasePath,
          action:
            "No thesis book exists at this path, so this is not evidence that no thesis is held. " +
            "Set LCX_FINANCE_STATE_DIR (or pass directory) to the directory an operator script " +
            "appended to, or open a first thesis with lcx-finance-thesis-ledger.ts --open.",
          notTouched: NOT_TOUCHED,
        });
      }

      const ledger = await readFinanceThesisLedger(
        state.directory,
        asOf === undefined ? {} : { asOf },
      );

      const selected =
        thesisId === undefined
          ? ledger.theses
          : ledger.theses.filter((thesis) => thesis.thesisId === thesisId);

      if (thesisId !== undefined && selected.length === 0) {
        return jsonResult({
          ok: false,
          schemaVersion: FINANCE_THESIS_LEDGER_READ_SCHEMA_VERSION,
          boundary: "finance_thesis_ledger_read_only",
          status: "absent",
          reason: "finance_thesis_ledger_thesis_id_unknown",
          ledgerDirectory: state.directory,
          resolvedFrom,
          databasePath,
          thesisId,
          knownThesisIds: ledger.theses.map((thesis) => thesis.thesisId),
          action:
            "No thesis in this book has that id, so this is not evidence that it was never held. " +
            "Omit thesisId to list the known ids.",
          notTouched: NOT_TOUCHED,
        });
      }

      const status = ledger.recordCount === 0 ? "empty" : "ready";

      return jsonResult({
        ok: true,
        schemaVersion: FINANCE_THESIS_LEDGER_READ_SCHEMA_VERSION,
        boundary: "finance_thesis_ledger_read_only",
        status,
        ledgerDirectory: state.directory,
        resolvedFrom,
        databasePath,
        databasePresent,
        asOf: asOf ?? null,
        recordCount: ledger.recordCount,
        openedRecordCount: ledger.openedRecordCount,
        transitionRecordCount: ledger.transitionRecordCount,
        headRef: ledger.headRef,
        thesisCount: ledger.theses.length,
        // Reported apart on purpose: `invalidated` and `realised` are different outcomes, and a
        // reader who collapses them into "closed" cannot tell a wrong call from a right one.
        stateCounts: {
          active: ledger.theses.filter((thesis) => thesis.state === "active").length,
          invalidated: ledger.theses.filter((thesis) => thesis.state === "invalidated").length,
          realised: ledger.theses.filter((thesis) => thesis.state === "realised").length,
        },
        // Two different empties, and they lead to different next actions. A book nobody has ever
        // written to means "go record a thesis"; a book that is empty *as of* an early instant
        // just means none existed yet, which says nothing about the book.
        emptyReason:
          ledger.recordCount === 0
            ? asOf === undefined
              ? "no thesis has ever been recorded in this book, which is not evidence that no " +
                "thesis is held: only the operator entry writes here, so this is usually a book " +
                "nobody has written to"
              : `no thesis had been recorded at or before ${asOf}; this is not evidence that no ` +
                "thesis is held, only that none existed yet at that instant"
            : null,
        theses: selected.map((thesis) => summarize(thesis, includeTransitions)),
        notTouched: NOT_TOUCHED,
      });
    },
  };
}
