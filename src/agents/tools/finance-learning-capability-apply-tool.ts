import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringOrNumberParam, readStringParam } from "./common.js";
import { createFinanceLearningCapabilityInspectTool } from "./finance-learning-capability-inspect-tool.js";
import {
  evaluateFinanceLearningTask,
  FinanceLearningTaskSchema,
  FinanceLearningPriorTaskSchema,
  type FinanceLearningTaskApplication,
} from "./finance-learning-task-evaluation.js";

const FinanceLearningCapabilityApplySchema = Type.Object({
  sourceArticlePath: Type.Optional(Type.String()),
  financialTask: Type.Optional(FinanceLearningTaskSchema),
  priorTaskReceiptSource: Type.Optional(FinanceLearningPriorTaskSchema),
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
  const reusableCapabilityLine =
    capabilityNames.length > 0
      ? `Use retained capability: ${capabilityNames.join("; ")}.`
      : "Name the retained capability before using it.";
  const freshInputLine =
    requiredInputs.length > 0
      ? `Fresh inputs checked or missing: ${requiredInputs.join("; ")}.`
      : "Fresh inputs checked or missing: name the required inputs before concluding.";
  const riskBoundaryLine =
    riskChecks.length > 0
      ? `Risk boundary: ${riskChecks.join(" | ")}.`
      : "Risk boundary: do not use the capability if risk, stale-data, or overfitting checks are missing.";

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
    usableAnswerContract: {
      status: "usable_after_fresh_inputs_are_checked",
      purpose:
        "Force the final agent reply to become an operator-usable research answer, not just a hidden receipt or generic summary.",
      requiredVisibleLines: [
        reusableCapabilityLine,
        "How to apply now: state the bounded research use before giving any conclusion.",
        freshInputLine,
        "Causal check: say whether the current case supports the retained mechanism.",
        riskBoundaryLine,
        "Final status: application_ready only if the checks pass; otherwise give failedReason.",
      ],
      refusalRule:
        "If fresh inputs, evidence families, causal support, or risk checks are missing, answer with not_application_ready plus a concrete failedReason instead of improvising.",
      noActionBoundary:
        "Research-only: no trade execution approval, no automatic doctrine mutation, no standalone prediction.",
    },
  };
}

export function buildUsageReceiptFileName(params: {
  appliedCapabilitySourcePaths?: string[];
  candidateCount?: number;
  queryText: string;
  synthesisMode?: string | null;
  toolCallId: string;
}): string {
  const hash = createHash("sha256")
    .update(
      [
        params.toolCallId,
        params.queryText,
        params.synthesisMode ?? "",
        String(params.candidateCount ?? ""),
        ...(params.appliedCapabilitySourcePaths ?? []),
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 12);
  return `${new Date().toISOString().replace(/[:.]/gu, "-")}__${hash}.json`;
}

async function writeReceiptFileWithoutOverwrite(params: {
  buildContent: () => string;
  receiptRelPath: string;
  workspaceDir: string;
}): Promise<{ path: string; sha256: string; bytes: number }> {
  const receiptRelDir = path.dirname(params.receiptRelPath);
  const receiptFileName = path.basename(params.receiptRelPath, ".json");
  await fs.mkdir(path.join(params.workspaceDir, receiptRelDir), { recursive: true });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidateRelPath =
      attempt === 0
        ? params.receiptRelPath
        : path.join(receiptRelDir, `${receiptFileName}__${attempt}.json`);
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(path.join(params.workspaceDir, candidateRelPath), "wx");
      const content = params.buildContent();
      await handle.writeFile(content, "utf8");
      return {
        path: candidateRelPath.split(path.sep).join("/"),
        sha256: createHash("sha256").update(content, "utf8").digest("hex"),
        bytes: Buffer.byteLength(content, "utf8"),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    } finally {
      await handle?.close();
    }
  }
  throw new Error(
    `could not allocate unique finance learning apply receipt path: ${params.receiptRelPath}`,
  );
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
  taskApplication?: FinanceLearningTaskApplication;
  taskResultScope?: "historical_task_not_current_market_or_trade";
  consumedTaskReceipt?: { path: string; sha256: string };
}) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const receiptRelDir = path.join(FINANCE_LEARNING_APPLY_USAGE_RECEIPT_DIR, dateKey);
  const receiptRelPath = path.join(
    receiptRelDir,
    buildUsageReceiptFileName({
      appliedCapabilitySourcePaths: (params.appliedCapabilities ?? [])
        .map((capability) => capability.sourceArticlePath)
        .filter((sourceArticlePath): sourceArticlePath is string => Boolean(sourceArticlePath)),
      candidateCount: params.candidateCount,
      queryText: params.queryText,
      synthesisMode: params.synthesisMode,
      toolCallId: params.toolCallId,
    }),
  );
  return writeReceiptFileWithoutOverwrite({
    workspaceDir: params.workspaceDir,
    receiptRelPath,
    buildContent: () =>
      `${JSON.stringify(
        {
          schemaVersion: 1,
          boundary: "finance_learning_capability_apply_usage_receipt",
          toolCallId: params.toolCallId,
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
          ...(params.taskApplication ? { taskApplication: params.taskApplication } : {}),
          ...(params.taskResultScope ? { taskResultScope: params.taskResultScope } : {}),
          ...(params.consumedTaskReceipt
            ? { consumedTaskReceipt: params.consumedTaskReceipt }
            : {}),
          noExecutionAuthority: true,
          noDoctrineMutation: true,
          noProtectedMemoryWrite: true,
          action:
            "Use this receipt to audit which retained finance capabilities were applied, synthesized, or refused for a bounded research question.",
        },
        null,
        2,
      )}\n`,
  });
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
  const usageReceiptSource = await writeApplyUsageReceipt(params);
  const usageReceiptPath = usageReceiptSource.path;
  const match = usageReceiptPath.match(
    /^memory\/finance-learning-apply-usage-receipts\/(\d{4}-\d{2}-\d{2})\//u,
  );
  const usageReviewPath = await writeApplyUsageReview({
    workspaceDir: params.workspaceDir,
    dateKey: match?.[1] ?? new Date().toISOString().slice(0, 10),
  });
  return { usageReceiptPath, usageReceiptSource, usageReviewPath };
}

