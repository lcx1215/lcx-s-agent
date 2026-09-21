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

import { existsSync, readFileSync } from "node:fs";
import { fetchAlpacaVenueState } from "../../src/agents/finance-alpaca-run.js";
import { computeChartStructure } from "../../src/agents/finance-chart-structure.js";
import { parseResearchConclusion } from "../../src/agents/finance-conclusion-intake.js";
import { resolveFinanceCredentialEnv } from "../../src/agents/finance-credential-env.js";
import {
  defaultEvidenceWindow,
  parseAvPublishedAgeDays,
  summarizeNewsCohort,
  type NewsItem,
} from "../../src/agents/finance-evidence-window.js";
import { createFmpFreeBasicEodCollectionAdapter } from "../../src/agents/finance-free-market-collection-adapters.js";
import { insiderFlowSignal } from "../../src/agents/finance-insider-signal.js";
import { compileExecutionIntent } from "../../src/agents/finance-intent-compiler.js";
import {
  classifyFinanceStrategy,
  evaluateFinanceMandate,
} from "../../src/agents/finance-mandate.js";
import {
  createFinanceMarketCollectionRegistry,
  createSecFilingsCollectionAdapter,
  runFinanceMarketCollectionRefresh,
} from "../../src/agents/finance-market-collection-registry.js";
import {
  buildReflection,
  renderReflection,
  type ScoredSample,
} from "../../src/agents/finance-reflection.js";
import { createRegisteredCapabilityAdapters } from "../../src/agents/finance-registered-capability-adapters.js";
import {
  buildFinanceConclusionPrompt,
  extractFinanceConclusionJson,
} from "../../src/agents/finance-research-conclusion-prompt.js";
import {
  financeResearchScoredPath,
  resolveFinanceStateDir,
} from "../../src/agents/finance-state-dir.js";
import { createFinanceUncachedFetch } from "../../src/agents/finance-write-transport.js";

type Evidence = { sourceId: string; description: string; detail: string };

function readArg(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function readScored(path: string): ScoredSample[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ScoredSample];
      } catch {
        return [];
      }
    });
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
  const window = defaultEvidenceWindow({ horizonDays: 30 });
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
        time_published?: unknown;
      }>;
    };
    const asOfMs = Date.parse(now);
    const cohortItems: NewsItem[] = [];
    for (const item of Array.isArray(payload.feed) ? payload.feed : []) {
      const match = (item.ticker_sentiment ?? []).find((e) => e.ticker === instrument);
      const raw = Number(match?.ticker_sentiment_score ?? item.overall_sentiment_score);
      // Articles with no usable timestamp are dropped, not treated as fresh.
      const ageDays = parseAvPublishedAgeDays(item.time_published, asOfMs);
      if (Number.isFinite(raw) && ageDays !== null) {
        cohortItems.push({ ageDays, score: raw });
      }
    }
    const cohort = summarizeNewsCohort(cohortItems, window);
    if (cohort.usable && cohort.weightedMean !== null) {
      evidence.push({
        sourceId: "alpha-vantage-news-sentiment",
        description: "news sentiment, recency weighted",
        detail:
          "weightedMean=" +
          cohort.weightedMean.toFixed(4) +
          " used=" +
          cohort.used +
          " spanDays=" +
          cohort.spanDays.toFixed(1) +
          " window=" +
          window.lookbackDays +
          "d" +
          " halfLife=" +
          window.newsHalfLifeDays +
          "d",
      });
    } else {
      process.stderr.write("sentiment unusable: " + cohort.refusals.join("; ") + "\n");
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

  // Gather 5: real insider sentiment, replacing any inference from form codes.
  try {
    const registry = createFinanceMarketCollectionRegistry({
      fmpApiKey: fmpKey,
      finnhubApiKey:
        avKey === ""
          ? ""
          : typeof (env as { FINNHUB_API_KEY?: unknown }).FINNHUB_API_KEY === "string"
            ? String((env as { FINNHUB_API_KEY?: unknown }).FINNHUB_API_KEY)
            : "",
    });
    const picks = (registry as unknown as ReadonlyArray<{ id: string }>).filter(
      (a) => a.id === "finnhub_stock_insider_transactions",
    );
    const result = await runFinanceMarketCollectionRefresh({
      request: {
        collection: "ownership",
        instrument,
        assetClass: "us_equity",
        asOf: now,
        limit: 6,
      } as never,
      adapters: picks as never,
    });
    const txs = (result.records ?? []).flatMap((r) => {
      const d = (r as { data?: Record<string, unknown> }).data ?? {};
      const when = d.transactionDate;
      const change = Number(d.change);
      if (typeof when !== "string" || !Number.isFinite(change) || change === 0) {
        return [];
      }
      return [
        {
          transactionDate: when,
          change,
          ...(typeof d.transactionCode === "string" ? { transactionCode: d.transactionCode } : {}),
        },
      ];
    });
    const signal = insiderFlowSignal(txs, { observedAt: now, window });
    evidence.push({
      sourceId: signal.sourceId,
      description: "open-market insider flow",
      detail:
        (signal.ref ?? "") +
        (signal.direction === "hold" ? " -> silent" : " -> " + signal.direction),
    });
  } catch (error) {
    process.stderr.write("gather insider failed: " + String(error).slice(0, 100) + "\n");
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

  // Show the model its own scored record before it judges again. Facts only -
  // it is told what happened, never how much to move its number.
  const scored = readScored(financeResearchScoredPath(resolveFinanceStateDir().directory));
  const reflection = [
    renderReflection(buildReflection(scored, { instrument })),
    "",
    renderReflection(buildReflection(scored)),
  ].join("\n");

  // What the book actually holds, before asking what to do with it.
  //
  // A person deciding whether to add to a position looks at the position first.
  // Asking for a directional view with no idea what is already held produces a
  // view that ignores it - the answer may be right about the instrument and
  // wrong about the portfolio.
  //
  // When the venue cannot be read this says so rather than assuming flat. An
  // assumed flat book and an unknown book are different, and only one of them
  // should lead to a decision.
  const venue = await fetchAlpacaVenueState({});
  const positionLine = venue.ok
    ? (() => {
        const held = venue.state.positions.get(instrument) ?? 0;
        const open = venue.state.openOrders.get(instrument) ?? 0;
        return (
          "Current book: holding " +
          held +
          " " +
          instrument +
          "; " +
          venue.state.positions.size +
          " position(s) open in total" +
          (open > 0 ? "; " + open + " unfilled order(s) already working on this instrument" : "") +
          ". Judge in the light of what is already held."
        );
      })()
    : "Current book: NOT READABLE (" +
      venue.reason +
      "). Judge without it, and do not assume the position is flat - an unknown " +
      "holding is not an empty one.";

  const prompt =
    buildFinanceConclusionPrompt({
      instrument,
      assetClass: "us_equity",
      availableSources: evidence.map((e) => ({ sourceId: e.sourceId, description: e.description })),
      question:
        positionLine +
        "\n\nGiven the evidence below, is there a directional view for the next 30 days?\n\n" +
        evidence.map((e) => "- " + e.sourceId + ": " + e.detail).join("\n") +
        "\n\n" +
        reflection,
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
