# Knowledge Validation Note Parser Alignment

## Exact failure mode

- `knowledge-validation` source notes were still parsed in multiple places with separate regex and field scraping:
  - `src/hooks/bundled/knowledge-validation-weekly/handler.ts`
  - `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
- that meant filename/date handling, hallucination-risk handling, verdict handling, and candidate extraction could drift.

## Why dangerous

- these notes feed supervision, quarantine, and weekly validation summaries
- if readers drift, the system can disagree with itself about whether the same note was:
  - in scope this week
  - risky enough to quarantine
  - carrying a correction candidate
  - carrying a repair-ticket candidate

## Smallest safe patch

- add one shared parser and filename contract for knowledge-validation source notes in `src/hooks/bundled/lobster-brain-registry.ts`
- route current producer/consumer handlers through it
- update current tests to use the shared note filename builder

## Files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `src/hooks/bundled/knowledge-validation-weekly/handler.ts`
- `src/hooks/bundled/knowledge-validation-weekly/handler.test.ts`
- `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
- `src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`

## Behavior change

- knowledge-validation weekly summaries now load source notes through one shared parser
- memory-hygiene rejected/quarantine logic now reads verdict and hallucination risk from the same shared parser
- current tests no longer handwrite source note filenames

## Proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/knowledge-validation-weekly/handler.test.ts src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/lobster-brain-registry.ts src/hooks/bundled/knowledge-validation-weekly/handler.ts src/hooks/bundled/knowledge-validation-weekly/handler.test.ts src/hooks/bundled/memory-hygiene-weekly/handler.ts src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`
- `corepack pnpm exec tsx -e \"...buildKnowledgeValidationNoteFilename...parseKnowledgeValidationNote...\"`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

This is a development-repo contract hardening step, not a live-runtime migration claim.
