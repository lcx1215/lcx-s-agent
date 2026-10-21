import { z } from "zod";
import { createAlpacaSafetyReadTransport } from "./finance-alpaca-safety-transport.js";
import { caseflowFingerprint } from "./finance-caseflow.js";
import { resolveFinanceCredentialEnv } from "./finance-credential-env.js";
import { financeEtClock, financeUsEquityLocalTimeInstant } from "./finance-cycle-schedule.js";
import { readFinancePaperEconomicAttribution } from "./finance-paper-economic-attribution.js";
import {
  appendFinanceBrokerHistory,
  reduceFinanceBrokerHistoryRecords,
  withFinanceBrokerHistorySnapshot,
} from "./finance-position-ledger.js";
import type { FinanceUncachedFetch } from "./finance-write-transport.js";

export const FINANCE_PAPER_ECONOMIC_PROTOCOL = Object.freeze({
  version: "account_close_economics_v1",
  historyStart: "2026-09-08",
  repairAt: "2026-10-15T05:18:09.427Z",
  reviewSessions: 20,
  cash: "nominal_USD_zero_interest_assumption",
  authority: "research_only_no_automatic_allocation_or_promotion",
});
const prefix = "account_economics:";
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const Calendar = z.array(z.object({ date: Day, open: z.string(), close: z.string() }));
const History = z.object({
  timestamp: z.array(z.number().int()),
  equity: z.array(z.number().finite()),
  cashflow: z.record(z.string(), z.array(z.number().finite())).optional(),
});
const Bar = z.object({ t: z.string(), c: z.number().positive() });
const Bars = z.object({
  bars: z.record(z.string(), z.array(Bar)),
  next_page_token: z.null().optional(),
});
const Auction = z.object({
  d: Day,
  c: z.array(z.object({ c: z.string(), p: z.number().positive(), x: z.string(), t: z.string() })),
});
const Auctions = z.object({
  auctions: z.record(z.string(), z.array(Auction)),
  next_page_token: z.null().optional(),
});
const Anchor = z.object({
  at: z.string().datetime(),
  equity: z.number().positive(),
  ref: z.string().min(1),
});
const Observation = z.object({
  protocolRef: z.literal(caseflowFingerprint(FINANCE_PAPER_ECONOMIC_PROTOCOL)),
  accountId: z.string().min(1),
  venue: z.literal("alpaca:paper"),
  observedAt: z.string().datetime(),
  calendar: Calendar,
  histories: z.array(History),
  auctions: Auctions,
  rawBars: Bars,
  adjustedBars: Bars,
  firstFillAt: z.string().datetime({ offset: true }).nullable().optional(),
  initialFunding: z
    .object({ day: Day, amount: z.number().positive(), ref: z.string().min(1) })
    .nullable(),
  repairAnchor: Anchor.nullable(),
});
type Observation = z.infer<typeof Observation>;
function closeAt(day: string, clock: string) {
  if (!/^\d{2}:\d{2}$/.test(clock)) {
    throw new Error("invalid session close");
  }
  const [h, m] = clock.split(":").map(Number);
  if (h > 23 || m > 59) {
    throw new Error("invalid session close");
  }
  const value = financeUsEquityLocalTimeInstant(day, h * 60 + m);
  if (!value) {
    throw new Error("invalid session date");
  }
  return value;
}

