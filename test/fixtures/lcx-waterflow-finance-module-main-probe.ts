import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import {
  FinanceResearchRunFailure,
  runCheckpointedFinanceResearch,
} from "../../scripts/operator/lcx-finance-research-checkpoint-run.js";
import { latestCompletedWeekdaySessionDate } from "../../src/agents/finance-cycle-schedule.js";
import type { FinanceDataGatewayObservationInput } from "../../src/agents/finance-data-gateway.js";
import type { FinanceMarketCollectionAdapter } from "../../src/agents/finance-market-collection-registry.js";
import { readFinanceActiveStrategyResearchScope } from "../../src/agents/finance-night-review-context.js";
import { financePortfolioPlanSchema } from "../../src/agents/finance-portfolio-composition.js";
import type { FinanceRealtimeSourceAdapter } from "../../src/agents/finance-realtime-source-registry.js";
import {
  runFinanceResearchRun,
  type FinanceResearchRunInput,
  type FinanceResearchRunReceipt,
} from "../../src/agents/finance-research-runner.js";
import {
  activateFinanceStrategyRule,
  declareFinanceStrategyRule,
  readFinanceStrategyRuleLedger,
} from "../../src/agents/finance-strategy-rule-ledger.js";
import { buildQualityHarnessModelPromptWithCoverage } from "../../src/agents/local-text-model-adapter.js";
import type {
  LogicalAgentModelAdapter,
  LogicalAgentModelRouting,
  ModelCallObservation,
} from "../../src/agents/logical-agent-model-router.js";
import type { QualityHarnessModelRequest } from "../../src/agents/quality-harness-contract.js";
import { buildFinanceFrameworkCoreContractPath } from "../../src/hooks/bundled/lobster-brain-registry.js";

export type FinanceModuleMainFault =
  | "missing_producer"
  | "missing_source"
  | "source_timeout"
  | "run_timeout"
  | "quality_failure";
const repo = path.resolve(import.meta.dirname, "../..");
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type CompactSummary = {
  status: string;
  plan?: { asOf: string };
  portfolioPlanWritten?: string;
  portfolioPlanWrite?: {
    path: string;
    sha256: string;
    asOf: string;
    accountId: string;
    venue: "paper" | "alpaca";
  };
  gates: readonly { id: string; passed: boolean }[];
};
type Writer = {
  writePrivateReceipt: (file: string, bytes: string) => Promise<void>;
  writeVerifiedPortfolioPlan: (
    file: string,
    plan: unknown,
  ) => Promise<NonNullable<CompactSummary["portfolioPlanWrite"]>>;
  compactFinanceResearchSummary: (summary: unknown) => CompactSummary;
  compactFinanceResearchFailure: (error: FinanceResearchRunFailure) => CompactSummary;
};

// Select exact original helpers, avoiding the CLI's configured-provider preflight and main.
// The dynamic import resolves to the original schema; no writer or validation logic is replaced.
async function nativeWriter() {
  const sourcePath = path.join(repo, "scripts/operator/lcx-finance-research-run.ts");
  const source = await fs.readFile(sourcePath, "utf8");
  const names = new Set([
    "writePrivateReceipt",
    "writeVerifiedPortfolioPlan",
    "compactFinanceResearchSummary",
    "compactFinanceResearchFailure",
  ]);
  const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  const declarations = ast.statements
    .filter((node) => ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text))
    .map((node) => node.getText(ast).replace(/^export\s+/u, ""));
  if (declarations.length !== names.size) {
    throw new Error("original finance writer helpers are unavailable");
  }
  const context = vm.createContext({
    createHash,
    fs,
    path,
    randomUUID,
    process: { pid: process.pid },
    require: (specifier: string) => {
      if (specifier !== "../../src/agents/finance-portfolio-composition.ts") {
        throw new Error(`unexpected native writer dependency: ${specifier}`);
      }
      return { financePortfolioPlanSchema };
    },
  });
  const isolated = `${declarations.join("\n")}\nglobalThis.nativeOwners = {${[...names].join(",")}};`;
  const code = ts.transpileModule(isolated, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new vm.Script(code, { filename: sourcePath }).runInContext(context);
  return { owners: context.nativeOwners as Writer, sourcePath, sourceSha256: digest(source) };
}

