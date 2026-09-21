import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
 * Shadow is the default. An injected controller may authorize the existing Alpaca paper seam.
 *
 * Usage:
 *   node --import tsx scripts/operator/lcx-finance-research-turn.ts \
 *     --instrument AAPL --equity 100000 --run-authorization ID [--json]
 */
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchAlpacaVenueState } from "../../src/agents/finance-alpaca-run.js";
import { computeChartStructure } from "../../src/agents/finance-chart-structure.js";
import { resolveFinanceCredentialEnv } from "../../src/agents/finance-credential-env.js";
import {
  defaultEvidenceWindow,
  parseAvPublishedAgeDays,
  summarizeNewsCohort,
  type NewsItem,
} from "../../src/agents/finance-evidence-window.js";
import { createFmpFreeBasicEodCollectionAdapter } from "../../src/agents/finance-free-market-collection-adapters.js";
import { insiderFlowSignal } from "../../src/agents/finance-insider-signal.js";
import { type FinanceRegime } from "../../src/agents/finance-mandate.js";
import {
  createFinanceMarketCollectionRegistry,
  createSecFilingsCollectionAdapter,
  runFinanceMarketCollectionRefresh,
} from "../../src/agents/finance-market-collection-registry.js";
import {
  readFinancePositionLedger,
  readFinanceAccountPositionLedger,
} from "../../src/agents/finance-position-ledger.js";
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
  runFinanceResearchExecutionBridge,
  recoverFinanceResearchHistory,
  buildFinanceResearchMathEvidence,
  type FinanceResearchDailyBars,
  type FinanceResearchEvidence,
  type FinanceResearchExecutionControl,
} from "../../src/agents/finance-research-execution-bridge.js";
import {
  financeResearchScoredPath,
  resolveFinanceStateDir,
} from "../../src/agents/finance-state-dir.js";
import { createFinanceUncachedFetch } from "../../src/agents/finance-write-transport.js";

type Evidence = FinanceResearchEvidence;
export type FinanceResearchTurnDependencies = Readonly<{
  gatherEvidence?: (request: {
    instrument: string;
    assetClass: "us_equity" | "crypto";
    asOf: string;
  }) => Promise<{
    evidence: readonly Evidence[];
    dailyBars?: FinanceResearchDailyBars;
    market: { referencePrice: number; referencePriceAt: string };
  }>;
  invokeModel?: (prompt: string) => Promise<string>;
  positionSummary?: string;
  reflection?: string;
  control?: FinanceResearchExecutionControl;
}>;

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

