/**
 * One research turn that the model can actually reason over.
 *
 * The previous turn asked the model for a conclusion and gave it only a list of
 * source names. It correctly answered `hold`, because it had nothing to read.
 * That is the right answer to the wrong question: a model asked to judge without
 * material will either refuse or invent.
 *
 * So this gathers the evidence first with the adapters already proven in this
 * repo, puts the actual numbers in the prompt, and only then asks for a
 * conclusion that cites those sources. The model's job is interpretation, not
 * data retrieval, and every number it sees came from a named source it must cite.
 *
 * Chain: gather -> prompt -> model -> extract -> intake -> compile -> mandate.
 * It places nothing; it reports the verdict and the reasons.
 *
 * Usage:
 *   node --import tsx scripts/operator/lcx-finance-research-turn.ts \
 *     --instrument AAPL --equity 100000 --run-authorization ID [--json]
 */

import { computeChartStructure } from "../../src/agents/finance-chart-structure.js";
import { parseResearchConclusion } from "../../src/agents/finance-conclusion-intake.js";
import { resolveFinanceCredentialEnv } from "../../src/agents/finance-credential-env.js";
import { createFmpFreeBasicEodCollectionAdapter } from "../../src/agents/finance-free-market-collection-adapters.js";
import { compileExecutionIntent } from "../../src/agents/finance-intent-compiler.js";
import {
  classifyFinanceStrategy,
  evaluateFinanceMandate,
} from "../../src/agents/finance-mandate.js";
import {
  createSecFilingsCollectionAdapter,
  runFinanceMarketCollectionRefresh,
} from "../../src/agents/finance-market-collection-registry.js";
import { createRegisteredCapabilityAdapters } from "../../src/agents/finance-registered-capability-adapters.js";
import {
  buildFinanceConclusionPrompt,
  extractFinanceConclusionJson,
} from "../../src/agents/finance-research-conclusion-prompt.js";
import { createFinanceUncachedFetch } from "../../src/agents/finance-write-transport.js";

type Evidence = { sourceId: string; description: string; detail: string };

