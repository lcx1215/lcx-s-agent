import { existsSync, readFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import { breakEvenFloor, type FloorSample } from "../finance-calibrated-floor.js";
import type { FinanceRiskBudget } from "../finance-execution-adapter.js";
import type { FinanceExecutionSafetyContextFactory } from "../finance-execution-safety.js";
import { runFinancePaperOrder } from "../finance-paper-run.js";
import {
  financeResearchSamplesPath,
  financeResearchScoredPath,
  resolveFinanceStateDir,
} from "../finance-state-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

/**
 * Rank the day's recorded candidates and submit the top ones.
 *
 * This does not place orders by itself. It calls `placeFinanceOrder`, the same
 * single seam used by the operator entry, the alpaca run and the paper run.
 * Adding a second route to the venue is how a system ends up with two ideas of
 * what was ordered, and the gates only guard the one that is remembered.
 *
 * The floor is either derived from what the system has actually achieved, or
 * declared explicitly as an exploration value. It is never a silent default: in
 * calibrated mode with no scored outcomes there is no floor and nothing trades,
 * and that is reported rather than worked around.
 *
 * Nothing here loosens a gate. Each selection still goes through the compiler
 * and the mandate - stop declared, risk capped, class resolved - and then
 * through placeFinanceOrder with its own budget.
 */

export const FINANCE_PAPER_RANK_PLACE_SCHEMA_VERSION = "lcx_finance_paper_rank_place_v1" as const;

const FinancePaperRankPlaceSchema = Type.Object({
  workspaceDir: Type.Optional(
    Type.String({
      description:
        "Workspace root whose finance state is read. Defaults to LCX_FINANCE_STATE_DIR, then the workspace default — the same root the daily cycle records its samples into.",
    }),
  ),
  day: Type.Optional(
    Type.String({ description: "UTC day of the samples to rank, YYYY-MM-DD. Defaults to today." }),
  ),
  top: Type.Optional(Type.Number({ description: "How many of the best to take (default 3)." })),
  rankingFloor: Type.Optional(
    Type.Number({
      description:
        "Minimum conviction to be eligible for ranking at all (default 0.15). Ranking alone would happily pick the least bad of a bad set.",
    }),
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal("calibrated"), Type.Literal("explore")], {
      description:
        "calibrated: derive the conviction floor from scored outcomes, and refuse if none can be justified. explore: use exploreFloor, explicitly for generating evidence rather than profit. Default calibrated.",
    }),
  ),
  exploreFloor: Type.Optional(
    Type.Number({ description: "Floor used in explore mode (default 0.1)." }),
  ),
  maxOrderNotional: Type.Optional(Type.Number({ description: "Cap on a single order." })),
  maxInstrumentNotional: Type.Optional(Type.Number({ description: "Cap per instrument." })),
  maxOrdersPerRun: Type.Optional(Type.Number({ description: "Cap on orders this run." })),
  place: Type.Optional(
    Type.Boolean({ description: "Actually submit. Default false: report only." }),
  ),
});

type Sample = {
  asOf: string;
  instrument: string;
  direction: string;
  conviction: number;
  lastPrice: number;
  /** Exact price observation time from its source, never a collection time or EOD date. */
  lastPriceAt?: string;
  lastPriceSource?: string;
  lastPriceDate?: string;
  sources: string[];
};

