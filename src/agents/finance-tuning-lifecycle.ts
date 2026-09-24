import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DirectionalOutcomeSample } from "./finance-calibrated-floor.js";
import {
  FINANCE_DIRECTIONAL_CALIBRATION_BLOCK_REASON,
  latestFinanceDirectionalCalibrationPromotion,
  type FinancePaperPromotion,
} from "./finance-paper-promotion.js";
import { financeResearchScoredPath, financeTuningProposalsPath } from "./finance-state-dir.js";
import {
  proposeTuning,
  TUNING_PROPOSAL_SCHEMA_VERSION,
  type TuningProposal,
  type TuningProposalResult,
} from "./finance-tuning-proposal.js";

function isCalibrationScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function readFinanceScoredFloorSamples(
  directory: string,
): readonly DirectionalOutcomeSample[] {
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
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return [];
        }
        const row = value as Record<string, unknown>;
        const valid =
          row.schemaVersion === TUNING_PROPOSAL_SCHEMA_VERSION &&
          row.scope === "forecast_calibration_only" &&
          row.knob === "directionalConfidenceFloor" &&
          typeof row.proposalId === "string" &&
          (row.current === null || isCalibrationScore(row.current)) &&
          isCalibrationScore(row.proposed) &&
          ["initialize", "lower", "raise"].includes(String(row.direction)) &&
          typeof row.evidence === "string" &&
          Number.isSafeInteger(row.sampleCount) &&
          Number(row.sampleCount) > 0 &&
          ["weak", "moderate", "strong"].includes(String(row.confidence)) &&
          typeof row.generatedAt === "string" &&
          row.status === "proposed" &&
          typeof row.applyWith === "string";
        return valid ? [value as TuningProposal] : [];
      } catch {
        return [];
      }
    });
}

export type FinanceTuningLifecycleResult = Readonly<{
  proposal: TuningProposalResult;
  newlyRecorded: number;
  /** Kept empty for response compatibility; directional scores no longer promote paper gates. */
  promotions: readonly Readonly<{ promotion: FinancePaperPromotion; appended: boolean }>[];
  paperExecutionPromotion: Readonly<{
    status: "blocked";
    reason: typeof FINANCE_DIRECTIONAL_CALIBRATION_BLOCK_REASON;
  }>;
}>;

/** Directional outcomes -> forecast-calibration proposal; execution promotion needs trade P&L. */
export function runFinanceTuningLifecycle(params: {
  directory: string;
  generatedAt?: string;
  minSamples?: number;
}): FinanceTuningLifecycleResult {
  const samples = readFinanceScoredFloorSamples(params.directory);
  // This prior value is retained only as the forecast-calibration comparison point.
  const currentFloor =
    latestFinanceDirectionalCalibrationPromotion(params.directory)?.promoted ?? null;
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
  const freshProposal = Object.freeze({
    ...proposal,
    proposals: Object.freeze(fresh),
  });
  return Object.freeze({
    proposal: freshProposal,
    newlyRecorded: fresh.length,
    promotions: Object.freeze([]),
    paperExecutionPromotion: Object.freeze({
      status: "blocked",
      reason: FINANCE_DIRECTIONAL_CALIBRATION_BLOCK_REASON,
    }),
  });
}
