# Learning Relevance Gate Hardening

- Scope: dev-repo-only learning-memory hardening.
- Objective: add relevance weighting so learned skills are not all pulled with equal strength.

## Exact failure mode

- The repo already had:
  - durable skill memory
  - trigger-oriented memory
  - rehearsal-oriented memory
  - transfer-oriented memory
- But it still lacked an explicit relevance gate.
- This meant the system could know many methods but still treat them too uniformly during later recall.

## Why this was dangerous

- Human-like memory is not flat retrieval.
- Without relevance weighting, the system risks pulling too much weak memory too early, or failing to privilege strong repeated skills as default-call methods.

## Smallest safe patch

- Add a cumulative `learning-relevance-gate` artifact to `learning-review-weekly`.
- Inject it into `learning-review-bootstrap` via:
  - `Learning Relevance Cue`
  - `Priority Learning Relevance Gate`
- Update the agent system prompt so math / code / quant tasks now check:
  - `learning-relevance-gate`
  - `learning-trigger-map`
  - `learning-rehearsal-queue`
  - `learning-transfer-bridges`
  - `learning-durable-skills`
  - `learning-long-term-catalog`
  before weekly summary and raw review artifacts.

## Files changed

- `src/hooks/bundled/learning-review-weekly/handler.ts`
- `src/hooks/bundled/learning-review-weekly/handler.test.ts`
- `src/hooks/bundled/learning-review-weekly/HOOK.md`
- `src/hooks/bundled/learning-review-bootstrap/handler.ts`
- `src/hooks/bundled/learning-review-bootstrap/handler.test.ts`
- `src/agents/system-prompt.ts`
- `src/agents/system-prompt.test.ts`

## Behavior change

- Weekly learning memory now writes:
  - `*-learning-relevance-gate.md`
- Bootstrap now surfaces:
  - an immediate relevance cue
  - the full relevance-gate artifact
- The default study-memory lookup order now privileges stronger learned skills before weaker reference-only topics.

## Proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/learning-review/handler.test.ts src/hooks/bundled/learning-review-weekly/handler.test.ts src/hooks/bundled/learning-review-bootstrap/handler.test.ts src/agents/system-prompt.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/learning-review/handler.ts src/hooks/bundled/learning-review/handler.test.ts src/hooks/bundled/learning-review-weekly/handler.ts src/hooks/bundled/learning-review-weekly/handler.test.ts src/hooks/bundled/learning-review-weekly/HOOK.md src/hooks/bundled/learning-review-bootstrap/handler.ts src/hooks/bundled/learning-review-bootstrap/handler.test.ts src/agents/system-prompt.ts src/agents/system-prompt.test.ts`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Out of scope

- This does not change live runtime behavior yet.
- This is not full human-like automatic reasoning.
- This does not replace future live migration, acceptance validation, or stronger real-task usage loops.
