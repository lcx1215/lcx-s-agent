import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

describe("runtime commit identity", () => {
  it("uses source identity even when the first call happens inside a user workspace", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-identity-"));
    const previous = process.cwd();
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const expected = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" })
      .trim()
      .slice(0, 7);
    try {
      vi.resetModules();
      const { resolveCommitHash } = await import("./git-commit.js");
      process.chdir(temp);
      expect(resolveCommitHash({ env: {} })).toBe(expected);
      expect(resolveCommitHash({ env: { GIT_COMMIT: "abcdef123456" } })).toBe("abcdef1");
      expect(resolveCommitHash({ env: {} })).toBe(expected);
      expect(resolveCommitHash({ cwd: temp, env: {} })).toBeNull();
    } finally {
      process.chdir(previous);
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
});
