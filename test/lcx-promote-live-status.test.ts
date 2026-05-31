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
          targetUiBuild: null,
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

function runStatus(sourceRoot: string, targetRoot: string, extraArgs: string[] = []): string {
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
      ...extraArgs,
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

function appendReplyFlowRecord(logPath: string, record: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
}

function writeFakePnpm(
  binDir: string,
  logPath: string,
  options: { probeReachable: boolean },
): void {
  const scriptPath = path.join(binDir, "pnpm");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/bin/sh",
      `echo "$*" >> ${JSON.stringify(logPath)}`,
      'if [ "$*" = "ui:build" ]; then',
      '  echo "ui built"',
      "  exit 0",
      "fi",
      'if [ "$*" = "--silent openclaw daemon restart" ]; then',
      `  echo "restart_timeout=$OPENCLAW_DAEMON_RESTART_HEALTH_TIMEOUT_MS" >> ${JSON.stringify(logPath)}`,
      '  echo "Restarted LaunchAgent: gui/501/ai.openclaw.gateway"',
      "  exit 0",
      "fi",
      'if [ "$*" = "--silent openclaw channels status --probe" ]; then',
      options.probeReachable
        ? '  echo "Gateway reachable."'
        : '  echo "Gateway not reachable; showing config-only status."',
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(scriptPath, 0o755);
}

function runApplyWithFakePnpm(params: {
  sourceRoot: string;
  targetRoot: string;
  fakeBinDir: string;
  json?: boolean;
}): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      scriptPath,
      "--apply",
      "--source-root",
      params.sourceRoot,
      "--target-root",
      params.targetRoot,
      "--skip-source-checks",
      "--skip-install",
      "--skip-gateway-install",
      ...(params.json ? ["--json"] : []),
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${params.fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    },
  );
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
    expect(stdout).toContain(
      "externalChannelStatusModel=dev-ready -> external-channel-bound -> user-visible-observed",
    );
    expect(stdout).toContain("externalChannel=lark");
    expect(stdout).toContain("externalChannelBound=false");
    expect(stdout).toContain("userVisibleObserved=false");
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
    expect(stdout).toContain(
      "externalChannelStatusModel=dev-ready -> external-channel-bound -> user-visible-observed",
    );
    expect(stdout).toContain("externalChannel=lark");
    expect(stdout).toContain("externalChannelBound=true");
    expect(stdout).toContain("userVisibleObserved=false");
    expect(stdout).toContain("statusModel=dev-ready -> live-runtime-updated -> live-user-seen");
    expect(stdout).toContain("devReady=not_checked_by_live_status");
    expect(stdout).toContain("liveRuntimeCommitMatched=true");
    expect(stdout).toContain("liveRuntimeRestartCommandStatus=passed");
    expect(stdout).toContain("liveRuntimeProbePassed=true");
    expect(stdout).toContain("liveRuntimeUpdated=true");
    expect(stdout).toContain("liveUserSeen=false");
    expect(stdout).toContain("nextHumanStep=send_real_lark_natural_probe");
    expect(stdout).toContain("naturalProbeMessage=现在状态怎么样？");
    expect(stdout).toContain(
      `acceptanceMessage=可选收据锚点：请回复 lark-live-visible-fixed-${currentCommit.slice(
        0,
        10,
      )}，用于精确匹配这次通道验收。`,
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

  it("keeps json status bounded by summarizing promotion receipt internals", () => {
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
    const statePath = path.join(targetRoot, "branches/_system/live-promotion-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      fileActions: unknown[];
      commands: {
        targetBuild: { stdout: string; stderr: string };
      };
    };
    state.fileActions = Array.from({ length: 250 }, (_, index) => ({
      relativePath: `file-${index}.ts`,
      sourceSha256: "source",
      targetSha256Before: "before",
      targetSha256After: "source",
      copied: true,
      removed: false,
    }));
    state.commands.targetBuild = {
      command: "pnpm build",
      cwd: targetRoot,
      status: "passed",
      code: 0,
      stdout: "x".repeat(10_000),
      stderr: "y".repeat(10_000),
    };
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

    const payload = JSON.parse(runStatus(sourceRoot, targetRoot, ["--json"])) as {
      state: {
        fileActions?: unknown;
        commands?: unknown;
        fileActionSummary: {
          storedCount: number;
          copiedCount: number;
          managedFileCount: number;
        };
        commandSummary: {
          targetBuild: { command: string; status: string; stdout?: unknown; stderr?: unknown };
        };
      };
      operatorStatus: { liveRuntimeUpdated: boolean };
      externalChannelStatus: { externalChannelBound: boolean; userVisibleObserved: boolean };
      visibleProof: { status: string };
    };

    expect(payload.state.fileActions).toBeUndefined();
    expect(payload.state.commands).toBeUndefined();
    expect(payload.state.fileActionSummary).toMatchObject({
      storedCount: 250,
      copiedCount: 250,
      managedFileCount: 1,
    });
    expect(payload.state.commandSummary.targetBuild).toEqual({
      command: "pnpm build",
      cwd: targetRoot,
      status: "passed",
      code: 0,
    });
    expect(payload.state.commandSummary.targetBuild.stdout).toBeUndefined();
    expect(payload.state.commandSummary.targetBuild.stderr).toBeUndefined();
    expect(payload.operatorStatus.liveRuntimeUpdated).toBe(true);
    expect(payload.externalChannelStatus).toMatchObject({
      externalChannelBound: true,
      userVisibleObserved: false,
    });
    expect(payload.visibleProof.status).toBe("reply_flow_missing");
  });

  it("counts a real post-migration Lark reply as live-user-seen without requiring the fixed acceptance phrase", () => {
    const sourceRoot = tempDir("promote-live-source");
    const targetRoot = tempDir("promote-live-target");
    const replyFlowLog = path.join(tempDir("promote-live-reply-flow"), "feishu-reply-flow.jsonl");
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
    appendReplyFlowRecord(replyFlowLog, {
      kind: "feishu_reply_flow",
      stage: "inbound",
      recordedAt: "2099-01-01T00:01:00.000Z",
      messageId: "om_learning_real_user",
      chatId: "oc_control",
      chatType: "group",
      contentType: "text",
      textPreview: "请用网上可靠来源和本地沉淀，一起做一次期权基础学习审阅",
    });
    appendReplyFlowRecord(replyFlowLog, {
      kind: "feishu_reply_flow",
      stage: "outbound_result",
      recordedAt: "2099-01-01T00:02:00.000Z",
      messageId: "om_learning_real_user",
      chatId: "oc_control",
      replyKind: "final",
      sendMode: "message",
      deliveryStatus: "success",
      textPreview: "收到，已开始学：期权基础。",
    });

    const stdout = runStatus(sourceRoot, targetRoot, ["--reply-flow-log", replyFlowLog]);

    expect(stdout).toContain("liveRuntimeUpdated=true");
    expect(stdout).toContain("liveUserSeen=true");
    expect(stdout).toContain("externalChannelBound=true");
    expect(stdout).toContain("userVisibleObserved=true");
    expect(stdout).toContain("nextHumanStep=no_action_current_dev_seen_in_live");
    expect(stdout).toContain("liveVisibleStatus=post_migration_reply_seen");
    expect(stdout).toContain("freshInboundCount=1");
    expect(stdout).toContain("freshOutboundResultCount=1");
    expect(stdout).toContain("acceptanceMatched=false");
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

  it("treats a matching commit as live-runtime-updated when fresh probe passes after restart timeout", () => {
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
    expect(stdout).toContain("liveRuntimeUpdated=true");
    expect(stdout).toContain("nextHumanStep=send_real_lark_natural_probe");
  });

  it("runs target ui build before live restart and probe", () => {
    const sourceRoot = tempDir("promote-live-source");
    const targetRoot = tempDir("promote-live-target");
    const fakeBinDir = tempDir("promote-live-bin");
    const commandLog = path.join(fakeBinDir, "pnpm.log");
    writeFakePnpm(fakeBinDir, commandLog, { probeReachable: true });
    git(sourceRoot, ["init", "--quiet"]);
    git(sourceRoot, ["config", "user.email", "lcx@example.test"]);
    git(sourceRoot, ["config", "user.name", "LCX Test"]);
    fs.writeFileSync(path.join(sourceRoot, "a.txt"), "one\n", "utf8");
    git(sourceRoot, ["add", "a.txt"]);
    git(sourceRoot, ["commit", "--quiet", "-m", "one"]);

    const result = runApplyWithFakePnpm({ sourceRoot, targetRoot, fakeBinDir });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("pnpm build.status=passed");
    expect(result.stdout).toContain("pnpm ui:build.status=passed");
    expect(result.stdout).toContain("pnpm --silent openclaw daemon restart.status=passed");
    expect(result.stdout).toContain("pnpm --silent openclaw channels status --probe.status=passed");
    expect(fs.readFileSync(commandLog, "utf8").split(/\r?\n/u).filter(Boolean)).toEqual([
      "build",
      "ui:build",
      "--silent openclaw daemon restart",
      "restart_timeout=90000",
      "--silent openclaw channels status --probe",
    ]);
  });

  it("keeps apply json output bounded while the receipt file remains auditable", () => {
    const sourceRoot = tempDir("promote-live-source");
    const targetRoot = tempDir("promote-live-target");
    const fakeBinDir = tempDir("promote-live-bin");
    const commandLog = path.join(fakeBinDir, "pnpm.log");
    writeFakePnpm(fakeBinDir, commandLog, { probeReachable: true });
    git(sourceRoot, ["init", "--quiet"]);
    git(sourceRoot, ["config", "user.email", "lcx@example.test"]);
    git(sourceRoot, ["config", "user.name", "LCX Test"]);
    fs.writeFileSync(path.join(sourceRoot, "a.txt"), "one\n", "utf8");
    git(sourceRoot, ["add", "a.txt"]);
    git(sourceRoot, ["commit", "--quiet", "-m", "one"]);

    const result = runApplyWithFakePnpm({ sourceRoot, targetRoot, fakeBinDir, json: true });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      fileActions?: unknown;
      commands?: unknown;
      receiptPath: string;
      fileActionSummary: { storedCount: number; managedFileCount: number };
      commandSummary: {
        targetBuild: { stdout?: unknown; stderr?: unknown };
        targetUiBuild: { stdout?: unknown; stderr?: unknown };
        restart: { status: string };
        probe: { status: string };
      };
      visibleProof: { status: string };
    };
    const receipt = JSON.parse(fs.readFileSync(payload.receiptPath, "utf8")) as {
      fileActions: unknown[];
      commands: { targetUiBuild: { stdout: string } };
    };

    expect(payload.fileActions).toBeUndefined();
    expect(payload.commands).toBeUndefined();
    expect(payload.fileActionSummary).toMatchObject({ storedCount: 1, managedFileCount: 1 });
    expect(payload.commandSummary.targetBuild.stdout).toBeUndefined();
    expect(payload.commandSummary.targetBuild.stderr).toBeUndefined();
    expect(payload.commandSummary.targetUiBuild.stdout).toBeUndefined();
    expect(payload.commandSummary.targetUiBuild.stderr).toBeUndefined();
    expect(payload.commandSummary.restart.status).toBe("passed");
    expect(payload.commandSummary.probe.status).toBe("passed");
    expect(payload.visibleProof.status).toBe("reply_flow_missing");
    expect(receipt.fileActions).toHaveLength(1);
    expect(receipt.commands.targetUiBuild.stdout).toContain("ui built");
  });

  it("fails live promotion when channel probe exits zero but reports gateway unreachable", () => {
    const sourceRoot = tempDir("promote-live-source");
    const targetRoot = tempDir("promote-live-target");
    const fakeBinDir = tempDir("promote-live-bin");
    const commandLog = path.join(fakeBinDir, "pnpm.log");
    writeFakePnpm(fakeBinDir, commandLog, { probeReachable: false });
    git(sourceRoot, ["init", "--quiet"]);
    git(sourceRoot, ["config", "user.email", "lcx@example.test"]);
    git(sourceRoot, ["config", "user.name", "LCX Test"]);
    fs.writeFileSync(path.join(sourceRoot, "a.txt"), "one\n", "utf8");
    git(sourceRoot, ["add", "a.txt"]);
    git(sourceRoot, ["commit", "--quiet", "-m", "one"]);

    const result = runApplyWithFakePnpm({ sourceRoot, targetRoot, fakeBinDir });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("promoteLive=blocked");
    expect(result.stdout).toContain("blockedReason=channel probe failed");
    expect(result.stdout).toContain("pnpm --silent openclaw channels status --probe.status=failed");
  });
});
