import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { buildReflection, renderReflection, type ScoredSample } from "../finance-reflection.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

/**
 * Read-only recall of the system's own track record, rendered for a model.
 *
 * `finance_calibration_read` reports the numbers. This returns the same history
 * as prose: how often the calls were right, what was claimed against what was
 * delivered, and a few concrete instances, in the exact wording that is injected
 * into a research prompt. An agent can therefore see its own track record before
 * judging again, and can quote it.
 *
 * Scope is either one instrument or the whole pool, and both are useful for
 * different questions: the pool answers "am I reliable", the instrument answers
 * "am I reliable on this name". A model shown only the aggregate cannot notice
 * that it is specifically bad at one of them.
 *
 * With no history it returns the honest "no scored history yet" text rather than
 * an empty or encouraging substitute.
 */

export const FINANCE_REFLECTION_READ_SCHEMA_VERSION = "lcx_finance_reflection_read_v1" as const;

const DEFAULT_SCORED_REL = "state/finance/research-scored.jsonl";
const DEFAULT_INSTANCE_LIMIT = 5;

const FinanceReflectionReadSchema = Type.Object({
  workspaceDir: Type.Optional(
    Type.String({
      description:
        "Workspace root whose finance state is read. Defaults to the process working directory.",
    }),
  ),
  instrument: Type.Optional(
    Type.String({
      description: "Limit the reflection to one instrument. Omit it for the whole pool.",
    }),
  ),
  instanceLimit: Type.Optional(
    Type.Number({
      description: `How many concrete past calls to quote (default ${DEFAULT_INSTANCE_LIMIT}).`,
    }),
  ),
});

function isOutcome(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

async function readScored(file: string): Promise<ScoredSample[]> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          const conviction = Number(row.conviction);
          const instrument = typeof row.instrument === "string" ? row.instrument : "";
          const asOf = typeof row.asOf === "string" ? row.asOf : "";
          const movePct = Number(row.movePct);
          if (
            instrument.length === 0 ||
            asOf.length === 0 ||
            !Number.isFinite(conviction) ||
            !isOutcome(row.outcome)
          ) {
            return [];
          }
          return [
            {
              instrument,
              asOf,
              direction: row.direction === "sell" ? ("sell" as const) : ("buy" as const),
              conviction,
              outcome: row.outcome,
              movePct: Number.isFinite(movePct) ? movePct : 0,
            },
          ];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function createFinanceReflectionReadTool(): AnyAgentTool {
  return {
    name: "finance_reflection_read",
    label: "Finance reflection",
    description:
      "Read-only recall of this system's own finance track record, rendered as text ready to reason with: how often calls were right, claimed conviction against delivered accuracy, and concrete past calls. Scope to one instrument or read the whole pool. Reports honestly when there is no scored history yet.",
    parameters: FinanceReflectionReadSchema,
    execute: async (_toolCallId, params) => {
      const workspaceDir = readStringParam(params, "workspaceDir");
      const instrument = readStringParam(params, "instrument");
      const rawLimit = params.instanceLimit as number | undefined;
      const instanceLimit =
        rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.floor(rawLimit), 20)
          : DEFAULT_INSTANCE_LIMIT;

      const root = resolveWorkspaceRoot(workspaceDir);
      const scoredFile = path.isAbsolute(DEFAULT_SCORED_REL)
        ? DEFAULT_SCORED_REL
        : path.join(root, DEFAULT_SCORED_REL);

      const scored = await readScored(scoredFile);

      const scoped = buildReflection(scored, {
        ...(instrument ? { instrument } : {}),
        instanceLimit,
      });
      const pool = buildReflection(scored, { instanceLimit });

      return jsonResult({
        ok: true,
        schemaVersion: FINANCE_REFLECTION_READ_SCHEMA_VERSION,
        inspectedFrom: { workspaceDir: root, scoredFile },
        sampleCount: scored.length,
        scope: instrument ? instrument.toUpperCase() : "pool",
        reflection: renderReflection(scoped),
        poolReflection: instrument ? renderReflection(pool) : undefined,
        summary: {
          samples: scoped.samples,
          hitRate: scoped.hitRate,
          meanClaimed: scoped.meanClaimed,
          brier: scoped.brier,
          overconfidenceGap: scoped.overconfidenceGap,
        },
      });
    },
  };
}
