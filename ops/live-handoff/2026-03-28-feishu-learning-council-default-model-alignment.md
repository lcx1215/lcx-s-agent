# 2026-03-28 feishu learning council default-model alignment

## Exact failure mode

`extensions/feishu/src/learning-council.ts` had already gained a local MiniMax override seam:

- `OPENCLAW_LEARNING_COUNCIL_MINIMAX_MODEL`

but it still bypassed the new repo-wide default-model seam when no council-specific override was set.

The bug was subtle:

- `resolveMinimaxDefaultTextModelId()` was evaluated at module load time
- so later runtime changes to:
  - `OPENCLAW_MINIMAX_DEFAULT_MODEL`
    did not actually reach the Feishu learning-council MiniMax lane

That left Feishu on an older frozen default while the rest of the dev repo had already moved to the shared MiniMax model registry.

## Why it was dangerous

- Feishu could silently lag behind the latest dev MiniMax/default-model contract
- operator training through Feishu would not actually exercise the same default-model seam as onboarding, auth-choice, provider build, and portal auth
- future MiniMax bumps could look repo-clean while Feishu still used an older frozen default

## Smallest safe patch

- remove the module-load freeze
- resolve the MiniMax default model at call time inside `resolveLearningCouncilModel("minimax")`
- keep the bounded council-specific override:
  - `OPENCLAW_LEARNING_COUNCIL_MINIMAX_MODEL`
- preserve the repo-wide default seam:
  - `OPENCLAW_MINIMAX_DEFAULT_MODEL`

## Files changed

- `extensions/feishu/src/learning-council.ts`
- `extensions/feishu/src/learning-council.test.ts`

## Proof tests

- `corepack pnpm exec vitest run extensions/feishu/src/learning-council.test.ts`
- `corepack pnpm exec vitest run extensions/feishu/src/learning-council.test.ts extensions/feishu/src/bot.test.ts extensions/feishu/src/feishu-command-handler.test.ts`
- `corepack pnpm exec oxlint extensions/feishu/src/learning-council.ts extensions/feishu/src/learning-council.test.ts extensions/feishu/src/bot.test.ts extensions/feishu/src/feishu-command-handler.test.ts`
- `pnpm build`

## Behavior change

Feishu learning-council now shares the same default MiniMax model seam as the rest of the dev repo.

Current verified behavior:

- council-specific override still wins:
  - `OPENCLAW_LEARNING_COUNCIL_MINIMAX_MODEL`
- otherwise Feishu falls back to the repo-wide default:
  - `OPENCLAW_MINIMAX_DEFAULT_MODEL`

## Explicit status

- `dev-fixed: yes`
- `live-fixed: no`
