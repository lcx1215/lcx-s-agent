import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
vi.mock("./pi-model-discovery.js", async (original) => ({
  ...(await original<typeof import("./pi-model-discovery.js")>()),
  // Authentication is a separate tested seam; use synthetic memory-only credentials here.
  discoverAuthStorage: () => AuthStorage.inMemory(),
}));
import { resolveModel } from "./pi-embedded-runner/model.js";
import { discoverModels } from "./pi-model-discovery.js";
let root: string;
let marker: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "native-model-registry-"));
  marker = path.join(root, "host-process-marker");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
function provider(): ModelProviderConfig {
  return {
    baseUrl: "https://fixture.invalid/v1",
    api: "openai-completions",
    apiKey: "fixture-key",
    models: [
      {
        id: "fixture",
        name: "fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10000,
        maxTokens: 1000,
      },
    ],
  };
}
function command() {
  return `!printf executed > '${marker}'; printf synthetic-key`;
}
async function noHostProcess() {
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
}
describe("native memory-only SDK model discovery", () => {
  it.each(["provider-header", "model-header", "auth-key", "unused-key"])(
    "does not load ambient executable %s configuration, even for unselected models",
    async (kind) => {
      const ambient = provider();
      if (kind === "provider-header") {
        ambient.headers = { "X-Fixture": command() };
      }
      if (kind === "model-header") {
        ambient.models[0].headers = { "X-Fixture": command() };
      }
      if (kind === "auth-key") {
        ambient.authHeader = true;
        ambient.apiKey = command();
      }
      if (kind === "unused-key") {
        ambient.apiKey = command();
      }
      const bytes = JSON.stringify({ providers: { unselected: ambient } });
      await fs.writeFile(path.join(root, "models.json"), bytes);
      const registry = discoverModels(AuthStorage.inMemory(), root, { readOnly: true });
      expect(registry.find("anthropic", "claude-sonnet-4-20250514")).toBeDefined();
      expect(registry.find("unselected", "fixture")).toBeUndefined();
      expect(await registry.getApiKeyForProvider("unselected")).toBeUndefined();
      await noHostProcess();
      expect(await fs.readFile(path.join(root, "models.json"), "utf8")).toBe(bytes);
      expect((await fs.readdir(root)).toSorted()).toEqual(["models.json"]);
    },
  );
  it.each(["provider-header", "model-header", "auth-key"])(
    "rejects trusted cfg %s command syntax before SDK resolution",
    async (kind) => {
      const entry = provider();
      if (kind === "provider-header") {
        entry.headers = { "X-Fixture": command() };
      }
      if (kind === "model-header") {
        entry.models[0].headers = { "X-Fixture": command() };
      }
      if (kind === "auth-key") {
        entry.authHeader = true;
        entry.apiKey = command();
      }
      expect(() =>
        resolveModel(
          "anthropic",
          "claude-sonnet-4-20250514",
          root,
          { models: { providers: { unused: entry } } },
          { readOnly: true },
        ),
      ).toThrow("cannot execute credential/header commands");
      await noHostProcess();
    },
  );
  it("prefers trusted config endpoint, headers and model data over a matching built-in", () => {
    const entry = provider();
    entry.api = "anthropic-messages";
    entry.baseUrl = "https://configured.fixture.invalid";
    entry.models[0].id = "claude-sonnet-4-20250514";
    entry.headers = { "X-Fixture": "pure-data" };
    entry.authHeader = true;
    const resolved = resolveModel(
      "anthropic",
      entry.models[0].id,
      root,
      { models: { providers: { anthropic: entry } } },
      { readOnly: true },
    );
    expect(resolved.model).toMatchObject({
      baseUrl: entry.baseUrl,
      contextWindow: 10000,
      headers: { "X-Fixture": "pure-data", Authorization: "Bearer fixture-key" },
    });
  });
  it("keeps ordinary SDK discovery of safe ambient custom models", async () => {
    await fs.writeFile(
      path.join(root, "models.json"),
      JSON.stringify({ providers: { fixture: provider() } }),
    );
    const registry = discoverModels(AuthStorage.inMemory(), root);
    expect(registry.find("fixture", "fixture")).toMatchObject({
      baseUrl: "https://fixture.invalid/v1",
    });
    await noHostProcess();
  });
});
