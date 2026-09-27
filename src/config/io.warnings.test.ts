import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import { createConfigIO } from "./io.js";

describe("config read warnings", () => {
  it("deduplicates repeated reads across IO instances and reports changed warnings", async () => {
    await withTempHome("config-warnings-", async (home) => {
      const configPath = path.join(home, "config.json");
      const warn = vi.fn();
      const read = () =>
        createConfigIO({ configPath, logger: { warn, error: vi.fn() } }).loadConfig();
      const write = async (pluginId: string) =>
        fs.writeFile(
          configPath,
          JSON.stringify({ plugins: { entries: { [pluginId]: { enabled: false } } } }),
        );

      await write("missing-warning-one");
      read();
      read();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("Config warnings:\n");
      expect(warn.mock.calls[0][0]).toContain("missing-warning-one");

      await write("missing-warning-two");
      read();
      read();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1][0]).toContain("missing-warning-two");
    });
  });

  it.each(["clean", "removed"])("reports warnings again after a %s config read", async (mode) => {
    await withTempHome("config-warnings-reset-", async (home) => {
      const configPath = path.join(home, "config.json");
      const raw = JSON.stringify({
        plugins: { entries: { "missing-warning-reset": { enabled: false } } },
      });
      const warn = vi.fn();
      const io = createConfigIO({ configPath, logger: { warn, error: vi.fn() } });
      await fs.writeFile(configPath, raw);
      io.loadConfig();
      if (mode === "clean") {
        await fs.writeFile(configPath, "{}");
      } else {
        await fs.unlink(configPath);
      }
      io.loadConfig();
      await fs.writeFile(configPath, raw);
      io.loadConfig();
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });

  it("does not suppress the same warning in another config file", async () => {
    await withTempHome("config-warnings-paths-", async (home) => {
      const warn = vi.fn();
      for (const name of ["first.json", "second.json"]) {
        const configPath = path.join(home, name);
        await fs.writeFile(
          configPath,
          JSON.stringify({ plugins: { entries: { "missing-warning-path": { enabled: false } } } }),
        );
        createConfigIO({ configPath, logger: { warn, error: vi.fn() } }).loadConfig();
      }
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });
});
