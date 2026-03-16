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
    expect(weeklyFile).toBe("2026-W11-learning-weekly-review.md");
    expect(upgradeFile).toBe("2026-W11-learning-upgrade.md");
    const content = await fs.readFile(path.join(memoryDir, weeklyFile!), "utf-8");
    const upgradeContent = await fs.readFile(path.join(memoryDir, upgradeFile!), "utf-8");
    expect(content).toContain("# Weekly Learning Review: 2026-W11");
    expect(content).toContain("**Review Count**: 3");
    expect(content).toContain("**Stable Topic Count**: 1");
    expect(content).toContain("**Fragile Topic Count**: 1");
    expect(content).toContain("**New Topic Count**: 0");
    expect(content).toContain("## Stable Topics");
    expect(content).toContain("- linear-algebra (2, last seen 2026-03-15) - anchor: check dimensions first - state: stable");
    expect(content).toContain("## Fragile Topics");
    expect(content).toContain("- probability-and-statistics (1, last seen 2026-03-10) - anchor: define events first - state: fragile");
    expect(content).toContain("## New Topics");
    expect(content).toContain("## Learning Priorities");
    expect(content).toContain("### Do Now");
    expect(content).toContain("- probability-and-statistics (do-now, fragile) - next drill: define A and B before using Bayes");
    expect(content).toContain("### Park");
    expect(content).toContain("- linear-algebra (park, stable) - next drill: write dimensions before multiplying matrices");
    expect(content).toContain("skipped dimension checks (2)");
    expect(content).toContain("check dimensions first (2)");
    expect(content).toContain("## Next Week Focus");
    expect(content).toContain("probability-and-statistics: define A and B before using Bayes");
    expect(content).toContain("## Upgrade Prompt");
    expect(content).toContain("**Main Failure To Avoid**: skipped dimension checks");
    expect(content).toContain("**Default Method To Apply**: check dimensions first");
    expect(upgradeContent).toContain("# Learning Upgrade Prompt: 2026-W11");
    expect(upgradeContent).toContain("**Main Failure To Avoid**: skipped dimension checks");
    expect(upgradeContent).toContain("**Default Method To Apply**: check dimensions first");
    expect(upgradeContent).toContain("**Stable Topic To Reuse**: linear-algebra (stable)");
    expect(upgradeContent).toContain("**Top Topic To Reinforce**: probability-and-statistics (fragile)");
    expect(upgradeContent).toContain("**Do Now**: probability-and-statistics (do-now)");
    expect(upgradeContent).toContain("**Do Next**: linear-algebra (do-next)");
    expect(upgradeContent).toContain("**Park**: linear-algebra (park)");
    expect(upgradeContent).toContain("**Next Micro-Drill**: define A and B before using Bayes");
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
