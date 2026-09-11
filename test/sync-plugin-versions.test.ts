import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { syncPluginVersions } from "../scripts/sync-plugin-versions.ts";

describe("syncPluginVersions", () => {
  it("keeps the workspace compatibility package aligned with the root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-plugin-version-sync-"));
    try {
      await fs.mkdir(path.join(root, "extensions", "example"), { recursive: true });
      await fs.mkdir(path.join(root, "packages", "openclaw"), { recursive: true });
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ version: "2026.4.0" }),
        "utf8",
      );
      await fs.writeFile(
        path.join(root, "extensions", "example", "package.json"),
        JSON.stringify({ name: "example", version: "2026.3.3" }),
        "utf8",
      );
      await fs.writeFile(
        path.join(root, "packages", "openclaw", "package.json"),
        JSON.stringify({
          name: "openclaw",
          version: "2026.3.3",
          dependencies: { "lcx-agent": "2026.3.3" },
        }),
        "utf8",
      );

      const summary = syncPluginVersions(root);
      const compatibilityPackage = JSON.parse(
        await fs.readFile(path.join(root, "packages", "openclaw", "package.json"), "utf8"),
      ) as { version?: string; dependencies?: Record<string, string> };

      expect(summary.updated).toEqual(["example", "openclaw"]);
      expect(compatibilityPackage.version).toBe("2026.4.0");
      expect(compatibilityPackage.dependencies?.["lcx-agent"]).toBe("2026.4.0");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
