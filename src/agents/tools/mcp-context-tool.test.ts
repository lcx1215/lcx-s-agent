import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createMcpContextTool } from "./mcp-context-tool.js";

async function createWorkspace() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mcp-context-"));
}

async function readDetails(tool: ReturnType<typeof createMcpContextTool>) {
  const result = await tool.execute("call-1", {});
  return result.details as {
    found: boolean;
    workspaceConfigs: Array<{ path: string; serverNames?: string[] }>;
    cliBackendConfigs: Array<{
      backendId: string;
      path: string;
      strict: boolean;
      serverNames?: string[];
    }>;
    qmdMcporter: { enabled: boolean; serverName: string; startDaemon: boolean };
    integrationHints: Array<{
      kind: "openspace" | "memd" | "memlayer";
      serverName: string;
      source: "workspace" | "cli-backend";
      sourcePath: string;
      localOnlyRecommended: boolean;
      cloudEnabled: boolean;
      hostSkillDirsConfigured?: boolean;
      workspaceConfigured?: boolean;
      recommendedWriteScope: string;
      recommendedRole?: "optional-skill-engine" | "supplemental-durable-memory";
      protectedSummaryWriteBlocked?: boolean;
      reflectCapable?: boolean;
      checkpointCapable?: boolean;
    }>;
    warnings: Array<{
      kind: "openspace" | "memd" | "memlayer";
      serverName: string;
      sourcePath: string;
      level: "warning";
      issue: "missing_host_skill_dirs" | "missing_workspace" | "cloud_enabled" | "hosted_backend";
      message: string;
      recommendation: string;
    }>;
    summary: { totalServerCount: number; warningCount: number };
  };
}