export async function prepareOriginalFinanceModuleMain(params: {
  directory: string;
  fault?: FinanceModuleMainFault;
  allocation?: number;
  dailyExecutableRule?: boolean;
  asOf?: string;
}) {
  const workspace = path.join(params.directory, "workspace");
  const book = path.join(params.directory, "finance-book");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(book, { recursive: true });
  const allocation = params.allocation ?? 0.4;
  await declareFinanceStrategyRule(book, {
    kind: "declared",
    ruleId: "private-trend",
    form: params.dailyExecutableRule ? "cross_asset_trend" : "monthly_trend",
    ...(params.dailyExecutableRule ? { formVersion: "1" } : {}),
    instruments: ["SPY"],
    emits: "target_weights",
    schedule: {
      kind: "monthly",
      timezone: "America/New_York",
      ...(params.dailyExecutableRule ? { at: "last_trading_day" } : {}),
    },
    body: { frozenRule: { lookbackMonths: 3, researchBudgetFraction: allocation } },
    observedAt: "2026-09-01T00:00:00Z",
    provenance: { origin: "private offline scope fixture", readScope: "private-trend only" },
  });
  await activateFinanceStrategyRule(book, {
    kind: "activated",
    ruleId: "private-trend",
    observedAt: "2026-09-01T00:01:00Z",
  });
  // Default offline proofs stay deterministic; callers modeling a multi-session
  // handoff may supply their injected clock without changing production time gates.
  const asOf = params.asOf ?? "2026-09-17T15:00:00.000Z";
  const scope = await readFinanceActiveStrategyResearchScope({
    directory: book,
    asOf,
    strategyIds: ["private-trend"],
  });
  const historyDates: string[] = [];
  let historyDay = Date.parse(latestCompletedWeekdaySessionDate(asOf) + "T00:00:00Z");
  while (historyDates.length < 3) {
    const day = new Date(historyDay);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) {
      historyDates.unshift(day.toISOString().slice(0, 10));
    }
    historyDay -= 86_400_000;
  }
  const input: FinanceResearchRunInput = {
    ask: "Review SPY within the active controller rule. Allocate only its bounded budget with explicit invalidation; no execution authority.",
    asOf,
    horizonMonths: 3,
    decisionMode: "strategy_candidate",
    strategyStage: "research_candidate",
    executeModules: true,
    moduleSelection: { moduleIds: ["quant_math"], rationale: "Use actual historical drawdown." },
    controllerEvidence: scope.evidence,
    portfolioContext: {
      accountId: `private-${digest(book).slice(0, 12)}`,
      venue: "paper",
      validityMinutes: 60,
      conflictPolicy: "block",
      activeStrategyIds: ["private-trend"],
      requiredInstruments: [...scope.instruments],
    },
    targets: scope.instruments.map((instrument) => ({
      id: `private-${instrument}`,
      instrument,
      assetClass: "us_equity",
      realtime: { requireOfficialReference: false },
      collections: [
        {
          collection: "eod_history",
          fromDate: historyDates[0],
          toDate: historyDates[2],
          limit: 3,
          freshnessMaxMinutes: 10_080,
        },
      ],
    })),
  };
  const frozenInputBytes = JSON.stringify(input, null, 2) + "\n";
  await fs.writeFile(path.join(params.directory, "frozen-original-input.json"), frozenInputBytes);
  const sourceCalls: Array<{ id: string; request: unknown; aborted: boolean; response?: unknown }> =
    [];
  const waitForAbort = (signal: AbortSignal) =>
    new Promise<never>((_, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener("abort", abort, { once: true });
      }
    });
  const sourceFault = async (signal: AbortSignal) => {
    if (params.fault === "missing_source") {
      throw new Error("private_source_missing");
    }
    if (params.fault === "source_timeout") {
      await waitForAbort(signal);
    }
  };
  const realtime = (
    role: FinanceRealtimeSourceAdapter["providerRole"],
  ): FinanceRealtimeSourceAdapter => ({
    id: `private-${role}`,
    providerName: `private-${role}`,
    providerRole: role,
    priority: 1,
    supports: () => true,
    collect: async (request, signal) => {
      const call: (typeof sourceCalls)[number] = { id: role, request, aborted: false };
      sourceCalls.push(call);
      signal.addEventListener("abort", () => (call.aborted = true), { once: true });
      await sourceFault(signal);
      const response: FinanceDataGatewayObservationInput = {
        providerName: `private-${role}`,
        providerRole: role,
        sourceFamily: "market_data_api",
        observedAt: asOf,
        timezone: "UTC",
        delayStatus: "realtime",
        fields: [
          {
            name: "last_price",
            value: 100,
            currency: "USD",
            adjusted: false,
            fieldDefinition: "private fixture price",
            sourceTimestamp: asOf,
            sourceUrlOrArtifact: `fixture://${role}/${request.instrument}`,
          },
        ],
      };
      call.response = response;
      return response;
    },
  });
  const collection: FinanceMarketCollectionAdapter = {
    id: "private-eod",
    providerName: "private-eod",
    providerRole: "primary_market_data",
    priority: 1,
    supports: (request) => request.collection === "eod_history",
    collect: async (request, signal) => {
      const call: (typeof sourceCalls)[number] = { id: "private-eod", request, aborted: false };
      sourceCalls.push(call);
      signal.addEventListener("abort", () => (call.aborted = true), { once: true });
      await sourceFault(signal);
      const response = [100, 95, 97].map((close, index) => {
        const date = historyDates[index];
        return {
          itemId: `private-eod-${index}`,
          collection: request.collection,
          providerName: "private-eod",
          providerRole: "primary_market_data" as const,
          sourceFamily: "market_data_api" as const,
          sourceTimestamp: `${date}T20:00:00.000Z`,
          observedAt: asOf,
          delayStatus: "official_lagged" as const,
          sourceUrlOrArtifact: `fixture://private-eod/${request.instrument}`,
          data: { date, open: close, high: close, low: close, close, volume: 100 },
        };
      });
      call.response = response;
      return response;
    },
  };
  const committeeRequests: QualityHarnessModelRequest[] = [];
  const qualityRequests: QualityHarnessModelRequest[] = [];
  const sourceBodyUses: Array<{
    requestStage: string;
    evidenceId: string;
    sourceText: string;
    sourceSha256: string;
    historyWindow: string;
    observedCount: string;
    quoteTimestamp: string;
    evidenceSummary: string;
  }> = [];
  const scriptedOutput = async (request: QualityHarnessModelRequest, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (params.fault === "run_timeout") {
      await waitForAbort(signal);
    }
    if (request.stage === "intake") {
      return {
        kind: "plan",
        requirements: ["same controller rule and native module evidence"],
        missingEvidence: [],
      };
    }
    if (request.stage === "draft" || request.stage === "format") {
      const rule = request.evidence.find(
        (entry) => entry.id === "finance-controller:active-strategies",
      );
      if (!rule) {
        throw new Error("original request did not contain active rule body");
      }
      const payload = JSON.parse(rule.text) as {
        activeRules: Array<{
          ruleId: string;
          body: { frozenRule: { researchBudgetFraction: number } };
        }>;
      };
      const active = payload.activeRules.find((item) => item.ruleId === "private-trend");
      if (!active) {
        throw new Error("original request lost the exact private rule");
      }
      const markets = request.evidence.filter((entry) => entry.id.startsWith("finance-model:"));
      const market = markets.length === 1 ? markets[0] : undefined;
      const instrument = market?.id.slice("finance-model:".length);
      if (market && (!instrument || !market.text.startsWith(`${instrument}\n`))) {
        throw new Error("original model input market identity conflicts with source body");
      }
      const historyWindow = market?.text.match(
        /\d+ closes \d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}/u,
      )?.[0];
      const observedCount =
        market?.text.match(/observed=\d+/u)?.[0] ?? market?.text.match(/\d+ closes/u)?.[0];
      const quoteTimestamp =
        market?.text.match(/"sourceTimestamp":"([^"]+)"/u)?.[1] ??
        (params.dailyExecutableRule ? "not_requested_research_close_only" : undefined);
      if (!market || !historyWindow || !observedCount || !quoteTimestamp) {
        throw new Error("original model input lacks unique dated target source observations");
      }
      const evidenceSummary = `[${market.id}] ${historyWindow}; ${observedCount}; quote sourceTimestamp=${quoteTimestamp}. Rule ${active.ruleId} bounds the research budget to ${active.body.frozenRule.researchBudgetFraction}; account profitability and execution readiness remain unknown.`;
      sourceBodyUses.push({
        requestStage: request.stage,
        evidenceId: market.id,
        sourceText: market.text,
        sourceSha256: digest(market.text),
        historyWindow,
        observedCount,
        quoteTimestamp,
        evidenceSummary,
      });
      const constraints = request.sharedContext?.userConstraints as
        | {
            financeFrameworkProducerContract?: {
              selectedModuleIds: string[];
              evidenceGateByModule: Record<
                string,
                { requiredAllCategories: string[]; requiredAnyCategoryGroups?: string[][] }
              >;
            };
          }
        | undefined;
      const contract = constraints?.financeFrameworkProducerContract;
      const producerInputs = Object.fromEntries(
        (contract?.selectedModuleIds ?? []).map((domain) => [
          domain,
          {
            domain,
            sourceArtifacts: [market.id, rule.id],
            evidenceCategories: [
              ...contract!.evidenceGateByModule[domain].requiredAllCategories,
              ...(contract!.evidenceGateByModule[domain].requiredAnyCategoryGroups?.[0] ?? []),
            ],
            evidenceSummary,
            baseCase: "retain the controller-bounded allocation while evidence remains valid",
            bullCase: "source history recovers without increasing the controller budget",
            bearCase: "drawdown invalidates the source-backed research hypothesis",
            keyCausalChain: `${instrument} ${observedCount} (${historyWindow}; quote ${quoteTimestamp}) -> rule ${active.ruleId} budget boundary -> bounded exposure hypothesis, not established causation`,
            upstreamDrivers: [
              `controller-declared budget and observed ${instrument} historical close levels`,
            ],
            downstreamAssetImpacts: [
              `${instrument} research exposure and possible drawdown within the declared budget`,
            ],
            confidenceOrConviction: "medium",
            whatChangesMyMind: `Invalidate on source loss or contradiction to ${historyWindow}, quote time ${quoteTimestamp}, or rule ${active.ruleId} budget boundary.`,
            noActionReason: "research review alone grants no execution authority",
            riskGateNotes: "actual account, fees and execution reconciliation are still required",
            allowedActionAuthority: "research_only",
          },
        ]),
      );
      return {
        kind: "artifact",
        artifact: {
          answer: `Under the supplied dated evidence, this three-month ${instrument} research candidate retains only the private rule budget if the supplied evidence remains valid. Stop the research hypothesis on source loss or contradictory drawdown; this is no order permission.`,
          claims: [
            {
              id: "controller-budget",
              text: "Only the controller's active rule budget is eligible for this research allocation.",
              status: "supported",
              evidenceIds: [rule.id],
              epistemicClass: "inference",
              basis: "The original active-rule ledger projection supplies the exact private scope.",
              evidenceRelations: [{ evidenceId: rule.id, relation: "supports" }],
            },
          ],
          supportingAnalysis: {
            ...(params.fault === "missing_producer"
              ? {}
              : { financeFrameworkProducerInputs: producerInputs }),
            portfolioAllocationProposal: {
              allocations: [
                {
                  strategyId: active.ruleId,
                  budgetFraction: active.body.frozenRule.researchBudgetFraction,
                  evidenceIds: [rule.id],
                },
              ],
            },
            causalHypotheses: ["budget", "drawdown"].map((id) => ({
              id,
              cause: id,
              effect: "exposure sensitivity",
              mechanism: "bounded capital allocation",
              evidenceIds: [rule.id],
              alternativeExplanations: ["market repricing"],
              disconfirmingTest: "observe contradictory history",
              status: "hypothesis",
            })),
            scenarios: ["base", "up", "down"].map((id, index) => ({
              id,
              probability: [0.5, 0.3, 0.2][index],
              condition: id,
              expectedEffect: "conditional exposure sensitivity",
              invalidation: "source contradiction",
              evidenceIds: [rule.id],
            })),
          },
        },
      };
    }
    return {
      kind: "review",
      review: {
        verdict: params.fault === "quality_failure" && request.stage ? "revise" : "pass",
        criticalFindings:
          params.fault === "quality_failure" && request.stage
            ? ["offline_quality_contradiction: supplied evidence does not justify the draft"]
            : [],
        evidenceGaps: [],
        notes: request.evidence.map(
          (entry) =>
            `[${entry.id}] available to this scripted review; no semantic correctness claim.`,
        ),
      },
    };
  };
  const coverage = new Map<string, ModelCallObservation["evidenceCoverage"]>();
  const adapter: LogicalAgentModelAdapter = {
    id: "private-quality",
    provider: "fixture",
    modelId: "scripted-io-only",
    mode: "adapter",
    capabilities: ["quality_harness"],
    requiredTools: [],
    requiredSideEffects: [],
    invoke: async (request, signal) => {
      const payload = request.payload as QualityHarnessModelRequest;
      qualityRequests.push(structuredClone(payload));
      coverage.set(
        request.callId,
        buildQualityHarnessModelPromptWithCoverage(payload).evidenceCoverage,
      );
      return scriptedOutput(payload, signal);
    },
    observe: (request) => ({
      callId: request.callId,
      provider: "fixture",
      modelId: "scripted-io-only",
      transportRequestId: `fixture:${request.callId}`,
      kind: "model_inference",
      evidenceCoverage: coverage.get(request.callId),
    }),
  };
  const routing: LogicalAgentModelRouting = {
    revision: "private-native-module-v1",
    adapters: [adapter],
    defaultPolicy: {
      primary: adapter.id,
      requiredCapabilities: ["quality_harness"],
      maxInputBytes: 1_000_000,
      timeoutMs: 1_000,
    },
  };
  return {
    phase: "inputs_prepared_no_research_receipt" as const,
    workspace,
    book,
    input,
    scope,
    asOf,
    frozenInputBytes,
    sourceCalls,
    committeeRequests,
    qualityRequests,
    sourceBodyUses,
    scriptedOutput,
    realtime,
    collection,
    routing,
  };
}

