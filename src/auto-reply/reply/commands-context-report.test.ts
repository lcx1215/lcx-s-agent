import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "../../../test/helpers/temp-home.js";
import { buildContextReply } from "./commands-context-report.js";
import type { HandleCommandsParams } from "./commands-types.js";

function makeParams(
  commandBodyNormalized: string,
  truncated: boolean,
  options?: { omitBootstrapLimits?: boolean; cfg?: HandleCommandsParams["cfg"] },
): HandleCommandsParams {
  return {
    command: {
      commandBodyNormalized,
      channel: "telegram",
      senderIsOwner: true,
    },
    sessionKey: "agent:default:main",
    workspaceDir: "/tmp/workspace",
    contextTokens: null,
    provider: "openai",
    model: "gpt-5",
    elevated: { allowed: false },
    resolvedThinkLevel: "off",
    resolvedReasoningLevel: "off",
    sessionEntry: {
      totalTokens: 123,
      inputTokens: 100,
      outputTokens: 23,
      systemPromptReport: {
        source: "run",
        generatedAt: Date.now(),
        workspaceDir: "/tmp/workspace",
        bootstrapMaxChars: options?.omitBootstrapLimits ? undefined : 20_000,
        bootstrapTotalMaxChars: options?.omitBootstrapLimits ? undefined : 150_000,
        sandbox: { mode: "off", sandboxed: false },
        systemPrompt: {
          chars: 1_000,
          projectContextChars: 500,
          nonProjectContextChars: 500,
        },
        injectedWorkspaceFiles: [
          {
            name: "AGENTS.md",
            path: "/tmp/workspace/AGENTS.md",
            missing: false,
            rawChars: truncated ? 200_000 : 10_000,
            injectedChars: truncated ? 20_000 : 10_000,
            truncated,
          },
        ],
        skills: {
          promptChars: 10,
          entries: [{ name: "checks", blockChars: 10 }],
        },
        tools: {
          listChars: 10,
          schemaChars: 20,
          entries: [{ name: "read", summaryChars: 10, schemaChars: 20, propertiesCount: 1 }],
        },
      },
    },
    cfg: options?.cfg ?? {},
    ctx: {},
    commandBody: "",
    commandArgs: [],
    resolvedElevatedLevel: "off",
  } as unknown as HandleCommandsParams;
}

describe("buildContextReply", () => {
  it("shows lobster protocol summary in help output when config is present", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "memory", "current-research-line.md"), "# current\n");
      fs.writeFileSync(path.join(workspace, "MEMORY.md"), "# memory\n");

      const result = await buildContextReply(
        makeParams("/context", false, {
          cfg: {
            agents: {
              defaults: {
                workspace,
                model: { primary: "moonshot/kimi-k2.6" },
              },
            },
          } as never,
        }),
      );
      expect(result.text).toContain(
        "🦞 Lobster: control_room_main_lane · openclaw_embedded_agent · plugin optional · dm=main · anchors 2/3",
      );
    });
  });

  it("shows bootstrap truncation warning in list output when context exceeds configured limits", async () => {
    const result = await buildContextReply(makeParams("/context list", true));
    expect(result.text).toContain("Bootstrap max/total: 150,000 chars");
    expect(result.text).toContain("⚠ Bootstrap context is over configured limits");
    expect(result.text).toContain("Causes: 1 file(s) exceeded max/file.");
  });

  it("does not show bootstrap truncation warning when there is no truncation", async () => {
    const result = await buildContextReply(makeParams("/context list", false));
    expect(result.text).not.toContain("Bootstrap context is over configured limits");
  });

  it("falls back to config defaults when legacy reports are missing bootstrap limits", async () => {
    const result = await buildContextReply(
      makeParams("/context list", false, {
        omitBootstrapLimits: true,
      }),
    );
    expect(result.text).toContain("Bootstrap max/file: 20,000 chars");
    expect(result.text).toContain("Bootstrap max/total: 150,000 chars");
    expect(result.text).not.toContain("Bootstrap max/file: ? chars");
  });

  it("shows lobster protocol summary in list output when config is present", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "memory", "current-research-line.md"), "# current\n");
      fs.writeFileSync(path.join(workspace, "MEMORY.md"), "# memory\n");

      const result = await buildContextReply(
        makeParams("/context list", false, {
          cfg: {
            tools: { alsoAllow: ["lobster"] },
            agents: {
              defaults: {
                workspace,
                model: { primary: "moonshot/kimi-k2.6" },
              },
            },
          } as never,
        }),
      );
      expect(result.text).toContain(
        "🦞 Lobster: control_room_main_lane · openclaw_embedded_agent · plugin on · dm=main · anchors 2/3",
      );
    });
  });

  it("shows lobster protocol detail block in detailed output when config is present", async () => {
    await withTempHome(async (home) => {
      const workspace = path.join(home, "workspace");
      fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "memory", "current-research-line.md"), "# current\n");
      fs.writeFileSync(path.join(workspace, "memory", "unified-risk-view.md"), "# risk\n");
      fs.writeFileSync(path.join(workspace, "MEMORY.md"), "# memory\n");

      const result = await buildContextReply(
        makeParams("/context detail", false, {
          cfg: {
            tools: { alsoAllow: ["lobster"] },
            agents: {
              defaults: {
                workspace,
                model: { primary: "moonshot/kimi-k2.6" },
              },
            },
          } as never,
        }),
      );
      expect(result.text).toContain("Lobster operating protocol:");
      expect(result.text).toContain("- defaultMode: control_room_main_lane");
      expect(result.text).toContain("enabledByPolicy: true");
      expect(result.text).toContain("  - memory/unified-risk-view.md: present (configured)");
    });
  });
});
