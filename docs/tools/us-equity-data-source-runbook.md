# US equity data source runbook

This runbook is the durable entry point for the LCX US-market research data
plane. It covers public price checks, official SEC fundamentals, and optional
keyed market-data providers. It does not add order, account, wallet, or broker
authority.

## Current source path

The canonical path is:

```text
finance_realtime_source_refresh
  -> finance-realtime-source-registry
  -> source adapters
  -> finance-data-gateway
  -> source/timestamp/conflict receipt
```

For a US common stock, use `assetClass=us_equity` (or `stock`, `equity`, or
`common_stock`). The default public/official path is:

| Source                 | Role                      | Coverage                                            | Credential |
| ---------------------- | ------------------------- | --------------------------------------------------- | ---------- |
| Yahoo chart            | primary market data       | delayed daily/latest chart quote                    | none       |
| Nasdaq public quote    | independent cross-check   | public exchange quote and session metadata          | none       |
| Stooq daily            | independent cross-check   | end-of-day daily CSV when available                 | none       |
| SEC EDGAR companyfacts | official/issuer reference | XBRL fundamentals and shares outstanding            | none       |
| SEC EDGAR submissions  | official/issuer reference | filing date/form for configured issuer/ETF mappings | none       |

The optional keyed path is enabled only when the corresponding process
environment values are already present at runtime:

| Environment value                             | Adapter             | Coverage                                                   |
| --------------------------------------------- | ------------------- | ---------------------------------------------------------- |
| `MASSIVE_API_KEY`                             | Massive snapshot    | consolidated US equity snapshot: trade/quote/day fields    |
| `ALPACA_API_KEY_ID` + `ALPACA_API_SECRET_KEY` | Alpaca latest quote | bid/ask/size and midpoint; `ALPACA_DATA_FEED` selects feed |
| `FINNHUB_API_KEY`                             | Finnhub quote       | current/delayed quote, change, session high/low/open       |
| `TWELVE_DATA_API_KEY`                         | Twelve Data quote   | quote, change, session range and volume                    |

The existing optional variables remain supported for Alpha Vantage, CoinGecko,
and CoinCap. Secrets are never accepted in the tool input schema and are not
written into source URLs or receipts. A missing or partial credential is an
unavailable adapter, not a fake success.

## Local verification

Dry inspection, with no network call:

```bash
pnpm exec tsx scripts/operator/finance-data-gateway-live-smoke.ts --asset-class us_equity --symbol AAPL
```

Real public/official fetch, explicitly opt-in:

```bash
node --import tsx scripts/operator/finance-data-gateway-live-smoke.ts \
  --live --asset-class us_equity --symbol AAPL --json
```

Every attempt records success/failure and latency. The gateway keeps
`needs_review` when source values conflict or timestamps are materially apart;
it does not select a number by model preference. Every current numeric value
must retain its source URL, source timestamp, field definition, and delay
status.

## Source boundaries

- SEC `data.sec.gov` and EDGAR search are read-only data references.
- The adapters do not submit filings, place trades, access accounts, or call
  broker/order endpoints.
- A successful HTTP response is not a quality verdict. The canonical gateway
  still requires provider-role coverage and checks conflicts/freshness.
- API plans differ. A keyed adapter being configured proves only that it can
  be attempted; live plan/entitlement and feed latency remain receipt evidence.