/** Read only a bounded recent receipt list for the selected primary method. */
async function findPriorMethodTask(workspaceDir: string, sourcePath: string) {
  let reviewDirectoryObserved = false;
  try {
    const root = await fs.realpath(workspaceDir);
    const entries = await fs.readdir(path.join(root, FINANCE_LEARNING_APPLY_USAGE_REVIEW_DIR));
    reviewDirectoryObserved = true;
    const reviews = entries
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name))
      .toSorted()
      .toReversed()
      .slice(0, 3);
    const read = async (relative: string, limit: number) => {
      const filename = await fs.realpath(path.join(root, relative));
      if (!filename.startsWith(root + path.sep) || (await fs.stat(filename)).size > limit) {
        throw new Error("prior_task_feedback_scope_or_budget_gap");
      }
      const bytes = await fs.readFile(filename);
      if (bytes.length > limit) {
        throw new Error("prior_task_feedback_budget_gap");
      }
      return bytes;
    };
    let remaining = 16;
    for (const review of reviews) {
      const index = asRecord(
        JSON.parse(
          (
            await read(path.join(FINANCE_LEARNING_APPLY_USAGE_REVIEW_DIR, review), 512_000)
          ).toString("utf8"),
        ),
      );
      for (const relative of stringArray(index.recentReceipts).toReversed()) {
        if (remaining-- <= 0) {
          return {
            gap: "prior_task_feedback_recent_lookup_budget; older receipts require an exact pointer",
          };
        }
        if (
          !/^memory\/finance-learning-apply-usage-receipts\/\d{4}-\d{2}-\d{2}\/[^/]+\.json$/u.test(
            relative,
          )
        ) {
          throw new Error("prior_task_feedback_receipt_scope_gap");
        }
        const bytes = await read(relative, 64_000);
        const receipt = asRecord(JSON.parse(bytes.toString("utf8")));
        const task = asRecord(receipt.taskApplication);
        if (asRecord(task.source).path !== sourcePath) {
          continue;
        }
        if (
          receipt.ok !== true ||
          receipt.boundary !== "finance_learning_capability_apply_usage_receipt" ||
          typeof task.taskId !== "string"
        ) {
          throw new Error("prior_task_feedback_original_receipt_invalid");
        }
        return {
          prior: {
            path: relative,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            taskId: task.taskId,
          },
        };
      }
    }
    return {};
  } catch (error) {
    if (!reviewDirectoryObserved && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    return { gap: "prior_task_feedback_lookup_unavailable; inspect original usage review/receipt" };
  }
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
      "Apply retained finance learning capabilities to one bounded research question by retrieving capability cards and returning reuse guidance, required inputs, causal checks, and risk checks. Optional financialTask executes the native economics evaluator under one exact sourceArticlePath; priorTaskReceiptSource revalidates and consumes its original task feedback to change the next research action. These are bounded risk/sample-review methods, not paper-algorithm replication or execution approval.",
    parameters: FinanceLearningCapabilityApplySchema,
    execute: async (toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const queryText = readStringParam(params, "queryText", {
        required: true,
        label: "queryText",
      });
      const maxCandidates = clampMaxCandidates(readStringOrNumberParam(params, "maxCandidates"));
      const writeUsageReceipt = params.writeUsageReceipt !== false;
      const taskRequested =
        params.financialTask !== undefined || params.priorTaskReceiptSource !== undefined;
      const sourceArticlePath = readStringParam(params, "sourceArticlePath");
      if (taskRequested && (!sourceArticlePath || !writeUsageReceipt)) {
        throw new Error("financial_task_requires_exact_source_and_original_usage_receipt");
      }
      const inspectResult = await inspectTool.execute("finance-learning-capability-apply:inspect", {
        queryText,
        maxCandidates,
        ...(sourceArticlePath ? { sourceArticlePath } : {}),
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
          usageReceiptSource: usageRecord?.usageReceiptSource ?? null,
          applicationStatus: "not_application_ready",
          failedReason:
            typeof inspectDetails.reason === "string"
              ? inspectDetails.reason
              : "finance_learning_capability_inspect_failed",
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
          usageReceiptSource: usageRecord?.usageReceiptSource ?? null,
          applicationStatus: "not_application_ready",
          failedReason: "no_retrievable_finance_capability",
          queryText,
          usageReceiptPath: usageRecord?.usageReceiptPath ?? null,
          usageReviewPath: usageRecord?.usageReviewPath ?? null,
          reason: "no_retrievable_finance_capability",
          action:
            "Do not improvise a learned answer. First run finance_learning_pipeline_orchestrator on a safe source or refine the query against existing capability tags.",
        });
      }
      const blockedCapabilities = candidates
        .filter((candidate) => {
          const review = asRecord(candidate.moduleLearningReview);
          return review.applicationAllowed === false;
        })
        .map((candidate) => ({
          capabilityName: candidate.capabilityName,
          sourceArticlePath: candidate.sourceArticlePath,
          moduleLearningReview: candidate.moduleLearningReview,
        }));
      const applicableCandidates = candidates.filter(
        (candidate) => asRecord(candidate.moduleLearningReview).applicationAllowed !== false,
      );
      if (applicableCandidates.length === 0 && blockedCapabilities.length > 0) {
        const usageRecord = writeUsageReceipt
          ? await writeApplyUsageReceiptAndReview({
              workspaceDir,
              toolCallId,
              queryText,
              ok: false,
              reason: "module_learning_review_blocks_application",
              candidateCount: 0,
            })
          : null;
        return jsonResult({
          ok: false,
          boundary: "finance_learning_capability_apply_read_only",
          usageReceiptSource: usageRecord?.usageReceiptSource ?? null,
          applicationStatus: "not_application_ready",
          failedReason: "module_learning_review_blocks_application",
          reason: "module_learning_review_blocks_application",
          queryText,
          usageReceiptPath: usageRecord?.usageReceiptPath ?? null,
          usageReviewPath: usageRecord?.usageReviewPath ?? null,
          candidateCount: 0,
          blockedCapabilities,
          action:
            "Resolve the cited original module-learning review decision or evidence gap before application; preserve the source and historical receipts.",
        });
      }
      const appliedCapabilities = applicableCandidates.map((candidate) =>
        formatCapabilityUse(candidate),
      );
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
          usageReceiptSource: usageRecord?.usageReceiptSource ?? null,
          applicationStatus: "not_application_ready",
          failedReason: "missing_reuse_guidance",
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
      let taskResult = taskRequested
        ? await evaluateFinanceLearningTask({
            workspaceDir,
            candidate:
              applicableCandidates.find(
                (candidate) => candidate.sourceArticlePath === sourceArticlePath,
              ) ?? {},
            task: params.financialTask,
            prior: params.priorTaskReceiptSource,
          })
        : undefined;
      let priorTaskFeedbackGap: string | undefined;
      let historicalFeedback = false;
      const primary = applicableCandidates[0];
      if (
        !taskRequested &&
        writeUsageReceipt &&
        primary &&
        stringArray(primary.capabilityTags).includes("risk_gate_design") &&
        typeof primary.sourceArticlePath === "string"
      ) {
        const found = await findPriorMethodTask(workspaceDir, primary.sourceArticlePath);
        priorTaskFeedbackGap = found.gap;
        if (found.prior) {
          try {
            taskResult = await evaluateFinanceLearningTask({
              workspaceDir,
              candidate: primary,
              prior: found.prior,
            });
            historicalFeedback = true;
          } catch {
            // A rejected optional historical result cannot become evidence or a trade veto.
            priorTaskFeedbackGap =
              "prior_task_feedback_validation_failed; inspect original source/task/receipt";
          }
        }
      }
      const usageRecord = writeUsageReceipt
        ? await writeApplyUsageReceiptAndReview({
            workspaceDir,
            toolCallId,
            queryText,
            ok: true,
            taskApplication: taskResult?.application,
            ...(historicalFeedback
              ? { taskResultScope: "historical_task_not_current_market_or_trade" as const }
              : {}),
            consumedTaskReceipt: taskResult?.consumedReceipt,
            synthesisMode: answerScaffold.capabilitySynthesis.mode,
            candidateCount: appliedCapabilities.length,
            appliedCapabilities,
            answerScaffoldStatus: answerScaffold.status,
            capabilitySynthesis: answerScaffold.capabilitySynthesis,
          })
        : null;
      if (taskResult && usageRecord) {
        const { application, consumedReceipt } = taskResult;
        // Keep task results in the original 4 KB handoff; exact rule/input detail stays
        // in the original immutable usage receipt, not duplicated in the model context.
        const response = {
          ok: true,
          boundary: "finance_learning_capability_apply_read_only",
          applicationStatus: "application_ready",
          applicationMode: historicalFeedback
            ? "prior_method_task_feedback_context"
            : "source_bound_financial_task_review",
          ...(historicalFeedback
            ? { taskResultScope: "historical_task_not_current_market_or_trade" }
            : {}),
          candidateCount: historicalFeedback ? appliedCapabilities.length : 1,
          ...(historicalFeedback
            ? {
                supportingMethodSourceRefs: appliedCapabilities.slice(1, 3).map((candidate) => ({
                  sourceArticlePath: candidate.sourceArticlePath,
                  capabilityName: candidate.capabilityName,
                })),
                otherMethodsBoundary:
                  "This prior result applies only to its exact primary source; supporting methods retain their own evidence and guidance requirements. Full selected method references remain in /appliedCapabilities of the original usage receipt.",
              }
            : {}),
          usageReceiptPath: usageRecord.usageReceiptPath,
          usageReviewPath: usageRecord.usageReviewPath,
          usageReceiptSource: usageRecord.usageReceiptSource,
          consumedTaskReceipt: consumedReceipt ?? null,
          taskApplication: {
            taskId: application.taskId,
            source: application.source,
            sourceMethod: application.sourceMethod,
            methodOwner: application.methodOwner,
            nativeReceiptRef: application.nativeReceiptRef,
            datasetRef: application.datasetRef,
            policyRef: application.policyRef,
            assessmentInputs: application.assessmentInputs,
            sourceTruth: application.sourceTruth,
            algorithmFromSource: false,
            executionAuthority: "none",
          },
          nextTaskReceiptSource: {
            path: usageRecord.usageReceiptSource.path,
            sha256: usageRecord.usageReceiptSource.sha256,
            taskId: application.taskId,
          },
          answerSkeleton: {
            summary: historicalFeedback
              ? `Historical method-task feedback: ${application.assessment.conclusion} This is not a current market/trade assessment; refresh current inputs independently.`
              : application.assessment.conclusion,
            nextAction: application.assessment.nextAction,
            requiredNextChecks: application.assessment.corrections,
          },
          remainingReceiptFields: [
            ...(historicalFeedback ? ["/appliedCapabilities"] : []),
            "/taskApplication/sourceChecksUsed",
            "/taskApplication/replay",
            "/taskApplication/policy",
            "/taskApplication/assessment",
          ],
        };
        if (Buffer.byteLength(JSON.stringify(response), "utf8") > 4096) {
          if (historicalFeedback) {
            return jsonResult({
              ok: true,
              applicationMode: "prior_method_feedback_omitted_budget",
              candidateCount: appliedCapabilities.length,
              usageReceiptSource: usageRecord.usageReceiptSource,
              priorTaskFeedbackGap:
                "Prior task feedback was not injected under the original 4KB budget; no current task assessment is implied.",
              readFields: ["/taskApplication", "/appliedCapabilities"],
            });
          }
          throw new Error("financial_task_response_exceeds_original_4kb_budget");
        }
        return jsonResult(response);
      }
      return jsonResult({
        ok: true,
        boundary: "finance_learning_capability_apply_read_only",
        usageReceiptSource: usageRecord?.usageReceiptSource ?? null,
        applicationStatus: "application_ready",
        blockedCapabilities,
        failedReason: null,
        queryText,
        usageReceiptPath: usageRecord?.usageReceiptPath ?? null,
        usageReviewPath: usageRecord?.usageReviewPath ?? null,
        retrievalMode: inspectDetails.retrievalMode ?? "query_ranked",
        applicationMode: "reuse_guidance_bounded_research_answer",
        ...(priorTaskFeedbackGap ? { priorTaskFeedbackGap } : {}),
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
            ...(priorTaskFeedbackGap ? [priorTaskFeedbackGap] : []),
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
          usableAnswerContract: answerScaffold.usableAnswerContract,
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
