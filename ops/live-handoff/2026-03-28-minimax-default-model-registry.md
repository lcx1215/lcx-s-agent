# MiniMax Default Model Registry

## Exact failure mode

- core MiniMax defaults were still scattered across:
  - provider build
  - onboarding
  - auth-choice
  - portal plugin
- changing the default model meant editing multiple `MiniMax-M2.5` literals

## Why dangerous

- this is the kind of config drift that becomes expensive later
- it also makes future verified MiniMax upgrades harder than they need to be

## Smallest safe patch

- add one shared resolver:
  - `src/agents/minimax-model-catalog.ts`
- use it in:
  - `src/agents/models-config.providers.ts`
  - `src/commands/onboard-auth.models.ts`
  - `src/commands/onboard-auth.config-minimax.ts`
  - `src/commands/auth-choice.apply.minimax.ts`
  - `extensions/minimax-portal-auth/index.ts`
- add bounded env override:
  - `OPENCLAW_MINIMAX_DEFAULT_MODEL`

## Important boundary

- this does **not** silently hard-switch the repo default to `MiniMax-M2.7`
- it makes the default-model seam single-source and overrideable once the operator wants to point the system at a verified runtime model

## Proof

- `corepack pnpm exec vitest run src/agents/minimax-model-catalog.test.ts src/agents/models-config.providers.nvidia.test.ts src/commands/auth-choice.apply.minimax.test.ts`
- `corepack pnpm exec oxlint src/agents/minimax-model-catalog.ts src/agents/minimax-model-catalog.test.ts src/commands/onboard-auth.models.ts src/commands/onboard-auth.config-minimax.ts src/commands/auth-choice.apply.minimax.ts src/commands/auth-choice.apply.minimax.test.ts src/agents/models-config.providers.ts src/agents/models-config.providers.nvidia.test.ts extensions/minimax-portal-auth/index.ts`
- `pnpm build`

## Status

- `dev-fixed: yes`
- `live-fixed: no`
