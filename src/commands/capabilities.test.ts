import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { buildCapabilitySurfaceReport, formatCapabilityRunFooter } from "./capabilities.js";

function createConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
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
});
