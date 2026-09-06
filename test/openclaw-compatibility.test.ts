import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDir = path.resolve(fileURLToPath(new URL("../packages/openclaw/", import.meta.url)));

const pluginSdkEntrypoints = [
  "core",
  "telegram",
  "discord",
  "slack",
  "signal",
  "imessage",
  "whatsapp",
  "line",
  "account-id",
  "keyed-async-queue",
] as const;

describe("openclaw compatibility package", () => {
  it("retains the legacy package, CLI, and plugin-sdk entrypoints", async () => {
    const manifest = JSON.parse(
      await fs.readFile(path.join(packageDir, "package.json"), "utf8"),
    ) as {
      name: string;
      dependencies?: Record<string, string>;
      exports?: Record<string, unknown>;
    };

    expect(manifest.name).toBe("openclaw");
    expect(manifest.dependencies?.["lcx-agent"]).toBe("2026.3.3");
    expect(manifest.exports).toMatchObject({
      ".": { types: "./index.d.ts", default: "./index.js" },
    });

    const entries = [
      ".",
      "./plugin-sdk",
      "./plugin-sdk/core",
      "./plugin-sdk/telegram",
      "./plugin-sdk/discord",
      "./plugin-sdk/slack",
      "./plugin-sdk/signal",
      "./plugin-sdk/imessage",
      "./plugin-sdk/whatsapp",
      "./plugin-sdk/line",
      "./plugin-sdk/account-id",
      "./plugin-sdk/keyed-async-queue",
      "./cli-entry",
      "./package.json",
    ];
    for (const entry of entries) {
      expect(manifest.exports).toHaveProperty(entry);
    }

    await expect(fs.readFile(path.join(packageDir, "openclaw.mjs"), "utf8")).resolves.toContain(
      'import("lcx-agent/cli-entry")',
    );
    await expect(fs.readFile(path.join(packageDir, "index.js"), "utf8")).resolves.toBe(
      'export * from "lcx-agent";\n',
    );
    await expect(fs.readFile(path.join(packageDir, "index.d.ts"), "utf8")).resolves.toBe(
      'export * from "lcx-agent";\n',
    );
    await expect(fs.readFile(path.join(packageDir, "plugin-sdk.js"), "utf8")).resolves.toBe(
      'export * from "lcx-agent/plugin-sdk";\n',
    );
    await expect(fs.readFile(path.join(packageDir, "plugin-sdk.d.ts"), "utf8")).resolves.toBe(
      'export * from "lcx-agent/plugin-sdk";\n',
    );
    for (const entry of pluginSdkEntrypoints) {
      await expect(
        fs.readFile(path.join(packageDir, "plugin-sdk", `${entry}.js`), "utf8"),
      ).resolves.toBe(`export * from "lcx-agent/plugin-sdk/${entry}";\n`);
      await expect(
        fs.readFile(path.join(packageDir, "plugin-sdk", `${entry}.d.ts`), "utf8"),
      ).resolves.toBe(`export * from "lcx-agent/plugin-sdk/${entry}";\n`);
    }
  });
});
