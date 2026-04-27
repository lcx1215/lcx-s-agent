import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { createHookEvent } from "../../hooks.js";
import type { HookHandler } from "../../hooks.js";
import {
  buildFeishuFinanceDoctrineCalibrationFilename,
  buildFeishuFinanceDoctrinePromotionCandidatesFilename,
  buildFeishuFinanceDoctrinePromotionReviewFilename,
  buildFeishuWorkReceiptFilename,
  buildCorrectionNoteFilename,
  buildLearningCouncilAdoptionLedgerFilename,
  buildLearningCouncilArtifactJsonRelativePath,
  buildKnowledgeArtifactDir,
  buildLearningCouncilMemoryNoteFilename,
  buildKnowledgeValidationWeeklyArtifactFilename,
  buildOperatingWeeklyArtifactFilename,
  buildWatchtowerArtifactDir,
  renderFeishuFinanceDoctrineCalibrationArtifact,
  parseFeishuFinanceDoctrinePromotionCandidateArtifact,
  parseFeishuFinanceDoctrinePromotionReviewArtifact,
  renderFeishuFinanceDoctrinePromotionReviewArtifact,
  renderFeishuWorkReceiptArtifact,
  renderLearningCouncilAdoptionLedger,
  parseLearningCouncilAdoptionLedger,
  renderLearningCouncilRuntimeArtifact,
  renderLearningCouncilMemoryNote,
  renderKnowledgeValidationWeeklyArtifact,
  renderPortfolioAnswerScorecardArtifact,
  renderCodexEscalationArtifact,
} from "../lobster-brain-registry.js";

let handler: HookHandler;
let suiteWorkspaceRoot = "";
let workspaceCaseCounter = 0;

async function createCaseWorkspace(prefix = "case"): Promise<string> {
  const dir = path.join(suiteWorkspaceRoot, `${prefix}-${workspaceCaseCounter}`);
  workspaceCaseCounter += 1;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-operating-workface-"));
});

afterAll(async () => {
  if (!suiteWorkspaceRoot) {
    return;
  }
  await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  suiteWorkspaceRoot = "";
  workspaceCaseCounter = 0;
});

function makeConfig(tempDir: string): OpenClawConfig {
  return {
    agents: { defaults: { workspace: tempDir } },
  } satisfies OpenClawConfig;
}

async function runReset(tempDir: string, stateDir: string, isoTime = "2026-03-26T15:00:00.000Z") {
  const sessionsDir = path.join(tempDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionFile = await writeWorkspaceFile({
    dir: sessionsDir,
    name: "workface-session.jsonl",
    content: "",
  });
  const event = createHookEvent("command", "reset", "agent:main:main", {
    cfg: makeConfig(tempDir),
    previousSessionEntry: {
      sessionId: "workface-123",
      sessionFile,
    },
  });
  event.timestamp = new Date(isoTime);
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    await handler(event);
  });
}

