# Learning Durable Skill Memory

- Scope: dev-repo-only memory hardening for learning artifacts.
- Objective: stop math / quant / coding study from collapsing into short-lived review traces only.

## Exact failure mode

- `src/hooks/bundled/learning-review/handler.ts` only recognized a narrow set of math topics, so quant / volatility / coding study often collapsed into `math-reasoning`.
- `src/hooks/bundled/learning-review-weekly/handler.ts` only produced weekly review + upgrade notes, which preserved short-horizon reinforcement but did not create a durable reusable skill memory.

## Why this was dangerous

- Users could study quant, code, or math-heavy material and still lose the practical method after the weekly window rolled over.
- The system looked like it had learning artifacts, but not like it had durable reusable study memory.

## Smallest safe patch

- Expand `learning-review` topic detection to classify:
  - `time-series-and-volatility`
  - `quant-modeling`
  - `coding-and-systems`
- Keep `learning-review-weekly` bounded, but add two cumulative artifacts:
  - `*-learning-long-term-catalog.md`
  - `*-learning-durable-skills.md`

## Files changed

- `src/hooks/bundled/learning-review/handler.ts`
- `src/hooks/bundled/learning-review/handler.test.ts`
- `src/hooks/bundled/learning-review-weekly/handler.ts`
- `src/hooks/bundled/learning-review-weekly/handler.test.ts`
- `src/hooks/bundled/learning-review-weekly/HOOK.md`

## Behavior change

- Quant / volatility / coding study now gets its own topic family instead of falling into a generic math bucket.
- Weekly memory output now includes:
  - a broad cumulative topic catalog
  - a durable skill-memory note with default method, common failure, next drill, and transfer surface

## Proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/learning-review/handler.test.ts src/hooks/bundled/learning-review-weekly/handler.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/learning-review/handler.ts src/hooks/bundled/learning-review/handler.test.ts src/hooks/bundled/learning-review-weekly/handler.ts src/hooks/bundled/learning-review-weekly/handler.test.ts src/hooks/bundled/learning-review-weekly/HOOK.md`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Out of scope

- This does not change live runtime behavior yet.
- This does not make every learned topic a top-level working-memory anchor.
- This does not replace future lane-scoped workspace propagation or live learning recall validation.
