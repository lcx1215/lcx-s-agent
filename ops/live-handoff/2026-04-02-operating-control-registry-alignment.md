# Operating / Control Registry Alignment

## Exact failure mode

- The operating / control family was still weaker than learning, frontier, and fundamental on artifact-contract discipline.
- These files were still hand-writing the same weekly artifact names and paths in multiple places:
  - `src/hooks/bundled/operating-weekly-review/handler.ts`
  - `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`
  - matching tests
- That meant future renames could drift producer, consumer, and tests separately.

## Why dangerous

- This is a control-plane seam, not cosmetic naming.
- If operating/control artifact names drift, daily workface can silently miss scorecards or hygiene ledgers even when producers still write them.
- That would recreate the same kind of maintenance debt already removed from learning, frontier, and fundamental.

## Smallest safe patch

- Extend `src/hooks/bundled/lobster-brain-registry.ts` with operating/control artifact builders.
- Update only the affected handlers/tests to consume those builders.
- Do not change artifact content, review logic, or wider routing.

## Files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `src/hooks/bundled/operating-weekly-review/handler.ts`
- `src/hooks/bundled/operating-weekly-review/handler.test.ts`
- `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
- `src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`
- `src/hooks/bundled/operating-daily-workface/handler.ts`
- `src/hooks/bundled/operating-daily-workface/handler.test.ts`

## Behavior change

- weekly review artifact filenames now come from the shared registry
- memory-hygiene relative paths now come from the shared registry
- daily workface now resolves portfolio scorecards through the same registry-backed matcher
- tests no longer duplicate the canonical filenames/paths

## Proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/operating-weekly-review/handler.test.ts src/hooks/bundled/memory-hygiene-weekly/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.test.ts src/hooks/bundled/operating-loop/handler.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/lobster-brain-registry.ts src/hooks/bundled/operating-weekly-review/handler.ts src/hooks/bundled/operating-weekly-review/handler.test.ts src/hooks/bundled/memory-hygiene-weekly/handler.ts src/hooks/bundled/memory-hygiene-weekly/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.ts src/hooks/bundled/operating-daily-workface/handler.test.ts`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

This is a development-repo contract hardening step. It is not a live-runtime migration claim.
