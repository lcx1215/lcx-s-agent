import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

/**
 * An explicit, revisable plan the agent maintains and a human can read.
 *
 * Codex's harness gives the model `update_plan`, and it is worth copying for a
 * reason that has nothing to do with the model: without it, the only way to know
 * what an agent intends to do next is to watch it do that thing. A written plan
 * makes intent inspectable before execution, which is the difference between
 * supervising an agent and auditing it afterwards.
 *
 * It is deliberately dumb storage. No inference, no auto-completion, no
 * reordering - the model states the steps and their status, and the tool stores
 * and echoes them. Anything cleverer would start guessing at intent.
 *
 * Persisted under the workspace so it survives across turns and can be reviewed,
 * rather than living in one turn's context.
 */

export const PLAN_UPDATE_SCHEMA_VERSION = "lcx_plan_update_v1" as const;

const PLAN_REL = "state/agent-plan-latest.json";

const STATUSES = ["pending", "in_progress", "completed"] as const;

const PlanUpdateSchema = Type.Object({
  steps: Type.Optional(
    Type.Array(
      Type.Object({
        text: Type.String({ description: "What is to be done, in one line." }),
        status: Type.Union(
          STATUSES.map((status) => Type.Literal(status)),
          {
            description: "pending, in_progress or completed.",
          },
        ),
      }),
      { description: "The full plan. Omit it entirely to read the current plan." },
    ),
  ),
  note: Type.Optional(Type.String({ description: "Why the plan is what it is, or what changed." })),
  workspaceDir: Type.Optional(
    Type.String({ description: "Workspace root. Defaults to the process working directory." }),
  ),
});

export function createPlanUpdateTool(): AnyAgentTool {
  return {
    name: "plan_update",
    label: "Update plan",
    description:
      "Maintain an explicit plan of steps and their status so the next action is inspectable before it is taken. Pass steps to replace the plan; pass nothing to read the current one. Persisted under the workspace.",
    parameters: PlanUpdateSchema,
    execute: async (_toolCallId, params) => {
      const workspaceDir = readStringParam(params, "workspaceDir");
      const note = readStringParam(params, "note");
      const root = resolveWorkspaceRoot(workspaceDir);
      const file = path.isAbsolute(PLAN_REL) ? PLAN_REL : path.join(root, PLAN_REL);

      const rawSteps = params.steps;
      if (!Array.isArray(rawSteps)) {
        // Read mode.
        try {
          const existing = JSON.parse(await fs.readFile(file, "utf8")) as {
            steps?: unknown;
            note?: unknown;
            updatedAt?: unknown;
          };
          return jsonResult({
            ok: true,
            schemaVersion: PLAN_UPDATE_SCHEMA_VERSION,
            mode: "read",
            ...existing,
          });
        } catch {
          return jsonResult({
            ok: true,
            schemaVersion: PLAN_UPDATE_SCHEMA_VERSION,
            mode: "read",
            steps: [],
            note: "no plan recorded yet",
          });
        }
      }

      const steps = rawSteps.flatMap((step) => {
        if (!step || typeof step !== "object") {
          return [];
        }
        const text = typeof step.text === "string" ? step.text.trim() : "";
        const status = STATUSES.includes(step.status) ? step.status : "pending";
        return text.length > 0 ? [{ text, status }] : [];
      });

      const updatedAt = new Date().toISOString();
      const payload = { schemaVersion: PLAN_UPDATE_SCHEMA_VERSION, updatedAt, note, steps };
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(payload, null, 2));

      const completed = steps.filter((s) => s.status === "completed").length;
      const inProgress = steps.filter((s) => s.status === "in_progress").length;

      return jsonResult({
        ok: true,
        schemaVersion: PLAN_UPDATE_SCHEMA_VERSION,
        mode: "write",
        updatedAt,
        stepCount: steps.length,
        completed,
        inProgress,
        pending: steps.length - completed - inProgress,
        steps,
        note,
        rendered:
          steps
            .map(
              (s) =>
                (s.status === "completed" ? "[x] " : s.status === "in_progress" ? "[~] " : "[ ] ") +
                s.text,
            )
            .join("\n") || "(empty plan)",
      });
    },
  };
}
