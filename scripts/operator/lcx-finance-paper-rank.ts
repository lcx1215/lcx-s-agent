/**
 * Rank the day's recorded candidates and turn the top ones into orders.
 *
 * Why this exists: an absolute conviction floor means the system either trades
 * or it does not, and with the signals available today the honest answer was
 * "does not" - every day, indefinitely. That is not caution, it is a stall that
 * produces no evidence either way.
 *
 * A systematic strategy does not ask "am I sure enough in the abstract". It asks
 * "of the things available today, which are the best few". So this ranks by
 * conviction and takes the top N, subject to a floor that still applies: the
 * floor is what stops the system from picking the least bad of a uniformly bad
 * set. Ranking without a floor is how you end up trading noise because it was
 * the tallest blade of grass.
 *
 * Nothing here loosens the gates. Each candidate still goes through the intent
 * compiler and the mandate - stop declared, risk capped, class resolved. Placing
 * is opt-in and only ever paper unless the venue says otherwise.
 *
 * Usage:
 *   node --import tsx scripts/operator/lcx-finance-paper-rank.ts \
 *     --record PATH --day YYYY-MM-DD --top 3 --floor 0.15 \
 *     --equity 100000 --run-authorization ID [--place]
 */

import { existsSync, readFileSync } from "node:fs";
import { breakEvenFloor, type FloorSample } from "../../src/agents/finance-calibrated-floor.js";
import {
  FINANCE_RISK_BUDGET_ANY_INSTRUMENT,
  createPaperExecutionAdapter,
  placeFinanceOrder,
  type FinanceRiskAutomation,
} from "../../src/agents/finance-execution-adapter.js";
import { compileExecutionIntent } from "../../src/agents/finance-intent-compiler.js";
import {
  classifyFinanceStrategy,
  evaluateFinanceMandate,
} from "../../src/agents/finance-mandate.js";
import {
  financeResearchSamplesPath,
  financeResearchScoredPath,
  resolveFinanceStateDir,
} from "../../src/agents/finance-state-dir.js";

type Sample = {
  asOf: string;
  instrument: string;
  direction: string;
  conviction: number;
  agreement: number;
  sources: string[];
  lastPrice: number;
  target: number | null;
  refusals?: string[];
};

