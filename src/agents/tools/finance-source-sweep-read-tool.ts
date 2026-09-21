import { Type } from "@sinclair/typebox";
import { DEFAULT_SWEEP_MAX_ATTEMPTS, sweepFinanceSources } from "../finance-source-sweep.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

/**
 * Discover which registered sources actually return data, right now.
 *
 * Before this existed, the answer to "what sources do we have" was a guess, or
 * a manual sweep that took several minutes and whose results were then quoted
 * from memory days later. An agent can now ask.
 *
 * It is capped by default because a full sweep is hundreds of provider calls.
 * When the cap bites, the result says so: reporting "these N worked" while
 * quietly having only looked at a fraction would let a caller mistake a partial
 * answer for a complete one.
 *
 * It calls providers, so it is not free and not instant, but it writes nothing.
 */

export const FINANCE_SOURCE_SWEEP_READ_SCHEMA_VERSION = "lcx_finance_source_sweep_read_v1" as const;

const MAX_ATTEMPTS_HARD_CAP = 120;

const FinanceSourceSweepReadSchema = Type.Object({
  instrument: Type.Optional(
    Type.String({ description: "Symbol to probe with. Defaults to AAPL." }),
  ),
  maxAttempts: Type.Optional(
    Type.Number({
      description: `Maximum provider probes (default ${DEFAULT_SWEEP_MAX_ATTEMPTS}, hard cap ${MAX_ATTEMPTS_HARD_CAP}). Higher is more complete and much slower.`,
    }),
  ),
  includeFailures: Type.Optional(
    Type.Boolean({
      description:
        "Include the sources that returned nothing. Defaults to true: a registered source that stays silent is the thing most worth seeing.",
    }),
  ),
});

export function createFinanceSourceSweepReadTool(): AnyAgentTool {
  return {
    name: "finance_source_sweep_read",
    label: "Finance source sweep",
    description:
      "Probe every registered finance source and report which ones actually return data for a symbol right now, with record counts. Reports the ones that returned nothing too. Capped by default; the result says when the cap was hit so a partial sweep is never mistaken for a complete one.",
    parameters: FinanceSourceSweepReadSchema,
    execute: async (_toolCallId, params) => {
      const instrument = readStringParam(params, "instrument");
      const rawAttempts = params.maxAttempts as number | undefined;
      const includeFailures = params.includeFailures !== false;

      const maxAttempts =
        rawAttempts !== undefined && Number.isFinite(rawAttempts) && rawAttempts > 0
          ? Math.min(Math.floor(rawAttempts), MAX_ATTEMPTS_HARD_CAP)
          : DEFAULT_SWEEP_MAX_ATTEMPTS;

      const result = await sweepFinanceSources({
        ...(instrument ? { instrument } : {}),
        maxAttempts,
      });

      return jsonResult({
        ok: true,
        schemaVersion: FINANCE_SOURCE_SWEEP_READ_SCHEMA_VERSION,
        instrument: result.instrument,
        asOf: result.asOf,
        adaptersSeen: result.adaptersSeen,
        attempts: result.attempts,
        capped: result.capped,
        workingCount: result.working.length,
        failedCount: result.failed.length,
        working: result.working.map((row) => ({
          adapterId: row.adapterId,
          collection: row.collection,
          records: row.records,
          fields: row.fields,
        })),
        failures: includeFailures
          ? result.failed.map((row) => ({
              adapterId: row.adapterId,
              collection: row.collection,
              error: row.error ?? "no records",
            }))
          : undefined,
        note: result.capped
          ? `Stopped at ${result.attempts} probes (cap). Treat this as a partial sweep, not a complete inventory.`
          : undefined,
      });
    },
  };
}
