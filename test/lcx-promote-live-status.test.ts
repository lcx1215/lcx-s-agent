import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts/dev/lcx-promote-live.ts");

function tempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lcx-${label}-`));
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return (result.stdout || "").trim();
}

function writePromotionState(targetRoot: string, commit: string): void {
  const statePath = path.join(targetRoot, "branches/_system/live-promotion-state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: "2099-01-01T00:00:00.000Z",
        sourceRoot: "/dev/source",
        targetRoot,
        receiptPath: path.join(targetRoot, "branches/_system/promotions/test.json"),
        manifestPath: path.join(targetRoot, "branches/_system/live-promotion-manifest.json"),
        statePath,
        mode: "apply",
        status: "promoted",
        liveStatus: "waiting_for_real_lark",
        git: {
          branch: "main",
          commit,
          upstream: null,
          trackedDirty: [],
          untracked: [],
          ahead: null,
          behind: null,
        },
        sourceSnapshot: {
          mode: "working_tree",
          originalSourceRoot: null,
          trackedDirty: [],
        },
        blockedReasons: [],
        managedFileCount: 1,
        changedFileCount: 0,
        removedFileCount: 0,
        fileActions: [],
        commands: {
          sourceChecks: [],
          install: null,
          targetBuild: null,
          gatewayInstall: null,
          restart: null,
          probe: null,
        },
        acceptancePhrase: `lark-live-visible-fixed-${commit.slice(0, 10)}`,
        nextLiveProof: [],
        boundary: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function runStatus(sourceRoot: string, targetRoot: string): string {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      scriptPath,
      "--status",
      "--source-root",
      sourceRoot,
      "--target-root",
      targetRoot,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return result.stdout;
}

describe("lcx-promote-live status", () => {
  it("shows when current dev commit differs from the last live promotion", () => {
    const sourceRoot = tempDir("promote-live-source");
    const targetRoot = tempDir("promote-live-target");
    git(sourceRoot, ["init", "--quiet"]);
    git(sourceRoot, ["config", "user.email", "lcx@example.test"]);
    git(sourceRoot, ["config", "user.name", "LCX Test"]);

    fs.writeFileSync(path.join(sourceRoot, "a.txt"), "one\n", "utf8");
    git(sourceRoot, ["add", "a.txt"]);
    git(sourceRoot, ["commit", "--quiet", "-m", "one"]);
    const promotedCommit = git(sourceRoot, ["rev-parse", "HEAD"]);

    fs.writeFileSync(path.join(sourceRoot, "a.txt"), "two\n", "utf8");
    git(sourceRoot, ["add", "a.txt"]);
    git(sourceRoot, ["commit", "--quiet", "-m", "two"]);
    const currentCommit = git(sourceRoot, ["rev-parse", "HEAD"]);

    writePromotionState(targetRoot, promotedCommit);
    const stdout = runStatus(sourceRoot, targetRoot);

    expect(stdout).toContain(`sourceCommit=${promotedCommit}`);
    expect(stdout).toContain(`currentDevCommit=${currentCommit}`);
    expect(stdout).toContain("liveMatchesCurrentDev=false");
    expect(stdout).toContain("liveNeedsPromotion=true");
    expect(stdout).toContain("devLiveDrift=dev_commit_differs");
  });

  it("shows parity when the live promotion commit matches a clean dev tree", () => {
    const sourceRoot = tempDir("promote-live-source");
    const targetRoot = tempDir("promote-live-target");
    git(sourceRoot, ["init", "--quiet"]);
    git(sourceRoot, ["config", "user.email", "lcx@example.test"]);
    git(sourceRoot, ["config", "user.name", "LCX Test"]);

    fs.writeFileSync(path.join(sourceRoot, "a.txt"), "one\n", "utf8");
    git(sourceRoot, ["add", "a.txt"]);
    git(sourceRoot, ["commit", "--quiet", "-m", "one"]);
    const currentCommit = git(sourceRoot, ["rev-parse", "HEAD"]);

    writePromotionState(targetRoot, currentCommit);
    const stdout = runStatus(sourceRoot, targetRoot);

    expect(stdout).toContain(`sourceCommit=${currentCommit}`);
    expect(stdout).toContain(`currentDevCommit=${currentCommit}`);
    expect(stdout).toContain("liveMatchesCurrentDev=true");
    expect(stdout).toContain("liveNeedsPromotion=false");
    expect(stdout).toContain("devLiveDrift=live_matches_current_dev");
  });
});
