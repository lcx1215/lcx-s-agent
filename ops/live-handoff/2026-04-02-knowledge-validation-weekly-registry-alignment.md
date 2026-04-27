# Knowledge Validation Weekly Registry Alignment

## Exact failure mode

- `knowledge-validation-weekly` was still using a handwritten weekly artifact filename.
- `operating-daily-workface` was separately using a handwritten regex to discover the latest weekly validation artifact.
- matching tests were also copying the filename directly.
- This kept the producer, consumer, and tests on separate filename contracts.

## Why dangerous

- `knowledge-validation-weekly` feeds the validation radar inside the operating control surface.
- If its filename drifts, the system can silently lose:
  - strongest-domain summary
  - weakest-domain summary
  - hallucination-watch summary
- That would degrade supervision quality while still looking superficially healthy.

## Smallest safe patch

- Add a registry-backed builder and matcher for `knowledge-validation-weekly`.
- Update only:
  - `src/hooks/bundled/knowledge-validation-weekly/handler.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - matching tests
- Do not change report content, scoring rules, or wider control routing.

## Files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `src/hooks/bundled/knowledge-validation-weekly/handler.ts`
- `src/hooks/bundled/knowledge-validation-weekly/handler.test.ts`
- `src/hooks/bundled/operating-daily-workface/handler.ts`
- `src/hooks/bundled/operating-daily-workface/handler.test.ts`

## Behavior change

- `knowledge-validation-weekly` now writes its weekly report through the shared registry
- `operating-daily-workface` now reads the latest weekly validation artifact through the same registry-backed matcher
- tests now use the canonical builder instead of duplicating the filename

## Proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/knowledge-validation-weekly/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.test.ts src/hooks/bundled/operating-loop/handler.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/lobster-brain-registry.ts src/hooks/bundled/knowledge-validation-weekly/handler.ts src/hooks/bundled/knowledge-validation-weekly/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.ts src/hooks/bundled/operating-daily-workface/handler.test.ts`
- `corepack pnpm exec tsx -e "...buildKnowledgeValidationWeeklyArtifactFilename...isKnowledgeValidationWeeklyArtifactFilename..."`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

This is a development-repo contract hardening step, not a live-runtime migration claim.
