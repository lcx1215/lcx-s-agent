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
          "frontier-research-bootstrap": {
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

describe("frontier-research-bootstrap hook", () => {
  it("injects weekly review and recent research cards into bootstrap context", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-frontier-research-bootstrap-");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-W11-frontier-upgrade.md",
      content: "# Frontier Upgrade Prompt\n\n- Primary Research Candidate: WaveLSFormer",
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-W11-frontier-methods-weekly-review.md",
      content: "# Weekly Methods Review\n\n- Cards Reviewed: 2",
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-W11-frontier-replication-backlog.md",
      content: "# Frontier Replication Backlog\n\n## WaveLSFormer\n- leakage_check_first: temporal windowing can leak future information",
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-03-15-frontier-research-wave.md",
      content: "# Frontier Research Card\n\n- verdict: worth_reproducing",
    });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-03-14-frontier-research-factor.md",
      content: "# Frontier Research Card\n\n- verdict: watch_for_followup",
    });

    const context = await createContext({
      workspaceDir,
      sessionKey: "agent:main:main",
      cfg: createConfig(),
    });

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", context);
    await handler(event);

    const injected = context.bootstrapFiles.find((file) => file.path.endsWith("_frontier-research-bootstrap.md"));
    expect(injected).toBeTruthy();
    expect(injected?.name).toBe("memory.md");
    expect(injected?.content).toContain("Recent Frontier Research");
    expect(injected?.content).toContain("Priority Frontier Upgrade");
    expect(injected?.content).toContain("2026-W11-frontier-upgrade.md");
    expect(injected?.content).toContain("2026-W11-frontier-methods-weekly-review.md");
    expect(injected?.content).toContain("2026-W11-frontier-replication-backlog.md");
    expect(injected?.content).toContain("2026-03-15-frontier-research-wave.md");
    expect(injected?.content).toContain("2026-03-14-frontier-research-factor.md");
    expect(injected?.content.indexOf("2026-W11-frontier-upgrade.md")).toBeLessThan(
      injected?.content.indexOf("2026-W11-frontier-methods-weekly-review.md") ?? Number.MAX_SAFE_INTEGER,
    );
    expect(injected?.content.indexOf("2026-W11-frontier-methods-weekly-review.md")).toBeLessThan(
      injected?.content.indexOf("2026-W11-frontier-replication-backlog.md") ?? Number.MAX_SAFE_INTEGER,
    );
    expect(injected?.content.indexOf("2026-W11-frontier-replication-backlog.md")).toBeLessThan(
      injected?.content.indexOf("2026-03-15-frontier-research-wave.md") ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("re-applies subagent allowlist and skips synthetic memory for subagents", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-frontier-research-bootstrap-subagent-");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await writeWorkspaceFile({
      dir: memoryDir,
      name: "2026-03-15-frontier-research-wave.md",
      content: "# Frontier Research Card\n\n- verdict: worth_reproducing",
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
});
