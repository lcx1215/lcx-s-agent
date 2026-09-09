# Finance source quotas

The native finance transport shares quota reservations across provider routes,
checkouts, and local processes using the configured state directory. It waits
before HTTP dispatch, observes rate-limit headers and error envelopes, and
stops at exhausted daily budgets or active cooldowns. Retries also reserve
quota. A task's own timeout, call budget, and concurrency remain additional
constraints; the transport does not generate background traffic to fill quotas.

Inspect the current policy and local budget through the existing
`research_data_autopilot` tool with `intent: "source_health"`. Its `quotas`
section is separate from recent successful-call evidence. `within_local_budget`
does not prove configured credentials, endpoint entitlement, or server-side
availability. `localRemaining` counts local reservations, including uncertain
or cancelled attempts; other clients and devices can consume the same account
or IP quota. Server remaining/reset headers can reduce the local allowance.

## Policy evidence

The bounded measurement pass on 2026-09-09 observed quota rejection for the
first seven providers below. This does not establish every endpoint's cost,
all account tiers, or every monthly/bandwidth limit.

| Provider                      | Ceiling used by the native transport      | Evidence and qualification                                                                                                                                                                             |
| ----------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Massive                       | 5 requests/minute                         | [Free tier](https://massive.com/stocks); fifth request succeeded and sixth returned 429 in the measured burst                                                                                          |
| Twelve Data                   | 8 credits/minute; 800/day                 | [Credit rules](https://support.twelvedata.com/en/articles/5615854-credits); minute credits reached zero, next request returned 429; daily ceiling is documented, not exhausted by the test             |
| Finnhub                       | 60 requests/minute                        | Real response limit/remaining/reset headers; request 61 returned 429; [API rules](https://finnhub.io/docs/api) also impose a per-second ceiling                                                        |
| Alpaca                        | Capacity 200, refill 200/minute           | [Basic market data](https://docs.alpaca.markets/us/docs/about-market-data-api); response headers and rejection after balance depletion; refill during a burst means its total successes can exceed 200 |
| Alpha Vantage                 | 25 requests/day                           | [Free service](https://www.alphavantage.co/support/); 25 successes across the measured calls, then HTTP 200 with a quota error rather than data                                                        |
| FRED API                      | 120 requests/minute                       | [API errors](https://fred.stlouisfed.org/docs/api/fred/errors.html); 120 successes then 429 in one short burst                                                                                         |
| FMP                           | 250 requests/day                          | [Basic plan](https://site.financialmodelingprep.com/developer/docs/pricing); 250 successes across the measured calls, then 429; its separate trailing bandwidth limit was not exhausted                |
| Binance                       | 6,000 request-weight units/minute         | Live `exchangeInfo` limit metadata; current symbol-price and candle routes cost 2 units; unknown weighted routes are rejected pending a cost mapping                                                   |
| BLS                           | 25 requests/day without registration      | [Documented daily allowance](https://www.bls.gov/developers/api_faqs.htm); the sample did not establish an unambiguous server quota rejection                                                          |
| SEC                           | 10 requests/second across hosts           | [Fair access](https://www.sec.gov/about/developer-resources); successful read, not a saturation test                                                                                                   |
| Kraken public REST            | 1 request/second                          | [Public endpoint guidance](https://support.kraken.com/articles/206548367-what-are-the-api-rate-limits-); bounded successful sample                                                                     |
| Coinbase Exchange public REST | 10 requests/second                        | [IP rate limits](https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits); the test did not exhaust its burst/refill allowance                                                                     |
| OKX ticker                    | 20 requests/2 seconds                     | [Ticker documentation](https://app.okx.com/docs-v5/en); bounded sample without a quota rejection                                                                                                       |
| Bybit public REST             | 600 requests/5 seconds                    | [IP rules](https://bybit-exchange.github.io/docs/v5/rate-limit); modest pacing margin because the provider warns against running at the edge                                                           |
| Bitstamp                      | 400 requests/second and 10,000/10 minutes | [Request limits](https://www.bitstamp.net/api/); paced to the longer-window ceiling; no saturation claim                                                                                               |

Yahoo, CoinGecko, CoinCap, Nasdaq, Stooq, Invesco, Treasury, Google News,
GDELT, and the public FRED CSV host do not have a verified fixed ceiling in
this policy. They retain a labeled conservative pacing rule, never an invented
unlimited allowance. GDELT DOC has a five-second pacing rule and remains
separate from its static title-file service. Public FRED CSV and the registered
FRED API also have separate host budgets. No configured credential means no
live test; a parsing/access failure is not proof of a quota boundary.

Daily windows use a conservative rolling 24 hours unless the provider's reset
boundary is explicit. Twelve Data resets its daily allowance at midnight UTC.
Monthly quota error envelopes stop calls conservatively; this is not a claim
that the account's exact billing reset date has been discovered. Public CDN
caching, endpoint weights, shared IP traffic, and changing entitlements can
affect measurements. A successful bounded sample establishes no upper limit.

## Repeat a bounded measurement

The measurement operator is dry by default. It uses registered read-only
adapters and stores numeric headers, transport receipts, and error categories;
it never stores raw provider errors, URLs containing credentials, or keys.

```bash
node --import tsx scripts/operator/lcx-finance-source-limit-probe.ts
node --import tsx scripts/operator/lcx-finance-source-limit-probe.ts \
  --live --provider massive --exhaust-free-quota --max-attempts 6 --interval-ms 0
```

Repeated calls require explicit authority to consume free quota. Use a known
free endpoint and stop on the first quota/access failure. The operator supports
at most four concurrent requests; requests already in flight may finish after
the stop signal, but no further request is dispatched. `--source-id` selects a
registered route belonging to the chosen provider. Do not interpret sample
size as a quota limit or buy overage to continue a test.

Raw measurement receipts live in `finance-caseflow/quota-probes` under the
configured state directory. The quota ledger imports completed new probe
receipts, so probing does not silently reset an already consumed budget.
Only the native default finance fetch is governed automatically; injected test
transports and the explicitly authorized raw measurement operator are separate.
Long-lived processes must load the new code through the normal deployment
procedure; a local CLI proof alone does not prove their reload or deployment.

## Calling pipeline and reuse

All default finance adapters, including gzip feeds, use this path:

```text
research / refresh / batch
  -> bounded provider lanes (same provider serial, independent providers parallel)
  -> bounded response reuse / duplicate wait
  -> shared provider quota reservation
  -> caller HTTP budget approval
  -> native HTTP / retry receipt
  -> source parsing and provenance / freshness gates
```

Each refresh permits four independent provider lanes by default, configurable
from one to eight with `maxSourceConcurrency`. Source results retain selection
order. A failed source remains in the receipt; parallelism does not replace it
with another provider or increase its quota. Batch job concurrency and source
lane concurrency are separate bounds.

The default response cache is shared inside one process and retains at most
256 entries / 16 MiB. It does not persist provider bodies to disk. Its identity
includes the full request and credentials in a hash, with separate namespaces
for normal and gzip decoding. It joins concurrent identical reads, respects
caller cancellation, and releases waiting readers when the owner fails.
Different processes share the durable quota ledger, but not response bodies.

Reuse defaults to five seconds for market responses, one minute for news and
recognized history/macro routes, and fifteen minutes for recognized reference
metadata routes. These are local reuse policies, not guarantees that source
data is current. A caller can tighten the window with `cacheMaxAgeMs`; zero
forces a network read. Known error envelopes, malformed JSON, HTML access
pages, and responses forbidding caching are not retained. Expired entries are
never returned as a fallback after a failed refresh. Gateway and collection
freshness checks still apply to the provider timestamps. Reuse preserves the
original fetch time and does not advance observation timestamps or fallback
source timestamps to the new request time.

HTTP receipts distinguish `dataAccess.kind: network` from `cache`. Cache reads
have their own call/correlation IDs and original `fetchedAt`, but no
`dispatchedAt`, no quota reservation, and no caller HTTP charge. Cached reads
do not close an open network circuit. Source health ignores cached/local-only
attempts when determining recovery and exposes process-local reuse counters
separately. Each quota group exposes `nextAllowedAt`, an estimate for one credit;
weighted endpoint eligibility must still be checked at dispatch.

Normal batches enforce `maxApiCalls` synchronously at actual HTTP dispatch.
Unused retry allowances and cached reads therefore leave budget for later
work. A small budget can yield partial source coverage; it does not promise a
complete multi-source answer. Checkpointed batches keep durable worst-case
reservations because a crashed process may have dispatched a request before
saving its result. Their receipt states `durable_worst_case_reservation` rather
than claiming actual-only accounting.

Batch `httpDispatchCount`, `cacheHitCount`, and `rejectedDispatchCount` distinguish
these outcomes. The legacy `callCount` continues to count HTTP-operation
receipts, including cache reads and locally rejected attempts; do not use it as
provider consumption. Quotas are ceilings, not traffic targets: there is no
background prefetch, automatic saturation, or trading execution.
