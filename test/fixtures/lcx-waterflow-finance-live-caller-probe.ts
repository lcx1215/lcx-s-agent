import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import {
  parseArgs,
  run,
  compactFinanceResearchSummary,
} from "../../scripts/operator/lcx-finance-research-run.js";
import * as configuredAdapter from "../../src/agents/configured-finance-model-adapter.js";
import { buildFinanceAutomaticLifecycleFeedback } from "../../src/agents/finance-automatic-lifecycle-feedback.js";
import {
  appendFinanceBars,
  type FinanceBarAppendInput,
} from "../../src/agents/finance-bar-ledger.js";
import { latestCompletedWeekdaySessionDate } from "../../src/agents/finance-cycle-schedule.js";
import * as freeCollection from "../../src/agents/finance-free-market-collection-adapters.js";
import { assessFinanceHistoryCoverage } from "../../src/agents/finance-history-coverage.js";
import * as collectionRegistry from "../../src/agents/finance-market-collection-registry.js";
import { readFinanceActiveStrategyResearchScope } from "../../src/agents/finance-night-review-context.js";
import * as realtimeRegistry from "../../src/agents/finance-realtime-source-registry.js";
import { runResearchBatch } from "../../src/agents/finance-research-batch.js";
import * as runner from "../../src/agents/finance-research-runner.js";
import {
  declareFinanceStrategyRule,
  activateFinanceStrategyRule,
} from "../../src/agents/finance-strategy-rule-ledger.js";
import * as prompt from "../../src/agents/local-text-model-adapter.js";
import * as checkpointStore from "../../src/agents/logical-agent-pool-checkpoint-store.js";
import type { QualityHarnessModelRequest } from "../../src/agents/quality-harness-contract.js";
import * as config from "../../src/config/config.js";
import type { OpenClawConfig } from "../../src/config/config.js";
import { probeOriginalFinanceDayOperator } from "./lcx-waterflow-finance-day-operator-probe.js";
import {
  prepareOriginalFinanceModuleMain,
  probeOriginalFinanceModuleMain,
  type FinanceModuleMainFault,
} from "./lcx-waterflow-finance-module-main-probe.js";
import { probeOriginalFinanceNightScheduler } from "./lcx-waterflow-finance-scheduler-plan-probe.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export type LiveCallerFault =
  | "missing_evidence"
  | "cross_account"
  | "broker_unknown"
  | FinanceModuleMainFault;

