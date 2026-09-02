# Runtime Default MiniMax Preference

## Exact failure mode

- The repo already knew:
  - MiniMax built-in default text model = `MiniMax-M2.7`
  - onboarding should write MiniMax defaults cleanly
- But empty-config runtime paths still fell back to:
  - `anthropic/claude-opus-4-6`
- That meant Lobster could look MiniMax-ready in onboarding and catalogs while still quietly using Anthropic as the built-in runtime fallback.

## Why dangerous

- It weakens the user's explicit goal of making Lobster use MiniMax heavily.
- It creates split reality between:
  - onboarding defaults
  - runtime defaults
  - user-facing status/model surfaces

## Smallest safe patch

- Keep explicit config highest priority.
- Only change the empty-config built-in fallback.
- Add one shared runtime default resolver in:
  - `src/agents/defaults.ts`
- Route key runtime/status surfaces through it.

## Files changed

- `src/agents/defaults.ts`
- `src/agents/defaults.test.ts`
- `src/agents/model-selection.ts`
- `src/agents/model-selection.test.ts`
- `src/agents/tools/model-config.helpers.ts`
- `src/auto-reply/reply/commands-models.ts`
- `src/auto-reply/status.ts`
- `src/auto-reply/commands-registry.ts`
- `src/commands/status.summary.ts`
- `src/commands/models/list.configured.ts`
- `src/commands/models/list.status-command.ts`
- `src/commands/doctor.ts`
- `src/gateway/server-startup.ts`

## Behavior change

- If MiniMax runtime credentials already exist:
  - `MINIMAX_API_KEY` -> built-in runtime default becomes `minimax/MiniMax-M2.7`
  - `MINIMAX_OAUTH_TOKEN` without API key -> built-in runtime default becomes `minimax-portal/MiniMax-M2.7`
- Explicit config still wins over this fallback.
- Status/model surfaces now report the same default reality instead of stale Anthropic fallback assumptions.

## Proof tests

- `corepack pnpm exec vitest run src/agents/defaults.test.ts src/agents/model-selection.test.ts src/agents/minimax-model-catalog.test.ts src/auto-reply/commands-registry.test.ts src/auto-reply/status.test.ts src/commands/status.summary.redaction.test.ts src/commands/models/list.status.test.ts`
- `corepack pnpm exec oxlint src/agents/defaults.ts src/agents/defaults.test.ts src/agents/model-selection.ts src/agents/model-selection.test.ts src/agents/tools/model-config.helpers.ts src/auto-reply/reply/commands-models.ts src/auto-reply/status.ts src/auto-reply/commands-registry.ts src/commands/status.summary.ts src/commands/models/list.configured.ts src/commands/models/list.status-command.ts src/commands/doctor.ts src/gateway/server-startup.ts`
- `corepack pnpm exec tsx -e "...resolveBuiltInDefaultModelRef..."`
- `git diff --check`

## Status

- `dev-fixed: yes`
- `live-fixed: no`
