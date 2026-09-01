import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExternalFinanceDoctrineTeacherCandidateInputReconciliationFilename,
  buildExternalFinanceDoctrineTeacherCandidateInputReviewFilename,
  buildExternalFinanceDoctrineTeacherCandidateInputsFilename,
  parseExternalFinanceDoctrineTeacherCandidateInputReconciliationArtifact,
  renderExternalFinanceDoctrineTeacherCandidateInputArtifact,
  renderExternalFinanceDoctrineTeacherCandidateInputReviewArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinanceDoctrineTeacherFeedbackCandidateInputReconciliationTool } from "./finance-doctrine-teacher-feedback-candidate-input-reconciliation-tool.js";

describe("finance_doctrine_teacher_feedback_candidate_input_reconciliation tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  async function seedCandidateInput(reviewOutcome: "consumed_into_candidate_flow" | "superseded") {
    const receiptsDir = path.join(workspaceDir!, "memory", "external-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-04-16";
    const candidateInputId =
      "finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1";
    await fs.writeFile(
      path.join(receiptsDir, buildExternalFinanceDoctrineTeacherCandidateInputsFilename(dateKey)),
      renderExternalFinanceDoctrineTeacherCandidateInputArtifact({
        createdAt: "2026-04-16T23:10:00.000Z",
        sourceTeacherElevationHandoffArtifact:
          "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-elevation-handoffs.md",
        sourceTeacherFeedbackArtifact:
          "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-feedback.md",
        sourceTeacherReviewArtifact:
          "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-review.md",
        candidateInputs: [
          {
            candidateInputId,
            handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            feedbackId: "feedback-1",
            critiqueType: "missing_causal_chain",
            critiqueText: "The calibration artifact omits the rates-to-index causal chain.",
            suggestedCandidateText:
              "teacher critique: make the rates-to-index transmission explicit before leaning on conviction",
            evidenceNeeded:
              "Need repeated calibration artifacts showing the same omitted chain weakens later review quality.",
            riskOfAdopting: "Could overcorrect into boilerplate macro narration.",
            targetGovernancePath:
              "memory/external-work-receipts/2026-04-16-external-finance-doctrine-promotion-candidates.md",
            operatorNextAction:
              "Review this converted teacher critique against the same-day finance governance candidate flow before any later governance action.",
          },
        ],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(
        receiptsDir,
        buildExternalFinanceDoctrineTeacherCandidateInputReviewFilename(dateKey),
      ),
      renderExternalFinanceDoctrineTeacherCandidateInputReviewArtifact({
        reviewedAt: "2026-04-16T23:40:00.000Z",
        sourceTeacherCandidateInputArtifact:
          "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-candidate-inputs.md",
        reviews: [
          {
            candidateInputId,
            handoffId: "finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            feedbackId: "feedback-1",
            targetGovernancePath:
              "memory/external-work-receipts/2026-04-16-external-finance-doctrine-promotion-candidates.md",
            reviewOutcome,
          },
        ],
      }),
      "utf8",
    );
    return { dateKey, candidateInputId };
  }

  it("creates a durable finance-candidate reconciliation artifact from a consumed teacher candidate-input", async () => {
    workspaceDir = await makeTempWorkspace(
      "openclaw-finance-teacher-candidate-input-reconciliation-",
    );
    const { dateKey, candidateInputId } = await seedCandidateInput("consumed_into_candidate_flow");
    const tool = createFinanceDoctrineTeacherFeedbackCandidateInputReconciliationTool({
      workspaceDir,
    });

    const result = await tool.execute("finance-teacher-candidate-input-reconciliation", {
      dateKey,
      candidateInputId,
      reconciliationMode: "link_existing_candidate",
      reconciliationNotes:
        "Keep this teacher input attached to the same-day finance candidate flow as explicit candidate evidence only.",
    });

    expect(result.details).toEqual({
      ok: true,
      updated: true,
      dateKey,
      candidateInputId,
      reconciliationId:
        "finance-teacher-candidate-input-reconciliation-2026-04-16-finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
      targetFinanceCandidatePath:
        "memory/external-work-receipts/2026-04-16-external-finance-doctrine-promotion-candidates.md",
      reconciliationMode: "link_existing_candidate",
      reconciliationNotes:
        "Keep this teacher input attached to the same-day finance candidate flow as explicit candidate evidence only.",
      status: "open",
      teacherCandidateInputPath:
        "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-candidate-inputs.md",
      teacherCandidateInputReviewPath:
        "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-candidate-input-review.md",
      teacherCandidateInputReconciliationPath:
        "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-candidate-input-reconciliation.md",
      action:
        "This creates a bounded finance-candidate reconciliation artifact only. It does not create promotion candidates automatically, does not promote doctrine, and does not mutate doctrine cards automatically.",
    });

    const parsed = parseExternalFinanceDoctrineTeacherCandidateInputReconciliationArtifact(
      await fs.readFile(
        path.join(
          workspaceDir,
          "memory",
          "external-work-receipts",
          buildExternalFinanceDoctrineTeacherCandidateInputReconciliationFilename(dateKey),
        ),
        "utf8",
      ),
    );
    expect(parsed?.reconciliations).toEqual([
      expect.objectContaining({
        candidateInputId,
        reconciliationMode: "link_existing_candidate",
        status: "open",
      }),
    ]);
  });

  it("fails closed on non-consumed teacher candidate-input review state", async () => {
    workspaceDir = await makeTempWorkspace(
      "openclaw-finance-teacher-candidate-input-reconciliation-",
    );
    const { dateKey, candidateInputId } = await seedCandidateInput("superseded");
    const tool = createFinanceDoctrineTeacherFeedbackCandidateInputReconciliationTool({
      workspaceDir,
    });

    const result = await tool.execute("finance-teacher-candidate-input-reconciliation-open", {
      dateKey,
      candidateInputId,
      reconciliationMode: "new_candidate_reference",
      reconciliationNotes: "This should fail because the candidate input was not consumed.",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "teacher_candidate_input_not_consumed",
      dateKey,
      candidateInputId,
      teacherCandidateInputPath:
        "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-candidate-inputs.md",
      teacherCandidateInputReviewPath:
        "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-candidate-input-review.md",
      reviewOutcome: "superseded",
      action:
        "Only teacher candidate-input artifacts already marked consumed_into_candidate_flow can create a finance-candidate reconciliation artifact.",
    });
  });

  it("fails closed on unknown candidateInputId values", async () => {
    workspaceDir = await makeTempWorkspace(
      "openclaw-finance-teacher-candidate-input-reconciliation-",
    );
    const { dateKey, candidateInputId } = await seedCandidateInput("consumed_into_candidate_flow");
    const tool = createFinanceDoctrineTeacherFeedbackCandidateInputReconciliationTool({
      workspaceDir,
    });

    const result = await tool.execute("finance-teacher-candidate-input-reconciliation-missing", {
      dateKey,
      candidateInputId: "candidate-input-does-not-exist",
      reconciliationMode: "link_existing_candidate",
      reconciliationNotes: "Need to reconcile a specific teacher input into the candidate flow.",
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "teacher_candidate_input_not_found",
      dateKey,
      candidateInputId: "candidate-input-does-not-exist",
      teacherCandidateInputPath:
        "memory/external-work-receipts/2026-04-16-external-finance-doctrine-teacher-candidate-inputs.md",
      availableCandidateInputIds: [candidateInputId],
      action:
        "Use finance_promotion_candidates with this dateKey to inspect current teacher candidate-input ids before retrying finance_doctrine_teacher_feedback_candidate_input_reconciliation.",
    });
  });
});
