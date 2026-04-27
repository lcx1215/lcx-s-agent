# Correction Note Registry Alignment

## Exact failure mode

- `correction-loop` was writing correction-note artifact filenames with handwritten string construction.
- repeat detection inside `correction-loop` was using a loose `includes("correction-note")` check.
- consumers were separately maintaining their own correction-note regexes:
  - `operating-weekly-review`
  - `operating-daily-workface`
  - `memory-hygiene-weekly`
- matching tests were also copying correction-note filenames or substring checks.

## Why dangerous

- Correction notes are a shared control-plane artifact.
- If that filename contract drifts, the system can silently lose:
  - repeat-issue counting
  - weekly correction summaries
  - daily workface correction visibility
  - memory-hygiene provisional tracking
- That would corrupt supervision and self-correction surfaces at once.

## Smallest safe patch

- Add one shared correction-note builder/parser/matcher in the brain registry.
- Update only:
  - producer
  - repeat detection
  - current consumers
  - directly related tests
- Do not change correction content, repair-ticket logic, or anomaly semantics.

## Files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `src/hooks/bundled/correction-loop/handler.ts`
- `src/hooks/bundled/correction-loop/handler.test.ts`
- `src/hooks/bundled/operating-weekly-review/handler.ts`
- `src/hooks/bundled/operating-weekly-review/handler.test.ts`
- `src/hooks/bundled/operating-daily-workface/handler.ts`
- `src/hooks/bundled/operating-daily-workface/handler.test.ts`
- `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
- `src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`

## Behavior change

- correction-note filenames now come from the shared registry
- repeat detection now parses canonical correction-note filenames instead of using substring matching
- operating weekly, daily workface, and memory hygiene now all consume the same parser for correction-note dates
- tests no longer depend on handwritten correction-note filenames or loose substring checks

## Proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/correction-loop/handler.test.ts src/hooks/bundled/operating-weekly-review/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.test.ts src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/lobster-brain-registry.ts src/hooks/bundled/correction-loop/handler.ts src/hooks/bundled/correction-loop/handler.test.ts src/hooks/bundled/operating-weekly-review/handler.ts src/hooks/bundled/operating-weekly-review/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.ts src/hooks/bundled/operating-daily-workface/handler.test.ts src/hooks/bundled/memory-hygiene-weekly/handler.ts src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`
- `corepack pnpm exec tsx -e "...buildCorrectionNoteFilename...parseCorrectionNoteFilename...isCorrectionNoteFilename..."`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

This is a development-repo contract hardening step, not a live-runtime migration claim.
