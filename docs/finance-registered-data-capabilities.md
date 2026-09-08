# Registered finance data capabilities

The collection registry reads credentials from the process environment and exposes
these endpoints to `research_data_autopilot`, the collection tool, and the
`all_registered` research planner. Each endpoint gets an independent evidence job.

| Provider       | Collection capabilities                                                                           | Environment variable  |
| -------------- | ------------------------------------------------------------------------------------------------- | --------------------- |
| Alpha Vantage  | Company overview, annual income/balance/cash-flow statements, compact daily history               | ALPHA_VANTAGE_API_KEY |
| Finnhub        | Company profile, valuation and financial metrics, earnings surprises, company news                | FINNHUB_API_KEY       |
| Massive        | Daily adjusted bars, news, options snapshots, dividends, splits                                   | MASSIVE_API_KEY       |
| CoinGecko Demo | Daily historical price snapshots by coin ID                                                       | COINGECKO_API_KEY     |
| FRED           | Any supported macro series; operator includes policy rate, GDP, unemployment, CPI, ten-year yield | FRED_API_KEY          |

Existing quote adapters remain available. Account registration does not establish
entitlement to every endpoint. Each live receipt records transport calls, failures,
source provenance, and returned records. Credentials must never enter arguments,
source files, reports, or version control.

Preview the configured collection plan:

```sh
node --import tsx scripts/operator/lcx-finance-capability-collect.ts
```

Collect a bounded research packet after loading credentials into the environment:

```sh
node --import tsx scripts/operator/lcx-finance-capability-collect.ts --live --output /secure/research-output
```

This is an explicit one-shot collection, with one HTTP attempt per endpoint, a
15-second timeout, and a durable manifest. It does not schedule background runs.
The operator uses AAPL and Bitcoin as representative instruments; the registry
and agent tools accept other supported tickers and coin IDs.

Use `financial_statements` to compare annual cash generation, debt and revenue;
`company_profile` to inspect business and valuation context; `earnings` for
reported results versus estimates; `eod_history` for bounded trend analysis;
news, distributions and splits for event context; macro series for economic
conditions. Feed records and failed-source receipts together into research.

Fiscal dates are accounting periods, not publication dates. Profiles without a
provider timestamp are labelled retrieved snapshots with unknown delay. These
are not point-in-time backtest evidence. CoinGecko prices are daily snapshots,
not exchange OHLC closing bars. Alpha Vantage compact history covers only the
latest 100 sessions; CoinGecko Demo history is capped at 365 days. Requested
windows and record limits still apply. Current-day bars and invalid prices are
excluded. A failed endpoint never becomes a synthetic successful record.

Official contracts: [Alpha Vantage](https://www.alphavantage.co/documentation/),
[Finnhub SDK](https://github.com/Finnhub-Stock-API/finnhub-python),
[Massive bars](https://massive.com/docs/rest/stocks/aggregates/custom-bars),
[CoinGecko historical data](https://docs.coingecko.com/reference/coins-id-market-chart),
[FRED observations](https://fred.stlouisfed.org/docs/api/fred/series_observations.html).
