# portfolio-answer-scorecard and knowledge-validation-weekly contract alignment

## exact failure mode

- `src/hooks/bundled/operating-weekly-review/handler.ts` wrote `portfolio-answer-scorecard` markdown.
- `src/hooks/bundled/knowledge-validation-weekly/handler.ts` wrote `knowledge-validation-weekly` markdown.
- `src/hooks/bundled/operating-daily-workface/handler.ts` and `extensions/feishu/src/bot.ts` each parsed those artifacts with their own regexes.

That left one writer with two independent readers on each artifact family.

## why dangerous

- This is control-plane drift, not cosmetic duplication.
- If the weekly artifact format changes, daily workface and Feishu summaries can silently disagree about the same scorecard or validation radar.
- That would dirty the supervision surface while still looking stable.

## smallest safe patch

- Added shared renderer/parser contracts in `src/hooks/bundled/lobster-brain-registry.ts` for:
  - `portfolio-answer-scorecard`
  - `knowledge-validation-weekly`
- Routed writers through the shared renderers.
- Routed `operating-daily-workface` and Feishu bot summaries through the shared parsers.
- Updated targeted tests and fixtures to use the shared contract.

## files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `src/hooks/bundled/knowledge-validation-weekly/handler.ts`
- `src/hooks/bundled/knowledge-validation-weekly/handler.test.ts`
- `src/hooks/bundled/operating-weekly-review/handler.ts`
- `src/hooks/bundled/operating-weekly-review/handler.test.ts`
- `src/hooks/bundled/operating-daily-workface/handler.ts`
- `src/hooks/bundled/operating-daily-workface/handler.test.ts`
- `extensions/feishu/src/bot.ts`
- `extensions/feishu/src/bot.test.ts`
- `memory/current_state.md`
- `ops/codex_handoff.md`

## proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/knowledge-validation-weekly/handler.test.ts src/hooks/bundled/operating-weekly-review/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.test.ts extensions/feishu/src/bot.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/lobster-brain-registry.ts src/hooks/bundled/knowledge-validation-weekly/handler.ts src/hooks/bundled/knowledge-validation-weekly/handler.test.ts src/hooks/bundled/operating-weekly-review/handler.ts src/hooks/bundled/operating-weekly-review/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.ts src/hooks/bundled/operating-daily-workface/handler.test.ts extensions/feishu/src/bot.ts extensions/feishu/src/bot.test.ts`
- `corepack pnpm exec tsx -e "...renderPortfolioAnswerScorecardArtifact...parsePortfolioAnswerScorecardArtifact...renderKnowledgeValidationWeeklyArtifact...parseKnowledgeValidationWeeklyArtifact..."`
- `git diff --check`

## status

- `dev-fixed: yes`
- `live-fixed: no`
