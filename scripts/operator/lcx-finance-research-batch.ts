/**
 * Accumulate research samples across a pool of instruments.
 *
 * Why this exists separately from the single research turn: sample size is the
 * binding constraint on knowing whether any of this works, and a low-frequency
 * strategy cannot wait years for one symbol to produce enough observations. The
 * only lever that actually moves is breadth - run the same judgement across
 * many instruments and collect one record per instrument per run.
 *
 * So this deliberately does NOT call the model. A pool of fifty would mean
 * fifty model calls per run, which is slow, rate-limited, and expensive, and
 * the resulting samples would be unrepeatable - the same inputs would not give
 * the same answer twice, so a calibration number computed over them would be
 * measuring the model's mood rather than the signal's accuracy.
 *
 * This path is deterministic: price structure and the analyst target, fused by
 * the same rules the single turn uses. Same inputs, same output, comparable
 * across a thousand observations. The model is for interpreting a shortlist,
 * not for generating samples.
 *
 * Records are appended as JSONL so a later run can fill in what actually
 * happened and score the calibration. Nothing is placed.
 *
 * Usage:
 *   node --import tsx scripts/operator/lcx-finance-research-batch.ts \
 *     --instruments AAPL,MSFT,NVDA --record PATH
 */

import { runResearchBatch } from "../../src/agents/finance-research-batch.js";

/**
 * Default pool: large, liquid US names.
 *
 * Breadth is the point. A low-frequency strategy on one symbol needs years to
 * produce a usable sample; the same judgement across forty symbols produces a
 * comparable number of observations in weeks. These are chosen for liquidity and
 * coverage by the free providers, not because they are expected to be good
 * trades - the pool should be boring, or its composition becomes a hidden bet.
 */
function readArg(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const raw = readArg(args, "--instruments");
  const instruments = raw
    ? raw
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter((value) => value.length > 0)
    : undefined;
  const recordPath = readArg(args, "--record") ?? "state/finance/research-samples.jsonl";

  // The sampler lives in src on purpose: the tool and this script must not hold
  // two copies, or they will drift and disagree about what the system believed
  // on a given day.
  const result = await runResearchBatch({
    ...(instruments ? { instruments } : {}),
    recordPath,
  });

  for (const r of result.recorded) {
    process.stdout.write(
      r.instrument.padEnd(6) +
        " " +
        r.direction.padEnd(5) +
        " conviction=" +
        r.conviction.toFixed(3) +
        " agreement=" +
        r.agreement.toFixed(2) +
        (r.refusals ? "  [" + [...r.refusals].join("; ") + "]" : "") +
        "\n",
    );
  }

  const acted = result.recorded.filter((r) => r.direction !== "none").length;
  process.stdout.write(
    "\nrecorded " +
      result.recorded.length +
      " to " +
      result.recordPath +
      " (" +
      acted +
      " with a direction, " +
      (result.recorded.length - acted) +
      " refused," +
      " " +
      result.skipped +
      " skipped as already present)\n",
  );
}

await main();
