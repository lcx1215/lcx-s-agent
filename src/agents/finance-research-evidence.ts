import type { FinanceCommitteeEvidence } from "./finance-agent-committee.js";
import {
  FINANCE_LIVE_NOW_MAX_FUTURE_SKEW_MINUTES,
  type FinanceAsOfMode,
} from "./finance-data-gateway.js";
import type { FinanceMarketCollectionItem } from "./finance-market-collection-registry.js";
import {
  renderFinanceOptionsEvidence,
  summarizeFinanceOptionsChain,
} from "./finance-options-evidence.js";
import type {
  FinanceResearchBatchEvidencePacket,
  FinanceResearchBatchJob,
} from "./finance-research-batch-runner.js";
import type { QualityHarnessArtifact } from "./quality-harness-contract.js";

/** Exact instrument labels only; this checks citation coverage, not semantic truth. */
export function findUncitedFinanceInstruments(
  evidence: readonly { id: string }[],
  claims: QualityHarnessArtifact["claims"],
): readonly string[] {
  const instruments = evidence
    .filter((entry) => entry.id.startsWith("finance-model:"))
    .map((entry) => ({
      id: entry.id,
      instrument: decodeURIComponent(entry.id.slice("finance-model:".length)),
    }));
  const missing: string[] = [];
  for (const claim of claims) {
    if (claim.status !== "supported") {
      continue;
    }
    for (const entry of instruments) {
      const escaped = entry.instrument.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      if (
        new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(claim.text) &&
        !claim.evidenceIds.includes(entry.id)
      ) {
        missing.push(`${claim.id}:${entry.id}`);
      }
    }
  }
  return missing;
}

function number(value: unknown): number | undefined {
  if (typeof value === "string" && /^[+-]?\d+(\.\d+)?$/u.test(value.trim())) {
    value = Number(value);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function macroValue(
  data: Readonly<Record<string, unknown>>,
): { field: string; value: number } | undefined {
  for (const field of ["value", "tot_pub_debt_out_amt", "avg_interest_rate_amt"]) {
    const value = number(data[field]);
    if (value !== undefined) {
      return { field, value };
    }
  }
  return undefined;
}
const rounded = (value: number) => Math.round(value * 1_000) / 1_000;

/**
 * Keep fetched non-price collections visible to the model without allowing one provider payload
 * to consume the whole bounded evidence window. This is a transport summary, not a valuation or
 * signal: the source record and timestamp remain attached so a later module can do the real work.
 */
function compactCollectionValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.length <= 240 ? value : `${value.slice(0, 237)}...`;
  }
  if (depth >= 2) {
    return "[nested value omitted]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => compactCollectionValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 24)
        .map(([key, item]) => [key, compactCollectionValue(item, depth + 1)]),
    );
  }
  return typeof value === "bigint" || typeof value === "symbol"
    ? String(value)
    : "[unsupported value omitted]";
}

function renderUnmodeledCollectionEvidence(
  job: FinanceResearchBatchJob,
  prefix: string,
  collection: string,
  records: readonly FinanceMarketCollectionItem[],
): string {
  const samples = records.slice(0, 6).map((record) => ({
    itemId: record.itemId,
    providerName: record.providerName,
    sourceTimestamp: record.sourceTimestamp,
    sourceUrlOrArtifact: record.sourceUrlOrArtifact,
    data: compactCollectionValue(record.data),
  }));
  return (
    `${prefix}: ${collection} records=${records.length}; samples=${JSON.stringify(samples)}. ` +
    "Raw collection evidence is source-bound; no derived signal or valuation was inferred here."
  );
}

