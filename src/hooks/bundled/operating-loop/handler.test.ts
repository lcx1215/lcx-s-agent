import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import { createHookEvent } from "../../hooks.js";
import type { HookHandler } from "../../hooks.js";
import {
  summarizeFundamentalIntakeSession,
  type FundamentalDocumentMetadata,
  type FundamentalManifestScaffold,
} from "../fundamental-intake/handler.js";
import { bridgeManifest } from "../fundamental-manifest-bridge/handler.js";
import { buildFundamentalRiskHandoff } from "../fundamental-risk-handoff/handler.js";
import { buildFundamentalScoringGate } from "../fundamental-scoring-gate/handler.js";
import { buildSnapshotInput } from "../fundamental-snapshot-bridge/handler.js";
import { buildFundamentalSnapshot } from "../fundamental-snapshot/handler.js";

let handler: HookHandler;
let suiteWorkspaceRoot = "";
let workspaceCaseCounter = 0;

async function createCaseWorkspace(prefix = "operating"): Promise<string> {
  const dir = path.join(suiteWorkspaceRoot, `${prefix}-${workspaceCaseCounter}`);
  workspaceCaseCounter += 1;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function makeConfig(tempDir: string): OpenClawConfig {
  return {
    agents: { defaults: { workspace: tempDir } },
  } satisfies OpenClawConfig;
}

function createSessionContent(
  entries: Array<{ role: "user" | "assistant"; content: string }>,
): string {
  return entries
    .map((entry) =>
      JSON.stringify({
        type: "message",
        message: {
          role: entry.role,
          content: entry.content,
        },
      }),
    )
    .join("\n");
}

function createProtectedSummaryFixture(params: {
  generation: number;
  producedAt: string;
  sourceRunId: string;
  body: string;
}): string {
  return [
    `<!-- operating-loop-write-guard: ${JSON.stringify({
      generation: params.generation,
      producedAt: params.producedAt,
      sourceRunId: params.sourceRunId,
    })} -->`,
    params.body,
  ].join("\n");
}

function createFundamentalManifestFixture(requestText: string): FundamentalManifestScaffold {
  return summarizeFundamentalIntakeSession(
    [
      {
        role: "user",
        text: requestText,
      },
      {
        role: "assistant",
        text: "I will keep this fundamental workflow manifest-first and approval-gated.",
      },
    ],
    "2026-03-15T12:00:00.000Z",
  ).manifestScaffold;
}

async function writeFundamentalDocument(params: {
  workspaceDir: string;
  manifest: FundamentalManifestScaffold;
  fileName: string;
  metadata: FundamentalDocumentMetadata;
}) {
  const targetDir = params.manifest.documentWorkspace.targetDirs[0]?.dir;
  if (!targetDir) {
    throw new Error("manifest fixture missing target dir");
  }
  const absoluteTargetDir = path.join(params.workspaceDir, targetDir);
  await fs.mkdir(absoluteTargetDir, { recursive: true });
  const filePath = path.join(absoluteTargetDir, params.fileName);
  await fs.writeFile(filePath, "fixture", "utf-8");
  await fs.writeFile(
    `${filePath}.meta.json`,
    `${JSON.stringify(params.metadata, null, 2)}\n`,
    "utf-8",
  );
}

async function seedFundamentalScoringArtifacts(params: {
  workspaceDir: string;
  manifest: FundamentalManifestScaffold;
  writeRiskHandoff?: boolean;
}) {
  await writeFundamentalDocument({
    workspaceDir: params.workspaceDir,
    manifest: params.manifest,
    fileName: "aapl--annual_report--issuer_primary--20260315.pdf",
    metadata: {
      version: 1,
      targetLabel: "AAPL",
      category: "annual_report",
      sourceType: "issuer_primary",
    },
  });
  await writeFundamentalDocument({
    workspaceDir: params.workspaceDir,
    manifest: params.manifest,
    fileName: "aapl--annual_report--regulatory_filing--20260315.pdf",
    metadata: {
      version: 1,
      targetLabel: "AAPL",
      category: "annual_report",
      sourceType: "regulatory_filing",
    },
  });
  await writeFundamentalDocument({
    workspaceDir: params.workspaceDir,
    manifest: params.manifest,
    fileName: "aapl--investor_presentation--company_presentation--20260315.pdf",
    metadata: {
      version: 1,
      targetLabel: "AAPL",
      category: "investor_presentation",
      sourceType: "company_presentation",
    },
  });

  const manifestPath = `bank/fundamental/manifests/2026-03-15-fundamental-manifest-${params.manifest.manifestId}.json`;
  const bridged = await bridgeManifest({
    workspaceDir: params.workspaceDir,
    nowIso: "2026-03-15T12:00:00.000Z",
    manifestPath,
    manifest: {
      ...params.manifest,
      reviewGate: {
        ...params.manifest.reviewGate,
        status: "approved_for_collection",
      },
    },
  });
  const snapshotInput = buildSnapshotInput({
    nowIso: "2026-03-15T12:00:00.000Z",
    manifestPath,
    readinessPath: `bank/fundamental/readiness/${params.manifest.manifestId}.json`,
    manifest: bridged.manifest,
    readiness: bridged.readiness,
  });
  const snapshot = buildFundamentalSnapshot({
    nowIso: "2026-03-15T12:00:00.000Z",
    manifestPath,
    readinessPath: `bank/fundamental/readiness/${params.manifest.manifestId}.json`,
    snapshotInputPath: `bank/fundamental/snapshot-inputs/${params.manifest.manifestId}.json`,
    manifest: bridged.manifest,
    readiness: bridged.readiness,
    snapshotInput,
  });
  const scoringGate = buildFundamentalScoringGate({
    nowIso: "2026-03-15T12:00:00.000Z",
    snapshotPath: `bank/fundamental/snapshots/${params.manifest.manifestId}.json`,
    snapshot,
  });

  const manifestsDir = path.join(params.workspaceDir, "bank", "fundamental", "manifests");
  const scoringGatesDir = path.join(params.workspaceDir, "bank", "fundamental", "scoring-gates");
  await fs.mkdir(manifestsDir, { recursive: true });
  await fs.mkdir(scoringGatesDir, { recursive: true });
  await fs.writeFile(
    path.join(manifestsDir, `2026-03-15-fundamental-manifest-${params.manifest.manifestId}.json`),
    `${JSON.stringify(bridged.manifest, null, 2)}\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(scoringGatesDir, `${params.manifest.manifestId}.json`),
    `${JSON.stringify(scoringGate, null, 2)}\n`,
    "utf-8",
  );

  if (!params.writeRiskHandoff) {
    return;
  }

  const handoff = buildFundamentalRiskHandoff({
    nowIso: "2026-03-15T12:00:00.000Z",
    scoringGatePath: `bank/fundamental/scoring-gates/${params.manifest.manifestId}.json`,
    manifestRiskHandoffStatus: bridged.manifest.riskHandoff.status,
    scoringGate,
  });
  const handoffDir = path.join(params.workspaceDir, "bank", "fundamental", "risk-handoffs");
  await fs.mkdir(handoffDir, { recursive: true });
  await fs.writeFile(
    path.join(handoffDir, `${params.manifest.manifestId}.json`),
    `${JSON.stringify(handoff, null, 2)}\n`,
    "utf-8",
  );
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-operating-loop-"));
});

afterAll(async () => {
  if (!suiteWorkspaceRoot) {
    return;
  }
  await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  suiteWorkspaceRoot = "";
  workspaceCaseCounter = 0;
});

describe("operating-loop hook", () => {
  it("writes daily and weekly operating artifacts from current memory notes", async () => {
    const workspaceDir = await createCaseWorkspace();
    const memoryDir = path.join(workspaceDir, "memory");
    const sessionsDir = path.join(workspaceDir, "sessions");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    const manifest = createFundamentalManifestFixture(
      "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations.",
    );
    await seedFundamentalScoringArtifacts({
      workspaceDir,
      manifest,
    });
    const reviewMemoDir = path.join(workspaceDir, "bank", "fundamental", "review-memos");
    const followUpDir = path.join(
      workspaceDir,
      "bank",
      "fundamental",
      "collection-follow-up-trackers",
    );
    await fs.mkdir(reviewMemoDir, { recursive: true });
    await fs.mkdir(followUpDir, { recursive: true });
    await fs.writeFile(
      path.join(reviewMemoDir, `${manifest.manifestId}.json`),
      `${JSON.stringify(
        {
          version: 1,
          generatedAt: "2026-03-15T12:00:00.000Z",
          manifestId: manifest.manifestId,
          manifestPath: `bank/fundamental/manifests/2026-03-15-fundamental-manifest-${manifest.manifestId}.json`,
          targetReportsPath: `bank/fundamental/target-reports/${manifest.manifestId}.json`,
          collectionPacketsPath: `bank/fundamental/collection-packets/${manifest.manifestId}.json`,
          targetPacketsPath: `bank/fundamental/target-packets/${manifest.manifestId}.json`,
          memoStatus: "follow_up_collection_needed",
          reportReviewTargets: [],
          collectionFollowUpTargets: [],
          blockedTargets: [],
          reviewFocus: ["Collect management guidance for AAPL before final report review."],
          nextActions: [
            "AAPL: repair metadata sidecars and confirm investor presentation coverage.",
          ],
          notes: ["Use this memo to drive the next research step, not execution."],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(followUpDir, `${manifest.manifestId}.json`),
      `${JSON.stringify(
        {
          version: 1,
          generatedAt: "2026-03-15T12:00:00.000Z",
          manifestId: manifest.manifestId,
          manifestPath: `bank/fundamental/manifests/2026-03-15-fundamental-manifest-${manifest.manifestId}.json`,
          reviewMemoPath: `bank/fundamental/review-memos/${manifest.manifestId}.json`,
          collectionPacketsPath: `bank/fundamental/collection-packets/${manifest.manifestId}.json`,
          targetPacketsPath: `bank/fundamental/target-packets/${manifest.manifestId}.json`,
          trackerStatus: "follow_up_active",
          followUpTargets: [
            {
              targetLabel: "AAPL",
              reviewPriority: "high",
              blockerReason: "missing_metadata_sidecar",
              recommendation: "metadata_repair_then_review",
              missingMaterials: ["management guidance"],
              missingMetadata: true,
              nextRequiredCollectionAction:
                "Repair metadata sidecars, then re-check the investor presentation coverage for AAPL.",
              collectionWorkfilePath: `bank/fundamental/collection-work/${manifest.manifestId}/aapl.md`,
              patchPath: `bank/fundamental/deliverables/${manifest.manifestId}/manifest-patches/aapl.json`,
              manualChecks: ["Confirm source type matches each local document."],
            },
          ],
          blockedTargets: [],
          nextCollectionPriorities: [
            "AAPL: repair metadata sidecars, then re-check the investor presentation coverage for AAPL. (high, missing_metadata_sidecar)",
          ],
          notes: ["This tracker only records collection gaps, priorities, and next steps."],
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-03-15-simple-math.md",
      content: [
        "# Session: 2026-03-15 11:50:00 UTC",
        "",
        "- **Session Key**: agent:main:main",
        "- **Session ID**: prior-session",
        "- **Source**: cli",
        "",
        "## Conversation Summary",
        "",
        "user: Re-check the weekly math notes",
        "assistant: I compared the linear algebra drills and the frontier backlog.",
        "",
      ].join("\n"),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-03-15-review-linear-algebra.md",
      content: [
        "# Learning Review",
        "",
        "- **Session Key**: agent:main:main",
        "- **Session ID**: study-1",
        "- **Topic**: linear-algebra",
        "",
        "## Review Note",
        "- mistake_pattern: skipped dimension checks",
        "- core_principle: check dimensions first",
        "- micro_drill: write dimensions before multiplying matrices",
        "- transfer_hint: helps with PCA and regression",
      ].join("\n"),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-03-12-review-probability.md",
      content: [
        "# Learning Review",
        "",
        "- **Session Key**: agent:main:main",
        "- **Session ID**: study-2",
        "- **Topic**: probability-and-statistics",
        "",
        "## Review Note",
        "- mistake_pattern: skipped event definitions",
        "- core_principle: define events first",
        "- micro_drill: define A and B before using Bayes",
        "- transfer_hint: helps with hypothesis testing",
      ].join("\n"),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-03-15-frontier-research-wave.md",
      content: [
        "# Frontier Research Card",
        "",
        "- **Session Key**: agent:main:main",
        "- **Session ID**: frontier-1",
        "",
        "## Research Card",
        "- title: WaveLSFormer",
        "- material_type: paper",
        "- method_family: time-series-transformer",
        "- claimed_contribution: multi-scale preprocessing improves signal quality",
        "- evaluation_protocol: use walk-forward splits and benchmark simpler baselines",
        "- key_results: the multi-scale framing is more reusable than the exact model stack",
        "- possible_leakage_points: temporal windowing can leak future information",
        "- overfitting_risks: sequence model may overfit one regime",
        "- replication_cost: medium",
        "- adoptable_ideas: keep multi-scale denoising but evaluate with trading-aligned objectives",
        "- verdict: worth_reproducing",
      ].join("\n"),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-03-15-lobster-workface.md",
      content: [
        "# Lobster Workface: 2026-03-15",
        "",
        "## Yesterday Learned",
        "",
        "- keep: keep leakage and OOS checks ahead of pretty results.",
        "- discard: discard any thesis that survives only on storytelling.",
        "- replay: when a result looks too clean, re-check leakage and stale anchors.",
        "- next eval: next time test whether the rule changes the risk gate before trusting it.",
      ].join("\n"),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-03-10-frontier-research-factor.md",
      content: [
        "# Frontier Research Card",
        "",
        "- **Session Key**: agent:main:main",
        "- **Session ID**: frontier-2",
        "",
        "## Research Card",
        "- title: Adaptive Factor Stack",
        "- material_type: paper",
        "- method_family: factor-model",
        "- claimed_contribution: factor timing adaptation may improve ranking stability",
        "- evaluation_protocol: check turnover, costs, and out-of-sample decay",
        "- key_results: timing discipline matters more than the exact stack",
        "- possible_leakage_points: rebalance timing may hide benchmark contamination",
        "- overfitting_risks: over-tuned factors decay out of sample",
        "- replication_cost: medium",
        "- adoptable_ideas: separate factor intuition from implementation timing",
        "- verdict: watch_for_followup",
      ].join("\n"),
    });

    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "active-session.jsonl",
      content: createSessionContent([
        { role: "user", content: "Summarize today's operating loop before reset" },
        {
          role: "assistant",
          content: "I can roll the learning and frontier notes into a daily summary.",
        },
      ]),
    });

    const event = createHookEvent("command", "reset", "agent:main:main", {
      cfg: makeConfig(workspaceDir),
      commandSource: "cli",
      previousSessionEntry: {
        sessionId: "active-session",
        sessionFile,
      },
    });
    event.timestamp = new Date("2026-03-15T12:00:00.000Z");

    await handler(event);

    const files = await fs.readdir(memoryDir);
    expect(files).toContain("2026-03-15-intake-log.md");
    expect(files).toContain("2026-03-15-fetch-log.md");
    expect(files).toContain("2026-03-15-review-log.md");
    expect(files).toContain("2026-03-15-branch-summary.md");
    expect(files).toContain("current-research-line.md");
    expect(files).toContain("2026-03-15-risk-audit-snapshot.md");
    expect(files).toContain("2026-W11-weekly-learning-loop.md");
    expect(files).toContain("unified-risk-view.md");

    const intake = await fs.readFile(path.join(memoryDir, "2026-03-15-intake-log.md"), "utf-8");
    const fetchLog = await fs.readFile(path.join(memoryDir, "2026-03-15-fetch-log.md"), "utf-8");
    const reviewLog = await fs.readFile(path.join(memoryDir, "2026-03-15-review-log.md"), "utf-8");
    const branchSummary = await fs.readFile(
      path.join(memoryDir, "2026-03-15-branch-summary.md"),
      "utf-8",
    );
    const currentResearchLine = await fs.readFile(
      path.join(memoryDir, "current-research-line.md"),
      "utf-8",
    );
    const riskAudit = await fs.readFile(
      path.join(memoryDir, "2026-03-15-risk-audit-snapshot.md"),
      "utf-8",
    );
    const weeklyLoop = await fs.readFile(
      path.join(memoryDir, "2026-W11-weekly-learning-loop.md"),
      "utf-8",
    );
    const unifiedRiskView = await fs.readFile(
      path.join(memoryDir, "unified-risk-view.md"),
      "utf-8",
    );

    expect(intake).toContain("# Intake Log: 2026-03-15");
    expect(intake).toContain("Re-check the weekly math notes");
    expect(intake).toContain("Summarize today's operating loop before reset");

    expect(fetchLog).toContain("# Fetch Log: 2026-03-15");
    expect(fetchLog).toContain(
      "WaveLSFormer | paper | time-series-transformer | verdict=worth_reproducing",
    );

    expect(reviewLog).toContain("# Review Log: 2026-03-15");
    expect(reviewLog).toContain(
      "linear-algebra | mistake=skipped dimension checks | principle=check dimensions first",
    );
    expect(reviewLog).toContain("WaveLSFormer | verdict=worth_reproducing");

    expect(branchSummary).toContain("# Branch Summary: 2026-03-15");
    expect(branchSummary).toContain("learning_focus: linear-algebra");
    expect(branchSummary).toContain("top_decision: worth_reproducing: WaveLSFormer");
    expect(branchSummary).toContain("fundamental_handoff: ready=1 partial=0 blocked=0");
    expect(branchSummary).toContain("fundamental-risk-handoff");

    expect(currentResearchLine).toContain("# Current Research Line");
    expect(currentResearchLine).toContain("current_focus: fundamental_follow_up");
    expect(currentResearchLine).toContain("line_status: active");
    expect(currentResearchLine).toContain(
      "current_session_summary: cli: Summarize today's operating loop before reset",
    );
    expect(currentResearchLine).toContain("latest_review_memo_state: follow_up_collection_needed");
    expect(currentResearchLine).toContain("latest_follow_up_state: follow_up_active");
    expect(currentResearchLine).toContain("next_step: AAPL: repair metadata sidecars");
    expect(currentResearchLine).toContain(
      "research_guardrail: research-first operating memory only; this is not an execution approval surface",
    );
    expect(currentResearchLine).toContain(
      "memory_state_contract: verified supports current decisions; provisional requires fresh re-check; stale is drill-down only until re-verified",
    );
    expect(currentResearchLine).toContain("review_memo_status: follow_up_collection_needed");
    expect(currentResearchLine).toContain("follow_up_tracker_status: follow_up_active");
    expect(currentResearchLine).toContain("top_follow_up: AAPL: repair metadata sidecars");
    expect(currentResearchLine).toContain("freshness: fresh");
    expect(currentResearchLine).toContain("workspace_brain_index_path: MEMORY.md");
    expect(currentResearchLine).toContain(
      "retained_rule: keep leakage and OOS checks ahead of pretty results.",
    );
    expect(currentResearchLine).toContain(
      "discarded_rule: discard any thesis that survives only on storytelling.",
    );
    expect(currentResearchLine).toContain(
      "replay_trigger: when a result looks too clean, re-check leakage and stale anchors.",
    );
    expect(currentResearchLine).toContain(
      "next_eval_cue: next time test whether the rule changes the risk gate before trusting it.",
    );
    expect(currentResearchLine).toContain(
      "primary_anchor: fundamental-collection-follow-up-tracker",
    );
    expect(currentResearchLine).toContain("drill_down_only_before: 2026-03-01");
    expect(currentResearchLine).toContain(
      "local_memory_activation_rule: after the latest carryover set and correction notes, load at most two active local durable memory cards whose subject or use-when rule matches the current ask before older drill-down artifacts",
    );
    expect(currentResearchLine).toContain(
      "recall_order: current-research-line -> MEMORY.md -> primary_anchor -> latest carryover set -> correction notes -> matching local durable memory cards -> unified-risk-view/review-memo -> older drill-down artifacts",
    );
    expect(currentResearchLine).toContain("## Continuous Improvement");
    expect(currentResearchLine).toContain(
      "daily_improvement_rule: carry at most one keeper lesson and one wrong-answer lesson into daily strategy work",
    );
    expect(currentResearchLine).toContain(
      "decision_convergence_rule: start with the current bracket, rule out obvious bad-fit interpretations, then run one highest-information next check before pretending the answer or rule is precise",
    );
    expect(currentResearchLine).toContain(
      "language_precision_repair_rule: if the operator says the prior answer was imprecise or missed the ask, narrow first on requested action, scope, timeframe, and output shape before rewriting content",
    );
    expect(currentResearchLine).toContain(
      "holdings_revalidation_rule: retrieve the old thesis, current anchor, carryover cue, and correction trail before writing any fresh hold/add/reduce stance from scratch",
    );
    expect(currentResearchLine).toContain(
      "holdings_revalidation_foundations: outcome-review -> risk-transmission -> behavior-error-correction -> catalyst-map -> business-quality",
    );
    expect(currentResearchLine).toContain("## Continuity And File Safety");
    expect(currentResearchLine).toContain(
      "file_safety_rule: refresh compact anchors first; do not replace continuity artifacts with empty or no-op rewrites",
    );
    expect(currentResearchLine).toContain(
      "archive_rule: treat ops/live-handoff notes as drill-down only when current-research-line or MEMORY.md already defines the active brain state",
    );
    expect(currentResearchLine).toContain("## Memory Budget");
    expect(currentResearchLine).toContain(
      "active_recall_budget: prefer at most five high-priority anchors before drilling into older artifacts",
    );
    expect(currentResearchLine).toContain(
      "research-first operating memory only; this is not an execution approval surface",
    );

    expect(riskAudit).toContain("# Risk Audit Snapshot: 2026-03-15");
    expect(riskAudit).toContain("**Top Decision**: ready_for_risk_review: AAPL");
    expect(riskAudit).toContain("**Risk Scope**: methods+fundamental-handoff");
    expect(riskAudit).toContain("**Fundamental Handoff Count**: 1");
    expect(riskAudit).toContain("temporal windowing can leak future information");
    expect(riskAudit).toContain(
      "Build a fundamental research scaffold for AAPL in the US. Use annual reports and investor presentations. | decision=ready | ready=1/1",
    );

    expect(weeklyLoop).toContain("# Weekly Learning Loop: 2026-W11");
    expect(weeklyLoop).toContain("learning_principle: check dimensions first (1)");
    expect(weeklyLoop).toContain(
      "transferable_method: keep multi-scale denoising but evaluate with trading-aligned objectives (1)",
    );
    expect(weeklyLoop).toContain("Asset approval and veto state are still unavailable");
    expect(weeklyLoop).toContain("session: 2026-03-15 2026-03-15-simple-math.md");

    expect(unifiedRiskView).toContain("# Unified Risk View");
    expect(unifiedRiskView).toContain("top_decision: ready_for_risk_review: AAPL");
    expect(unifiedRiskView).toContain("approved_assets: []");
    expect(unifiedRiskView).toContain("blackout_status: mixed_research_no_asset_gate");
    expect(unifiedRiskView).toContain(
      "source_branch: frontier_research_branch+fundamental_research_branch",
    );
    expect(unifiedRiskView).toContain("## Carryover Discipline");
    expect(unifiedRiskView).toContain(
      "retain: keep leakage and OOS checks ahead of pretty results.",
    );
    expect(unifiedRiskView).toContain(
      "discard: discard any thesis that survives only on storytelling.",
    );
    expect(unifiedRiskView).toContain(
      "replay: when a result looks too clean, re-check leakage and stale anchors.",
    );
    expect(unifiedRiskView).toContain(
      "next eval: next time test whether the rule changes the risk gate before trusting it.",
    );
    expect(unifiedRiskView).toContain("ready_targets: 1");
    expect(unifiedRiskView).toContain("risk_audit_path: memory/2026-03-15-risk-audit-snapshot.md");
  });

  it("derives risk artifacts from the current frontier session even before a research card exists", async () => {
    const workspaceDir = await createCaseWorkspace();
    const memoryDir = path.join(workspaceDir, "memory");
    const sessionsDir = path.join(workspaceDir, "sessions");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });

    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "frontier-now.jsonl",
      content: createSessionContent([
        {
          role: "user",
          content: [
            "Paper title: WaveLSFormer",
            "Review this paper and decide whether it is worth a small reproduction.",
          ].join("\n"),
        },
        {
          role: "assistant",
          content: [
            "Claimed contribution: multi-scale preprocessing improves signal quality.",
            "Method family: time-series-transformer.",
            "Evaluation protocol: use walk-forward splits and benchmark simpler baselines.",
            "Key results: the multi-scale framing is more reusable than the exact model stack.",
            "Possible leakage points: temporal windowing can leak future information.",
            "The verdict is worth_reproducing because the denoising idea transfers well.",
          ].join(" "),
        },
      ]),
    });

    const event = createHookEvent("command", "reset", "agent:main:main", {
      cfg: makeConfig(workspaceDir),
      commandSource: "cli",
      previousSessionEntry: {
        sessionId: "frontier-now",
        sessionFile,
      },
    });
    event.timestamp = new Date("2026-03-15T14:00:00.000Z");

    await handler(event);

    const fetchLog = await fs.readFile(path.join(memoryDir, "2026-03-15-fetch-log.md"), "utf-8");
    const riskAudit = await fs.readFile(
      path.join(memoryDir, "2026-03-15-risk-audit-snapshot.md"),
      "utf-8",
    );
    const unifiedRiskView = await fs.readFile(
      path.join(memoryDir, "unified-risk-view.md"),
      "utf-8",
    );

    expect(fetchLog).toContain(
      "WaveLSFormer | paper | time-series-transformer | verdict=worth_reproducing",
    );
    expect(riskAudit).toContain("worth_reproducing: WaveLSFormer");
    expect(unifiedRiskView).toContain("top_decision: worth_reproducing: WaveLSFormer");
  });

  it("skips stale writes for protected summary artifacts and records an audit", async () => {
    const workspaceDir = await createCaseWorkspace("stale-summary");
    const memoryDir = path.join(workspaceDir, "memory");
    const sessionsDir = path.join(workspaceDir, "sessions");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });

    await fs.writeFile(
      path.join(memoryDir, "current-research-line.md"),
      createProtectedSummaryFixture({
        generation: Date.parse("2026-03-16T12:00:00.000Z"),
        producedAt: "2026-03-16T12:00:00.000Z",
        sourceRunId: "newer-run",
        body: "# Current Research Line\n\n- sentinel: keep-newer-current\n",
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(memoryDir, "unified-risk-view.md"),
      createProtectedSummaryFixture({
        generation: Date.parse("2026-03-16T12:00:00.000Z"),
        producedAt: "2026-03-16T12:00:00.000Z",
        sourceRunId: "newer-run",
        body: "# Unified Risk View\n\n- sentinel: keep-newer-risk\n",
      }),
      "utf-8",
    );

    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "older-session.jsonl",
      content: createSessionContent([
        { role: "user", content: "Continue the older research line" },
        { role: "assistant", content: "I will summarize the prior state." },
      ]),
    });

    const event = createHookEvent("command", "reset", "agent:main:main", {
      cfg: makeConfig(workspaceDir),
      commandSource: "cli",
      previousSessionEntry: {
        sessionId: "older-session",
        sessionFile,
      },
    });
    event.timestamp = new Date("2026-03-15T12:00:00.000Z");

    await handler(event);

    const currentResearchLine = await fs.readFile(
      path.join(memoryDir, "current-research-line.md"),
      "utf-8",
    );
    const unifiedRiskView = await fs.readFile(
      path.join(memoryDir, "unified-risk-view.md"),
      "utf-8",
    );
    expect(currentResearchLine).toContain("sentinel: keep-newer-current");
    expect(unifiedRiskView).toContain("sentinel: keep-newer-risk");

    const auditsDir = path.join(workspaceDir, "bank", "operating-loop", "write-audits");
    const auditFiles = await fs.readdir(auditsDir);
    expect(auditFiles).toEqual([
      "current-research-line.md-agent-main-main-older-session-reset-2026-03-15T12-00-00.000Z.json",
      "unified-risk-view.md-agent-main-main-older-session-reset-2026-03-15T12-00-00.000Z.json",
    ]);
    const currentAudit = JSON.parse(
      await fs.readFile(path.join(auditsDir, auditFiles[0]), "utf-8"),
    ) as Record<string, unknown>;
    expect(currentAudit.event).toBe("skipped_stale_write");
    expect(currentAudit.reason).toBe("older_generation");
  });

  it("rejects same-generation conflicts for protected summary artifacts", async () => {
    const workspaceDir = await createCaseWorkspace("same-generation-conflict");
    const memoryDir = path.join(workspaceDir, "memory");
    const sessionsDir = path.join(workspaceDir, "sessions");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });

    const generation = Date.parse("2026-03-15T12:00:00.000Z");
    const producedAt = "2026-03-15T12:00:00.000Z";
    await fs.writeFile(
      path.join(memoryDir, "current-research-line.md"),
      createProtectedSummaryFixture({
        generation,
        producedAt,
        sourceRunId: "other-run",
        body: "# Current Research Line\n\n- sentinel: same-generation-current\n",
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(memoryDir, "unified-risk-view.md"),
      createProtectedSummaryFixture({
        generation,
        producedAt,
        sourceRunId: "other-run",
        body: "# Unified Risk View\n\n- sentinel: same-generation-risk\n",
      }),
      "utf-8",
    );

    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "conflict-session.jsonl",
      content: createSessionContent([
        { role: "user", content: "Summarize the current operating loop" },
        { role: "assistant", content: "I will use the current session as context." },
      ]),
    });

    const event = createHookEvent("command", "reset", "agent:main:main", {
      cfg: makeConfig(workspaceDir),
      commandSource: "cli",
      previousSessionEntry: {
        sessionId: "conflict-session",
        sessionFile,
      },
    });
    event.timestamp = new Date(producedAt);

    await handler(event);

    const currentResearchLine = await fs.readFile(
      path.join(memoryDir, "current-research-line.md"),
      "utf-8",
    );
    expect(currentResearchLine).toContain("sentinel: same-generation-current");

    const auditsDir = path.join(workspaceDir, "bank", "operating-loop", "write-audits");
    const currentAudit = JSON.parse(
      await fs.readFile(
        path.join(
          auditsDir,
          "current-research-line.md-agent-main-main-conflict-session-reset-2026-03-15T12-00-00.000Z.json",
        ),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    expect(currentAudit.reason).toBe("same_generation_conflict");
  });

  it("allows newer protected summary writes to replace older ones", async () => {
    const workspaceDir = await createCaseWorkspace("newer-summary");
    const memoryDir = path.join(workspaceDir, "memory");
    const sessionsDir = path.join(workspaceDir, "sessions");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });

    await fs.writeFile(
      path.join(memoryDir, "current-research-line.md"),
      createProtectedSummaryFixture({
        generation: Date.parse("2026-03-14T12:00:00.000Z"),
        producedAt: "2026-03-14T12:00:00.000Z",
        sourceRunId: "older-run",
        body: "# Current Research Line\n\n- sentinel: replace-me-current\n",
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(memoryDir, "unified-risk-view.md"),
      createProtectedSummaryFixture({
        generation: Date.parse("2026-03-14T12:00:00.000Z"),
        producedAt: "2026-03-14T12:00:00.000Z",
        sourceRunId: "older-run",
        body: "# Unified Risk View\n\n- sentinel: replace-me-risk\n",
      }),
      "utf-8",
    );

    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "newer-session.jsonl",
      content: createSessionContent([
        { role: "user", content: "Summarize today's operating loop before reset" },
        { role: "assistant", content: "I can update the current research line." },
      ]),
    });

    const event = createHookEvent("command", "reset", "agent:main:main", {
      cfg: makeConfig(workspaceDir),
      commandSource: "cli",
      previousSessionEntry: {
        sessionId: "newer-session",
        sessionFile,
      },
    });
    event.timestamp = new Date("2026-03-15T12:00:00.000Z");

    await handler(event);

    const currentResearchLine = await fs.readFile(
      path.join(memoryDir, "current-research-line.md"),
      "utf-8",
    );
    const unifiedRiskView = await fs.readFile(
      path.join(memoryDir, "unified-risk-view.md"),
      "utf-8",
    );
    expect(currentResearchLine).toContain("# Current Research Line");
    expect(currentResearchLine).not.toContain("sentinel: replace-me-current");
    expect(currentResearchLine).toContain(
      '"sourceRunId":"agent:main:main:newer-session:reset:2026-03-15T12:00:00.000Z"',
    );
    expect(unifiedRiskView).not.toContain("sentinel: replace-me-risk");
    await expect(
      fs.access(path.join(workspaceDir, "bank", "operating-loop", "write-audits")),
    ).rejects.toThrow();
  });

  it("preserves a paused current research line when refreshing the anchor without a new active session", async () => {
    const workspaceDir = await createCaseWorkspace("paused-line-preserved");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    await fs.writeFile(
      path.join(memoryDir, "current-research-line.md"),
      createProtectedSummaryFixture({
        generation: Date.parse("2026-03-14T12:00:00.000Z"),
        producedAt: "2026-03-14T12:00:00.000Z",
        sourceRunId: "older-run",
        body: [
          "# Current Research Line",
          "",
          "- current_focus: learning_review",
          "- line_status: paused",
          "- top_decision: Keep the ETF timing line paused until the next scheduled review.",
          "- current_session_summary: none",
          "- next_step: Resume only after the next operator check.",
          "- research_guardrail: research-first operating memory only; this is not an execution approval surface",
          "",
        ].join("\n"),
      }),
      "utf-8",
    );
    await fs.writeFile(
      path.join(memoryDir, "2026-03-15-review-paused-line.md"),
      [
        "# Learning Review",
        "",
        "- **Session Key**: agent:main:main",
        "- **Session ID**: learning-session-paused-line",
        "- **Topic**: rates and dollar timing discipline",
        "- mistake_pattern: do not reopen paused lines from vague momentum.",
        "- core_principle: keep paused work paused until the operator reactivates it.",
        "- micro_drill: confirm whether the next review really changes the decision bracket.",
        "- transfer_hint: use explicit status before resuming a stale line.",
        "",
      ].join("\n"),
      "utf-8",
    );

    const event = createHookEvent("command", "reset", "agent:main:main", {
      cfg: makeConfig(workspaceDir),
      commandSource: "cli",
    });
    event.timestamp = new Date("2026-03-15T12:00:00.000Z");

    await handler(event);

    const currentResearchLine = await fs.readFile(
      path.join(memoryDir, "current-research-line.md"),
      "utf-8",
    );
    expect(currentResearchLine).toContain("line_status: paused");
    expect(currentResearchLine).not.toContain("line_status: ready_to_resume");
    expect(currentResearchLine).toContain(
      '"sourceRunId":"agent:main:main:unknown:reset:2026-03-15T12:00:00.000Z"',
    );
  });

  it("only surfaces repeated artifact errors as a lightweight operating concern", async () => {
    const workspaceDir = await createCaseWorkspace("artifact-concern");
    const memoryDir = path.join(workspaceDir, "memory");
    const sessionsDir = path.join(workspaceDir, "sessions");
    const artifactErrorsDir = path.join(workspaceDir, "bank", "fundamental", "artifact-errors");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.mkdir(artifactErrorsDir, { recursive: true });

    await fs.writeFile(
      path.join(artifactErrorsDir, "snapshot-msft-artifact-error.json"),
      `${JSON.stringify(
        {
          version: 1,
          generatedAt: "2026-03-15T13:00:00.000Z",
          firstSeenAt: "2026-03-15T12:00:00.000Z",
          lastSeenAt: "2026-03-15T13:00:00.000Z",
          occurrenceCount: 2,
          stage: "snapshot",
          manifestId: "msft-artifact-error",
          relativePath: "bank/fundamental/readiness/msft-artifact-error.json",
          errorStatus: "blocked_due_to_artifact_error",
          errorFingerprint:
            "snapshot::bank/fundamental/readiness/msft-artifact-error.json::broken json",
          errorMessage: "broken json",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "artifact-session.jsonl",
      content: createSessionContent([
        { role: "user", content: "Continue the operating loop" },
        { role: "assistant", content: "I will refresh the daily memory anchors." },
      ]),
    });

    const event = createHookEvent("command", "reset", "agent:main:main", {
      cfg: makeConfig(workspaceDir),
      commandSource: "cli",
      previousSessionEntry: {
        sessionId: "artifact-session",
        sessionFile,
      },
    });
    event.timestamp = new Date("2026-03-15T14:00:00.000Z");

    await handler(event);

    const currentResearchLine = await fs.readFile(
      path.join(memoryDir, "current-research-line.md"),
      "utf-8",
    );
    expect(currentResearchLine).toContain(
      "active_artifact_error: snapshot/msft-artifact-error x2 last_seen=2026-03-15T13:00:00.000Z",
    );
  });
});
