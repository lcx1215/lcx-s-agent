import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import type {
  buildCommercialAcceptanceHarness,
  HarnessInputs,
} from "../../scripts/operator/lcx-commercial-acceptance-harness.js";
import {
  executeDirectedDailyResearchTask,
  inspectDirectedContentReview,
} from "../../scripts/operator/lcx-directed-daily-research-brief.js";
import type { FinanceMarketCollectionAdapter } from "../../src/agents/finance-market-collection-registry.js";
import type { QualityHarnessModelRequest } from "../../src/agents/quality-harness-contract.js";
import {
  prepareOriginalFinanceModuleMain,
  type FinanceModuleMainFault,
} from "./lcx-waterflow-finance-module-main-probe.js";

export const directedRepo = path.resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);
export function directedSha(bytes: string | Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Only the native brief's file-only CLI is executed. The commercial owner collector
// and research/provider stacks are never invoked.
export async function produceNativeBrief(workspace: string) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      path.join(directedRepo, "scripts/operator/lcx-directed-daily-research-brief.ts"),
      "--json",
      "--write",
      "--date",
      "2026-10-11",
    ],
    {
      cwd: directedRepo,
      env: { ...process.env, OPENCLAW_WORKSPACE_DIR: workspace },
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const output = JSON.parse(stdout) as Record<string, unknown>;
  const receiptPath = path.join(workspace, "state/lcx-directed-daily-research-brief-latest.json");
  const bytes = await fs.readFile(receiptPath, "utf8");
  const payload = JSON.parse(bytes) as Record<string, unknown>;
  return { output, payload, receiptPath, bytes, sha256: directedSha(bytes) };
}

