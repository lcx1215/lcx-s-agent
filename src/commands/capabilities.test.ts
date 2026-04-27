import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildCapabilitySurfaceReport,
  formatCapabilityRunFooter,
  formatLobsterProtocolDetailLines,
  formatLobsterProtocolSummary,
  listKnownCapabilityDescriptors,
  resolveKnownCapabilityDescriptor,
} from "./capabilities.js";

function createConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: "/tmp/openclaw-capabilities-workspace",
        model: {
          primary: "moonshot/kimi-k2.6",
          fallbacks: ["minimax-portal/MiniMax-M2.7", "deepseek/deepseek-chat"],
        },
        models: {
          "moonshot/kimi-k2.6": {},
          "minimax-portal/MiniMax-M2.7": {},
          "deepseek/deepseek-chat": {},
        },
      },
    },
    models: {
      providers: {
        moonshot: {
          baseUrl: "https://api.moonshot.ai/v1",
          api: "openai-completions",
          models: [
            {
              id: "kimi-k2.6",
              name: "Kimi 2.6",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 256000,
              maxTokens: 8192,
            },
          ],
        },
        "minimax-portal": {
          baseUrl: "https://api.minimax.io/anthropic",
          api: "anthropic-messages",
          models: [
            {
              id: "MiniMax-M2.7",
              name: "MiniMax M2.7",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200000,
              maxTokens: 8192,
            },
          ],
        },
        deepseek: {
          baseUrl: "https://api.deepseek.com/v1",
          api: "openai-completions",
          models: [
            {
              id: "deepseek-chat",
              name: "DeepSeek Chat",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 8192,
            },
          ],
        },
      },
    },
  } as OpenClawConfig;
}

