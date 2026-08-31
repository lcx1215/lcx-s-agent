# Learning Trigger Layer Hardening

- Scope: dev-repo-only learning-memory hardening.
- Objective: move learned math / quant / coding memory from "stored skill" toward "default trigger cue".

## Exact failure mode

- Durable learning memory existed only as a stored reusable skill layer.
- Later tasks still lacked an explicit trigger map that said when to pull which skill.
- As a result, the system could still behave like a searchable archive instead of a default-calling study brain.

## Why this was dangerous

- Learned methods could remain passive unless the operator explicitly reminded the system.
- Math / quant / coding memory stayed closer to recall than to automatic application.

## Smallest safe patch

- Add a cumulative `learning-trigger-map` artifact in `learning-review-weekly`.
- Inject that trigger map into `learning-review-bootstrap`.
- Update the system prompt to route math / code / quant tasks through:
  - `learning-trigger-map`
  - then `learning-durable-skills`
  - then `learning-long-term-catalog`
  - then weekly upgrade / weekly review / raw review notes

## Files changed

- `src/hooks/bundled/learning-review-weekly/handler.ts`
- `src/hooks/bundled/learning-review-weekly/handler.test.ts`
- `src/hooks/bundled/learning-review-weekly/HOOK.md`
- `src/hooks/bundled/learning-review-bootstrap/handler.ts`
- `src/hooks/bundled/learning-review-bootstrap/handler.test.ts`
- `src/agents/system-prompt.ts`
- `src/agents/system-prompt.test.ts`

## Behavior change

- Weekly learning memory now writes a trigger-oriented artifact:
  - `*-learning-trigger-map.md`
- Bootstrap now surfaces:
  - `Learning Trigger Cue`
  - `Priority Learning Trigger Map`
- The agent system prompt now explicitly treats trigger maps as first-class study memory for math / code / quant tasks.

## Proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/learning-review/handler.test.ts src/hooks/bundled/learning-review-weekly/handler.test.ts src/hooks/bundled/learning-review-bootstrap/handler.test.ts src/agents/system-prompt.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/learning-review/handler.ts src/hooks/bundled/learning-review/handler.test.ts src/hooks/bundled/learning-review-weekly/handler.ts src/hooks/bundled/learning-review-weekly/handler.test.ts src/hooks/bundled/learning-review-weekly/HOOK.md src/hooks/bundled/learning-review-bootstrap/handler.ts src/hooks/bundled/learning-review-bootstrap/handler.test.ts src/agents/system-prompt.ts src/agents/system-prompt.test.ts`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Out of scope

- This does not change live runtime behavior yet.
- This is not full automatic cross-domain transfer.
- This does not replace future repeated-use / rehearsal / lane-workspace work.
