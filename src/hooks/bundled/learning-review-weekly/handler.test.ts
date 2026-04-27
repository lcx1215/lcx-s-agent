import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import { createHookEvent } from "../../hooks.js";
import type { HookHandler } from "../../hooks.js";
import {
  buildLearningCouncilMemoryNoteFilename,
  buildLearningRecallFilename,
  renderLearningCouncilMemoryNote,
} from "../lobster-brain-registry.js";

let handler: HookHandler;
let suiteWorkspaceRoot = "";
let workspaceCaseCounter = 0;

async function createCaseWorkspace(prefix = "weekly"): Promise<string> {
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

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-review-weekly-"));
});

afterAll(async () => {
  if (!suiteWorkspaceRoot) {
    return;
  }
  await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  suiteWorkspaceRoot = "";
  workspaceCaseCounter = 0;
});

describe("learning-review-weekly hook", () => {
  it("aggregates recent review notes into a weekly summary", async () => {
    const workspaceDir = await createCaseWorkspace();
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-03-15-review-linear-algebra.md",
      content: [
        "# Learning Review",
        "",
        "- **Topic**: linear-algebra",
        "",
        "## Review Note",
        "- mistake_pattern: skipped dimension checks",
        "- core_principle: check dimensions first",
        "- micro_drill: write dimensions before multiplying matrices",
        "- transfer_hint: helps with PCA and regression",
        "",
        "## Lobster Transfer",
        "- foundation_template: risk-transmission",
      ].join("\n"),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-03-14-review-linear-algebra.md",
      content: [
        "# Learning Review",
        "",
        "- **Topic**: linear-algebra",
        "",
        "## Review Note",
        "- mistake_pattern: skipped dimension checks",
        "- core_principle: check dimensions first",
        "- micro_drill: write dimensions before multiplying matrices",
        "- transfer_hint: helps with PCA and regression",
        "",
        "## Lobster Transfer",
        "- foundation_template: risk-transmission",
      ].join("\n"),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-03-10-review-probability.md",
      content: [
        "# Learning Review",
        "",
        "- **Topic**: probability-and-statistics",
        "",
        "## Review Note",
        "- mistake_pattern: skipped event definitions",
        "- core_principle: define events first",
        "- micro_drill: define A and B before using Bayes",
        "- transfer_hint: helps with hypothesis testing",
        "",
        "## Lobster Transfer",
        "- foundation_template: outcome-review",
      ].join("\n"),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-02-20-review-quant.md",
      content: [
        "# Learning Review",
        "",
        "- **Topic**: quant-modeling",
        "",
        "## Review Note",
        "- mistake_pattern: trusted in-sample Sharpe too early",
        "- core_principle: test OOS before trusting the edge",
        "- micro_drill: add one walk-forward check before ranking the signal",
        "- transfer_hint: helps with strategy audit and candidate ranking",
        "",
        "## Lobster Transfer",
        "- foundation_template: portfolio-sizing-discipline",
      ].join("\n"),
    });

    const event = createHookEvent("command", "reset", "agent:main:main", {
      cfg: makeConfig(workspaceDir),
    });
    event.timestamp = new Date("2026-03-15T12:00:00.000Z");

    await handler(event);

    const files = await fs.readdir(memoryDir);
    const weeklyFile = files.find((name) => name.endsWith("learning-weekly-review.md"));
    const upgradeFile = files.find((name) => name.endsWith("learning-upgrade.md"));
    const catalogFile = files.find((name) => name.endsWith("learning-long-term-catalog.md"));
    const durableSkillsFile = files.find((name) => name.endsWith("learning-durable-skills.md"));
    const triggerMapFile = files.find((name) => name.endsWith("learning-trigger-map.md"));
    const rehearsalQueueFile = files.find((name) => name.endsWith("learning-rehearsal-queue.md"));
    const transferBridgesFile = files.find((name) => name.endsWith("learning-transfer-bridges.md"));
    const relevanceGateFile = files.find((name) => name.endsWith("learning-relevance-gate.md"));
    expect(weeklyFile).toBe(buildLearningRecallFilename("2026-W11", "learning-weekly-review"));
    expect(upgradeFile).toBe(buildLearningRecallFilename("2026-W11", "learning-upgrade"));
    expect(catalogFile).toBe(buildLearningRecallFilename("2026-W11", "learning-long-term-catalog"));
    expect(durableSkillsFile).toBe(
      buildLearningRecallFilename("2026-W11", "learning-durable-skills"),
    );
    expect(triggerMapFile).toBe(buildLearningRecallFilename("2026-W11", "learning-trigger-map"));
    expect(rehearsalQueueFile).toBe(
      buildLearningRecallFilename("2026-W11", "learning-rehearsal-queue"),
    );
    expect(transferBridgesFile).toBe(
      buildLearningRecallFilename("2026-W11", "learning-transfer-bridges"),
    );
    expect(relevanceGateFile).toBe(
      buildLearningRecallFilename("2026-W11", "learning-relevance-gate"),
    );
    const content = await fs.readFile(path.join(memoryDir, weeklyFile!), "utf-8");
    const upgradeContent = await fs.readFile(path.join(memoryDir, upgradeFile!), "utf-8");
    const catalogContent = await fs.readFile(path.join(memoryDir, catalogFile!), "utf-8");
    const durableSkillsContent = await fs.readFile(
      path.join(memoryDir, durableSkillsFile!),
      "utf-8",
    );
    const triggerMapContent = await fs.readFile(path.join(memoryDir, triggerMapFile!), "utf-8");
    const rehearsalQueueContent = await fs.readFile(
      path.join(memoryDir, rehearsalQueueFile!),
      "utf-8",
    );
    const transferBridgesContent = await fs.readFile(
      path.join(memoryDir, transferBridgesFile!),
      "utf-8",
    );
    const relevanceGateContent = await fs.readFile(
      path.join(memoryDir, relevanceGateFile!),
      "utf-8",
    );
    expect(content).toContain("# Weekly Learning Review: 2026-W11");
    expect(content).toContain("**Review Count**: 3");
    expect(content).toContain("**Stable Topic Count**: 1");
    expect(content).toContain("**Fragile Topic Count**: 1");
    expect(content).toContain("**New Topic Count**: 0");
    expect(content).toContain("## Stable Topics");
    expect(content).toContain(
      "- linear-algebra (2, last seen 2026-03-15) - anchor: check dimensions first - state: stable",
    );
    expect(content).toContain("## Fragile Topics");
    expect(content).toContain(
      "- probability-and-statistics (1, last seen 2026-03-10) - anchor: define events first - state: fragile",
    );
    expect(content).toContain("## New Topics");
    expect(content).toContain("## Learning Priorities");
    expect(content).toContain("### Do Now");
    expect(content).toContain(
      "- probability-and-statistics (do-now, fragile) - next drill: define A and B before using Bayes",
    );
    expect(content).toContain("### Park");
    expect(content).toContain(
      "- linear-algebra (park, stable) - next drill: write dimensions before multiplying matrices",
    );
    expect(content).toContain("skipped dimension checks (2)");
    expect(content).toContain("check dimensions first (2)");
    expect(content).toContain("## Foundation Template Focus");
    expect(content).toContain("risk-transmission (2)");
    expect(content).toContain("outcome-review (1)");
    expect(content).toContain("## Next Week Focus");
    expect(content).toContain("probability-and-statistics: define A and B before using Bayes");
    expect(content).toContain("## Upgrade Prompt");
    expect(content).toContain("**Main Failure To Avoid**: skipped dimension checks");
    expect(content).toContain("**Default Method To Apply**: check dimensions first");
    expect(upgradeContent).toContain("# Learning Upgrade Prompt: 2026-W11");
    expect(upgradeContent).toContain("**Main Failure To Avoid**: skipped dimension checks");
    expect(upgradeContent).toContain("**Default Method To Apply**: check dimensions first");
    expect(upgradeContent).toContain("**Stable Topic To Reuse**: linear-algebra (stable)");
    expect(upgradeContent).toContain(
      "**Top Topic To Reinforce**: probability-and-statistics (fragile)",
    );
    expect(upgradeContent).toContain("**Do Now**: probability-and-statistics (do-now)");
    expect(upgradeContent).toContain("**Do Next**: linear-algebra (do-next)");
    expect(upgradeContent).toContain("**Park**: linear-algebra (park)");
    expect(upgradeContent).toContain("**Next Micro-Drill**: define A and B before using Bayes");
    expect(upgradeContent).toContain("**Dominant Foundation Template**: risk-transmission");
    expect(upgradeContent).toContain("route the work through risk-transmission");
    expect(catalogContent).toContain("# Learning Long-Term Catalog: 2026-W11");
    expect(catalogContent).toContain("**Total Review Count**: 4");
    expect(catalogContent).toContain("**Tracked Topic Count**: 3");
    expect(catalogContent).toContain(
      "quant-modeling (1, last seen 2026-02-20) - state: fragile - priority: do-now - anchor: test OOS before trusting the edge",
    );
    expect(catalogContent).toContain(
      "linear-algebra (2, last seen 2026-03-15) - state: stable - priority: park - anchor: check dimensions first",
    );
    expect(durableSkillsContent).toContain("# Learning Durable Skills: 2026-W11");
    expect(durableSkillsContent).toContain("### quant-modeling");
    expect(durableSkillsContent).toContain("- default_method: test OOS before trusting the edge");
    expect(durableSkillsContent).toContain("### linear-algebra");
    expect(durableSkillsContent).toContain("- common_failure: skipped dimension checks");
    expect(triggerMapContent).toContain("# Learning Trigger Map: 2026-W11");
    expect(triggerMapContent).toContain("### quant-modeling");
    expect(triggerMapContent).toContain(
      "- when_you_see: backtest, factor, alpha, ranking, Sharpe, OOS, leakage, or parameter-fragility questions",
    );
    expect(triggerMapContent).toContain("- apply: test OOS before trusting the edge");
    expect(rehearsalQueueContent).toContain("# Learning Rehearsal Queue: 2026-W11");
    expect(rehearsalQueueContent).toContain("## Do Now");
    expect(rehearsalQueueContent).toContain(
      "- quant-modeling (fragile) - drill: add one walk-forward check before ranking the signal - apply: test OOS before trusting the edge",
    );
    expect(rehearsalQueueContent).toContain("## Park");
    expect(rehearsalQueueContent).toContain(
      "- linear-algebra (stable) - drill: write dimensions before multiplying matrices - apply: check dimensions first",
    );
    expect(transferBridgesContent).toContain("# Learning Transfer Bridges: 2026-W11");
    expect(transferBridgesContent).toContain("### quant-modeling");
    expect(transferBridgesContent).toContain(
      "- transfer_to: helps with strategy audit and candidate ranking",
    );
    expect(transferBridgesContent).toContain("- reuse_rule: test OOS before trusting the edge");
    expect(relevanceGateContent).toContain("# Learning Relevance Gate: 2026-W11");
    expect(relevanceGateContent).toContain("## Primary Call");
    expect(relevanceGateContent).toContain(
      "- linear-algebra (2, last seen 2026-03-15) - default method: check dimensions first",
    );
    expect(relevanceGateContent).toContain("## Reference Only");
    expect(relevanceGateContent).toContain(
      "- quant-modeling (1, last seen 2026-02-20) - default method: test OOS before trusting the edge",
    );
  });

  it("promotes bounded learning-council notes into weekly learning memory", async () => {
    const workspaceDir = await createCaseWorkspace();
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: buildLearningCouncilMemoryNoteFilename({
        dateStr: "2026-03-15",
        noteSlug: "agent-architecture",
      }),
      content: renderLearningCouncilMemoryNote({
        stem: "agent-architecture",
        generatedAt: "2026-03-15T12:00:00.000Z",
        status: "full",
        userMessage:
          "帮我学习这个 GitHub repo 和 AI 智能体架构，重点看 system design、workflow、shared state 和失败路径。",
        mutableFactWarnings: 0,
        failedRolesSummary: "none",
        finalReplySnapshot: "先写输入、状态、失败、验收四栏，再决定这套架构值不值得迁移。",
        keeperLines: ["先把输入、状态、失败、验收四栏写清，再决定架构值不值得迁移。"],
        discardLines: ["丢掉只会列组件、不会说明失败面和状态流的架构总结。"],
        rehearsalTriggerLines: [
          "当一个新 agent 架构听起来很强，但没讲共享状态和回退路径时，重新想起这条规则。",
        ],
        nextEvalCueLines: ["拿最近一个 Lobster 流程故障，检查这套架构有没有明确的人接管点。"],
      }),
    });

    const event = createHookEvent("command", "reset", "agent:main:main", {
      cfg: makeConfig(workspaceDir),
    });
    event.timestamp = new Date("2026-03-15T12:00:00.000Z");

    await handler(event);

    const weeklyPath = path.join(
      memoryDir,
      buildLearningRecallFilename("2026-W11", "learning-weekly-review"),
    );
    const weeklyContent = await fs.readFile(weeklyPath, "utf-8");
    expect(weeklyContent).toContain("**Review Count**: 1");
    expect(weeklyContent).toContain("agent-architecture-and-workflows");
    expect(weeklyContent).toContain("先把输入、状态、失败、验收四栏写清，再决定架构值不值得迁移。");
    expect(weeklyContent).toContain("丢掉只会列组件、不会说明失败面和状态流的架构总结。");
    expect(weeklyContent).toContain(
      buildLearningCouncilMemoryNoteFilename({
        dateStr: "2026-03-15",
        noteSlug: "agent-architecture",
      }),
    );
    const rehearsalQueuePath = path.join(
      memoryDir,
      buildLearningRecallFilename("2026-W11", "learning-rehearsal-queue"),
    );
    const rehearsalQueueContent = await fs.readFile(rehearsalQueuePath, "utf-8");
    expect(rehearsalQueueContent).toContain(
      "拿最近一个 Lobster 流程故障，检查这套架构有没有明确的人接管点。",
    );
    expect(rehearsalQueueContent).toContain(
      "先把输入、状态、失败、验收四栏写清，再决定架构值不值得迁移。",
    );
  });

  it("does nothing when no recent review notes exist", async () => {
    const workspaceDir = await createCaseWorkspace();
    const event = createHookEvent("command", "new", "agent:main:main", {
      cfg: makeConfig(workspaceDir),
    });
    event.timestamp = new Date("2026-03-15T12:00:00.000Z");

    await handler(event);

    const memoryDir = path.join(workspaceDir, "memory");
    await expect(fs.readdir(memoryDir)).resolves.toEqual([]);
  });
});
