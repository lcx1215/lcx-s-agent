import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { breakEvenFloor, type FloorSample } from "./finance-calibrated-floor.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import { financePaperPromotionsPath } from "./finance-state-dir.js";
import type { TuningProposal } from "./finance-tuning-proposal.js";

export const FINANCE_PAPER_PROMOTION_SCHEMA_VERSION =
  "lcx_finance_paper_tuning_promotion_v1" as const;

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
}>;

function isPromotion(value: unknown): value is FinancePaperPromotion {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    row.schemaVersion === FINANCE_PAPER_PROMOTION_SCHEMA_VERSION &&
    typeof row.promotionId === "string" &&
    typeof row.proposalId === "string" &&
    row.knob === "convictionFloor" &&
    (row.previous === null || typeof row.previous === "number") &&
    typeof row.promoted === "number" &&
    Number.isFinite(row.promoted) &&
    Number.isSafeInteger(row.sampleCount) &&
    typeof row.scoredEvidenceRef === "string" &&
    typeof row.promotedAt === "string" &&
    row.authority === "paper_only" &&
    row.status === "promoted" &&
    typeof row.basis === "string"
  );
}

export function readFinancePaperPromotions(directory: string): readonly FinancePaperPromotion[] {
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
        throw new Error(`invalid paper promotion record at line ${index + 1}`);
      }
      return Object.freeze(value);
    });
}

export function latestFinancePaperPromotion(directory: string): FinancePaperPromotion | null {
  return readFinancePaperPromotions(directory).at(-1) ?? null;
}

/**
 * Promote only after independently re-deriving the proposal from the scored ledger.
 * This owner can change paper selection behaviour; it never grants a venue or live authority.
 */
export function deterministicPromotion(params: {
  directory: string;
  proposal: TuningProposal;
  samples: readonly FloorSample[];
  promotedAt?: string;
}): Readonly<{ promotion: FinancePaperPromotion; appended: boolean }> {
  const latest = latestFinancePaperPromotion(params.directory);
  const derived = breakEvenFloor(params.samples);
  if (derived.floor === null) {
    throw new Error(`paper promotion refused: ${derived.basis}`);
  }
  if (params.proposal.knob !== "convictionFloor" || params.proposal.status !== "proposed") {
    throw new Error("paper promotion refused: unsupported proposal contract");
  }
  if (
    params.proposal.proposed !== derived.floor ||
    params.proposal.sampleCount !== derived.samplesUsed
  ) {
    throw new Error("paper promotion refused: proposal no longer matches the scored ledger");
  }

  const scoredEvidenceRef = caseflowFingerprint(params.samples);
  const promotionId = `paper-floor-${caseflowFingerprint({
    proposalId: params.proposal.proposalId,
    previous: params.proposal.current,
    promoted: derived.floor,
    scoredEvidenceRef,
  }).slice(0, 24)}`;
  const existing = readFinancePaperPromotions(params.directory).find(
    (item) => item.promotionId === promotionId,
  );
  if (existing) {
    return Object.freeze({ promotion: existing, appended: false });
  }
  if (params.proposal.current !== (latest?.promoted ?? null)) {
    throw new Error(
      "paper promotion refused: proposal does not start from the promoted paper floor",
    );
  }

  const promotion: FinancePaperPromotion = Object.freeze({
    schemaVersion: FINANCE_PAPER_PROMOTION_SCHEMA_VERSION,
    promotionId,
    proposalId: params.proposal.proposalId,
    knob: "convictionFloor",
    previous: params.proposal.current,
    promoted: derived.floor,
    sampleCount: derived.samplesUsed,
    scoredEvidenceRef,
    promotedAt: params.promotedAt ?? new Date().toISOString(),
    authority: "paper_only",
    status: "promoted",
    basis: derived.basis,
  });
  const filename = financePaperPromotionsPath(params.directory);
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  appendFileSync(filename, `${JSON.stringify(promotion)}\n`, { mode: 0o600 });
  chmodSync(filename, 0o600);
  return Object.freeze({ promotion, appended: true });
}
