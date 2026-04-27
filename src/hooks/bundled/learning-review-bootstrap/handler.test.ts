import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import type { AgentBootstrapHookContext } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";
import {
  buildLearningRecallFilename,
  type LearningRecallMemoryNote,
} from "../lobster-brain-registry.js";
import handler from "./handler.js";

function createConfig(recentCount = 3): OpenClawConfig {
  return {
    hooks: {
      internal: {
        entries: {
          "learning-review-bootstrap": {
            enabled: true,
            recentCount,
          },
        },
      },
    },
  };
}

async function createContext(params: {
  workspaceDir: string;
  sessionKey: string;
  cfg: OpenClawConfig;
}): Promise<AgentBootstrapHookContext> {
  return {
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    cfg: params.cfg,
    bootstrapFiles: [
      {
        name: "AGENTS.md",
        path: await writeWorkspaceFile({
          dir: params.workspaceDir,
          name: "AGENTS.md",
          content: "root agents",
        }),
        content: "root agents",
        missing: false,
      },
    ],
  };
}

function learningFile(weekKey: string, noteName: LearningRecallMemoryNote): string {
  return buildLearningRecallFilename(weekKey, noteName);
}

describe("learning-review-bootstrap hook", () => {
  it("injects recent review notes into bootstrap context", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-learning-review-bootstrap-");
    const memoryDir = path.join(workspaceDir, "memory");
    const weekKey = "2026-W11";
    await fs.mkdir(memoryDir, { recursive: true });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: learningFile(weekKey, "learning-weekly-review"),
      content: "# Weekly Learning Review\n\n- Review Count: 2",
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: learningFile(weekKey, "learning-upgrade"),
      content: [
        "# Learning Upgrade Prompt: 2026-W11",
        "",
        "- **Window**: 2026-03-09 to 2026-03-15",
        "- **Main Failure To Avoid**: skipped dimension checks",
        "- **Default Method To Apply**: check dimensions first",
        "- **Stable Topic To Reuse**: linear-algebra",
        "- **Top Topic To Reinforce**: probability-and-statistics",
        "- **Next Micro-Drill**: define A and B before using Bayes",
      ].join("\n"),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: learningFile(weekKey, "learning-durable-skills"),
      content: [
        "# Learning Durable Skills: 2026-W11",
        "",
        "### quant-modeling",
        "- learned_count: 2",
        "- default_method: test OOS before trusting the edge",
        "- common_failure: trusted in-sample Sharpe too early",
        "- next_drill: add one walk-forward check before ranking the signal",
      ].join("\n"),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: learningFile(weekKey, "learning-long-term-catalog"),
      content: "# Learning Long-Term Catalog: 2026-W11\n\n- **Tracked Topic Count**: 3",
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: learningFile(weekKey, "learning-trigger-map"),
      content: [
        "# Learning Trigger Map: 2026-W11",
        "",
        "### quant-modeling",
        "- when_you_see: backtest, factor, alpha, ranking, Sharpe, OOS, leakage, or parameter-fragility questions",
        "- apply: test OOS before trusting the edge",
        "- avoid: trusted in-sample Sharpe too early",
      ].join("\n"),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: learningFile(weekKey, "learning-rehearsal-queue"),
      content: [
        "# Learning Rehearsal Queue: 2026-W11",
        "",
        "## Do Now",
        "- quant-modeling (fragile) - drill: add one walk-forward check before ranking the signal - apply: test OOS before trusting the edge",
      ].join("\n"),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: learningFile(weekKey, "learning-transfer-bridges"),
      content: [
        "# Learning Transfer Bridges: 2026-W11",
        "",
        "### quant-modeling",
        "- transfer_to: helps with strategy audit and candidate ranking",
        "- reuse_rule: test OOS before trusting the edge",
      ].join("\n"),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: learningFile(weekKey, "learning-relevance-gate"),
      content: [
        "# Learning Relevance Gate: 2026-W11",
        "",
        "## Primary Call",
        "- quant-modeling (2, last seen 2026-03-15) - default method: test OOS before trusting the edge",
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
        "- keep: trust walk-forward before trusting in-sample Sharpe.",
        "- discard: do not let pretty factor tearsheets override OOS weakness.",
        "- replay: when a backtest looks too clean, rerun the leakage and OOS checks first.",
        "- next eval: next batch verify the rule changes the actual ranking gate before keeping it.",
      ].join("\n"),
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-03-15-review-linear-algebra.md",
      content: "# Learning Review\n\n- core_principle: check dimensions first",
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-03-14-review-probability.md",
      content: "# Learning Review\n\n- core_principle: define events first",
    });

    const context = await createContext({
      workspaceDir,
      sessionKey: "agent:main:main",
      cfg: createConfig(),
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    const injected = context.bootstrapFiles.find((file) =>
      file.path.endsWith("_learning-review-bootstrap.md"),
    );
    expect(injected).toBeTruthy();
    expect(injected?.name).toBe("memory.md");
    expect(injected?.content ?? "").toContain("Recent Learning Reviews");
    expect(injected?.content ?? "").toContain("Immediate Study Cue");
    expect(injected?.content ?? "").toContain("- avoid: skipped dimension checks");
    expect(injected?.content ?? "").toContain("- apply: check dimensions first");
    expect(injected?.content ?? "").toContain("Latest Learning Carryover Cue");
    expect(injected?.content ?? "").toContain(
      "- retain: trust walk-forward before trusting in-sample Sharpe.",
    );
    expect(injected?.content ?? "").toContain(
      "- discard: do not let pretty factor tearsheets override OOS weakness.",
    );
    expect(injected?.content ?? "").toContain(
      "- replay: when a backtest looks too clean, rerun the leakage and OOS checks first.",
    );
    expect(injected?.content ?? "").toContain("- next eval: next batch verify the rule changes");
    expect(injected?.content ?? "").toContain("Durable Skill Cue");
    expect(injected?.content ?? "").toContain("- default topic: quant-modeling");
    expect(injected?.content ?? "").toContain(
      "- default method: test OOS before trusting the edge",
    );
    expect(injected?.content ?? "").toContain("Learning Trigger Cue");
    expect(injected?.content ?? "").toContain(
      "- when you see: backtest, factor, alpha, ranking, Sharpe, OOS, leakage, or parameter-fragility questions",
    );
    expect(injected?.content ?? "").toContain("Learning Rehearsal Cue");
    expect(injected?.content ?? "").toContain(
      "- quant-modeling (fragile) - drill: add one walk-forward check before ranking the signal - apply: test OOS before trusting the edge",
    );
    expect(injected?.content ?? "").toContain("Learning Transfer Cue");
    expect(injected?.content ?? "").toContain(
      "- transfer to: helps with strategy audit and candidate ranking",
    );
    expect(injected?.content ?? "").toContain("- reuse rule: test OOS before trusting the edge");
    expect(injected?.content ?? "").toContain("Learning Relevance Cue");
    expect(injected?.content ?? "").toContain(
      "- quant-modeling (2, last seen 2026-03-15) - default method: test OOS before trusting the edge",
    );
    expect(injected?.content ?? "").toContain("Priority Learning Trigger Map");
    expect(injected?.content ?? "").toContain(learningFile(weekKey, "learning-trigger-map"));
    expect(injected?.content ?? "").toContain("Priority Learning Rehearsal Queue");
    expect(injected?.content ?? "").toContain(learningFile(weekKey, "learning-rehearsal-queue"));
    expect(injected?.content ?? "").toContain("Priority Learning Transfer Bridges");
    expect(injected?.content ?? "").toContain(learningFile(weekKey, "learning-transfer-bridges"));
    expect(injected?.content ?? "").toContain("Priority Learning Relevance Gate");
    expect(injected?.content ?? "").toContain(learningFile(weekKey, "learning-relevance-gate"));
    expect(injected?.content ?? "").toContain("Priority Durable Skills");
    expect(injected?.content ?? "").toContain(learningFile(weekKey, "learning-durable-skills"));
    expect(injected?.content ?? "").toContain("Priority Learning Upgrade");
    expect(injected?.content ?? "").toContain(learningFile(weekKey, "learning-upgrade"));
    expect(injected?.content ?? "").toContain(learningFile(weekKey, "learning-weekly-review"));
    expect(injected?.content ?? "").toContain("Long-Term Learning Catalog");
    expect(injected?.content ?? "").toContain(learningFile(weekKey, "learning-long-term-catalog"));
    expect(injected?.content ?? "").toContain("2026-03-15-review-linear-algebra.md");
    expect(injected?.content ?? "").toContain("2026-03-14-review-probability.md");
    expect(
      (injected?.content ?? "").indexOf(learningFile(weekKey, "learning-durable-skills")),
    ).toBeLessThan(
      (injected?.content ?? "").indexOf(learningFile(weekKey, "learning-upgrade")) ??
        Number.MAX_SAFE_INTEGER,
    );
    expect(
      (injected?.content ?? "").indexOf(learningFile(weekKey, "learning-trigger-map")),
    ).toBeLessThan(
      (injected?.content ?? "").indexOf(learningFile(weekKey, "learning-durable-skills")) ??
        Number.MAX_SAFE_INTEGER,
    );
    expect((injected?.content ?? "").indexOf("Latest Learning Carryover Cue")).toBeLessThan(
      (injected?.content ?? "").indexOf("Durable Skill Cue") ?? Number.MAX_SAFE_INTEGER,
    );
    expect(
      (injected?.content ?? "").indexOf(learningFile(weekKey, "learning-rehearsal-queue")),
    ).toBeLessThan(
      (injected?.content ?? "").indexOf(learningFile(weekKey, "learning-upgrade")) ??
        Number.MAX_SAFE_INTEGER,
    );
    expect(
      (injected?.content ?? "").indexOf(learningFile(weekKey, "learning-transfer-bridges")),
    ).toBeLessThan(
      (injected?.content ?? "").indexOf(learningFile(weekKey, "learning-upgrade")) ??
        Number.MAX_SAFE_INTEGER,
    );
    expect(
      (injected?.content ?? "").indexOf(learningFile(weekKey, "learning-relevance-gate")),
    ).toBeLessThan(
      (injected?.content ?? "").indexOf(learningFile(weekKey, "learning-upgrade")) ??
        Number.MAX_SAFE_INTEGER,
    );
    expect(
      (injected?.content ?? "").indexOf(learningFile(weekKey, "learning-upgrade")),
    ).toBeLessThan(
      (injected?.content ?? "").indexOf(learningFile(weekKey, "learning-weekly-review")) ??
        Number.MAX_SAFE_INTEGER,
    );
    expect(
      (injected?.content ?? "").indexOf(learningFile(weekKey, "learning-weekly-review")),
    ).toBeLessThan(
      (injected?.content ?? "").indexOf("2026-03-15-review-linear-algebra.md") ??
        Number.MAX_SAFE_INTEGER,
    );
    expect(
      (injected?.content ?? "").match(
        new RegExp(learningFile(weekKey, "learning-weekly-review").replace(".", "\\."), "g"),
      ),
    ).toHaveLength(1);
  });

  it("re-applies subagent allowlist and skips synthetic memory for subagents", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-learning-review-bootstrap-subagent-");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-03-15-review-proof.md",
      content: "# Learning Review\n\n- core_principle: do not assume the conclusion",
    });

    const context = await createContext({
      workspaceDir,
      sessionKey: "agent:main:subagent:abc",
      cfg: createConfig(),
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:subagent:abc", context);
    await handler(event);

    expect(context.bootstrapFiles.map((file) => file.name)).toEqual(["AGENTS.md"]);
  });

  it("still injects aggregated learning memory when only upgrade and weekly notes exist", async () => {
    const workspaceDir = await makeTempWorkspace(
      "openclaw-learning-review-bootstrap-aggregate-only-",
    );
    const memoryDir = path.join(workspaceDir, "memory");
    const weekKey = "2026-W11";
    await fs.mkdir(memoryDir, { recursive: true });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: learningFile(weekKey, "learning-weekly-review"),
      content: "# Weekly Learning Review\n\n- Review Count: 2",
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: learningFile(weekKey, "learning-upgrade"),
      content: "# Learning Upgrade Prompt\n\n- Main Failure To Avoid: skipped dimension checks",
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: learningFile(weekKey, "learning-durable-skills"),
      content: "# Learning Durable Skills: 2026-W11\n\n### coding-and-systems",
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: learningFile(weekKey, "learning-trigger-map"),
      content: "# Learning Trigger Map: 2026-W11\n\n### coding-and-systems",
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: learningFile(weekKey, "learning-rehearsal-queue"),
      content: "# Learning Rehearsal Queue: 2026-W11\n\n## Do Now\n- coding-and-systems (new)",
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: learningFile(weekKey, "learning-transfer-bridges"),
      content: "# Learning Transfer Bridges: 2026-W11\n\n### coding-and-systems",
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: learningFile(weekKey, "learning-relevance-gate"),
      content: "# Learning Relevance Gate: 2026-W11\n\n## Primary Call\n- coding-and-systems",
    });

    const context = await createContext({
      workspaceDir,
      sessionKey: "agent:main:main",
      cfg: createConfig(),
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    const injected = context.bootstrapFiles.find((file) =>
      file.path.endsWith("_learning-review-bootstrap.md"),
    );
    expect(injected?.content ?? "").toContain(learningFile(weekKey, "learning-relevance-gate"));
    expect(injected?.content ?? "").toContain(learningFile(weekKey, "learning-transfer-bridges"));
    expect(injected?.content ?? "").toContain(learningFile(weekKey, "learning-rehearsal-queue"));
    expect(injected?.content ?? "").toContain(learningFile(weekKey, "learning-trigger-map"));
    expect(injected?.content ?? "").toContain(learningFile(weekKey, "learning-durable-skills"));
    expect(injected?.content ?? "").toContain(learningFile(weekKey, "learning-upgrade"));
    expect(injected?.content ?? "").toContain(learningFile(weekKey, "learning-weekly-review"));
  });

  it("still injects the latest learning carryover when only workface memory exists", async () => {
    const workspaceDir = await makeTempWorkspace(
      "openclaw-learning-review-bootstrap-workface-only-",
    );
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-03-15-lobster-workface.md",
      content: [
        "# Lobster Workface: 2026-03-15",
        "",
        "## Yesterday Learned",
        "",
        "- keep: keep one concrete rule instead of a vague study summary.",
        "- discard: discard learning notes that never change the next batch.",
        "- replay: when the same failure shape returns, replay the concrete fix first.",
        "- next eval: next batch verify the carryover cue still appears without weekly notes.",
      ].join("\n"),
    });

    const context = await createContext({
      workspaceDir,
      sessionKey: "agent:main:main",
      cfg: createConfig(),
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    const injected = context.bootstrapFiles.find((file) =>
      file.path.endsWith("_learning-review-bootstrap.md"),
    );
    expect(injected).toBeTruthy();
    expect(injected?.content ?? "").toContain("Latest Learning Carryover Cue");
    expect(injected?.content ?? "").toContain(
      "- retain: keep one concrete rule instead of a vague study summary.",
    );
    expect(injected?.content ?? "").toContain(
      "- discard: discard learning notes that never change the next batch.",
    );
    expect(injected?.content ?? "").toContain(
      "- replay: when the same failure shape returns, replay the concrete fix first.",
    );
    expect(injected?.content ?? "").toContain(
      "- next eval: next batch verify the carryover cue still appears without weekly notes.",
    );
  });
});
