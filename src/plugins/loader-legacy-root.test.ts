import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadOpenClawPlugins } from "./loader.js";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-legacy-root-"));
const pluginDir = path.join(fixtureRoot, "legacy-root-import");
const pluginFile = path.join(pluginDir, "legacy-root-import.cjs");

fs.mkdirSync(pluginDir, { recursive: true });
fs.writeFileSync(
  path.join(pluginDir, "openclaw.plugin.json"),
  JSON.stringify(
    {
      id: "legacy-root-import",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    null,
    2,
  ),
  "utf8",
);
fs.writeFileSync(
  pluginFile,
  `module.exports = {
  id: "legacy-root-import",
  configSchema: (require("openclaw/plugin-sdk").emptyPluginConfigSchema)(),
  register() {},
};
`,
  "utf8",
);
process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";

afterAll(() => {
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures in the isolated compatibility process.
  }
});

describe("legacy plugin-sdk root compatibility", () => {
  it("loads a legacy plugin importing the monolithic plugin-sdk root", () => {
    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: pluginDir,
      config: {
        plugins: {
          load: { paths: [pluginFile] },
          allow: ["legacy-root-import"],
        },
      },
    });

    const record = registry.plugins.find((entry) => entry.id === "legacy-root-import");
    expect(record?.status).toBe("loaded");
  }, 300_000);
});
