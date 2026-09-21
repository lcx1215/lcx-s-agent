import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { FloorSample } from "../finance-calibrated-floor.js";
import { proposeTuning, type TuningProposal } from "../finance-tuning-proposal.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

/**
 * Generate and recall tuning proposals - never apply one.
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
 * Applying is not implemented here on purpose. The tool names the operator
 * command a human would use, so the gap between proposing and applying is a
 * deliberate step rather than an oversight.
 */

export const FINANCE_TUNING_PROPOSAL_TOOL_SCHEMA_VERSION =
  "lcx_finance_tuning_proposal_tool_v1" as const;

const SCORED_REL = "state/finance/research-scored.jsonl";
const PROPOSALS_REL = "state/finance/tuning-proposals.jsonl";

const FinanceTuningProposalSchema = Type.Object({
  action: Type.Union([Type.Literal("propose"), Type.Literal("list")], {
    description:
      "propose derives proposals from the scored ledger; list returns what is on record.",
  }),
  currentFloor: Type.Optional(
    Type.Number({
      description:
        "The conviction floor in force now, so the proposal can say what it would change. Defaults to 0.6, the class A default.",
    }),
  ),
  minSamples: Type.Optional(
    Type.Number({
      description:
        "Settled samples required before proposing anything (default 30). Below it there is nothing to say.",
    }),
  ),
  workspaceDir: Type.Optional(Type.String({ description: "Workspace root." })),
});

function isOutcome(value: unknown): value is 0 | 1 {
  return value === 0 || value === 1;
}

function readScored(file: string): FloorSample[] {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const row = JSON.parse(line) as { conviction?: unknown; outcome?: unknown };
        const conviction = Number(row.conviction);
        if (!Number.isFinite(conviction) || !isOutcome(row.outcome)) {
          return [];
        }
        return [{ conviction, outcome: row.outcome }];
      } catch {
        return [];
      }
    });
}

function readProposals(file: string): TuningProposal[] {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const row = JSON.parse(line) as TuningProposal;
        return typeof row?.proposalId === "string" ? [row] : [];
      } catch {
        return [];
      }
    });
}

export function createFinanceTuningProposalTool(): AnyAgentTool {
  return {
    name: "finance_tuning_proposal",
    label: "Finance tuning proposal",
    description:
      "Derive tuning proposals from the settled track record, each carrying evidence that can be re-checked, and record them. Proposes only: applying a proposal is a human step, and the operator command to use is named in the proposal. Says plainly when there is too little data to propose anything.",
    parameters: FinanceTuningProposalSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action") ?? "propose";
      const workspaceDir = readStringParam(params, "workspaceDir");
      const root = resolveWorkspaceRoot(workspaceDir);
      const scoredFile = join(root, SCORED_REL);
      const proposalsFile = join(root, PROPOSALS_REL);

      if (action === "list") {
        const existing = readProposals(proposalsFile);
        return jsonResult({
          ok: true,
          schemaVersion: FINANCE_TUNING_PROPOSAL_TOOL_SCHEMA_VERSION,
          count: existing.length,
          proposals: existing,
        });
      }

      const currentFloor =
        typeof params.currentFloor === "number" && Number.isFinite(params.currentFloor)
          ? params.currentFloor
          : 0.6;
      const minSamples =
        typeof params.minSamples === "number" && Number.isFinite(params.minSamples)
          ? Math.max(1, Math.floor(params.minSamples))
          : 30;

      const samples = readScored(scoredFile);
      const result = proposeTuning({ samples, currentFloor, minSamples });

      // Recorded once per proposal id; re-running the same day must not pile up
      // duplicates of an unchanged proposal.
      const existingIds = new Set(readProposals(proposalsFile).map((p) => p.proposalId));
      const fresh = result.proposals.filter((p) => !existingIds.has(p.proposalId));
      if (fresh.length > 0) {
        mkdirSync(dirname(proposalsFile), { recursive: true });
        appendFileSync(proposalsFile, fresh.map((p) => JSON.stringify(p)).join("\n") + "\n");
      }

      return jsonResult({
        ok: true,
        schemaVersion: FINANCE_TUNING_PROPOSAL_TOOL_SCHEMA_VERSION,
        action,
        currentFloor,
        samplesUsed: result.samplesUsed,
        basis: result.basis,
        proposals: result.proposals,
        newlyRecorded: fresh.length,
        note: "Nothing here changes behaviour. A proposal is a claim with its evidence attached; applying it is a deliberate human step.",
      });
    },
  };
}
