import fs from "node:fs/promises";
import path from "node:path";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { formatValidationErrors, validateAgentParams } from "../../gateway/protocol/index.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { resolveUserPath } from "../../utils.js";
import { runLanguageBrainLoopSmoke } from "./language-brain-loop-smoke.js";

export type LarkLoopDiagnoseCommandOptions = {
  agent?: string;
  workspaceDir?: string;
  fixtureDir?: string;
  json?: boolean;
};

type ReceiptStats = {
  agentId: string | null;
  workspaceDir: string;
  count: number;
  latestPath: string | null;
  latestGeneratedAt: string | null;
};

type AggregateReceiptStats = {
  workspaceDir: string;
  count: number;
  latestPath: string | null;
  latestGeneratedAt: string | null;
  workspaces: ReceiptStats[];
};

type ReceiptWorkspace = {
  agentId: string | null;
  workspaceDir: string;
};

type GatewayModelParamSchemaCheck = {
  ok: boolean;
  error: string | null;
};

async function walkJsonFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(fullPath);
      }
    }
  }
  await walk(root);
  return files;
}

function dedupeReceiptWorkspaces(workspaces: ReceiptWorkspace[]): ReceiptWorkspace[] {
  const seen = new Set<string>();
  const result: ReceiptWorkspace[] = [];
  for (const workspace of workspaces) {
    if (seen.has(workspace.workspaceDir)) {
      continue;
    }
    seen.add(workspace.workspaceDir);
    result.push(workspace);
  }
  return result;
}

function resolveReceiptWorkspaces(opts: LarkLoopDiagnoseCommandOptions): ReceiptWorkspace[] {
  if (opts.workspaceDir?.trim()) {
    return [
      {
        agentId: opts.agent?.trim() || null,
        workspaceDir: path.resolve(resolveUserPath(opts.workspaceDir.trim())),
      },
    ];
  }
  const cfg = loadConfig();
  const agentIds = opts.agent?.trim() ? [opts.agent.trim()] : listAgentIds(cfg);
  if (agentIds.length === 0) {
    const agentId = resolveDefaultAgentId(cfg);
    return [{ agentId, workspaceDir: resolveAgentWorkspaceDir(cfg, agentId) }];
  }
  return dedupeReceiptWorkspaces(
    agentIds.map((agentId) => ({
      agentId,
      workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
    })),
  );
}

async function readSingleReceiptStats(workspace: ReceiptWorkspace): Promise<ReceiptStats> {
  const workspaceDir = workspace.workspaceDir;
  const root = path.join(workspaceDir, "memory", "lark-language-handoff-receipts");
  const files = await walkJsonFiles(root);
  let latestPath: string | null = null;
  let latestGeneratedAt: string | null = null;
  for (const filePath of files) {
    let generatedAt: string | null = null;
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as { generatedAt?: unknown };
      generatedAt =
        typeof parsed.generatedAt === "string" && parsed.generatedAt.trim()
          ? parsed.generatedAt
          : null;
    } catch {
      generatedAt = null;
    }
    if ((generatedAt ?? "") >= (latestGeneratedAt ?? "")) {
      latestGeneratedAt = generatedAt;
      latestPath = path.relative(workspaceDir, filePath).replaceAll(path.sep, "/");
    }
  }
  return {
    agentId: workspace.agentId,
    workspaceDir,
    count: files.length,
    latestPath,
    latestGeneratedAt,
  };
}

export async function readReceiptStats(
  opts: LarkLoopDiagnoseCommandOptions,
): Promise<AggregateReceiptStats> {
  const workspaces = await Promise.all(resolveReceiptWorkspaces(opts).map(readSingleReceiptStats));
  let latestPath: string | null = null;
  let latestGeneratedAt: string | null = null;
  let latestWorkspaceDir: string | null = null;
  let count = 0;
  for (const workspace of workspaces) {
    count += workspace.count;
    if ((workspace.latestGeneratedAt ?? "") >= (latestGeneratedAt ?? "") && workspace.latestPath) {
      latestGeneratedAt = workspace.latestGeneratedAt;
      latestPath = workspace.latestPath;
      latestWorkspaceDir = workspace.workspaceDir;
    }
  }
  return {
    workspaceDir:
      workspaces.length === 1
        ? (workspaces[0]?.workspaceDir ?? "")
        : (latestWorkspaceDir ?? "multiple"),
    count,
    latestPath,
    latestGeneratedAt,
    workspaces,
  };
}

