import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { randomIdempotencyKey, callGateway } from "../../gateway/call.js";
import {
  buildFeishuFinanceDoctrineTeacherFeedbackFilename,
  parseFeishuFinanceDoctrineCalibrationArtifact,
  parseFeishuFinanceDoctrineCalibrationFilename,
  parseFeishuFinanceDoctrineTeacherFeedbackArtifact,
  parseFeishuWorkReceiptArtifact,
  renderFeishuFinanceDoctrineTeacherFeedbackArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const FINANCE_DOCTRINE_TEACHER_CRITIQUE_TYPES = [
  "missing_causal_chain",
  "overconfident_conviction",
  "missing_bear_case",
  "weak_no_action_justification",
  "weak_instrument_choice",
  "weak_risk_gate",
] as const;

const FinanceDoctrineTeacherFeedbackSchema = Type.Object({
  dateKey: Type.String(),
  sourceArtifact: Type.String(),
});

type GatewayAgentPayload = {
  text?: string;
};

type GatewayAgentResponse = {
  summary?: string;
  result?: {
    payloads?: GatewayAgentPayload[];
  };
};

type ParsedTeacherFeedbackOutput = {
  sourceArtifact: string;
  teacherModel: string;
  critiqueType: (typeof FINANCE_DOCTRINE_TEACHER_CRITIQUE_TYPES)[number];
  critiqueText: string;
  suggestedCandidateText: string;
  evidenceNeeded: string;
  riskOfAdopting: string;
  recommendedNextAction: string;
};

type TeacherModelRun = {
  model: string;
  rawText: string;
};

function assertDateKey(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new ToolInputError("dateKey must be YYYY-MM-DD");
  }
  return normalized;
}

function pickGatewayText(response: GatewayAgentResponse): string {
  const texts =
    response.result?.payloads
      ?.map((payload) => payload.text?.trim())
      .filter((value): value is string => Boolean(value)) ?? [];
  if (texts.length > 0) {
    return texts.join("\n\n").trim();
  }
  return response.summary?.trim() ?? "";
}

function resolveTeacherFeedbackModel(): string {
  return process.env.OPENCLAW_FINANCE_TEACHER_FEEDBACK_MODEL?.trim() || "openai/gpt-5.2";
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("empty JSON response");
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("no JSON object found");
    }
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  }
}

function parseTeacherFeedbackOutput(text: string): ParsedTeacherFeedbackOutput {
  const parsed = parseJsonObject(text) as {
    source_artifact?: unknown;
    sourceArtifact?: unknown;
    teacher_model?: unknown;
    teacherModel?: unknown;
    critique_type?: unknown;
    critiqueType?: unknown;
    critique_text?: unknown;
    critiqueText?: unknown;
    suggested_candidate_text?: unknown;
    suggestedCandidateText?: unknown;
    evidence_needed?: unknown;
    evidenceNeeded?: unknown;
    risk_of_adopting?: unknown;
    riskOfAdopting?: unknown;
    recommended_next_action?: unknown;
    recommendedNextAction?: unknown;
  };
  const sourceArtifact =
    typeof (parsed.sourceArtifact ?? parsed.source_artifact) === "string"
      ? String(parsed.sourceArtifact ?? parsed.source_artifact).trim()
      : "";
  const teacherModel =
    typeof (parsed.teacherModel ?? parsed.teacher_model) === "string"
      ? String(parsed.teacherModel ?? parsed.teacher_model).trim()
      : "";
  const critiqueTypeRaw =
    typeof (parsed.critiqueType ?? parsed.critique_type) === "string"
      ? String(parsed.critiqueType ?? parsed.critique_type).trim()
      : "";
  const critiqueType = FINANCE_DOCTRINE_TEACHER_CRITIQUE_TYPES.includes(
    critiqueTypeRaw as (typeof FINANCE_DOCTRINE_TEACHER_CRITIQUE_TYPES)[number],
  )
    ? (critiqueTypeRaw as (typeof FINANCE_DOCTRINE_TEACHER_CRITIQUE_TYPES)[number])
    : undefined;
  const critiqueText =
    typeof (parsed.critiqueText ?? parsed.critique_text) === "string"
      ? String(parsed.critiqueText ?? parsed.critique_text).trim()
      : "";
  const suggestedCandidateText =
    typeof (parsed.suggestedCandidateText ?? parsed.suggested_candidate_text) === "string"
      ? String(parsed.suggestedCandidateText ?? parsed.suggested_candidate_text).trim()
      : "";
  const evidenceNeeded =
    typeof (parsed.evidenceNeeded ?? parsed.evidence_needed) === "string"
      ? String(parsed.evidenceNeeded ?? parsed.evidence_needed).trim()
      : "";
  const riskOfAdopting =
    typeof (parsed.riskOfAdopting ?? parsed.risk_of_adopting) === "string"
      ? String(parsed.riskOfAdopting ?? parsed.risk_of_adopting).trim()
      : "";
  const recommendedNextAction =
    typeof (parsed.recommendedNextAction ?? parsed.recommended_next_action) === "string"
      ? String(parsed.recommendedNextAction ?? parsed.recommended_next_action).trim()
      : "";
  if (
    !sourceArtifact ||
    !teacherModel ||
    !critiqueType ||
    !critiqueText ||
    !suggestedCandidateText ||
    !evidenceNeeded ||
    !riskOfAdopting ||
    !recommendedNextAction
  ) {
    throw new Error("invalid teacher feedback output");
  }
  return {
    sourceArtifact,
    teacherModel,
    critiqueType,
    critiqueText,
    suggestedCandidateText,
    evidenceNeeded,
    riskOfAdopting,
    recommendedNextAction,
  };
}