describe("buildCapabilitySurfaceReport", () => {
  it("shows configured provider/model entries", () => {
    const report = buildCapabilitySurfaceReport(createConfig());
    expect(report.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "moonshot",
          model: "kimi-k2.6",
          defaultAgent: true,
          mode: "model_only",
        }),
        expect.objectContaining({
          provider: "minimax-portal",
          model: "MiniMax-M2.7",
        }),
      ]),
    );
  });

  it("does not claim provider-native tools are connected when adapters are missing", () => {
    const report = buildCapabilitySurfaceReport(createConfig());
    expect(report.models.find((entry) => entry.provider === "moonshot")?.toolsConnected).toEqual(
      [],
    );
    expect(
      report.providerCapabilities.find(
        (entry) => entry.provider === "moonshot" && entry.capability === "web-search",
      )?.states,
    ).toEqual(["advertised", "adapter_missing"]);
  });

  it("shows moonshot tools as advertised but adapter_missing", () => {
    const report = buildCapabilitySurfaceReport(createConfig());
    expect(
      report.providerCapabilities.find(
        (entry) => entry.provider === "moonshot" && entry.capability === "fetch",
      ),
    ).toEqual(
      expect.objectContaining({
        states: ["advertised", "adapter_missing"],
      }),
    );
  });

  it("shows deepseek function calling as advertised with missing execution adapter", () => {
    const report = buildCapabilitySurfaceReport(createConfig());
    expect(
      report.providerCapabilities.find(
        (entry) => entry.provider === "deepseek" && entry.capability === "function_calling",
      ),
    ).toEqual(
      expect.objectContaining({
        states: ["advertised", "adapter_missing"],
      }),
    );
  });

  it("recognizes deepseek-like custom provider ids from configured model ids", () => {
    const cfg = createConfig();
    cfg.models ??= {};
    cfg.models.providers ??= {};
    cfg.models.providers["custom-api-deepseek-com"] = {
      baseUrl: "https://example.com/v1",
      api: "openai-completions",
      models: [
        {
          id: "deepseek-chat",
          name: "DeepSeek Chat",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
    };

    const report = buildCapabilitySurfaceReport(cfg);
    expect(
      report.providerCapabilities.find(
        (entry) =>
          entry.provider === "custom-api-deepseek-com" && entry.capability === "function_calling",
      ),
    ).toEqual(
      expect.objectContaining({
        states: ["advertised", "adapter_missing"],
      }),
    );
  });

  it("shows minimax MCP tools as advertised but adapter_missing", () => {
    const report = buildCapabilitySurfaceReport(createConfig());
    expect(
      report.providerCapabilities.find(
        (entry) =>
          entry.provider === "minimax-portal" && entry.capability === "understand_image_mcp",
      ),
    ).toEqual(
      expect.objectContaining({
        states: ["advertised", "adapter_missing"],
      }),
    );
  });

  it("distinguishes model-only mode from tool-backed mode in the footer formatter", () => {
    expect(
      formatCapabilityRunFooter({
        provider: "moonshot",
        model: "kimi-k2.6",
      }),
    ).toBe("model=moonshot/kimi-k2.6 · mode=model-only · tools=none");
    expect(
      formatCapabilityRunFooter({
        provider: "moonshot",
        model: "kimi-k2.6",
        toolsActuallyCalled: ["web-search", "fetch"],
        sourceCount: 5,
      }),
    ).toBe("model=moonshot/kimi-k2.6 · mode=tool-backed · tools=web-search/fetch · sources=5");
  });

  it("never claims live_verified without explicit evidence", () => {
    const report = buildCapabilitySurfaceReport(createConfig());
    expect(
      report.providerCapabilities.some((entry) => entry.states.includes("live_verified")),
    ).toBe(false);
    expect(report.models.some((entry) => entry.states.includes("live_verified"))).toBe(false);
  });

  it("shows the lobster workflow runtime as optional and disabled by default", () => {
    const report = buildCapabilitySurfaceReport(createConfig());
    expect(report.lobsterProtocol.lobsterWorkflowRuntime).toEqual(
      expect.objectContaining({
        kind: "optional_plugin",
        enabledByPolicy: false,
        states: ["adapter_implemented", "disabled"],
      }),
    );
  });

  it("shows the lobster workflow runtime as configured when allowlisted", () => {
    const cfg = createConfig();
    cfg.tools = { alsoAllow: ["lobster"] };
    const report = buildCapabilitySurfaceReport(cfg);
    expect(report.lobsterProtocol.lobsterWorkflowRuntime).toEqual(
      expect.objectContaining({
        enabledByPolicy: true,
        states: ["adapter_implemented", "configured"],
      }),
    );
  });

  it("reports protected anchor presence from the configured workspace", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-capabilities-"));
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "memory", "current-research-line.md"), "# ok\n");
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# durable\n");

    const cfg = createConfig();
    cfg.agents ??= {};
    cfg.agents.defaults ??= {};
    cfg.agents.defaults.workspace = workspaceDir;

    const report = buildCapabilitySurfaceReport(cfg);
    expect(report.lobsterProtocol.protectedAnchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "memory/current-research-line.md",
          present: true,
          states: ["configured"],
        }),
        expect.objectContaining({
          path: "memory/unified-risk-view.md",
          present: false,
          states: ["unavailable"],
        }),
        expect.objectContaining({
          path: "MEMORY.md",
          present: true,
          states: ["configured"],
        }),
      ]),
    );
  });

  it("formats a shared lobster protocol summary line", () => {
    const report = buildCapabilitySurfaceReport(createConfig());
    expect(formatLobsterProtocolSummary(report.lobsterProtocol)).toBe(
      "control_room_main_lane · openclaw_embedded_agent · plugin optional · dm=main · anchors 0/3",
    );
    expect(
      formatLobsterProtocolSummary(report.lobsterProtocol, {
        pluginEnabled: "enabled",
        pluginDisabled: "disabled",
      }),
    ).toContain("disabled");
  });

  it("formats lobster protocol detail lines from the shared surface", () => {
    const report = buildCapabilitySurfaceReport(createConfig());
    const lines = formatLobsterProtocolDetailLines(report.lobsterProtocol);
    expect(lines).toContain("- defaultMode: control_room_main_lane");
    expect(lines).toContain(
      "  executionSubstrate: openclaw_embedded_agent (configured, connected)",
    );
    expect(lines.some((line) => line.includes("lobsterWorkflowRuntime: adapter_implemented, disabled"))).toBe(
      true,
    );
  });

  it("exports known capability descriptors from the shared capability surface", () => {
    const descriptors = listKnownCapabilityDescriptors();
    expect(descriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerCapability: "web-search",
          genericTool: "web_search",
          aliases: expect.arrayContaining(["web-search", "web search"]),
        }),
        expect.objectContaining({
          providerCapability: "quickjs",
          genericTool: null,
          aliases: expect.arrayContaining(["quickjs"]),
        }),
        expect.objectContaining({
          providerCapability: "file_search",
          genericTool: null,
          aliases: expect.arrayContaining(["file_search", "file search"]),
        }),
      ]),
    );
  });

  it("resolves known capability aliases without duplicating matcher-local taxonomy", () => {
    expect(resolveKnownCapabilityDescriptor("can you use web search")).toEqual(
      expect.objectContaining({
        providerCapability: "web-search",
        genericTool: "web_search",
      }),
    );
    expect(resolveKnownCapabilityDescriptor("你能用 quickjs 吗")).toEqual(
      expect.objectContaining({
        providerCapability: "quickjs",
        genericTool: null,
      }),
    );
    expect(resolveKnownCapabilityDescriptor("can you use file search")).toEqual(
      expect.objectContaining({
        providerCapability: "file_search",
        genericTool: null,
      }),
    );
  });
});