export async function runFinanceResearchTurn(
  args: readonly string[],
  deps: FinanceResearchTurnDependencies = {},
) {
  const instrument = (readArg(args, "--instrument") ?? "AAPL").toUpperCase();
  const assetClass = readArg(args, "--asset-class") ?? "us_equity";
  if (assetClass !== "us_equity" && assetClass !== "crypto") {
    throw new Error("--asset-class must be us_equity or crypto");
  }
  if (assetClass === "crypto" && !deps.gatherEvidence) {
    const blocked = {
      status: "blocked" as const,
      refusals: [
        "crypto research evidence provider unavailable; stock sources are not used for crypto",
      ],
    };
    process.stdout.write(JSON.stringify(blocked) + "\n");
    return blocked;
  }
  const equity = Number(readArg(args, "--equity") ?? 100_000);
  const authorization = readArg(args, "--run-authorization") ?? "";
  // Regime parity with the other conclusion path. A regime tightens the caps and
  // never widens them, so without this the same conclusion is judged under
  // looser rules here than there - a divergence nobody declared.
  const rawRegime = readArg(args, "--regime");
  const regime: FinanceRegime | undefined =
    rawRegime === "normal" || rawRegime === "risk_off" || rawRegime === "liquidity_tightening"
      ? rawRegime
      : undefined;
  // Recording what this path decided is the whole point of running it alongside
  // the mechanical one: a verdict that is only printed cannot be compared with
  // what the other path actually did.
  const write = args.includes("--write");
  const stateDirectory = deps.control?.stateDirectory ?? resolveFinanceStateDir().directory;
  const recordShadow = (record: Record<string, unknown>): void => {
    if (!write) {
      return;
    }
    const file = join(stateDirectory, "shadow-verdicts.jsonl");
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(record) + "\n");
    } catch (error) {
      process.stdout.write(
        "\nshadow record NOT written: " +
          (error instanceof Error ? error.message : String(error)) +
          "\n",
      );
    }
  };

  const now = new Date().toISOString();
  const evidence: Evidence[] = [];
  let lastPrice = 0;
  let lastPriceAt = "";
  if (deps.gatherEvidence) {
    const gathered = await deps.gatherEvidence({ instrument, assetClass, asOf: now });
    evidence.push(...gathered.evidence);
    if (gathered.dailyBars) {
      evidence.push(...buildFinanceResearchMathEvidence(gathered.dailyBars));
    }
    lastPrice = gathered.market.referencePrice;
    lastPriceAt = gathered.market.referencePriceAt;
  } else {
    const env = resolveFinanceCredentialEnv(process.env) as Record<string, unknown>;
    const fmpKey = typeof env.FMP_API_KEY === "string" ? env.FMP_API_KEY : "";
    const avKey = typeof env.ALPHA_VANTAGE_API_KEY === "string" ? env.ALPHA_VANTAGE_API_KEY : "";
    const window = defaultEvidenceWindow({ horizonDays: 30 });

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
            ((r as { data?: Record<string, unknown> }).data ?? {}) as Record<
              string,
              number | string
            >,
        )
        .filter((row) => Number(row.close) > 0 && typeof row.date === "string")
        .toSorted((a, b) => String(a.date).localeCompare(String(b.date)));
      evidence.push(
        ...buildFinanceResearchMathEvidence({
          sourceId: "fmp-native-daily-bars",
          sourceUrlOrArtifact: "provider:fmp/eod_history",
          periodsPerYear: 252,
          rows: rows.map((row) => ({ date: String(row.date), close: Number(row.close) })),
        }),
      );
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
          sourceUrlOrArtifact: "provider:fmp/eod_history",
          sourceTimestamp: String(rows.at(-1)?.date ?? ""),
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
          sourceUrlOrArtifact: "provider:alpha-vantage/NEWS_SENTIMENT",
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
          sourceUrlOrArtifact: "provider:fmp/price-target-summary",
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
                (((Number(data.lastMonthAvgPriceTarget) - lastPrice) / lastPrice) * 100).toFixed(
                  2,
                ) +
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
          sourceUrlOrArtifact: "provider:sec/filings",
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
            ...(typeof d.transactionCode === "string"
              ? { transactionCode: d.transactionCode }
              : {}),
          },
        ];
      });
      const signal = insiderFlowSignal(txs, { observedAt: now, window });
      evidence.push({
        sourceId: signal.sourceId,
        sourceUrlOrArtifact: "provider:finnhub/stock-insider-transactions",
        description: "open-market insider flow",
        detail:
          (signal.ref ?? "") +
          (signal.direction === "hold" ? " -> silent" : " -> " + signal.direction),
      });
    } catch (error) {
      process.stderr.write("gather insider failed: " + String(error).slice(0, 100) + "\n");
    }
  }

  process.stdout.write("=== evidence gathered ===\n");
  for (const item of evidence) {
    process.stdout.write(" " + item.sourceId + ": " + item.detail + "\n");
  }

  if (
    !evidence.some(
      (item) => item.sourceId.trim() && item.detail.trim() && item.sourceUrlOrArtifact.trim(),
    )
  ) {
    process.stdout.write(
      "\nRESULT: no valid source evidence returned data; not asking the model to judge.\n",
    );
    return;
  }

  if (deps.control?.mode === "alpaca_paper") {
    const recovery = await recoverFinanceResearchHistory(deps.control);
    if (!recovery.ok) {
      return {
        status: "blocked" as const,
        recovery,
        refusals: ["execution history recovery or account reconciliation required"],
      };
    }
  }
  let historicalBook: string;
  try {
    if (deps.control?.recovery) {
      const history = await readFinanceAccountPositionLedger(stateDirectory, deps.control.recovery);
      historicalBook =
        "Stored account-scoped history (recorded history only; missing is not broker flat): " +
        JSON.stringify({
          headRef: history.headRef,
          historyStatus: history.historyStatus,
          receiptCount: history.receipts.length,
          positions: history.ledger.positions,
          unassignedReceiptCount: history.unassignedReceiptCount,
          excludedReceiptCount: history.excludedReceiptCount,
        });
    } else {
      const history = await readFinancePositionLedger(stateDirectory);
      historicalBook =
        "Stored mixed-source execution history (account unassigned; not current Alpaca holdings or execution authority): " +
        JSON.stringify({
          headRef: history.headRef,
          receiptCount: history.receiptRecordCount,
          positions: history.ledger.positions,
        });
    }
  } catch (error) {
    historicalBook =
      "Stored execution history unavailable: " +
      (error instanceof Error ? error.message : String(error));
    if (deps.control?.mode === "alpaca_paper") {
      return { status: "blocked" as const, refusals: [historicalBook] };
    }
  }

  // Show the model its own scored record before it judges again. Facts only -
  // it is told what happened, never how much to move its number.
  const scored =
    deps.reflection === undefined ? readScored(financeResearchScoredPath(stateDirectory)) : [];
  const reflection =
    deps.reflection ??
    [
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
  const venue =
    deps.positionSummary === undefined
      ? await fetchAlpacaVenueState({})
      : { ok: false as const, reason: "controller supplied summary" };
  const positionLine =
    deps.positionSummary ??
    (venue.ok
      ? (() => {
          const held = venue.state.positions.get(instrument) ?? 0;
          const open = venue.state.openOrders.get(instrument) ?? 0;
          // The whole book, not a count. A judgement made one instrument at a time
          // still has to be made against everything already held: a count says how
          // crowded the book is, the list says what it is crowded with.
          const book = [...venue.state.positions.entries()]
            .filter(([, qty]) => qty !== 0)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([symbol, qty]) => symbol + " " + qty)
            .join(", ");
          return (
            "Current book: holding " +
            held +
            " " +
            instrument +
            ".\n" +
            "Whole book (" +
            venue.state.positions.size +
            " position(s)): " +
            (book.length > 0 ? book : "none") +
            "." +
            (open > 0
              ? "\n" + open + " unfilled order(s) already working on " + instrument + "."
              : "") +
            "\nJudge in the light of what is already held: adding to a position already held, " +
            "and opening one that is not, are different decisions."
          );
        })()
      : "Current book: NOT READABLE (" +
        venue.reason +
        "). Judge without it, and do not assume the position is flat - an unknown " +
        "holding is not an empty one.");

  const prompt =
    buildFinanceConclusionPrompt({
      instrument,
      assetClass,
      availableSources: evidence.map((e) => ({ sourceId: e.sourceId, description: e.description })),
      question:
        historicalBook +
        "\n" +
        positionLine +
        "\n\nA single independent source supports only hold or avoid. Buy/sell candidates require at least two independent evidence roots; derived calculations do not add a source.\n" +
        "Given the evidence below, is there a directional view for the next 30 days?\n\n" +
        evidence.map((e) => "- " + e.sourceId + ": " + e.detail).join("\n") +
        "\n\n" +
        reflection,
      horizonDays: 30,
    }) + "\n\nReply with the JSON object only.";

  let answer: string;
  if (deps.invokeModel) {
    answer = await deps.invokeModel(prompt);
  } else {
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
    answer = raw;
    try {
      const parsed = JSON.parse(raw) as { payloads?: Array<{ text?: string }> };
      const first = parsed.payloads?.[0]?.text;
      if (typeof first === "string") {
        answer = first;
      }
    } catch {
      // keep the raw body
    }
  }

  const extracted = extractFinanceConclusionJson(answer);
  if (extracted === null) {
    process.stdout.write("\nRESULT: model produced no machine-readable conclusion\n");
    return;
  }
  process.stdout.write("\n=== model conclusion ===\n" + JSON.stringify(extracted) + "\n");

  // The shared back half, so this path and the conclusion-to-order path cannot
  // drift apart again - they already had, on whether a regime reaches the mandate.
  const bridge = await runFinanceResearchExecutionBridge(
    {
      instrument,
      assetClass,
      modelText: answer,
      evidence,
      market: { referencePrice: lastPrice, referencePriceAt: lastPriceAt },
      equity,
      runAuthorizationId: authorization,
      ...(regime === undefined ? {} : { regime }),
    },
    deps.control,
  );
  const decision = "decision" in bridge ? bridge.decision : undefined;
  if (!decision) {
    process.stdout.write("\n=== research execution boundary ===\n" + JSON.stringify(bridge) + "\n");
    recordShadow({
      asOf: now,
      instrument,
      assetClass,
      path: "judgement",
      outcome: bridge.status,
      evidenceReceipt: bridge.receipt,
    });
    return bridge;
  }

  if (!decision.ok) {
    process.stdout.write(
      "\n=== " +
        decision.stage +
        " ===\n" +
        JSON.stringify({ ok: false, refusals: decision.refusals }, null, 2) +
        "\n",
    );
    recordShadow({
      asOf: now,
      instrument,
      path: "judgement",
      outcome: "refused_at_" + decision.stage,
      refusals: [...decision.refusals],
    });
    return bridge;
  }

  const strategyClass = decision.strategyClass;
  const mandate = decision.mandate;

  process.stdout.write(
    "\n=== mandate ===\n" +
      JSON.stringify(
        {
          ok: mandate.verdict === "pass",
          strategyClass,
          verdict: mandate.verdict,
          reasons: mandate.reasons,
          intent: decision.intent,
        },
        null,
        2,
      ) +
      "\n",
  );

  // The shadow record: what this path wanted, and what stopped it. Compared
  // later against what the mechanical path actually did on the same day.
  recordShadow({
    asOf: now,
    instrument,
    path: "judgement",
    outcome: bridge.status === "shadow" ? "would_trade" : bridge.status,
    assetClass,
    evidenceReceipt: bridge.receipt,
    execution: "placement" in bridge ? bridge.placement : undefined,
    claimedConviction: decision.conclusion.conviction,
    direction: decision.conclusion.direction,
    mandateVerdict: mandate.verdict,
    reasons: [...mandate.reasons],
    ...(decision.intent === undefined
      ? {}
      : {
          wouldBeIntent: {
            side: decision.intent.side,
            quantity: decision.intent.quantity,
            stopPrice: decision.intent.stopPrice ?? null,
          },
        }),
  });
  process.stdout.write("\n=== research execution boundary ===\n" + JSON.stringify(bridge) + "\n");
  return bridge;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runFinanceResearchTurn(process.argv.slice(2));
}
