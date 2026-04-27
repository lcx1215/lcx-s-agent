# User-Facing Simple Language And MiniMax M2.7 Default

## Exact failure mode

- user-facing Lobster replies still relied mostly on general doctrine like "simple summary first", but the global agent prompt did not explicitly enforce short, plain-language communication as a first-class contract.
- MiniMax support existed, but the repo-wide built-in default text model was still `MiniMax-M2.5`, and one non-interactive onboarding path still hardcoded normal MiniMax API setup to `MiniMax-M2.5`.

## Why dangerous

- without an explicit communication contract, the system can keep sounding too dense or too internal for the operator even when the underlying reasoning is good.
- without a single MiniMax default seam, the repo can split between:
  - one path using the newer default
  - another path still silently pinning `M2.5`

## Smallest safe patch

- add one explicit user-facing communication section to the global agent system prompt
- switch the built-in MiniMax default text model to `MiniMax-M2.7`
- keep non-lightning MiniMax onboarding paths on the same shared default resolver
- update only the tests that actually depended on the old default contract

## Files changed

- `src/agents/system-prompt.ts`
- `src/agents/system-prompt.test.ts`
- `src/agents/minimax-model-catalog.ts`
- `src/commands/onboard-non-interactive/local/auth-choice.ts`
- `src/commands/auth-choice.apply.minimax.test.ts`
- `src/commands/onboard-auth.test.ts`
- `src/commands/onboard-non-interactive.provider-auth.test.ts`
- `src/agents/models-config.skips-writing-models-json-no-env-token.test.ts`

## Behavior change

- Lobster now has an explicit global contract to answer the operator in simpler, shorter, more direct language by default.
- internal reasoning and internal memory structure are unchanged.
- the built-in MiniMax default text model is now `MiniMax-M2.7`.
- current normal MiniMax API onboarding paths now follow the shared default resolver instead of hardcoding `MiniMax-M2.5`.

## Proof tests

- `corepack pnpm exec vitest run src/agents/system-prompt.test.ts src/agents/minimax-model-catalog.test.ts src/commands/auth-choice.apply.minimax.test.ts src/commands/onboard-auth.test.ts src/commands/onboard-non-interactive.provider-auth.test.ts src/agents/models-config.skips-writing-models-json-no-env-token.test.ts extensions/feishu/src/learning-council.test.ts src/hooks/bundled/memory-hygiene-weekly/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.test.ts src/hooks/bundled/learning-review-weekly/handler.test.ts`
- `corepack pnpm exec oxlint src/agents/system-prompt.ts src/agents/system-prompt.test.ts src/agents/minimax-model-catalog.ts src/agents/minimax-model-catalog.test.ts src/commands/auth-choice.apply.minimax.ts src/commands/auth-choice.apply.minimax.test.ts src/commands/onboard-auth.models.ts src/commands/onboard-auth.test.ts src/commands/onboard-non-interactive/local/auth-choice.ts src/commands/onboard-non-interactive.provider-auth.test.ts src/agents/models-config.skips-writing-models-json-no-env-token.test.ts extensions/feishu/src/learning-council.ts extensions/feishu/src/learning-council.test.ts src/hooks/bundled/lobster-brain-registry.ts src/hooks/bundled/memory-hygiene-weekly/handler.ts src/hooks/bundled/memory-hygiene-weekly/handler.test.ts src/hooks/bundled/operating-daily-workface/handler.ts src/hooks/bundled/operating-daily-workface/handler.test.ts src/hooks/bundled/learning-review-weekly/handler.ts src/hooks/bundled/learning-review-weekly/handler.test.ts`
- `corepack pnpm exec tsx -e \"...resolveMinimaxDefaultTextModelId...resolveMinimaxTextModelCatalog...\"`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

This is a development-repo contract hardening step, not a live-runtime migration claim.
