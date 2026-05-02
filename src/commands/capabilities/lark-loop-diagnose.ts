import fs from "node:fs/promises";
import path from "node:path";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { planFinanceBrainOrchestration } from "../../agents/finance-brain-orchestration.js";
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
  financeOrchestrationCount: number;
  latestFinanceOrchestration: FinanceOrchestrationReceiptSummary | null;
  latestReceiptFinanceReplay: FinanceOrchestrationReceiptSummary | null;
};

type AggregateReceiptStats = {
  workspaceDir: string;
  count: number;
  latestPath: string | null;
  latestGeneratedAt: string | null;
  financeOrchestrationCount: number;
  latestFinanceOrchestration: FinanceOrchestrationReceiptSummary | null;
  latestReceiptFinanceReplay: FinanceOrchestrationReceiptSummary | null;
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

type FinanceOrchestrationReceiptSummary = {
  receiptPath: string;
  generatedAt: string | null;
  family: string | null;
  source: string | null;
  primaryModules: string[];
  supportingModules: string[];
  requiredTools: string[];
  reviewTools: string[];
  boundaries: string[];
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function summarizeFinanceOrchestrationReceipt(params: {
  workspaceDir: string;
  filePath: string;
  parsed: Record<string, unknown>;
}): FinanceOrchestrationReceiptSummary | null {
  const orchestration = params.parsed.financeBrainOrchestration;
  if (!orchestration || typeof orchestration !== "object" || Array.isArray(orchestration)) {
    return null;
  }
  const handoff = params.parsed.handoff;
  const handoffRecord =
    handoff && typeof handoff === "object" && !Array.isArray(handoff)
      ? (handoff as Record<string, unknown>)
      : {};
  const orchestrationRecord = orchestration as Record<string, unknown>;
  return {
    receiptPath: path.relative(params.workspaceDir, params.filePath).replaceAll(path.sep, "/"),
    generatedAt:
      typeof params.parsed.generatedAt === "string" && params.parsed.generatedAt.trim()
        ? params.parsed.generatedAt
        : null,
    family: typeof handoffRecord.family === "string" ? handoffRecord.family : null,
    source: typeof handoffRecord.source === "string" ? handoffRecord.source : null,
    primaryModules: stringArray(orchestrationRecord.primaryModules),
    supportingModules: stringArray(orchestrationRecord.supportingModules),
    requiredTools: stringArray(orchestrationRecord.requiredTools),
    reviewTools: stringArray(orchestrationRecord.reviewTools),
    boundaries: stringArray(orchestrationRecord.boundaries),
  };
}

function hasLocalMathInputs(text: string): boolean {
  return /数学|计算|math|calculate|beta|volatility|covariance|回撤|夏普/iu.test(text);
}

function summarizeFinanceOrchestrationReplay(params: {
  workspaceDir: string;
  filePath: string;
  parsed: Record<string, unknown>;
}): FinanceOrchestrationReceiptSummary | null {
  const userMessage =
    typeof params.parsed.userMessage === "string" ? params.parsed.userMessage.trim() : "";
  if (!userMessage) {
    return null;
  }
  const handoff = params.parsed.handoff;
  const handoffRecord =
    handoff && typeof handoff === "object" && !Array.isArray(handoff)
      ? (handoff as Record<string, unknown>)
      : {};
  const family = typeof handoffRecord.family === "string" ? handoffRecord.family : null;
  const plan = planFinanceBrainOrchestration({
    text: userMessage,
    hasHoldingsOrPortfolioContext:
      family === "position_risk_adjustment" || family === "bracket_exit_plan",
    hasLocalMathInputs: hasLocalMathInputs(userMessage),
    highStakesConclusion:
      family === "position_risk_adjustment" ||
      family === "trading_execution_boundary" ||
      family === "trading_execution_order",
  });
  if (plan.primaryModules.length === 0 && plan.supportingModules.length === 0) {
    return null;
  }
  return {
    receiptPath: path.relative(params.workspaceDir, params.filePath).replaceAll(path.sep, "/"),
    generatedAt:
      typeof params.parsed.generatedAt === "string" && params.parsed.generatedAt.trim()
        ? params.parsed.generatedAt
        : null,
    family,
    source: typeof handoffRecord.source === "string" ? handoffRecord.source : null,
    primaryModules: plan.primaryModules,
    supportingModules: plan.supportingModules,
    requiredTools: plan.requiredTools,
    reviewTools: plan.reviewTools,
    boundaries: plan.boundaries,
  };
}

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
  let latestParsed: Record<string, unknown> | null = null;
  let latestFilePath: string | null = null;
  let financeOrchestrationCount = 0;
  let latestFinanceOrchestration: FinanceOrchestrationReceiptSummary | null = null;
  for (const filePath of files) {
    let generatedAt: string | null = null;
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
      generatedAt =
        typeof parsed.generatedAt === "string" && parsed.generatedAt.trim()
          ? parsed.generatedAt
          : null;
      const financeSummary = summarizeFinanceOrchestrationReceipt({
        workspaceDir,
        filePath,
        parsed,
      });
      if (financeSummary) {
        financeOrchestrationCount += 1;
        if ((financeSummary.generatedAt ?? "") >= (latestFinanceOrchestration?.generatedAt ?? "")) {
          latestFinanceOrchestration = financeSummary;
        }
      }
    } catch {
      generatedAt = null;
    }
    if ((generatedAt ?? "") >= (latestGeneratedAt ?? "")) {
      latestGeneratedAt = generatedAt;
      latestPath = path.relative(workspaceDir, filePath).replaceAll(path.sep, "/");
      try {
        latestParsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
        latestFilePath = filePath;
      } catch {
        latestParsed = null;
        latestFilePath = null;
      }
    }
  }
  const latestReceiptFinanceReplay =
    latestParsed && latestFilePath
      ? summarizeFinanceOrchestrationReplay({
          workspaceDir,
          filePath: latestFilePath,
          parsed: latestParsed,
        })
      : null;
  return {
    agentId: workspace.agentId,
    workspaceDir,
    count: files.length,
    latestPath,
    latestGeneratedAt,
    financeOrchestrationCount,
    latestFinanceOrchestration,
    latestReceiptFinanceReplay,
  };
}

