import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  buildWatchtowerCodexEscalationRelativePath,
  renderCodexEscalationArtifact,
} from "../hooks/bundled/lobster-brain-registry.js";
import { writeFileWithinRoot } from "./fs-safe.js";

const CODEX_ESCALATION_ELIGIBLE_CATEGORIES = new Set(["artifact_integrity", "write_edit_failure"]);

export type CodexEscalationCommandStatus = "disabled" | "dispatched" | "spawn_failed";

type SpawnLike = typeof spawn;

export function shouldEscalateOperationalIssueToCodex(category: string): boolean {
  return CODEX_ESCALATION_ELIGIBLE_CATEGORIES.has(category.trim());
}

function resolveCodexEscalationCommand(env: NodeJS.ProcessEnv): string | undefined {
  const command = env.OPENCLAW_CODEX_ESCALATION_COMMAND?.trim();
  return command ? command : undefined;
}

function spawnDetachedCommand(params: {
  command: string;
  workspaceDir: string;
  env: NodeJS.ProcessEnv;
  spawnImpl: SpawnLike;
}): ChildProcess {
  if (process.platform === "win32") {
    return params.spawnImpl("cmd.exe", ["/d", "/s", "/c", params.command], {
      cwd: params.workspaceDir,
      env: params.env,
      stdio: "ignore",
      windowsHide: true,
      detached: true,
    });
  }
  return params.spawnImpl("/bin/sh", ["-lc", params.command], {
    cwd: params.workspaceDir,
    env: params.env,
    stdio: "ignore",
    windowsHide: true,
    detached: true,
  });
}

export async function writeAndMaybeDispatchCodexEscalation(params: {
  workspaceDir: string;
  category: string;
  issueKey: string;
  source: string;
  severity: string;
  foundationTemplate: string;
  occurrences: number;
  lastSeen: string;
  repairTicketPath: string;
  anomalyRecordPath?: string;
  problem: string;
  evidenceLines: string[];
  impactLine: string;
  suggestedScopeLine: string;
  generatedAt: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: SpawnLike;
}): Promise<{
  packetPath: string;
  commandStatus: CodexEscalationCommandStatus;
}> {
  const packetPath = buildWatchtowerCodexEscalationRelativePath({
    category: params.category,
    issueKey: params.issueKey,
  });

  await writeFileWithinRoot({
    rootDir: params.workspaceDir,
    relativePath: packetPath,
    data: renderCodexEscalationArtifact({
      titleValue: params.category,
      category: params.category,
      issueKey: params.issueKey,
      source: params.source,
      severity: params.severity,
      foundationTemplate: params.foundationTemplate,
      occurrences: params.occurrences,
      lastSeen: params.lastSeen,
      repairTicketPath: params.repairTicketPath,
      anomalyRecordPath: params.anomalyRecordPath,
      problem: params.problem,
      evidenceLines: params.evidenceLines,
      impactLine: params.impactLine,
      suggestedScopeLine: params.suggestedScopeLine,
      generatedAt: params.generatedAt,
    }),
    encoding: "utf-8",
    mkdir: true,
  });

  const env = params.env ?? process.env;
  const command = resolveCodexEscalationCommand(env);
  if (!command) {
    return { packetPath, commandStatus: "disabled" };
  }

  const absolutePacketPath = path.join(params.workspaceDir, packetPath);
  const spawnEnv: NodeJS.ProcessEnv = {
    ...env,
    OPENCLAW_CODEX_ESCALATION_PACKET_PATH: absolutePacketPath,
    OPENCLAW_CODEX_ESCALATION_RELATIVE_PATH: packetPath,
    OPENCLAW_CODEX_ESCALATION_WORKSPACE_DIR: params.workspaceDir,
    OPENCLAW_CODEX_ESCALATION_ISSUE_KEY: params.issueKey,
    OPENCLAW_CODEX_ESCALATION_CATEGORY: params.category,
    OPENCLAW_CODEX_ESCALATION_SOURCE: params.source,
    OPENCLAW_CODEX_ESCALATION_SEVERITY: params.severity,
  };

  try {
    const child = spawnDetachedCommand({
      command,
      workspaceDir: params.workspaceDir,
      env: spawnEnv,
      spawnImpl: params.spawnImpl ?? spawn,
    });
    child.unref();
    return { packetPath, commandStatus: "dispatched" };
  } catch {
    return { packetPath, commandStatus: "spawn_failed" };
  }
}