describe("mcp_context tool", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("surfaces workspace MCP files, CLI MCP config, and mcporter config", async () => {
    workspaceDir = await createWorkspace();
    await fs.mkdir(path.join(workspaceDir, ".cursor"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            docs: { command: "npx", args: ["-y", "@demo/docs-server"] },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, ".cursor", "mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            browser: { url: "http://127.0.0.1:3000/mcp" },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          cliBackends: {
            claude: {
              command: "claude",
              args: ["--strict-mcp-config", "--mcp-config", ".cursor/mcp.json"],
            },
          },
        },
      },
      memory: {
        qmd: {
          mcporter: {
            enabled: true,
            serverName: "qmd",
            startDaemon: false,
          },
        },
      },
    } as OpenClawConfig;

    const tool = createMcpContextTool({ config: cfg, workspaceDir });
    const details = await readDetails(tool);

    expect(details.found).toBe(true);
    expect(details.workspaceConfigs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ".mcp.json",
          serverNames: ["docs"],
        }),
        expect.objectContaining({
          path: ".cursor/mcp.json",
          serverNames: ["browser"],
        }),
      ]),
    );
    expect(details.cliBackendConfigs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backendId: "claude",
          path: ".cursor/mcp.json",
          strict: true,
          serverNames: ["browser"],
        }),
      ]),
    );
    expect(details.qmdMcporter).toEqual({
      enabled: true,
      serverName: "qmd",
      startDaemon: false,
    });
    expect(details.summary.totalServerCount).toBeGreaterThanOrEqual(2);
  });

  it("stays explicit when no MCP context exists", async () => {
    workspaceDir = await createWorkspace();
    const tool = createMcpContextTool({ workspaceDir });
    const details = await readDetails(tool);

    expect(details.found).toBe(false);
    expect(details.workspaceConfigs).toEqual([]);
    expect(details.cliBackendConfigs).toEqual([]);
    expect(details.qmdMcporter.enabled).toBe(false);
    expect(details.warnings).toEqual([]);
  });

  it("parses --mcp-config=<path> CLI backend wiring", async () => {
    workspaceDir = await createWorkspace();
    await fs.mkdir(path.join(workspaceDir, ".mcp"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".mcp", "docs.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            docs: { url: "https://developers.openai.com/mcp" },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          cliBackends: {
            codex: {
              command: "codex",
              args: ["--strict-mcp-config", "--mcp-config=.mcp/docs.json"],
            },
          },
        },
      },
    } as OpenClawConfig;

    const tool = createMcpContextTool({ config: cfg, workspaceDir });
    const details = await readDetails(tool);

    expect(details.cliBackendConfigs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backendId: "codex",
          path: ".mcp/docs.json",
          strict: true,
          serverNames: ["docs"],
        }),
      ]),
    );
  });

  it("surfaces bounded OpenSpace integration hints", async () => {
    workspaceDir = await createWorkspace();
    await fs.writeFile(
      path.join(workspaceDir, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            openspace: {
              command: "openspace-mcp",
              env: {
                OPENSPACE_HOST_SKILL_DIRS: "./skills/openspace",
                OPENSPACE_WORKSPACE: "./.openspace",
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const tool = createMcpContextTool({ workspaceDir });
    const details = await readDetails(tool);

    expect(details.integrationHints).toEqual([
      expect.objectContaining({
        kind: "openspace",
        serverName: "openspace",
        source: "workspace",
        sourcePath: ".mcp.json",
        localOnlyRecommended: true,
        cloudEnabled: false,
        hostSkillDirsConfigured: true,
        workspaceConfigured: true,
        recommendedWriteScope: "dedicated OpenSpace skills/workspace only",
      }),
    ]);
    expect(details.warnings).toEqual([]);
  });

  it("warns when OpenSpace is missing isolation envs or enables cloud access", async () => {
    workspaceDir = await createWorkspace();
    await fs.writeFile(
      path.join(workspaceDir, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            openspace: {
              command: "openspace-mcp",
              env: {
                OPENSPACE_API_KEY: "test-key",
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const tool = createMcpContextTool({ workspaceDir });
    const details = await readDetails(tool);

    expect(details.integrationHints).toEqual([
      expect.objectContaining({
        kind: "openspace",
        cloudEnabled: true,
        hostSkillDirsConfigured: false,
        workspaceConfigured: false,
      }),
    ]);
    expect(details.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issue: "missing_host_skill_dirs",
          sourcePath: ".mcp.json",
        }),
        expect.objectContaining({
          issue: "missing_workspace",
          sourcePath: ".mcp.json",
        }),
        expect.objectContaining({
          issue: "cloud_enabled",
          sourcePath: ".mcp.json",
        }),
      ]),
    );
    expect(details.summary.warningCount).toBe(3);
  });

  it("surfaces memd as supplemental durable memory and warns on hosted backend", async () => {
    workspaceDir = await createWorkspace();
    await fs.writeFile(
      path.join(workspaceDir, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            memd: {
              command: "npx",
              args: ["@memd/mcp"],
              env: {
                MEMD_API_URL: "https://api.memd.dev",
                MEMD_API_KEY: "test-key",
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const tool = createMcpContextTool({ workspaceDir });
    const details = await readDetails(tool);

    expect(details.integrationHints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "memd",
          serverName: "memd",
          localOnlyRecommended: true,
          cloudEnabled: true,
          recommendedRole: "supplemental-durable-memory",
          protectedSummaryWriteBlocked: true,
          checkpointCapable: true,
        }),
      ]),
    );
    expect(details.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "memd",
          issue: "hosted_backend",
          sourcePath: ".mcp.json",
        }),
      ]),
    );
  });

  it("does not misreport memd as hosted when backend mode is not explicitly cloud", async () => {
    workspaceDir = await createWorkspace();
    await fs.writeFile(
      path.join(workspaceDir, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            memd: {
              command: "npx",
              args: ["@memd/mcp"],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const tool = createMcpContextTool({ workspaceDir });
    const details = await readDetails(tool);

    expect(details.integrationHints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "memd",
          serverName: "memd",
          localOnlyRecommended: true,
          cloudEnabled: false,
          recommendedRole: "supplemental-durable-memory",
          protectedSummaryWriteBlocked: true,
          checkpointCapable: true,
        }),
      ]),
    );
    expect(details.warnings).toEqual([]);
  });

  it("surfaces MemLayer as a supplemental reflect-capable memory layer", async () => {
    workspaceDir = await createWorkspace();
    await fs.writeFile(
      path.join(workspaceDir, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            memlayer: {
              command: "memlayer-mcp",
              env: {
                MEMLAYER_DATA_DIR: "./.memlayer",
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const tool = createMcpContextTool({ workspaceDir });
    const details = await readDetails(tool);

    expect(details.integrationHints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "memlayer",
          serverName: "memlayer",
          localOnlyRecommended: true,
          cloudEnabled: false,
          recommendedRole: "supplemental-durable-memory",
          protectedSummaryWriteBlocked: true,
          reflectCapable: true,
        }),
      ]),
    );
    expect(details.warnings).toEqual([]);
  });
});