function checkGatewayModelParamSchema(): GatewayModelParamSchemaCheck {
  const ok = validateAgentParams({
    message: "schema smoke",
    agentId: "main",
    sessionKey: "agent:main:lark-loop-diagnose-schema-smoke",
    model: "moonshot/kimi-k2.5",
    idempotencyKey: "lark-loop-diagnose-schema-smoke",
  });
  return {
    ok,
    error: ok ? null : formatValidationErrors(validateAgentParams.errors),
  };
}

function formatDiagnosisText(payload: Record<string, unknown>): string {
  const localLoop = payload.localLoop as Record<string, unknown>;
  const receipts = payload.liveHandoffReceipts as AggregateReceiptStats;
  const gatewaySchema = payload.gatewayAgentModelParamSchema as GatewayModelParamSchemaCheck;
  const scalar = (value: unknown) =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "unknown";
  const lines = [
    "LCX Lark loop diagnosis",
    "",
    `localLoop: ${localLoop.ok ? "ok" : "failed"}`,
    `localFamily: ${scalar(localLoop.family)}`,
    `localBackendTool: ${scalar(localLoop.backendTool)}`,
    `localAnalysis: ${scalar(localLoop.analysisStatus)}`,
    `gatewayAgentModelParamSchema: ${gatewaySchema.ok ? "ok" : "failed"}`,
    `liveHandoffReceipts: ${receipts.count}`,
    `receiptWorkspaces: ${receipts.workspaces.length}`,
  ];
  for (const workspace of receipts.workspaces) {
    lines.push(
      `  - ${workspace.agentId ?? "workspace"}: ${workspace.count} (${workspace.workspaceDir})`,
    );
  }
  if (receipts.latestPath) {
    lines.push(`latestReceipt: ${receipts.latestPath}`);
  }
  if (gatewaySchema.error) {
    lines.push(`gatewayAgentModelParamSchemaError: ${gatewaySchema.error}`);
  }
  lines.push("");
  lines.push(`nextBlocker: ${String(payload.nextBlocker)}`);
  return lines.join("\n");
}

export async function larkLoopDiagnoseCommand(
  opts: LarkLoopDiagnoseCommandOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const gatewayAgentModelParamSchema = checkGatewayModelParamSchema();
  const [localLoop, liveHandoffReceipts] = await Promise.all([
    runLanguageBrainLoopSmoke({ fixtureDir: opts.fixtureDir }),
    readReceiptStats(opts),
  ]);
  const payload = {
    ok: localLoop.ok && liveHandoffReceipts.count > 0 && gatewayAgentModelParamSchema.ok,
    gatewayAgentModelParamSchema,
    localLoop: {
      ok: localLoop.ok,
      family: localLoop.language.family,
      backendTool: localLoop.language.backendTool,
      analysisStatus: localLoop.analysis.eventReviewStatus,
      noActionBoundary: localLoop.analysis.noActionBoundary,
      receiptPath: localLoop.memory.loopReceiptPath,
    },
    liveHandoffReceipts,
    nextBlocker: !gatewayAgentModelParamSchema.ok
      ? "gateway_agent_model_param_schema_rejects_learning_council"
      : liveHandoffReceipts.count > 0
        ? "none"
        : "no_live_lark_user_inbound_handoff_receipt_yet",
    boundaries: {
      noRemoteFetchOccurred: localLoop.noRemoteFetchOccurred,
      noExecutionAuthority: localLoop.noExecutionAuthority,
      protectedMemoryUntouched: localLoop.protectedMemoryUntouched,
      localLoopDoesNotProveLiveIngress: true,
    },
  };
  runtime.log(opts.json ? JSON.stringify(payload, null, 2) : formatDiagnosisText(payload));
}