function readArg(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const recordPath =
    readArg(args, "--record") ?? financeResearchSamplesPath(resolveFinanceStateDir().directory);
  const day = readArg(args, "--day") ?? new Date().toISOString().slice(0, 10);
  const top = Number(readArg(args, "--top") ?? 3);
  const floor = Number(readArg(args, "--floor") ?? 0.15);
  const equity = Number(readArg(args, "--equity") ?? 100_000);
  const authorization = readArg(args, "--run-authorization") ?? "";
  const place = args.includes("--place");

  // The floor is either derived from what the system has actually achieved, or
  // explicitly declared as an exploration value. It is never a silent default.
  const mode = readArg(args, "--mode") ?? "calibrated";
  const scoredPath =
    readArg(args, "--scored") ?? financeResearchScoredPath(resolveFinanceStateDir().directory);
  const exploreFloor = Number(readArg(args, "--explore-floor") ?? 0.1);

  let effectiveFloor: number | null = floor;
  let floorBasis = "ranking floor supplied on the command line";
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
    effectiveFloor = derived.floor;
    floorBasis = derived.basis;
    if (derived.floor === null) {
      process.stdout.write(
        "calibrated mode: no data-derived floor - " +
          derived.basis +
          "\nrefusing to trade; use --mode explore to generate the missing evidence\n",
      );
      return;
    }
    process.stdout.write(
      "calibrated floor=" + derived.floor.toFixed(3) + " (" + derived.basis + ")\n",
    );
  } else {
    effectiveFloor = exploreFloor;
    floorBasis = "explore mode: declared for evidence generation, not profit";
    process.stdout.write("explore floor=" + exploreFloor.toFixed(3) + " (" + floorBasis + ")\n");
  }

  if (!existsSync(recordPath)) {
    process.stdout.write("no sample file at " + recordPath + "\n");
    return;
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
    .filter((s) => s.asOf.slice(0, 10) === day)
    .filter((s) => s.direction === "buy" || s.direction === "sell")
    .filter((s) => Number.isFinite(s.conviction) && s.lastPrice > 0);

  const ranked = samples.toSorted((a, b) => b.conviction - a.conviction);
  const eligible = ranked.filter((s) => s.conviction >= floor);
  const chosen = eligible.slice(0, Math.max(0, top));

  process.stdout.write(
    "day=" +
      day +
      " candidates=" +
      samples.length +
      " aboveFloor=" +
      eligible.length +
      " selected=" +
      chosen.length +
      " (top=" +
      top +
      " floor=" +
      floor +
      ")\n\n",
  );

  if (chosen.length === 0) {
    process.stdout.write(
      "nothing clears the floor; refusing to trade the least bad of a bad set\n",
    );
    return;
  }

  const asOf = new Date().toISOString();
  // Unattended requires every cap; attended leaves them opt-in. So a scheduled
  // run has to name its boundaries, and cannot inherit someone else's.
  const automation = (readArg(args, "--automation") ?? "attended") as FinanceRiskAutomation;
  const budget = {
    automation,
    maxOrderNotional: Number(readArg(args, "--max-order-notional") ?? 5000),
    maxInstrumentNotional: Number(readArg(args, "--max-instrument-notional") ?? 5000),
    maxOrdersPerRun: Number(readArg(args, "--max-orders-per-run") ?? 3),
    allowedInstruments: [FINANCE_RISK_BUDGET_ANY_INSTRUMENT],
  };
  const paperAdapter = createPaperExecutionAdapter({
    instruments: samples.map((c) => c.instrument),
    slippageBps: Number(readArg(args, "--slippage-bps") ?? 0),
  });
  let placedCount = 0;

  for (const s of chosen) {
    const stopDistance = s.lastPrice * 0.02;
    const invalidationPrice =
      s.direction === "buy"
        ? Number((s.lastPrice - stopDistance).toFixed(4))
        : Number((s.lastPrice + stopDistance).toFixed(4));

    const strategyClass = classifyFinanceStrategy({ assetClass: "us_equity" });
    const compiled = compileExecutionIntent({
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
          " at conviction " +
          s.conviction,
        assetClass: "us_equity",
        invalidationPrice,
      },
      market: { referencePrice: s.lastPrice, referencePriceAt: asOf },
      equity,
      runAuthorizationId: authorization,
      ...(effectiveFloor !== null ? { minConviction: effectiveFloor } : {}),
      ...(strategyClass !== "unknown" ? { strategyClass } : {}),
    });

    if (!compiled.ok) {
      process.stdout.write(
        s.instrument.padEnd(6) + " refused at compile: " + [...compiled.refusals].join("; ") + "\n",
      );
      continue;
    }

    const mandate = evaluateFinanceMandate({
      strategy: { assetClass: "us_equity" },
      riskFractionOfEquity: (compiled.intent.quantity * stopDistance) / equity,
      drawdownFraction: 0,
      stopLossDefined: true,
      hasSignificantAutocorrelation: true,
    });

    process.stdout.write(
      s.instrument.padEnd(6) +
        " conviction=" +
        s.conviction.toFixed(3) +
        " " +
        compiled.intent.side +
        " qty=" +
        compiled.intent.quantity +
        " stop=" +
        (compiled.intent.stopPrice?.toFixed(2) ?? "none") +
        " mandate=" +
        mandate.verdict +
        (mandate.verdict === "pass" ? "" : " [" + mandate.reasons.join("; ") + "]") +
        "\n",
    );

    if (place && mandate.verdict === "pass") {
      const result = await placeFinanceOrder({
        mode: "live_execution",
        intent: compiled.intent,
        budget,
        adapters: [paperAdapter],
        executionAdapterId: paperAdapter.id,
        committedInstrumentNotional: 0,
        ordersPlacedThisRun: placedCount,
      });
      if (result.status === "placed") {
        placedCount += 1;
        process.stdout.write("   placed " + (result.receipt?.receiptId ?? "?") + "\n");
      } else {
        process.stdout.write("   refused: " + [...result.refusalReasons].join("; ") + "\n");
      }
    }
  }

  if (!place) {
    process.stdout.write("\ndry run; pass --place to submit to the paper venue\n");
  }
}

await main();
