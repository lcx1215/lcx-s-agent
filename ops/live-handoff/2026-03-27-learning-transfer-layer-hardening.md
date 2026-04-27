# Learning Transfer Layer Hardening

- Scope: dev-repo-only learning-memory hardening.
- Objective: add explicit cross-domain transfer bridges so learned methods do not stay trapped in their original study topic.

## Exact failure mode

- The repo already had:
  - durable skill memory
  - trigger-oriented memory
  - rehearsal-oriented memory
- But it still lacked a dedicated transfer layer.
- This meant a method could be stored, triggered, and rehearsed while still not being surfaced as a reusable bridge into adjacent domains.

## Why this was dangerous

- The system could remain too topic-local.
- It would know more, but still fail to carry a good method from math into quant, or from coding into system architecture, unless the operator explicitly nudged it.

## Smallest safe patch

- Add a cumulative `learning-transfer-bridges` artifact to `learning-review-weekly`.
- Inject it into `learning-review-bootstrap` via:
  - `Learning Transfer Cue`
  - `Priority Learning Transfer Bridges`
- Update the agent system prompt so math / code / quant tasks now check:
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
  - `*-learning-transfer-bridges.md`
- Bootstrap now surfaces:
  - an immediate transfer cue
  - the full transfer bridge artifact
- The default study-memory lookup order now includes transfer bridges before weekly summaries.

## Proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/learning-review/handler.test.ts src/hooks/bundled/learning-review-weekly/handler.test.ts src/hooks/bundled/learning-review-bootstrap/handler.test.ts src/agents/system-prompt.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/learning-review/handler.ts src/hooks/bundled/learning-review/handler.test.ts src/hooks/bundled/learning-review-weekly/handler.ts src/hooks/bundled/learning-review-weekly/handler.test.ts src/hooks/bundled/learning-review-weekly/HOOK.md src/hooks/bundled/learning-review-bootstrap/handler.ts src/hooks/bundled/learning-review-bootstrap/handler.test.ts src/agents/system-prompt.ts src/agents/system-prompt.test.ts`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Out of scope

- This does not change live runtime behavior yet.
- This is not full automatic cross-domain reasoning.
- This does not replace future relevance gating or stronger live execution of default-calling behavior.