function readArg(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const instrument = (readArg(args, "--instrument") ?? "AAPL").toUpperCase();
  const equity = Number(readArg(args, "--equity") ?? 100_000);
  const authorization = readArg(args, "--run-authorization") ?? "";

  const env = resolveFinanceCredentialEnv(process.env) as Record<string, unknown>;
  const fmpKey = typeof env.FMP_API_KEY === "string" ? env.FMP_API_KEY : "";
  const avKey = typeof env.ALPHA_VANTAGE_API_KEY === "string" ? env.ALPHA_VANTAGE_API_KEY : "";
  const now = new Date().toISOString();
  const evidence: Evidence[] = [];
  let lastPrice = 0;

  // Gather 1: price structure from full OHLCV.
  try {
    const result = await runFinanceMarketCollectionRefresh({
      request: {
        collection: "eod_history",
        instrument,
        assetClass: "us_equity",
        asOf: now,
        limit: 250,
        fromDate: new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10),
        toDate: now.slice(0, 10),
      } as never,
      adapters: [createFmpFreeBasicEodCollectionAdapter({ apiKey: fmpKey })],
    });
    const rows = (result.records ?? [])
      .map(
        (r) =>
          ((r as { data?: Record<string, unknown> }).data ?? {}) as Record<string, number | string>,
      )
      .filter((row) => Number(row.close) > 0 && typeof row.date === "string")
      .toSorted((a, b) => String(a.date).localeCompare(String(b.date)));
    const closes = rows.map((row) => Number(row.close));
    const volumes = rows.map((row) => Number(row.volume ?? 0));
    lastPrice = closes[closes.length - 1] ?? 0;
    const structure = computeChartStructure(closes);
    if (structure) {
      const recentVolume = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
      const priorVolume = volumes.slice(-20, -10).reduce((a, b) => a + b, 0) / 10;
      const ratio = priorVolume > 0 ? recentVolume / priorVolume : 1;
      evidence.push({
        sourceId: "fmp-eod-structure",
        description: "price structure from daily OHLCV",
        detail:
          "last=" +
          structure.lastPrice.toFixed(2) +
          " trend=" +
          structure.trend +
          " momentum=" +
          (structure.momentumPct * 100).toFixed(2) +
          "%" +
          " realisedVol=" +
          (structure.realizedVolFraction * 100).toFixed(1) +
          "%" +
          " volumeRatio=" +
          ratio.toFixed(2),
      });
    }
  } catch (error) {
    process.stderr.write("gather eod failed: " + String(error).slice(0, 100) + "\n");
  }

  // Gather 2: news sentiment.
  try {
    const fetchImpl = createFinanceUncachedFetch();
    const url =
      "https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=" +
      encodeURIComponent(instrument) +
      "&limit=50&apikey=" +
      encodeURIComponent(avKey);
    const response = await fetchImpl(url, { headers: {} });
    const payload = JSON.parse(response.body) as {
      feed?: Array<{
        overall_sentiment_score?: number;
        ticker_sentiment?: Array<{ ticker?: string; ticker_sentiment_score?: string }>;
      }>;
    };
    const scores: number[] = [];
    for (const item of Array.isArray(payload.feed) ? payload.feed : []) {
      const match = (item.ticker_sentiment ?? []).find((e) => e.ticker === instrument);
      const raw = Number(match?.ticker_sentiment_score ?? item.overall_sentiment_score);
      if (Number.isFinite(raw)) {
        scores.push(raw);
      }
    }
    if (scores.length > 0) {
      const average = scores.reduce((a, b) => a + b, 0) / scores.length;
      evidence.push({
        sourceId: "alpha-vantage-news-sentiment",
        description: "aggregated news sentiment",
        detail: "meanScore=" + average.toFixed(4) + " articles=" + scores.length,
      });
    }
  } catch (error) {
    process.stderr.write("gather sentiment failed: " + String(error).slice(0, 100) + "\n");
  }

  // Gather 3: analyst consensus target.
  try {
    const adapters = createRegisteredCapabilityAdapters({ fmpApiKey: fmpKey });
    const result = await runFinanceMarketCollectionRefresh({
      request: {
        collection: "analyst_estimates",
        instrument,
        assetClass: "us_equity",
        asOf: now,
        limit: 3,
      } as never,
      adapters: adapters.filter((a) => a.id === "fmp_price_target_summary"),
    });
    const first = (result.records ?? [])[0] as
      | { data?: Record<string, number | string> }
      | undefined;
    const data = first?.data ?? {};
    if (Number(data.lastMonthAvgPriceTarget) > 0) {
      evidence.push({
        sourceId: "fmp-analyst",
        description: "analyst consensus price target",
        detail:
          "lastMonthTarget=" +
          Number(data.lastMonthAvgPriceTarget).toFixed(2) +
          " analysts=" +
          String(data.lastMonthCount ?? 0) +
          (lastPrice > 0
            ? " vs price " +
              lastPrice.toFixed(2) +
              " (" +
              (((Number(data.lastMonthAvgPriceTarget) - lastPrice) / lastPrice) * 100).toFixed(2) +
              "%)"
            : ""),
      });
    }
  } catch (error) {
    process.stderr.write("gather target failed: " + String(error).slice(0, 100) + "\n");
  }

  // Gather 4: filings.
  try {
    const result = await runFinanceMarketCollectionRefresh({
      request: {
        collection: "sec_filings",
        instrument,
        assetClass: "us_equity",
        asOf: now,
        limit: 5,
      } as never,
      adapters: [createSecFilingsCollectionAdapter({})],
    });
    const forms = (result.records ?? []).map((r) => {
      const data = (r as { data?: Record<string, unknown> }).data ?? {};
      return typeof data.form === "string" ? data.form : "";
    });
    if (forms.length > 0) {
      evidence.push({
        sourceId: "sec-edgar",
        description: "recent SEC filings",
        detail: "forms=" + forms.join(","),
      });
    }
  } catch (error) {
    process.stderr.write("gather filings failed: " + String(error).slice(0, 100) + "\n");
  }

  process.stdout.write("=== evidence gathered ===\n");
  for (const item of evidence) {
    process.stdout.write(" " + item.sourceId + ": " + item.detail + "\n");
  }

  if (evidence.length < 2) {
    process.stdout.write(
      "\nRESULT: fewer than two sources returned data; not asking the model to judge.\n",
    );
    return;
  }

  const prompt =
    buildFinanceConclusionPrompt({
      instrument,
      assetClass: "us_equity",
      availableSources: evidence.map((e) => ({ sourceId: e.sourceId, description: e.description })),
      question:
        "Given the evidence below, is there a directional view for the next 30 days?\n\n" +
        evidence.map((e) => "- " + e.sourceId + ": " + e.detail).join("\n"),
      horizonDays: 30,
    }) + "\n\nReply with the JSON object only.";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 170_000);
  const response = await fetch("http://127.0.0.1:8788/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify({ message: prompt, timeoutSeconds: 150 }),
  });
  clearTimeout(timer);
  const raw = await response.text();
  let answer = raw;
  try {
    const parsed = JSON.parse(raw) as { payloads?: Array<{ text?: string }> };
    const first = parsed.payloads?.[0]?.text;
    if (typeof first === "string") {
      answer = first;
    }
  } catch {
    // keep the raw body
  }

  const extracted = extractFinanceConclusionJson(answer);
  if (extracted === null) {
    process.stdout.write("\nRESULT: model produced no machine-readable conclusion\n");
    return;
  }
  process.stdout.write("\n=== model conclusion ===\n" + JSON.stringify(extracted) + "\n");

  const intake = parseResearchConclusion(extracted);
  if (!intake.ok) {
    process.stdout.write(
      "\n=== intake ===\n" +
        JSON.stringify({ ok: false, refusals: intake.refusals }, null, 2) +
        "\n",
    );
    return;
  }

  const strategyClass = classifyFinanceStrategy({ assetClass: intake.conclusion.assetClass });
  const compiled = compileExecutionIntent({
    conclusion: intake.conclusion,
    market: { referencePrice: lastPrice, referencePriceAt: now },
    equity,
    runAuthorizationId: authorization,
    ...(strategyClass !== "unknown" ? { strategyClass } : {}),
  });
  if (!compiled.ok) {
    process.stdout.write(
      "\n=== compile ===\n" +
        JSON.stringify({ ok: false, refusals: compiled.refusals }, null, 2) +
        "\n",
    );
    return;
  }

  const stopDistance =
    intake.conclusion.invalidationPrice === undefined
      ? lastPrice
      : Math.abs(lastPrice - intake.conclusion.invalidationPrice);
  const mandate = evaluateFinanceMandate({
    strategy: { assetClass: intake.conclusion.assetClass },
    riskFractionOfEquity: (compiled.intent.quantity * stopDistance) / equity,
    drawdownFraction: 0,
    stopLossDefined: intake.conclusion.invalidationPrice !== undefined,
    hasSignificantAutocorrelation: true,
  });

  process.stdout.write(
    "\n=== mandate ===\n" +
      JSON.stringify(
        {
          ok: mandate.verdict === "pass",
          strategyClass,
          verdict: mandate.verdict,
          reasons: mandate.reasons,
          intent: mandate.verdict === "pass" ? compiled.intent : undefined,
        },
        null,
        2,
      ) +
      "\n",
  );
}

await main();
