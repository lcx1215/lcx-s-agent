# 2026-03-28 Fundamental Review Chain Registry Alignment

## Exact failure mode

The core fundamental review chain still duplicated its artifact path contract across:

- `src/hooks/bundled/fundamental-review-queue/handler.ts`
- `src/hooks/bundled/fundamental-review-brief/handler.ts`
- `src/hooks/bundled/fundamental-review-plan/handler.ts`
- `src/hooks/bundled/fundamental-review-workbench/handler.ts`
- the matching handler tests

Each stage was hand-writing:

- the bank JSON output path
- the memory note filename
- the implied stage identity

That meant queue, brief, plan, and workbench could drift independently even though they are one locked review chain.

## Why dangerous

- It creates avoidable maintenance debt in one of the main L4 research chains.
- A future rename or directory adjustment can easily fix one stage and quietly leave the next stage or tests stale.
- This is exactly the kind of repeated path logic that makes the system harder to read, repair, and audit over time.

## Smallest safe patch

Do not redesign the fundamental chain.
Do not change review logic.

Instead:

- add bounded review-chain path helpers to `src/hooks/bundled/lobster-brain-registry.ts`
- make queue / brief / plan / workbench all use the same helper for:
  - JSON artifact path
  - memory note filename
- make the matching tests assert through the same helpers

## Files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `src/hooks/bundled/fundamental-review-queue/handler.ts`
- `src/hooks/bundled/fundamental-review-queue/handler.test.ts`
- `src/hooks/bundled/fundamental-review-brief/handler.ts`
- `src/hooks/bundled/fundamental-review-brief/handler.test.ts`
- `src/hooks/bundled/fundamental-review-plan/handler.ts`
- `src/hooks/bundled/fundamental-review-plan/handler.test.ts`
- `src/hooks/bundled/fundamental-review-workbench/handler.ts`
- `src/hooks/bundled/fundamental-review-workbench/handler.test.ts`

## Behavior change

- The fundamental review chain now has one code-level contract for:
  - `bank/fundamental/review-queues/<manifestId>.json`
  - `bank/fundamental/review-briefs/<manifestId>.json`
  - `bank/fundamental/review-plans/<manifestId>.json`
  - `bank/fundamental/review-workbenches/<manifestId>.json`
  - `YYYY-MM-DD-fundamental-review-<stage>-<manifestId>.md`
- Handlers no longer rely on repeated hand-written path strings.
- Tests no longer infer success by fuzzy filename includes when the exact stage note path is known.

## Proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/fundamental-review-queue/handler.test.ts src/hooks/bundled/fundamental-review-brief/handler.test.ts src/hooks/bundled/fundamental-review-plan/handler.test.ts src/hooks/bundled/fundamental-review-workbench/handler.test.ts src/hooks/bundled/fundamental-review-chain.integration.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/lobster-brain-registry.ts src/hooks/bundled/fundamental-review-queue/handler.ts src/hooks/bundled/fundamental-review-queue/handler.test.ts src/hooks/bundled/fundamental-review-brief/handler.ts src/hooks/bundled/fundamental-review-brief/handler.test.ts src/hooks/bundled/fundamental-review-plan/handler.ts src/hooks/bundled/fundamental-review-plan/handler.test.ts src/hooks/bundled/fundamental-review-workbench/handler.ts src/hooks/bundled/fundamental-review-workbench/handler.test.ts src/hooks/bundled/fundamental-review-chain.integration.test.ts`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Out of scope

- This does not install the TypeScript hook chain into the live Python runtime.
- This does not registry-ize every fundamental artifact family yet.
- This only closes the core queue -> brief -> plan -> workbench review-chain path contract seam.
