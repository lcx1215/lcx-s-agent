# Repair Ticket Schema Alignment

## Exact failure mode

- repair-ticket markdown still had a split contract:
  - `src/infra/operational-anomalies.ts` rendered one form
  - `src/hooks/bundled/correction-loop/handler.ts` rendered another form
  - `src/hooks/bundled/operating-weekly-review/handler.ts` scraped tickets with its own regexes
  - tests used partial hand-written fixtures
- this meant shared supervision was still depending on duplicated markdown assumptions instead of one canonical ticket contract

## Why dangerous

- repair tickets are the bridge between repeated failures and bounded repair work
- if their schema drifts, weekly operating review can silently lose active repair-ticket visibility even while tickets still exist on disk
- that weakens the control plane exactly where the system should become more self-correcting

## Smallest safe patch

- add one shared repair-ticket renderer/parser contract in `src/hooks/bundled/lobster-brain-registry.ts`
- update only:
  - current producers
  - weekly consumer
  - directly related tests
- do not change escalation thresholds, anomaly semantics, or correction-note logic

## Files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `src/infra/operational-anomalies.ts`
- `src/infra/operational-anomalies.test.ts`
- `src/hooks/bundled/correction-loop/handler.ts`
- `src/hooks/bundled/correction-loop/handler.test.ts`
- `src/hooks/bundled/operating-weekly-review/handler.ts`
- `src/hooks/bundled/operating-weekly-review/handler.test.ts`
- `src/hooks/bundled/fundamental-artifact-errors.test.ts`

## Behavior change

- both repair-ticket producers now render through the same shared contract
- operating weekly review now parses repair tickets through the same shared parser instead of ad-hoc regex scraping
- tests now validate that the shared parser can consume both producer outputs

## Proof tests

- `corepack pnpm exec vitest run src/infra/operational-anomalies.test.ts src/hooks/bundled/correction-loop/handler.test.ts src/hooks/bundled/operating-weekly-review/handler.test.ts src/hooks/bundled/fundamental-artifact-errors.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/lobster-brain-registry.ts src/infra/operational-anomalies.ts src/infra/operational-anomalies.test.ts src/hooks/bundled/correction-loop/handler.ts src/hooks/bundled/correction-loop/handler.test.ts src/hooks/bundled/operating-weekly-review/handler.ts src/hooks/bundled/operating-weekly-review/handler.test.ts src/hooks/bundled/fundamental-artifact-errors.test.ts`
- `corepack pnpm exec tsx -e \"...renderRepairTicketArtifact...parseRepairTicketArtifact...\"`
- `git diff --check`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

This is a development-repo contract hardening step, not a live-runtime migration claim.
