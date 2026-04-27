# lobster-workface contract alignment

## exact failure mode

- `src/hooks/bundled/operating-daily-workface/handler.ts` wrote `lobster-workface` markdown.
- `extensions/feishu/src/bot.ts` parsed top metrics, validation radar, and lane panel with its own regexes.
- `src/hooks/bundled/memory-hygiene-weekly/handler.ts` separately hardcoded the workface filename pattern for TTL/pruning.

That left one writer with multiple ad-hoc readers and another duplicate filename contract.

## why dangerous

- This is a shared control-surface seam between daily supervision and Feishu summaries.
- If workface headings, labels, or filename shape drift, the user-facing daily brief can silently diverge from the actual workface artifact.
- That would keep the system looking stable while its control summary already drifted.

## smallest safe patch

- Added shared `lobster-workface` filename builder/parser plus artifact renderer/parser in `src/hooks/bundled/lobster-brain-registry.ts`.
- Routed `operating-daily-workface` writing through the shared renderer and filename builder.
- Routed Feishu bot daily-brief summary through the shared parser.
- Routed memory-hygiene TTL/prune logic through the shared filename parser.
- Updated Feishu workface fixtures to use the shared workface renderer.

## files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `src/hooks/bundled/operating-daily-workface/handler.ts`
- `src/hooks/bundled/memory-hygiene-weekly/handler.ts`
- `extensions/feishu/src/bot.ts`
- `extensions/feishu/src/bot.test.ts`
- `memory/current_state.md`
- `ops/codex_handoff.md`

## proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/operating-daily-workface/handler.test.ts src/hooks/bundled/memory-hygiene-weekly/handler.test.ts extensions/feishu/src/bot.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/lobster-brain-registry.ts src/hooks/bundled/operating-daily-workface/handler.ts src/hooks/bundled/operating-daily-workface/handler.test.ts src/hooks/bundled/memory-hygiene-weekly/handler.ts extensions/feishu/src/bot.ts extensions/feishu/src/bot.test.ts`
- `corepack pnpm exec tsx -e "...buildLobsterWorkfaceFilename...renderLobsterWorkfaceArtifact...parseLobsterWorkfaceArtifact..."`
- `git diff --check`

## status

- `dev-fixed: yes`
- `live-fixed: no`
