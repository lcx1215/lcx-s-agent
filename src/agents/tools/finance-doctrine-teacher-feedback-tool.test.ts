import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFeishuFinanceDoctrineTeacherFeedbackFilename,
  parseFeishuFinanceDoctrineTeacherFeedbackArtifact,
  renderFeishuFinanceDoctrineCalibrationArtifact,
  renderFeishuWorkReceiptArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { makeTempWorkspace } from "../../test-helpers/workspace.js";
import { createFinanceDoctrineTeacherFeedbackTool } from "./finance-doctrine-teacher-feedback-tool.js";

describe("finance_doctrine_teacher_feedback tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  async function seedCalibrationSource(dateKey: string) {
    const receiptsDir = path.join(workspaceDir!, "memory", "feishu-work-receipts");
    const doctrineDir = path.join(workspaceDir!, "memory", "local-memory");
    await fs.mkdir(receiptsDir, { recursive: true });
    await fs.mkdir(doctrineDir, { recursive: true });
    await fs.writeFile(
      path.join(doctrineDir, "holding-holdings-thesis-revalidation.md"),
      "# Local Memory Card\n\n- subject: Holdings thesis revalidation\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(receiptsDir, `${dateKey}-feishu-work-receipt-183000-000Z-control-room-msg-1.md`),
      renderFeishuWorkReceiptArtifact({
        handledAt: "2026-03-25T18:30:00.000Z",
        surface: "control_room",
        chatId: "chat-1",
        sessionKey: "agent:main:feishu:control_room",
        messageId: "msg-1",
        userMessage: "Revalidate the current holdings thesis.",
        requestedAction: "holdings thesis revalidation",
        scope: "current holding thesis",
        timeframe: "same-day",
        outputShape: "discipline checklist",
        repairDisposition: "none",
        readPathLines: [
          "memory/current-research-line.md",
          "memory/local-memory/holding-holdings-thesis-revalidation.md",
        ],
        finalReplySummary: "Bounded finance doctrine reply with revalidation fields.",
        financeDoctrineProof: {
          consumer: "holdings_thesis_revalidation",
          doctrineFieldsUsed: [
            "base_case",
            "bear_case",
            "what_changes_my_mind",
            "why_no_action_may_be_better",
          ],
          outputEvidenceLines: [
            "Base case: rates ease and breadth improves.",
            "Bear case: rates stay higher for longer and valuation compresses.",
          ],
          proves: "the retained reply exposed the doctrine-labeled fields",
          doesNotProve: "the scenario framing is economically correct",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(
        receiptsDir,
        `${dateKey}-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md`,
      ),
      renderFeishuFinanceDoctrineCalibrationArtifact({
        reviewDate: "2026-03-25T19:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        linkedReceipt:
          "memory/feishu-work-receipts/2026-03-25-feishu-work-receipt-183000-000Z-control-room-msg-1.md",
        observedOutcome: "price was flat while breadth stayed weak",
        scenarioClosestToOutcome: "unclear",
        baseCaseDirectionallyCloser: "unclear",
        changeMyMindTriggered: "no",
        convictionLooksTooHighOrLow: "too_high",
        notes:
          "derived from later holdings_thesis_revalidation reply in retained finance doctrine review",
      }),
      "utf8",
    );
  }

  it("writes bounded teacher feedback for one calibration artifact", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-feedback-");
    const dateKey = "2026-03-25";
    const sourceArtifact =
      "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md";
    await seedCalibrationSource(dateKey);
    const doctrineCardPath = path.join(
      workspaceDir,
      "memory",
      "local-memory",
      "holding-holdings-thesis-revalidation.md",
    );
    const doctrineCardBefore = await fs.readFile(doctrineCardPath, "utf8");

    const tool = createFinanceDoctrineTeacherFeedbackTool({
      workspaceDir,
      runTeacherModel: async () => ({
        model: "openai/gpt-5.2",
        rawText: JSON.stringify({
          source_artifact: sourceArtifact,
          teacher_model: "openai/gpt-5.2",
          critique_type: "overconfident_conviction",
          critique_text:
            "The calibration artifact admits conviction looked too high but does not explain what hard evidence would have lowered conviction sooner.",
          suggested_candidate_text:
            "teacher critique: holdings_thesis_revalidation calibration repeatedly flags conviction as too high without a concrete earlier-de-risk trigger",
          evidence_needed:
            "Need repeated later calibration notes showing the same missing trigger degrades decision quality.",
          risk_of_adopting:
            "Could hard-code de-risking language too early and reduce flexibility in ambiguous regimes.",
          recommended_next_action:
            "Inspect adjacent calibration artifacts and only promote this critique if the missing trigger repeats.",
        }),
      }),
    });

    const result = await tool.execute("finance-doctrine-teacher-feedback", {
      dateKey,
      sourceArtifact,
    });

    expect(result.details).toEqual({
      ok: true,
      updated: true,
      dateKey,
      sourceArtifact,
      linkedReceipt:
        "memory/feishu-work-receipts/2026-03-25-feishu-work-receipt-183000-000Z-control-room-msg-1.md",
      teacherModel: "openai/gpt-5.2",
      critiqueType: "overconfident_conviction",
      feedbackId:
        "finance-teacher-feedback-2026-03-25-feishu-finance-doctrine-calibration-190000-000z-control-room-msg-1-overconfident_conviction",
      teacherFeedbackPath:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-teacher-feedback.md",
      action:
        "This writes bounded teacher feedback as candidate evidence only. It does not adopt knowledge, does not promote doctrine, and does not mutate doctrine cards automatically.",
    });

    const parsed = parseFeishuFinanceDoctrineTeacherFeedbackArtifact(
      await fs.readFile(
        path.join(
          workspaceDir,
          "memory",
          "feishu-work-receipts",
          buildFeishuFinanceDoctrineTeacherFeedbackFilename(dateKey),
        ),
        "utf8",
      ),
    );
    expect(parsed?.feedbacks).toEqual([
      expect.objectContaining({
        sourceArtifact,
        teacherModel: "openai/gpt-5.2",
        critiqueType: "overconfident_conviction",
      }),
    ]);
    expect(await fs.readFile(doctrineCardPath, "utf8")).toBe(doctrineCardBefore);
  });

  it("fails closed on malformed teacher output", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-feedback-");
    const dateKey = "2026-03-25";
    const sourceArtifact =
      "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md";
    await seedCalibrationSource(dateKey);

    const tool = createFinanceDoctrineTeacherFeedbackTool({
      workspaceDir,
      runTeacherModel: async () => ({
        model: "openai/gpt-5.2",
        rawText: '{"bad":"shape"}',
      }),
    });

    const result = await tool.execute("finance-doctrine-teacher-feedback-bad-output", {
      dateKey,
      sourceArtifact,
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "teacher_output_malformed",
      dateKey,
      sourceArtifact,
      teacherModel: "openai/gpt-5.2",
      rawText: '{"bad":"shape"}',
      action:
        "Repair the teacher prompt or model output shape before retrying finance_doctrine_teacher_feedback.",
    });
  });

  it("fails closed when the linked receipt is missing", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-finance-teacher-feedback-");
    const dateKey = "2026-03-25";
    const sourceArtifact =
      "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-calibration-190000-000Z-control-room-msg-1.md";
    await seedCalibrationSource(dateKey);
    await fs.rm(
      path.join(
        workspaceDir,
        "memory",
        "feishu-work-receipts",
        "2026-03-25-feishu-work-receipt-183000-000Z-control-room-msg-1.md",
      ),
      { force: true },
    );

    const tool = createFinanceDoctrineTeacherFeedbackTool({
      workspaceDir,
      runTeacherModel: async () => {
        throw new Error("should not run teacher");
      },
    });

    const result = await tool.execute("finance-doctrine-teacher-feedback-missing-link", {
      dateKey,
      sourceArtifact,
    });

    expect(result.details).toEqual({
      ok: false,
      updated: false,
      reason: "linked_receipt_missing",
      dateKey,
      sourceArtifact,
      linkedReceipt:
        "memory/feishu-work-receipts/2026-03-25-feishu-work-receipt-183000-000Z-control-room-msg-1.md",
      action:
        "Restore the linked finance doctrine proof receipt before retrying finance_doctrine_teacher_feedback.",
    });
  });
});
