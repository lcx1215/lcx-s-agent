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
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-frontier-weekly-"));
});

afterAll(async () => {
  if (!suiteWorkspaceRoot) {
    return;
  }
  await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  suiteWorkspaceRoot = "";
  workspaceCaseCounter = 0;
});

describe("frontier-research-weekly hook", () => {
  it("aggregates recent frontier research cards into a weekly review", async () => {
    const workspaceDir = await createCaseWorkspace();
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-03-15-frontier-research-wave.md",
      content: [
        "# Frontier Research Card",
        "",
        "## Research Card",
        "- title: WaveLSFormer",
        "- material_type: paper",
        "- method_family: time-series-transformer",
        "- claimed_contribution: multi-scale preprocessing improves signal quality",
        "- data_setup: historical market time series with enough lookback for decomposition",
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
      name: "2026-03-14-frontier-research-factor.md",
      content: [
        "# Frontier Research Card",
        "",
        "## Research Card",
        "- title: Adaptive Factor Stack",
        "- material_type: paper",
        "- method_family: factor-model",
        "- claimed_contribution: factor timing adaptation may improve ranking stability",
        "- data_setup: cross-sectional market data with a defined universe and rebalance schedule",
        "- evaluation_protocol: check turnover, costs, and out-of-sample decay",
        "- key_results: the timing discipline matters more than the exact stack",
        "- possible_leakage_points: rebalance timing may hide benchmark contamination",
        "- overfitting_risks: over-tuned factors decay out of sample",
        "- replication_cost: medium",
        "- adoptable_ideas: separate factor intuition from implementation timing",
        "- verdict: watch_for_followup",
      ].join("\n"),
    });

    const event = createHookEvent("command", "reset", "agent:main:main", {
      cfg: makeConfig(workspaceDir),
    });
    event.timestamp = new Date("2026-03-15T12:00:00.000Z");

    await handler(event);

    const files = await fs.readdir(memoryDir);
    const weeklyFile = files.find((name) => name.endsWith("frontier-methods-weekly-review.md"));
    const upgradeFile = files.find((name) => name.endsWith("frontier-upgrade.md"));
    const backlogFile = files.find((name) => name.endsWith("frontier-replication-backlog.md"));
    expect(weeklyFile).toBe("2026-W11-frontier-methods-weekly-review.md");
    expect(upgradeFile).toBe("2026-W11-frontier-upgrade.md");
    expect(backlogFile).toBe("2026-W11-frontier-replication-backlog.md");
    const content = await fs.readFile(path.join(memoryDir, weeklyFile!), "utf-8");
    const upgradeContent = await fs.readFile(path.join(memoryDir, upgradeFile!), "utf-8");
    const backlogContent = await fs.readFile(path.join(memoryDir, backlogFile!), "utf-8");
    expect(content).toContain("# Weekly Methods Review: 2026-W11");
    expect(content).toContain("**Cards Reviewed**: 2");
    expect(content).toContain("worth_reproducing (1)");
    expect(content).toContain("watch_for_followup (1)");
    expect(content).toContain("## Worth Reproducing");
    expect(content).toContain("- WaveLSFormer");
    expect(content).toContain("## Watch For Followup");
    expect(content).toContain("- Adaptive Factor Stack");
    expect(upgradeContent).toContain("# Frontier Upgrade Prompt: 2026-W11");
    expect(upgradeContent).toContain("**Primary Research Candidate**: WaveLSFormer");
    expect(upgradeContent).toContain("**Primary Verdict**: worth_reproducing");
    expect(upgradeContent).toContain("**Main Leakage Check**: temporal windowing can leak future information");
    expect(backlogContent).toContain("# Frontier Replication Backlog: 2026-W11");
    expect(backlogContent).toContain("## WaveLSFormer");
    expect(backlogContent).toContain("evaluation_protocol: use walk-forward splits and benchmark simpler baselines");
    expect(backlogContent).not.toContain("Adaptive Factor Stack");
  });

  it("does nothing when no recent frontier cards exist", async () => {
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
