import { createHash } from "node:crypto";
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

export type FinanceScoredSourceRead = Readonly<{
  status: "read" | "absent";
  path: string;
  sha256?: string;
  bytes?: number;
  includedSampleCount: number;
  ignoredRowCount: number;
  usedFields: readonly ["conviction", "outcome"];
  boundary: "raw_ledger_bytes_and_parsed_fields_not_source_truth";
}>;

/** The bytes hashed here are the same single read used by the legacy score parser. */
export function readFinanceScoredFloorSamplesWithSource(directory: string): Readonly<{
  samples: readonly DirectionalOutcomeSample[];
  sourceRead: FinanceScoredSourceRead;
}> {
  const filename = financeResearchScoredPath(directory);
  const identity = {
    path: filename,
    usedFields: Object.freeze(["conviction", "outcome"] as const),
    boundary: "raw_ledger_bytes_and_parsed_fields_not_source_truth" as const,
  };
  if (!existsSync(filename)) {
    return Object.freeze({
      samples: [],
      sourceRead: Object.freeze({
        ...identity,
        status: "absent",
        includedSampleCount: 0,
        ignoredRowCount: 0,
      }),
    });
  }
  const bytes = readFileSync(filename);
  const rows = bytes.toString("utf8").split("\n").filter(Boolean);
  const samples: DirectionalOutcomeSample[] = rows.flatMap((line) => {
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
  return Object.freeze({
    samples,
    sourceRead: Object.freeze({
      ...identity,
      status: "read",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      includedSampleCount: samples.length,
      ignoredRowCount: rows.length - samples.length,
    }),
  });
}

export function readFinanceScoredFloorSamples(
  directory: string,
): readonly DirectionalOutcomeSample[] {
  return readFinanceScoredFloorSamplesWithSource(directory).samples;
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
  sourceRead: FinanceScoredSourceRead;
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
  expectedSource?: Readonly<{ path: string; sha256: string; bytes: number }>;
}): FinanceTuningLifecycleResult {
  const { samples, sourceRead } = readFinanceScoredFloorSamplesWithSource(params.directory);
  if (params.expectedSource !== undefined) {
    const expected = params.expectedSource;
    if (
      !expected ||
      typeof expected.path !== "string" ||
      !expected.path.trim() ||
      typeof expected.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(expected.sha256) ||
      !Number.isSafeInteger(expected.bytes) ||
      expected.bytes < 0 ||
      sourceRead.status !== "read" ||
      path.resolve(expected.path) !== path.resolve(sourceRead.path) ||
      expected.sha256 !== sourceRead.sha256 ||
      expected.bytes !== sourceRead.bytes
    ) {
      throw new Error(
        "input_source_mismatch: finance scored source path/hash/bytes or availability mismatch",
      );
    }
  }
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
    sourceRead,
    proposal: freshProposal,
    newlyRecorded: fresh.length,
    promotions: Object.freeze([]),
    paperExecutionPromotion: Object.freeze({
      status: "blocked",
      reason: FINANCE_DIRECTIONAL_CALIBRATION_BLOCK_REASON,
    }),
  });
}
