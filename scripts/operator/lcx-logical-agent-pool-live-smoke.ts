import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ApiCallReceipt } from "../../src/agents/api-call-contract.ts";
import {
  createGeospatialSourceRegistry,
  runGeospatialRefresh,
  type GeospatialRefreshReceipt,
} from "../../src/agents/geospatial-source-registry.ts";
import {
  createLocalRoleShadowAdapter,
  resolveLocalTextModelRuntimeConfig,
  type LocalRoleShadowRequest,
  type LocalTextModelRuntimeConfig,
} from "../../src/agents/local-text-model-adapter.ts";
import {
  LogicalAgentModelRouter,
  type LogicalAgentModelRouting,
} from "../../src/agents/logical-agent-model-router.ts";
import {
  buildDefaultLogicalAgentPlan,
  LOGICAL_AGENT_LOCAL_CAPABILITIES,
  LOGICAL_AGENT_DEFINITIONS,
  LogicalAgentPool,
  runLogicalAgentPlan,
  type LogicalAgentRequest,
  type ModelCallReceipt,
} from "../../src/agents/logical-agent-pool.ts";
import { parseJsonObjectFromOutput } from "./smoke-json-output.ts";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

type Options = {
  ask: string;
  adapterPath?: string;
  modelId: string;
  pythonPath?: string;
  maxTokens: number;
  timeoutMs: number;
  allowNetwork: boolean;
  withGeospatial: boolean;
  geospatialQuery: string;
  skipFull: boolean;
  json: boolean;
};

function readValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(args: readonly string[]): Options {
  const options: Options = {
    ask: "对已提供材料做一次研究风险审阅，只保留有证据的结论。",
    modelId: "Qwen/Qwen3-0.6B",
    maxTokens: 384,
    timeoutMs: 120_000,
    allowNetwork: false,
    withGeospatial: false,
    geospatialQuery: "40.7128,-74.0060",
    skipFull: false,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--ask") {
      options.ask = readValue(args, index, arg);
      index += 1;
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
      options.maxTokens = parsePositiveInteger(readValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(readValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--allow-model-network") {
      options.allowNetwork = true;
    } else if (arg === "--with-geospatial") {
      options.withGeospatial = true;
    } else if (arg === "--geospatial-query") {
      options.geospatialQuery = readValue(args, index, arg);
      index += 1;
    } else if (arg === "--skip-full") {
      options.skipFull = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(
        "Usage: node --import tsx scripts/operator/lcx-logical-agent-pool-live-smoke.ts [--json] [--skip-full] [--with-geospatial] [--geospatial-query LAT,LON] [--allow-model-network] [--ask TEXT] [--adapter DIR] [--model MODEL] [--python PATH] [--max-tokens N] [--timeout-ms N]",
      );
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
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
      "latest",
    ],
    { cwd: REPO_ROOT, maxBuffer: 2 * 1024 * 1024, timeout: 30_000 },
  );
  const payload = parseJsonObjectFromOutput(result.stdout);
  if (typeof payload.selectedAdapter !== "string" || !payload.selectedAdapter.trim()) {
    throw new Error("training guard did not return a selected adapter");
  }
  return path.resolve(payload.selectedAdapter);
}

function buildRouting(
  adapter: ReturnType<typeof createLocalRoleShadowAdapter>,
  runtime: LocalTextModelRuntimeConfig,
): LogicalAgentModelRouting {
  return {
    revision: `live-local-qwen-v1-${createHash("sha256")
      .update(runtime.adapterPath)
      .digest("hex")
      .slice(0, 12)}`,
    adapters: [adapter],
    defaultPolicy: {
      primary: adapter.id,
      requiredCapabilities: ["logical_agent_role_shadow"],
      maxInputBytes: 256_000,
      timeoutMs: runtime.timeoutMs,
    },
  };
}

type ShadowInput = Readonly<{
  ask: string;
  evidence: readonly string[];
}>;

function buildRequest(ask: string): ShadowInput {
  return buildRequestWithEvidence(ask, [
    "本次 smoke 只提供一条人工输入材料；没有注入当前行情、交易授权或外部事实。",
  ]);
}

function buildRequestWithEvidence(ask: string, evidence: readonly string[]): ShadowInput {
  return {
    ask,
    evidence,
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

function summarizeGeospatialEvidence(receipt: GeospatialRefreshReceipt) {
  const apiCalls = receipt.sourceAttempts.flatMap((attempt) => attempt.apiCalls ?? []);
  const evidence = [
    `geospatial_refresh_status=${receipt.status}`,
    ...receipt.sourceAttempts.map(
      (attempt) =>
        `source_attempt=${attempt.providerName}:${attempt.status}:latency_ms=${attempt.latencyMs}`,
    ),
    ...receipt.normalizedFields.map(
      (field) =>
        `field=${field.name};value=${String(field.value)};source_timestamp=${field.sourceTimestamp};definition=${field.fieldDefinition}`,
    ),
    ...receipt.freshnessWarnings.map((warning) => `freshness_warning=${warning}`),
    ...receipt.missingEvidence.map((missing) => `missing_evidence=${missing}`),
  ];
  return {
    status: receipt.status,
    transportSucceeded: apiCalls.some((call) => call.status === "succeeded"),
    fieldNames: receipt.normalizedFields.map((field) => field.name),
    sourceTimestamps: receipt.normalizedFields.map((field) => field.sourceTimestamp),
    freshnessWarnings: receipt.freshnessWarnings,
    receipts: apiCalls.map(compactApiCall),
    evidence,
  };
}

async function runGeospatialShadow(query: string, timeoutMs: number) {
  const correlationId = `lcx-model-api-shadow:${Date.now()}`;
  const receipt = await runGeospatialRefresh({
    request: {
      kind: "weather",
      query,
      asOf: new Date().toISOString(),
      freshnessMaxMinutes: 60,
    },
    adapters: createGeospatialSourceRegistry(),
    maxSources: 1,
    timeoutMs,
    correlationId,
    retry: { attempts: 1 },
    authScopeLabel: "public",
    idempotencyKey: `${correlationId}:open_meteo_current_weather`,
  });
  return {
    correlationId,
    ...summarizeGeospatialEvidence(receipt),
  };
}

function compactCall(call: ModelCallReceipt) {
  return {
    taskId: call.taskId,
    role: call.role,
    attempt: call.attempt,
    provider: call.provider,
    modelId: call.modelId,
    mode: call.mode,
    outcome: call.outcome,
    adapterInvoked: call.adapterInvoked,
    realModelInferenceObserved: call.realModelInferenceObserved,
    providerCallObserved: call.providerCallObserved,
    evidence: call.evidence,
    reason: call.reason,
  };
}

async function runSingleRole(
  routing: LogicalAgentModelRouting,
  request: ShadowInput,
): Promise<{
  outputKind: unknown;
  outputKeys: string[];
  calls: readonly ModelCallReceipt[];
}> {
  const router = new LogicalAgentModelRouter(routing);
  const calls: ModelCallReceipt[] = [];
  const modelRequest: LocalRoleShadowRequest = {
    schemaVersion: "lcx_local_role_shadow_v1",
    runId: "local-live-single-role",
    taskId: "data_cleaning",
    role: "data_cleaning",
    purpose: LOGICAL_AGENT_DEFINITIONS.find((agent) => agent.id === "data_cleaning")!.purpose,
    ask: request.ask,
    evidence: request.evidence,
    dependencyOutputs: {},
  };
  const result = await router.invoke({
    role: "data_cleaning",
    taskId: "data_cleaning",
    correlationId: "local-live-single-role",
    payload: modelRequest,
    capabilities: LOGICAL_AGENT_LOCAL_CAPABILITIES,
    signal: new AbortController().signal,
    dispatch: async (invoke) => invoke(),
    record: (receipt) => calls.push(receipt),
  });
  const record = result as Record<string, unknown>;
  if (
    typeof record.task_family !== "string" ||
    !Array.isArray(record.primary_modules) ||
    !Array.isArray(record.risk_boundaries)
  ) {
    throw new Error("single-role local model did not satisfy the role shadow contract");
  }
  return {
    outputKind: record.task_family,
    outputKeys: Object.keys(record).toSorted(),
    calls,
  };
}

async function runFullRoleShadow(
  routing: LogicalAgentModelRouting,
  runtime: LocalTextModelRuntimeConfig,
  request: ShadowInput,
) {
  const pool = new LogicalAgentPool<LogicalAgentRequest, Record<string, unknown>>({
    modelId: runtime.modelId,
    maxConcurrency: 1,
    taskTimeoutMs: Math.max(runtime.timeoutMs + 30_000, 180_000),
    modelRouting: routing,
  });
  const tasks = buildDefaultLogicalAgentPlan({
    ask: request.ask,
    evidence: request.evidence,
  });
  const result = await runLogicalAgentPlan<LogicalAgentRequest, Record<string, unknown>>({
    tasks,
    pool,
    finalTaskId: "final_precheck",
    runId: `local-live-shadow-${randomUUID()}`,
    sharedContext: {
      mode: "local_shadow",
      researchOnly: true,
      externalSideEffectsAllowed: false,
    },
    executor: async (context) => {
      const dependencyOutputs = Object.fromEntries(
        Object.entries(context.dependencyResults).map(([taskId, dependency]) => [
          taskId,
          {
            status: dependency.status,
            output: dependency.output,
          },
        ]),
      );
      const payload: LocalRoleShadowRequest = {
        schemaVersion: "lcx_local_role_shadow_v1",
        runId: context.task.id,
        taskId: context.task.id,
        role: context.agent.id,
        purpose: context.agent.purpose,
        ask: context.input.ask,
        evidence: context.input.evidence ?? [],
        dependencyOutputs,
      };
      const output = (await context.modelSlot.invoke(payload, context.signal)) as Record<
        string,
        unknown
      >;
      return { output, sideEffects: [] };
    },
  });
  const calls = result.tasks.flatMap((task) => task.modelCalls ?? []);
  return {
    status: result.status,
    finalTaskId: result.finalTaskId,
    pool: result.pool,
    allRolesCompleted:
      result.tasks.length === 10 && result.tasks.every((task) => task.status === "completed"),
    taskStatuses: result.tasks.map((task) => ({
      taskId: task.taskId,
      agentId: task.agentId,
      status: task.status,
      modelCalls: task.modelCalls?.length ?? 0,
      error: task.error,
    })),
    modelCalls: calls.map(compactCall),
    realModelInferenceObserved: calls.some((call) => call.realModelInferenceObserved),
    allModelCallsAttested:
      calls.length > 0 && calls.every((call) => call.evidence === "adapter-attested"),
  };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const adapterPath = await resolveAdapterPath(options);
  await fs.access(path.join(adapterPath, "adapter_config.json"));
  const runtime = resolveLocalTextModelRuntimeConfig({
    adapterPath,
    modelId: options.modelId,
    ...(options.pythonPath === undefined ? {} : { pythonPath: options.pythonPath }),
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
    allowNetwork: options.allowNetwork,
  });
  const adapter = createLocalRoleShadowAdapter(runtime);
  const routing = buildRouting(adapter, runtime);
  const apiShadow = options.withGeospatial
    ? await runGeospatialShadow(options.geospatialQuery, options.timeoutMs)
    : undefined;
  const request = options.withGeospatial
    ? buildRequestWithEvidence(options.ask, apiShadow?.evidence ?? [])
    : buildRequest(options.ask);
  if (options.withGeospatial && !apiShadow?.transportSucceeded) {
    throw new Error("geospatial transport did not produce a successful API receipt");
  }
  const single = await runSingleRole(routing, request);
  const singleCalls = single.calls.map(compactCall);
  const singlePassed =
    single.calls.length === 1 &&
    single.calls[0]?.outcome === "completed" &&
    single.calls[0]?.evidence === "adapter-attested" &&
    single.calls[0]?.realModelInferenceObserved;

  let full: Awaited<ReturnType<typeof runFullRoleShadow>> | undefined;
  if (singlePassed && !options.skipFull) {
    full = await runFullRoleShadow(routing, runtime, request);
  }

  const fullCalls = full?.modelCalls ?? [];
  const fullPassed =
    options.skipFull ||
    (full !== undefined &&
      full.allRolesCompleted &&
      fullCalls.length === 10 &&
      fullCalls.every(
        (call) => call.evidence === "adapter-attested" && call.realModelInferenceObserved,
      ));
  const payload = {
    schemaVersion: "lcx_live_local_model_smoke_v1",
    boundary: "local_logical_agent_pool_only",
    runtime: {
      provider: "mlx-local",
      modelId: runtime.modelId,
      adapterFingerprint: createHash("sha256")
        .update(runtime.adapterPath)
        .digest("hex")
        .slice(0, 16),
      maxTokens: runtime.maxTokens,
      timeoutMs: runtime.timeoutMs,
      allowNetwork: runtime.allowNetwork,
      maxConcurrency: 1,
    },
    singleRole: {
      passed: singlePassed,
      outputKind: single.outputKind,
      outputKeys: single.outputKeys,
      modelCalls: singleCalls,
    },
    fullShadow: options.skipFull
      ? { skipped: true, reason: "--skip-full" }
      : { passed: fullPassed, ...full },
    apiShadow: options.withGeospatial
      ? {
          ...apiShadow,
          evidenceInjectedIntoRoles: true,
          freshnessGatePassed: apiShadow?.status === "ready",
        }
      : { skipped: true, reason: "--with-geospatial not supplied" },
    claims: {
      singleRoleRealModelInferenceObserved: single.calls.some(
        (call) => call.realModelInferenceObserved,
      ),
      fullShadowRealModelInferenceObserved: full?.realModelInferenceObserved ?? false,
      realModelInferenceObserved:
        single.calls.some((call) => call.realModelInferenceObserved) ||
        (full?.realModelInferenceObserved ?? false),
      fullShadowCompletedTenRoles: !options.skipFull && fullPassed,
      fullShadowQualityGates: "not_run_in_raw_role_shadow",
      apiTransportSucceeded: apiShadow?.transportSucceeded ?? false,
      apiFreshnessGatePassed: apiShadow?.status === "ready",
      providerConfigTouched: false,
      externalSideEffects: false,
      protectedMemoryTouched: false,
      deterministicFallbackUsed: false,
    },
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `single_role=${singlePassed ? "passed" : "failed"}`,
        `full_shadow=${options.skipFull ? "skipped" : fullPassed ? "passed" : "failed"}`,
        `model=${runtime.modelId}`,
        `evidence=adapter-attested only when receipt says so`,
        `external_side_effects=false provider_config_touched=false`,
      ].join("\n") + "\n",
    );
  }
  return singlePassed && fullPassed && (!options.withGeospatial || apiShadow?.status === "ready")
    ? 0
    : 2;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(
    `lcx live model smoke failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
