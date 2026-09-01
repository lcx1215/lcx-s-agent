# 2026-03-28 Learning Artifact Registry Alignment

## Exact failure mode

The weekly learning artifact contract still existed in three separate places:

- `src/hooks/bundled/learning-review-weekly/handler.ts`
  - generated the artifact filenames directly
- `src/hooks/bundled/learning-review-bootstrap/handler.ts`
  - loaded the same filenames one by one in a separate hardcoded order
- `src/hooks/bundled/learning-review-weekly/handler.test.ts`
- `src/hooks/bundled/learning-review-bootstrap/handler.test.ts`
  - repeated the same filenames and expected ordering again

That meant the learning weekly producer, the bootstrap consumer, and the tests could drift independently even though they were all talking about the same L4 brain artifacts.

## Why dangerous

- It creates a silent maintenance seam in one of the core L4 learning chains.
- A future artifact rename or reorder could easily update one file and leave the other two stale.
- This is exactly the kind of duplicated contract that turns routine L4 hardening into future cleanup debt.

## Smallest safe patch

Do not redesign learning.
Do not add a new memory layer.

Instead:

- promote weekly learning artifact names and ordering into `src/hooks/bundled/lobster-brain-registry.ts`
- let the weekly producer build filenames from that registry
- let the bootstrap consumer load and render priority sections from that same registry
- let tests assert against the shared filename builder instead of their own hardcoded strings

## Files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `src/hooks/bundled/learning-review-weekly/handler.ts`
- `src/hooks/bundled/learning-review-weekly/handler.test.ts`
- `src/hooks/bundled/learning-review-bootstrap/handler.ts`
- `src/hooks/bundled/learning-review-bootstrap/handler.test.ts`

## Behavior change

- Weekly learning artifacts now have one code-level contract for:
  - prompt recall ordering
  - weekly producer ordering
  - bootstrap priority ordering
  - canonical filename construction
- `learning-review-bootstrap` no longer hardcodes each weekly artifact name one by one.
- `learning-review-weekly` no longer hardcodes each weekly artifact filename one by one.
- The tests now verify the shared contract instead of re-declaring it.

## Proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/learning-review-weekly/handler.test.ts src/hooks/bundled/learning-review-bootstrap/handler.test.ts src/agents/system-prompt.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/lobster-brain-registry.ts src/hooks/bundled/learning-review-weekly/handler.ts src/hooks/bundled/learning-review-weekly/handler.test.ts src/hooks/bundled/learning-review-bootstrap/handler.ts src/hooks/bundled/learning-review-bootstrap/handler.test.ts src/agents/system-prompt.ts src/agents/system-prompt.test.ts`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Out of scope

- This does not install the higher-level TypeScript learning brain into the live Python runtime.
- This does not change live Feishu behavior directly.
- This does not collapse every hook-family artifact contract into one registry yet; it only closes the weekly learning artifact seam.
