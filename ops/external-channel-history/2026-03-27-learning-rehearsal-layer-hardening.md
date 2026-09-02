# Learning Rehearsal Layer Hardening

- Scope: dev-repo-only learning-memory hardening.
- Objective: add repeated-use / rehearsal pressure so learned skills do not stop at triggerable storage.

## Exact failure mode

- The repo already had:
  - durable skill memory
  - trigger-oriented memory
- But it still lacked a dedicated rehearsal layer.
- This meant skills could be stored and even triggered, yet still miss the repeated-use loop that helps methods become durable.

## Why this was dangerous

- The system could still feel like a well-indexed archive instead of a study brain that keeps methods alive through repetition.
- Weak or new topics had no dedicated repetition surface beyond being present in summaries.

## Smallest safe patch

- Add a cumulative `learning-rehearsal-queue` artifact to `learning-review-weekly`.
- Inject it into `learning-review-bootstrap` via:
  - `Learning Rehearsal Cue`
  - `Priority Learning Rehearsal Queue`
- Update the agent system prompt so math / code / quant tasks check:
  - `learning-trigger-map`
  - `learning-rehearsal-queue`
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
  - `*-learning-rehearsal-queue.md`
- Bootstrap now surfaces:
  - an immediate rehearsal cue
  - the full rehearsal queue artifact
- The default study-memory lookup order now includes rehearsal before weekly summaries.

## Proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/learning-review/handler.test.ts src/hooks/bundled/learning-review-weekly/handler.test.ts src/hooks/bundled/learning-review-bootstrap/handler.test.ts src/agents/system-prompt.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/learning-review/handler.ts src/hooks/bundled/learning-review/handler.test.ts src/hooks/bundled/learning-review-weekly/handler.ts src/hooks/bundled/learning-review-weekly/handler.test.ts src/hooks/bundled/learning-review-weekly/HOOK.md src/hooks/bundled/learning-review-bootstrap/handler.ts src/hooks/bundled/learning-review-bootstrap/handler.test.ts src/agents/system-prompt.ts src/agents/system-prompt.test.ts`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Out of scope

- This does not change live runtime behavior yet.
- This is not full automatic cross-domain transfer.
- This is not a full mastery model; it is a bounded reinforcement layer on top of stored skills and trigger cues.
