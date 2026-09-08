#!/usr/bin/env node

import {
  createApiSourceGovernanceRegistry,
  type ApiCallReceipt,
} from "../../src/agents/api-call-contract.ts";
import {
  createFinanceMarketCollectionRegistry,
  runFinanceMarketCollectionRefresh,
} from "../../src/agents/finance-market-collection-registry.ts";
import {
  createFinanceRealtimeSourceRegistry,
  runFinanceRealtimeRefresh,
  resolveFinanceRealtimeSourceRegistryOptionsFromEnv,
} from "../../src/agents/finance-realtime-source-registry.ts";
import {
  createGeospatialSourceRegistry,
  runGeospatialRefresh,
} from "../../src/agents/geospatial-source-registry.ts";

type LoadKind = "weather" | "finance" | "news";

type Options = Readonly<{
  live: boolean;
  json: boolean;
  kind: LoadKind;
  rounds: number;
  concurrency: number;
  minIntervalMs: number;
  timeoutMs: number;
  symbol: string;
  query: string;
}>;

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function positiveInteger(value: string | undefined, flag: string, fallback: number, max: number) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${flag} must be a positive integer <= ${max}`);
  }
  return parsed;
}

function parseArgs(args: readonly string[]): Options {
  const kind = valueAfter(args, "--kind") ?? "mixed";
  if (kind !== "weather" && kind !== "finance" && kind !== "news" && kind !== "mixed") {
    throw new Error("--kind must be weather, finance, news, or mixed");
  }
  const minIntervalMs = Number(valueAfter(args, "--min-interval-ms") ?? "1000");
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 250) {
    throw new Error("--min-interval-ms must be at least 250");
  }
  return {
    live: args.includes("--live"),
    json: args.includes("--json"),
    kind: kind === "mixed" ? "weather" : kind,
    rounds: positiveInteger(valueAfter(args, "--rounds"), "--rounds", 3, 20),
    concurrency: positiveInteger(valueAfter(args, "--concurrency"), "--concurrency", 2, 4),
    minIntervalMs,
    timeoutMs: positiveInteger(valueAfter(args, "--timeout-ms"), "--timeout-ms", 30_000, 120_000),
    symbol: (valueAfter(args, "--symbol") ?? "AAPL").toUpperCase(),
    query: valueAfter(args, "--query") ?? "40.7128,-74.0060",
  };
}

function compactCall(receipt: ApiCallReceipt) {
  return {
    source: receipt.source,
    operation: receipt.operation,
    status: receipt.status,
    httpStatus: receipt.httpStatus,
    transportError: receipt.transportError,
    attempt: receipt.attempt,
    throttleWaitMs: receipt.throttleWaitMs,
    circuitState: receipt.circuitState,
  };
}

function compactAttempts(
  attempts: readonly Readonly<{
    adapterId: string;
    status: string;
    error?: string;
    apiCalls?: readonly ApiCallReceipt[];
  }>[],
) {
  return attempts.map((attempt) => ({
    adapterId: attempt.adapterId,
    status: attempt.status,
    // Fixed source error labels only; no URL, body, credential, or exception text.
    error: attempt.error,
    apiCalls: (attempt.apiCalls ?? []).map(compactCall),
  }));
}

async function runRound(
  options: Options,
  round: number,
  governance: ReturnType<typeof createApiSourceGovernanceRegistry>,
  kind: LoadKind,
) {
  const correlationId = `lcx-api-load:${kind}:${round}:${Date.now()}`;
  if (kind === "weather") {
    const receipt = await runGeospatialRefresh({
      request: {
        kind: "weather",
        query: options.query,
        asOf: new Date().toISOString(),
        freshnessMaxMinutes: 60,
      },
      adapters: createGeospatialSourceRegistry(),
      maxSources: 2,
      timeoutMs: options.timeoutMs,
      correlationId,
      retry: { attempts: 1 },
      authScopeLabel: "public",
      idempotencyKey: `${correlationId}:weather`,
      sourceGovernance: governance,
    });
    return {
      kind,
      round,
      status: receipt.status,
      sourceAttempts: compactAttempts(receipt.sourceAttempts),
      conflicts: receipt.conflicts,
      freshnessWarnings: receipt.freshnessWarnings,
      staleSourceWarnings: receipt.staleSourceWarnings,
      provenanceConflictGatePassed: receipt.conflicts.length === 0,
      freshnessGatePassed: receipt.freshnessWarnings.length === 0,
      analysisEligible: receipt.status === "ready",
    };
  }
  if (kind === "finance") {
    const receipt = await runFinanceRealtimeRefresh({
      request: {
        instrument: options.symbol,
        assetClass: "us_equity",
        useCase: "bounded_high_frequency_research_simulation",
        asOf: new Date().toISOString(),
        freshnessMaxMinutes: 24 * 60,
        requireOfficialReference: false,
      },
      adapters: createFinanceRealtimeSourceRegistry(
        resolveFinanceRealtimeSourceRegistryOptionsFromEnv(),
      ),
      maxSources: 4,
      timeoutMs: options.timeoutMs,
      correlationId,
      retry: { attempts: 1 },
      sourceGovernance: governance,
    });
    return {
      kind,
      round,
      status: receipt.status,
      sourceAttempts: compactAttempts(receipt.sourceAttempts),
      freshnessWarnings: receipt.snapshot?.freshnessWarnings ?? [],
      missingEvidence: receipt.missingEvidence,
      analysisEligible: receipt.status === "ready",
    };
  }
  const receipt = await runFinanceMarketCollectionRefresh({
    request: {
      instrument: options.symbol,
      assetClass: "us_equity",
      collection: "news",
      asOf: new Date().toISOString(),
      limit: 10,
    },
    adapters: createFinanceMarketCollectionRegistry(),
    maxSources: 2,
    timeoutMs: options.timeoutMs,
    correlationId,
    retry: { attempts: 1 },
    sourceGovernance: governance,
  });
  return {
    kind,
    round,
    status: receipt.status,
    recordCount: receipt.records.length,
    sourceAttempts: compactAttempts(receipt.sourceAttempts),
    missingEvidence: receipt.missingEvidence,
    analysisEligible: receipt.status === "ready",
  };
}

async function runBounded<T>(
  jobs: readonly (() => Promise<T>)[],
  concurrency: number,
): Promise<T[]> {
  const results: T[] = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      const job = jobs[index];
      if (!job) {
        return;
      }
      results[index] = await job();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
  return results;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const kinds: readonly LoadKind[] =
    process.argv.includes("--kind") && valueAfter(process.argv.slice(2), "--kind") !== "mixed"
      ? [options.kind]
      : ["weather", "finance", "news"];
  if (!options.live) {
    process.stdout.write(
      [
        "lcx-api-load-smoke: dry mode; no network calls were made.",
        "Pass --live to run bounded public-source refreshes.",
        `default plan: rounds=${options.rounds} concurrency=${options.concurrency} minIntervalMs=${options.minIntervalMs}`,
        "Yahoo public endpoints are opt-in; 403 is classified and quarantined, never retried or sent to analysis.",
      ].join("\n") + "\n",
    );
    return 0;
  }

  const governance = createApiSourceGovernanceRegistry({
    minIntervalMs: options.minIntervalMs,
    maxConcurrent: 1,
    maxQueue: 128,
    failureThreshold: 2,
    resetAfterMs: 5 * 60_000,
  });
  const jobs = kinds.flatMap((kind) =>
    Array.from(
      { length: options.rounds },
      (_, index) => () => runRound(options, index + 1, governance, kind),
    ),
  );
  const results = await runBounded(jobs, options.concurrency);
  const forbiddenCalls = results
    .flatMap((result) => result.sourceAttempts)
    .flatMap((attempt) =>
      (attempt.apiCalls ?? []).filter((call) => call.transportError === "forbidden"),
    ).length;
  const eligibleResults = results.filter((result) => result.analysisEligible).length;
  const payload = {
    schemaVersion: "lcx_api_load_smoke_v1",
    boundary: "bounded_research_only_api_load",
    rounds: options.rounds,
    concurrency: options.concurrency,
    minIntervalMs: options.minIntervalMs,
    resultCount: results.length,
    eligibleResults,
    forbiddenCalls,
    visibleAnalysisPolicy: "exclude_forbidden_or_stale_selected_evidence",
    results,
    claims: {
      externalSideEffects: false,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
      tradingExecution: false,
      forbiddenCallsExcludedFromAnalysis: true,
    },
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `results=${results.length}`,
        `eligible_results=${eligibleResults}`,
        `forbidden_calls=${forbiddenCalls}`,
        `external_side_effects=false provider_config_touched=false`,
      ].join("\n") + "\n",
    );
  }
  return eligibleResults > 0 ? 0 : 2;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `lcx api load smoke failed: ${error instanceof Error ? error.message : "source_error"}\n`,
    );
    process.exitCode = 2;
  },
);
