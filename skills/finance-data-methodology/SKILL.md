---
name: finance-data-methodology
description: Provider-neutral method for selecting, validating, timestamping, and citing finance data from sources actually available in the current runtime.
metadata: { "openclaw": { "emoji": "🧭" } }
---

# Finance Data Methodology

This Skill defines an evidence workflow, not a connector, vendor registry,
credential store, or promise that any particular finance API is installed.
Discover callable sources in the current runtime and follow their declared
contracts. Tool names and routing order in other deployments are examples, not
assumptions.

## Context to lock first

Identify the question, entity/instrument, market and venue, jurisdiction,
reporting or observation period, as-of cutoff, required fields, units/currency,
adjustment basis, and decision use. Do not mix currencies, periods, calendars,
consolidated perimeters, or definitions without an explicit conversion.

## Workflow

1. Inspect the currently available, authorized data sources and their documented
   coverage. If no callable route exists for a required field, state that gap;
   do not invent a tool, endpoint, credential, or vendor fallback.
2. Select the narrowest source and smallest query that can answer the question.
   Prefer regulator, exchange, issuer, or other primary records for filed facts;
   use a market-data provider for fields it actually defines and covers.
3. Preserve a provenance record for each material field: source identity and
   artifact/URL, retrieval timestamp, observed-as-of time, field definition,
   units/currency, adjustment status, period, and any transformations.
4. Validate schema, units, dates, duplicates, coverage, revisions, and
   plausibility. Keep source facts, normalized values, calculations, and
   inferences distinguishable.
5. Cross-check material mutable values when an independent source is available.
   If sources conflict, document the difference in definition, time, or method;
   do not choose a value because it fits the thesis. Escalate unresolved
   conflicts or leave the value unknown.
6. Report sources attempted, values used or withheld, freshness, conflicts,
   coverage limitations, assumptions, and the next safe verification.

## Boundaries

- Raw tool output is not automatically validated evidence.
- Stale or undated snapshots can support historical context, not current claims.
- Credentials, egress policy, account access, and data licensing are controlled
  outside this Skill; never inspect or alter them as a side effect.
- Data availability does not grant research, advisory, trading, or execution
  authority.
