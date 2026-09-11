#!/usr/bin/env node

/**
 * Build one auditable receipt for the complete 12-method strategy surface.
 *
 * The market calculations live in the existing benchmark and research
 * runners. This operator joins their real-data receipts, checks that every
 * catalog method has an actual result or an explicit evidence gate, and keeps
 * blocked methods blocked. It never turns a diagnostic into a trade signal.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FINANCE_STRATEGY_METHODS,
  STRATEGY_METHOD_IDS,
  type StrategyMethodId,
} from "../../src/agents/finance-strategy-method-catalog.ts";

type JsonObject = Record<string, unknown>;
type MethodReceipt = Readonly<{
  method: StrategyMethodId;
  name: string;
  evidenceType: "real_market_backtest" | "real_market_diagnostic" | "real_market_contract";
  sourceWindow: string;
  sourceArtifacts: readonly string[];
  sourceKinds: readonly string[];
  sourceReceiptsReady: boolean;
  sourceStage: string;
  assessment: "research_only";
  gateStatus: string;
  checksPass: boolean;
  result: JsonObject;
  claims: Readonly<{
    profit: "not_claimed";
    modelLearning: "not_claimed";
    execution: "none";
  }>;
}>;

type AllMethodsReceipt = Readonly<{
  schemaVersion: "lcx_finance_strategy_all_methods_v1";
  status: "completed";
  boundary: "research_only_no_execution";
  runAt: string;
  methodCount: number;
  methods: readonly MethodReceipt[];
  checks: Readonly<{
    completeCatalog: boolean;
    everyMethodHasEvidence: boolean;
    everyMethodHasSourceReceipt: boolean;
    everyMethodHasExplicitGate: boolean;
    noProfitClaim: true;
    noModelLearningClaim: true;
    executionAuthority: "none";
  }>;
}>;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const EXTERNAL_ROOT =
  process.env.LCX_TRADER_STRATEGY_RESEARCH_ROOT ??
  path.resolve(REPO_ROOT, "../../.codex/research/trader-strategies-20260909");

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

async function readJson(filePath: string): Promise<JsonObject> {
  return asObject(JSON.parse(await fs.readFile(filePath, "utf8")), filePath);
}

function requiredObject(value: unknown, label: string): JsonObject {
  return asObject(value, label);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function sourceGroupReady(receipts: JsonObject): boolean {
  const rows = Object.values(receipts);
  return (
    rows.length > 0 &&
    rows.every(
      (receipt) =>
        typeof receipt === "object" &&
        receipt !== null &&
        Number((receipt as JsonObject).http_status) === 200,
    )
  );
}

function artifactLabel(filePath: string): string {
  if (path.resolve(filePath).startsWith(`${EXTERNAL_ROOT}${path.sep}`)) {
    return `external-research/${path.relative(EXTERNAL_ROOT, filePath)}`;
  }
  return path.relative(REPO_ROOT, filePath) || filePath;
}

function methodName(method: StrategyMethodId): string {
  return FINANCE_STRATEGY_METHODS.find((item) => item.id === method)?.name ?? method;
}

function sourceWindow(value: unknown, fallback: string): string {
  const sample = typeof value === "object" && value !== null ? (value as JsonObject).sample : null;
  if (typeof sample === "object" && sample !== null) {
    const start = (sample as JsonObject).start;
    const end = (sample as JsonObject).end;
    if (typeof start === "string" && typeof end === "string") {
      return `${start}..${end}`;
    }
  }
  return fallback;
}

function checkBooleans(value: unknown, label: string): boolean {
  const checks = requiredObject(value, label);
  const values = Object.entries(checks)
    .filter(([, item]) => typeof item === "boolean")
    .map(([, item]) => item);
  if (values.length === 0) {
    throw new Error(`${label} must contain boolean checks`);
  }
  return values.every(Boolean);
}

function methodReceipt(
  method: StrategyMethodId,
  evidenceType: MethodReceipt["evidenceType"],
  sourceWindowValue: string,
  sourceArtifacts: readonly string[],
  sourceKinds: readonly string[],
  sourceStage: string,
  sourceReceiptsReady: boolean,
  checksPass: boolean,
  gateStatus: string,
  result: JsonObject,
): MethodReceipt {
  if (!gateStatus) {
    throw new Error(`${method} must have an explicit gate status`);
  }
  return Object.freeze({
    method,
    name: methodName(method),
    evidenceType,
    sourceWindow: sourceWindowValue,
    sourceArtifacts: Object.freeze([...sourceArtifacts]),
    sourceKinds: Object.freeze([...sourceKinds]),
    sourceReceiptsReady,
    sourceStage,
    assessment: "research_only",
    gateStatus,
    checksPass,
    result,
    claims: Object.freeze({
      profit: "not_claimed",
      modelLearning: "not_claimed",
      execution: "none",
    }),
  });
}

function getMediumRows(value: unknown, label: string): JsonObject[] {
  const root = requiredObject(value, label);
  const rows = root.results;
  if (!Array.isArray(rows)) {
    throw new Error(`${label}.results must be an array`);
  }
  return rows
    .filter(
      (row): row is JsonObject => typeof row === "object" && row !== null && !Array.isArray(row),
    )
    .filter(
      (row) => requiredObject(row.cost_assumption, `${label}.cost_assumption`).label === "medium",
    );
}

function buildMethods(
  benchmark: JsonObject,
  stress: JsonObject,
  strategyManifest: JsonObject,
  m02: JsonObject,
  m05: JsonObject,
  m06: JsonObject,
  m07: JsonObject,
  realSummary: JsonObject,
  realResults: Readonly<Record<string, JsonObject>>,
): readonly MethodReceipt[] {
  const benchmarkChecks = requiredObject(benchmark.checks, "benchmark.checks");
  const benchmarkPortfolio = requiredObject(benchmark.portfolio, "benchmark.portfolio");
  const benchmarkData = requiredObject(benchmark.data, "benchmark.data");
  const stressSummary = requiredObject(
    requiredObject(stress.stressMatrix, "stress.stressMatrix").summary,
    "stress summary",
  );
  const strategyManifestReceipts = requiredObject(
    strategyManifest.source_receipts,
    "strategy manifest source_receipts",
  );
  const strategySourcesReady = sourceGroupReady(strategyManifestReceipts);
  const localSources = benchmarkData.sourceReceipts;
  const localSourcesReady =
    Array.isArray(localSources) &&
    localSources.length > 0 &&
    localSources.every(
      (receipt) =>
        typeof receipt === "object" &&
        receipt !== null &&
        (receipt as JsonObject).status === "ready",
    );
  const realSources = requiredObject(realSummary.sources, "real_market_summary.sources");
  const realYahooSources = requiredObject(
    realSources.yahoo_symbols,
    "real_market_summary.sources.yahoo_symbols",
  );
  const realYahooReady = sourceGroupReady(realYahooSources);
  const cboeSource = requiredObject(realSources.cboe, "real_market_summary.sources.cboe");
  const cboeReady = Number(cboeSource.http_status) === 200;
  const eventSources = requiredObject(
    realSources.event_sources,
    "real_market_summary.sources.event_sources",
  );
  const eventSourcesReady = sourceGroupReady(eventSources);
  const realSummaryTests = realSummary.tests;
  if (!Array.isArray(realSummaryTests)) {
    throw new Error("real_market_summary.tests must be an array");
  }

  const localBenchmark = artifactLabel(
    path.join(REPO_ROOT, ".artifacts/finance-strategy/benchmark-20260910.json"),
  );
  const localStress = artifactLabel(
    path.join(REPO_ROOT, ".artifacts/finance-strategy/stress-matrix-12us-20260910.json"),
  );
  const external = (name: string) => path.join(EXTERNAL_ROOT, name);

  const m02Portfolio = requiredObject(
    benchmarkPortfolio.trend_breadth_gate,
    "benchmark trend_breadth_gate",
  );
  const m02Base = requiredObject(benchmarkPortfolio.buy_hold, "benchmark buy_hold");
  const m02Stress = {
    variantCount: stressSummary.variantCount,
    cagrOutperformanceCount: stressSummary.cagrOutperformanceCount,
    drawdownImprovementCount: stressSummary.drawdownImprovementCount,
    bothCagrAndDrawdownCount: stressSummary.bothCagrAndDrawdownCount,
    medianCagrDeltaPp: stressSummary.medianCagrDeltaPp,
  };

  const m05Medium = getMediumRows(m05, "m05_results");
  const m06Medium = getMediumRows(m06, "m06_results");
  const m07Rows = m07.results;
  if (!Array.isArray(m07Rows)) {
    throw new Error("m07_diagnostic.results must be an array");
  }
  const real = (method: string) => requiredObject(realResults[method], `real_market/${method}`);
  const realTest = (method: string) => {
    const row = realSummaryTests.find(
      (item) => typeof item === "object" && item !== null && (item as JsonObject).module === method,
    );
    return row ? requiredObject(row, `real_market_summary.tests.${method}`) : undefined;
  };
  const realGate = (method: string) =>
    requiredText(
      realTest(method)?.gate_status ?? real(method).gate_status ?? "unknown",
      `${method}.gate_status`,
    );
  const m09Events = real("M09").events;

  const receipts: MethodReceipt[] = [
    methodReceipt(
      "M01",
      "real_market_contract",
      `${requiredText(benchmarkData.fromDate, "benchmarkData.fromDate")}..${requiredText(benchmarkData.toDate, "benchmarkData.toDate")}`,
      [localBenchmark],
      [requiredText(benchmarkData.source, "benchmarkData.source")],
      "completed",
      localSourcesReady,
      checkBooleans(benchmarkChecks, "benchmark.checks"),
      "research_only_quality_gate",
      {
        alignedObservations: benchmarkData.alignedObservations,
        sourceAsOf: benchmarkData.asOf,
        requiredOutputChecks: "source, timestamp, baseline, cost, periods, uncertainty, boundary",
      },
    ),
    methodReceipt(
      "M02",
      "real_market_backtest",
      `${requiredText(benchmarkData.fromDate, "benchmarkData.fromDate")}..${requiredText(benchmarkData.toDate, "benchmarkData.toDate")}`,
      [localBenchmark, localStress, artifactLabel(external("experiments/m02_results.json"))],
      [requiredText(benchmarkData.source, "benchmarkData.source"), "Yahoo Finance chart API"],
      "research_candidate",
      localSourcesReady && strategySourcesReady,
      checkBooleans(benchmarkChecks, "benchmark.checks") &&
        Number(stressSummary.variantCount) === 48,
      "research_only_no_outperformance",
      {
        baseline: requiredObject(m02Base.metric, "benchmark buy_hold.metric"),
        enriched: requiredObject(m02Portfolio.metric, "benchmark trend_breadth_gate.metric"),
        stress: m02Stress,
        historicalProxyRuns: m02.results,
      },
    ),
    methodReceipt(
      "M03",
      "real_market_diagnostic",
      sourceWindow(real("M03"), "2018-01-03..2026-09-08"),
      [
        artifactLabel(external("experiments/real_market/m03_real_market.json")),
        artifactLabel(external("experiments/real_market/real_market_summary.json")),
      ],
      ["Yahoo Finance chart API"],
      requiredText(real("M03").stage, "M03.stage"),
      realYahooReady,
      checkBooleans(real("M03").checks, "M03.checks"),
      realGate("M03"),
      {
        signalCount: real("M03").signal_count,
        activeSignalMetrics: real("M03").net_metrics_on_active_signals,
      },
    ),
    methodReceipt(
      "M04",
      "real_market_diagnostic",
      sourceWindow(real("M04"), "2018-02-28..2026-09-09"),
      [
        artifactLabel(external("experiments/real_market/m04_real_market.json")),
        artifactLabel(external("experiments/real_market/real_market_summary.json")),
      ],
      ["Yahoo Finance chart API"],
      requiredText(real("M04").stage, "M04.stage"),
      realYahooReady,
      checkBooleans(real("M04").checks, "M04.checks"),
      realGate("M04"),
      {
        trackingErrorRmseOos: real("M04").tracking_error_rmse_oos,
        regimeBreakRatio: real("M04").regime_break_ratio,
      },
    ),
    methodReceipt(
      "M05",
      "real_market_backtest",
      sourceWindow(m05, "2005-01-01..2026-09-09"),
      [
        artifactLabel(external("experiments/m05_results.json")),
        artifactLabel(external("experiments/manifest.json")),
      ],
      ["Yahoo Finance chart API"],
      requiredText(m05.stage, "m05.stage"),
      strategySourcesReady,
      m05Medium.length === 2 &&
        m05Medium.every(
          (row) => requiredObject(row.long_short, "M05.long_short").metrics !== undefined,
        ),
      "research_only_negative_or_unstable_delta",
      {
        mediumCost: m05Medium.map((row) => ({
          lookbackMonths: row.lookback_months,
          delta: row.delta_vs_long_only,
          metrics: requiredObject(row.long_short, "M05.long_short").metrics,
        })),
      },
    ),
    methodReceipt(
      "M06",
      "real_market_backtest",
      sourceWindow(m06, "2005-01-01..2026-09-09"),
      [
        artifactLabel(external("experiments/m06_results.json")),
        artifactLabel(external("experiments/manifest.json")),
      ],
      ["Yahoo Finance chart API"],
      requiredText(m06.stage, "m06.stage"),
      strategySourcesReady,
      m06Medium.length === 2 &&
        m06Medium.every((row) => requiredObject(row, "M06.row").metrics !== undefined),
      "research_only_high_turnover_and_drawdown",
      {
        mediumCost: m06Medium.map((row) => ({
          lookbackDays: row.lookback_days,
          metrics: row.metrics,
        })),
      },
    ),
    methodReceipt(
      "M07",
      "real_market_diagnostic",
      sourceWindow(m07, "2005-01-01..2026-09-09"),
      [
        artifactLabel(external("experiments/m07_diagnostic.json")),
        artifactLabel(external("experiments/manifest.json")),
      ],
      ["Yahoo Finance chart API"],
      requiredText(m07.stage, "m07.stage"),
      strategySourcesReady,
      m07Rows.length === 18,
      requiredText(m07.gate_status, "m07.gate_status"),
      {
        rows: m07Rows.length,
        maximumSignalObservations: Math.max(
          ...m07Rows.map((row) => Number((row as JsonObject).signal_observations ?? 0)),
        ),
      },
    ),
    methodReceipt(
      "M08",
      "real_market_diagnostic",
      sourceWindow(real("M08"), "2018-01-03..2026-09-09"),
      [
        artifactLabel(external("experiments/real_market/m08_real_market.json")),
        artifactLabel(external("experiments/real_market/real_market_summary.json")),
      ],
      ["Yahoo Finance chart API"],
      requiredText(real("M08").stage, "M08.stage"),
      realYahooReady,
      checkBooleans(real("M08").checks, "M08.checks"),
      realGate("M08"),
      { netMetrics: real("M08").net_metrics, stress: real("M08").credit_relative_stress },
    ),
    methodReceipt(
      "M09",
      "real_market_diagnostic",
      "2025-03-07..2026-06-22 announced events",
      [
        artifactLabel(external("experiments/real_market/m09_real_market.json")),
        artifactLabel(external("experiments/real_market/real_market_summary.json")),
      ],
      ["S&P Global official announcements", "Yahoo Finance chart API"],
      requiredText(real("M09").stage, "M09.stage"),
      realYahooReady && eventSourcesReady,
      checkBooleans(real("M09").checks, "M09.checks"),
      realGate("M09"),
      { eventCount: Array.isArray(m09Events) ? m09Events.length : 0 },
    ),
    methodReceipt(
      "M10",
      "real_market_diagnostic",
      requiredText(real("M10").quote_timestamp ?? "2026-09-10 snapshot", "M10.quote_timestamp"),
      [
        artifactLabel(external("experiments/real_market/m10_real_market.json")),
        artifactLabel(external("experiments/real_market/real_market_summary.json")),
      ],
      ["Cboe delayed options quote API"],
      requiredText(real("M10").stage, "M10.stage"),
      cboeReady,
      checkBooleans(real("M10").checks, "M10.checks"),
      realGate("M10"),
      { put: real("M10").put, scenarios: real("M10").scenarios },
    ),
    methodReceipt(
      "M11",
      "real_market_diagnostic",
      requiredText(real("M11").quote_timestamp ?? "2026-09-10 snapshot", "M11.quote_timestamp"),
      [
        artifactLabel(external("experiments/real_market/m11_real_market.json")),
        artifactLabel(external("experiments/real_market/real_market_summary.json")),
      ],
      ["Cboe delayed options quote API"],
      requiredText(real("M11").stage, "M11.stage"),
      cboeReady,
      checkBooleans(real("M11").checks, "M11.checks"),
      realGate("M11"),
      {
        contractPair: real("M11").contract_pair,
        greeks: real("M11").greeks_sum,
        scenarios: real("M11").scenarios,
      },
    ),
    methodReceipt(
      "M12",
      "real_market_backtest",
      `${requiredText(benchmarkData.fromDate, "benchmarkData.fromDate")}..${requiredText(benchmarkData.toDate, "benchmarkData.toDate")}`,
      [localBenchmark, localStress],
      [requiredText(benchmarkData.source, "benchmarkData.source")],
      "research_candidate",
      localSourcesReady,
      checkBooleans(benchmarkChecks, "benchmark.checks") &&
        Boolean(benchmarkChecks.commonExposureBreadthGate),
      "research_only_drawdown_tradeoff_without_alpha",
      {
        baseline: requiredObject(m02Base.metric, "benchmark buy_hold.metric"),
        breadthGate: requiredObject(m02Portfolio.metric, "benchmark trend_breadth_gate.metric"),
        stress: m02Stress,
      },
    ),
  ];
  const ids = receipts.map((item) => item.method);
  if (ids.length !== STRATEGY_METHOD_IDS.length || new Set(ids).size !== ids.length) {
    throw new Error(`method coverage mismatch: ${ids.join(",")}`);
  }
  return Object.freeze(receipts);
}

export async function buildAllMethodsReceipt(): Promise<AllMethodsReceipt> {
  const benchmarkPath = path.join(REPO_ROOT, ".artifacts/finance-strategy/benchmark-20260910.json");
  const stressPath = path.join(
    REPO_ROOT,
    ".artifacts/finance-strategy/stress-matrix-12us-20260910.json",
  );
  const strategyManifestPath = path.join(EXTERNAL_ROOT, "experiments/manifest.json");
  const [benchmark, stress, strategyManifest, m02, m05, m06, m07, realSummary, ...realResults] =
    await Promise.all([
      readJson(benchmarkPath),
      readJson(stressPath),
      readJson(strategyManifestPath),
      readJson(path.join(EXTERNAL_ROOT, "experiments/m02_results.json")),
      readJson(path.join(EXTERNAL_ROOT, "experiments/m05_results.json")),
      readJson(path.join(EXTERNAL_ROOT, "experiments/m06_results.json")),
      readJson(path.join(EXTERNAL_ROOT, "experiments/m07_diagnostic.json")),
      readJson(path.join(EXTERNAL_ROOT, "experiments/real_market/real_market_summary.json")),
      ...STRATEGY_METHOD_IDS.filter((id) =>
        ["M03", "M04", "M08", "M09", "M10", "M11"].includes(id),
      ).map((id) =>
        readJson(
          path.join(EXTERNAL_ROOT, `experiments/real_market/${id.toLowerCase()}_real_market.json`),
        ),
      ),
    ]);
  const realById = Object.fromEntries(
    ["M03", "M04", "M08", "M09", "M10", "M11"].map((id, index) => [id, realResults[index]]),
  );
  const methods = buildMethods(
    benchmark,
    stress,
    strategyManifest,
    m02,
    m05,
    m06,
    m07,
    realSummary,
    realById,
  );
  const checks = Object.freeze({
    completeCatalog:
      methods.length === STRATEGY_METHOD_IDS.length &&
      methods.every((item, index) => item.method === STRATEGY_METHOD_IDS[index]),
    everyMethodHasEvidence: methods.every((item) => item.checksPass),
    everyMethodHasSourceReceipt: methods.every(
      (item) => item.sourceReceiptsReady && item.sourceArtifacts.length > 0,
    ),
    everyMethodHasExplicitGate: methods.every((item) => item.gateStatus.length > 0),
    noProfitClaim: true as const,
    noModelLearningClaim: true as const,
    executionAuthority: "none" as const,
  });
  if (
    !checks.completeCatalog ||
    !checks.everyMethodHasEvidence ||
    !checks.everyMethodHasSourceReceipt ||
    !checks.everyMethodHasExplicitGate
  ) {
    throw new Error(`all-method contract failed: ${JSON.stringify(checks)}`);
  }
  return Object.freeze({
    schemaVersion: "lcx_finance_strategy_all_methods_v1",
    status: "completed",
    boundary: "research_only_no_execution",
    runAt: new Date().toISOString(),
    methodCount: methods.length,
    methods,
    checks,
  });
}

function parseOutputPath(args: readonly string[]): string | undefined {
  if (args.length === 0) {
    return undefined;
  }
  if (args.length !== 2 || args[0] !== "--out" || !args[1]?.trim() || args[1].startsWith("--")) {
    throw new Error(
      "Usage: finance-strategy-all-methods [--out PATH]; default writes JSON to stdout only",
    );
  }
  return path.resolve(args[1]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  Promise.resolve()
    .then(async () => {
      const outputPath = parseOutputPath(process.argv.slice(2));
      const receipt = await buildAllMethodsReceipt();
      const json = `${JSON.stringify(receipt, null, 2)}\n`;
      if (outputPath) {
        await fs.writeFile(outputPath, json, "utf8");
      }
      process.stdout.write(
        outputPath
          ? `all_method_receipt_ok methods=${receipt.methodCount} output=${outputPath}\n`
          : json,
      );
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `all_method_receipt_blocked: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

export const __test = { buildMethods, requiredText, sourceGroupReady, parseOutputPath };
