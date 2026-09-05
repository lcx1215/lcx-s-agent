import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDir = path.resolve(fileURLToPath(new URL("../packages/openclaw/", import.meta.url)));

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

    await expect(fs.access(path.join(packageDir, "openclaw.mjs"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(packageDir, "index.js"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(packageDir, "plugin-sdk.js"))).resolves.toBeUndefined();
    for (const entry of entries.filter((value) => value.startsWith("./plugin-sdk/"))) {
      const relative = entry.slice("./".length);
      await expect(fs.access(path.join(packageDir, `${relative}.js`))).resolves.toBeUndefined();
      await expect(fs.access(path.join(packageDir, `${relative}.d.ts`))).resolves.toBeUndefined();
    }

    await expect(fs.readFile(path.join(packageDir, "index.js"), "utf8")).resolves.toContain(
      'from "lcx-agent"',
    );
    await expect(
      fs.readFile(path.join(packageDir, "plugin-sdk/core.js"), "utf8"),
    ).resolves.toContain('from "lcx-agent/plugin-sdk/core"');
    await expect(fs.readFile(path.join(packageDir, "openclaw.mjs"), "utf8")).resolves.toContain(
      'import("lcx-agent/cli-entry")',
    );
  });
});