export function rankFinanceWindowDrawdowns(
  entries: readonly {
    instrument: string;
    from: string;
    to: string;
    maxDrawdownPct: number;
  }[],
) {
  const groups = new Map<string, (typeof entries)[number][]>();
  for (const entry of entries) {
    const key = `${entry.from}..${entry.to}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups].map(([window, values]) => ({
    window,
    ranked: values.toSorted((a, b) => a.maxDrawdownPct - b.maxDrawdownPct),
  }));
}

/** Descriptive arithmetic over one provider and one price definition, never a forecast. */
export function summarizeFinancePriceHistory(
  rows: readonly FinanceMarketCollectionItem[],
  asOf: string,
  options: Readonly<{
    asOfMode?: FinanceAsOfMode;
    futureTimestampLimitMs?: number;
  }> = {},
) {
  const historicalCutoff = options.asOfMode !== "live_now";
  const futureTimestampLimitMs =
    options.futureTimestampLimitMs ??
    (historicalCutoff
      ? Date.parse(asOf)
      : Date.now() + FINANCE_LIVE_NOW_MAX_FUTURE_SKEW_MINUTES * 60_000);
  const series = new Map<string, Map<string, number>>();
  let invalid = 0;
  let duplicates = 0;
  let conflicts = 0;
  for (const row of rows) {
    const close = number(row.data.close ?? row.data.c ?? row.data.price);
    const date =
      typeof row.data.date === "string" ? row.data.date : row.sourceTimestamp.slice(0, 10);
    const dateMs = Date.parse(`${date}T00:00:00.000Z`);
    const dateAfterCutoff = historicalCutoff
      ? date >= asOf.slice(0, 10)
      : !Number.isFinite(dateMs) || dateMs > futureTimestampLimitMs;
    const sourceTimestampMs = Date.parse(row.sourceTimestamp);
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date ||
      dateAfterCutoff ||
      !Number.isFinite(sourceTimestampMs) ||
      sourceTimestampMs > futureTimestampLimitMs ||
      close === undefined ||
      close <= 0
    ) {
      invalid += 1;
      continue;
    }
    // Feed and adjustment basis are part of identity; do not stitch different definitions.
    const key = JSON.stringify([
      row.providerName,
      row.data.feed ?? "unspecified",
      row.data.adjusted ?? "unspecified",
      row.data.instrumentType ?? "unspecified",
      row.data.unit ?? "unspecified",
    ]);
    const values = series.get(key) ?? new Map<string, number>();
    if (values.has(date)) {
      duplicates += 1;
      if (values.get(date) !== close) {
        conflicts += 1;
      }
    } else {
      values.set(date, close);
    }
    series.set(key, values);
  }
  const summaries = [...series].map(([identity, values]) => {
    const ordered = [...values].toSorted(([a], [b]) => a.localeCompare(b));
    const prices = ordered.map(([, close]) => close);
    const last = prices.at(-1)!;
    let peak = prices[0];
    let drawdown = 0;
    for (const price of prices) {
      peak = Math.max(peak, price);
      drawdown = Math.min(drawdown, price / peak - 1);
    }
    const returns = Object.fromEntries(
      [1, 5, 21, 63, 126].map((period) => [
        period,
        prices.length > period
          ? rounded((last / prices[prices.length - 1 - period] - 1) * 100)
          : null,
      ]),
    );
    const observationWindows = Object.fromEntries(
      [1, 5, 21, 63, 126].map((period) => [
        period,
        prices.length > period
          ? { from: ordered[prices.length - 1 - period][0], to: ordered.at(-1)![0] }
          : null,
      ]),
    );
    return {
      identity: JSON.parse(identity) as string[],
      observations: prices.length,
      from: ordered[0][0],
      to: ordered.at(-1)![0],
      first: prices[0],
      last,
      priceReturnPct: rounded((last / prices[0] - 1) * 100),
      returnsByObservationPct: returns,
      observationWindows,
      maxDrawdownPct: rounded(drawdown * 100),
      currentDrawdownPct: rounded((last / peak - 1) * 100),
    };
  });
  return {
    invalid,
    duplicates,
    conflicts,
    summaries,
    usable: conflicts === 0 && summaries.length > 0,
    basis:
      "price_change_not_dividend_reinvested_total_return; periods_are_observations; gaps_and_source_status_remain_separate",
  };
}

/** Build model-sized facts before prompt clipping, retaining the raw job IDs for audit. */
export function buildFinanceResearchModelEvidence(
  batch: FinanceResearchBatchEvidencePacket,
  options: { includeReviewEvidence?: boolean } = {},
): readonly FinanceCommitteeEvidence[] {
  const futureTimestampLimitMs =
    batch.asOfMode === "live_now"
      ? Date.now() + FINANCE_LIVE_NOW_MAX_FUTURE_SKEW_MINUTES * 60_000
      : Date.parse(batch.asOf);
  const groups = new Map<string, FinanceResearchBatchJob[]>();
  const readyDrawdowns: Parameters<typeof rankFinanceWindowDrawdowns>[0][number][] = [];
  for (const job of batch.jobs) {
    const group = groups.get(job.request.instrument) ?? [];
    group.push(job);
    groups.set(job.request.instrument, group);
  }
  const result: FinanceCommitteeEvidence[] = [
    {
      id: `finance-model-coverage:${batch.correlationId}`,
      source: "finance-research-batch-runner",
      timestamp: batch.asOf,
      text: `Research only. ${
        batch.asOfMode === "live_now"
          ? `Live-now collection-time evidence anchored at asOf=${batch.asOf}; source timestamps may be later than asOf only within the bounded live-now skew.`
          : `Frozen asOf=${batch.asOf}.`
      } ${batch.jobs.length} jobs, ${batch.status}. Status counts: ${JSON.stringify(
        batch.jobs.reduce<Record<string, number>>((counts, job) => {
          counts[job.status] = (counts[job.status] ?? 0) + 1;
          return counts;
        }, {}),
      )}. Facts below are deterministic summaries of ${
        batch.asOfMode === "live_now" ? "collection-time receipts" : "frozen receipts"
      }, not model conclusions. Needs_review values cannot be promoted to verified current evidence. Original receipts remain available by job ID.`,
    },
  ];
  for (const [instrument, jobs] of groups) {
    const facts: string[] = [];
    const priceCandidates: {
      job: FinanceResearchBatchJob;
      summary: ReturnType<typeof summarizeFinancePriceHistory>["summaries"][number];
      spotAt: string;
    }[] = [];
    const optionCandidates: Array<{
      job: FinanceResearchBatchJob;
      records: readonly FinanceMarketCollectionItem[];
    }> = [];
    for (const job of jobs) {
      if (
        job.status !== "ready" &&
        !(options.includeReviewEvidence && job.status === "needs_review")
      ) {
        continue;
      }
      if (!job.receipt) {
        continue;
      }
      const prefix = `${job.jobId} (${job.status}; ${
        batch.asOfMode === "live_now" ? "collection-time evidence" : "frozen-asOf evidence"
      })`;
      if ("records" in job.receipt) {
        const records = job.receipt.records;
        const collection = "collection" in job.request ? job.request.collection : undefined;
        if (collection === "eod_history") {
          const history = summarizeFinancePriceHistory(records, batch.asOf, {
            asOfMode: batch.asOfMode,
            futureTimestampLimitMs,
          });
          if (!history.usable) {
            facts.push(
              `${prefix}: historical values excluded; conflicting dates=${history.conflicts}, invalid=${history.invalid}.`,
            );
            continue;
          }
          for (const summary of history.summaries) {
            priceCandidates.push({ job, summary, spotAt: summary.to });
          }
        } else if (collection === "options_chain") {
          optionCandidates.push({ job, records });
        } else if (collection === "macro_series") {
          const valid = records
            .filter(
              (r) =>
                macroValue(r.data) !== undefined &&
                Date.parse(r.sourceTimestamp) <= futureTimestampLimitMs,
            )
            .toSorted((a, b) => a.sourceTimestamp.localeCompare(b.sourceTimestamp));
          const last = valid.at(-1),
            previous = valid.at(-2);
          if (last) {
            const latest = macroValue(last.data);
            const prior = previous ? macroValue(previous.data) : undefined;
            facts.push(
              `${prefix}: ${typeof last.data.seriesId === "string" ? last.data.seriesId : instrument}, latest ${latest?.field ?? "value"}=${String(latest?.value ?? "unknown")}, observation period=${last.sourceTimestamp}; previous=${String(prior?.value ?? "unknown")} (${previous?.sourceTimestamp ?? "unknown"}). Observation period is not publication time; units and revisions need source review.`,
            );
          }
        } else if (collection === "news") {
          const eligible = records.filter((r) => {
            const match = r.data.entityMatch;
            return (
              Date.parse(r.sourceTimestamp) <= futureTimestampLimitMs &&
              typeof match === "object" &&
              match !== null &&
              "status" in match &&
              match.status === "matched"
            );
          });
          facts.push(
            `${prefix}: ${records.length} news rows, ${eligible.length} entity-matched headlines. Headline-only, not full-text verification or sentiment. ${eligible
              .slice(0, 2)
              .map(
                (r) =>
                  `${typeof r.data.title === "string" ? r.data.title : typeof r.data.headline === "string" ? r.data.headline : "unknown"} (${r.sourceTimestamp})`,
              )
              .join("; ")}`,
          );
        } else if (collection) {
          // The runner can deliberately fetch these collections for selected modules. They used
          // to disappear here, so the module was "collected" but the committee never saw it.
          facts.push(renderUnmodeledCollectionEvidence(job, prefix, collection, records));
        }
      } else {
        const fields = job.receipt.snapshot?.normalizedFields ?? [];
        if (fields.length) {
          facts.push(
            `${prefix}: quote fields ${JSON.stringify(fields.slice(0, 3).map((f) => ({ name: f.name, value: f.value, sourceTimestamp: f.sourceTimestamp })))}`,
          );
        }
      }
    }
    // One entire source series per instrument. Tie-breaks prefer consolidated daily closes over IEX.
    const preference = ["yahoo", "massive", "twelve", "binance", "fred", "alpaca"];
    const rank = (provider: string) => {
      const index = preference.findIndex((name) => provider.includes(name));
      return index < 0 ? 99 : index;
    };
    priceCandidates.sort(
      (a, b) =>
        b.summary.to.localeCompare(a.summary.to) ||
        b.summary.observations - a.summary.observations ||
        rank(a.summary.identity[0]) - rank(b.summary.identity[0]),
    );
    const candidate = priceCandidates[0];
    if (candidate) {
      const h = candidate.summary;
      if (candidate.job.status === "ready") {
        readyDrawdowns.push({
          instrument,
          from: h.from,
          to: h.to,
          maxDrawdownPct: h.maxDrawdownPct,
        });
      }
      const window21 = h.observationWindows[21];
      const window63 = h.observationWindows[63];
      facts.unshift(
        `Price (${candidate.job.status}); assetClass=${candidate.job.request.assetClass}, kind=${h.identity[3]}, unit=${h.identity[4]}; ${h.observations} closes ${h.from}..${h.to}, window=${h.priceReturnPct}%, maxDD_entire_window=${h.maxDrawdownPct}%; last21=${h.returnsByObservationPct[21] ?? "unknown"}% (${window21 ? `${window21.from}..${window21.to}` : "insufficient history"}); last63=${h.returnsByObservationPct[63] ?? "unknown"}% (${window63 ? `${window63.from}..${window63.to}` : "insufficient history"}). Price change, not total return; lookbacks are return intervals, not calendar days. Source=${h.identity[0]}; feed=${h.identity[1]}; adjusted=${h.identity[2]}; Coverage=${candidate.job.historyCoverage?.status ?? "unverified"}; ${priceCandidates.length} series available, not stitched. Receipt=${candidate.job.jobId}.`,
      );
    }
    for (const option of optionCandidates) {
      if (!candidate) {
        facts.push(
          `Options chain (${option.job.status}); job=${option.job.jobId}; no usable underlying price series was available, so Greeks were not calculated.`,
        );
        continue;
      }
      const summary = summarizeFinanceOptionsChain(option.records, {
        asOf: batch.asOf,
        underlyingSpot: candidate.summary.last,
        underlyingSpotAt: candidate.spotAt,
        futureTimestampLimitMs,
      });
      facts.push(renderFinanceOptionsEvidence(summary, option.job.jobId));
    }
    if (facts.length) {
      result.push({
        id: `finance-model:${encodeURIComponent(instrument)}`,
        source: "finance-research-batch-runner",
        timestamp: batch.asOf,
        text: `${instrument}\n${facts.join("\n")}`,
      });
    }
  }
  const ranking = rankFinanceWindowDrawdowns(readyDrawdowns)
    .filter((group) => group.ranked.length > 1)
    .map(
      (group) =>
        `Worst drawdown magnitudes, same window ${group.window}: ${group.ranked
          .slice(0, 5)
          .map((entry) => `${entry.instrument} ${entry.maxDrawdownPct}%`)
          .join(", ")}.`,
    )
    .join(" ");
  if (ranking) {
    result[0] = {
      ...result[0],
      text: result[0].text.replace(". Facts below", `. ${ranking} Facts below`),
    };
  }
  return result;
}
