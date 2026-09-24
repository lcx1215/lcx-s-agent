import { existsSync, readFileSync } from "node:fs";
import { financePaperPromotionsPath } from "./finance-state-dir.js";

/** Legacy records are retained for audit, but no longer control paper execution. */
export const FINANCE_PAPER_PROMOTION_SCHEMA_VERSION =
  "lcx_finance_paper_tuning_promotion_v1" as const;
export const FINANCE_DIRECTIONAL_CALIBRATION_BLOCK_REASON =
  "directional_forecast_outcomes_are_not_net_trade_pnl" as const;
export const FINANCE_PAPER_EXECUTION_BLOCK_REASON =
  "net_trade_economics_promotion_contract_unavailable" as const;

export type FinancePaperPromotion = Readonly<{
  schemaVersion: typeof FINANCE_PAPER_PROMOTION_SCHEMA_VERSION;
  promotionId: string;
  proposalId: string;
  knob: "convictionFloor";
  previous: number | null;
  promoted: number;
  sampleCount: number;
  scoredEvidenceRef: string;
  promotedAt: string;
  authority: "paper_only";
  status: "promoted";
  basis: string;
  /** Added on read: the historical evidence was forecast direction, not trade P&L. */
  evidenceScope: "legacy_directional_calibration_only";
  executionEligible: false;
}>;

type StoredFinancePaperPromotion = Omit<
  FinancePaperPromotion,
  "evidenceScope" | "executionEligible"
>;

function isPromotion(value: unknown): value is StoredFinancePaperPromotion {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    row.schemaVersion === FINANCE_PAPER_PROMOTION_SCHEMA_VERSION &&
    typeof row.promotionId === "string" &&
    typeof row.proposalId === "string" &&
    row.knob === "convictionFloor" &&
    (row.previous === null ||
      (typeof row.previous === "number" &&
        Number.isFinite(row.previous) &&
        row.previous >= 0 &&
        row.previous <= 1)) &&
    typeof row.promoted === "number" &&
    Number.isFinite(row.promoted) &&
    row.promoted >= 0 &&
    row.promoted <= 1 &&
    Number.isSafeInteger(row.sampleCount) &&
    Number(row.sampleCount) > 0 &&
    typeof row.scoredEvidenceRef === "string" &&
    typeof row.promotedAt === "string" &&
    row.authority === "paper_only" &&
    row.status === "promoted" &&
    typeof row.basis === "string"
  );
}

/** Read historical directional-calibration promotions with their execution boundary attached. */
export function readFinancePaperPromotionHistory(
  directory: string,
): readonly FinancePaperPromotion[] {
  const filename = financePaperPromotionsPath(directory);
  if (!existsSync(filename)) {
    return [];
  }
  return readFileSync(filename, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const value: unknown = JSON.parse(line);
      if (!isPromotion(value)) {
        throw new Error(`invalid legacy paper calibration record at line ${index + 1}`);
      }
      return Object.freeze({
        ...value,
        evidenceScope: "legacy_directional_calibration_only" as const,
        executionEligible: false as const,
      });
    });
}

/** Current trade-economics promotions; v1 directional-only history never qualifies. */
export function readFinancePaperPromotions(_directory: string): readonly FinancePaperPromotion[] {
  return [];
}

/** Most recent historical forecast-calibration baseline; never an execution authorization. */
export function latestFinanceDirectionalCalibrationPromotion(
  directory: string,
): FinancePaperPromotion | null {
  return readFinancePaperPromotionHistory(directory).at(-1) ?? null;
}

/** Current paper execution promotion; unavailable until a net-trade evidence contract exists. */
export function latestFinancePaperPromotion(_directory: string): FinancePaperPromotion | null {
  return null;
}
