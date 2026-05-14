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

function writePromotionState(
  targetRoot: string,
  commit: string,
  options: {
    restartStatus?: "skipped" | "passed" | "failed";
    probeStatus?: "skipped" | "passed" | "failed";
  } = {},
): void {
  const statePath = path.join(targetRoot, "branches/_system/live-promotion-state.json");
  const command = (name: string, status: "skipped" | "passed" | "failed") => ({
    command: name,
    cwd: targetRoot,
    status,
    code: status === "failed" ? 1 : 0,
    stdout: "",
    stderr: "",
  });
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
          restart: options.restartStatus
            ? command("pnpm --silent openclaw daemon restart", options.restartStatus)
            : null,
          probe: options.probeStatus
            ? command("pnpm --silent openclaw channels status --probe", options.probeStatus)
            : null,
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
  it("blocks overlapping live promotion runs before touching the target", () => {
    const sourceRoot = tempDir("promote-live-source");
    const targetRoot = tempDir("promote-live-target");
    const lockDir = path.join(targetRoot, "branches/_system/live-promotion.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        scriptPath,
        "--apply",
        "--source-root",
        sourceRoot,
        "--target-root",
        targetRoot,
        "--skip-source-checks",
        "--skip-install",
        "--skip-target-build",
        "--skip-gateway-install",
        "--skip-restart",
        "--skip-probe",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("live promotion already running");
    expect(result.stderr).toContain(`pid=${process.pid}`);
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(
      fs.existsSync(path.join(targetRoot, "branches/_system/live-promotion-manifest.json")),
    ).toBe(false);
  });

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
    expect(stdout).toContain("statusModel=dev-ready -> live-runtime-updated -> live-user-seen");
    expect(stdout).toContain("devReady=not_checked_by_live_status");
    expect(stdout).toContain("liveRuntimeCommitMatched=false");
    expect(stdout).toContain("liveRuntimeRestartCommandStatus=not_run");
    expect(stdout).toContain("liveRuntimeProbePassed=false");
    expect(stdout).toContain("liveRuntimeUpdated=false");
    expect(stdout).toContain("liveUserSeen=false");
    expect(stdout).toContain("nextHumanStep=run_dev_tests_then_promote_dev_to_live");
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

    writePromotionState(targetRoot, currentCommit, {
      restartStatus: "passed",
      probeStatus: "passed",
    });
    const stdout = runStatus(sourceRoot, targetRoot);

    expect(stdout).toContain(`sourceCommit=${currentCommit}`);
    expect(stdout).toContain(`currentDevCommit=${currentCommit}`);
    expect(stdout).toContain("statusModel=dev-ready -> live-runtime-updated -> live-user-seen");
    expect(stdout).toContain("devReady=not_checked_by_live_status");
    expect(stdout).toContain("liveRuntimeCommitMatched=true");
    expect(stdout).toContain("liveRuntimeRestartCommandStatus=passed");
    expect(stdout).toContain("liveRuntimeProbePassed=true");
    expect(stdout).toContain("liveRuntimeUpdated=true");
    expect(stdout).toContain("liveUserSeen=false");
    expect(stdout).toContain("nextHumanStep=send_real_lark_acceptance");
    expect(stdout).toContain(
      `acceptanceMessage=live验收：请只回复 lark-live-visible-fixed-${currentCommit.slice(
        0,
        10,
      )}，并说明这是重启后的真实链路。`,
    );
    expect(stdout).toContain(
      "postMigrationProbeCommand=/Users/liuchengxu/.codex/skills/lark-post-migration-probe/scripts/lark-post-migration-probe.sh --since 2099-01-01T00:00:00.000Z",
    );
    expect(stdout).toContain(
      "replyFlowProbeCommand=node --import tsx scripts/dev/lcx-promote-live.ts --status --with-probe",
    );
    expect(stdout).toContain("liveMatchesCurrentDev=true");
    expect(stdout).toContain("liveNeedsPromotion=false");
    expect(stdout).toContain("devLiveDrift=live_matches_current_dev");
  });

  it("does not call dirty dev work live-runtime-updated", () => {
    const sourceRoot = tempDir("promote-live-source");
    const targetRoot = tempDir("promote-live-target");
    git(sourceRoot, ["init", "--quiet"]);
    git(sourceRoot, ["config", "user.email", "lcx@example.test"]);
    git(sourceRoot, ["config", "user.name", "LCX Test"]);

    fs.writeFileSync(path.join(sourceRoot, "a.txt"), "one\n", "utf8");
    git(sourceRoot, ["add", "a.txt"]);
    git(sourceRoot, ["commit", "--quiet", "-m", "one"]);
    const currentCommit = git(sourceRoot, ["rev-parse", "HEAD"]);

    fs.writeFileSync(path.join(sourceRoot, "a.txt"), "dirty\n", "utf8");
    writePromotionState(targetRoot, currentCommit, {
      restartStatus: "passed",
      probeStatus: "passed",
    });
    const stdout = runStatus(sourceRoot, targetRoot);

    expect(stdout).toContain(`sourceCommit=${currentCommit}`);
    expect(stdout).toContain(`currentDevCommit=${currentCommit}`);
    expect(stdout).toContain("liveRuntimeCommitMatched=false");
    expect(stdout).toContain("liveRuntimeRestartCommandStatus=passed");
    expect(stdout).toContain("liveRuntimeProbePassed=true");
    expect(stdout).toContain("liveRuntimeUpdated=false");
    expect(stdout).toContain("liveUserSeen=false");
    expect(stdout).toContain("nextHumanStep=commit_or_clean_dev_then_run_dev_tests");
    expect(stdout).toContain("liveMatchesCurrentDev=false");
    expect(stdout).toContain("liveNeedsPromotion=true");
    expect(stdout).toContain("devLiveDrift=current_dev_dirty");
  });

  it("does not call matching commit live-runtime-updated without runtime probe evidence", () => {
    const sourceRoot = tempDir("promote-live-source");
    const targetRoot = tempDir("promote-live-target");
    git(sourceRoot, ["init", "--quiet"]);
    git(sourceRoot, ["config", "user.email", "lcx@example.test"]);
    git(sourceRoot, ["config", "user.name", "LCX Test"]);

    fs.writeFileSync(path.join(sourceRoot, "a.txt"), "one\n", "utf8");
    git(sourceRoot, ["add", "a.txt"]);
    git(sourceRoot, ["commit", "--quiet", "-m", "one"]);
    const currentCommit = git(sourceRoot, ["rev-parse", "HEAD"]);

    writePromotionState(targetRoot, currentCommit, { restartStatus: "passed" });
    const stdout = runStatus(sourceRoot, targetRoot);

    expect(stdout).toContain("liveRuntimeCommitMatched=true");
    expect(stdout).toContain("liveRuntimeRestartCommandStatus=passed");
    expect(stdout).toContain("liveRuntimeProbePassed=false");
    expect(stdout).toContain("liveRuntimeUpdated=false");
    expect(stdout).toContain("nextHumanStep=retry_live_restart_then_probe");
  });

  it("does not call matching commit live-runtime-updated when restart failed but probe passed", () => {
    const sourceRoot = tempDir("promote-live-source");
    const targetRoot = tempDir("promote-live-target");
    git(sourceRoot, ["init", "--quiet"]);
    git(sourceRoot, ["config", "user.email", "lcx@example.test"]);
    git(sourceRoot, ["config", "user.name", "LCX Test"]);

    fs.writeFileSync(path.join(sourceRoot, "a.txt"), "one\n", "utf8");
    git(sourceRoot, ["add", "a.txt"]);
    git(sourceRoot, ["commit", "--quiet", "-m", "one"]);
    const currentCommit = git(sourceRoot, ["rev-parse", "HEAD"]);

    writePromotionState(targetRoot, currentCommit, {
      restartStatus: "failed",
      probeStatus: "passed",
    });
    const stdout = runStatus(sourceRoot, targetRoot);

    expect(stdout).toContain("liveRuntimeCommitMatched=true");
    expect(stdout).toContain("liveRuntimeRestartCommandStatus=failed");
    expect(stdout).toContain("liveRuntimeProbePassed=true");
    expect(stdout).toContain("liveRuntimeUpdated=false");
    expect(stdout).toContain("nextHumanStep=retry_live_restart_then_probe");
  });
});
