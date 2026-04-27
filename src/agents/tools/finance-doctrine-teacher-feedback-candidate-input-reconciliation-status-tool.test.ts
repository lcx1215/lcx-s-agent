import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFeishuFinanceDoctrineTeacherCandidateInputReconciliationFilename,
  parseFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact,
  renderFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinanceDoctrineTeacherFeedbackCandidateInputReconciliationStatusTool } from "./finance-doctrine-teacher-feedback-candidate-input-reconciliation-status-tool.js";

describe("finance_doctrine_teacher_feedback_candidate_input_reconciliation_status tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  async function seedReconciliation(
    status:
      | "open"
      | "linked_to_existing_candidate"
      | "created_as_new_candidate_reference"
      | "rejected_before_reconciliation"
      | "superseded" = "open",
  ) {
    const receiptsDir = path.join(workspaceDir!, "memory", "feishu-work-receipts");
    await fs.mkdir(receiptsDir, { recursive: true });
    const dateKey = "2026-04-16";
    const reconciliationId =
      "finance-teacher-candidate-input-reconciliation-2026-04-16-finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1";
    await fs.writeFile(
      path.join(
        receiptsDir,
        buildFeishuFinanceDoctrineTeacherCandidateInputReconciliationFilename(dateKey),
      ),
      renderFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact({
        reconciledAt: "2026-04-16T23:55:00.000Z",
        sourceTeacherCandidateInputArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md",
        sourceTeacherCandidateInputReviewArtifact:
          "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-input-review.md",
        reconciliations: [
          {
            reconciliationId,
            sourceTeacherCandidateInputArtifact:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-inputs.md",
            sourceTeacherCandidateInputReviewArtifact:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-input-review.md",
            candidateInputId:
              "finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
            targetFinanceCandidatePath:
              "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-promotion-candidates.md",
            reconciliationMode: "link_existing_candidate",
            reconciliationNotes:
              "Keep this teacher candidate-input linked to the same-day finance candidate flow as bounded evidence only.",
            status,
          },
        ],
      }),
      "utf8",
    );
    return { dateKey, reconciliationId };
  }

  it("records a bounded status action for one open teacher candidate-input reconciliation", async () => {
    workspaceDir = await makeTempWorkspace(
      "openclaw-finance-teacher-candidate-input-reconciliation-status-",
    );
    const { dateKey, reconciliationId } = await seedReconciliation("open");
    const tool = createFinanceDoctrineTeacherFeedbackCandidateInputReconciliationStatusTool({
      workspaceDir,
    });

    const result = await tool.execute("finance-teacher-candidate-input-reconciliation-status", {
      dateKey,
      reconciliationId,
      status: "linked_to_existing_candidate",
    });

    expect(result.details).toEqual({
      ok: true,
      updated: true,
      dateKey,
      reconciliationId,
      candidateInputId:
        "finance-teacher-candidate-input-2026-04-16-finance-teacher-elevation-handoff-2026-04-16-feedback-1",
      previousStatus: "open",
      reconciliationStatus: "linked_to_existing_candidate",
      teacherCandidateInputReconciliationPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-input-reconciliation.md",
      action:
        "This records teacher candidate-input reconciliation status only. It does not create promotion candidates automatically, does not promote doctrine, and does not mutate doctrine cards automatically.",
    });

    const parsed = parseFeishuFinanceDoctrineTeacherCandidateInputReconciliationArtifact(
      await fs.readFile(
        path.join(
          workspaceDir,
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherCandidateInputReconciliationFilename(dateKey),
        ),
        "utf8",
      ),
    );
    expect(parsed?.reconciliations).toEqual([
      expect.objectContaining({
        reconciliationId,
        status: "linked_to_existing_candidate",
      }),
    ]);
  });

  it("fails closed on unknown reconciliation ids", async () => {
    workspaceDir = await makeTempWorkspace(
      "openclaw-finance-teacher-candidate-input-reconciliation-status-",
    );
    const { dateKey, reconciliationId } = await seedReconciliation("open");
    const tool = createFinanceDoctrineTeacherFeedbackCandidateInputReconciliationStatusTool({
      workspaceDir,
    });

    const result = await tool.execute(
      "finance-teacher-candidate-input-reconciliation-status-missing",
      {
        dateKey,
        reconciliationId: "reconciliation-does-not-exist",
        status: "superseded",
      },
    );

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "teacher_candidate_input_reconciliation_not_found",
      dateKey,
      reconciliationId: "reconciliation-does-not-exist",
      teacherCandidateInputReconciliationPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-input-reconciliation.md",
      availableReconciliationIds: [reconciliationId],
      action:
        "Use finance_promotion_candidates with this dateKey to inspect current teacher candidate-input reconciliation ids before retrying finance_doctrine_teacher_feedback_candidate_input_reconciliation_status.",
    });
  });

  it("fails closed on invalid reconciliation status transitions", async () => {
    workspaceDir = await makeTempWorkspace(
      "openclaw-finance-teacher-candidate-input-reconciliation-status-",
    );
    const { dateKey, reconciliationId } = await seedReconciliation(
      "created_as_new_candidate_reference",
    );
    const tool = createFinanceDoctrineTeacherFeedbackCandidateInputReconciliationStatusTool({
      workspaceDir,
    });

    const result = await tool.execute(
      "finance-teacher-candidate-input-reconciliation-status-transition",
      {
        dateKey,
        reconciliationId,
        status: "superseded",
      },
    );

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "invalid_teacher_candidate_input_reconciliation_status_transition",
      dateKey,
      reconciliationId,
      currentStatus: "created_as_new_candidate_reference",
      requestedStatus: "superseded",
      teacherCandidateInputReconciliationPath:
        "memory/feishu-work-receipts/2026-04-16-feishu-finance-doctrine-teacher-candidate-input-reconciliation.md",
      action:
        "Only teacher candidate-input reconciliations still in open status can be marked linked_to_existing_candidate, created_as_new_candidate_reference, rejected_before_reconciliation, or superseded.",
    });
  });
});
