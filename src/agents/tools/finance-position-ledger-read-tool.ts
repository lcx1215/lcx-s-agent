import fs from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import {
  buildFinanceBehaviourProfile,
  parseFinanceBehaviourThresholds,
  type FinanceBehaviourThresholds,
} from "../finance-behaviour-profile.js";
import { buildFinanceEquityCurve } from "../finance-equity-curve.js";
import type { FinanceExecutionReceipt } from "../finance-execution-adapter.js";
import {
  readFinancePositionLedger,
  readFinancePositionRecords,
  type FinancePositionMark,
} from "../finance-position-ledger.js";
import {
  financeBehaviourThresholdsPath,
  resolveFinancePositionLedgerLocation,
} from "../finance-state-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

export const FINANCE_POSITION_LEDGER_READ_SCHEMA_VERSION =
  "lcx_finance_position_ledger_read_v1" as const;

const FinancePositionLedgerReadSchema = Type.Object({
  directory: Type.Optional(
    Type.String({
      description:
        "Ledger directory to read. Defaults to LCX_FINANCE_STATE_DIR, then <workspace>/state/finance.",
    }),
  ),
  asOf: Type.Optional(
    Type.String({
      description:
        "ISO datetime for a point-in-time view. Only marks at or before this instant are used.",
    }),
  ),
  initialCapital: Type.Optional(
    Type.Number({
      description:
        "Positive starting capital. Supplying it adds the equity-curve projection; without it no curve is produced and no return figure is invented.",
    }),
  ),
  includeCurveLevels: Type.Optional(
    Type.Boolean({
      description: "Include the full equity level series instead of only its summary.",
    }),
  ),
  includeBehaviour: Type.Optional(
    Type.Boolean({
      description:
        "Include the behaviour profile of the recorded fills (disposition effect, turnover, momentum chasing, anchoring). Measured numbers are always reported; a dimension carries a label only when the owner has declared that dimension's threshold in the ledger's behaviour-thresholds.json. Descriptive observations, never advice.",
    }),
  ),
});

/**
 * Build the behaviour section of a ledger read.
 *
 * A declaration that exists but does not parse is **reported, not thrown**. The positions are
 * still the answer to the question that was asked, and a broken declaration is not a reason to
 * make the book unreadable. The validation rules come from `parseFinanceBehaviourThresholds`, so
 * this tool and the operator entry cannot come to disagree about what a valid declaration is —
 * only their failure behaviour differs.
 *
 * The profile is built over the stream the ledger projection actually consumed, so a label can
 * never describe different fills than the positions printed beside it.
 */
