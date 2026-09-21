import { Type } from "@sinclair/typebox";
import {
  DEFAULT_OVERRIDE_TTL_MS,
  OVERRIDE_BOUNDS,
  OVERRIDE_KNOBS,
  clearScopedOverride,
  listScopedOverrides,
  resolveScopedOverride,
  setScopedOverride,
  type OverrideKnob,
} from "../finance-scoped-override.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

/**
 * A bounded, expiring adjustment to a declared cap - never to a gate.
 *
 * The point of the separation: caps bound an action, gates refuse it. A cap can
 * be tuned; a gate cannot be turned off. Conflating them is how a safety system
 * ends up still present and no longer effective.
 *
 * Insistence is not evidence, so this tool does not accept "I am confident" as a
 * reason. It requires a stated reason long enough to be read, it bounds the
 * value, it expires, and it records what the previous value was so the change
 * can be undone and audited.
 *
 * Every read enforces expiry and verifies the removal. If an override cannot be
 * confirmed gone, that is reported as a failure rather than as a successful
 * revert - a caller continuing after an unverified revert would be running with
 * a loosened bound while believing it had been restored.
 */

export const FINANCE_SCOPED_OVERRIDE_SCHEMA_VERSION = "lcx_finance_scoped_override_v1" as const;

const FinanceScopedOverrideSchema = Type.Object({
  action: Type.Union(
    [Type.Literal("set"), Type.Literal("get"), Type.Literal("clear"), Type.Literal("list")],
    {
      description:
        "set adjusts a cap, get resolves its effective value, clear removes it, list shows all.",
    },
  ),
  knob: Type.Optional(
    Type.Union(
      OVERRIDE_KNOBS.map((knob) => Type.Literal(knob)),
      {
        description: "The cap to adjust. Required for set, get and clear.",
      },
    ),
  ),
  value: Type.Optional(
    Type.Number({
      description:
        "New value, within the knob's bounds: " +
        OVERRIDE_KNOBS.map(
          (k) => k + " " + OVERRIDE_BOUNDS[k].min + ".." + OVERRIDE_BOUNDS[k].max,
        ).join("; ") +
        ". Required for set.",
    }),
  ),
  fallback: Type.Optional(
    Type.Number({ description: "The default to compare against for `get`." }),
  ),
  reason: Type.Optional(
    Type.String({
      description:
        "Why this run needs a different bound. Required for set, and must be a reason someone else could read - not a statement of confidence.",
    }),
  ),
  ttlMs: Type.Optional(
    Type.Number({
      description: `Lifetime in ms (default ${DEFAULT_OVERRIDE_TTL_MS}, max one hour).`,
    }),
  ),
  runId: Type.Optional(Type.String({ description: "Identifier for the run this applies to." })),
  workspaceDir: Type.Optional(Type.String({ description: "Workspace root." })),
});

export function createFinanceScopedOverrideTool(): AnyAgentTool {
  return {
    name: "finance_scoped_override",
    label: "Finance scoped override",
    description:
      "Temporarily adjust a declared cap within bounds, with an expiry and a verified revert: set, get, clear or list. Caps only - gates cannot be disabled through this. A reason is required, and insistence is not accepted as one.",
    parameters: FinanceScopedOverrideSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action") ?? "list";
      const knob = readStringParam(params, "knob") as OverrideKnob | undefined;
      const workspaceDir = readStringParam(params, "workspaceDir");

      if (action === "list") {
        return jsonResult({
          ok: true,
          schemaVersion: FINANCE_SCOPED_OVERRIDE_SCHEMA_VERSION,
          knobs: OVERRIDE_KNOBS,
          bounds: OVERRIDE_BOUNDS,
          overrides: await listScopedOverrides(workspaceDir),
        });
      }

      if (!knob) {
        return jsonResult({
          ok: false,
          schemaVersion: FINANCE_SCOPED_OVERRIDE_SCHEMA_VERSION,
          refusals: ["knob is required for " + action],
        });
      }

      if (action === "set") {
        const value = params.value as number | undefined;
        if (typeof value !== "number") {
          return jsonResult({
            ok: false,
            schemaVersion: FINANCE_SCOPED_OVERRIDE_SCHEMA_VERSION,
            refusals: ["value is required for set"],
          });
        }
        const result = await setScopedOverride({
          knob,
          value,
          reason: readStringParam(params, "reason") ?? "",
          ...(typeof params.ttlMs === "number" ? { ttlMs: params.ttlMs } : {}),
          ...(readStringParam(params, "runId")
            ? { runId: readStringParam(params, "runId") as string }
            : {}),
          ...(workspaceDir ? { workspaceDir } : {}),
        });
        return jsonResult({
          ok: result.ok,
          schemaVersion: FINANCE_SCOPED_OVERRIDE_SCHEMA_VERSION,
          ...(result.ok ? { entry: result.entry } : { refusals: [...result.refusals] }),
        });
      }

      if (action === "clear") {
        const revert = await clearScopedOverride(knob, workspaceDir);
        return jsonResult({
          ok: revert.verified,
          schemaVersion: FINANCE_SCOPED_OVERRIDE_SCHEMA_VERSION,
          knob,
          ...revert,
        });
      }

      const fallback = typeof params.fallback === "number" ? params.fallback : 0;
      const resolved = await resolveScopedOverride({
        knob,
        fallback,
        ...(workspaceDir ? { workspaceDir } : {}),
      });
      return jsonResult({
        ok: true,
        schemaVersion: FINANCE_SCOPED_OVERRIDE_SCHEMA_VERSION,
        ...resolved,
      });
    },
  };
}
