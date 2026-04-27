import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFeishuFinanceDoctrinePromotionCandidatesFilename,
  buildFeishuFinanceDoctrinePromotionDecisionsFilename,
  buildFeishuFinanceDoctrinePromotionReviewFilename,
  parseFeishuFinanceDoctrinePromotionCandidateArtifact,
  parseFeishuFinanceDoctrinePromotionDecisionArtifact,
  parseFeishuFinanceDoctrinePromotionReviewArtifact,
  renderFeishuFinanceDoctrinePromotionDecisionArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const FINANCE_PROMOTION_DECISION_OUTCOMES = [
  "proposal_created",
  "deferred_after_promotion_review",
  "rejected_after_promotion_review",
] as const;

const FinancePromotionDecisionSchema = Type.Object({
  dateKey: Type.String(),
  candidateKey: Type.String(),
  decision: stringEnum(FINANCE_PROMOTION_DECISION_OUTCOMES),
  decisionNotes: Type.Optional(Type.String()),
});

function assertDateKey(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw new ToolInputError("dateKey must be YYYY-MM-DD");
  }
  return normalized;
}

function normalizeOptionalText(value?: string): string | undefined {
  const normalized = value?.trim().replace(/\r\n/g, "\n");
  return normalized ? normalized : undefined;
}

export function createFinancePromotionDecisionTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Promotion Decision",
    name: "finance_promotion_decision",
    description:
      "Record a bounded manual promotion decision for one same-day finance promotion candidate that is already marked ready_for_manual_promotion. This writes a durable promotion-decision artifact and does not promote doctrine automatically.",
    parameters: FinancePromotionDecisionSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const dateKey = assertDateKey(readStringParam(params, "dateKey", { required: true }));
      const candidateKey = readStringParam(params, "candidateKey", { required: true });
      const decision = readStringParam(params, "decision", { required: true }) as
        | (typeof FINANCE_PROMOTION_DECISION_OUTCOMES)[number]
        | undefined;
      const decisionNotes = normalizeOptionalText(readStringParam(params, "decisionNotes"));
      if (!decision || !FINANCE_PROMOTION_DECISION_OUTCOMES.includes(decision)) {
        throw new ToolInputError(
          `decision must be one of: ${FINANCE_PROMOTION_DECISION_OUTCOMES.join(", ")}`,
        );
      }

      const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
      const candidateRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrinePromotionCandidatesFilename(dateKey),
      );
      const candidateAbsPath = path.join(workspaceDir, candidateRelPath);
      let candidateContent: string;
      try {
        candidateContent = await fs.readFile(candidateAbsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "candidate_artifact_missing",
            dateKey,
            candidateKey,
            candidatePath: candidateRelPath.replace(/\\/gu, "/"),
            action:
              "Generate the same-day finance promotion candidates first before recording a manual promotion decision.",
          });
        }
        throw error;
      }
      const parsedCandidates =
        parseFeishuFinanceDoctrinePromotionCandidateArtifact(candidateContent);
      if (!parsedCandidates) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "candidate_artifact_malformed",
          dateKey,
          candidateKey,
          candidatePath: candidateRelPath.replace(/\\/gu, "/"),
          action:
            "Repair or archive the malformed finance promotion candidate artifact before retrying finance_promotion_decision.",
        });
      }

      const candidate = parsedCandidates.candidates.find(
        (entry) => entry.candidateKey === candidateKey,
      );
      if (!candidate) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "candidate_not_found",
          dateKey,
          candidateKey,
          candidatePath: candidateRelPath.replace(/\\/gu, "/"),
          availableCandidateKeys: parsedCandidates.candidates.map((entry) => entry.candidateKey),
          action:
            "Use finance_promotion_candidates with this dateKey to discover valid same-day candidateKey values before retrying finance_promotion_decision.",
        });
      }

      const reviewRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrinePromotionReviewFilename(dateKey),
      );
      const reviewAbsPath = path.join(workspaceDir, reviewRelPath);
      let reviewContent: string;
      try {
        reviewContent = await fs.readFile(reviewAbsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "review_artifact_missing",
            dateKey,
            candidateKey,
            reviewPath: reviewRelPath.replace(/\\/gu, "/"),
            action:
              "Record the same-day finance promotion review state first before retrying finance_promotion_decision.",
          });
        }
        throw error;
      }
      const parsedReview = parseFeishuFinanceDoctrinePromotionReviewArtifact(reviewContent);
      if (!parsedReview) {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "review_artifact_malformed",
          dateKey,
          candidateKey,
          reviewPath: reviewRelPath.replace(/\\/gu, "/"),
          action:
            "Repair or archive the malformed finance promotion review artifact before retrying finance_promotion_decision.",
        });
      }

      const currentReviewState =
        parsedReview.reviews.find((entry) => entry.candidateKey === candidateKey)?.reviewState ??
        candidate.reviewState;
      if (currentReviewState !== "ready_for_manual_promotion") {
        return jsonResult({
          ok: false,
          updated: false,
          reason: "candidate_not_ready_for_manual_promotion",
          dateKey,
          candidateKey,
          currentReviewState,
          action:
            "Only candidates already marked ready_for_manual_promotion can record a bounded manual promotion decision.",
        });
      }

      const decisionRelPath = path.join(
        "memory",
        "feishu-work-receipts",
        buildFeishuFinanceDoctrinePromotionDecisionsFilename(dateKey),
      );
      const decisionAbsPath = path.join(workspaceDir, decisionRelPath);
      let parsedDecisions = undefined as
        | ReturnType<typeof parseFeishuFinanceDoctrinePromotionDecisionArtifact>
        | undefined;
      try {
        parsedDecisions = parseFeishuFinanceDoctrinePromotionDecisionArtifact(
          await fs.readFile(decisionAbsPath, "utf8"),
        );
        if (!parsedDecisions) {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "decision_artifact_malformed",
            dateKey,
            candidateKey,
            decisionPath: decisionRelPath.replace(/\\/gu, "/"),
            action:
              "Repair or archive the malformed finance promotion decision artifact before retrying finance_promotion_decision.",
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      const decisionByKey = new Map(
        parsedDecisions?.decisions.map((entry) => [entry.candidateKey, entry]) ?? [],
      );
      const previousDecision = decisionByKey.get(candidateKey);
      const nextDecisionNotes = decisionNotes ?? previousDecision?.decisionNotes;
      decisionByKey.set(candidateKey, {
        candidateKey,
        decisionOutcome: decision,
        reviewStateAtDecision: "ready_for_manual_promotion",
        decisionNotes: nextDecisionNotes,
      });

      await fs.mkdir(receiptsDir, { recursive: true });
      await fs.writeFile(
        decisionAbsPath,
        renderFeishuFinanceDoctrinePromotionDecisionArtifact({
          decidedAt: new Date().toISOString(),
          consumer: parsedDecisions?.consumer ?? parsedCandidates.consumer,
          linkedCandidateArtifact:
            parsedDecisions?.linkedCandidateArtifact ?? candidateRelPath.replace(/\\/gu, "/"),
          linkedReviewArtifact:
            parsedDecisions?.linkedReviewArtifact ?? reviewRelPath.replace(/\\/gu, "/"),
          decisions: Array.from(decisionByKey.values()).toSorted((left, right) =>
            left.candidateKey.localeCompare(right.candidateKey),
          ),
        }),
        "utf8",
      );

      return jsonResult({
        ok: true,
        updated: true,
        dateKey,
        candidateKey,
        currentReviewState,
        decisionOutcome: decision,
        previousDecisionOutcome: previousDecision?.decisionOutcome ?? null,
        decisionNotes: nextDecisionNotes ?? null,
        candidatePath: candidateRelPath.replace(/\\/gu, "/"),
        reviewPath: reviewRelPath.replace(/\\/gu, "/"),
        decisionPath: decisionRelPath.replace(/\\/gu, "/"),
        action:
          "This records a bounded manual promotion decision only. It does not promote doctrine and does not update doctrine cards automatically.",
      });
    },
  };
}
