import type { ApiCallReceipt } from "../../src/agents/api-call-contract.ts";
import {
  fetchYahooQuote,
  type LiveMarketQuote,
} from "../../src/agents/finance-live-market-source.ts";
import {
  createGeospatialSourceRegistry,
  runGeospatialRefresh,
  type GeospatialRefreshReceipt,
} from "../../src/agents/geospatial-source-registry.ts";

type Source = "yahoo" | "open-meteo";

type Options = {
  source: Source;
  instrument: string;
  query: string;
  timeoutMs: number;
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
    source: "yahoo",
    instrument: "AAPL",
    query: "40.7128,-74.0060",
    timeoutMs: 15_000,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--source") {
      const value = readValue(args, index, arg);
      if (value !== "yahoo" && value !== "open-meteo") {
        throw new Error("--source must be yahoo or open-meteo");
      }
      options.source = value;
      index += 1;
    } else if (arg === "--instrument") {
      options.instrument = readValue(args, index, arg).toUpperCase();
      index += 1;
    } else if (arg === "--query") {
      options.query = readValue(args, index, arg);
      index += 1;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(readValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(
        "Usage: node --import tsx scripts/operator/lcx-api-live-smoke.ts [--json] [--source yahoo|open-meteo] [--instrument AAPL] [--query LAT,LON] [--timeout-ms N]",
      );
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function compactReceipt(receipt: ApiCallReceipt) {
  return {
    provider: receipt.provider,
    source: receipt.source,
    operation: receipt.operation,
    status: receipt.status,
    httpStatus: receipt.httpStatus,
    transportError: receipt.transportError,
    attempt: receipt.attempt,
    latencyMs: receipt.latencyMs,
    circuitState: receipt.circuitState,
    authScopeLabel: receipt.authScopeLabel,
    rateLimited: receipt.rateLimited,
    idempotencyKeyPresent: receipt.idempotencyKey !== undefined,
  };
}

function summarizeYahoo(quote: LiveMarketQuote, receipts: readonly ApiCallReceipt[]) {
  return {
    status: "succeeded" as const,
    data: {
      symbol: quote.symbol,
      currency: quote.currency,
      delayStatus: quote.delayStatus,
      quoteTimestamp: quote.quoteTimestamp,
      sourceUrlOrArtifact: quote.sourceUrlOrArtifact,
      valueObserved: true,
    },
    receipts: receipts.map(compactReceipt),
  };
}

function summarizeGeospatial(receipt: GeospatialRefreshReceipt) {
  const apiCalls = receipt.sourceAttempts.flatMap((attempt) => attempt.apiCalls ?? []);
  return {
    status:
      receipt.status === "ready"
        ? ("succeeded" as const)
        : receipt.status === "needs_review"
          ? ("needs_review" as const)
          : ("failed" as const),
    transportSucceeded: apiCalls.some((call) => call.status === "succeeded"),
    data: {
      selectedSourceIds: receipt.selectedSourceIds,
      fieldNames: receipt.normalizedFields.map((field) => field.name),
      sourceTimestamps: receipt.normalizedFields.map((field) => field.sourceTimestamp),
      valueObserved: receipt.normalizedFields.length > 0,
    },
    freshnessGatePassed: receipt.freshnessWarnings.length === 0,
    provenanceConflictGatePassed: receipt.conflicts.length === 0,
    readyGatePassed: receipt.status === "ready",
    sourceAttempts: receipt.sourceAttempts.map((attempt) => ({
      adapterId: attempt.adapterId,
      providerName: attempt.providerName,
      status: attempt.status,
      latencyMs: attempt.latencyMs,
      apiCalls: (attempt.apiCalls ?? []).map(compactReceipt),
    })),
    receipts: apiCalls.map(compactReceipt),
    conflicts: receipt.conflicts,
    missingEvidence: receipt.missingEvidence,
    freshnessWarnings: receipt.freshnessWarnings,
    staleSourceWarnings: receipt.staleSourceWarnings,
  };
}

/**
 * Failure shape emitted when the Yahoo probe throws. `summarizeYahoo` only ever describes a
 * success, so the failure branch is its own member of the `result` union instead of an
 * assertion onto the success type.
 */
type YahooSmokeFailure = {
  status: "failed";
  data: { valueObserved: false };
  receipts: ReturnType<typeof summarizeYahoo>["receipts"];
  error: string;
};

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const correlationId = `lcx-api-live-smoke:${options.source}:${Date.now()}`;
  const receipts: ApiCallReceipt[] = [];
  let result:
    | ReturnType<typeof summarizeYahoo>
    | ReturnType<typeof summarizeGeospatial>
    | YahooSmokeFailure;
  if (options.source === "yahoo") {
    try {
      const quote = await fetchYahooQuote(options.instrument, {
        timeoutMs: options.timeoutMs,
        correlationId,
        authScopeLabel: "public",
        idempotencyKey: `${correlationId}:read-only`,
        retry: { attempts: 1 },
        onReceipt: (receipt) => receipts.push(receipt),
      });
      result = summarizeYahoo(quote, receipts);
    } catch (error) {
      result = {
        status: "failed",
        data: { valueObserved: false },
        receipts: receipts.map(compactReceipt),
        error: error instanceof Error ? error.name : "source_error",
      };
    }
  } else {
    const refresh = await runGeospatialRefresh({
      request: {
        kind: "weather",
        query: options.query,
        asOf: new Date().toISOString(),
        freshnessMaxMinutes: 60,
      },
      adapters: createGeospatialSourceRegistry(),
      // Keep one global source plus one official cross-check so a cached or
      // lagging public feed cannot become the sole freshness authority.
      maxSources: 2,
      timeoutMs: options.timeoutMs,
      correlationId,
      retry: { attempts: 1 },
      authScopeLabel: "public",
      idempotencyKey: `${correlationId}:weather_refresh`,
    });
    result = summarizeGeospatial(refresh);
  }
  const payload = {
    schemaVersion: "lcx_live_api_smoke_v1",
    boundary: "research_only_read_only_api",
    source: options.source,
    correlationId,
    ...result,
    claims: {
      currentDataRequiresTimestamp: true,
      authScope: "public",
      externalSideEffects: false,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
    },
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `source=${options.source}`,
        `status=${result.status}`,
        `receipts=${result.receipts.length}`,
        `external_side_effects=false provider_config_touched=false`,
      ].join("\n") + "\n",
    );
  }
  return result.status === "succeeded" && result.receipts.length > 0 ? 0 : 2;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(
    `lcx live api smoke failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
