import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import type { AgentBootstrapHookContext } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";
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

describe("learning-review-bootstrap hook", () => {
  it("injects recent review notes into bootstrap context", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-learning-review-bootstrap-");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-W11-learning-weekly-review.md",
      content: "# Weekly Learning Review\n\n- Review Count: 2",
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-W11-learning-upgrade.md",
      content: "# Learning Upgrade Prompt\n\n- Default Method To Apply: check dimensions first",
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

    const injected = context.bootstrapFiles.find((file) => file.path.endsWith("_learning-review-bootstrap.md"));
    expect(injected).toBeTruthy();
    expect(injected?.name).toBe("memory.md");
    expect(injected?.content).toContain("Recent Learning Reviews");
    expect(injected?.content).toContain("Priority Learning Upgrade");
    expect(injected?.content).toContain("2026-W11-learning-upgrade.md");
    expect(injected?.content).toContain("2026-W11-learning-weekly-review.md");
    expect(injected?.content).toContain("2026-03-15-review-linear-algebra.md");
    expect(injected?.content).toContain("2026-03-14-review-probability.md");
    expect(injected?.content.indexOf("2026-W11-learning-upgrade.md")).toBeLessThan(
      injected?.content.indexOf("2026-W11-learning-weekly-review.md") ?? Number.MAX_SAFE_INTEGER,
    );
    expect(injected?.content.indexOf("2026-W11-learning-weekly-review.md")).toBeLessThan(
      injected?.content.indexOf("2026-03-15-review-linear-algebra.md") ?? Number.MAX_SAFE_INTEGER,
    );
    expect(injected?.content.match(/2026-W11-learning-weekly-review\.md/g)).toHaveLength(1);
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
    const workspaceDir = await makeTempWorkspace("openclaw-learning-review-bootstrap-aggregate-only-");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-W11-learning-weekly-review.md",
      content: "# Weekly Learning Review\n\n- Review Count: 2",
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-W11-learning-upgrade.md",
      content: "# Learning Upgrade Prompt\n\n- Main Failure To Avoid: skipped dimension checks",
    });

    const context = await createContext({
      workspaceDir,
      sessionKey: "agent:main:main",
      cfg: createConfig(),
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    const injected = context.bootstrapFiles.find((file) => file.path.endsWith("_learning-review-bootstrap.md"));
    expect(injected?.content).toContain("2026-W11-learning-upgrade.md");
    expect(injected?.content).toContain("2026-W11-learning-weekly-review.md");
  });
});
