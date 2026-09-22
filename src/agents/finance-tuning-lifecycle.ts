import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FloorSample } from "./finance-calibrated-floor.js";
import {
  deterministicPromotion,
  latestFinancePaperPromotion,
  type FinancePaperPromotion,
} from "./finance-paper-promotion.js";
import { financeResearchScoredPath, financeTuningProposalsPath } from "./finance-state-dir.js";
import {
  proposeTuning,
  type TuningProposal,
  type TuningProposalResult,
} from "./finance-tuning-proposal.js";

export function readFinanceScoredFloorSamples(directory: string): readonly FloorSample[] {
  const filename = financeResearchScoredPath(directory);
  if (!existsSync(filename)) {
    return [];
  }
  return readFileSync(filename, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const row = JSON.parse(line) as { conviction?: unknown; outcome?: unknown };
        const conviction = Number(row.conviction);
        return Number.isFinite(conviction) && (row.outcome === 0 || row.outcome === 1)
          ? [{ conviction, outcome: row.outcome }]
          : [];
      } catch {
        return [];
      }
    });
}

export function readFinanceTuningProposals(directory: string): readonly TuningProposal[] {
  const filename = financeTuningProposalsPath(directory);
  if (!existsSync(filename)) {
    return [];
  }
  return readFileSync(filename, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const row = JSON.parse(line) as TuningProposal;
        return typeof row.proposalId === "string" ? [row] : [];
      } catch {
        return [];
      }
    });
}

export type FinanceTuningLifecycleResult = Readonly<{
  proposal: TuningProposalResult;
  newlyRecorded: number;
  promotions: readonly Readonly<{ promotion: FinancePaperPromotion; appended: boolean }>[];
}>;

/** New scored evidence -> proposal -> deterministic paper-only promotion. */
export function runFinanceTuningLifecycle(params: {
  directory: string;
  generatedAt?: string;
  minSamples?: number;
}): FinanceTuningLifecycleResult {
  const samples = readFinanceScoredFloorSamples(params.directory);
  const currentFloor = latestFinancePaperPromotion(params.directory)?.promoted ?? null;
  const proposal = proposeTuning({
    samples,
    currentFloor,
    ...(params.minSamples === undefined ? {} : { minSamples: params.minSamples }),
    ...(params.generatedAt === undefined ? {} : { generatedAt: params.generatedAt }),
  });
  const existingIds = new Set(
    readFinanceTuningProposals(params.directory).map((item) => item.proposalId),
  );
  const fresh = proposal.proposals.filter((item) => !existingIds.has(item.proposalId));
  if (fresh.length > 0) {
    const filename = financeTuningProposalsPath(params.directory);
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    appendFileSync(filename, `${fresh.map((item) => JSON.stringify(item)).join("\n")}\n`, {
      mode: 0o600,
    });
    chmodSync(filename, 0o600);
  }
  const promotions = fresh.map((item) =>
    deterministicPromotion({
      directory: params.directory,
      proposal: item,
      samples,
      ...(params.generatedAt === undefined ? {} : { promotedAt: params.generatedAt }),
    }),
  );
  return Object.freeze({
    proposal,
    newlyRecorded: fresh.length,
    promotions: Object.freeze(promotions),
  });
}