function buildFeedbackId(sourceArtifact: string, critiqueType: string): string {
  const sourceSlug = path.posix
    .basename(sourceArtifact, ".md")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `finance-teacher-feedback-${sourceSlug || "artifact"}-${critiqueType}`;
}

function normalizeRelativeReceiptPath(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/gu, "/").trim());
  if (
    !normalized ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized.startsWith("/")
  ) {
    throw new ToolInputError(
      "sourceArtifact must be a repo-relative path under memory/feishu-work-receipts",
    );
  }
  return normalized;
}

function buildTeacherPrompt(params: {
  sourceArtifact: string;
  teacherModel: string;
  calibrationContent: string;
  linkedReceiptPath: string;
  linkedReceiptContent: string;
}): string {
  return [
    "You are a bounded teacher model auditing one finance doctrine calibration artifact.",
    "You are not allowed to promote doctrine, mutate doctrine cards, or claim adoption.",
    "Pick exactly one highest-leverage critique only.",
    "Allowed critique_type values:",
    FINANCE_DOCTRINE_TEACHER_CRITIQUE_TYPES.map((item) => `- ${item}`).join("\n"),
    "Focus areas:",
    "- missing causal chain",
    "- overconfident conviction",
    "- missing bear case",
    "- weak no-action justification",
    "- weak options/ETF instrument choice",
    "- weak risk gate",
    "Return JSON only. No markdown. Schema:",
    `{
  "source_artifact": "${params.sourceArtifact}",
  "teacher_model": "${params.teacherModel}",
  "critique_type": "missing_causal_chain|overconfident_conviction|missing_bear_case|weak_no_action_justification|weak_instrument_choice|weak_risk_gate",
  "critique_text": "one concise critique",
  "suggested_candidate_text": "one concise candidate-evidence line for later governance review",
  "evidence_needed": "what evidence would be needed before adoption",
  "risk_of_adopting": "what could go wrong if this critique were promoted too early",
  "recommended_next_action": "one bounded next action"
}`,
    "Rules:",
    "- teacher feedback is candidate evidence only, not truth",
    "- suggested_candidate_text must stay bounded and promotion-candidate-like, not doctrine text",
    "- if the artifact is already strong, choose the single weakest remaining gap rather than inventing novelty",
    "",
    "Calibration artifact:",
    params.calibrationContent,
    "",
    `Linked receipt (${params.linkedReceiptPath}):`,
    params.linkedReceiptContent,
  ].join("\n");
}

async function runTeacherModel(params: {
  cfg?: OpenClawConfig;
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
  userMessage: string;
  extraSystemPrompt: string;
}): Promise<TeacherModelRun> {
  const model = resolveTeacherFeedbackModel();
  const routeAgentId =
    params.requesterAgentIdOverride?.trim() ||
    resolveSessionAgentId({ sessionKey: params.agentSessionKey, config: params.cfg });
  const response = await callGateway<GatewayAgentResponse>({
    method: "agent",
    params: {
      message: params.userMessage,
      agentId: routeAgentId,
      sessionKey: `${params.agentSessionKey ?? "agent:main:main"}:finance-teacher-feedback`,
      model,
      thinking: "medium",
      timeout: 90,
      lane: "finance-teacher-feedback",
      extraSystemPrompt: params.extraSystemPrompt,
      idempotencyKey: randomIdempotencyKey(),
      label: "Finance Teacher Feedback",
    },
    expectFinal: true,
    timeoutMs: 135_000,
    config: params.cfg,
  });
  return {
    model,
    rawText: pickGatewayText(response),
  };
}

