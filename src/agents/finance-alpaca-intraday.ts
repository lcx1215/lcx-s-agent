import { createAlpacaSafetyReadTransport } from "./finance-alpaca-safety-transport.js";
import { resolveFinanceCredentialEnv } from "./finance-credential-env.js";
import {
  appendFinanceIntradayBars,
  type FinanceIntradayAppendInput,
} from "./finance-intraday-ledger.js";
import type { FinanceUncachedFetch } from "./finance-write-transport.js";

export type AlpacaIntradayFeed = "iex" | "sip";

type AlpacaBar = { t?: unknown; o?: unknown; h?: unknown; l?: unknown; c?: unknown; v?: unknown };

function positive(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Alpaca intraday bar requires positive ${field}`);
  }
  return value;
}

export async function syncAlpacaIntradayBars(options: {
  directory: string;
  instrument: string;
  start: string;
  end: string;
  intervalSeconds: 60 | 300 | 900;
  feed: AlpacaIntradayFeed;
  signal?: AbortSignal;
  read?: FinanceUncachedFetch;
  credentials?: { apiKeyId: string; apiSecretKey: string };
  now?: () => Date;
}) {
  const instrument = options.instrument.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,14}$/u.test(instrument)) {
    throw new Error("Alpaca intraday sync supports unambiguous US-equity symbols only");
  }
  const startMs = Date.parse(options.start);
  const endMs = Date.parse(options.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new Error("Alpaca intraday sync requires ordered ISO start/end timestamps");
  }
  const env = options.credentials ? undefined : resolveFinanceCredentialEnv(process.env);
  const key = options.credentials?.apiKeyId ?? env?.ALPACA_API_KEY_ID;
  const secret = options.credentials?.apiSecretKey ?? env?.ALPACA_API_SECRET_KEY;
  if (!key?.trim() || !secret?.trim()) {
    throw new Error("Alpaca data credentials unavailable");
  }

  const read = options.read ?? createAlpacaSafetyReadTransport();
  const signal = options.signal ?? new AbortController().signal;
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const observedMs = Date.parse(observedAt);
  const timeframe =
    options.intervalSeconds === 60 ? "1Min" : options.intervalSeconds === 300 ? "5Min" : "15Min";
  const collected: AlpacaBar[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    signal.throwIfAborted();
    const url = new URL(
      `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(instrument)}/bars`,
    );
    url.searchParams.set("timeframe", timeframe);
    url.searchParams.set("start", new Date(startMs).toISOString());
    url.searchParams.set("end", new Date(endMs).toISOString());
    url.searchParams.set("feed", options.feed);
    url.searchParams.set("adjustment", "raw");
    url.searchParams.set("limit", "10000");
    if (pageToken) {
      url.searchParams.set("page_token", pageToken);
    }
    const response = await read(url.toString(), {
      headers: {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
        accept: "application/json",
      },
      signal,
    });
    if (response.status !== 200) {
      throw new Error(`Alpaca intraday bars returned HTTP ${response.status}`);
    }
    const payload = JSON.parse(response.body) as { bars?: unknown; next_page_token?: unknown };
    if (!Array.isArray(payload.bars)) {
      throw new Error("Alpaca intraday bars response is malformed");
    }
    collected.push(...(payload.bars as AlpacaBar[]));
    pageToken =
      typeof payload.next_page_token === "string" && payload.next_page_token
        ? payload.next_page_token
        : undefined;
    pages += 1;
    if (pages > 100) {
      throw new Error("Alpaca intraday pagination exceeded 100 pages");
    }
  } while (pageToken);

  let unclosedBarsSkipped = 0;
  const bars: FinanceIntradayAppendInput["bars"] = collected.flatMap((bar) => {
    if (typeof bar.t !== "string" || !Number.isFinite(Date.parse(bar.t))) {
      throw new Error("Alpaca intraday bar requires a native timestamp");
    }
    const barEnd = Date.parse(bar.t) + options.intervalSeconds * 1_000;
    if (barEnd > observedMs) {
      unclosedBarsSkipped += 1;
      return [];
    }
    return [
      {
        startAt: new Date(Date.parse(bar.t)).toISOString(),
        open: positive(bar.o, "open"),
        high: positive(bar.h, "high"),
        low: positive(bar.l, "low"),
        close: positive(bar.c, "close"),
        volume:
          typeof bar.v === "number" && Number.isFinite(bar.v) && bar.v >= 0
            ? bar.v
            : (() => {
                throw new Error("Alpaca intraday bar requires non-negative volume");
              })(),
      },
    ];
  });
  if (bars.length === 0) {
    throw new Error("Alpaca intraday sync returned no closed bars");
  }
  const append = await appendFinanceIntradayBars(options.directory, {
    instrument,
    intervalSeconds: options.intervalSeconds,
    observedAt,
    provenance: {
      origin: "Alpaca Market Data API",
      sourceUrlOrArtifact: "https://data.alpaca.markets/v2/stocks/{symbol}/bars",
      feed: options.feed,
    },
    bars,
  });
  return Object.freeze({
    boundary: "read_only_market_data_then_local_ledger_write" as const,
    instrument,
    intervalSeconds: options.intervalSeconds,
    observedAt,
    pages,
    barsReceived: collected.length,
    closedBarsAccepted: bars.length,
    unclosedBarsSkipped,
    append,
    credentialsPersisted: false as const,
    orderPathTouched: false as const,
  });
}
