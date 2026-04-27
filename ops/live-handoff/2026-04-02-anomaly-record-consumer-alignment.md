# Anomaly Record Consumer Alignment

## Exact failure mode

- watchtower anomaly JSON writing was relatively stable, but consumers were still scraping fields ad hoc:
  - `src/hooks/bundled/operating-weekly-review/handler.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
- each consumer separately assumed how to read:
  - `lastSeenAt`
  - `category`
  - `severity`
  - `source`
  - `problem`
  - `foundationTemplate`
  - `occurrenceCount`

## Why dangerous

- anomaly records are a shared watchtower input to multiple control surfaces
- if those readers drift, the system can silently disagree on:
  - what happened
  - when it happened
  - how severe it was
  - which foundation template it touched
- that would degrade supervision while preserving a false appearance of stability

## Smallest safe patch

- add one shared watchtower anomaly parser in `src/hooks/bundled/lobster-brain-registry.ts`
- update current control-family consumers to use it
- do not change anomaly record writing semantics

## Files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `src/hooks/bundled/operating-weekly-review/handler.ts`
- `src/hooks/bundled/operating-daily-workface/handler.ts`
- `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
- `src/infra/operational-anomalies.test.ts`
- `src/hooks/bundled/operating-weekly-review/handler.test.ts`
- `src/hooks/bundled/operating-daily-workface/handler.test.ts`
- `src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`

## Behavior change

- anomaly consumers now share one parser for watchtower JSON records
- date-key extraction for anomaly freshness now comes from the same parsed contract
- control-family readers no longer each guess their own default field handling

## Proof tests

- `corepack pnpm exec vitest run src/infra/operational-anomalies.test.ts src/hooks/bundled/operating-weekly-review/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.test.ts src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/lobster-brain-registry.ts src/infra/operational-anomalies.ts src/hooks/bundled/operating-weekly-review/handler.ts src/hooks/bundled/operating-daily-workface/handler.ts src/hooks/bundled/memory-hygiene-weekly/handler.ts src/infra/operational-anomalies.test.ts src/hooks/bundled/operating-weekly-review/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.test.ts src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`
- `corepack pnpm exec tsx -e \"...parseWatchtowerAnomalyRecord...\"`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

This is a development-repo contract hardening step, not a live-runtime migration claim.
