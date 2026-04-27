import { Type } from "@sinclair/typebox";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringOrNumberParam, readStringParam, ToolInputError } from "./common.js";
import { createFinanceLearningCapabilityInspectTool } from "./finance-learning-capability-inspect-tool.js";

const FinanceLearningCapabilityApplySchema = Type.Object({
  queryText: Type.String({
    description:
      "Natural-language research question to answer using retained finance learning capabilities.",
  }),
  maxCandidates: Type.Optional(
    Type.Number({ description: "Maximum retained capabilities to apply. Defaults to 3." }),
  ),
});

function clampMaxCandidates(value: string | undefined): number {
  const parsed = value ? Number(value) : 3;
  if (!Number.isFinite(parsed)) {
    return 3;
  }
  return Math.max(1, Math.min(8, Math.floor(parsed)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function formatCapabilityUse(candidate: Record<string, unknown>) {
  const reuseGuidance = asRecord(candidate.reuseGuidance);
  const requiredInputs = stringArray(reuseGuidance.requiredInputs);
  const requiredEvidenceCategories = stringArray(reuseGuidance.requiredEvidenceCategories);
  const riskChecks = stringArray(reuseGuidance.riskChecks);
  const causalCheck = optionalString(reuseGuidance.causalCheck);
  const implementationCheck = optionalString(reuseGuidance.implementationCheck);
  return {
    capabilityName: optionalString(candidate.capabilityName),
    sourceArticlePath: optionalString(candidate.sourceArticlePath),
    retrievalScore: typeof candidate.retrievalScore === "number" ? candidate.retrievalScore : null,
    matchedSignals: stringArray(candidate.matchedSignals),
    applicationBoundary: optionalString(reuseGuidance.applicationBoundary),
    attachmentPoint: optionalString(reuseGuidance.attachmentPoint),
    useFor: optionalString(reuseGuidance.useFor),
    requiredInputs,
    requiredEvidenceCategories,
    causalCheck,
    riskChecks,
    implementationCheck,
    doNotUseFor: optionalString(reuseGuidance.doNotUseFor),
    applicationChecklist: [
      `Refresh inputs: ${requiredInputs.join(", ")}`,
      `Check evidence families: ${requiredEvidenceCategories.join(", ")}`,
      causalCheck ? `Validate causal link: ${causalCheck}` : null,
      implementationCheck ? `Implementation constraint: ${implementationCheck}` : null,
      `Run risk checks: ${riskChecks.join(" | ")}`,
    ].filter((item): item is string => Boolean(item)),
  };
}

export function createFinanceLearningCapabilityApplyTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  const inspectTool = createFinanceLearningCapabilityInspectTool({ workspaceDir });
  return {
    label: "Finance Learning Capability Apply",
    name: "finance_learning_capability_apply",
    description:
      "Apply retained finance learning capabilities to one bounded research question by retrieving capability cards and returning reuse guidance, required inputs, causal checks, and risk checks. This is read-only and does not create trading advice.",
    parameters: FinanceLearningCapabilityApplySchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const queryText = readStringParam(params, "queryText", {
        required: true,
        label: "queryText",
      });
      const maxCandidates = clampMaxCandidates(readStringOrNumberParam(params, "maxCandidates"));
      const inspectResult = await inspectTool.execute("finance-learning-capability-apply:inspect", {
        queryText,
        maxCandidates,
      });
      const inspectDetails = asRecord(inspectResult.details);
      if (inspectDetails.ok !== true) {
        return jsonResult({
          ok: false,
          boundary: "finance_learning_capability_apply_read_only",
          queryText,
          reason:
            typeof inspectDetails.reason === "string"
              ? inspectDetails.reason
              : "finance_learning_capability_inspect_failed",
          action:
            "Learn or repair retained finance capability cards before applying finance learning to this research question.",
        });
      }
      const candidates = Array.isArray(inspectDetails.candidates)
        ? inspectDetails.candidates.map((candidate) => asRecord(candidate))
        : [];
      if (candidates.length === 0) {
        return jsonResult({
          ok: false,
          boundary: "finance_learning_capability_apply_read_only",
          queryText,
          reason: "no_retrievable_finance_capability",
          action:
            "Do not improvise a learned answer. First run finance_learning_pipeline_orchestrator on a safe source or refine the query against existing capability tags.",
        });
      }
      const appliedCapabilities = candidates.map((candidate) => formatCapabilityUse(candidate));
      const missingReuseGuidance = appliedCapabilities.filter(
        (candidate) =>
          !candidate.applicationBoundary ||
          !candidate.attachmentPoint ||
          !candidate.useFor ||
          candidate.requiredInputs.length === 0 ||
          candidate.requiredEvidenceCategories.length === 0 ||
          !candidate.causalCheck ||
          candidate.riskChecks.length === 0 ||
          !candidate.implementationCheck ||
          !candidate.doNotUseFor,
      );
      if (missingReuseGuidance.length > 0) {
        throw new ToolInputError(
          "retrieved finance capability is missing reuse guidance; inspect or repair capability cards before applying",
        );
      }
      return jsonResult({
        ok: true,
        boundary: "finance_learning_capability_apply_read_only",
        queryText,
        retrievalMode: inspectDetails.retrievalMode ?? "query_ranked",
        applicationMode: "reuse_guidance_bounded_research_answer",
        candidateCount: appliedCapabilities.length,
        answerSkeleton: {
          summary:
            "A bounded research answer can use the retained capabilities below, but must stay inside their application boundaries and refresh required inputs before any conclusion.",
          requiredSections: [
            "Retrieved capability used",
            "Fresh inputs checked",
            "Causal link tested",
            "Risk and overfitting checks",
            "Red-team invalidation",
            "Research-only conclusion",
          ],
          requiredNextChecks: [
            ...new Set(appliedCapabilities.flatMap((candidate) => candidate.requiredInputs)),
          ],
          requiredEvidenceCategories: [
            ...new Set(
              appliedCapabilities.flatMap((candidate) => candidate.requiredEvidenceCategories),
            ),
          ],
          causalChecks: appliedCapabilities.map((candidate) => candidate.causalCheck),
          implementationChecks: appliedCapabilities.map(
            (candidate) => candidate.implementationCheck,
          ),
          riskChecks: [
            ...new Set(appliedCapabilities.flatMap((candidate) => candidate.riskChecks)),
          ],
          applyOrRefuseRule:
            "If any required input, evidence family, causal check, or risk check is missing for the current question, say the retained capability is not ready to apply instead of filling the gap with generic commentary.",
          redTeam:
            "If fresh evidence conflicts with the required inputs, causal checks, or risk checks, downgrade or discard the capability for this question.",
          noActionBoundary:
            "This application is research-only and does not approve trades, auto-promotion, doctrine mutation, or standalone prediction.",
        },
        appliedCapabilities,
        sourceInspectTool: "finance_learning_capability_inspect",
      });
    },
  };
}
