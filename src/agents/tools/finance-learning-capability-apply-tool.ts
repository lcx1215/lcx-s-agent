import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringOrNumberParam, readStringParam } from "./common.js";
import { createFinanceLearningCapabilityInspectTool } from "./finance-learning-capability-inspect-tool.js";

const FinanceLearningCapabilityApplySchema = Type.Object({
  queryText: Type.String({
    description:
      "Natural-language research question to answer using retained finance learning capabilities.",
  }),
  maxCandidates: Type.Optional(
    Type.Number({ description: "Maximum retained capabilities to apply. Defaults to 3." }),
  ),
  writeUsageReceipt: Type.Optional(
    Type.Boolean({
      description:
        "Whether to write a bounded finance-learning apply usage receipt. Defaults to true.",
    }),
  ),
});

const FINANCE_LEARNING_APPLY_USAGE_RECEIPT_DIR = path.join(
  "memory",
  "finance-learning-apply-usage-receipts",
);
const FINANCE_LEARNING_APPLY_USAGE_REVIEW_DIR = path.join(
  "memory",
  "finance-learning-apply-usage-reviews",
);

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

function uniqueStrings(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function buildCapabilitySynthesis(appliedCapabilities: ReturnType<typeof formatCapabilityUse>[]) {
  const [primaryCapability, ...supportingCapabilities] = appliedCapabilities;
  const combinedRequiredInputs = uniqueStrings(
    appliedCapabilities.flatMap((candidate) => candidate.requiredInputs),
  );
  const combinedEvidenceCategories = uniqueStrings(
    appliedCapabilities.flatMap((candidate) => candidate.requiredEvidenceCategories),
  );
  const combinedRiskChecks = uniqueStrings(
    appliedCapabilities.flatMap((candidate) => candidate.riskChecks),
  );
  return {
    mode:
      appliedCapabilities.length > 1
        ? "multi_capability_synthesis"
        : "single_capability_application",
    primaryCapability: primaryCapability?.capabilityName ?? null,
    supportingCapabilities: uniqueStrings(
      supportingCapabilities.map((candidate) => candidate.capabilityName),
    ),
    combinedRequiredInputs,
    combinedEvidenceCategories,
    combinedRiskChecks,
    synthesisOrder: [
      "Use the primary capability to define the research frame.",
      "Use supporting capabilities only where their required inputs and evidence categories are present.",
      "Merge overlapping checks, but keep stricter risk and implementation constraints.",
      "If capabilities point to conflicting conclusions, downgrade confidence and surface the conflict instead of forcing one answer.",
    ],
    conflictChecks: [
      "Do the capabilities require different evidence families that are not all available?",
      "Does one capability's risk check invalidate another capability's causal story?",
      "Does the combined frame create unsupported timing, sizing, or execution language?",
    ],
    synthesisRule:
      "A multi-capability answer is usable only when the shared question has fresh inputs, all required evidence families, a tested causal link, and no unresolved risk conflict.",
    fallbackRule:
      "If the support capability lacks current inputs or conflicts with the primary capability, use only the primary capability and explicitly name the dropped support capability.",
  };
}

function buildResearchAnswerScaffold(params: {
  queryText: string;
  appliedCapabilities: ReturnType<typeof formatCapabilityUse>[];
}) {
  const requiredInputs = uniqueStrings(
    params.appliedCapabilities.flatMap((candidate) => candidate.requiredInputs),
  );
  const requiredEvidenceCategories = uniqueStrings(
    params.appliedCapabilities.flatMap((candidate) => candidate.requiredEvidenceCategories),
  );
  const causalChecks = uniqueStrings(
    params.appliedCapabilities.map((candidate) => candidate.causalCheck),
  );
  const riskChecks = uniqueStrings(
    params.appliedCapabilities.flatMap((candidate) => candidate.riskChecks),
  );
  const capabilityNames = uniqueStrings(
    params.appliedCapabilities.map((candidate) => candidate.capabilityName),
  );
  const doNotUseFor = uniqueStrings(
    params.appliedCapabilities.map((candidate) => candidate.doNotUseFor),
  );
  const capabilitySynthesis = buildCapabilitySynthesis(params.appliedCapabilities);

  return {
    question: params.queryText,
    status: "scaffold_only_until_fresh_inputs_are_checked",
    capabilitySynthesis,
    oneLineUse:
      "Use the retained capability only to structure research: refresh inputs, test the causal link, run risk checks, then state a research-only conclusion or refuse to apply it.",
    sections: [
      {
        heading: "Capability synthesis plan",
        writeThis:
          capabilityNames.length > 1
            ? `Use ${capabilitySynthesis.primaryCapability ?? "the highest-ranked capability"} as the primary frame, then add ${capabilitySynthesis.supportingCapabilities.join("; ")} only where fresh inputs and evidence support them.`
            : "Use the retrieved capability as a single research frame only after its inputs and evidence are checked.",
        mustInclude: ["primary capability", "supporting capability", "conflict checks"],
      },
      {
        heading: "Retrieved capability used",
        writeThis:
          capabilityNames.length > 0
            ? `Use: ${capabilityNames.join("; ")}. Explain why it matches this question before using it.`
            : "Name the retrieved capability and explain why it matches this question.",
        mustInclude: ["capability name", "matching signals", "application boundary"],
      },
      {
        heading: "Fresh inputs checked",
        writeThis:
          requiredInputs.length > 0
            ? `Refresh and cite/check these inputs first: ${requiredInputs.join("; ")}.`
            : "List the fresh inputs required before any conclusion.",
        mustInclude: requiredInputs,
      },
      {
        heading: "Evidence families checked",
        writeThis:
          requiredEvidenceCategories.length > 0
            ? `Confirm these evidence families are present: ${requiredEvidenceCategories.join("; ")}.`
            : "Confirm the evidence families needed by the retained capability.",
        mustInclude: requiredEvidenceCategories,
      },
      {
        heading: "Causal link tested",
        writeThis:
          causalChecks.length > 0
            ? `Test this causal/mechanistic claim against the current case: ${causalChecks.join(" | ")}.`
            : "State the causal link and whether current evidence supports it.",
        mustInclude: causalChecks,
      },
      {
        heading: "Risk and overfitting checks",
        writeThis:
          riskChecks.length > 0
            ? `Run these checks before using the capability: ${riskChecks.join(" | ")}.`
            : "Run risk, overfitting, and stale-data checks before using the capability.",
        mustInclude: riskChecks,
      },
      {
        heading: "Research-only conclusion",
        writeThis:
          "Conclude only after the input/evidence/causal/risk checks pass. If any check is missing, say the retained capability is not ready to apply.",
        mustInclude: ["no trade approval", "no auto-promotion", "explicit missing-checks list"],
      },
    ],
    refusalTriggers: [
      "required inputs are missing or stale",
      "required evidence categories are absent",
      "causal link is not supported in the current case",
      "risk checks identify overfitting, narrative overreach, or unsupported timing language",
      ...doNotUseFor,
    ],
    outputDiscipline: {
      allowed:
        "bounded research framing, evidence checklist, causal/risk evaluation, red-team invalidation, and research-only conclusion",
      forbidden:
        "trade execution approval, automatic doctrine promotion, standalone prediction, or position sizing beyond qualitative research implications",
    },
  };
}

function buildUsageReceiptFileName(params: { toolCallId: string; queryText: string }): string {
  const hash = createHash("sha256")
    .update(`${params.toolCallId}\n${params.queryText}`)
    .digest("hex")
    .slice(0, 12);
  return `${new Date().toISOString().replace(/[:.]/gu, "-")}__${hash}.json`;
}

async function writeApplyUsageReceipt(params: {
  workspaceDir: string;
  toolCallId: string;
  queryText: string;
  ok: boolean;
  reason?: string;
  synthesisMode?: string | null;
  candidateCount: number;
  appliedCapabilities?: ReturnType<typeof formatCapabilityUse>[];
  answerScaffoldStatus?: string | null;
  capabilitySynthesis?: ReturnType<typeof buildCapabilitySynthesis> | null;
}): Promise<string> {
  const dateKey = new Date().toISOString().slice(0, 10);
  const receiptRelDir = path.join(FINANCE_LEARNING_APPLY_USAGE_RECEIPT_DIR, dateKey);
  const receiptRelPath = path.join(
    receiptRelDir,
    buildUsageReceiptFileName({ toolCallId: params.toolCallId, queryText: params.queryText }),
  );
  await fs.mkdir(path.join(params.workspaceDir, receiptRelDir), { recursive: true });
  await fs.writeFile(
    path.join(params.workspaceDir, receiptRelPath),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        boundary: "finance_learning_capability_apply_usage_receipt",
        generatedAt: new Date().toISOString(),
        queryText: params.queryText,
        ok: params.ok,
        reason: params.reason ?? null,
        synthesisMode: params.synthesisMode ?? null,
        candidateCount: params.candidateCount,
        answerScaffoldStatus: params.answerScaffoldStatus ?? null,
        capabilitySynthesis: params.capabilitySynthesis ?? null,
        appliedCapabilities: (params.appliedCapabilities ?? []).map((candidate) => ({
          capabilityName: candidate.capabilityName,
          sourceArticlePath: candidate.sourceArticlePath,
          retrievalScore: candidate.retrievalScore,
          matchedSignals: candidate.matchedSignals,
          applicationBoundary: candidate.applicationBoundary,
          attachmentPoint: candidate.attachmentPoint,
        })),
        noExecutionAuthority: true,
        noDoctrineMutation: true,
        noProtectedMemoryWrite: true,
        action:
          "Use this receipt to audit which retained finance capabilities were applied, synthesized, or refused for a bounded research question.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return receiptRelPath.split(path.sep).join("/");
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

async function writeApplyUsageReview(params: {
  workspaceDir: string;
  dateKey: string;
}): Promise<string> {
  const receiptDir = path.join(
    params.workspaceDir,
    FINANCE_LEARNING_APPLY_USAGE_RECEIPT_DIR,
    params.dateKey,
  );
  let entries: string[];
  try {
    entries = await fs.readdir(receiptDir);
  } catch {
    entries = [];
  }
  const receipts = (
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .toSorted()
        .map(async (entry) => {
          const absolutePath = path.join(receiptDir, entry);
          try {
            const parsed = JSON.parse(await fs.readFile(absolutePath, "utf8")) as Record<
              string,
              unknown
            >;
            return {
              path: normalizeRelativePath(path.relative(params.workspaceDir, absolutePath)),
              receipt: parsed,
            };
          } catch {
            return {
              path: normalizeRelativePath(path.relative(params.workspaceDir, absolutePath)),
              receipt: null,
            };
          }
        }),
    )
  ).filter(
    (entry) => entry.receipt?.boundary === "finance_learning_capability_apply_usage_receipt",
  );
  const capabilityUseCounts = new Map<string, number>();
  for (const entry of receipts) {
    const appliedCapabilities = Array.isArray(entry.receipt?.appliedCapabilities)
      ? entry.receipt.appliedCapabilities
      : [];
    for (const capability of appliedCapabilities) {
      const capabilityName = optionalString(asRecord(capability).capabilityName);
      if (!capabilityName) {
        continue;
      }
      capabilityUseCounts.set(capabilityName, (capabilityUseCounts.get(capabilityName) ?? 0) + 1);
    }
  }
  const reviewRelPath = path.join(
    FINANCE_LEARNING_APPLY_USAGE_REVIEW_DIR,
    `${params.dateKey}.json`,
  );
  await fs.mkdir(path.join(params.workspaceDir, FINANCE_LEARNING_APPLY_USAGE_REVIEW_DIR), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(params.workspaceDir, reviewRelPath),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        boundary: "finance_learning_capability_apply_usage_review",
        dateKey: params.dateKey,
        generatedAt: new Date().toISOString(),
        counts: {
          usageReceipts: receipts.length,
          successfulApplications: receipts.filter((entry) => entry.receipt?.ok === true).length,
          refusedApplications: receipts.filter((entry) => entry.receipt?.ok === false).length,
          multiCapabilitySyntheses: receipts.filter(
            (entry) => entry.receipt?.synthesisMode === "multi_capability_synthesis",
          ).length,
          singleCapabilityApplications: receipts.filter(
            (entry) => entry.receipt?.synthesisMode === "single_capability_application",
          ).length,
        },
        topCapabilities: [...capabilityUseCounts.entries()]
          .map(([capabilityName, count]) => ({ capabilityName, count }))
          .toSorted(
            (a, b) => b.count - a.count || a.capabilityName.localeCompare(b.capabilityName),
          ),
        refusedQueries: receipts
          .filter((entry) => entry.receipt?.ok === false)
          .map((entry) => ({
            queryText: optionalString(entry.receipt?.queryText),
            reason: optionalString(entry.receipt?.reason),
            receiptPath: entry.path,
          })),
        recentReceipts: receipts.map((entry) => entry.path),
        separationContract: {
          readsOnly: FINANCE_LEARNING_APPLY_USAGE_RECEIPT_DIR,
          writesOnly: FINANCE_LEARNING_APPLY_USAGE_REVIEW_DIR,
          protectedMemoryUntouched: true,
          languageCorpusUntouched: true,
          noExecutionAuthority: true,
          noDoctrineMutation: true,
        },
        action:
          "Use this automatic review to see which retained finance capabilities are actually applied, synthesized, or refused without asking the operator for a daily command.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return normalizeRelativePath(reviewRelPath);
}

async function writeApplyUsageReceiptAndReview(
  params: Parameters<typeof writeApplyUsageReceipt>[0],
) {
  const usageReceiptPath = await writeApplyUsageReceipt(params);
  const match = usageReceiptPath.match(
    /^memory\/finance-learning-apply-usage-receipts\/(\d{4}-\d{2}-\d{2})\//u,
  );
  const usageReviewPath = await writeApplyUsageReview({
    workspaceDir: params.workspaceDir,
    dateKey: match?.[1] ?? new Date().toISOString().slice(0, 10),
  });
  return { usageReceiptPath, usageReviewPath };
}

export function createFinanceLearningCapabilityApplyTool(options?: {
  workspaceDir?: string;
  inspectTool?: AnyAgentTool;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  const inspectTool =
    options?.inspectTool ?? createFinanceLearningCapabilityInspectTool({ workspaceDir });
  return {
    label: "Finance Learning Capability Apply",
    name: "finance_learning_capability_apply",
    description:
      "Apply retained finance learning capabilities to one bounded research question by retrieving capability cards and returning reuse guidance, required inputs, causal checks, and risk checks. This is read-only and does not create trading advice.",
    parameters: FinanceLearningCapabilityApplySchema,
    execute: async (toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const queryText = readStringParam(params, "queryText", {
        required: true,
        label: "queryText",
      });
      const maxCandidates = clampMaxCandidates(readStringOrNumberParam(params, "maxCandidates"));
      const writeUsageReceipt = params.writeUsageReceipt !== false;
      const inspectResult = await inspectTool.execute("finance-learning-capability-apply:inspect", {
        queryText,
        maxCandidates,
      });
      const inspectDetails = asRecord(inspectResult.details);
      if (inspectDetails.ok !== true) {
        const usageRecord = writeUsageReceipt
          ? await writeApplyUsageReceiptAndReview({
              workspaceDir,
              toolCallId,
              queryText,
              ok: false,
              reason:
                typeof inspectDetails.reason === "string"
                  ? inspectDetails.reason
                  : "finance_learning_capability_inspect_failed",
              candidateCount: 0,
            })
          : null;
        return jsonResult({
          ok: false,
          boundary: "finance_learning_capability_apply_read_only",
          queryText,
          usageReceiptPath: usageRecord?.usageReceiptPath ?? null,
          usageReviewPath: usageRecord?.usageReviewPath ?? null,
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
        const usageRecord = writeUsageReceipt
          ? await writeApplyUsageReceiptAndReview({
              workspaceDir,
              toolCallId,
              queryText,
              ok: false,
              reason: "no_retrievable_finance_capability",
              candidateCount: 0,
            })
          : null;
        return jsonResult({
          ok: false,
          boundary: "finance_learning_capability_apply_read_only",
          queryText,
          usageReceiptPath: usageRecord?.usageReceiptPath ?? null,
          usageReviewPath: usageRecord?.usageReviewPath ?? null,
          reason: "no_retrievable_finance_capability",
          action:
            "Do not improvise a learned answer. First run finance_learning_pipeline_orchestrator on a safe source or refine the query against existing capability tags.",
        });
      }
      const appliedCapabilities = candidates.map((candidate) => formatCapabilityUse(candidate));
      const answerScaffold = buildResearchAnswerScaffold({ queryText, appliedCapabilities });
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
        const usageRecord = writeUsageReceipt
          ? await writeApplyUsageReceiptAndReview({
              workspaceDir,
              toolCallId,
              queryText,
              ok: false,
              reason: "missing_reuse_guidance",
              candidateCount: appliedCapabilities.length,
              appliedCapabilities,
            })
          : null;
        return jsonResult({
          ok: false,
          boundary: "finance_learning_capability_apply_read_only",
          queryText,
          usageReceiptPath: usageRecord?.usageReceiptPath ?? null,
          usageReviewPath: usageRecord?.usageReviewPath ?? null,
          reason: "missing_reuse_guidance",
          candidateCount: appliedCapabilities.length,
          missingReuseGuidanceCapabilities: missingReuseGuidance.map((candidate) => ({
            capabilityName: candidate.capabilityName,
            sourceArticlePath: candidate.sourceArticlePath,
          })),
          action:
            "Repair retained finance capability reuse guidance before applying this learning to a research answer.",
        });
      }
      const usageRecord = writeUsageReceipt
        ? await writeApplyUsageReceiptAndReview({
            workspaceDir,
            toolCallId,
            queryText,
            ok: true,
            synthesisMode: answerScaffold.capabilitySynthesis.mode,
            candidateCount: appliedCapabilities.length,
            appliedCapabilities,
            answerScaffoldStatus: answerScaffold.status,
            capabilitySynthesis: answerScaffold.capabilitySynthesis,
          })
        : null;
      return jsonResult({
        ok: true,
        boundary: "finance_learning_capability_apply_read_only",
        queryText,
        usageReceiptPath: usageRecord?.usageReceiptPath ?? null,
        usageReviewPath: usageRecord?.usageReviewPath ?? null,
        retrievalMode: inspectDetails.retrievalMode ?? "query_ranked",
        applicationMode: "reuse_guidance_bounded_research_answer",
        synthesisMode: answerScaffold.capabilitySynthesis.mode,
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
          answerScaffold,
          capabilitySynthesis: answerScaffold.capabilitySynthesis,
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
