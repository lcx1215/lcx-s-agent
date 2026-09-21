/**
 * Operator entry for the step after reflection.
 *
 * The nightly cycle settles matured calls and builds the reflection, and that was
 * where the chain ended: the numbers got printed and nothing followed. This runs
 * the next step and stops before the one that matters - it proposes, it does not
 * apply.
 *
 * It exists as an operator entry rather than only as a tool because a step that
 * only a conversation can reach is a step that does not happen on a schedule.
 * The loop has to close on its own up to the point where a human is required.
 *
 * Usage:
 *   node --import tsx scripts/operator/lcx-finance-tuning-proposal.ts [--json] \
 *     [--current-floor N] [--min-samples N] [--dir PATH]
 *
 * Exit code is 0 whether or not a proposal was produced. "No proposal, and here
 * is why" is a successful run: most days there will not be enough settled
 * evidence, and treating that as failure would train everyone to ignore it.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FloorSample } from "../../src/agents/finance-calibrated-floor.js";
import { resolveFinanceStateDir } from "../../src/agents/finance-state-dir.js";
import { proposeTuning, type TuningProposal } from "../../src/agents/finance-tuning-proposal.js";

const SCORED_FILE = "research-scored.jsonl";
const PROPOSALS_FILE = "tuning-proposals.jsonl";
const DEFAULT_FLOOR = 0.6;
const DEFAULT_MIN_SAMPLES = 30;

function readArg(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function readScored(file: string): FloorSample[] {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const row = JSON.parse(line) as { conviction?: unknown; outcome?: unknown };
        const conviction = Number(row.conviction);
        if (!Number.isFinite(conviction) || (row.outcome !== 0 && row.outcome !== 1)) {
          return [];
        }
        return [{ conviction, outcome: row.outcome }];
      } catch {
        return [];
      }
    });
}

function readProposals(file: string): TuningProposal[] {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const row = JSON.parse(line) as TuningProposal;
        return typeof row?.proposalId === "string" ? [row] : [];
      } catch {
        return [];
      }
    });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const directory = readArg(args, "--dir") ?? resolveFinanceStateDir().directory;
  const rawFloor = Number(readArg(args, "--current-floor"));
  const rawMin = Number(readArg(args, "--min-samples"));
  const currentFloor = Number.isFinite(rawFloor) ? rawFloor : DEFAULT_FLOOR;
  const minSamples =
    Number.isFinite(rawMin) && rawMin > 0 ? Math.floor(rawMin) : DEFAULT_MIN_SAMPLES;

  const scoredFile = join(directory, SCORED_FILE);
  const proposalsFile = join(directory, PROPOSALS_FILE);

  const result = proposeTuning({
    samples: readScored(scoredFile),
    currentFloor,
    minSamples,
  });

  const existingIds = new Set(readProposals(proposalsFile).map((p) => p.proposalId));
  const fresh = result.proposals.filter((p) => !existingIds.has(p.proposalId));
  if (fresh.length > 0) {
    mkdirSync(dirname(proposalsFile), { recursive: true });
    appendFileSync(proposalsFile, fresh.map((p) => JSON.stringify(p)).join("\n") + "\n");
  }

  if (asJson) {
    process.stdout.write(
      JSON.stringify({ ...result, newlyRecorded: fresh.length, directory }, null, 2) + "\n",
    );
    return;
  }

  process.stdout.write(
    "tuning proposal: floor " + currentFloor + ", " + result.samplesUsed + " settled sample(s)\n",
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
  if (fresh.length > 0) {
    process.stdout.write("  recorded " + fresh.length + " new proposal(s)\n");
  }
}

await main();