/** Account returns are based on broker equity; reported charges are not subtracted again. */
export function evaluateFinancePaperEconomicWindow(input: unknown) {
  const o = Observation.parse(input),
    gaps: string[] = [],
    values = new Map<string, number>();
  const calendar = o.calendar.toSorted((a, b) => a.date.localeCompare(b.date));
  if (new Set(calendar.map((d) => d.date)).size !== calendar.length) {
    throw new Error("duplicate calendar day");
  }
  const completed = calendar.filter(
    (d) => Date.parse(closeAt(d.date, d.close)) <= Date.parse(o.observedAt),
  );
  const sessions = new Map(
    completed.map((d) => [Date.parse(closeAt(d.date, d.close)) / 1000, d.date]),
  );
  let externalFlow = false;
  for (const h of o.histories) {
    if (
      h.timestamp.length !== h.equity.length ||
      Object.values(h.cashflow ?? {}).some((v) => v.length !== h.timestamp.length)
    ) {
      throw new Error("history columns disagree");
    }
    h.timestamp.forEach((t, i) => {
      if (t * 1000 > Date.parse(o.observedAt)) {
        throw new Error("future equity observation");
      }
      const day = sessions.get(t);
      if (day) {
        if (values.has(day) && values.get(day) !== h.equity[i]) {
          throw new Error("conflicting close equity");
        }
        values.set(day, h.equity[i]);
      }
      for (const [kind, flows] of Object.entries(h.cashflow ?? {})) {
        if (!flows[i] || ["FEE", "CFEE", "DIV", "INT", "MA"].includes(kind)) {
          continue;
        }
        if (
          kind === "JNLC" &&
          o.initialFunding &&
          financeEtClock(new Date(t * 1000)).date === o.initialFunding.day &&
          flows[i] === o.initialFunding.amount
        ) {
          continue;
        }
        externalFlow = true;
      }
    });
  }
  if (externalFlow) {
    gaps.push("external_flow_requires_before_after_valuation; return_unknown");
  }
  if (o.initialFunding?.day !== FINANCE_PAPER_ECONOMIC_PROTOCOL.historyStart) {
    gaps.push("initial_funding_unverified");
  }
  // The independently verified funding amount is an opening anchor, never a replacement close.
  const initialConflict =
    o.initialFunding && values.get(o.initialFunding.day) !== o.initialFunding.amount;
  if (initialConflict) {
    gaps.push("initial_day_close_conflict; retained_unknown_not_corrected");
  }
  const usable = completed.filter((d) => d.date !== o.initialFunding?.day);
  for (const d of usable) {
    if (!(values.get(d.date)! > 0)) {
      gaps.push(`close_missing:${d.date}`);
    }
  }
  const lastDay = completed.at(-1)?.date;
  const last = lastDay ? values.get(lastDay) : undefined;
  const returnsAvailable =
    usable.length > 0 &&
    !externalFlow &&
    !!o.initialFunding &&
    o.initialFunding.day === FINANCE_PAPER_ECONOMIC_PROTOCOL.historyStart &&
    last !== undefined &&
    usable.every((d) => values.get(d.date)! > 0);
  const levels = [o.initialFunding?.amount, ...usable.map((d) => values.get(d.date))];
  let peak = 0,
    drawdown = 0;
  for (const value of levels) {
    if (value !== undefined) {
      peak = Math.max(peak, value);
      drawdown = Math.max(drawdown, 1 - value / peak);
    }
  }
  const benchmarks = (["SPY", "QQQ"] as const).map((symbol) => {
    const exchange = symbol === "SPY" ? "P" : "Q";
    const prices = new Map<string, number>();
    for (const a of o.auctions.auctions[symbol] ?? []) {
      const records = a.c.filter((c) => c.x === exchange && c.c === "M");
      if (new Set(records.map((c) => c.p)).size !== 1) {
        continue;
      }
      const raw = (o.rawBars.bars[symbol] ?? []).filter(
        (b) => financeEtClock(new Date(b.t)).date === a.d,
      );
      const adj = (o.adjustedBars.bars[symbol] ?? []).filter(
        (b) => financeEtClock(new Date(b.t)).date === a.d,
      );
      if (raw.length === 1 && adj.length === 1 && records.length) {
        prices.set(a.d, (records[0].p * adj[0].c) / raw[0].c);
      }
    }
    const missing = completed.filter((d) => !prices.has(d.date)).map((d) => d.date);
    const start = prices.get(FINANCE_PAPER_ECONOMIC_PROTOCOL.historyStart),
      end = lastDay ? prices.get(lastDay) : undefined;
    return {
      symbol,
      source: "primary_market_official_close_times_SIP_dividend_split_adjustment_factor",
      totalReturnProxy: !missing.length && start && end ? end / start - 1 : null,
      missingDates: missing,
      cost: "hypothetical_buy_hold_transaction_cost_unknown",
      reinvestment: "vendor_dividend_adjustment_proxy_not_exact_reinvestment_execution",
    };
  });
  const post =
    o.repairAnchor && Date.parse(o.repairAnchor.at) <= Date.parse(o.observedAt)
      ? o.repairAnchor
      : null;
  const postDays = completed.filter(
    (d) => post && Date.parse(closeAt(d.date, d.close)) >= Date.parse(post.at),
  );
  return {
    protocol: FINANCE_PAPER_ECONOMIC_PROTOCOL,
    accountId: o.accountId,
    venue: o.venue,
    observedAt: o.observedAt,
    status:
      gaps.length || benchmarks.some((b) => b.totalReturnProxy === null)
        ? "evidence_incomplete"
        : "observed_not_profitability_qualified",
    history: {
      start: FINANCE_PAPER_ECONOMIC_PROTOCOL.historyStart,
      firstFillAt: o.firstFillAt ?? null,
      through: lastDay ?? null,
      initialFunding: o.initialFunding,
      initialClose: initialConflict
        ? null
        : (values.get(FINANCE_PAPER_ECONOMIC_PROTOCOL.historyStart) ?? null),
      latestClose: last ?? null,
      observedSessions: completed.length,
      accountEquityReturn: returnsAvailable ? last / o.initialFunding!.amount - 1 : null,
      observedCloseDrawdown: returnsAvailable ? drawdown : null,
      drawdownBoundary: "observed_closes_only_initial_close_unknown_not_continuous_drawdown",
    },
    postRepair: {
      anchor: post,
      closedSessions: postDays.length,
      accountEquityReturn:
        post && postDays.length && !externalFlow && last !== undefined
          ? last / post.equity - 1
          : null,
      attribution: {
        inheritedPositions: "separate_opening_lots; source_breakdown_required",
        newDecisions: "exact_decision_entry_exit_lineage_required",
        unallocatedPnl: null,
        status: "not_yet_attributed_do_not_assign_account_return_to_new_code",
      },
    },
    benchmarks,
    cash: { return: 0, assumption: FINANCE_PAPER_ECONOMIC_PROTOCOL.cash },
    costs: {
      trading: "posted_charges_already_in_broker_equity_do_not_subtract_again",
      pendingFees: "unknown",
      modelBill: null,
      modelCostTreatment: "separate_operating_cost_not_already_subtracted; tokens_are_not_currency",
    },
    gaps,
    nextDecision:
      "Use each new result now to challenge the mechanism, evidence or execution; retain/change/veto with specific facts. Twenty sessions is a comparison window, never a waiting period or automatic permission to promote.",
  };
}

