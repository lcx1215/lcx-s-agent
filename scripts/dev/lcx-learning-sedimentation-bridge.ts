import fs from "node:fs/promises";
import path from "node:path";
import { createModuleLearningPipelinePlanTool } from "../../src/agents/tools/module-learning-pipeline-plan-tool.ts";
import { DEFAULT_WORKSPACE_DIR } from "./lcx-local-paths.ts";

type CliOptions = {
  workspaceDir: string;
  maxCandidates: number;
  writePlanReceipts: boolean;
  json: boolean;
};

type FileEntry = {
  path: string;
  mtimeMs: number;
};

type AppliedCapability = {
  capabilityName?: string;
  sourceArticlePath?: string;
  matchedSignals?: unknown;
  applicationBoundary?: string;
  attachmentPoint?: string;
};

type ApplyReceipt = {
  boundary?: string;
  queryText?: string;
  ok?: boolean;
  appliedCapabilities?: unknown;
};

type RetrievalReceipt = {
  boundary?: string;
  normalizedArticleArtifactPaths?: unknown;
  preflightCapabilityRetrieval?: unknown;
};

const DEFAULT_MAX_CANDIDATES = 8;
const MODULE_LEARNING_SOURCE_REGISTRY =
  "memory/local-memory/finance-learning-capability-candidates.md";

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/dev/lcx-learning-sedimentation-bridge.ts [--workspace DIR] [--max-candidates N] [--write-plan-receipts] [--json]",
      "",
      "Builds module-learning plan candidates from existing finance learning retrieval/apply receipts.",
      "Default is dry-run: it does not write plan receipts, touch live, change providers, or write protected memory.",
    ].join("\n"),
  );
}

function readValue(args: string[], index: number): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    usage();
  }
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    workspaceDir: DEFAULT_WORKSPACE_DIR,
    maxCandidates: DEFAULT_MAX_CANDIDATES,
    writePlanReceipts: false,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workspace" || arg === "--worktree") {
      options.workspaceDir = path.resolve(readValue(args, index));
      index += 1;
    } else if (arg === "--max-candidates") {
      const parsed = Number.parseInt(readValue(args, index), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        usage();
      }
      options.maxCandidates = parsed;
      index += 1;
    } else if (arg === "--write-plan-receipts") {
      options.writePlanReceipts = true;
    } else if (arg === "--dry-run" || arg === "--no-write") {
      options.writePlanReceipts = false;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage();
    }
  }
  options.workspaceDir = path.resolve(options.workspaceDir);
  return options;
}

async function listJsonFiles(root: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  async function visit(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const filePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(filePath);
          return;
        }
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          return;
        }
        const stat = await fs.stat(filePath).catch(() => undefined);
        if (stat) {
          files.push({ path: filePath, mtimeMs: stat.mtimeMs });
        }
      }),
    );
  }
  await visit(root);
  return files.toSorted((left, right) => right.mtimeMs - left.mtimeMs);
}

async function readJsonObject<T extends Record<string, unknown>>(
  filePath: string,
): Promise<T | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function relativeToWorkspace(workspaceDir: string, filePath: string): string {
  return path.relative(workspaceDir, filePath).split(path.sep).join("/");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function appliedCapabilities(value: unknown): AppliedCapability[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is AppliedCapability => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return false;
        }
        const record = entry as AppliedCapability;
        return typeof record.sourceArticlePath === "string" && record.sourceArticlePath.length > 0;
      })
    : [];
}

function normalizedSignals(capability: AppliedCapability): string[] {
  return [
    ...stringArray(capability.matchedSignals),
    capability.attachmentPoint ?? "",
    capability.capabilityName ?? "",
    capability.sourceArticlePath ?? "",
  ]
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/u)
    .filter(Boolean);
}

function hasSignal(signals: string[], patterns: RegExp[]): boolean {
  const text = signals.join(" ");
  return patterns.some((pattern) => pattern.test(text));
}