/** Same original scheduler child invocation produces the receipt later consumed by the original day owner. */
export async function probeOriginalFinanceLiveCaller(params: {
  directory: string;
  allocation?: number;
  fault?: LiveCallerFault;
  includeNight?: boolean;
}) {
  let preparation = await prepareOriginalFinanceModuleMain({
    seedControllerHistory: false,
    directory: path.join(params.directory, "current-research"),
    allocation: params.allocation,
    dailyExecutableRule: true,
    fault:
      params.fault === "missing_evidence" ||
      params.fault === "cross_account" ||
      params.fault === "run_timeout" ||
      params.fault === "broker_unknown"
        ? undefined
        : params.fault,
  });
  let selectedControllerContext: runner.FinanceResearchRunInput["portfolioContext"];
  if (params.fault === "broker_unknown") {
    // This is the explicit host selection before preflight, never a mutation of runner inputs.
    await declareFinanceStrategyRule(preparation.book, {
      kind: "declared",
      ruleId: "private-intraday",
      form: "opening_range",
      formVersion: "1",
      instruments: ["SPY"],
      emits: "trade_signals",
      schedule: { kind: "intraday", timezone: "America/New_York" },
      body: {
        frozenRule: { lookbackMonths: 3, researchBudgetFraction: 0, openingRangeMinutes: 30 },
      },
      observedAt: "2026-09-01T00:02:00Z",
      provenance: { origin: "private explicit intraday research fixture, no execution permission" },
    });
    await activateFinanceStrategyRule(preparation.book, {
      kind: "activated",
      ruleId: "private-intraday",
      observedAt: "2026-09-01T00:03:00Z",
    });
    const strategyIds = ["private-trend", "private-intraday"];
    const scope = await readFinanceActiveStrategyResearchScope({
      directory: preparation.book,
      asOf: preparation.asOf,
      strategyIds,
    });
    selectedControllerContext = {
      ...preparation.input.portfolioContext!,
      activeStrategyIds: strategyIds,
      requiredInstruments: [...scope.instruments],
    };
    preparation = {
      ...preparation,
      scope,
      input: {
        ...preparation.input,
        portfolioContext: selectedControllerContext,
        controllerEvidence: scope.evidence,
      },
    };
    await fs.writeFile(
      path.join(params.directory, "selected-original-controller-context.json"),
      JSON.stringify(
        {
          selectedControllerContext,
          originalScope: scope,
          phase: "host_selection_before_original_preflight_not_execute_input",
        },
        null,
        2,
      ) + "\n",
    );
  }
  const cutoff = Date.parse(latestCompletedWeekdaySessionDate(preparation.asOf) + "T00:00:00Z");
  const bars: Extract<FinanceBarAppendInput, { derivation: "ohlcv" }>["bars"] = [];
  for (let offset = 1500; offset >= 0; offset--) {
    const day = new Date(cutoff - offset * 86_400_000);
    if ([0, 6].includes(day.getUTCDay())) {
      continue;
    }
    const close = 100 + (1500 - offset) * 0.05 + Math.sin(offset);
    bars.push({
      date: day.toISOString().slice(0, 10),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000000,
    });
  }
  const privateBarWrite = await appendFinanceBars(preparation.book, {
    instrument: "SPY",
    derivation: "ohlcv",
    observedAt: preparation.asOf,
    provenance: {
      origin: "private offline synthetic historical input",
      sourceUrlOrArtifact: "fixture://private-ledger/SPY",
    },
    bars,
  });
  const originalCollection = preparation.collection;
  const historyCollection: collectionRegistry.FinanceMarketCollectionAdapter = {
    ...originalCollection,
    collect: async (request, signal) => {
      if (params.fault === "missing_source" || params.fault === "source_timeout") {
        return originalCollection.collect(request, signal);
      }
      signal.throwIfAborted();
      const records = bars
        .filter(
          (bar) =>
            (!request.fromDate || bar.date >= request.fromDate) &&
            (!request.toDate || bar.date <= request.toDate),
        )
        .map((bar) => ({
          itemId: `private-history-${bar.date}`,
          collection: request.collection,
          providerName: originalCollection.providerName,
          providerRole: originalCollection.providerRole,
          sourceFamily: "market_data_api" as const,
          sourceTimestamp: `${bar.date}T20:00:00.000Z`,
          observedAt: preparation.asOf,
          delayStatus: "official_lagged" as const,
          sourceUrlOrArtifact: "fixture://private-ledger/SPY",
          data: bar,
        }));
      // Local synthetic weekday bars include exchange holidays; keep the original calendar gate.
      const coverage = assessFinanceHistoryCoverage(request, records);
      const invalid = new Set(coverage.providers.flatMap((provider) => provider.invalid));
      return records.filter((record) => !invalid.has(record.itemId));
    },
  };
  vi.stubEnv("OPENCLAW_WORKSPACE_DIR", preparation.workspace);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(preparation.workspace, "private-state"));
  vi.stubEnv("LCX_FINANCE_STATE_DIR", preparation.book);
  vi.stubEnv("LCX_MODEL_TRAJECTORY", "0");
  vi.stubEnv("ALPACA_API_KEY_ID", "");
  vi.stubEnv("ALPACA_API_SECRET_KEY", "");
  const privateConfig: OpenClawConfig = {
    agents: { defaults: { model: "fixture/fast", memorySearch: { enabled: false } } },
    tools: {
      financeModelSlots: {
        fast: "fixture/fast",
        reasoning: "fixture/reasoning",
        review: "fixture/review",
      },
    },
    models: {
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: "https://fixture.invalid/v1",
          apiKey: "private-synthetic-token",
          models: ["fast", "reasoning", "review"].map((id) => ({
            id,
            name: id,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 320_000,
            maxTokens: 32_000,
          })),
        },
      },
    },
  };
  vi.spyOn(config, "loadConfig").mockReturnValue(privateConfig);
  const originalCheckpoint = checkpointStore.createCanonicalStateRootLogicalAgentCheckpointStore;
  vi.spyOn(
    checkpointStore,
    "createCanonicalStateRootLogicalAgentCheckpointStore",
  ).mockImplementation(() =>
    originalCheckpoint({
      stateDir: path.join(preparation.workspace, "private-quality-checkpoints"),
    }),
  );
  const realtimeOptions = realtimeRegistry.resolveFinanceRealtimeSourceRegistryOptionsFromEnv;
  const collectionOptions = collectionRegistry.resolveFinanceMarketCollectionRegistryOptionsFromEnv;
  vi.spyOn(
    realtimeRegistry,
    "resolveFinanceRealtimeSourceRegistryOptionsFromEnv",
  ).mockImplementation(() => realtimeOptions({}));
  vi.spyOn(
    collectionRegistry,
    "resolveFinanceMarketCollectionRegistryOptionsFromEnv",
  ).mockImplementation(() => collectionOptions({}));
  vi.spyOn(realtimeRegistry, "createFinanceRealtimeSourceRegistry").mockImplementation(() => [
    preparation.realtime("primary_market_data"),
    preparation.realtime("cross_check_market_data"),
  ]);
  vi.spyOn(collectionRegistry, "createFinanceMarketCollectionRegistry").mockImplementation(() => [
    historyCollection,
    {
      id: "private-news",
      providerName: "private-news",
      providerRole: "primary_market_data",
      priority: 1,
      supports: (request) => request.collection === "news",
      collect: async (request, signal) => {
        signal.throwIfAborted();
        if (params.fault === "missing_source") {
          throw new Error("private_source_missing");
        }
        return [
          {
            itemId: "private-news-item",
            collection: request.collection,
            providerName: "private-news",
            providerRole: "primary_market_data",
            sourceFamily: "market_data_api",
            sourceTimestamp: preparation.asOf,
            observedAt: preparation.asOf,
            delayStatus: "realtime",
            sourceUrlOrArtifact: "fixture://private-news/SPY",
            data: { title: "Private SPY synthetic source report", tickers: ["SPY"] },
          },
        ];
      },
    },
  ]);
  const requests = new Map<string, QualityHarnessModelRequest>();
  const modelRequests: QualityHarnessModelRequest[] = [];
  const originalPrompt = prompt.buildQualityHarnessModelPromptWithCoverage;
  vi.spyOn(prompt, "buildQualityHarnessModelPromptWithCoverage").mockImplementation(
    (request, options) => {
      const built = originalPrompt(request, options);
      requests.set(built.prompt, structuredClone(request));
      return built;
    },
  );
  const adapterStates: Array<{
    modelRef?: string;
    adapter: ReturnType<typeof configuredAdapter.createConfiguredFinanceModelAdapter>;
  }> = [];
  const originalAdapter = configuredAdapter.createConfiguredFinanceModelAdapter;
  vi.spyOn(configuredAdapter, "createConfiguredFinanceModelAdapter").mockImplementation(
    (cfg, options) => {
      const adapter = originalAdapter(cfg, {
        ...options,
        availabilityStateDirectory: path.join(preparation.workspace, "private-cooldowns"),
      });
      adapterStates.push({ modelRef: options?.modelRef, adapter });
      return adapter;
    },
  );
  let forbiddenNetwork = 0;
  const modelHttpCalls: Array<{
    url: string;
    model: string;
    stage: string;
    response?: unknown;
    aborted?: boolean;
    promptText?: string;
  }> = [];
  const lateResult = { attempted: false, cancelled: false, enqueueRejected: false };
  let lateCompletion: Promise<void> | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url) !== "https://fixture.invalid/v1/chat/completions") {
        forbiddenNetwork++;
        throw new Error("external network forbidden");
      }
      if (typeof init?.body !== "string") {
        throw new Error("private model transport expected a JSON string body");
      }
      const body = JSON.parse(init.body);
      const request = requests.get(body.messages[0].content);
      if (!request || !init?.signal) {
        throw new Error("original prompt/signal missing at model HTTP seam");
      }
      modelRequests.push(structuredClone(request));
      const call: (typeof modelHttpCalls)[number] = {
        url: String(url),
        model: body.model,
        stage: request.stage,
      };
      modelHttpCalls.push(call);
      call.promptText = body.messages[0].content;
      if (!call.promptText) {
        throw new Error("original model HTTP prompt missing");
      }
      const evidenceSection = call.promptText.match(
        /(?:^|\n)evidence=([\s\S]*?)(?=\ninstrument_citation_scope=|\nallowed_evidence_ids=)/u,
      )?.[1];
      if (!evidenceSection) {
        throw new Error("actual model HTTP prompt omitted evidence section");
      }
      const promptEvidence = [
        ...evidenceSection.matchAll(/\[([^\]]+)\] ([\s\S]*?)(?= \| \[|$)/gu),
      ].map((match) => ({
        id: match[1],
        text: match[2].replace(/ \([^()]*\)$/u, ""),
      }));
      // Scripted budgets come from the exact bounded HTTP prompt, not the fixture's prepared input.
      let response = await preparation.scriptedOutput(
        { ...request, evidence: promptEvidence },
        init.signal,
      );
      if (
        params.fault === "broker_unknown" &&
        response.kind === "artifact" &&
        response.artifact?.supportingAnalysis
      ) {
        const rule = promptEvidence.find(
          (entry) => entry.id === "finance-controller:active-strategies",
        );
        const rules = rule
          ? (JSON.parse(rule.text).activeRules as Array<{
              ruleId: string;
              body: { frozenRule: { researchBudgetFraction: number } };
            }>)
          : [];
        const intraday = rules.find((entry) => entry.ruleId === "private-intraday");
        if (!intraday || intraday.body.frozenRule.researchBudgetFraction !== 0) {
          throw new Error("actual model prompt lost private zero-budget intraday rule");
        }
        response = {
          ...response,
          artifact: {
            ...response.artifact,
            supportingAnalysis: {
              ...response.artifact.supportingAnalysis,
              portfolioAllocationProposal: {
                allocations: [
                  ...response.artifact.supportingAnalysis.portfolioAllocationProposal.allocations,
                  {
                    strategyId: intraday.ruleId,
                    budgetFraction: intraday.body.frozenRule.researchBudgetFraction,
                    evidenceIds: [rule!.id],
                  },
                ],
              },
            },
          },
        };
      }
      call.response = response;
      if (params.fault === "run_timeout") {
        let completeLate: (() => void) | undefined;
        lateCompletion = new Promise<void>((resolve) => {
          completeLate = resolve;
        });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            setTimeout(() => {
              lateResult.attempted = true;
              try {
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify({
                      choices: [
                        { finish_reason: "stop", message: { content: JSON.stringify(response) } },
                      ],
                    }),
                  ),
                );
                controller.close();
              } catch {
                lateResult.enqueueRejected = true;
              }
              completeLate?.();
            }, 250);
          },
          cancel() {
            lateResult.cancelled = true;
          },
        });
        init.signal.addEventListener(
          "abort",
          () => {
            call.aborted = true;
          },
          { once: true },
        );
        return new Response(stream, { status: 200 });
      }
      return new Response(
        JSON.stringify({
          id: `private-response-${modelHttpCalls.length}`,
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify(response) } }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
        { status: 200 },
      );
    }),
  );
  const actualRunnerInputs: runner.FinanceResearchRunInput[] = [];
  const originalRunner = runner.runFinanceResearchRun;
  vi.spyOn(runner, "runFinanceResearchRun").mockImplementation(async (options) => {
    actualRunnerInputs.push(structuredClone(options.input));
    return originalRunner(options);
  });
  let privateDayFetch: Parameters<
    typeof freeCollection.createChinaReachableUsEodHistoryCollectionAdapter
  >[0];
  const originalDayAdapter = freeCollection.createChinaReachableUsEodHistoryCollectionAdapter;
  vi.spyOn(freeCollection, "createChinaReachableUsEodHistoryCollectionAdapter").mockImplementation(
    (options) => originalDayAdapter({ ...options, ...privateDayFetch }),
  );
  let cliOutput: Awaited<ReturnType<typeof run>> | undefined;
  let cliFailure: string | undefined;
  let cliFailureCause: string | undefined;
  let childArgv: readonly string[] | undefined;
  let preflightBytes:
    | { evidence: string; context: string; evidencePath: string; contextPath: string }
    | undefined;
  const result = await probeOriginalFinanceDayOperator({
    directory: params.directory,
    fault: params.fault === "broker_unknown" ? "broker_unknown" : undefined,
    researchPreparation: preparation,
    researchChildConsumer: async ({ argv }) => {
      childArgv = argv;
      const options = parseArgs(argv.slice(3));
      preflightBytes = {
        evidence: await fs.readFile(options.controllerEvidencePath!, "utf8"),
        context: await fs.readFile(options.portfolioContextPath!, "utf8"),
        evidencePath: options.controllerEvidencePath!,
        contextPath: options.portfolioContextPath!,
      };
      if (params.fault === "missing_evidence") {
        await fs.rm(options.controllerEvidencePath!);
      }
      if (params.fault === "cross_account") {
        const items = JSON.parse(preflightBytes.evidence);
        const payload = JSON.parse(items[0].text);
        payload.accountScope.accountId = "different-private-account";
        items[0].text = JSON.stringify(payload);
        await fs.writeFile(options.controllerEvidencePath!, JSON.stringify(items) + "\n");
      }
      options.sourceTimeoutMs = 30;
      options.totalTimeoutMs = 2_000;
      options.runTimeoutMs = params.fault === "run_timeout" ? 100 : 10_000;
      try {
        const nativeProducer = await probeOriginalFinanceModuleMain({
          directory: path.join(params.directory, "current-research"),
          preparation,
          checkpointDirectory: path.join(
            preparation.workspace,
            "state",
            "finance-research-checkpoints",
          ),
          executeResearch: async () => {
            try {
              cliOutput = await run(options);
            } catch (error) {
              cliFailure = error instanceof Error ? error.message : String(error);
              cliFailureCause =
                error instanceof Error && error.cause instanceof Error
                  ? error.cause.message
                  : undefined;
              throw error;
            }
            return { receipt: cliOutput.receipt, executeInput: actualRunnerInputs.at(-1)! };
          },
        });
        const summary = cliOutput
          ? compactFinanceResearchSummary({ ...cliOutput.receipt, ...cliOutput })
          : nativeProducer.summary;
        return {
          nativeProducer,
          summary,
          exitCode: summary.status === "candidate" || summary.status === "planned" ? 0 : 2,
          stderr: cliFailure ? `lcx finance research run failed: ${cliFailure}\n` : "",
        };
      } catch (error) {
        cliFailure = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
    installPrivateIo: ({ fetchImpl }) => {
      privateDayFetch = { fetchImpl };
    },
  });
  await lateCompletion;
  let sameBookNight:
    | {
        sampler: Awaited<ReturnType<typeof runResearchBatch>>;
        sample: { path: string; sha256: string; bytes: number; text: string };
        night: Awaited<ReturnType<typeof probeOriginalFinanceNightScheduler>>;
        centralFeedback: Awaited<ReturnType<typeof buildFinanceAutomaticLifecycleFeedback>>;
        localPriceRequests: string[];
        boundary: string;
      }
    | undefined;
  if (params.includeNight) {
    if (cliOutput?.receipt.status !== "candidate") {
      throw new Error("same-book night requires this actual original research candidate");
    }
    const sampler = await runResearchBatch({
      directory: preparation.book,
      instruments: ["SPY"],
      env: { LCX_FINANCE_STATE_DIR: preparation.book },
      macroFor: async () => [],
      newsFor: async () => ({ sourceId: "private_no_news_supplied", items: [] }),
    });
    const sampleBytes = await fs.readFile(sampler.recordPath);
    const nightAsOf = sampler.asOf;
    const localPriceRequests: string[] = [];
    privateDayFetch = {
      fetchImpl: async (url) => {
        localPriceRequests.push(String(url));
        if (!String(url).includes("/api/qt/stock/kline/get")) {
          throw new Error("private night market HTTP route not supplied");
        }
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              data: {
                klines: bars.map(
                  (bar) =>
                    `${bar.date},${bar.open},${bar.close},${bar.high},${bar.low},${bar.volume}`,
                ),
              },
            }),
        };
      },
    };
    // Use the existing original HTTP adapter for both refresh and settlement, with local raw IO.
    vi.spyOn(collectionRegistry, "createFinanceMarketCollectionRegistry").mockImplementation(() => [
      originalDayAdapter(privateDayFetch),
    ]);
    const nightDirectory = path.join(params.directory, "same-book-night");
    await fs.mkdir(nightDirectory, { recursive: true });
    const night = await probeOriginalFinanceNightScheduler({
      directory: nightDirectory,
      workspace: preparation.workspace,
      book: preparation.book,
      asOf: nightAsOf,
      sampleSource: "existing",
    });
    const centralFeedback = await buildFinanceAutomaticLifecycleFeedback({
      directory: preparation.book,
      observedAt: nightAsOf,
    });
    sameBookNight = {
      sampler,
      sample: {
        path: sampler.recordPath,
        sha256: hash(sampleBytes),
        bytes: sampleBytes.length,
        text: sampleBytes.toString("utf8"),
      },
      night,
      centralFeedback,
      localPriceRequests,
      boundary:
        "same private native book; explicit original sampler, original night caller and independent original Central feedback reader. A refused direction is declined and never scored or calibrated. Market HTTP is a local synthetic scenario only; forecast sample has no financial account/run binding. Proposal tool workspace-default read is separate and not claimed as this book; native proposalReadback is used.",
    };
  }
  const proof = {
    result,
    childArgv,
    preflightBytes,
    preflightEvidenceSha256: preflightBytes ? hash(preflightBytes.evidence) : null,
    preflightContextSha256: preflightBytes ? hash(preflightBytes.context) : null,
    actualRunnerInputs,
    cliOutput,
    cliFailure,
    cliFailureCause,
    preparationPhase: preparation.phase,
    selectedControllerContext,
    modelRequests,
    modelHttpCalls,
    forbiddenNetwork,
    adapterStates: adapterStates.map(({ modelRef, adapter }) => ({
      modelRef,
      state: adapter.inspectCall?.(),
    })),
    sourceCalls: preparation.sourceCalls,
    lateResult,
    privateBarWrite,
    sameBookNight,
    boundary:
      "original live CLI, workflow, configured adapter, checkpoint, runner, module, quality and native writers; scheduler child spawn is private IO. Market registry factories return declared synthetic adapters, not original market HTTP. Model HTTP is a local Response substitute. Scripted acceptance proves handoff only, never source truth or natural semantic judgment. Private config/state only; broker confirmation remains required.",
  };
  await fs.writeFile(
    path.join(params.directory, "native-live-caller-result.json"),
    JSON.stringify(proof, null, 2) + "\n",
  );
  return proof;
}
