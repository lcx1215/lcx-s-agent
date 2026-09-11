import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  createApiSourceGovernanceRegistry,
  type ApiCallReceipt,
} from "../../src/agents/api-call-contract.ts";
import type { FinanceDecisionMode } from "../../src/agents/finance-decision-policy.ts";
import { resolveFinanceMarketCollectionRegistryOptionsFromEnv } from "../../src/agents/finance-market-collection-registry.ts";
import { resolveFinanceRealtimeSourceRegistryOptionsFromEnv } from "../../src/agents/finance-realtime-source-registry.ts";
import {
  runFinanceResearchRun,
  type FinanceResearchRunInput,
  type FinanceResearchRunReceipt,
} from "../../src/agents/finance-research-runner.ts";
import {
  createLocalQualityHarnessAdapter,
  resolveLocalTextModelRuntimeConfig,
  type LocalTextModelRuntimeConfig,
} from "../../src/agents/local-text-model-adapter.ts";
import type { LogicalAgentModelRouting } from "../../src/agents/logical-agent-model-router.ts";
import { DEFAULT_WORKSPACE_DIR } from "./lcx-local-paths.ts";
import { parseJsonObjectFromOutput } from "./smoke-json-output.ts";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const WORKSPACE_DIR = () => process.env.OPENCLAW_WORKSPACE_DIR?.trim() || DEFAULT_WORKSPACE_DIR;

const DEFAULT_ASK =
  "分析过去六个月加密货币和美股的市场情绪、最近美股上涨的驱动，以及美国中期选举后可能发生什么。";
const DEFAULT_MODEL_ID = "Qwen/Qwen3-0.6B";
const MAX_HORIZON_MONTHS = 120;
const MAX_MODEL_TOKENS = 16_384;
const MAX_MODEL_TIMEOUT_MS = 2_147_483_647;

type Options = {
  ask: string;
  asOf?: string;
  horizonMonths: number;
  decisionMode: FinanceDecisionMode;
  live: boolean;
  quality: boolean;
  write: boolean;
  adapterPath?: string;
  modelId: string;
  pythonPath?: string;
  maxTokens: number;
  timeoutMs: number;
  allowModelNetwork: boolean;
  maxApiCalls: number;
  maxConcurrency: number;
  maxSourcesPerJob: number;
  sourceTimeoutMs: number;
  totalTimeoutMs: number;
  retryAttempts: number;
  includeYahooPublicSources: boolean;
  json: boolean;
};

function usage(): never {
  throw new Error(
    [
      "Usage: node --import tsx scripts/operator/lcx-finance-research-run.ts [options]",
      "",
      "Runs the bounded finance research waterflow: source batch -> committee -> quality -> quarterly output.",
      "Dry plan is the default and never fetches sources or resolves a model adapter.",
      "",
      "Options:",
      "  --ask TEXT                         natural-language research question",
      "  --as-of ISO                        observation cutoff (default: now)",
      `  --horizon-months N                 horizon for the research plan (default: 6, max: ${MAX_HORIZON_MONTHS})`,
      "  --decision-mode MODE               research_only|strategy_candidate|conditional_trade_candidate",
      "  --live                              fetch bounded public/provider sources and run the model DAG",
      "  --skip-quality                     do not run the quality harness (live only)",
      "  --adapter DIR                      explicit local adapter directory",
      "  --model MODEL                      local model id (default: Qwen/Qwen3-0.6B)",
      "  --python PATH                      local model Python runtime",
      `  --max-tokens N                     bounded local model output tokens (max: ${MAX_MODEL_TOKENS})`,
      `  --timeout-ms N                     bounded local model timeout (max: ${MAX_MODEL_TIMEOUT_MS})`,
      "  --allow-model-network              allow the local model runtime to use network",
      "  --max-api-calls N                  hard source-attempt budget (default: 48, max: 10000)",
      "  --max-concurrency N                batch concurrency (default: 3)",
      "  --max-sources-per-job N            source adapters per job (default: 2)",
      `  --source-timeout-ms N              per-source timeout (default: 30000, max: ${MAX_MODEL_TIMEOUT_MS})`,
      `  --total-timeout-ms N               whole batch timeout (default: 180000, max: ${MAX_MODEL_TIMEOUT_MS})`,
      "  --retry-attempts N                 attempts per adapter (default: 1)",
      "  --include-yahoo-public-sources     explicitly opt in to Yahoo public adapters",
      "  --write                            write the full receipt to workspace state",
      "  --json                             emit a bounded JSON summary",
    ].join("\n"),
  );
}

function readValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function positiveInteger(value: string, flag: string, max?: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || (max !== undefined && parsed > max)) {
    throw new Error(`${flag} must be a positive integer${max === undefined ? "" : ` <= ${max}`}`);
  }
  return parsed;
}

function decisionMode(value: string): FinanceDecisionMode {
  if (
    value === "research_only" ||
    value === "strategy_candidate" ||
    value === "conditional_trade_candidate"
  ) {
    return value;
  }
  throw new Error(
    "--decision-mode must be research_only, strategy_candidate, or conditional_trade_candidate",
  );
}

function parseArgs(args: readonly string[]): Options {
  const options: Options = {
    ask: DEFAULT_ASK,
    horizonMonths: 6,
    decisionMode: "research_only",
    live: false,
    quality: true,
    write: false,
    modelId: DEFAULT_MODEL_ID,
    maxTokens: 384,
    timeoutMs: 120_000,
    allowModelNetwork: false,
    maxApiCalls: 48,
    maxConcurrency: 3,
    maxSourcesPerJob: 2,
    sourceTimeoutMs: 30_000,
    totalTimeoutMs: 180_000,
    retryAttempts: 1,
    includeYahooPublicSources: false,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--ask") {
      options.ask = readValue(args, index, arg);
      index += 1;
    } else if (arg === "--as-of") {
      options.asOf = readValue(args, index, arg);
      index += 1;
    } else if (arg === "--horizon-months") {
      options.horizonMonths = positiveInteger(readValue(args, index, arg), arg, MAX_HORIZON_MONTHS);
      index += 1;
    } else if (arg === "--decision-mode") {
      options.decisionMode = decisionMode(readValue(args, index, arg));
      index += 1;
    } else if (arg === "--live") {
      options.live = true;
    } else if (arg === "--skip-quality") {
      options.quality = false;
    } else if (arg === "--adapter") {
      options.adapterPath = readValue(args, index, arg);
      index += 1;
    } else if (arg === "--model") {
      options.modelId = readValue(args, index, arg);
      index += 1;
    } else if (arg === "--python") {
      options.pythonPath = readValue(args, index, arg);
      index += 1;
    } else if (arg === "--max-tokens") {
      options.maxTokens = positiveInteger(readValue(args, index, arg), arg, MAX_MODEL_TOKENS);
      index += 1;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = positiveInteger(readValue(args, index, arg), arg, MAX_MODEL_TIMEOUT_MS);
      index += 1;
    } else if (arg === "--allow-model-network") {
      options.allowModelNetwork = true;
    } else if (arg === "--max-api-calls") {
      options.maxApiCalls = positiveInteger(readValue(args, index, arg), arg, 10_000);
      index += 1;
    } else if (arg === "--max-concurrency") {
      options.maxConcurrency = positiveInteger(readValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--max-sources-per-job") {
      options.maxSourcesPerJob = positiveInteger(readValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--source-timeout-ms") {
      options.sourceTimeoutMs = positiveInteger(
        readValue(args, index, arg),
        arg,
        MAX_MODEL_TIMEOUT_MS,
      );
      index += 1;
    } else if (arg === "--total-timeout-ms") {
      options.totalTimeoutMs = positiveInteger(
        readValue(args, index, arg),
        arg,
        MAX_MODEL_TIMEOUT_MS,
      );
      index += 1;
    } else if (arg === "--retry-attempts") {
      options.retryAttempts = positiveInteger(readValue(args, index, arg), arg, 3);
      index += 1;
    } else if (arg === "--include-yahoo-public-sources") {
      options.includeYahooPublicSources = true;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/u;

export function assertIsoTimestamp(value: string): string {
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  const year = match ? Number(match[1]) : Number.NaN;
  const month = match ? Number(match[2]) : Number.NaN;
  const day = match ? Number(match[3]) : Number.NaN;
  const daysInMonth =
    month === 2
      ? 28 + Number(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;
  if (
    !match ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error("--as-of must be an ISO timestamp");
  }
  return new Date(value).toISOString();
}

async function resolveAdapterPath(options: Options): Promise<string> {
  if (options.adapterPath?.trim()) {
    return path.resolve(options.adapterPath);
  }
  const result = await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(REPO_ROOT, "scripts/operator/minimax-brain-training-guard.ts"),
      "--resolve-current-adapter",
      "--no-train",
      "--model",
      options.modelId,
      "--current-adapter",
      "latest-passing",
    ],
    { cwd: REPO_ROOT, maxBuffer: 2 * 1024 * 1024, timeout: 30_000 },
  );
  const payload = parseJsonObjectFromOutput(result.stdout);
  if (typeof payload.selectedAdapter !== "string" || !payload.selectedAdapter.trim()) {
    throw new Error("training guard did not return a selected adapter");
  }
  return path.resolve(payload.selectedAdapter);
}

function routingRevision(prefix: string, runtime: LocalTextModelRuntimeConfig): string {
  return `${prefix}-${createHash("sha256")
    .update(`${runtime.adapterPath}:${runtime.modelId}`)
    .digest("hex")
    .slice(0, 12)}`;
}

export function buildFinanceResearchCommitteeRouting(
  runtime: LocalTextModelRuntimeConfig,
): LogicalAgentModelRouting {
  const adapter = createLocalQualityHarnessAdapter(runtime);
  return {
    revision: routingRevision("finance-local-committee-v1", runtime),
    adapters: [adapter],
    defaultPolicy: {
      primary: adapter.id,
      requiredCapabilities: ["quality_harness"],
      maxInputBytes: 256_000,
      timeoutMs: runtime.timeoutMs,
    },
  };
}

function buildQualityRouting(runtime: LocalTextModelRuntimeConfig): LogicalAgentModelRouting {
  const adapter = createLocalQualityHarnessAdapter(runtime);
  return {
    revision: routingRevision("finance-local-quality-v1", runtime),
    adapters: [adapter],
    defaultPolicy: {
      primary: adapter.id,
      requiredCapabilities: ["quality_harness"],
      maxInputBytes: 256_000,
      timeoutMs: runtime.timeoutMs,
    },
  };
}

function compactApiCall(call: ApiCallReceipt) {
  return {
    provider: call.provider,
    source: call.source,
    operation: call.operation,
    status: call.status,
    httpStatus: call.httpStatus,
    transportError: call.transportError,
    attempt: call.attempt,
    latencyMs: call.latencyMs,
    circuitState: call.circuitState,
    authScopeLabel: call.authScopeLabel,
    idempotencyKeyPresent: call.idempotencyKey !== undefined,
  };
}

function summarizeReceipt(receipt: FinanceResearchRunReceipt, options: Options) {
  const batch = receipt.batch;
  return {
    schemaVersion: "lcx_finance_research_operator_v1",
    boundary: "local_finance_research_run_only",
    request: {
      ask: receipt.plan.ask,
      asOf: receipt.plan.asOf,
      horizonMonths: receipt.plan.horizonMonths,
      decisionMode: receipt.plan.decisionMode,
      liveFetch: options.live,
      qualityRequested: options.quality,
    },
    status: receipt.status,
    answerDecision: receipt.answerDecision,
    plan: {
      expectedJobCount: receipt.plan.expectedJobCount,
      targetIds: receipt.plan.targets.map((target) => target.id),
      orchestration: receipt.plan.orchestration,
      sourceInspectionCount: receipt.plan.sourceInspections.length,
      sourceInspections: receipt.plan.sourceInspections,
      boundaries: receipt.plan.boundaries,
    },
    batch: batch
      ? {
          schemaVersion: batch.schemaVersion,
          status: batch.status,
          correlationId: batch.correlationId,
          budget: batch.budget,
          jobs: batch.jobs.map((job) => ({
            jobId: job.jobId,
            targetId: job.targetId,
            kind: job.kind,
            request: job.request,
            status: job.status,
            missingEvidence: job.missingEvidence,
            freshnessWarnings: job.freshnessWarnings,
            conflicts: job.conflicts,
            error: job.error,
            sourceAttempts: job.receipt?.sourceAttempts?.map((attempt) => ({
              adapterId: attempt.adapterId,
              providerName: attempt.providerName,
              status: attempt.status,
              recordCount: attempt.recordCount,
              latencyMs: attempt.latencyMs,
              error: attempt.error,
              apiCalls: attempt.apiCalls?.map(compactApiCall),
            })),
            apiCalls: job.apiCalls.map(compactApiCall),
          })),
          committeeEvidenceCount: batch.committeeEvidence.length,
        }
      : undefined,
    committee: receipt.committee
      ? {
          coverage: receipt.committee.coverage,
          model: {
            ...receipt.committee.model,
            roleStatuses: receipt.committee.model.roleStatuses.map((role) => ({
              taskId: role.taskId,
              agentId: role.agentId,
              status: role.status,
              error: role.error,
            })),
          },
        }
      : undefined,
    quality: receipt.quality
      ? {
          status: receipt.quality.status,
          quality: receipt.quality.quality,
          verification: receipt.quality.verification,
          execution: {
            backend: receipt.quality.execution.backend,
            evidenceMode: receipt.quality.execution.evidenceMode,
            modelId: receipt.quality.execution.modelId,
            modelCallCount: receipt.quality.execution.modelCalls.length,
            realModelInferenceObserved: receipt.quality.execution.realModelInferenceObserved,
            allModelCallsAttested: receipt.quality.execution.allModelCallsAttested,
            providerCallsMade: receipt.quality.execution.providerCallsMade,
          },
          attempts: receipt.quality.attempts.map((attempt) => ({
            attempt: attempt.attempt,
            status: attempt.status,
            planStatus: attempt.planStatus,
            gates: attempt.gates,
            verification: attempt.verification,
            stages: attempt.stages.map((stage) => ({
              taskId: stage.taskId,
              agentId: stage.agentId,
              status: stage.status,
              outputKind: stage.outputKind,
              error: stage.error,
              modelCalls: stage.modelCalls?.map((call) => ({
                outcome: call.outcome,
                reason: call.reason,
                evidence: call.evidence,
                realModelInferenceObserved: call.realModelInferenceObserved,
              })),
            })),
          })),
          repair: receipt.quality.repair,
          finalArtifact: receipt.quality.finalArtifact,
        }
      : undefined,
    quarterlyOutput: receipt.quarterlyOutput,
    gates: receipt.gates,
    missingEvidence: receipt.missingEvidence,
    notTouched: receipt.notTouched,
  };
}

async function writePrivateReceipt(filePath: string, serialized: string): Promise<void> {
  await fs.writeFile(filePath, serialized, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

async function writeReceipt(receipt: FinanceResearchRunReceipt, asOf: string) {
  const root = WORKSPACE_DIR();
  const stateDir = path.join(root, "state");
  const runDir = path.join(root, "memory", "finance-research-runs", asOf.slice(0, 10));
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const datedPath = path.join(runDir, `${stamp}__finance-research-run.json`);
  const latestPath = path.join(stateDir, "lcx-finance-research-run-latest.json");
  await fs.mkdir(runDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  await writePrivateReceipt(datedPath, serialized);
  await writePrivateReceipt(latestPath, serialized);
  return { datedPath, latestPath };
}

export function buildFinanceResearchRegistryOptions(
  includeYahooPublicSources: boolean,
  env: NodeJS.ProcessEnv = process.env,
) {
  const realtimeRegistryOptions = resolveFinanceRealtimeSourceRegistryOptionsFromEnv(env);
  const collectionRegistryOptions = resolveFinanceMarketCollectionRegistryOptionsFromEnv(env);
  return {
    realtimeRegistryOptions: {
      ...realtimeRegistryOptions,
      ...(includeYahooPublicSources ? { includeYahooPublicSource: true } : {}),
    },
    collectionRegistryOptions: {
      ...collectionRegistryOptions,
      ...(includeYahooPublicSources ? { includeYahooPublicSources: true } : {}),
    },
  } as const;
}

async function run(
  options: Options,
): Promise<{ receipt: FinanceResearchRunReceipt; written?: unknown }> {
  const asOf = assertIsoTimestamp(options.asOf ?? new Date().toISOString());
  const asOfMode = options.live && options.asOf === undefined ? ("live_now" as const) : undefined;
  if (options.live && !options.write) {
    throw new Error("--write is required with --live to persist the full research receipt");
  }
  const input: FinanceResearchRunInput = {
    ask: options.ask,
    asOf,
    horizonMonths: options.horizonMonths,
    decisionMode: options.decisionMode,
    ...(asOfMode === undefined ? {} : { asOfMode }),
  };
  const { realtimeRegistryOptions, collectionRegistryOptions } =
    buildFinanceResearchRegistryOptions(options.includeYahooPublicSources);
  const batchOptions = {
    maxApiCalls: options.maxApiCalls,
    maxConcurrency: options.maxConcurrency,
    maxSourcesPerJob: options.maxSourcesPerJob,
    sourceTimeoutMs: options.sourceTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs,
    retry: { attempts: options.retryAttempts },
    realtimeRegistryOptions,
    collectionRegistryOptions,
  } as const;
  if (!options.live) {
    const receipt = await runFinanceResearchRun({
      input,
      liveFetch: false,
      batchOptions,
    });
    const written = options.write ? await writeReceipt(receipt, asOf) : undefined;
    return { receipt, ...(written === undefined ? {} : { written }) };
  }
  const adapterPath = await resolveAdapterPath(options);
  await Promise.all([
    fs.access(path.join(adapterPath, "adapter_config.json")),
    fs.access(path.join(adapterPath, "adapters.safetensors")),
  ]);
  const runtime = resolveLocalTextModelRuntimeConfig({
    adapterPath,
    modelId: options.modelId,
    ...(options.pythonPath === undefined ? {} : { pythonPath: options.pythonPath }),
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
    allowNetwork: options.allowModelNetwork,
  });
  const governance = createApiSourceGovernanceRegistry({
    minIntervalMs: 250,
    maxConcurrent: 1,
    maxQueue: 64,
    failureThreshold: 3,
    resetAfterMs: 30_000,
  });
  const receipt = await runFinanceResearchRun({
    input,
    liveFetch: true,
    qualityEnabled: options.quality,
    modelId: runtime.modelId,
    modelRouting: buildFinanceResearchCommitteeRouting(runtime),
    ...(options.quality ? { qualityModelRouting: buildQualityRouting(runtime) } : {}),
    sourceGovernance: governance,
    batchOptions,
  });
  const written = options.write ? await writeReceipt(receipt, asOf) : undefined;
  return { receipt, ...(written === undefined ? {} : { written }) };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const result = await run(options);
  const summary = {
    ...summarizeReceipt(result.receipt, options),
    ...(result.written === undefined ? {} : { written: result.written }),
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `finance_research_run=${summary.status}`,
        `answer_decision=${summary.answerDecision}`,
        `expected_jobs=${summary.plan.expectedJobCount}`,
        `gates=${summary.gates.map((gate) => `${gate.id}:${gate.passed ? "pass" : "fail"}`).join(",")}`,
        `not_touched=${summary.notTouched.join(",")}`,
      ].join("\n") + "\n",
    );
  }
  return summary.status === "candidate" || summary.status === "planned" ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(
      `lcx finance research run failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
