import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const baseGitEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
const baseRunEnv: NodeJS.ProcessEnv = { ...process.env, ...baseGitEnv };

const run = (cwd: string, cmd: string, args: string[] = [], env?: NodeJS.ProcessEnv) => {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...baseRunEnv, ...env } : baseRunEnv,
  }).trim();
};

describe("git-hooks/pre-commit (integration)", () => {
  it("leaves no reverse staged changes after a path-specific commit formats its file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lcx-committer-hook-"));
    const file = "handoff [1].md";
    try {
      run(dir, "git", ["init", "-q", "--initial-branch=main"]);
      run(dir, "git", ["config", "user.name", "LCX Test"]);
      run(dir, "git", ["config", "user.email", "test@example.invalid"]);
      run(dir, "git", ["config", "commit.gpgsign", "false"]);
      run(dir, "git", ["config", "core.hooksPath", ".git/hooks"]);
      writeFileSync(path.join(dir, file), "original\n");
      writeFileSync(path.join(dir, "unrelated.md"), "baseline\n");
      run(dir, "git", ["add", "--", file, "unrelated.md"]);
      run(dir, "git", ["commit", "-qm", "initial fixture"]);
      writeFileSync(path.join(dir, file), "unformatted edit\n");
      writeFileSync(path.join(dir, "unrelated.md"), "user edit\n");
      writeFileSync(path.join(dir, "untracked.md"), "keep untracked\n");
      writeFileSync(
        path.join(dir, ".git/hooks/pre-commit"),
        `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' 'formatted edit' > '${file}'\ngit add -- '${file}'\n`,
        { mode: 0o755 },
      );

      run(dir, "bash", [path.join(process.cwd(), "scripts/committer"), "docs: fixture", file]);

      expect(run(dir, "git", ["show", `HEAD:${file}`])).toBe("formatted edit");
      expect(readFileSync(path.join(dir, file), "utf8")).toBe("formatted edit\n");
      expect(run(dir, "git", ["diff", "--cached", "--name-only"])).toBe("");
      expect(run(dir, "git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).toBe(
        file,
      );
      expect(readFileSync(path.join(dir, "unrelated.md"), "utf8")).toBe("user edit\n");
      expect(readFileSync(path.join(dir, "untracked.md"), "utf8")).toBe("keep untracked\n");
      expect(run(dir, "git", ["diff", "--name-only"])).toBe("unrelated.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not treat staged filenames as git-add flags (e.g. --all)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "openclaw-pre-commit-"));
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);

    // Use the real hook script and lightweight helper stubs.
    mkdirSync(path.join(dir, "git-hooks"), { recursive: true });
    mkdirSync(path.join(dir, "scripts", "pre-commit"), { recursive: true });
    symlinkSync(
      path.join(process.cwd(), "git-hooks", "pre-commit"),
      path.join(dir, "git-hooks", "pre-commit"),
    );
    writeFileSync(
      path.join(dir, "scripts", "pre-commit", "run-node-tool.sh"),
      "#!/usr/bin/env bash\nexit 0\n",
      {
        encoding: "utf8",
        mode: 0o755,
      },
    );
    writeFileSync(
      path.join(dir, "scripts", "pre-commit", "filter-staged-files.mjs"),
      "process.exit(0);\n",
      "utf8",
    );
    const fakeBinDir = path.join(dir, "bin");
    mkdirSync(fakeBinDir, { recursive: true });
    writeFileSync(path.join(fakeBinDir, "node"), "#!/usr/bin/env bash\nexit 0\n", {
      encoding: "utf8",
      mode: 0o755,
    });

    // Create an untracked file that should NOT be staged by the hook.
    writeFileSync(path.join(dir, "secret.txt"), "do-not-stage\n", "utf8");

    // Stage a maliciously-named file. Older hooks using `xargs git add` could run `git add --all`.
    writeFileSync(path.join(dir, "--all"), "flag\n", "utf8");
    run(dir, "git", ["add", "--", "--all"]);

    // Run the hook directly (same logic as when installed via core.hooksPath).
    run(dir, "bash", ["git-hooks/pre-commit"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    });

    const staged = run(dir, "git", ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
    expect(staged).toEqual(["--all"]);
  });

  it("can commit a removed tracked file without trying to restore an absent index entry", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lcx-committer-delete-"));
    try {
      run(dir, "git", ["init", "-q", "--initial-branch=main"]);
      run(dir, "git", ["config", "user.name", "LCX Test"]);
      run(dir, "git", ["config", "user.email", "test@example.invalid"]);
      run(dir, "git", ["config", "commit.gpgsign", "false"]);
      run(dir, "git", ["config", "core.hooksPath", ".git/hooks"]);
      writeFileSync(path.join(dir, "obsolete.md"), "fixture\n");
      run(dir, "git", ["add", "--", "obsolete.md"]);
      run(dir, "git", ["commit", "-qm", "initial fixture"]);
      rmSync(path.join(dir, "obsolete.md"));

      run(dir, "bash", [
        path.join(process.cwd(), "scripts/committer"),
        "docs: delete fixture",
        "obsolete.md",
      ]);

      expect(run(dir, "git", ["ls-files"])).toBe("");
      expect(run(dir, "git", ["status", "--porcelain"])).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