export async function readFinancePaperEconomicWindow(
  directory: string,
  accountId: string,
  asOf: string,
) {
  try {
    return await withFinanceBrokerHistorySnapshot(directory, () =>
      readEconomicWindowSnapshot(directory, accountId, asOf),
    );
  } catch {
    return { status: "unavailable", reason: "account_economic_observation_unverified" };
  }
}

async function readEconomicWindowSnapshot(directory: string, accountId: string, asOf: string) {
  try {
    if (!Number.isFinite(Date.parse(asOf)) || Date.parse(asOf) > Date.now()) {
      throw new Error("invalid cutoff");
    }
    const result = await reduceFinanceBrokerHistoryRecords(
      directory,
      accountId,
      "alpaca:paper",
      undefined as { ref: string; observation: Observation } | undefined,
      (prior, record) => {
        if (!record.body.query.startsWith(prefix)) {
          return prior;
        }
        const parsed = Observation.safeParse(record.body.payload[0]);
        if (
          !parsed.success ||
          parsed.data.accountId !== accountId ||
          Date.parse(parsed.data.observedAt) > Date.parse(asOf)
        ) {
          return prior;
        }
        if (!prior || parsed.data.observedAt > prior.observation.observedAt) {
          return { ref: record.ref, observation: parsed.data };
        }
        return prior;
      },
      { streams: [prefix.slice(0, -1)] },
    );
    if (!result.value) {
      return { status: "unavailable", reason: "no_account_economic_observation" };
    }
    const summary = evaluateFinancePaperEconomicWindow(result.value.observation);
    const attribution = await readFinancePaperEconomicAttribution(
      directory,
      accountId,
      summary.postRepair.anchor,
      asOf,
    );
    return {
      sourceRef: result.value.ref,
      ...summary,
      postRepair: { ...summary.postRepair, attribution },
    };
  } catch {
    return { status: "unavailable", reason: "account_economic_observation_unverified" };
  }
}

