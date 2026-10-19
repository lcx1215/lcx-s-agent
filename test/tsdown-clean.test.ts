import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "tsdown";
import { expect, it } from "vitest";
import tsdownConfig from "../tsdown.config.ts";

it("cleans stale build output while preserving the tracked protocol contract", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-build-clean-"));
  try {
    await fs.mkdir(path.join(directory, "dist"));
    const schema = path.join(directory, "dist", "protocol.schema.json");
    const stale = path.join(directory, "dist", "stale.js");
    await fs.writeFile(schema, '{"contract":"fixture"}\n');
    await fs.writeFile(stale, "stale output");
    await fs.writeFile(path.join(directory, "entry.ts"), "export const value = 1;\n");
    const configs = Array.isArray(tsdownConfig) ? tsdownConfig : [tsdownConfig];
    await build({
      cwd: directory,
      config: false,
      entry: ["entry.ts"],
      outDir: "dist",
      clean: configs[0].clean,
      dts: false,
      logLevel: "silent",
    });
    expect(await fs.readFile(schema, "utf8")).toBe('{"contract":"fixture"}\n');
    await expect(fs.stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await fs.readdir(path.join(directory, "dist"))).some((name) => name.startsWith("entry.")),
    ).toBe(true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
