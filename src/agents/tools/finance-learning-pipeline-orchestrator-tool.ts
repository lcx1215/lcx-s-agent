import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  FINANCE_ARTICLE_SOURCE_TYPES,
  FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringOrNumberParam, readStringParam, ToolInputError } from "./common.js";
import { createFinanceArticleExtractCapabilityInputTool } from "./finance-article-extract-capability-input-tool.js";
import { createFinanceExternalSourceAdapterTool } from "./finance-external-source-adapter-tool.js";
import { createFinanceLearningCapabilityApplyTool } from "./finance-learning-capability-apply-tool.js";
import { createFinanceLearningCapabilityAttachTool } from "./finance-learning-capability-attach-tool.js";
import { createFinanceLearningCapabilityInspectTool } from "./finance-learning-capability-inspect-tool.js";
import {
  countApplicationReadyRetrievedCandidates,
  writeFinanceLearningRetrievalReview,
} from "./finance-learning-retrieval-review-tool.js";
import { createFinanceResearchSourceWorkbenchTool } from "./finance-research-source-workbench-tool.js";

const FINANCE_EXTERNAL_SOURCE_ADAPTER_TYPES = [
  "rss_atom_json_feed",
  "markdown_article_export",
  "local_text_html_article_export",
  "opml_export",
  "external_tool_export_folder",
  "web_search_export",
  "official_reference_export",
] as const;

const FINANCE_EXTERNAL_SOURCE_ADAPTER_COLLECTION_METHODS = [
  "rss_or_public_feed_if_available",
  "local_file",
  "manual_paste",
  "external_tool_export",
  "browser_assisted_manual_collection",
] as const;

const FINANCE_EXTERNAL_SOURCE_FAMILIES = [
  "official_filing",
  "official_macro_data",
  "company_ir",
  "etf_issuer",
  "news",
  "research_blog",
  "public_feed",
  "public_web_reference",
  "wechat_public_account",
  "local_artifact",
  "manual_paste",
] as const;

const FinanceLearningPipelineOrchestratorSchema = Type.Object({
  adapterName: Type.Optional(Type.String()),
  adapterType: Type.Optional(stringEnum(FINANCE_EXTERNAL_SOURCE_ADAPTER_TYPES)),
  inputPath: Type.Optional(Type.String()),
  feedUrl: Type.Optional(Type.String()),
  referenceUrl: Type.Optional(Type.String()),
  sourceFamily: Type.Optional(stringEnum(FINANCE_EXTERNAL_SOURCE_FAMILIES)),
  sourceName: Type.String(),
  collectionMethod: Type.Optional(stringEnum(FINANCE_EXTERNAL_SOURCE_ADAPTER_COLLECTION_METHODS)),
  complianceNotes: Type.Optional(Type.String()),
  sourceType: Type.Optional(stringEnum(FINANCE_ARTICLE_SOURCE_TYPES)),
  pastedText: Type.Optional(Type.String()),
  localFilePath: Type.Optional(Type.String()),
  userProvidedUrl: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  publishDate: Type.Optional(Type.String()),
  retrievalNotes: Type.String(),
  allowedActionAuthority: Type.Optional(stringEnum(FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES)),
  isPubliclyAccessible: Type.Optional(Type.Boolean()),
  executionRequested: Type.Optional(Type.Boolean()),
  autoPromotionRequested: Type.Optional(Type.Boolean()),
  doctrineMutationRequested: Type.Optional(Type.Boolean()),
  learningIntent: Type.Optional(
    Type.String({
      description:
        "Optional natural-language learning intent used to retrieve existing capability cards before and after intake.",
    }),
  ),
  maxRetrievedCapabilities: Type.Optional(
    Type.Number({
      description:
        "Maximum existing capability cards to retrieve for learningIntent before and after intake.",
    }),
  ),
  applicationValidationQuery: Type.Optional(
    Type.String({
      description:
        "Optional bounded research question used after successful attachment to prove the retained capability can be applied, not just retrieved.",
    }),
  ),
  maxAppliedCapabilities: Type.Optional(
    Type.Number({
      description:
        "Maximum retained capabilities to apply during application validation. Defaults to 3.",
    }),
  ),
});

type IntakeRoute = "external_source_adapter" | "research_source_workbench";

