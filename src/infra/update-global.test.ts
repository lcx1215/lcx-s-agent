import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectGlobalInstallManagerByPresence,
  detectGlobalInstallManagerForRoot,
  resolveGlobalPackageRoot,
} from "./update-global.js";

describe("global update package identity", () => {
  it("recognizes the canonical lcx-agent package in npm's global root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-update-global-"));
    try {
      const globalRoot = path.join(root, "node_modules");
      const packageRoot = path.join(globalRoot, "lcx-agent");
      await fs.mkdir(packageRoot, { recursive: true });
      const runCommand = async (argv: string[]) =>
        argv[0] === "npm"
          ? { stdout: `${globalRoot}\n`, stderr: "", code: 0 }
          : { stdout: "", stderr: "", code: 1 };

      await expect(resolveGlobalPackageRoot("npm", runCommand, 1_000)).resolves.toBe(packageRoot);
      await expect(detectGlobalInstallManagerForRoot(runCommand, packageRoot, 1_000)).resolves.toBe(
        "npm",
      );
      await expect(detectGlobalInstallManagerByPresence(runCommand, 1_000)).resolves.toBe("npm");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
