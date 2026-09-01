# correction-note content contract alignment

## exact failure mode

- `src/hooks/bundled/correction-loop/handler.ts` wrote structured correction-note markdown.
- `src/hooks/bundled/operating-weekly-review/handler.ts` read `Issue Key / Foundation Template / What Was Wrong` with local regexes.
- `src/hooks/bundled/operating-daily-workface/handler.ts` did the same.
- `src/hooks/bundled/memory-hygiene-weekly/handler.ts` did the same again.

Only the filename had been unified before; the content contract still drifted across four places.

## why dangerous

- This is a self-correction control-plane seam.
- If the correction-note shape changes, weekly review, daily workface, and memory hygiene can silently disagree about the same correction.
- That would make the learning/correction loop look stable while supervision is already dirty.

## smallest safe patch

- Added shared `correction-note` renderer/parser in `src/hooks/bundled/lobster-brain-registry.ts`.
- Routed `correction-loop` writing through the shared renderer.
- Routed `operating-weekly-review`, `operating-daily-workface`, and `memory-hygiene-weekly` through the shared parser.
- Also changed repeated-note counting in `correction-loop` to compare parsed `issueKey` instead of raw string inclusion.
- Updated targeted fixtures/tests to use the shared correction-note renderer.

## files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `src/hooks/bundled/correction-loop/handler.ts`
- `src/hooks/bundled/correction-loop/handler.test.ts`
- `src/hooks/bundled/operating-weekly-review/handler.ts`
- `src/hooks/bundled/operating-daily-workface/handler.ts`
- `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
- `src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`
- `memory/current_state.md`
- `ops/codex_handoff.md`

## proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/correction-loop/handler.test.ts src/hooks/bundled/operating-weekly-review/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.test.ts src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/lobster-brain-registry.ts src/hooks/bundled/correction-loop/handler.ts src/hooks/bundled/correction-loop/handler.test.ts src/hooks/bundled/operating-weekly-review/handler.ts src/hooks/bundled/operating-weekly-review/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.ts src/hooks/bundled/operating-daily-workface/handler.test.ts src/hooks/bundled/memory-hygiene-weekly/handler.ts src/hooks/bundled/memory-hygiene-weekly/handler.test.ts`
- `corepack pnpm exec tsx -e "...renderCorrectionNoteArtifact...parseCorrectionNoteArtifact..."`
- `git diff --check`

## status

- `dev-fixed: yes`
- `live-fixed: no`
