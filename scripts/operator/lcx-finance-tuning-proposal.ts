/**
 * Operator entry for the step after reflection.
 *
 * The nightly cycle settles matured calls and builds the reflection, and that was
 * where the chain ended: the numbers got printed and nothing followed. This runs
 * the shared forecast-calibration proposal lifecycle.
 *
 * It exists as an operator entry rather than only as a tool because a step that
 * only a conversation can reach is a step that does not happen on a schedule.
 * Directional outcomes never promote a paper execution threshold. Net-trade evidence is a separate gate.
 *
 * Usage:
 *   node --import tsx scripts/operator/lcx-finance-tuning-proposal.ts [--json] \
 *     [--min-samples N] [--dir PATH]
 *
 * Exit code is 0 whether or not a proposal was produced. "No proposal, and here
 * is why" is a successful run: most days there will not be enough settled
 * evidence, and treating that as failure would train everyone to ignore it.
 */

import { resolveFinanceStateDir } from "../../src/agents/finance-state-dir.js";
import { runFinanceTuningLifecycle } from "../../src/agents/finance-tuning-lifecycle.js";

function readArg(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const directory = readArg(args, "--dir") ?? resolveFinanceStateDir().directory;
  const rawMin = Number(readArg(args, "--min-samples"));
  const lifecycle = runFinanceTuningLifecycle({
    directory,
    ...(Number.isFinite(rawMin) && rawMin > 0 ? { minSamples: Math.floor(rawMin) } : {}),
  });
  const result = lifecycle.proposal;

  if (asJson) {
    process.stdout.write(JSON.stringify({ ...result, ...lifecycle, directory }, null, 2) + "\n");
    return;
  }

  process.stdout.write(
    "forecast calibration baseline " +
      String(result.currentFloor ?? "none") +
      ", " +
      result.samplesUsed +
      " settled sample(s)\n",
  );
  if (result.proposals.length === 0) {
    process.stdout.write("  no proposal - " + result.basis + "\n");
  } else {
    for (const p of result.proposals) {
      process.stdout.write(
        "  PROPOSE " +
          p.knob +
          ": " +
          p.current +
          " -> " +
          p.proposed +
          " (" +
          p.direction +
          ", confidence " +
          p.confidence +
          ")\n" +
          "    evidence: " +
          p.evidence +
          "\n" +
          "    apply with: " +
          p.applyWith +
          "\n",
      );
    }
  }
  process.stdout.write(
    "  paper execution promotion: " +
      lifecycle.paperExecutionPromotion.status +
      " (" +
      lifecycle.paperExecutionPromotion.reason +
      ")\n",
  );
  if (lifecycle.newlyRecorded > 0) {
    process.stdout.write("  recorded " + lifecycle.newlyRecorded + " new proposal(s)\n");
  }
}

await main();
