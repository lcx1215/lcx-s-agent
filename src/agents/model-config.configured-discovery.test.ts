import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { ModelsConfigSchema } from "../config/zod-schema.core.js";

const discovery = vi.hoisted(() => ({
  implicit: vi.fn(),
  bedrock: vi.fn(),
  copilot: vi.fn(),
}));
vi.mock("./models-config.providers.js", () => ({
  resolveImplicitProviders: discovery.implicit,
  resolveImplicitBedrockProvider: discovery.bedrock,
  resolveImplicitCopilotProvider: discovery.copilot,
  normalizeProviders: ({ providers }: { providers: unknown }) => providers,
}));
vi.mock("../config/env-vars.js", () => ({ applyConfigEnvVars: vi.fn() }));

import { ensureOpenClawModelsJson } from "./models-config.js";

const configuredProvider = {
  baseUrl: "https://configured.example/v1",
  apiKey: "CONFIGURED_API_KEY",
  api: "openai-completions" as const,
  models: [
    {
      id: "selected",
      name: "Selected",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 1_024,
    },
  ],
};
let agentDir: string;
beforeEach(async () => {
  agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "configured-discovery-"));
  discovery.implicit.mockReset().mockResolvedValue({ inferred: configuredProvider });
  discovery.bedrock.mockReset().mockResolvedValue(configuredProvider);
  discovery.copilot.mockReset().mockResolvedValue(configuredProvider);
});
afterEach(async () => {
  await fs.rm(agentDir, { recursive: true, force: true });
});

async function catalog() {
  return JSON.parse(await fs.readFile(path.join(agentDir, "models.json"), "utf8")) as {
    providers: Record<string, typeof configuredProvider>;
  };
}

describe("configured provider discovery", () => {
  it("accepts supported choices and rejects an unknown choice", () => {
    expect(ModelsConfigSchema.safeParse({ discovery: "configured_only" }).success).toBe(true);
    expect(ModelsConfigSchema.safeParse({ discovery: "implicit" }).success).toBe(true);
    expect(ModelsConfigSchema.safeParse({ discovery: "off" }).success).toBe(false);
  });
  it("uses only explicit providers and skips every implicit discovery path", async () => {
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({ providers: { retired: configuredProvider } }),
    );
    await ensureOpenClawModelsJson(
      {
        models: {
          discovery: "configured_only",
          mode: "replace",
          providers: { selected: configuredProvider },
        },
      },
      agentDir,
    );
    expect((await catalog()).providers).toEqual({ selected: configuredProvider });
    expect(discovery.implicit).not.toHaveBeenCalled();
    expect(discovery.bedrock).not.toHaveBeenCalled();
    expect(discovery.copilot).not.toHaveBeenCalled();
  });
  it.each([undefined, "implicit"] as const)(
    "preserves implicit discovery when choice is %s",
    async (choice) => {
      const cfg: OpenClawConfig = {
        models: { discovery: choice, mode: "replace", providers: { selected: configuredProvider } },
      };
      await ensureOpenClawModelsJson(cfg, agentDir);
      expect(Object.keys((await catalog()).providers)).toEqual([
        "inferred",
        "selected",
        "amazon-bedrock",
        "github-copilot",
      ]);
      expect(discovery.implicit).toHaveBeenCalledTimes(1);
      expect(discovery.bedrock).toHaveBeenCalledTimes(1);
      expect(discovery.copilot).toHaveBeenCalledTimes(1);
    },
  );
  it("preserves existing entries when configured-only uses merge mode", async () => {
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({ providers: { existing: configuredProvider } }),
    );
    await ensureOpenClawModelsJson(
      { models: { discovery: "configured_only", providers: { selected: configuredProvider } } },
      agentDir,
    );
    expect(Object.keys((await catalog()).providers)).toEqual(["existing", "selected"]);
  });
  it("clears a stale catalog for an empty configured-only replacement", async () => {
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({ providers: { existing: configuredProvider } }),
    );
    const cfg: OpenClawConfig = {
      models: { discovery: "configured_only", mode: "replace", providers: {} },
    };
    expect((await ensureOpenClawModelsJson(cfg, agentDir)).wrote).toBe(true);
    expect((await catalog()).providers).toEqual({});
    expect((await ensureOpenClawModelsJson(cfg, agentDir)).wrote).toBe(false);
    expect(discovery.implicit).not.toHaveBeenCalled();
  });
});