function inferTargetModule(capability: AppliedCapability, queryText: string): string {
  const signals = normalizedSignals(capability);
  const fallbackText = queryText.toLowerCase();
  if (hasSignal(signals, [/options_volatility/u, /volatility_research/u, /\biv\b/u, /gamma/u])) {
    return "options_volatility";
  }
  if (hasSignal(signals, [/technical_timing/u, /tactical_timing/u, /timing_validation/u])) {
    return "technical_timing";
  }
  if (hasSignal(signals, [/event_driven/u, /event_catalyst/u, /catalyst/u, /event-triage/u])) {
    return "event_driven";
  }
  if (
    hasSignal(signals, [/portfolio_risk_gates/u, /risk_gate_design/u, /portfolio_risk_evidence/u])
  ) {
    return "portfolio_risk_gates";
  }
  if (hasSignal(signals, [/factor_research/u, /\bfactor\b/u, /backtest/u, /walk-forward/u])) {
    return "factor_research";
  }
  if (hasSignal(signals, [/macro_rates/u, /inflation/u, /rate/u, /liquidity/u])) {
    return "macro_rates_inflation";
  }
  if (hasSignal(signals, [/etf_regime/u, /index/u, /equity_market_evidence/u])) {
    return "global_index_regime";
  }
  if (/portfolio|risk|sizing|drawdown/u.test(fallbackText)) {
    return "portfolio_risk_gates";
  }
  return "research_artifact_qc";
}

function retrievalSources(receipt: RetrievalReceipt): string[] {
  const direct = stringArray(receipt.normalizedArticleArtifactPaths);
  const preflight = recordValue(receipt.preflightCapabilityRetrieval);
  const candidates = Array.isArray(preflight?.candidates) ? preflight.candidates : [];
  const candidateSources = candidates
    .map((candidate) => recordValue(candidate)?.sourceArticlePath)
    .filter((source): source is string => typeof source === "string" && source.length > 0);
  return [...new Set([...direct, ...candidateSources])];
}

async function buildRetrievalIndex(workspaceDir: string): Promise<Map<string, string>> {
  const memoryDir = path.join(workspaceDir, "memory");
  const retrievalFiles = await listJsonFiles(
    path.join(memoryDir, "finance-learning-retrieval-receipts"),
  );
  const index = new Map<string, string>();
  for (const file of retrievalFiles) {
    const receipt = await readJsonObject<RetrievalReceipt>(file.path);
    if (receipt?.boundary !== "finance_learning_retrieval_receipt") {
      continue;
    }
    for (const source of retrievalSources(receipt)) {
      if (!index.has(source)) {
        index.set(source, relativeToWorkspace(workspaceDir, file.path));
      }
    }
  }
  return index;
}