async function readBehaviourSection(params: {
  directory: string;
  receipts: readonly FinanceExecutionReceipt[];
  marks: readonly FinancePositionMark[];
}) {
  const thresholdsFile = financeBehaviourThresholdsPath(params.directory);
  let raw: string | null = null;
  try {
    raw = await fs.readFile(thresholdsFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  let declared: FinanceBehaviourThresholds | null = null;
  let thresholdsError: string | null = null;
  if (raw !== null) {
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      thresholdsError = `${thresholdsFile} is not valid JSON`;
    }
    if (thresholdsError === null) {
      const parsed = parseFinanceBehaviourThresholds(value, thresholdsFile);
      if (parsed.ok) {
        declared = parsed.thresholds;
      } else {
        thresholdsError = parsed.error;
      }
    }
  }

  return {
    status: "computed" as const,
    thresholdsFile,
    thresholdsDeclared: declared !== null,
    thresholdsError,
    profile: buildFinanceBehaviourProfile({
      receipts: params.receipts,
      marks: params.marks,
      ...(declared === null ? {} : { thresholds: declared }),
    }),
  };
}

/**
 * Read-only view of the agent's own book.
 *
 * Before this tool the ledger was write-only from the agent's side: fills and marks could be
 * appended by operator scripts, but no tool could answer "what do I hold, and what is it
 * worth". That made every finance answer stateless, so the agent could not reason about a
 * position it had already opened or a call it had already made.
 *
 * It reports where it read from. Reading the wrong directory is silent — an absent book and
 * a flat account look identical — so `ledgerDirectory`, `resolvedFrom` and `status` are part
 * of the result, and an absent database is a named failure rather than an empty portfolio.
 *
 * `includeBehaviour` adds the behaviour profile over the same stream. The boundary it reports
 * against is the owner's, not the caller's: the thresholds come from the declaration file in the
 * ledger directory, which the operator entry resolves to the same path, and the caller cannot
 * substitute its own. That is deliberate — a model choosing the thresholds would be making the
 * judgement and then reading its own measurement as evidence for it.
 */
export function createFinancePositionLedgerReadTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  return {
    label: "Finance Position Ledger Read",
    name: "finance_position_ledger_read",
    description:
      "Read the durable position book: open positions, average cost, realized and unrealized PnL, marks, and (when initial capital is supplied) the equity curve derived from the same stream. Use this before answering anything that depends on what is currently held or on how a prior position is doing. With includeBehaviour it also describes how the owner has actually traded — disposition effect, turnover, momentum chasing, anchoring — as measurements over the recorded fills. Read-only: it never appends a fill, places an order, or touches a venue.",
    parameters: FinancePositionLedgerReadSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const directory = readStringParam(params, "directory");
      const asOf = readStringParam(params, "asOf");
      const initialCapital = readNumberParam(params, "initialCapital");
      const includeCurveLevels = params.includeCurveLevels === true;
      const includeBehaviour = params.includeBehaviour === true;

      const location = resolveFinancePositionLedgerLocation({
        workspaceDir: options?.workspaceDir,
        directory,
      });

      if (asOf !== undefined && !Number.isFinite(Date.parse(asOf))) {
        return jsonResult({
          ok: false,
          reason: "finance_position_ledger_as_of_invalid",
          asOf,
          action: "Pass asOf as an ISO datetime, or omit it for the current book.",
        });
      }
      if (
        initialCapital !== undefined &&
        (!Number.isFinite(initialCapital) || initialCapital <= 0)
      ) {
        return jsonResult({
          ok: false,
          reason: "finance_position_ledger_initial_capital_invalid",
          initialCapital,
          action:
            "initialCapital must be a positive finite number. Omit it to read positions without an equity curve.",
        });
      }

      const databasePresent = await fs
        .access(location.database)
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
          schemaVersion: FINANCE_POSITION_LEDGER_READ_SCHEMA_VERSION,
          boundary: "finance_position_ledger_read_only",
          status: "absent",
          reason: "finance_position_ledger_absent",
          ledgerDirectory: location.directory,
          resolvedFrom: location.source,
          databasePath: location.database,
          action:
            "No ledger exists at this path, so this is not evidence of a flat book. Set LCX_FINANCE_STATE_DIR (or pass directory) to the directory an operator script appended to, or append a first execution receipt.",
          notTouched: [
            "trading_execution",
            "order_placement",
            "provider_config",
            "external_channel_sender",
            "protected_memory",
          ],
        });
      }

      const read = await readFinancePositionRecords(location.directory);
      const ledgerRead = await readFinancePositionLedger(
        location.directory,
        asOf === undefined ? {} : { asOf },
      );
      const { ledger } = ledgerRead;

      const openPositions = ledger.positions.filter((position) => position.quantity !== 0);
      const status =
        ledgerRead.recordCount === 0
          ? "empty"
          : ledger.unrealizedPnl === null
            ? "partial_no_mark"
            : "ready";

      const equityCurve =
        initialCapital === undefined
          ? { status: "not_requested" as const }
          : (() => {
              const curve = buildFinanceEquityCurve({
                receipts: read.receipts,
                marks: read.marks,
                initialCapital,
              });
              return {
                status: "computed" as const,
                initialCapital,
                sampleCount: curve.sampleCount,
                finalEquity: curve.finalEquity,
                definedLevelCount: curve.levels.length,
                undefinedEquityAt: curve.undefinedEquityAt,
                receiptsAfterLastMark: curve.receiptsAfterLastMark,
                meanSampleSpacingSeconds: curve.meanSampleSpacingSeconds,
                ...(includeCurveLevels
                  ? { levels: curve.levels, levelTimestamps: curve.levelTimestamps }
                  : {}),
              };
            })();

      const behaviour = includeBehaviour
        ? await readBehaviourSection({
            directory: location.directory,
            receipts: ledgerRead.receipts,
            marks: ledgerRead.marks,
          })
        : ({ status: "not_requested" as const } as const);

      return jsonResult({
        ok: true,
        schemaVersion: FINANCE_POSITION_LEDGER_READ_SCHEMA_VERSION,
        boundary: "finance_position_ledger_read_only",
        status,
        ledgerDirectory: location.directory,
        resolvedFrom: location.source,
        databasePath: location.database,
        asOf: asOf ?? null,
        // Stated because the ledger's own as-of view filters marks only: a fill recorded after
        // the instant still contributes to the position it opened.
        asOfCaveat:
          asOf === undefined
            ? null
            : "positions include every recorded fill; only marks are limited to asOf",
        recordCount: ledgerRead.recordCount,
        receiptRecordCount: ledgerRead.receiptRecordCount,
        markRecordCount: ledgerRead.markRecordCount,
        headRef: ledgerRead.headRef,
        // Paper and venue fills are reported apart so a simulated book is never read as real.
        paperFillCount: ledger.paperFillCount,
        venueFillCount: ledger.venueFillCount,
        positionCount: ledger.positions.length,
        openPositionCount: openPositions.length,
        positions: ledger.positions,
        realizedPnl: ledger.realizedPnl,
        unrealizedPnl: ledger.unrealizedPnl,
        unrealizedUnavailableReason:
          ledger.unrealizedPnl === null
            ? "at least one open position has no usable mark; a partial sum would overstate certainty"
            : null,
        instrumentsWithoutMark: ledger.instrumentsWithoutMark,
        rejectedMarks: ledger.rejectedMarks,
        equityCurve,
        behaviour,
        notTouched: [
          "trading_execution",
          "order_placement",
          "provider_config",
          "external_channel_sender",
          "protected_memory",
        ],
      });
    },
  };
}