export async function probeOriginalFinanceModuleMain(
  params: Parameters<typeof prepareOriginalFinanceModuleMain>[0] & {
    preparation?: Awaited<ReturnType<typeof prepareOriginalFinanceModuleMain>>;
    executeResearch?: (
      preparation: Awaited<ReturnType<typeof prepareOriginalFinanceModuleMain>>,
    ) => Promise<{
      receipt: FinanceResearchRunReceipt;
      executeInput: FinanceResearchRunInput;
    }>;
    checkpointDirectory?: string;
  },
) {
  const preparation = params.preparation ?? (await prepareOriginalFinanceModuleMain(params));
  const {
    workspace,
    book,
    input,
    scope,
    asOf,
    frozenInputBytes,
    sourceCalls,
    committeeRequests,
    qualityRequests,
    scriptedOutput,
    realtime,
    collection,
    routing,
  } = preparation;
  const checkpointRoot = params.checkpointDirectory ?? path.join(params.directory, "checkpoints");
  let receipt: FinanceResearchRunReceipt | undefined;
  let failure: FinanceResearchRunFailure | undefined;
  let executeInput: FinanceResearchRunInput | undefined;
  try {
    if (params.executeResearch) {
      const result = await params.executeResearch(preparation);
      receipt = result.receipt;
      executeInput = result.executeInput;
    } else {
      receipt = await runCheckpointedFinanceResearch(
        {
          input,
          workspaceDir: workspace,
          financeStateDir: book,
          liveFetch: true,
          allowProviderCalls: false,
          qualityEnabled: true,
          modelInvoker: async (request, signal) => {
            const payload = request as QualityHarnessModelRequest;
            committeeRequests.push(structuredClone(payload));
            return scriptedOutput(payload, signal);
          },
          qualityModelRouting: routing,
          batchOptions: {
            realtimeAdapters: [
              realtime("primary_market_data"),
              realtime("cross_check_market_data"),
            ],
            collectionAdapters: [collection],
            maxSourcesPerJob: 2,
            maxConcurrency: 1,
            sourceTimeoutMs: 20,
            totalTimeoutMs: 2_000,
          },
        },
        {
          directory: checkpointRoot,
          runTimeoutMs: params.fault === "run_timeout" ? 60 : 10_000,
          maxModelCalls: 64,
        },
        async (options) => {
          executeInput = structuredClone(options.input);
          return runFinanceResearchRun(options);
        },
      );
    }
  } catch (error) {
    if (!(error instanceof FinanceResearchRunFailure)) {
      throw error;
    }
    failure = error;
  }
  const writer = await nativeWriter();
  const receiptPath = path.join(params.directory, "native-research-receipt.json");
  const planPath = path.join(params.directory, "native-portfolio-plan.json");
  const portfolioPlanWrite = receipt?.portfolioPlan
    ? await writer.owners.writeVerifiedPortfolioPlan(planPath, receipt.portfolioPlan)
    : undefined;
  const portfolioPlanWritten = portfolioPlanWrite?.path;
  const summary = receipt
    ? writer.owners.compactFinanceResearchSummary({
        ...receipt,
        portfolioPlanWritten,
        portfolioPlanWrite,
      })
    : writer.owners.compactFinanceResearchFailure(failure!);
  await writer.owners.writePrivateReceipt(
    receiptPath,
    JSON.stringify(receipt ?? summary, null, 2) + "\n",
  );
  await writer.owners.writePrivateReceipt(
    path.join(params.directory, "native-summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  const readback = JSON.parse(await fs.readFile(receiptPath, "utf8")) as
    | FinanceResearchRunReceipt
    | CompactSummary;
  const planReadback = portfolioPlanWritten
    ? financePortfolioPlanSchema.parse(JSON.parse(await fs.readFile(portfolioPlanWritten, "utf8")))
    : undefined;
  const contractPath = path.join(workspace, buildFinanceFrameworkCoreContractPath());
  const frameworkContract = await fs.readFile(contractPath, "utf8").catch(() => null);
  const checkpoints = await fs.readdir(checkpointRoot);
  const checkpointPath = path.join(checkpointRoot, checkpoints[0], "run.json");
  const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8")) as {
    status: string;
    reason?: string;
    runId: string;
  };
  const captured = {
    scope,
    executeInput,
    sourceCalls,
    committeeRequests,
    qualityRequests,
    receipt,
    summary,
    readback,
    planReadback,
    frameworkContract,
    checkpoint,
    writerSourceSha256: writer.sourceSha256,
    frozenInputSha256: digest(frozenInputBytes),
    receiptSha256: digest(await fs.readFile(receiptPath)),
    ruleRead: await readFinanceStrategyRuleLedger(book, { asOf }),
    boundary:
      "private original components; scripted IO is not real model quality, natural scheduler or broker acceptance",
  };
  await fs.writeFile(
    path.join(params.directory, "native-captured-consumption.json"),
    JSON.stringify(captured, null, 2) + "\n",
  );
  return { ...captured, workspace, book, receiptPath, planPath, checkpointPath, contractPath };
}
