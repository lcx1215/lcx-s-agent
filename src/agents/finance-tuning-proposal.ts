/**
 * Turn the track record into a proposal someone can act on - and stop there.
 *
 * The loop was open at its last step: settlement and reflection run every night,
 * the numbers get printed and injected into the next prompt, and then nothing
 * happens. The system will tell you it is inaccurate and will not do anything
 * about it. That is the right half of a design (a model that can rewrite its own
 * rules will rewrite them to finish the task) and the wrong half of a loop.
 *
 * What was missing is the step before application: a proposal. This produces
 * one, with the evidence attached, and applies nothing.
 *
 * The separation matters:
 *
 * - proposing can be automatic, because a proposal costs nothing if it is wrong.
 * - applying stays manual, because applying is what changes behaviour.
 *
 * Every proposal carries its own falsification. Not "the floor feels too high",
 * but "at conviction 0.5 and above the realised hit rate is 0.71 over 14 settled
 * calls, against a floor of 0.6" - a claim a reader can check against the same
 * ledger this read from. A proposal whose evidence cannot be re-derived is not a
 * proposal, it is an opinion, and it is not emitted.
 *
 * It also declines to propose from too little data. Below the sample threshold
 * there is nothing to say, and saying something anyway is how a system ends up
 * tuning itself on noise.
 */

import { breakEvenFloor, type FloorSample } from "./finance-calibrated-floor.js";

export const TUNING_PROPOSAL_SCHEMA_VERSION = "lcx_finance_tuning_proposal_v1" as const;

export type TuningProposal = Readonly<{
  proposalId: string;
  knob: "convictionFloor";
  current: number;
  proposed: number;
  direction: "lower" | "raise";
  /** Re-derivable from the same ledger; this is the whole point of the record. */
  evidence: string;
  sampleCount: number;
  confidence: "weak" | "moderate" | "strong";
  generatedAt: string;
  /** Always "proposed". Nothing here applies anything. */
  status: "proposed";
  /** How a human would apply it - named so the step is not a mystery. */
  applyWith: string;
}>;

export type TuningProposalResult = Readonly<{
  schemaVersion: string;
  proposals: readonly TuningProposal[];
  /** Why there is nothing to propose, when there is nothing. */
  basis: string;
  samplesUsed: number;
  currentFloor: number;
}>;

export function proposeTuning(params: {
  samples: readonly FloorSample[];
  currentFloor: number;
  /** Minimum settled samples before any proposal is worth making. */
  minSamples?: number;
  generatedAt?: string;
}): TuningProposalResult {
  const minSamples = params.minSamples ?? 30;
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const derived = breakEvenFloor(params.samples);

  const base = {
    schemaVersion: TUNING_PROPOSAL_SCHEMA_VERSION,
    samplesUsed: derived.samplesUsed,
    currentFloor: params.currentFloor,
  };

  if (derived.samplesUsed < minSamples) {
    return {
      ...base,
      proposals: [],
      basis:
        derived.samplesUsed +
        " settled sample(s), below the " +
        minSamples +
        " needed before a threshold change is worth proposing; tuning on this little would be tuning on noise",
    };
  }

  if (derived.floor === null) {
    return {
      ...base,
      proposals: [],
      basis:
        "no conviction level has demonstrated break-even over " +
        derived.samplesUsed +
        " samples (" +
        derived.basis +
        "), so there is no floor to propose; the honest reading is that this signal has not shown an edge",
    };
  }

  if (derived.floor === params.currentFloor) {
    return {
      ...base,
      proposals: [],
      basis:
        "the derived floor already equals the current floor (" +
        params.currentFloor +
        "), so there is nothing to change",
    };
  }

  const lower = derived.floor < params.currentFloor;
  const hitRateAtFloor = hitRateAtOrAbove(params.samples, derived.floor);
  const confidence: TuningProposal["confidence"] =
    derived.samplesUsed >= 100 ? "strong" : derived.samplesUsed >= 60 ? "moderate" : "weak";

  return {
    ...base,
    basis: derived.basis,
    proposals: [
      {
        proposalId:
          "tuning-conviction-floor-" + generatedAt.slice(0, 10) + "-" + (lower ? "lower" : "raise"),
        knob: "convictionFloor",
        current: params.currentFloor,
        proposed: derived.floor,
        direction: lower ? "lower" : "raise",
        evidence:
          "over " +
          derived.samplesUsed +
          " settled calls, " +
          hitRateAtFloor.wins +
          " of " +
          hitRateAtFloor.total +
          " calls at conviction " +
          derived.floor.toFixed(2) +
          " or above were right (hit rate " +
          (hitRateAtFloor.hitRate ?? 0).toFixed(2) +
          "); break-even is " +
          (hitRateAtFloor.breakEven ?? 0.5) +
          ", so " +
          (lower
            ? "trades above " +
              derived.floor.toFixed(2) +
              " have been profitable while the floor sits at " +
              params.currentFloor
            : "the current floor of " +
              params.currentFloor +
              " admits convictions that have not broken even") +
          ". Re-derive from the same scored ledger.",
        sampleCount: derived.samplesUsed,
        confidence,
        generatedAt,
        status: "proposed",
        applyWith:
          "node --import tsx scripts/operator/lcx-finance-strategy-rule-ledger.ts (review the proposal, then declare/activate a rule carrying the new floor) - a human applies it, deliberately",
      },
    ],
  };
}

function hitRateAtOrAbove(
  samples: readonly FloorSample[],
  floor: number,
): { total: number; wins: number; hitRate: number | null; breakEven: number } {
  const atOrAbove = samples.filter((s) => Number.isFinite(s.conviction) && s.conviction >= floor);
  const wins = atOrAbove.filter((s) => s.outcome === 1).length;
  return {
    total: atOrAbove.length,
    wins,
    hitRate: atOrAbove.length === 0 ? null : wins / atOrAbove.length,
    breakEven: 0.5,
  };
}
