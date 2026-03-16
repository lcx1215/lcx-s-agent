import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import { createHookEvent } from "../../hooks.js";
import type { HookHandler } from "../../hooks.js";

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

    expect(riskAudit).toContain("# Risk Audit Snapshot: 2026-03-15");
    expect(riskAudit).toContain("**Risk Scope**: methods-only");
    expect(riskAudit).toContain("temporal windowing can leak future information");

    expect(weeklyLoop).toContain("# Weekly Learning Loop: 2026-W11");
    expect(weeklyLoop).toContain("learning_principle: check dimensions first (1)");
    expect(weeklyLoop).toContain(
      "transferable_method: keep multi-scale denoising but evaluate with trading-aligned objectives (1)",
    );
    expect(weeklyLoop).toContain("Asset approval and veto state are still unavailable");
    expect(weeklyLoop).toContain("session: 2026-03-15 2026-03-15-simple-math.md");

    expect(unifiedRiskView).toContain("# Unified Risk View");
    expect(unifiedRiskView).toContain("top_decision: worth_reproducing: WaveLSFormer");
    expect(unifiedRiskView).toContain("approved_assets: []");
    expect(unifiedRiskView).toContain("blackout_status: method_only_no_asset_gate");
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
});