async function buildBridge(options: CliOptions) {
  const memoryDir = path.join(options.workspaceDir, "memory");
  const [applyFiles, retrievalIndex] = await Promise.all([
    listJsonFiles(path.join(memoryDir, "finance-learning-apply-usage-receipts")),
    buildRetrievalIndex(options.workspaceDir),
  ]);
  const planTool = createModuleLearningPipelinePlanTool({ workspaceDir: options.workspaceDir });
  const rawCandidates: Array<{
    targetModule: string;
    sourceUrlOrPath: string;
    retrievalReceiptPath?: string;
    applicationValidationReceiptPath: string;
    queryText: string;
    capabilityName: string;
    matchedSignals: string[];
    generatedAtRank: number;
  }> = [];

  for (const file of applyFiles) {
    const receipt = await readJsonObject<ApplyReceipt>(file.path);
    if (
      receipt?.boundary !== "finance_learning_capability_apply_usage_receipt" ||
      receipt.ok !== true
    ) {
      continue;
    }
    const queryText =
      typeof receipt.queryText === "string"
        ? receipt.queryText
        : "existing finance learning apply receipt";
    for (const capability of appliedCapabilities(receipt.appliedCapabilities)) {
      const sourceUrlOrPath = capability.sourceArticlePath;
      if (!sourceUrlOrPath) {
        continue;
      }
      rawCandidates.push({
        targetModule: inferTargetModule(capability, queryText),
        sourceUrlOrPath,
        retrievalReceiptPath: retrievalIndex.get(sourceUrlOrPath),
        applicationValidationReceiptPath: relativeToWorkspace(options.workspaceDir, file.path),
        queryText,
        capabilityName: capability.capabilityName ?? path.basename(sourceUrlOrPath),
        matchedSignals: stringArray(capability.matchedSignals),
        generatedAtRank: file.mtimeMs,
      });
    }
  }

  const seen = new Set<string>();
  const uniqueCandidates = rawCandidates
    .toSorted((left, right) => right.generatedAtRank - left.generatedAtRank)
    .filter((candidate) => {
      const key = `${candidate.targetModule}\n${candidate.sourceUrlOrPath}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, options.maxCandidates);

  const candidates = [];
  for (const [index, candidate] of uniqueCandidates.entries()) {
    const planResult = await planTool.execute(`learning-sedimentation-bridge-${index}`, {
      targetModule: candidate.targetModule,
      sourceUrlOrPath: candidate.sourceUrlOrPath,
      learningIntent: `Convert existing finance-learning sedimentation into a module-learning review candidate for ${candidate.targetModule}; do not claim eval_absorbed until Qwen eval/training evidence and keep/downrank/discard decision exist.`,
      actualReadingScope:
        "Existing local finance-learning source artifact, retrieval receipt, and apply-usage receipt only; no remote fetch in this bridge.",
      applicationValidationTask: candidate.queryText,
      existingArtifactPaths: [
        candidate.sourceUrlOrPath,
        candidate.retrievalReceiptPath,
        candidate.applicationValidationReceiptPath,
      ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
      sourceRegistryRecordPath: MODULE_LEARNING_SOURCE_REGISTRY,
      retrievalReceiptPath: candidate.retrievalReceiptPath,
      applicationValidationReceiptPath: candidate.applicationValidationReceiptPath,
      keepDownrankDiscardDecision: "not_decided",
      writeReceipt: options.writePlanReceipts,
    });
    const details = planResult.details as Record<string, unknown>;
    candidates.push({
      targetModule: candidate.targetModule,
      capabilityName: candidate.capabilityName,
      sourceUrlOrPath: candidate.sourceUrlOrPath,
      retrievalReceiptPath: candidate.retrievalReceiptPath ?? null,
      applicationValidationReceiptPath: candidate.applicationValidationReceiptPath,
      matchedSignals: candidate.matchedSignals,
      status: details.status,
      missingEvidence: details.missingEvidence,
      receiptPath: details.receiptPath,
      receiptWritten: details.receiptWritten,
      claimBoundary: details.claimBoundary,
    });
  }

  return {
    ok: true,
    boundary: "dev_learning_sedimentation_bridge_only",
    workspaceDir: options.workspaceDir,
    writePlanReceipts: options.writePlanReceipts,
    candidateCount: candidates.length,
    sourceApplyReceiptFiles: applyFiles.length,
    candidates,
    nextAction:
      candidates.length > 0
        ? "write_plan_receipts_then_run_module_learning_review_when_operator_wants_certification"
        : "create_or_apply_learning_receipts_before_module_bridge",
    notPromoted: true,
    notTouched: [
      "live_sender",
      "provider_config",
      "protected_repo_memory",
      "formal_lark_routing_corpus",
      "finance_doctrine",
    ],
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
}

function renderText(result: Awaited<ReturnType<typeof buildBridge>>): string {
  return (
    [
      `Learning sedimentation bridge | candidates=${result.candidateCount}`,
      `boundary=${result.boundary}`,
      `write_plan_receipts=${result.writePlanReceipts}`,
      `next_action=${result.nextAction}`,
      `not_promoted=${result.notPromoted}`,
    ].join("\n") + "\n"
  );
}

const options = parseArgs(process.argv.slice(2));
const result = await buildBridge(options);
if (options.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(renderText(result));
}