describe("operating-daily-workface hook", () => {
  it("materializes empty work receipt index and repair queue before any receipt exists", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const stateDir = await createCaseWorkspace("state");
    const memoryDir = path.join(tempDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    await runReset(tempDir, stateDir);

    const receiptIndex = await fs.readFile(
      path.join(memoryDir, "feishu-work-receipts", "index.md"),
      "utf-8",
    );
    const repairQueue = await fs.readFile(
      path.join(memoryDir, "feishu-work-receipts", "repair-queue.md"),
      "utf-8",
    );
    expect(receiptIndex).toContain("# Feishu Work Receipt Index");
    expect(receiptIndex).toContain("- **Tracked Receipts**: 0");
    expect(receiptIndex).toContain("No Feishu work receipts are recorded yet.");
    expect(repairQueue).toContain("# Feishu Work Repair Queue");
    expect(repairQueue).toContain("- **Active Repair Clusters**: 0");
    expect(repairQueue).toContain("No repair-minded work receipts are queued right now.");
  });

  it("writes one daily workface artifact with learning, corrections, anomalies, and token usage", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const stateDir = await createCaseWorkspace("state");
    const memoryDir = path.join(tempDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-03-25-review-risk-transmission.md",
      content: [
        "# Learning Review: 2026-03-25 10:00:00 UTC",
        "",
        "- **Topic**: risk-transmission",
        "",
        "## Review Note",
        "- core_principle: trace the live driver before jumping to price commentary.",
        "",
        "## Lobster Transfer",
        "- foundation_template: risk-transmission",
        "",
      ].join("\n"),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: buildCorrectionNoteFilename({
        dateStr: "2026-03-25",
        issueKey: "issue-1",
        timeSlug: "120000-000Z",
      }),
      content: [
        "# Correction Note: 2026-03-25 12:00:00 UTC",
        "",
        "- **Issue Key**: issue-1",
        "",
        "## Foundation Template",
        "- outcome-review",
        "",
        "## What Was Wrong",
        "- confidence was too high while freshness was weak.",
        "",
      ].join("\n"),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: buildOperatingWeeklyArtifactFilename("2026-W13", "portfolio-answer-scorecard"),
      content: renderPortfolioAnswerScorecardArtifact({
        weekKey: "2026-W13",
        rangeLabel: "2026-03-23 to 2026-03-29",
        sessionKey: "agent:main:main",
        signalsReviewed: 3,
        averageScore: "3.6 / 5.0",
        dimensionScoreLines: [
          "- Wait Discipline: 3/5 (1 recent signal) - focus: say wait earlier.",
        ],
        mainFailureModeLines: [
          "- Wait Discipline: 1 recent signal pushed this below a clean answer standard.",
        ],
        nextUpgradeFocusLines: [
          "- do-now: improve wait discipline before trying to sound smarter elsewhere.",
          "- use this scorecard to judge whether Lobster is answering like a portfolio assistant or hiding behind market commentary.",
        ],
      }),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: buildKnowledgeValidationWeeklyArtifactFilename("2026-W13"),
      content: renderKnowledgeValidationWeeklyArtifact({
        weekKey: "2026-W13",
        rangeLabel: "2026-03-23 to 2026-03-29",
        sessionKey: "agent:main:main",
        validationNotes: 2,
        benchmarkNotes: 1,
        dailyRealTaskNotes: 1,
        benchmarkCoverageLines: ["- financebench_style_qa: 1 note"],
        dailyRealTaskCoverageLines: ["- position_management: 1 note"],
        capabilityCoverageLines: ["- finance: 2 notes"],
        strongestDomainLines: [
          "- bounded repair planning: factual 4.0/5, reasoning 4.0/5 (1 note)",
        ],
        weakestDomainLines: ["- position management: factual 3.0/5, reasoning 2.0/5 (1 note)"],
        hallucinationProneLines: ["- position management: 1 risky validation note"],
        correctionCandidateLines: ["- tighten source-grounded quote discipline"],
        repairTicketCandidateLines: ["- patch position-answer confidence discipline only"],
        nextValidationFocusLines: [
          "- Keep benchmark validation running so reasoning quality does not outrun factual quality.",
        ],
      }),
    });
    const surfaceLinesDir = path.join(memoryDir, "feishu-surface-lines");
    await fs.mkdir(surfaceLinesDir, { recursive: true });
    await writeWorkspaceFile({
      dir: surfaceLinesDir,
      name: "index.md",
      content: [
        "# Feishu Surface Lane Panel",
        "",
        "- **Active Lanes**: 2",
        "",
        "## Lane Meter",
        "- learning_command / oc-learning: 3 turns · session agent:main:feishu:group:oc-learning:surface:learning_command · updated 2026-03-25T16:00:00.000Z",
        "- fundamental_research / oc-fundamental: 2 turns · session agent:main:feishu:group:oc-fundamental:surface:fundamental_research · updated 2026-03-25T15:00:00.000Z",
        "",
      ].join("\n"),
    });
    const workReceiptsDir = path.join(memoryDir, "feishu-work-receipts");
    await fs.mkdir(workReceiptsDir, { recursive: true });
    await writeWorkspaceFile({
      dir: workReceiptsDir,
      name: buildFeishuWorkReceiptFilename({
        handledAt: "2026-03-25T11:00:00.000Z",
        surface: "control_room",
        messageId: "msg-work-1",
      }),
      content: renderFeishuWorkReceiptArtifact({
        handledAt: "2026-03-25T11:00:00.000Z",
        surface: "control_room",
        chatId: "oc-control-room",
        sessionKey: "agent:main:feishu:dm:oc-control-room",
        messageId: "msg-work-1",
        userMessage: "打开我的浏览器分析，然后生成几个你未来半年最看好的股票",
        requestedAction: "analyze_or_summarize",
        scope: "control_room_general",
        timeframe: "next_6_months",
        outputShape: "shortlist_with_reasons",
        repairDisposition: "none",
        readPathLines: [
          "- memory/current-research-line.md",
          "- MEMORY.md",
          "- latest carryover cue and correction notes",
        ],
        finalReplySummary: "给出未来半年最看好的几只股票和理由。",
        financeDoctrineProof: {
          consumer: "holdings_thesis_revalidation",
          doctrineFieldsUsed: [
            "base_case",
            "bear_case",
            "what_changes_my_mind",
            "why_no_action_may_be_better",
          ],
          outputEvidenceLines: [
            "Base case: 旧 thesis 还没死，但需要更保守的仓位前提。",
            "Bear case: 行业传导若继续恶化，旧逻辑会明显失真。",
            "What changes my mind: 订单和利润率同时转弱。",
            "Why no action may be better: 证据还不够支持强动作。",
          ],
          proves:
            "the captured control-room finance reply explicitly exposed the doctrine-labeled fields in the final output",
          doesNotProve:
            "the scenario framing is correct, calibrated, or economically superior; it only proves those fields appeared in the retained reply text",
        },
      }),
    });
    await writeWorkspaceFile({
      dir: workReceiptsDir,
      name: buildFeishuWorkReceiptFilename({
        handledAt: "2026-03-25T11:30:00.000Z",
        surface: "control_room",
        messageId: "msg-work-repair-1",
      }),
      content: renderFeishuWorkReceiptArtifact({
        handledAt: "2026-03-25T11:30:00.000Z",
        surface: "control_room",
        chatId: "oc-control-room",
        sessionKey: "agent:main:feishu:dm:oc-control-room",
        messageId: "msg-work-repair-1",
        userMessage: "你刚才那段还是词不达意。我让你先说动作和范围，不是直接重写长文。",
        requestedAction: "repair_previous_answer",
        scope: "answer_repair",
        timeframe: "today_or_immediate",
        outputShape: "correction_note",
        repairDisposition: "correction_loop",
        readPathLines: [
          "- recent correction notes or correction-loop receipts",
          "- memory/current-research-line.md",
          "- matching memory/local-memory/*.md durable cards",
        ],
        finalReplySummary: "先承认答偏，再按动作和范围重答。",
      }),
    });
    await writeWorkspaceFile({
      dir: workReceiptsDir,
      name: buildFeishuFinanceDoctrineCalibrationFilename({
        reviewDate: "2026-03-25T14:30:00.000Z",
        consumer: "holdings_thesis_revalidation",
        linkedReceipt: "2026-03-25-feishu-work-receipt-110000-000Z-control_room-msg-work-1.md",
      }),
      content: renderFeishuFinanceDoctrineCalibrationArtifact({
        reviewDate: "2026-03-25T14:30:00.000Z",
        consumer: "holdings_thesis_revalidation",
        linkedReceipt:
          "memory/feishu-work-receipts/2026-03-25-feishu-work-receipt-110000-000Z-control_room-msg-work-1.md",
        observedOutcome: "到目前为止更像弱修复而不是强兑现，结果离原来的 base case 更近。",
        scenarioClosestToOutcome: "base_case",
        baseCaseDirectionallyCloser: "yes",
        changeMyMindTriggered: "no",
        convictionLooksTooHighOrLow: "too_high",
        notes:
          "derived from later holdings_thesis_revalidation reply in memory/feishu-work-receipts/2026-03-25-feishu-work-receipt-143000-000Z-control_room-msg-work-3.md",
      }),
    });
    await writeWorkspaceFile({
      dir: workReceiptsDir,
      name: buildFeishuFinanceDoctrineCalibrationFilename({
        reviewDate: "2026-03-25T16:30:00.000Z",
        consumer: "holdings_thesis_revalidation",
        linkedReceipt: "2026-03-25-feishu-work-receipt-110000-000Z-control_room-msg-work-1.md",
      }),
      content: renderFeishuFinanceDoctrineCalibrationArtifact({
        reviewDate: "2026-03-25T16:30:00.000Z",
        consumer: "holdings_thesis_revalidation",
        linkedReceipt:
          "memory/feishu-work-receipts/2026-03-25-feishu-work-receipt-110000-000Z-control_room-msg-work-1.md",
        observedOutcome: "后续传导更像 thesis 破损，结果离 bear case 更近。",
        scenarioClosestToOutcome: "bear_case",
        baseCaseDirectionallyCloser: "no",
        changeMyMindTriggered: "yes",
        convictionLooksTooHighOrLow: "about_right",
        notes:
          "derived from a later holdings_thesis_revalidation follow-up with explicit posterior review labels",
      }),
    });
    await writeWorkspaceFile({
      dir: workReceiptsDir,
      name: buildFeishuFinanceDoctrineCalibrationFilename({
        reviewDate: "2026-03-22T12:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        linkedReceipt: "2026-03-22-feishu-work-receipt-100000-000Z-control_room-msg-work-old.md",
      }),
      content: renderFeishuFinanceDoctrineCalibrationArtifact({
        reviewDate: "2026-03-22T12:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        linkedReceipt:
          "memory/feishu-work-receipts/2026-03-22-feishu-work-receipt-100000-000Z-control_room-msg-work-old.md",
        observedOutcome: "旧 thesis 仍然更接近 base case，而且 change-my-mind 还没被触发。",
        scenarioClosestToOutcome: "base_case",
        baseCaseDirectionallyCloser: "yes",
        changeMyMindTriggered: "no",
        convictionLooksTooHighOrLow: "too_high",
        notes: "derived from an earlier same-family posterior review within the rolling window",
      }),
    });
    await writeWorkspaceFile({
      dir: workReceiptsDir,
      name: buildFeishuFinanceDoctrineCalibrationFilename({
        reviewDate: "2026-03-15T12:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        linkedReceipt: "2026-03-15-feishu-work-receipt-100000-000Z-control_room-msg-work-stale.md",
      }),
      content: renderFeishuFinanceDoctrineCalibrationArtifact({
        reviewDate: "2026-03-15T12:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        linkedReceipt:
          "memory/feishu-work-receipts/2026-03-15-feishu-work-receipt-100000-000Z-control_room-msg-work-stale.md",
        observedOutcome: "这条太旧，不该进入最近 7 天聚合。",
        scenarioClosestToOutcome: "base_case",
        baseCaseDirectionallyCloser: "yes",
        changeMyMindTriggered: "no",
        convictionLooksTooHighOrLow: "too_high",
        notes: "outside the rolling window and should be excluded",
      }),
    });

    const learningCouncilDir = path.join(tempDir, buildKnowledgeArtifactDir("learningCouncils"));
    await fs.mkdir(learningCouncilDir, { recursive: true });
    await writeWorkspaceFile({
      dir: tempDir,
      name: buildLearningCouncilArtifactJsonRelativePath("msg-1"),
      content: renderLearningCouncilRuntimeArtifact({
        version: 1,
        generatedAt: "2026-03-25T13:00:00.000Z",
        messageId: "msg-1",
        userMessage: "学一下 Treasuries 和 growth risk",
        status: "full",
        mutableFactWarnings: [],
        roles: [],
        finalReply:
          "先看 rates，再看 duration 风险。\n\n### Lobster improvement feedback\n- 先把 finance ask 的动作和范围讲清楚，再展开长总结。",
      }),
    });

    const anomaliesDir = path.join(tempDir, buildWatchtowerArtifactDir("anomalies"));
    await fs.mkdir(anomaliesDir, { recursive: true });
    await writeWorkspaceFile({
      dir: anomaliesDir,
      name: "hallucination-risk-1.json",
      content: JSON.stringify(
        {
          version: 1,
          lastSeenAt: "2026-03-25T14:00:00.000Z",
          category: "hallucination_risk",
          severity: "medium",
          source: "feishu.learning_command",
          problem: "mutable fact was not clearly labelled provisional",
          foundationTemplate: "outcome-review",
        },
        null,
        2,
      ),
    });
    const codexDir = path.join(tempDir, buildWatchtowerArtifactDir("codexEscalations"));
    await fs.mkdir(codexDir, { recursive: true });
    await writeWorkspaceFile({
      dir: codexDir,
      name: "write_edit_failure-issue-1.md",
      content: renderCodexEscalationArtifact({
        titleValue: "write_edit_failure",
        category: "write_edit_failure",
        issueKey: "issue-1",
        source: "correction-loop",
        severity: "medium",
        foundationTemplate: "execution-hygiene",
        occurrences: 2,
        lastSeen: "2026-03-25T16:00:00.000Z",
        repairTicketPath: "bank/watchtower/repair-tickets/issue-1.md",
        anomalyRecordPath: "bank/watchtower/anomalies/hallucination-risk-1.json",
        problem: "file save still did not land cleanly",
        evidenceLines: ["attempt=2", "surface=learning_command"],
        impactLine: "file repair loop is blocked",
        suggestedScopeLine: "smallest-safe-patch only",
        generatedAt: "2026-03-25T16:00:00.000Z",
      }),
    });

    const transcriptDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(transcriptDir, { recursive: true });
    await writeWorkspaceFile({
      dir: transcriptDir,
      name: "sess-1.jsonl",
      content: [
        JSON.stringify({
          type: "message",
          timestamp: "2026-03-25T09:00:00.000Z",
          message: {
            role: "assistant",
            provider: "moonshot",
            model: "moonshot/kimi-k2.5",
            usage: {
              input: 400,
              output: 600,
              totalTokens: 1000,
              cost: { total: 0.12 },
            },
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-03-25T09:05:00.000Z",
          message: {
            role: "assistant",
            provider: "minimax",
            model: "minimax/MiniMax-M2.5",
            usage: {
              input: 300,
              output: 200,
              totalTokens: 500,
              cost: { total: 0.05 },
            },
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-03-24T09:00:00.000Z",
          message: {
            role: "assistant",
            provider: "qianfan",
            model: "qianfan/deepseek-v3.2",
            usage: {
              input: 200,
              output: 100,
              totalTokens: 300,
              cost: { total: 0.03 },
            },
          },
        }),
      ].join("\n"),
    });

    await runReset(tempDir, stateDir);

    const content = await fs.readFile(
      path.join(memoryDir, "2026-03-25-lobster-workface.md"),
      "utf-8",
    );
    expect(content).toContain("# Lobster Workface: 2026-03-25");
    expect(content).toContain("review / risk-transmission");
    expect(content).toContain("Learning Council Runs");
    expect(content).toContain("full: 学一下 Treasuries 和 growth risk");
    expect(content).toContain(
      "improve lobster: 先把 finance ask 的动作和范围讲清楚，再展开长总结。",
    );
    expect(content).toContain("## Yesterday Work Receipts");
    expect(content).toContain(
      "analyze_or_summarize / control_room_general / next_6_months / shortlist_with_reasons: 打开我的浏览器分析，然后生成几个你未来半年最看好的股票",
    );
    expect(content).toContain(
      "finance doctrine proof: holdings_thesis_revalidation -> base_case / bear_case / what_changes_my_mind / why_no_action_may_be_better",
    );
    expect(content).toContain(
      "repair_previous_answer / answer_repair / today_or_immediate / correction_note",
    );
    expect(content).toContain("### Finance Doctrine Calibration");
    expect(content).toContain(
      "recent 7d (2026-03-19 to 2026-03-25): 3 notes / closest scenario base_case 2, bear_case 1, unclear 0",
    );
    expect(content).toContain("recent 7d base closer: yes 2, no 1, unclear 0");
    expect(content).toContain("recent 7d change-my-mind triggered: yes 1, no 2, unclear 0");
    expect(content).toContain(
      "recent 7d conviction looked: too_high 2, too_low 0, about_right 1, unclear 0",
    );
    expect(content).toContain("promotion candidates: unreviewed 4, ready 0, defer 0, reject 0");
    expect(content).toContain(
      "unreviewed: closest_scenario repeated base_case in 2/3 recent calibration notes",
    );
    expect(content).toContain(
      "summary: 2 notes / closest scenario base_case 1, bear_case 1, unclear 0",
    );
    expect(content).toContain("change-my-mind triggered: yes 1, no 1, unclear 0");
    expect(content).toContain("conviction looked: too_high 1, too_low 0, about_right 1, unclear 0");
    expect(content).toContain(
      "holdings_thesis_revalidation: closest base_case / base closer yes / change-my-mind no / conviction too_high",
    );
    expect(content).toContain(
      "holdings_thesis_revalidation: closest bear_case / base closer no / change-my-mind yes / conviction about_right",
    );
    expect(content).toContain(
      "observed outcome: 到目前为止更像弱修复而不是强兑现，结果离原来的 base case 更近。",
    );
    expect(content).toContain(
      "observed outcome: 后续传导更像 thesis 破损，结果离 bear case 更近。",
    );
    expect(content).not.toContain("这条太旧，不该进入最近 7 天聚合。");
    const promotionCandidateFilename =
      buildFeishuFinanceDoctrinePromotionCandidatesFilename("2026-03-25");
    const parsedPromotionCandidates = parseFeishuFinanceDoctrinePromotionCandidateArtifact(
      await fs.readFile(path.join(workReceiptsDir, promotionCandidateFilename), "utf-8"),
    );
    expect(parsedPromotionCandidates).toMatchObject({
      consumer: "holdings_thesis_revalidation",
      windowDays: 7,
      windowStartDate: "2026-03-19",
      windowEndDate: "2026-03-25",
      totalCalibrationNotes: 3,
    });
    expect(parsedPromotionCandidates?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateKey: "closest_scenario:base_case",
          signal: "closest_scenario",
          observedValue: "base_case",
          occurrences: 2,
          reviewState: "unreviewed",
        }),
        expect.objectContaining({
          candidateKey: "base_case_directionally_closer:yes",
          signal: "base_case_directionally_closer",
          observedValue: "yes",
          occurrences: 2,
          reviewState: "unreviewed",
        }),
        expect.objectContaining({
          candidateKey: "change_my_mind_triggered:no",
          signal: "change_my_mind_triggered",
          observedValue: "no",
          occurrences: 2,
          reviewState: "unreviewed",
        }),
        expect.objectContaining({
          candidateKey: "conviction_looks:too_high",
          signal: "conviction_looks",
          observedValue: "too_high",
          occurrences: 2,
          reviewState: "unreviewed",
        }),
      ]),
    );
    const promotionReviewFilename = buildFeishuFinanceDoctrinePromotionReviewFilename("2026-03-25");
    const parsedPromotionReview = parseFeishuFinanceDoctrinePromotionReviewArtifact(
      await fs.readFile(path.join(workReceiptsDir, promotionReviewFilename), "utf-8"),
    );
    expect(parsedPromotionReview).toMatchObject({
      consumer: "holdings_thesis_revalidation",
      linkedCandidateArtifact:
        "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
    });
    expect(parsedPromotionReview?.reviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateKey: "closest_scenario:base_case",
          reviewState: "unreviewed",
        }),
      ]),
    );
    expect(content).toContain("## Self-Repair Signals");
    expect(content).toContain("correction_loop: 你刚才那段还是词不达意");
    expect(content).toContain("issue-1: confidence was too high while freshness was weak.");
    expect(content).toContain("hallucination_risk");
    expect(content).toContain("## Codex Escalations");
    expect(content).toContain("write_edit_failure");
    expect(content).toContain("file save still did not land cleanly");
    expect(content).toContain("## Portfolio Answer Scorecard");
    expect(content).toContain("average score: 3.6 / 5.0");
    expect(content).toContain(
      "weakest current dimension: wait discipline before trying to sound smarter elsewhere",
    );
    expect(content).toContain("## Dashboard Snapshot");
    expect(content).toContain("## Validation Radar");
    expect(content).toContain("Strongest Domain: bounded repair planning");
    expect(content).toContain("Weakest Domain: position management");
    expect(content).toContain("Hallucination Watch: position management: 1 risky validation note");
    expect(content).toContain("## Feishu Lane Panel");
    expect(content).toContain("- **Active Surface Lanes**: 2");
    expect(content).toContain("learning_command / oc-learning: 3 turns");
    expect(content).toContain("fundamental_research / oc-fundamental: 2 turns");
    expect(content).toContain("## 7-Day Operating View");
    expect(content).toContain("Learning Items (7d):");
    expect(content).toContain("Codex Escalations (7d): 1");
    expect(content).toContain("Average Tokens / Day (7d):");
    expect(content).toContain("Learning Flow:");
    expect(content).toContain("Answer Quality:");
    expect(content).toContain("Token Load:");
    expect(content).toContain("1,500");
    expect(content).toContain("moonshot/moonshot/kimi-k2.5");
    expect(content).toContain("minimax/minimax/MiniMax-M2.5");
    expect(content).toContain("### 7-Day Token Trend");
    expect(content).toContain(
      "Active brain path: read memory/current-research-line.md first, then MEMORY.md",
    );
    expect(content).toContain(
      "the distillation chain serves both Lobster's general agent meta-capability and the full finance research pipeline",
    );
    expect(content).toContain(
      "Treat memory/local-memory/*.md as reusable durable cards; treat ops/live-handoff/*.md as drill-down or migration history",
    );
  });

  it("falls back to memory learning-council notes when bank artifacts are absent", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const stateDir = await createCaseWorkspace("state");
    const memoryDir = path.join(tempDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    await writeWorkspaceFile({
      dir: memoryDir,
      name: buildLearningCouncilMemoryNoteFilename({
        dateStr: "2026-03-25",
        noteSlug: "msg-2",
      }),
      content: renderLearningCouncilMemoryNote({
        stem: "msg-2",
        generatedAt: "2026-03-25T13:00:00.000Z",
        status: "full",
        userMessage: "学一下 rates 和 duration 风险",
        mutableFactWarnings: 0,
        failedRolesSummary: "none",
        finalReplySnapshot: "先看 rates，再看 duration 风险。",
        keeperLines: ["先分清 rates shock 和 growth 修复。"],
        discardLines: ["不要把所有反弹都解释成 risk-on。"],
        rehearsalTriggerLines: ["长久期资产突然反弹时先拆 driver。"],
        nextEvalCueLines: ["下次看 TLT 反弹时先检查美元和实际利率。"],
      }),
    });

    await runReset(tempDir, stateDir);

    const content = await fs.readFile(
      path.join(memoryDir, "2026-03-25-lobster-workface.md"),
      "utf-8",
    );
    expect(content).toContain("Learning Council Runs");
    expect(content).toContain("full: 学一下 rates 和 duration 风险");
    expect(content).toContain("keep: 先分清 rates shock 和 growth 修复。");
    expect(content).toContain("discard: 不要把所有反弹都解释成 risk-on。");
    expect(content).toContain("replay: 长久期资产突然反弹时先拆 driver。");
    expect(content).toContain("next eval: 下次看 TLT 反弹时先检查美元和实际利率。");
  });

  it("prefers the structured learning run packet over reparsing final reply prose", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const stateDir = await createCaseWorkspace("state");
    const memoryDir = path.join(tempDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.mkdir(path.join(tempDir, buildKnowledgeArtifactDir("learningCouncils")), {
      recursive: true,
    });

    await writeWorkspaceFile({
      dir: tempDir,
      name: buildLearningCouncilArtifactJsonRelativePath("msg-packet"),
      content: renderLearningCouncilRuntimeArtifact({
        version: 2,
        generatedAt: "2026-03-25T13:00:00.000Z",
        messageId: "msg-packet",
        userMessage: "去学金融主线里最值得内化的东西",
        status: "full",
        mutableFactWarnings: [],
        roles: [],
        runPacket: {
          objective: "去学金融主线里最值得内化的东西",
          protectedAnchorsPresent: ["memory/current-research-line.md", "MEMORY.md"],
          protectedAnchorsMissing: ["memory/unified-risk-view.md"],
          currentFocus: "finance_mainline_learning",
          topDecision: "anchor learning to the active finance brain before broad recall",
          recallOrder: "current-research-line -> MEMORY.md -> latest carryover set",
          latestCarryoverSource: "memory/2026-03-24-lobster-workface.md",
          localMemoryCardPaths: ["memory/local-memory/holding-holdings-thesis-revalidation.md"],
          keepLines: ["keep finance learning tied to the active research line"],
          discardLines: ["discard generic meta-agent recap that does not change finance work"],
          lobsterImprovementLines: [
            "tighten the first-pass finance-learning bracket before broad meta-agent synthesis",
          ],
          currentBracketLines: [
            "either tighten finance-learning on the active brain or drift into generic meta-agent study",
          ],
          ruledOutLines: ["generic meta-agent recap as the primary output for this ask"],
          highestInfoNextCheckLines: [
            "check whether the next workface or brief actually changes one finance behavior",
          ],
          replayTriggerLines: ["replay when the next finance-learning ask arrives without anchors"],
          nextEvalCueLines: [
            "verify the next workface carries one concrete finance behavior change",
          ],
          recoveryReadOrder: [
            "memory/current-research-line.md",
            "MEMORY.md",
            "memory/2026-03-24-lobster-workface.md",
          ],
        },
        finalReply: "这一轮学习已经完成，但这里只保留了一段简短摘要。",
      }),
    });

    await runReset(tempDir, stateDir);

    const content = await fs.readFile(
      path.join(memoryDir, "2026-03-25-lobster-workface.md"),
      "utf-8",
    );
    expect(content).toContain("Learning Council Runs");
    expect(content).toContain("full: 去学金融主线里最值得内化的东西");
    expect(content).toContain("keep: keep finance learning tied to the active research line");
    expect(content).toContain(
      "discard: discard generic meta-agent recap that does not change finance work",
    );
    expect(content).toContain(
      "improve lobster: tighten the first-pass finance-learning bracket before broad meta-agent synthesis",
    );
    expect(content).toContain(
      "replay: replay when the next finance-learning ask arrives without anchors",
    );
    expect(content).toContain(
      "next eval: verify the next workface carries one concrete finance behavior change",
    );
  });

  it("prefers the adoption ledger when explicit retained adoption state exists", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const stateDir = await createCaseWorkspace("state");
    const memoryDir = path.join(tempDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    await writeWorkspaceFile({
      dir: memoryDir,
      name: buildLearningCouncilAdoptionLedgerFilename({
        dateStr: "2026-03-25",
        noteSlug: "msg-adoption",
      }),
      content: renderLearningCouncilAdoptionLedger({
        stem: "msg-adoption",
        generatedAt: "2026-03-25T13:00:00.000Z",
        status: "full",
        userMessage: "去学金融主线里最值得内化的东西",
        sourceArtifact: buildLearningCouncilArtifactJsonRelativePath("msg-adoption"),
        entries: [
          {
            source: "learning-council:msg-adoption",
            cueType: "keep",
            text: "keep finance learning tied to the active research line",
            adoptedState: "adopted_now",
            reusedLater: false,
            downrankedOrFailed: false,
            linkedArtifactOrReceipt: buildLearningCouncilArtifactJsonRelativePath("msg-adoption"),
            notes: "seeded from runPacket.keepLines",
          },
          {
            source: "learning-council:msg-adoption",
            cueType: "discard",
            text: "discard generic meta-agent recap that does not change finance work",
            adoptedState: "adopted_now",
            reusedLater: false,
            downrankedOrFailed: false,
            linkedArtifactOrReceipt: buildLearningCouncilArtifactJsonRelativePath("msg-adoption"),
            notes: "seeded from runPacket.discardLines",
          },
          {
            source: "learning-council:msg-adoption",
            cueType: "lobster_improvement",
            text: "persist one bounded improvement cue instead of leaving it in council prose",
            adoptedState: "candidate_for_reuse",
            reusedLater: false,
            downrankedOrFailed: false,
            linkedArtifactOrReceipt: buildLearningCouncilArtifactJsonRelativePath("msg-adoption"),
            notes: "bounded self-improvement candidate",
          },
          {
            source: "learning-council:msg-adoption",
            cueType: "replay_trigger",
            text: "replay when the next finance-learning ask arrives without anchors",
            adoptedState: "candidate_for_reuse",
            reusedLater: false,
            downrankedOrFailed: false,
            linkedArtifactOrReceipt: buildLearningCouncilArtifactJsonRelativePath("msg-adoption"),
            notes: "candidate replay trigger",
          },
          {
            source: "learning-council:msg-adoption",
            cueType: "next_eval",
            text: "verify the next workface carries one concrete finance behavior change",
            adoptedState: "candidate_for_reuse",
            reusedLater: false,
            downrankedOrFailed: false,
            linkedArtifactOrReceipt: buildLearningCouncilArtifactJsonRelativePath("msg-adoption"),
            notes: "candidate next eval cue",
          },
          {
            source: "learning-council:msg-adoption",
            cueType: "current_bracket",
            text: "either tighten finance-learning on the active brain or drift into generic meta-agent study",
            adoptedState: "candidate_for_reuse",
            reusedLater: false,
            downrankedOrFailed: false,
            linkedArtifactOrReceipt: buildLearningCouncilArtifactJsonRelativePath("msg-adoption"),
            notes: "candidate current bracket",
          },
        ],
      }),
    });
    await runReset(tempDir, stateDir);

    const content = await fs.readFile(
      path.join(memoryDir, "2026-03-25-lobster-workface.md"),
      "utf-8",
    );
    expect(content).toContain("Learning Council Runs");
    expect(content).toContain("full: 去学金融主线里最值得内化的东西");
    expect(content).toContain(
      "adoption ledger: adopted now 2 / candidate 4 / reused 5 / downranked 0",
    );
    expect(content).toContain("keep: keep finance learning tied to the active research line");
    expect(content).toContain(
      "discard: discard generic meta-agent recap that does not change finance work",
    );
    expect(content).toContain(
      "improve lobster: persist one bounded improvement cue instead of leaving it in council prose",
    );
    expect(content).toContain(
      "replay: replay when the next finance-learning ask arrives without anchors",
    );
    expect(content).toContain(
      "next eval: verify the next workface carries one concrete finance behavior change",
    );
    const ledgerFilename = buildLearningCouncilAdoptionLedgerFilename({
      dateStr: "2026-03-25",
      noteSlug: "msg-adoption",
    });
    const parsedLedger = parseLearningCouncilAdoptionLedger({
      filename: ledgerFilename,
      content: await fs.readFile(path.join(memoryDir, ledgerFilename), "utf-8"),
    });
    expect(parsedLedger?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cueType: "keep",
          text: "keep finance learning tied to the active research line",
          reusedLater: true,
          downrankedOrFailed: false,
        }),
        expect.objectContaining({
          cueType: "discard",
          text: "discard generic meta-agent recap that does not change finance work",
          reusedLater: true,
          downrankedOrFailed: false,
        }),
        expect.objectContaining({
          cueType: "lobster_improvement",
          text: "persist one bounded improvement cue instead of leaving it in council prose",
          reusedLater: true,
          downrankedOrFailed: false,
        }),
        expect.objectContaining({
          cueType: "replay_trigger",
          text: "replay when the next finance-learning ask arrives without anchors",
          reusedLater: true,
          downrankedOrFailed: false,
        }),
        expect.objectContaining({
          cueType: "next_eval",
          text: "verify the next workface carries one concrete finance behavior change",
          reusedLater: true,
          downrankedOrFailed: false,
        }),
        expect.objectContaining({
          cueType: "current_bracket",
          text: "either tighten finance-learning on the active brain or drift into generic meta-agent study",
          reusedLater: false,
          downrankedOrFailed: false,
        }),
      ]),
    );
  });

  it("preserves promotion-candidate review state when recalculating the same finance candidate file", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const stateDir = await createCaseWorkspace("state");
    const memoryDir = path.join(tempDir, "memory");
    const workReceiptsDir = path.join(memoryDir, "feishu-work-receipts");
    await fs.mkdir(workReceiptsDir, { recursive: true });

    await writeWorkspaceFile({
      dir: workReceiptsDir,
      name: buildFeishuFinanceDoctrineCalibrationFilename({
        reviewDate: "2026-03-25T14:30:00.000Z",
        consumer: "holdings_thesis_revalidation",
        linkedReceipt: "2026-03-25-feishu-work-receipt-110000-000Z-control_room-msg-work-1.md",
      }),
      content: renderFeishuFinanceDoctrineCalibrationArtifact({
        reviewDate: "2026-03-25T14:30:00.000Z",
        consumer: "holdings_thesis_revalidation",
        linkedReceipt:
          "memory/feishu-work-receipts/2026-03-25-feishu-work-receipt-110000-000Z-control_room-msg-work-1.md",
        observedOutcome: "结果依然更像 base case。",
        scenarioClosestToOutcome: "base_case",
        baseCaseDirectionallyCloser: "yes",
        changeMyMindTriggered: "no",
        convictionLooksTooHighOrLow: "too_high",
        notes: "first repeated calibration note",
      }),
    });
    await writeWorkspaceFile({
      dir: workReceiptsDir,
      name: buildFeishuFinanceDoctrineCalibrationFilename({
        reviewDate: "2026-03-22T12:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        linkedReceipt: "2026-03-22-feishu-work-receipt-100000-000Z-control_room-msg-work-old.md",
      }),
      content: renderFeishuFinanceDoctrineCalibrationArtifact({
        reviewDate: "2026-03-22T12:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        linkedReceipt:
          "memory/feishu-work-receipts/2026-03-22-feishu-work-receipt-100000-000Z-control_room-msg-work-old.md",
        observedOutcome: "第二条也更像 base case。",
        scenarioClosestToOutcome: "base_case",
        baseCaseDirectionallyCloser: "yes",
        changeMyMindTriggered: "no",
        convictionLooksTooHighOrLow: "too_high",
        notes: "second repeated calibration note",
      }),
    });
    await writeWorkspaceFile({
      dir: workReceiptsDir,
      name: buildFeishuFinanceDoctrinePromotionReviewFilename("2026-03-25"),
      content: renderFeishuFinanceDoctrinePromotionReviewArtifact({
        reviewedAt: "2026-03-25T18:00:00.000Z",
        consumer: "holdings_thesis_revalidation",
        linkedCandidateArtifact:
          "memory/feishu-work-receipts/2026-03-25-feishu-finance-doctrine-promotion-candidates.md",
        reviews: [
          {
            candidateKey: "closest_scenario:base_case",
            reviewState: "ready_for_manual_promotion",
            reviewNotes: "repeat pattern is stable enough to consider manual promotion",
          },
        ],
      }),
    });

    await runReset(tempDir, stateDir);

    const content = await fs.readFile(
      path.join(memoryDir, "2026-03-25-lobster-workface.md"),
      "utf-8",
    );
    expect(content).toContain("promotion candidates: unreviewed 3, ready 1, defer 0, reject 0");
    expect(content).toContain(
      "reviewed: ready_for_manual_promotion / closest_scenario repeated base_case in 2/2 recent calibration notes",
    );
    expect(content).toContain("note: repeat pattern is stable enough to consider manual promotion");
    const parsedPromotionCandidates = parseFeishuFinanceDoctrinePromotionCandidateArtifact(
      await fs.readFile(
        path.join(
          workReceiptsDir,
          buildFeishuFinanceDoctrinePromotionCandidatesFilename("2026-03-25"),
        ),
        "utf-8",
      ),
    );
    expect(parsedPromotionCandidates?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateKey: "closest_scenario:base_case",
          reviewState: "ready_for_manual_promotion",
          reviewNotes: "repeat pattern is stable enough to consider manual promotion",
        }),
        expect.objectContaining({
          candidateKey: "base_case_directionally_closer:yes",
          reviewState: "unreviewed",
        }),
        expect.objectContaining({
          candidateKey: "change_my_mind_triggered:no",
          reviewState: "unreviewed",
        }),
        expect.objectContaining({
          candidateKey: "conviction_looks:too_high",
          reviewState: "unreviewed",
        }),
      ]),
    );
    const parsedPromotionReview = parseFeishuFinanceDoctrinePromotionReviewArtifact(
      await fs.readFile(
        path.join(workReceiptsDir, buildFeishuFinanceDoctrinePromotionReviewFilename("2026-03-25")),
        "utf-8",
      ),
    );
    expect(parsedPromotionReview?.reviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateKey: "closest_scenario:base_case",
          reviewState: "ready_for_manual_promotion",
          reviewNotes: "repeat pattern is stable enough to consider manual promotion",
        }),
        expect.objectContaining({
          candidateKey: "base_case_directionally_closer:yes",
          reviewState: "unreviewed",
        }),
      ]),
    );
  });

  it("does nothing when yesterday has no learning, correction, anomaly, or token signals", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const stateDir = await createCaseWorkspace("state");

    await runReset(tempDir, stateDir);

    await expect(
      fs.access(path.join(tempDir, "memory", "2026-03-25-lobster-workface.md")),
    ).rejects.toThrow();
  });

  it("still writes a workface when weekly validation exists even if yesterday was quiet", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const stateDir = await createCaseWorkspace("state");
    const memoryDir = path.join(tempDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    await writeWorkspaceFile({
      dir: memoryDir,
      name: buildKnowledgeValidationWeeklyArtifactFilename("2026-W13"),
      content: renderKnowledgeValidationWeeklyArtifact({
        weekKey: "2026-W13",
        rangeLabel: "2026-03-23 to 2026-03-29",
        sessionKey: "agent:main:main",
        validationNotes: 1,
        benchmarkNotes: 0,
        dailyRealTaskNotes: 1,
        benchmarkCoverageLines: ["- No benchmark-style validation note was captured this week."],
        dailyRealTaskCoverageLines: ["- position_management: 1 note"],
        capabilityCoverageLines: ["- finance: 1 note"],
        strongestDomainLines: [
          "- bounded repair planning: factual 4.0/5, reasoning 4.0/5 (1 note)",
        ],
        weakestDomainLines: ["- position management: factual 3.0/5, reasoning 2.0/5 (1 note)"],
        hallucinationProneLines: ["- position management: 1 risky validation note"],
        correctionCandidateLines: ["- No correction candidate was captured this week."],
        repairTicketCandidateLines: ["- No repair-ticket candidate was captured this week."],
        nextValidationFocusLines: [
          "- Add at least one benchmark-style note next week before claiming domain improvement.",
        ],
      }),
    });

    await runReset(tempDir, stateDir);

    const content = await fs.readFile(
      path.join(memoryDir, "2026-03-25-lobster-workface.md"),
      "utf-8",
    );
    expect(content).toContain("## Validation Radar");
    expect(content).toContain("position management");
    expect(content).toContain("## Reading Guide");
    expect(content).toContain("Active brain path: read memory/current-research-line.md first");
  });
});