export function createFinanceDoctrineTeacherFeedbackTool(options?: {
  workspaceDir?: string;
  config?: OpenClawConfig;
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
  runTeacherModel?: (params: {
    userMessage: string;
    extraSystemPrompt: string;
  }) => Promise<TeacherModelRun>;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Doctrine Teacher Feedback",
    name: "finance_doctrine_teacher_feedback",
    description:
      "Audit one same-day finance doctrine calibration artifact through a bounded teacher model and write structured critique as candidate evidence only. This does not promote doctrine or mutate doctrine cards.",
    parameters: FinanceDoctrineTeacherFeedbackSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const dateKey = assertDateKey(readStringParam(params, "dateKey", { required: true }));
      const sourceArtifact = normalizeRelativeReceiptPath(
        readStringParam(params, "sourceArtifact", { required: true }),
      );
      if (!sourceArtifact.startsWith("memory/feishu-work-receipts/")) {
        throw new ToolInputError(
          "sourceArtifact must be under memory/feishu-work-receipts for finance_doctrine_teacher_feedback",
        );
      }

      const parsedSourceFilename = parseFeishuFinanceDoctrineCalibrationFilename(
        path.posix.basename(sourceArtifact),
      );
      if (!parsedSourceFilename) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "unsupported_source_artifact",
          dateKey,
          sourceArtifact,
          action:
            "Use a same-day finance doctrine calibration artifact as the teacher-feedback source for this bounded v1 loop.",
        });
      }
      if (parsedSourceFilename.dateStr !== dateKey) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "source_artifact_date_mismatch",
          dateKey,
          sourceArtifact,
          sourceArtifactDate: parsedSourceFilename.dateStr,
          action:
            "Use a same-day finance doctrine calibration artifact whose date matches the requested dateKey.",
        });
      }

      const sourceAbsPath = path.join(workspaceDir, sourceArtifact);
      let calibrationContent: string;
      try {
        calibrationContent = await fs.readFile(sourceAbsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "source_artifact_missing",
            dateKey,
            sourceArtifact,
            action:
              "Restore the same-day finance doctrine calibration artifact before retrying finance_doctrine_teacher_feedback.",
          });
        }
        throw error;
      }
      const parsedCalibration = parseFeishuFinanceDoctrineCalibrationArtifact(calibrationContent);
      if (!parsedCalibration) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "source_artifact_malformed",
          dateKey,
          sourceArtifact,
          action:
            "Repair or archive the malformed finance doctrine calibration artifact before retrying finance_doctrine_teacher_feedback.",
        });
      }

      const linkedReceiptPath = normalizeRelativeReceiptPath(parsedCalibration.linkedReceipt);
      const linkedReceiptAbsPath = path.join(workspaceDir, linkedReceiptPath);
      let linkedReceiptContent: string;
      try {
        linkedReceiptContent = await fs.readFile(linkedReceiptAbsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "linked_receipt_missing",
            dateKey,
            sourceArtifact,
            linkedReceipt: linkedReceiptPath,
            action:
              "Restore the linked finance doctrine proof receipt before retrying finance_doctrine_teacher_feedback.",
          });
        }
        throw error;
      }
      const parsedReceipt = parseFeishuWorkReceiptArtifact(linkedReceiptContent);
      if (!parsedReceipt) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "linked_receipt_malformed",
          dateKey,
          sourceArtifact,
          linkedReceipt: linkedReceiptPath,
          action:
            "Repair or archive the malformed linked finance doctrine proof receipt before retrying finance_doctrine_teacher_feedback.",
        });
      }

      const teacherModel = resolveTeacherFeedbackModel();
      const extraSystemPrompt = buildTeacherPrompt({
        sourceArtifact,
        teacherModel,
        calibrationContent,
        linkedReceiptPath,
        linkedReceiptContent,
      });

      let teacherRun: TeacherModelRun;
      try {
        teacherRun = options?.runTeacherModel
          ? await options.runTeacherModel({
              userMessage: `Audit the finance calibration artifact ${sourceArtifact} and return the requested JSON only.`,
              extraSystemPrompt,
            })
          : await runTeacherModel({
              cfg: options?.config,
              agentSessionKey: options?.agentSessionKey,
              requesterAgentIdOverride: options?.requesterAgentIdOverride,
              userMessage: `Audit the finance calibration artifact ${sourceArtifact} and return the requested JSON only.`,
              extraSystemPrompt,
            });
      } catch (error) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_runtime_failed",
          dateKey,
          sourceArtifact,
          teacherModel,
          error: String(error),
          action:
            "Repair the bounded teacher runtime before retrying finance_doctrine_teacher_feedback. No doctrine or promotion state has changed.",
        });
      }

      let parsedFeedback: ParsedTeacherFeedbackOutput;
      try {
        parsedFeedback = parseTeacherFeedbackOutput(teacherRun.rawText);
      } catch {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_output_malformed",
          dateKey,
          sourceArtifact,
          teacherModel: teacherRun.model,
          rawText: teacherRun.rawText,
          action:
            "Repair the teacher prompt or model output shape before retrying finance_doctrine_teacher_feedback.",
        });
      }

      if (parsedFeedback.sourceArtifact !== sourceArtifact) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_output_source_mismatch",
          dateKey,
          sourceArtifact,
          teacherOutputSourceArtifact: parsedFeedback.sourceArtifact,
          teacherModel: teacherRun.model,
          action:
            "Retry only after the teacher output echoes the exact source_artifact path being audited.",
        });
      }
      if (parsedFeedback.teacherModel !== teacherRun.model) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "teacher_output_model_mismatch",
          dateKey,
          sourceArtifact,
          teacherModel: teacherRun.model,
          teacherOutputTeacherModel: parsedFeedback.teacherModel,
          action:
            "Retry only after the teacher output echoes the exact teacher_model used for this audit.",
        });
      }

      const feedbackRelPath = path.posix.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrineTeacherFeedbackFilename(dateKey),
      );
      const feedbackAbsPath = path.join(workspaceDir, feedbackRelPath);
      let parsedArtifact = undefined as
        | ReturnType<typeof parseFeishuFinanceDoctrineTeacherFeedbackArtifact>
        | undefined;
      try {
        parsedArtifact = parseFeishuFinanceDoctrineTeacherFeedbackArtifact(
          await fs.readFile(feedbackAbsPath, "utf8"),
        );
        if (!parsedArtifact) {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "teacher_feedback_artifact_malformed",
            dateKey,
            sourceArtifact,
            teacherFeedbackPath: feedbackRelPath,
            action:
              "Repair or archive the malformed finance teacher-feedback artifact before retrying finance_doctrine_teacher_feedback.",
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      const feedbackId = buildFeedbackId(sourceArtifact, parsedFeedback.critiqueType);
      const feedbackBySourceArtifact = new Map(
        parsedArtifact?.feedbacks.map((feedback) => [feedback.sourceArtifact, feedback]) ?? [],
      );
      feedbackBySourceArtifact.set(sourceArtifact, {
        feedbackId,
        sourceArtifact,
        teacherModel: teacherRun.model,
        critiqueType: parsedFeedback.critiqueType,
        critiqueText: parsedFeedback.critiqueText,
        suggestedCandidateText: parsedFeedback.suggestedCandidateText,
        evidenceNeeded: parsedFeedback.evidenceNeeded,
        riskOfAdopting: parsedFeedback.riskOfAdopting,
        recommendedNextAction: parsedFeedback.recommendedNextAction,
      });

      await fs.mkdir(path.dirname(feedbackAbsPath), { recursive: true });
      await fs.writeFile(
        feedbackAbsPath,
        renderFeishuFinanceDoctrineTeacherFeedbackArtifact({
          generatedAt: new Date().toISOString(),
          teacherTask: "finance_calibration_audit",
          feedbacks: Array.from(feedbackBySourceArtifact.values()).toSorted((left, right) =>
            left.sourceArtifact.localeCompare(right.sourceArtifact),
          ),
        }),
        "utf8",
      );

      return jsonResult({
        ok: true,
        updated: true,
        dateKey,
        sourceArtifact,
        linkedReceipt: linkedReceiptPath,
        teacherModel: teacherRun.model,
        critiqueType: parsedFeedback.critiqueType,
        feedbackId,
        teacherFeedbackPath: feedbackRelPath,
        action:
          "This writes bounded teacher feedback as candidate evidence only. It does not adopt knowledge, does not promote doctrine, and does not mutate doctrine cards automatically.",
      });
    },
  };
}
