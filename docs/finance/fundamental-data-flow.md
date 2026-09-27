# Fundamental evidence used by business-value research

The investment question is future shareholder cash flow relative to the price paid.
Acquisition breadth alone does not establish earnings quality, durable competitive
advantage, capital allocation quality or a valuation margin.

## Current paths and limits

| Information                                                               | Existing acquisition owner                                                             | Storage / actual consumer                                                                                                                                  |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Annual income, cash-flow and balance statements                           | SEC accession-matched annual facts; registered FMP adapters and Alpha Vantage fallback | `fundamental-store_1.sqlite` when research-turn uses `--write`; `gatherFinanceOperatingEvidence` reads snapshots into the value assessment evidence packet |
| Profiles, quarterly statements, ratios, forecasts, ownership, transcripts | Collection registry and extended capability catalog                                    | Collection receipts / optional batch checkpoints; catalog presence does not establish entitlement or a unified queryable history                           |
| SEC filings and company facts                                             | SEC collection and realtime adapters                                                   | Source receipts / gateway fields; selected facts are not a full cash-flow statement and must not be silently substituted                                   |
| News and macro context                                                    | Existing collection / research batch                                                   | Source receipts and research evidence; not automatically a company financial fact                                                                          |
| Investment hypotheses and expectation gaps                                | Research thesis learning and thesis ledger                                             | Eligible thesis projection into trade decision context; no thesis is inferred merely from having stored statements                                         |
| Prices, positions, executions and scheduler feedback                      | Existing separate finance ledgers                                                      | Execution/risk and feedback consumers; these are not fundamental evidence                                                                                  |

## Persistence contract

The fundamental store is under the resolved finance state directory. Each immutable
snapshot includes the complete bounded collection receipt, request, provider records,
source URLs, publication metadata where supplied, collection time and failed attempts.
The SHA-256 snapshot ID is checked on read. Indexed lookup uses instrument, asset class,
collection, source and collection time. Publication dates and fiscal periods remain
separate; corrections create snapshots rather than overwrite earlier observations.
The current caller requests three annual records per statement, not an exhaustive history.

A subsequent operating-evidence run reuses a snapshot for at most six hours. This is a
reuse policy, not proof no filing occurred during that interval. Knowledge-time lookup
excludes observations captured after its cutoff. A fresh historical provider response
is not, by itself, proof of the exact dataset available in the past.

`--write` persists new observations; without it, existing snapshots may be read but no
fundamental database is created. Missing stores are distinct from corrupt stores.
Failed and empty collections are retained for diagnosis but never count as financial
facts. No raw credentials or HTTP headers are written by this path.

FMP collection failure triggers the existing configured Alpha Vantage statement adapter.
Those fallback records retain `publicationTimeUnknown` and provider-native fields.
They are available as partial research evidence; the current valuation normalizer does
not invent their publication time or silently relabel them as FMP data. A missing
complete normalized set means this particular cash-flow method is unavailable, not
that all research or all other trading strategies must stop.

## Decision use and remaining work

The operating normalizer joins USD annual statements by company and fiscal period,
selects the latest disclosed revision available by the requested cutoff, and supplies
cash conversion, capex, leverage and diluted-share inputs to the existing analyst and
opposing reviewer. Each evidence packet carries its snapshot ID and original record
metadata. Model hypotheses and calculated scenario values remain distinct from facts.

The durable roundtrip is tested separately from network entitlement, model consumption,
and actual trading. Further integration is needed for quarterly history, original
filing text, segments, competitive evidence, management capital allocation, estimate
vintages and estimate-to-realization comparisons. These should use the existing source
owners and explicit units/periods/knowledge times; do not add a second execution authority
or turn an incomplete company dossier into a universal trading veto.

## Official annual operating facts

The collection registry exposes `sec_edgar_annual_operating`. Business-value research
tries this official source first, stores its bounded collection in the same database,
and stops redundant statement acquisition when it has usable operating facts.
Each cohort uses a single accession, fiscal end, annual duration and filing date;
flow fields cannot borrow quarterly values or values from another accession.
USD amounts and diluted weighted-average shares keep distinct units. Missing or
conflicting facts remain missing and may fall back to the existing providers.

SEC companyfacts filing dates have day precision. `publishedAt` remains the compatible
cutoff field, with `publicationTimeBasis=conservative_known_by`: midnight UTC of the
filing date plus 36 hours, not a claimed publication instant. Raw filing date, accession,
period start/end and the exact selected XBRL tags remain in the evidence packet.
The supported debt decomposition is current/noncurrent long-term debt plus explicitly
reported commercial paper. It is identified as such for the model and does not establish
absence of leases or other obligations. Unsupported decompositions remain incomplete.