export async function readReceiptStats(
  opts: LarkLoopDiagnoseCommandOptions,
): Promise<AggregateReceiptStats> {
  const workspaces = await Promise.all(resolveReceiptWorkspaces(opts).map(readSingleReceiptStats));
  let latestPath: string | null = null;
  let latestGeneratedAt: string | null = null;
  let latestWorkspaceDir: string | null = null;
  let financeOrchestrationCount = 0;
  let latestFinanceOrchestration: FinanceOrchestrationReceiptSummary | null = null;
  let latestReceiptFinanceReplay: FinanceOrchestrationReceiptSummary | null = null;
  let count = 0;
  for (const workspace of workspaces) {
    count += workspace.count;
    financeOrchestrationCount += workspace.financeOrchestrationCount;
    if ((workspace.latestGeneratedAt ?? "") >= (latestGeneratedAt ?? "") && workspace.latestPath) {
      latestGeneratedAt = workspace.latestGeneratedAt;
      latestPath = workspace.latestPath;
      latestWorkspaceDir = workspace.workspaceDir;
      latestReceiptFinanceReplay = workspace.latestReceiptFinanceReplay;
    }
    if (
      (workspace.latestFinanceOrchestration?.generatedAt ?? "") >=
        (latestFinanceOrchestration?.generatedAt ?? "") &&
      workspace.latestFinanceOrchestration
    ) {
      latestFinanceOrchestration = workspace.latestFinanceOrchestration;
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
    financeOrchestrationCount,
    latestFinanceOrchestration,
    latestReceiptFinanceReplay,
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
  lines.push(`financeOrchestrationReceipts: ${receipts.financeOrchestrationCount}`);
  if (receipts.latestFinanceOrchestration) {
    lines.push(`latestFinanceOrchestration: ${receipts.latestFinanceOrchestration.receiptPath}`);
    lines.push(
      `latestFinanceModules: ${receipts.latestFinanceOrchestration.primaryModules.join(", ")}`,
    );
    lines.push(
      `latestFinanceTools: ${receipts.latestFinanceOrchestration.requiredTools.join(", ")}`,
    );
  }
  if (receipts.latestReceiptFinanceReplay) {
    lines.push(`latestReceiptFinanceReplay: ${receipts.latestReceiptFinanceReplay.receiptPath}`);
    lines.push(
      `latestReceiptReplayModules: ${receipts.latestReceiptFinanceReplay.primaryModules.join(", ")}`,
    );
    lines.push(
      `latestReceiptReplayTools: ${receipts.latestReceiptFinanceReplay.requiredTools.join(", ")}`,
    );
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
      orchestration: localLoop.orchestration,
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
