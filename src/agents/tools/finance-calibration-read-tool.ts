import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { breakEvenFloor, type FloorSample } from "../finance-calibrated-floor.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

/**
 * Read-only recall over the system's own scored outcomes.
 *
 * Everything else in the finance stack produces claims. This is the only place
 * an agent can find out whether those claims were any good, and without it the
 * reflection loop has no input: the model is asked to judge again with no way
 * to see how the last judgement went.
 *
 * It reports the raw counts as well as the derived numbers, because a Brier
 * score over four samples is a fact about four samples and not about the
 * strategy. When no floor can be derived it says so plainly rather than
 * substituting a plausible-looking constant.
 *
 * Read-only: no network, no model, no writes.
 */

export const FINANCE_CALIBRATION_READ_SCHEMA_VERSION = "lcx_finance_calibration_read_v1" as const;

const DEFAULT_SCORED_REL = "state/finance/research-scored.jsonl";
const DEFAULT_SAMPLES_REL = "state/finance/research-samples.jsonl";

const FinanceCalibrationReadSchema = Type.Object({
  workspaceDir: Type.Optional(
    Type.String({
      description:
        "Workspace root whose finance state is read. Defaults to the process working directory.",
    }),
  ),
  includeFloor: Type.Optional(
    Type.Boolean({
      description:
        "Also report the conviction floor derived from these outcomes, if any can be derived. Defaults to true.",
    }),
  ),
});

type Counts = {
  total: number;
  mature: number;
  pending: number;
  refused: number;
};

function isOutcome(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

async function readJsonl(file: string): Promise<Record<string, unknown>[]> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const parsed: unknown = JSON.parse(line);
          return parsed && typeof parsed === "object" ? [parsed as Record<string, unknown>] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function resolveUnderWorkspace(
  workspaceDir: string | undefined,
  rel: string,
): Promise<string> {
  const root = resolveWorkspaceRoot(workspaceDir);
  return path.isAbsolute(rel) ? rel : path.join(root, rel);
}

export function createFinanceCalibrationReadTool(): AnyAgentTool {
  return {
    name: "finance_calibration_read",
    label: "Finance calibration",
    description:
      "Read-only summary of how accurate this system's own finance calls have been: hit rate, Brier score, overconfidence gap, and how many samples are still pending. Optionally reports the conviction floor derived from those outcomes, or states that none can be justified yet. Never calls the network or a model.",
    parameters: FinanceCalibrationReadSchema,
    execute: async (_toolCallId, params) => {
      const workspaceDir = readStringParam(params, "workspaceDir");
      const includeFloor = params.includeFloor !== false;
      const root = resolveWorkspaceRoot(workspaceDir);

      const scoredFile = await resolveUnderWorkspace(workspaceDir, DEFAULT_SCORED_REL);
      const samplesFile = await resolveUnderWorkspace(workspaceDir, DEFAULT_SAMPLES_REL);

      const scored = await readJsonl(scoredFile);
      const samples = await readJsonl(samplesFile);

      const floorSamples: FloorSample[] = scored.flatMap((row) => {
        const conviction = Number(row.conviction);
        if (!Number.isFinite(conviction)) {
          return [];
        }
        return [{ conviction, outcome: isOutcome(row.outcome) ? row.outcome : 0 }];
      });

      const outcomes: number[] = floorSamples.map((row) => row.outcome);
      const meanClaimed =
        floorSamples.length === 0
          ? null
          : floorSamples.reduce((sum, row) => sum + row.conviction, 0) / floorSamples.length;
      const hitRate =
        outcomes.length === 0
          ? null
          : outcomes.reduce((sum, value) => sum + value, 0) / outcomes.length;
      const brier =
        floorSamples.length === 0
          ? null
          : floorSamples.reduce((sum, row) => sum + (row.conviction - row.outcome) ** 2, 0) /
            floorSamples.length;

      const counts: Counts = {
        total: samples.length,
        mature: floorSamples.length,
        pending: Math.max(0, samples.length - floorSamples.length),
        refused: samples.filter((row) => row.direction === "none").length,
      };

      const derived = includeFloor ? breakEvenFloor(floorSamples) : null;

      return jsonResult({
        ok: true,
        schemaVersion: FINANCE_CALIBRATION_READ_SCHEMA_VERSION,
        inspectedFrom: { workspaceDir: root, scoredFile, samplesFile },
        counts,
        hitRate,
        meanClaimedConviction: meanClaimed,
        brier,
        overconfidenceGap: hitRate === null || meanClaimed === null ? null : meanClaimed - hitRate,
        floor: derived
          ? { value: derived.floor, basis: derived.basis, samplesUsed: derived.samplesUsed }
          : null,
        note:
          floorSamples.length === 0
            ? "No scored outcomes yet. Any calibration number would be invented, so none is reported."
            : floorSamples.length < 30
              ? `Only ${floorSamples.length} scored outcome(s). Treat these numbers as provisional, not as evidence about the strategy.`
              : undefined,
      });
    },
  };
}
