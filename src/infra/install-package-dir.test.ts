import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installPackageDir } from "./install-package-dir.js";

type RmFn = typeof fsp.rm;

describe("installPackageDir", () => {
  let base = "";
  let originalRm: RmFn;

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "install-pkg-dir-"));
    originalRm = fsp.rm;
  });

  afterEach(async () => {
    fsp.rm = originalRm;
    await fs.promises.rm(base, { recursive: true, force: true });
  });

  it("reports a rollback that could not restore the previous install", async () => {
    const targetDir = path.join(base, "pkg");
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, "old.txt"), "old");

    // The failure a full disk or a permissions problem produces: the target cannot be cleared,
    // so the backup cannot be moved back over it.
    fsp.rm = ((target: string) => {
      if (target === targetDir) {
        return Promise.reject(Object.assign(new Error("simulated"), { code: "EACCES" }));
      }
      return originalRm(target);
    }) as RmFn;

    const result = await installPackageDir({
      sourceDir: path.join(base, "does-not-exist"),
      targetDir,
      mode: "update",
      timeoutMs: 1000,
      copyErrorPrefix: "copy failed",
      hasDeps: false,
      depsLogMessage: "deps",
    });

    if (result.ok) {
      throw new Error("expected the install to fail");
    }
    expect(result.error).toContain("rollback incomplete");
    expect(result.error).toContain("EACCES");
  });

  it("says nothing about a rollback that restored the previous install", async () => {
    const targetDir = path.join(base, "pkg");
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, "old.txt"), "old");

    const result = await installPackageDir({
      sourceDir: path.join(base, "does-not-exist"),
      targetDir,
      mode: "update",
      timeoutMs: 1000,
      copyErrorPrefix: "copy failed",
      hasDeps: false,
      depsLogMessage: "deps",
    });

    if (result.ok) {
      throw new Error("expected the install to fail");
    }
    expect(result.error).not.toContain("rollback incomplete");
    // The previous install is back where it was.
    expect(fs.existsSync(path.join(targetDir, "old.txt"))).toBe(true);
  });
});
