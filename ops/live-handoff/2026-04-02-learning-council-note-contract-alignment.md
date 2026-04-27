# Learning Council Note Contract Alignment

## Exact failure mode

- Feishu `learning-council` wrote bounded memory notes in one place, but current consumers still parsed them ad hoc:
  - `extensions/feishu/src/learning-council.ts`
  - `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - `src/hooks/bundled/learning-review-weekly/handler.ts`
- that meant filename/date handling, status extraction, user-message extraction, and final-reply extraction could drift.

## Why dangerous

- these notes are the bridge between Feishu learning and Lobster's durable dev-side memory loops
- if writer and readers drift, the system can silently disagree on:
  - what was learned
  - whether it should stay provisional
  - whether it should appear in daily workface
  - whether it should be promoted into weekly learning memory

## Smallest safe patch

- add one shared learning-council note filename/render/parser contract in `src/hooks/bundled/lobster-brain-registry.ts`
- route the Feishu writer plus current dev-side consumers through it
- update current tests to use the same shared note contract

## Files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `extensions/feishu/src/learning-council.ts`
- `extensions/feishu/src/learning-council.test.ts`
- `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
- `src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`
- `src/hooks/bundled/operating-daily-workface/handler.ts`
- `src/hooks/bundled/operating-daily-workface/handler.test.ts`
- `src/hooks/bundled/learning-review-weekly/handler.ts`
- `src/hooks/bundled/learning-review-weekly/handler.test.ts`

## Behavior change

- Feishu learning-council notes now use one shared filename and markdown contract
- memory-hygiene provisional handling now reads learning-council note status through the shared parser
- operating-daily-workface fallback now reads learning-council note status/user-message through the shared parser
- learning-review-weekly promotion now reads user-message/final-reply through the shared parser
- current tests no longer handwrite note fixtures independently

## Proof tests

- `corepack pnpm exec vitest run extensions/feishu/src/learning-council.test.ts src/hooks/bundled/memory-hygiene-weekly/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.test.ts src/hooks/bundled/learning-review-weekly/handler.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/lobster-brain-registry.ts extensions/feishu/src/learning-council.ts extensions/feishu/src/learning-council.test.ts src/hooks/bundled/memory-hygiene-weekly/handler.ts src/hooks/bundled/memory-hygiene-weekly/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.ts src/hooks/bundled/operating-daily-workface/handler.test.ts src/hooks/bundled/learning-review-weekly/handler.ts src/hooks/bundled/learning-review-weekly/handler.test.ts`
- `corepack pnpm exec tsx -e \"...buildLearningCouncilMemoryNoteFilename...renderLearningCouncilMemoryNote...parseLearningCouncilMemoryNote...\"`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

This is a development-repo contract hardening step, not a live-runtime migration claim.
