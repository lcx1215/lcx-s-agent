# Learning Review Contract Alignment

## Exact failure mode

- `src/hooks/bundled/learning-review/handler.ts` wrote learning-review notes.
- `src/hooks/bundled/learning-review-weekly/handler.ts` parsed them with one local regex set.
- `src/hooks/bundled/operating-daily-workface/handler.ts` parsed them with another local regex set.

This left the same learning-review artifact with one writer and two drifting readers.

## Why dangerous

- weekly learning rollups and daily workface could silently disagree about the same learning session
- later review-note shape changes would require three manual edits instead of one
- the operating control surface could drift before the learning writer itself looks obviously broken

## Smallest safe patch

- add one shared learning-review filename/parser/renderer contract to:
  - `src/hooks/bundled/lobster-brain-registry.ts`
- route the writer through it:
  - `src/hooks/bundled/learning-review/handler.ts`
- route both current readers through it:
  - `src/hooks/bundled/learning-review-weekly/handler.ts`
  - `src/hooks/bundled/operating-daily-workface/handler.ts`

## Files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `src/hooks/bundled/learning-review/handler.ts`
- `src/hooks/bundled/learning-review-weekly/handler.ts`
- `src/hooks/bundled/operating-daily-workface/handler.ts`
- `memory/current_state.md`
- `ops/codex_handoff.md`

## Behavior change

- learning-review notes now have one shared writer/reader contract
- weekly learning and daily workface now consume the same parsed review shape
- operating-daily-workface seven-day counters also stopped depending on a removed local regex constant

## Proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/learning-review/handler.test.ts src/hooks/bundled/learning-review-weekly/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/lobster-brain-registry.ts src/hooks/bundled/learning-review/handler.ts src/hooks/bundled/learning-review/handler.test.ts src/hooks/bundled/learning-review-weekly/handler.ts src/hooks/bundled/learning-review-weekly/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.ts src/hooks/bundled/operating-daily-workface/handler.test.ts`
- `git diff --check`

## Status

- `dev-fixed: yes`
- `live-fixed: no`
