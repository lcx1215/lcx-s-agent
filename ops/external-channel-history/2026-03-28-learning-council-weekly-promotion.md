# Learning Council Weekly Promotion

## Exact failure mode

- bounded Feishu `learning-council` artifacts were written into `memory/`
- but `src/hooks/bundled/learning-review-weekly/handler.ts` only promoted `*-review-*.md`
- result:
  - the user could teach Lobster through Feishu
  - the note existed
  - weekly durable learning memory could still miss it

## Why dangerous

- this breaks the long-horizon training contract
- it makes `learning-council` look useful in the moment while silently skipping durable weekly promotion

## Smallest safe patch

- teach `learning-review-weekly` to parse bounded `*-learning-council-*.md` artifacts
- reuse existing:
  - `inferTopic(...)`
  - `reviewHintsForTopic(...)`
  - `foundationTemplateForTopic(...)`
- do not invent a second council-specific weekly memory path

## Proof

- `corepack pnpm exec vitest run src/hooks/bundled/learning-review-weekly/handler.test.ts src/hooks/bundled/learning-review/handler.test.ts src/hooks/bundled/learning-review-bootstrap/handler.test.ts src/agents/system-prompt.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/learning-review-weekly/handler.ts src/hooks/bundled/learning-review-weekly/handler.test.ts src/hooks/bundled/learning-review/handler.ts src/hooks/bundled/learning-review/handler.test.ts src/hooks/bundled/learning-review-bootstrap/handler.ts src/hooks/bundled/learning-review-bootstrap/handler.test.ts src/agents/system-prompt.ts src/agents/system-prompt.test.ts`

## Status

- `dev-fixed: yes`
- `live-fixed: no`
