import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts/dev/lcx-automation-repair-lock.ts");

async function runLock(args: string[], cwd: string, home: string) {
  const result = await execFileAsync(
    process.execPath,
    ["--import", "tsx", scriptPath, "--json", ...args],
    {
      cwd: repoRoot,
      env: { ...process.env, HOME: home },
    },
  );
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("lcx automation repair lock", () => {
  it("serializes automation repair ownership by token", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-repair-lock-home-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-repair-lock-cwd-"));

    const acquired = await runLock(
      ["--mode", "acquire", "--lane", "teacher-quality", "--worktree", cwd],
      cwd,
      home,
    );
    expect(acquired.acquired).toBe(true);
    expect(typeof acquired.token).toBe("string");

    const blocked = await runLock(
      ["--mode", "acquire", "--lane", "health", "--worktree", cwd],
      cwd,
      home,
    );
    expect(blocked.acquired).toBe(false);
    expect(blocked.status).toBe("locked");

    const released = await runLock(
      [
        "--mode",
        "release",
        "--lane",
        "teacher-quality",
        "--token",
        String(acquired.token),
        "--worktree",
        cwd,
      ],
      cwd,
      home,
    );
    expect(released.released).toBe(true);

    const reacquired = await runLock(
      ["--mode", "acquire", "--lane", "health", "--worktree", cwd],
      cwd,
      home,
    );
    expect(reacquired.acquired).toBe(true);
  });

  it("refuses repair ownership on dirty git worktrees", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-repair-lock-home-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-repair-lock-repo-"));
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.email", "codex@example.invalid"], { cwd });
    await execFileAsync("git", ["config", "user.name", "Codex Test"], { cwd });
    await fs.writeFile(path.join(cwd, "tracked.txt"), "clean\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd });
    await fs.writeFile(path.join(cwd, "tracked.txt"), "dirty\n");

    const blocked = await runLock(
      ["--mode", "acquire", "--lane", "dev-acceptance", "--worktree", cwd],
      cwd,
      home,
    );
    expect(blocked.acquired).toBe(false);
    expect(blocked.status).toBe("dirty_worktree");
    expect(blocked.dirtyFiles).toContain(" M tracked.txt");
  });
});
