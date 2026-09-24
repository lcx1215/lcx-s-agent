/**
 * Turn forecast outcomes into a re-checkable directional-calibration proposal.
 *
 * This owner can describe observed forecast accuracy, but it cannot change a
 * paper execution gate. Its input is a binary direction outcome, not realized
 * trade P&L. The proposal remains evidence-linked and reviewable; profitability
 * requires a separate execution, cost, and attribution record.
 */

import {
  deriveDirectionalCalibrationFloor,
  type DirectionalOutcomeSample,
} from "./finance-calibrated-floor.js";

export const TUNING_PROPOSAL_SCHEMA_VERSION = "lcx_finance_tuning_proposal_v2" as const;

export type TuningProposal = Readonly<{
  schemaVersion: typeof TUNING_PROPOSAL_SCHEMA_VERSION;
  proposalId: string;
  scope: "forecast_calibration_only";
  knob: "directionalConfidenceFloor";
  current: number | null;
  proposed: number;
  direction: "initialize" | "lower" | "raise";
  /** Re-derivable from the same directional outcome ledger. */
  evidence: string;
  sampleCount: number;
  confidence: "weak" | "moderate" | "strong";
  generatedAt: string;
  status: "proposed";
  /** Forecast-calibration review only; no paper or live execution authority. */
  applyWith: string;
}>;

export type TuningProposalResult = Readonly<{
  schemaVersion: string;
  proposals: readonly TuningProposal[];
  basis: string;
  samplesUsed: number;
  currentFloor: number | null;
}>;

export function proposeTuning(params: {
  samples: readonly DirectionalOutcomeSample[];
  currentFloor: number | null;
  /** Optional declared policy override. No extra total-sample gate is invented by default. */
  minSamples?: number;
  generatedAt?: string;
}): TuningProposalResult {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const derived = deriveDirectionalCalibrationFloor(params.samples);

  const base = {
    schemaVersion: TUNING_PROPOSAL_SCHEMA_VERSION,
    samplesUsed: derived.samplesUsed,
    currentFloor: params.currentFloor,
  };

  if (params.minSamples !== undefined && derived.samplesUsed < params.minSamples) {
    return {
      ...base,
      proposals: [],
      basis:
        derived.samplesUsed +
        " scored directional sample(s), below the " +
        params.minSamples +
        " needed before a calibration change is worth proposing; this would be tuning on noise",
    };
  }

  if (derived.floor === null) {
    return {
      ...base,
      proposals: [],
      basis:
        "no conviction level met the directional hit-rate baseline over " +
        derived.samplesUsed +
        " scored calls (" +
        derived.basis +
        "), so there is no calibration floor to propose",
    };
  }

  if (derived.floor === params.currentFloor) {
    return {
      ...base,
      proposals: [],
      basis:
        "the derived directional calibration floor already equals the current floor (" +
        params.currentFloor +
        "), so there is nothing to change",
    };
  }

  const direction: TuningProposal["direction"] =
    params.currentFloor === null
      ? "initialize"
      : derived.floor < params.currentFloor
        ? "lower"
        : "raise";
  const hitRateAtFloor = hitRateAtOrAbove(params.samples, derived.floor);
  const confidence: TuningProposal["confidence"] =
    derived.samplesUsed >= 100 ? "strong" : derived.samplesUsed >= 60 ? "moderate" : "weak";
  const transition =
    direction === "initialize"
      ? "this proposes an initial forecast-calibration floor"
      : "the forecast-calibration floor moves from " +
        params.currentFloor +
        " to " +
        derived.floor.toFixed(2);

  return {
    ...base,
    basis: derived.basis,
    proposals: [
      {
        schemaVersion: TUNING_PROPOSAL_SCHEMA_VERSION,
        proposalId:
          "directional-calibration-floor-" +
          String(params.currentFloor ?? "none").replace(".", "_") +
          "-to-" +
          String(derived.floor).replace(".", "_") +
          "-n" +
          derived.samplesUsed,
        scope: "forecast_calibration_only",
        knob: "directionalConfidenceFloor",
        current: params.currentFloor,
        proposed: derived.floor,
        direction,
        evidence:
          "over " +
          derived.samplesUsed +
          " settled directional calls, " +
          hitRateAtFloor.wins +
          " of " +
          hitRateAtFloor.total +
          " calls at conviction " +
          derived.floor.toFixed(2) +
          " or above predicted the direction correctly (hit rate " +
          (hitRateAtFloor.hitRate ?? 0).toFixed(2) +
          "). The 0.5 reference is a coin-flip classification baseline, not an economic break-even estimate; " +
          transition +
          ". This is not evidence of profitability and cannot change paper selection or execution.",
        sampleCount: derived.samplesUsed,
        confidence,
        generatedAt,
        status: "proposed",
        applyWith:
          "forecast-calibration review only; realized net-trade evidence is required before any paper execution threshold can change",
      },
    ],
  };
}

function hitRateAtOrAbove(
  samples: readonly DirectionalOutcomeSample[],
  floor: number,
): { total: number; wins: number; hitRate: number | null } {
  const atOrAbove = samples.filter(
    (sample) => Number.isFinite(sample.conviction) && sample.conviction >= floor,
  );
  const wins = atOrAbove.filter((sample) => sample.outcome === 1).length;
  return {
    total: atOrAbove.length,
    wins,
    hitRate: atOrAbove.length === 0 ? null : wins / atOrAbove.length,
  };
}
