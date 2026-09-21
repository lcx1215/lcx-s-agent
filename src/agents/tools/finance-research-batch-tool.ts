import { Type } from "@sinclair/typebox";
import { DEFAULT_POOL, runResearchBatch } from "../finance-research-batch.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

/**
 * Record what the signals say across a pool of instruments.
 *
 * This is the sampling step of the loop, and the reason it exists as a tool is
 * breadth: a low-frequency judgement on one symbol needs years to produce a
 * usable sample, while the same judgement across forty symbols produces a
 * comparable number of observations in weeks. An agent that can only sample one
 * symbol at a time cannot build the evidence the rest of the stack needs.
 *
 * Deterministic - no model is called. Samples that depend on a model's mood
 * would make any later calibration number measure the mood rather than the
 * signal.
 *
 * Idempotent per instrument and day, so a retry or a schedule overlap cannot
 * double-count an observation. Skipped instruments are reported: a caller should
 * be able to tell "recorded nothing new" from "failed".
 */

export const FINANCE_RESEARCH_BATCH_SCHEMA_VERSION = "lcx_finance_research_batch_v1" as const;

const FinanceResearchBatchSchema = Type.Object({
  instruments: Type.Optional(
    Type.String({
      description: `Comma-separated symbols. Defaults to the ${DEFAULT_POOL.length}-name pool.`,
    }),
  ),
  recordPath: Type.Optional(
    Type.String({
      description:
        "Where samples are appended. Defaults to the resolved finance state directory — the same file the night run settles. Override only to write somewhere deliberately separate.",
    }),
  ),
  maxInstruments: Type.Optional(
    Type.Number({
      description:
        "Cap on instruments per run, to keep provider usage sane. Defaults to all requested.",
    }),
  ),
});

export function createFinanceResearchBatchTool(): AnyAgentTool {
  return {
    name: "finance_research_batch_run",
    label: "Finance research batch",
    description:
      "Sample a pool of instruments and append what the signals said, using the shared sampler. Deterministic (no model), idempotent per instrument and day, and reports which instruments were skipped as already recorded. This is what produces the evidence the calibration and reflection tools read.",
    parameters: FinanceResearchBatchSchema,
    execute: async (_toolCallId, params) => {
      const raw = readStringParam(params, "instruments");
      const requested = raw
        ? raw
            .split(",")
            .map((value) => value.trim().toUpperCase())
            .filter((value) => value.length > 0)
        : [...DEFAULT_POOL];

      const rawCap = params.maxInstruments as number | undefined;
      const capped =
        rawCap !== undefined && Number.isFinite(rawCap) && rawCap > 0
          ? requested.slice(0, Math.floor(rawCap))
          : requested;

      const result = await runResearchBatch({
        instruments: capped,
        ...(readStringParam(params, "recordPath")
          ? { recordPath: readStringParam(params, "recordPath") as string }
          : {}),
      });

      const withDirection = result.recorded.filter((r) => r.direction !== "none").length;
      return jsonResult({
        ok: true,
        schemaVersion: FINANCE_RESEARCH_BATCH_SCHEMA_VERSION,
        asOf: result.asOf,
        recordPath: result.recordPath,
        requested: result.requested,
        recorded: result.recorded.length,
        skippedAlreadyRecorded: result.skipped,
        withDirection,
        refused: result.recorded.length - withDirection,
        records: result.recorded.map((r) => ({
          instrument: r.instrument,
          direction: r.direction,
          conviction: r.conviction,
          agreement: r.agreement,
          sources: r.sources,
          lastPrice: r.lastPrice,
          ...(r.refusals ? { refusals: [...r.refusals] } : {}),
        })),
        note:
          result.recorded.length === 0 && result.skipped > 0
            ? "Nothing new: every requested instrument already has a sample for today."
            : undefined,
      });
    },
  };
}