function numberOr(params: Record<string, unknown>, key: string, fallback: number): number {
  const raw = params[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

export type FinancePaperRankPlaceControl = Readonly<{
  equity: number;
  runAuthorizationId: string;
  budget: FinanceRiskBudget;
  createSafetyContext: FinanceExecutionSafetyContextFactory;
}>;

async function main(
  _toolCallId: string,
  params: Record<string, unknown>,
  control?: FinancePaperRankPlaceControl,
) {
  const day = readStringParam(params, "day") ?? new Date().toISOString().slice(0, 10);
  const top = Math.max(0, Math.floor(numberOr(params, "top", 3)));
  const rankingFloor = numberOr(params, "rankingFloor", 0.15);
  const mode = (readStringParam(params, "mode") ?? "calibrated") as "calibrated" | "explore";
  const exploreFloor = numberOr(params, "exploreFloor", 0.1);
  const equity = control?.equity ?? Number.NaN;
  const authorization = control?.runAuthorizationId ?? "";
  const place = params.place === true;

  // Resolved, not relative: a scheduler does not start from the repository root, and a relative
  // name would then read a second, empty samples file and rank nothing — reporting "no sample
  // file yet" for samples that are on file in the book the cycle actually writes.
  const state = resolveFinanceStateDir({ workspaceDir: readStringParam(params, "workspaceDir") });
  const recordPath = financeResearchSamplesPath(state.directory);
  const scoredPath = financeResearchScoredPath(state.directory);

  if (!existsSync(recordPath)) {
    return jsonResult({
      ok: true,
      schemaVersion: FINANCE_PAPER_RANK_PLACE_SCHEMA_VERSION,
      day,
      placed: [],
      note: "no sample file yet; run the batch before ranking",
    });
  }

  const samples = readFileSync(recordPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Sample];
      } catch {
        return [];
      }
    })
    .filter(
      (s) =>
        s.asOf?.slice(0, 10) === day &&
        (s.direction === "buy" || s.direction === "sell") &&
        Number.isFinite(s.conviction) &&
        s.lastPrice > 0,
    );

  const ranked = samples.toSorted((a, b) => b.conviction - a.conviction);
  const eligible = ranked.filter((s) => s.conviction >= rankingFloor);
  const chosen = eligible.slice(0, top);

  let floor: number | null;
  let floorBasis: string;
  if (mode === "calibrated") {
    const scored: FloorSample[] = existsSync(scoredPath)
      ? readFileSync(scoredPath, "utf8")
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .flatMap((line) => {
            try {
              const row = JSON.parse(line) as { conviction?: unknown; outcome?: unknown };
              const conviction = Number(row.conviction);
              if (!Number.isFinite(conviction)) {
                return [];
              }
              return [{ conviction, outcome: row.outcome === 1 ? 1 : 0 }];
            } catch {
              return [];
            }
          })
      : [];
    const derived = breakEvenFloor(scored);
    floor = derived.floor;
    floorBasis = derived.basis;
    if (floor === null) {
      return jsonResult({
        ok: true,
        schemaVersion: FINANCE_PAPER_RANK_PLACE_SCHEMA_VERSION,
        day,
        mode,
        floor: null,
        floorBasis,
        candidates: samples.length,
        placed: [],
        note: "no data-derived floor, so nothing trades; use explore mode to generate the missing evidence",
      });
    }
  } else {
    floor = exploreFloor;
    floorBasis = "explore mode: declared for evidence generation, not profit";
  }

  if (chosen.length === 0) {
    return jsonResult({
      ok: true,
      schemaVersion: FINANCE_PAPER_RANK_PLACE_SCHEMA_VERSION,
      day,
      mode,
      floor,
      floorBasis,
      candidates: samples.length,
      placed: [],
      note: "nothing clears the ranking floor",
    });
  }

  const budget: FinanceRiskBudget = {
    ...control?.budget,
    automation: "unattended",
    allowedInstruments: control?.budget.allowedInstruments ?? [],
    ...Object.fromEntries(
      ["maxOrderNotional", "maxInstrumentNotional", "maxOrdersPerRun"].map((key) => {
        const ceiling = control?.budget[key as keyof FinanceRiskBudget];
        const requested = params[key];
        return [
          key,
          typeof ceiling === "number"
            ? typeof requested === "number"
              ? Math.min(ceiling, requested)
              : ceiling
            : undefined,
        ];
      }),
    ),
  };

  const results: unknown[] = [];
  let placedCount = 0;

  for (const s of chosen) {
    const stopDistance = s.lastPrice * 0.02;
    const invalidationPrice =
      s.direction === "buy"
        ? Number((s.lastPrice - stopDistance).toFixed(4))
        : Number((s.lastPrice + stopDistance).toFixed(4));

    if (!place || !control || authorization.length === 0) {
      results.push({
        instrument: s.instrument,
        status: "not placed",
        reasons: [
          place
            ? "trusted controller authorization is unavailable; model parameters cannot authorize execution"
            : "place is false; this call reports only",
        ],
      });
      continue;
    }

    if (
      typeof s.lastPriceAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
        s.lastPriceAt,
      ) ||
      !Number.isFinite(Date.parse(s.lastPriceAt)) ||
      Date.parse(s.lastPriceAt) > Date.now() ||
      typeof s.lastPriceSource !== "string" ||
      !s.lastPriceSource.trim()
    ) {
      results.push({
        instrument: s.instrument,
        status: "refused",
        reasons: [
          "missing valid original price observation time/source; sample asOf and EOD date are not quote timestamps",
        ],
      });
      continue;
    }

    // Routed through the paper seam rather than around it: that is where the
    // day guard and the receipt filing live, and a caller that bypasses it
    // produces fills the ledger never hears about.
    const placed = await runFinancePaperOrder({
      createSafetyContext: control.createSafetyContext,
      conclusion: {
        conclusionId: "rank-" + s.instrument.toLowerCase() + "-" + day,
        instrument: s.instrument,
        direction: s.direction === "sell" ? "sell" : "buy",
        conviction: s.conviction,
        thesis:
          "ranked top-" +
          top +
          " of " +
          samples.length +
          " on " +
          day +
          "; price source: " +
          s.lastPriceSource,
        assetClass: "us_equity",
        invalidationPrice,
      },
      market: { referencePrice: s.lastPrice, referencePriceAt: s.lastPriceAt },
      equity,
      runAuthorizationId: authorization,
      budget,
      ordersPlacedThisRun: placedCount,
      instruments: samples.map((x) => x.instrument),
      ...(floor !== null ? { minConviction: floor } : {}),
    });

    if (!placed.ok) {
      results.push({
        instrument: s.instrument,
        status: "refused",
        reasons: [...placed.refusals],
      });
      continue;
    }

    placedCount += 1;
    results.push({
      instrument: s.instrument,
      status: "placed",
      receiptId: placed.receipt.receiptId,
    });
  }

  return jsonResult({
    ok: true,
    schemaVersion: FINANCE_PAPER_RANK_PLACE_SCHEMA_VERSION,
    day,
    mode,
    floor,
    floorBasis,
    candidates: samples.length,
    selected: chosen.length,
    placedCount,
    venue: "paper",
    results,
  });
}

export function createFinancePaperRankPlaceTool(
  control?: FinancePaperRankPlaceControl,
): AnyAgentTool {
  return {
    name: "finance_paper_rank_place",
    label: "Finance paper rank and place",
    description:
      "Rank the day's recorded candidate signals and submit the top ones to the paper venue through placeFinanceOrder, the same seam the operator entry uses. Each selection still clears the intent compiler and the mandate first. Default is report-only: placing requires place:true and a trusted controller authorization with verified account facts. Model parameters cannot grant authority.",
    parameters: FinancePaperRankPlaceSchema,
    execute: (id, params) => main(id, params, control),
  };
}