/** Reuses original night execution, original GET transport and the existing broker ledger. */
export async function captureFinancePaperEconomicWindow(options: {
  directory: string;
  accountId: string;
  sessionDate: string;
  signal: AbortSignal;
  read?: FinanceUncachedFetch;
  now?: () => Date;
  credentials?: { keyId: string; secretKey: string };
}) {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]),
    now = options.now ?? (() => new Date());
  try {
    Day.parse(options.sessionDate);
    signal.throwIfAborted();
    const env = options.credentials
      ? undefined
      : resolveFinanceCredentialEnv({ ...process.env, LCX_FINANCE_STATE_DIR: options.directory });
    const keyId = options.credentials?.keyId ?? env?.ALPACA_API_KEY_ID,
      secretKey = options.credentials?.secretKey ?? env?.ALPACA_API_SECRET_KEY;
    if (!keyId || !secretKey) {
      throw new Error("credentials unavailable");
    }
    const read = options.read ?? createAlpacaSafetyReadTransport();
    const get = async (base: string, params: Record<string, string> = {}) => {
      signal.throwIfAborted();
      const u = new URL(base);
      u.search = new URLSearchParams(params).toString();
      const response = await read(u.href, {
        headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secretKey },
        signal,
      });
      signal.throwIfAborted();
      if (response.status !== 200) {
        throw new Error("source unavailable");
      }
      return JSON.parse(response.body) as unknown;
    };
    z.object({ id: z.literal(options.accountId), currency: z.literal("USD") }).parse(
      await get("https://paper-api.alpaca.markets/v2/account"),
    );
    const calendar = Calendar.parse(
      await get("https://paper-api.alpaca.markets/v2/calendar", {
        start: FINANCE_PAPER_ECONOMIC_PROTOCOL.historyStart,
        end: options.sessionDate,
      }),
    );
    const completed = calendar.filter(
      (d) => Date.parse(closeAt(d.date, d.close)) <= now().getTime(),
    );
    if (!completed.length) {
      return { status: "skipped", reason: "no_closed_session" };
    }
    const anchors = await reduceFinanceBrokerHistoryRecords(
      options.directory,
      options.accountId,
      "alpaca:paper",
      {
        funding: new Map<string, { day: string; amount: number; ref: string }>(),
        repair: null as z.infer<typeof Anchor> | null,
        firstFillAt: null as string | null,
      },
      (state, record) => {
        if (record.body.query.startsWith("activities:")) {
          for (const row of record.body.payload) {
            const fill = z
              .object({
                activity_type: z.literal("FILL"),
                transaction_time: z.string().datetime({ offset: true }),
              })
              .safeParse(row);
            if (
              fill.success &&
              (!state.firstFillAt ||
                Date.parse(fill.data.transaction_time) < Date.parse(state.firstFillAt))
            ) {
              state.firstFillAt = fill.data.transaction_time;
            }

            const p = z
              .object({
                id: z.string(),
                activity_type: z.literal("JNLC"),
                date: Day,
                net_amount: z.string(),
              })
              .safeParse(row);
            if (
              p.success &&
              p.data.date === FINANCE_PAPER_ECONOMIC_PROTOCOL.historyStart &&
              Number(p.data.net_amount) > 0
            ) {
              state.funding.set(p.data.id, {
                day: p.data.date,
                amount: Number(p.data.net_amount),
                ref: record.ref,
              });
            }
          }
        }
        if (record.body.query.startsWith("reconciliation:")) {
          const p = z
            .object({
              status: z.literal("reconciled"),
              observedAt: z.string().datetime(),
              accountObservation: z.object({
                accountId: z.literal(options.accountId),
                equity: z.number().positive(),
              }),
            })
            .safeParse(record.body.payload[0]);
          if (
            p.success &&
            p.data.observedAt >= FINANCE_PAPER_ECONOMIC_PROTOCOL.repairAt &&
            p.data.observedAt <= now().toISOString() &&
            (!state.repair || p.data.observedAt < state.repair.at)
          ) {
            state.repair = {
              at: p.data.observedAt,
              equity: p.data.accountObservation.equity,
              ref: record.ref,
            };
          }
        }
        return state;
      },
      { streams: ["activities", "reconciliation"], signal },
    );
    const histories: z.infer<typeof History>[] = [];
    for (let i = 0; i < completed.length; i += 15) {
      const days = completed.slice(i, i + 15);
      histories.push(
        History.parse(
          await get("https://paper-api.alpaca.markets/v2/account/portfolio/history", {
            start: closeAt(days[0].date, days[0].open),
            end: new Date(
              Date.parse(closeAt(days.at(-1)!.date, days.at(-1)!.close)) + 60_000,
            ).toISOString(),
            timeframe: "5Min",
            intraday_reporting: "market_hours",
            cashflow_types: "ALL",
          }),
        ),
      );
    }
    const common = {
      symbols: "SPY,QQQ",
      start: closeAt(completed[0].date, "00:00"),
      end: new Date(
        Date.parse(closeAt(completed.at(-1)!.date, completed.at(-1)!.close)) + 300_000,
      ).toISOString(),
      feed: "sip",
      limit: "10000",
    };
    const auctions = Auctions.parse(
      await get("https://data.alpaca.markets/v2/stocks/auctions", common),
    );
    const rawBars = Bars.parse(
      await get("https://data.alpaca.markets/v2/stocks/bars", {
        ...common,
        timeframe: "1Day",
        adjustment: "raw",
      }),
    );
    const adjustedBars = Bars.parse(
      await get("https://data.alpaca.markets/v2/stocks/bars", {
        ...common,
        timeframe: "1Day",
        adjustment: "all",
      }),
    );
    const observation: Observation = {
      protocolRef: caseflowFingerprint(FINANCE_PAPER_ECONOMIC_PROTOCOL),
      accountId: options.accountId,
      venue: "alpaca:paper",
      observedAt: now().toISOString(),
      calendar: completed,
      histories,
      auctions,
      rawBars,
      adjustedBars,
      firstFillAt: anchors.value.firstFillAt,
      initialFunding:
        anchors.value.funding.size === 1 ? [...anchors.value.funding.values()][0] : null,
      repairAnchor: anchors.value.repair,
    };
    const summary = evaluateFinancePaperEconomicWindow(observation);
    signal.throwIfAborted();
    const saved = await appendFinanceBrokerHistory(
      options.directory,
      {
        kind: "broker_history",
        accountId: options.accountId,
        venue: "alpaca:paper",
        query: `${prefix}${options.sessionDate}`,
        cursor: "",
        payload: [observation],
      },
      { signal },
    );
    return { status: "captured", ref: saved.record.ref, summary };
  } catch {
    return {
      status: "unavailable",
      reason: signal.aborted ? "cancelled_or_timeout" : "economic_source_or_schema_unavailable",
    };
  }
}
