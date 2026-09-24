import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  readFinanceTuningProposals,
  runFinanceTuningLifecycle,
} from "../finance-tuning-lifecycle.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

/**
 * Generate and recall forecast-calibration proposals from directional outcomes.
 *
 * The reflection loop ended at a printed number: the system could say it was
 * inaccurate and had no next step. This is the next step, and it stops short of
 * the one that changes behaviour.
 *
 * Proposals are appended to a ledger so that a rejected proposal is still on
 * record. A proposal that disappears when ignored cannot be re-examined later,
 * and the most valuable thing to re-examine is exactly the one that was turned
 * down before the evidence was in.
 *
 * This lifecycle no longer promotes directional hit-rate evidence into a paper
 * execution threshold. Trade-economics promotion requires reconciled fills,
 * costs, and attribution through a separate owner.
 */

export const FINANCE_TUNING_PROPOSAL_TOOL_SCHEMA_VERSION =
  "lcx_finance_tuning_proposal_tool_v2" as const;

const FinanceTuningProposalSchema = Type.Object({
  action: Type.Union([Type.Literal("propose"), Type.Literal("list")], {
    description:
      "propose derives proposals from the scored ledger; list returns what is on record.",
  }),
  workspaceDir: Type.Optional(Type.String({ description: "Workspace root." })),
});

export function createFinanceTuningProposalTool(): AnyAgentTool {
  return {
    name: "finance_tuning_proposal",
    label: "Finance tuning proposal",
    description:
      "Derive and record forecast-calibration proposals from settled directional outcomes. These proposals cannot change paper selection or execution gates; actual net-trade economics are a separate requirement. Says plainly when the evidence supports no calibration change.",
    parameters: FinanceTuningProposalSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action") ?? "propose";
      const workspaceDir = readStringParam(params, "workspaceDir");
      const root = resolveWorkspaceRoot(workspaceDir);
      const directory = path.join(root, "state", "finance");

      if (action === "list") {
        const existing = readFinanceTuningProposals(directory);
        return jsonResult({
          ok: true,
          schemaVersion: FINANCE_TUNING_PROPOSAL_TOOL_SCHEMA_VERSION,
          count: existing.length,
          proposals: existing,
        });
      }

      const lifecycle = runFinanceTuningLifecycle({ directory });
      const result = lifecycle.proposal;

      return jsonResult({
        ok: true,
        schemaVersion: FINANCE_TUNING_PROPOSAL_TOOL_SCHEMA_VERSION,
        action,
        currentFloor: result.currentFloor,
        samplesUsed: result.samplesUsed,
        basis: result.basis,
        proposals: result.proposals,
        newlyRecorded: lifecycle.newlyRecorded,
        promotions: lifecycle.promotions,
        paperExecutionPromotion: lifecycle.paperExecutionPromotion,
        note: "Directional outcomes are retained for forecast calibration only. Paper execution thresholds remain blocked until reconciled trade costs and strategy attribution support a separate net-P&L assessment.",
      });
    },
  };
}
