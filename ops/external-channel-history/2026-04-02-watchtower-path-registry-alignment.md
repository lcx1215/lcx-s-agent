# Watchtower Path Registry Alignment

## Exact failure mode

- watchtower artifact directories and relative paths were still duplicated across multiple subsystems:
  - `src/infra/operational-anomalies.ts`
  - `src/hooks/bundled/correction-loop/handler.ts`
  - `src/hooks/bundled/operating-weekly-review/handler.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
  - related tests
- this included:
  - anomaly directory
  - repair-ticket directory
  - anomaly record path shape
  - anomaly-generated repair-ticket path shape
  - correction-loop repair-ticket path shape

## Why dangerous

- watchtower is a shared control-plane substrate.
- if these paths drift, the system can silently break cross-surface visibility between:
  - anomaly recording
  - repeated issue escalation
  - weekly operating summaries
  - daily workface watchtower views
  - memory-hygiene anti-pattern extraction
- that would recreate multi-surface state drift in a high-value supervision seam.

## Smallest safe patch

- add shared watchtower path helpers in the brain registry
- update only current producers/consumers/tests to use them
- do not change anomaly content, repair-ticket semantics, or escalation thresholds

## Files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `src/infra/operational-anomalies.ts`
- `src/infra/operational-anomalies.test.ts`
- `src/hooks/bundled/correction-loop/handler.ts`
- `src/hooks/bundled/correction-loop/handler.test.ts`
- `src/hooks/bundled/operating-weekly-review/handler.ts`
- `src/hooks/bundled/operating-weekly-review/handler.test.ts`
- `src/hooks/bundled/operating-daily-workface/handler.ts`
- `src/hooks/bundled/operating-daily-workface/handler.test.ts`
- `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
- `src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`
- `src/hooks/bundled/fundamental-artifact-errors.test.ts`

## Behavior change

- watchtower anomaly and repair-ticket directory names now come from one shared registry
- anomaly record and anomaly-generated repair-ticket relative paths now come from one shared registry
- correction-loop repair-ticket paths now also use the shared registry
- current control-family consumers now point at the same watchtower directories instead of hardcoding them

## Proof tests

- `corepack pnpm exec vitest run src/infra/operational-anomalies.test.ts src/hooks/bundled/correction-loop/handler.test.ts src/hooks/bundled/operating-weekly-review/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.test.ts src/hooks/bundled/memory-hygiene-weekly/handler.test.ts src/hooks/bundled/fundamental-artifact-errors.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/lobster-brain-registry.ts src/infra/operational-anomalies.ts src/infra/operational-anomalies.test.ts src/hooks/bundled/correction-loop/handler.ts src/hooks/bundled/correction-loop/handler.test.ts src/hooks/bundled/operating-weekly-review/handler.ts src/hooks/bundled/operating-weekly-review/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.ts src/hooks/bundled/operating-daily-workface/handler.test.ts src/hooks/bundled/memory-hygiene-weekly/handler.ts src/hooks/bundled/memory-hygiene-weekly/handler.test.ts src/hooks/bundled/fundamental-artifact-errors.test.ts`
- `corepack pnpm exec tsx -e \"...buildWatchtowerArtifactDir...buildWatchtowerAnomalyRecordRelativePath...buildWatchtowerAnomalyRepairTicketRelativePath...buildCorrectionLoopRepairTicketRelativePath...\"`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

This is a development-repo contract hardening step, not a live-runtime migration claim.