async function nativeFunctions(file: string, names?: readonly string[]) {
  const source = await fs.readFile(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const functions = ast.statements
    .filter(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) &&
        Boolean(node.name) &&
        (!names || names.includes(node.name!.text)),
    )
    .map((node) => node.getText(ast));
  const context = vm.createContext({ createHash, inspectDirectedContentReview, exports: {} });
  vm.runInContext(
    ts.transpileModule(functions.join("\n"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    context,
  );
  return context;
}

// Reuse the existing unrelated-gate fixtures. They are substitutes, not native
// owner evidence; the only actual producer in this sample is the daily brief.
export async function unrelatedGateInputs() {
  const context = await nativeFunctions(
    path.join(directedRepo, "test/lcx-commercial-acceptance-harness.test.ts"),
    ["owner", "baseInputs"],
  );
  return vm.runInContext("baseInputs()", context) as HarnessInputs;
}

export async function nativeAcceptance(
  inputs: HarnessInputs,
  source = path.join(directedRepo, "scripts/operator/lcx-commercial-acceptance-harness.ts"),
) {
  const context = await nativeFunctions(source);
  context.inputs = inputs;
  return vm.runInContext("buildCommercialAcceptanceHarness(inputs)", context) as ReturnType<
    typeof buildCommercialAcceptanceHarness
  >;
}

export function briefSnapshot(payload: Record<string, unknown>) {
  return {
    ok: true,
    commandSucceeded: true,
    owner: "lcx-directed-daily-research-brief",
    command: "lcx-directed-daily-research-brief --json --write --date 2026-10-11",
    payload,
  };
}

// Reuse the prepared private ledger and registered source/quality IO only.
// The original task caller invokes the real runner, module composition and Caseflow writer.
export async function prepareNativeDirectedTask(
  workspace: string,
  fault?: FinanceModuleMainFault,
  historyLevels?: readonly [number, number, number],
  maxApiCalls = 64,
) {
  const prepared = await prepareOriginalFinanceModuleMain({ directory: workspace, fault });
  const host = {
    accountId: "private-directed-account",
    runId: "private-directed-attempt",
    maxModelCalls: 48,
    maxApiCalls,
  };
  const request = {
    schemaVersion: "lcx_directed_daily_task_request_v1",
    ...host,
    taskId: "index_options_regime",
    caseId: "native-directed-single-task",
    date: prepared.asOf.slice(0, 10),
    asOf: prepared.asOf,
    horizonMonths: 3,
    targets: prepared.input.targets,
    moduleSelection: prepared.input.moduleSelection,
  };
  const requestPath = path.join(workspace, "task-request.json");
  const hostPath = path.join(workspace, "independent-host.json");
  const bytes = JSON.stringify(request, null, 2) + "\n";
  await fs.writeFile(requestPath, bytes);
  const hostBytes = JSON.stringify(host, null, 2) + "\n";
  await fs.writeFile(hostPath, hostBytes);
  const collection: FinanceMarketCollectionAdapter = {
    ...prepared.collection,
    collect: async (request, signal) => {
      const source = await prepared.collection.collect(request, signal);
      const observations = source.map((item, index) =>
        historyLevels
          ? {
              ...item,
              data: {
                ...item.data,
                open: historyLevels[index],
                high: historyLevels[index],
                low: historyLevels[index],
                close: historyLevels[index],
              },
            }
          : item,
      );
      const actual = prepared.sourceCalls.at(-1);
      if (actual) {
        actual.response = observations;
      }
      return observations;
    },
  };
  const routing = {
    ...prepared.routing,
    adapters: prepared.routing.adapters.map((adapter) => ({
      ...adapter,
      invoke: async (request: Parameters<typeof adapter.invoke>[0], signal: AbortSignal) => {
        const response = await adapter.invoke(request, signal);
        const input = request.payload as QualityHarnessModelRequest;
        const module = input.evidence.find((entry) => entry.id === "finance-module:quant_math");
        // Scripted IO demonstrates concrete tool-content consumption, not semantic acceptance.
        if (
          module &&
          response &&
          typeof response === "object" &&
          "artifact" in response &&
          typeof response.artifact === "object" &&
          response.artifact
        ) {
          const tool = JSON.parse(module.text) as { toolOutput: { maxDrawdown: number } };
          const artifact = response.artifact as Record<string, unknown>;
          return {
            ...response,
            artifact: {
              ...artifact,
              answer: `${String(artifact.answer)} Original quantitative history remains an unadjusted close calculation, not current IV/skew evidence or learning acceptance.`,
              supportingAnalysis: {
                ...(artifact.supportingAnalysis && typeof artifact.supportingAnalysis === "object"
                  ? artifact.supportingAnalysis
                  : {}),
                originalQuantResult: {
                  ...tool.toolOutput,
                  evidenceId: module.id,
                  origin: "derived_measure",
                  basis:
                    "original quant_math actual supplied close history, not adjusted total return or a current quote",
                },
              },
            },
          };
        }
        return response;
      },
    })),
  };
  const nativeOptions = {
    date: request.date,
    taskId: request.taskId,
    requestPath,
    requestSha256: directedSha(bytes),
    workspaceDir: workspace,
    host,
    controllerEvidence: prepared.scope.evidence,
    researchOptions: {
      financeStateDir: prepared.book,
      modelInvoker: async (request: unknown, signal: AbortSignal) => {
        const payload = request as QualityHarnessModelRequest;
        prepared.committeeRequests.push(structuredClone(payload));
        return prepared.scriptedOutput(payload, signal);
      },
      qualityModelRouting: routing,
      batchOptions: {
        realtimeAdapters: [
          prepared.realtime("primary_market_data"),
          prepared.realtime("cross_check_market_data"),
        ],
        collectionAdapters: [collection],
        maxSourcesPerJob: 2,
        maxConcurrency: 1,
        sourceTimeoutMs: 20,
        totalTimeoutMs: 2000,
      },
    },
  };
  return {
    prepared,
    host,
    request,
    requestPath,
    hostPath,
    hostSha256: directedSha(hostBytes),
    nativeOptions,
    run: (
      options: Partial<typeof nativeOptions> & { timeoutMs?: number; signal?: AbortSignal } = {},
    ) => executeDirectedDailyResearchTask({ ...nativeOptions, ...options }),
  };
}

export async function nativeDirectedTaskCli(
  workspace: string,
  params: {
    requestPath: string;
    requestSha256: string;
    hostPath: string;
    hostSha256: string;
    date: string;
    source?: string;
  },
) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        params.source ??
          path.join(directedRepo, "scripts/operator/lcx-directed-daily-research-brief.ts"),
        "--json",
        "--execute-task",
        "index_options_regime",
        "--research-request",
        params.requestPath,
        "--research-request-sha",
        params.requestSha256,
        "--research-host",
        params.hostPath,
        "--research-host-sha",
        params.hostSha256,
        "--date",
        params.date,
      ],
      {
        cwd: directedRepo,
        env: { ...process.env, OPENCLAW_WORKSPACE_DIR: workspace },
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return {
      ...result,
      exitCode: 0,
      payload: JSON.parse(result.stdout) as Record<string, unknown>,
    };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      exitCode: failure.code,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      payload: undefined,
    };
  }
}