const FINANCE_LEARNING_RETRIEVAL_RECEIPT_DIR = path.join(
  "memory",
  "finance-learning-retrieval-receipts",
);

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function chooseIntakeRoute(params: Record<string, unknown>): IntakeRoute {
  const adapterType = normalizeOptionalString(readStringParam(params, "adapterType"));
  const adapterName = normalizeOptionalString(readStringParam(params, "adapterName"));
  if (adapterType || adapterName) {
    return "external_source_adapter";
  }
  return "research_source_workbench";
}

async function readContentKind(workspaceDir: string, articlePath: string): Promise<string | null> {
  const absolutePath = path.join(workspaceDir, articlePath);
  const content = await fs.readFile(absolutePath, "utf8");
  const match = content.match(/^- \*\*Content Kind\*\*: ([^\n]+)$/mu);
  return match?.[1]?.trim() ?? null;
}

function normalizeResultArrays(details: Record<string, unknown>, key: string): string[] {
  const value = details[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function countRetrievedCandidates(details: unknown): number {
  if (!details || typeof details !== "object") {
    return 0;
  }
  const record = details as Record<string, unknown>;
  return typeof record.candidateCount === "number" && Number.isFinite(record.candidateCount)
    ? record.candidateCount
    : 0;
}

function buildLearningRetrievalReceiptFileName(params: {
  learningIntent: string;
  sourceName: string;
  toolCallId: string;
}): string {
  const hash = createHash("sha256")
    .update(`${params.toolCallId}\n${params.sourceName}\n${params.learningIntent}`)
    .digest("hex")
    .slice(0, 12);
  return `${new Date().toISOString().replace(/[:.]/gu, "-")}__${hash}.json`;
}

async function writeLearningRetrievalReceipt(params: {
  workspaceDir: string;
  toolCallId: string;
  sourceName: string;
  learningIntent: string;
  maxRetrievedCapabilities: number;
  normalizedArticleArtifactPaths: string[];
  normalizedReferenceArtifactPaths: string[];
  preflightCapabilityRetrieval: unknown;
  postAttachCapabilityRetrieval: unknown;
  applicationValidation: {
    requested: boolean;
    status: string;
    candidateCount: number;
    failedReason: string | null;
    usageReceiptPath: string | null;
    usageReviewPath: string | null;
  } | null;
  retainedCandidateCount: number;
}): Promise<string> {
  const preflightCandidateCount = countRetrievedCandidates(params.preflightCapabilityRetrieval);
  const postAttachCandidateCount = countRetrievedCandidates(params.postAttachCapabilityRetrieval);
  const dateKey = new Date().toISOString().slice(0, 10);
  const receiptRelDir = path.join(FINANCE_LEARNING_RETRIEVAL_RECEIPT_DIR, dateKey);
  const receiptRelPath = path.join(
    receiptRelDir,
    buildLearningRetrievalReceiptFileName({
      learningIntent: params.learningIntent,
      sourceName: params.sourceName,
      toolCallId: params.toolCallId,
    }),
  );
  await fs.mkdir(path.join(params.workspaceDir, receiptRelDir), { recursive: true });
  await fs.writeFile(
    path.join(params.workspaceDir, receiptRelPath),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        boundary: "finance_learning_retrieval_receipt",
        generatedAt: new Date().toISOString(),
        sourceName: params.sourceName,
        learningIntent: params.learningIntent,
        maxRetrievedCapabilities: params.maxRetrievedCapabilities,
        normalizedArticleArtifactPaths: params.normalizedArticleArtifactPaths,
        normalizedReferenceArtifactPaths: params.normalizedReferenceArtifactPaths,
        retainedCandidateCount: params.retainedCandidateCount,
        preflightCandidateCount,
        postAttachCandidateCount,
        newlyRetrievableCandidateDelta: Math.max(
          0,
          postAttachCandidateCount - preflightCandidateCount,
        ),
        reusedExistingBeforeLearning: preflightCandidateCount > 0,
        retrievalFirstLearningApplied: true,
        noExecutionAuthority: true,
        noDoctrineMutation: true,
        preflightCapabilityRetrieval: params.preflightCapabilityRetrieval,
        postAttachCapabilityRetrieval: params.postAttachCapabilityRetrieval,
        applicationValidation: params.applicationValidation,
        action:
          "Use this receipt to verify whether a learning run became retrievable and, when requested, application-validated through stable finance domains, capability tags, query-ranked capability cards, and read-only apply guidance.",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return receiptRelPath.split(path.sep).join("/");
}

function extractRetrievalReceiptDateKey(receiptPath: string): string | null {
  const match = receiptPath.match(
    /^memory\/finance-learning-retrieval-receipts\/(\d{4}-\d{2}-\d{2})\//u,
  );
  return match?.[1] ?? null;
}

function clampMaxRetrievedCapabilities(value: string | undefined): number {
  const parsed = value ? Number(value) : 5;
  if (!Number.isFinite(parsed)) {
    return 5;
  }
  return Math.max(1, Math.min(20, Math.floor(parsed)));
}

function clampMaxAppliedCapabilities(value: string | undefined): number {
  const parsed = value ? Number(value) : 3;
  if (!Number.isFinite(parsed)) {
    return 3;
  }
  return Math.max(1, Math.min(8, Math.floor(parsed)));
}

function buildLearningInternalizationStatus(params: {
  retainedCandidateCount: number;
  postAttachCandidateCount: number;
  applicationReadyCandidateCount: number;
}): "application_ready" | "retrievable_but_not_application_ready" | "not_retrievable" {
  if (params.retainedCandidateCount <= 0 || params.postAttachCandidateCount <= 0) {
    return "not_retrievable";
  }
  if (params.applicationReadyCandidateCount <= 0) {
    return "retrievable_but_not_application_ready";
  }
  return "application_ready";
}

function wrapStepFailure(params: {
  route: IntakeRoute;
  failedStep: "intake" | "extract" | "attach" | "inspect";
  intakeTool: string;
  articlePath?: string;
  normalizedArticleArtifactPaths?: string[];
  normalizedReferenceArtifactPaths?: string[];
  reason: string;
  errorMessage?: string;
  extractionGap?: unknown;
}) {
  return jsonResult({
    ok: false,
    intakeRoute: params.route,
    intakeTool: params.intakeTool,
    failedStep: params.failedStep,
    failedSourceArticlePath: params.articlePath ?? null,
    normalizedArticleArtifactPaths: params.normalizedArticleArtifactPaths ?? [],
    normalizedReferenceArtifactPaths: params.normalizedReferenceArtifactPaths ?? [],
    reason: params.reason,
    errorMessage: params.errorMessage ?? null,
    extractionGap: params.extractionGap ?? null,
    action:
      "The finance learning pipeline stopped on the first failed step. No later extraction, attachment, or inspect step was treated as success.",
  });
}

export function createFinanceLearningPipelineOrchestratorTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  const externalAdapterTool = createFinanceExternalSourceAdapterTool({ workspaceDir });
  const workbenchTool = createFinanceResearchSourceWorkbenchTool({ workspaceDir });
  const extractTool = createFinanceArticleExtractCapabilityInputTool({ workspaceDir });
  const attachTool = createFinanceLearningCapabilityAttachTool({ workspaceDir });
  const inspectTool = createFinanceLearningCapabilityInspectTool({ workspaceDir });
  const applyTool = createFinanceLearningCapabilityApplyTool({ workspaceDir });

  return {
    label: "Finance Learning Pipeline Orchestrator",
    name: "finance_learning_pipeline_orchestrator",
    description:
      "Run one bounded finance learning pipeline from safe source intake through article extraction, capability attachment, evidence-gated retention, and inspect-ready output without fetching remote content automatically.",
    parameters: FinanceLearningPipelineOrchestratorSchema,
    execute: async (toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const route = chooseIntakeRoute(params);
      const sourceName = readStringParam(params, "sourceName", {
        required: true,
        allowEmpty: true,
      }).trim();
      if (!sourceName) {
        throw new ToolInputError("sourceName must be non-empty");
      }
      const retrievalNotes = readStringParam(params, "retrievalNotes", {
        required: true,
        allowEmpty: true,
      }).trim();
      if (!retrievalNotes) {
        throw new ToolInputError("retrievalNotes must be non-empty");
      }
      const learningIntent = normalizeOptionalString(
        readStringParam(params, "learningIntent", { allowEmpty: true }),
      );
      const maxRetrievedCapabilities = clampMaxRetrievedCapabilities(
        readStringOrNumberParam(params, "maxRetrievedCapabilities"),
      );
      const applicationValidationQuery = normalizeOptionalString(
        readStringParam(params, "applicationValidationQuery", { allowEmpty: true }),
      );
      const maxAppliedCapabilities = clampMaxAppliedCapabilities(
        readStringOrNumberParam(params, "maxAppliedCapabilities"),
      );
      const preflightCapabilityRetrieval = learningIntent
        ? (
            await inspectTool.execute(`${toolCallId}:preflight-capability-retrieval`, {
              queryText: learningIntent,
              maxCandidates: maxRetrievedCapabilities,
            })
          ).details
        : null;

      const intakeArgs = {
        adapterName: normalizeOptionalString(readStringParam(params, "adapterName")),
        adapterType: normalizeOptionalString(readStringParam(params, "adapterType")),
        inputPath: normalizeOptionalString(readStringParam(params, "inputPath")),
        feedUrl: normalizeOptionalString(readStringParam(params, "feedUrl")),
        referenceUrl: normalizeOptionalString(readStringParam(params, "referenceUrl")),
        sourceFamily: normalizeOptionalString(readStringParam(params, "sourceFamily")),
        sourceName,
        collectionMethod: normalizeOptionalString(readStringParam(params, "collectionMethod")),
        complianceNotes: normalizeOptionalString(readStringParam(params, "complianceNotes")),
        sourceType: normalizeOptionalString(readStringParam(params, "sourceType")),
        pastedText: normalizeOptionalString(
          readStringParam(params, "pastedText", { allowEmpty: true }),
        ),
        localFilePath: normalizeOptionalString(
          readStringParam(params, "localFilePath", { allowEmpty: true }),
        ),
        userProvidedUrl: normalizeOptionalString(
          readStringParam(params, "userProvidedUrl", { allowEmpty: true }),
        ),
        title: normalizeOptionalString(readStringParam(params, "title", { allowEmpty: true })),
        publishDate: normalizeOptionalString(
          readStringParam(params, "publishDate", { allowEmpty: true }),
        ),
        retrievalNotes,
        allowedActionAuthority: normalizeOptionalString(
          readStringParam(params, "allowedActionAuthority"),
        ),
        isPubliclyAccessible:
          typeof params.isPubliclyAccessible === "boolean"
            ? params.isPubliclyAccessible
            : undefined,
        executionRequested: params.executionRequested === true,
        autoPromotionRequested: params.autoPromotionRequested === true,
        doctrineMutationRequested: params.doctrineMutationRequested === true,
      };

      const intakeTool =
        route === "external_source_adapter"
          ? "finance_external_source_adapter"
          : "finance_research_source_workbench";
      let intakeResult: Awaited<ReturnType<AnyAgentTool["execute"]>>;
      try {
        if (route === "external_source_adapter") {
          if (!intakeArgs.adapterType) {
            throw new ToolInputError(
              "adapterType is required when using the external source adapter intake path",
            );
          }
          if (!intakeArgs.collectionMethod) {
            throw new ToolInputError(
              "collectionMethod is required when using the external source adapter intake path",
            );
          }
          if (!intakeArgs.sourceFamily) {
            throw new ToolInputError(
              "sourceFamily is required when using the external source adapter intake path",
            );
          }
          if (!intakeArgs.complianceNotes) {
            throw new ToolInputError(
              "complianceNotes is required when using the external source adapter intake path",
            );
          }
          intakeResult = await externalAdapterTool.execute(toolCallId, intakeArgs);
        } else {
          intakeResult = await workbenchTool.execute(toolCallId, {
            sourceName: intakeArgs.sourceName,
            sourceType: intakeArgs.sourceType,
            pastedText: intakeArgs.pastedText,
            localFilePath: intakeArgs.localFilePath,
            userProvidedUrl: intakeArgs.userProvidedUrl,
            title: intakeArgs.title,
            publishDate: intakeArgs.publishDate,
            retrievalNotes: intakeArgs.retrievalNotes,
            allowedActionAuthority: intakeArgs.allowedActionAuthority,
            isPubliclyAccessible: intakeArgs.isPubliclyAccessible,
            executionRequested: intakeArgs.executionRequested,
            autoPromotionRequested: intakeArgs.autoPromotionRequested,
            doctrineMutationRequested: intakeArgs.doctrineMutationRequested,
          });
        }
      } catch (error) {
        return wrapStepFailure({
          route,
          intakeTool,
          failedStep: "intake",
          reason: "finance_learning_pipeline_intake_failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
      const intakeDetails = intakeResult.details as Record<string, unknown>;
      if (intakeDetails.ok !== true) {
        return wrapStepFailure({
          route,
          intakeTool,
          failedStep: "intake",
          reason:
            typeof intakeDetails.reason === "string"
              ? intakeDetails.reason
              : "finance_learning_pipeline_intake_failed",
          errorMessage:
            typeof intakeDetails.errorMessage === "string" ? intakeDetails.errorMessage : undefined,
        });
      }

      const normalizedArticleArtifactPaths =
        route === "external_source_adapter"
          ? normalizeResultArrays(intakeDetails, "normalizedArticleArtifactPaths")
          : typeof intakeDetails.artifactPath === "string"
            ? [intakeDetails.artifactPath]
            : [];
      const normalizedReferenceArtifactPaths =
        route === "external_source_adapter"
          ? normalizeResultArrays(intakeDetails, "normalizedReferenceArtifactPaths")
          : [];

      if (route === "research_source_workbench" && normalizedArticleArtifactPaths.length === 1) {
        const contentKind = await readContentKind(workspaceDir, normalizedArticleArtifactPaths[0]);
        if (contentKind === "metadata_only_reference") {
          return jsonResult({
            ok: true,
            intakeRoute: route,
            intakeTool,
            normalizedArticleArtifactPaths: [],
            normalizedReferenceArtifactPaths: normalizedArticleArtifactPaths,
            extractionSkipped: true,
            extractionSkippedReason: "metadata_only_reference_source",
            noRemoteFetchOccurred: true,
            provenancePreserved: true,
            inspectTool: null,
            action:
              "The source was normalized as metadata-only reference material. No remote content was fetched and no learning candidate was attached. Capture a local/manual article artifact before retrying the full pipeline.",
          });
        }
      }

      if (normalizedArticleArtifactPaths.length === 0) {
        return jsonResult({
          ok: true,
          intakeRoute: route,
          intakeTool,
          normalizedArticleArtifactPaths,
          normalizedReferenceArtifactPaths,
          extractionSkipped: true,
          extractionSkippedReason: "reference_only_source",
          noRemoteFetchOccurred: true,
          provenancePreserved: true,
          inspectTool: null,
          action:
            "The input normalized into references only. No remote content was fetched and no retained candidate was attached because there was no local article content to extract.",
        });
      }

      const extractedPayloads: Array<{
        sourceArticlePath: string;
        attachPayload: Record<string, unknown>;
        extractionDetails: Record<string, unknown>;
      }> = [];

      for (const articlePath of normalizedArticleArtifactPaths) {
        let extractionResult: Awaited<ReturnType<AnyAgentTool["execute"]>>;
        try {
          extractionResult = await extractTool.execute(`${toolCallId}:extract:${articlePath}`, {
            articlePath,
          });
        } catch (error) {
          return wrapStepFailure({
            route,
            intakeTool,
            failedStep: "extract",
            articlePath,
            normalizedArticleArtifactPaths,
            normalizedReferenceArtifactPaths,
            reason: "finance_learning_pipeline_extraction_failed",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
        const extractionDetails = extractionResult.details as Record<string, unknown>;
        if (extractionDetails.ok !== true || !extractionDetails.attachPayload) {
          return wrapStepFailure({
            route,
            intakeTool,
            failedStep: "extract",
            articlePath,
            normalizedArticleArtifactPaths,
            normalizedReferenceArtifactPaths,
            reason:
              typeof extractionDetails.reason === "string"
                ? extractionDetails.reason
                : "finance_learning_pipeline_extraction_failed",
            errorMessage:
              typeof extractionDetails.errorMessage === "string"
                ? extractionDetails.errorMessage
                : undefined,
            extractionGap: extractionDetails.extractionGap,
          });
        }
        extractedPayloads.push({
          sourceArticlePath: articlePath,
          attachPayload: extractionDetails.attachPayload as Record<string, unknown>,
          extractionDetails,
        });
      }

      const attachedResults: Array<{
        sourceArticlePath: string;
        attachDetails: Record<string, unknown>;
      }> = [];
      for (const extracted of extractedPayloads) {
        let attachResult: Awaited<ReturnType<AnyAgentTool["execute"]>>;
        try {
          attachResult = await attachTool.execute(
            `${toolCallId}:attach:${extracted.sourceArticlePath}`,
            extracted.attachPayload,
          );
        } catch (error) {
          return wrapStepFailure({
            route,
            intakeTool,
            failedStep: "attach",
            articlePath: extracted.sourceArticlePath,
            normalizedArticleArtifactPaths,
            normalizedReferenceArtifactPaths,
            reason: "finance_learning_pipeline_attachment_failed",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
        const attachDetails = attachResult.details as Record<string, unknown>;
        if (attachDetails.ok !== true) {
          return wrapStepFailure({
            route,
            intakeTool,
            failedStep: "attach",
            articlePath: extracted.sourceArticlePath,
            normalizedArticleArtifactPaths,
            normalizedReferenceArtifactPaths,
            reason:
              typeof attachDetails.reason === "string"
                ? attachDetails.reason
                : "finance_learning_pipeline_attachment_failed",
            errorMessage:
              typeof attachDetails.errorMessage === "string"
                ? attachDetails.errorMessage
                : undefined,
          });
        }
        attachedResults.push({
          sourceArticlePath: extracted.sourceArticlePath,
          attachDetails,
        });
      }

      const inspectResults: Array<Record<string, unknown>> = [];
      for (const attached of attachedResults) {
        const inspectResult = await inspectTool.execute(
          `${toolCallId}:inspect:${attached.sourceArticlePath}`,
          {
            sourceArticlePath: attached.sourceArticlePath,
          },
        );
        const inspectDetails = inspectResult.details as Record<string, unknown>;
        if (inspectDetails.ok !== true) {
          return wrapStepFailure({
            route,
            intakeTool,
            failedStep: "inspect",
            articlePath: attached.sourceArticlePath,
            normalizedArticleArtifactPaths,
            normalizedReferenceArtifactPaths,
            reason:
              typeof inspectDetails.reason === "string"
                ? inspectDetails.reason
                : "finance_learning_pipeline_inspect_failed",
            errorMessage:
              typeof inspectDetails.errorMessage === "string"
                ? inspectDetails.errorMessage
                : undefined,
          });
        }
        inspectResults.push(inspectDetails);
      }
      const postAttachCapabilityRetrieval = learningIntent
        ? (
            await inspectTool.execute(`${toolCallId}:post-attach-capability-retrieval`, {
              queryText: learningIntent,
              maxCandidates: maxRetrievedCapabilities,
            })
          ).details
        : null;
      const postAttachCandidateCount = countRetrievedCandidates(postAttachCapabilityRetrieval);
      const applicationReadyCandidateCount = countApplicationReadyRetrievedCandidates(
        postAttachCapabilityRetrieval,
      );
      const retainedCandidateCount = inspectResults.reduce((sum, item) => {
        return sum + (typeof item.candidateCount === "number" ? item.candidateCount : 0);
      }, 0);
      const applicationValidation = applicationValidationQuery
        ? ((await applyTool.execute(`${toolCallId}:application-validation`, {
            queryText: applicationValidationQuery,
            maxCandidates: maxAppliedCapabilities,
          })).details as Record<string, unknown>)
        : null;
      const applicationValidationCandidateCount =
        applicationValidation && typeof applicationValidation.candidateCount === "number"
          ? applicationValidation.candidateCount
          : 0;
      const applicationValidationStatus =
        applicationValidationQuery && applicationValidation?.ok === true
          ? applicationValidationCandidateCount > 0
            ? "application_ready"
            : "no_applicable_capability"
          : applicationValidationQuery
            ? "application_validation_failed"
            : "not_requested";
      const applicationValidationReceiptSummary = applicationValidationQuery
        ? {
            requested: true,
            status: applicationValidationStatus,
            candidateCount: applicationValidationCandidateCount,
            failedReason:
              applicationValidation?.ok === true
                ? null
                : typeof applicationValidation?.reason === "string"
                  ? applicationValidation.reason
                  : "finance_learning_capability_apply_failed",
            usageReceiptPath:
              typeof applicationValidation?.usageReceiptPath === "string"
                ? applicationValidation.usageReceiptPath
                : null,
            usageReviewPath:
              typeof applicationValidation?.usageReviewPath === "string"
                ? applicationValidation.usageReviewPath
                : null,
          }
        : null;
      const retrievalReceiptPath = learningIntent
        ? await writeLearningRetrievalReceipt({
            workspaceDir,
            toolCallId,
            sourceName,
            learningIntent,
            maxRetrievedCapabilities,
            normalizedArticleArtifactPaths,
            normalizedReferenceArtifactPaths,
            preflightCapabilityRetrieval,
            postAttachCapabilityRetrieval,
            applicationValidation: applicationValidationReceiptSummary,
            retainedCandidateCount,
          })
        : null;
      const retrievalReview =
        learningIntent && retrievalReceiptPath
          ? await writeFinanceLearningRetrievalReview({
              workspaceDir,
              dateKey:
                extractRetrievalReceiptDateKey(retrievalReceiptPath) ??
                new Date().toISOString().slice(0, 10),
            })
          : null;

      return jsonResult({
        ok: true,
        intakeRoute: route,
        intakeTool,
        normalizedArticleArtifactPaths,
        normalizedReferenceArtifactPaths,
        retainedCandidateCount,
        retrievalFirstLearning: learningIntent
          ? {
              ok: true,
              learningIntent,
              maxRetrievedCapabilities,
              retrievalReceiptPath,
              retrievalReviewPath: retrievalReview?.reviewPath ?? null,
              retrievalReviewCounts: retrievalReview?.review.counts ?? null,
              postAttachCandidateCount,
              applicationReadyCandidateCount,
              learningInternalizationStatus: buildLearningInternalizationStatus({
                retainedCandidateCount,
                postAttachCandidateCount,
                applicationReadyCandidateCount,
              }),
              weakLearningIntents: retrievalReview?.review.weakLearningIntents ?? [],
              classificationContract:
                "Use stable finance domains plus capability tags and query-ranked capability cards before creating narrower categories.",
              preflightCapabilityRetrieval,
              postAttachCapabilityRetrieval,
            }
          : null,
        applicationValidation: applicationValidationQuery
          ? {
              ok: applicationValidation?.ok === true,
              applicationValidationQuery,
              maxAppliedCapabilities,
              applicationValidationStatus,
              candidateCount: applicationValidationCandidateCount,
              failedReason: applicationValidationReceiptSummary?.failedReason ?? null,
              applicationMode:
                typeof applicationValidation?.applicationMode === "string"
                  ? applicationValidation.applicationMode
                  : null,
              synthesisMode:
                typeof applicationValidation?.synthesisMode === "string"
                  ? applicationValidation.synthesisMode
                  : null,
              usageReceiptPath:
                typeof applicationValidation?.usageReceiptPath === "string"
                  ? applicationValidation.usageReceiptPath
                  : null,
              usageReviewPath:
                typeof applicationValidation?.usageReviewPath === "string"
                  ? applicationValidation.usageReviewPath
                  : null,
              answerSkeleton:
                applicationValidation?.answerSkeleton &&
                typeof applicationValidation.answerSkeleton === "object"
                  ? applicationValidation.answerSkeleton
                  : null,
              appliedCapabilities: Array.isArray(applicationValidation?.appliedCapabilities)
                ? applicationValidation.appliedCapabilities
                : [],
            }
          : null,
        inspectTool: "finance_learning_capability_inspect",
        inspectTargets: inspectResults.map((item) => {
          const filters =
            item.filters && typeof item.filters === "object"
              ? (item.filters as Record<string, unknown>)
              : {};
          return {
            sourceArticlePath:
              typeof filters.sourceArticlePath === "string" ? filters.sourceArticlePath : null,
          };
        }),
        extractionTool: "finance_article_extract_capability_input",
        attachTool: "finance_learning_capability_attach",
        noRemoteFetchOccurred: true,
        provenancePreserved: true,
        intakeResult: intakeDetails,
        extractionResults: extractedPayloads.map((item) => ({
          sourceArticlePath: item.sourceArticlePath,
          extractedTitle: item.extractionDetails.extractedTitle ?? null,
          extractedCandidateCount: item.extractionDetails.extractedCandidateCount ?? null,
        })),
        attachResults: attachedResults.map((item) => ({
          sourceArticlePath: item.sourceArticlePath,
          inspectTool: item.attachDetails.inspectTool ?? null,
        })),
      });
    },
  };
}
