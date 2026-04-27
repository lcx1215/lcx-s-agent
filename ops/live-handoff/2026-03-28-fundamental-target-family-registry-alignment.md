# 2026-03-28 Fundamental Target Family Registry Alignment

## Exact failure mode

The back half of the fundamental artifact chain still hand-wrote its JSON and note path contract in each stage:

- `fundamental-target-packets`
- `fundamental-target-workfiles`
- `fundamental-target-deliverables`
- `fundamental-target-reports`
- `fundamental-review-memo`
- `fundamental-collection-packets`
- `fundamental-collection-follow-up-tracker`
- `fundamental-manifest-patch-review`
- `fundamental-dossier-drafts`

The matching tests were also still locating note files by fuzzy `includes(...)` or `endsWith(...)` checks instead of using the same stage contract as production code.

## Why dangerous

- It keeps the fundamental chain readable only if you remember every folder and filename convention by hand.
- A future rename or directory adjustment could easily patch one stage and leave the downstream stage or tests stale.
- This is exactly the kind of repeated path logic that grows future maintenance work for no user value.

## Smallest safe patch

Do not redesign the fundamental flow.
Do not change business logic.

Instead:

- extend `src/hooks/bundled/lobster-brain-registry.ts` so it knows the full fundamental artifact-stage surface
- make the target-family handlers use that shared JSON / note path helper
- make the matching tests read the same helper-backed artifact paths instead of fuzzy filename guessing

## Files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `src/hooks/bundled/fundamental-target-packets/handler.ts`
- `src/hooks/bundled/fundamental-target-packets/handler.test.ts`
- `src/hooks/bundled/fundamental-target-workfiles/handler.ts`
- `src/hooks/bundled/fundamental-target-workfiles/handler.test.ts`
- `src/hooks/bundled/fundamental-target-deliverables/handler.ts`
- `src/hooks/bundled/fundamental-target-deliverables/handler.test.ts`
- `src/hooks/bundled/fundamental-target-reports/handler.ts`
- `src/hooks/bundled/fundamental-target-reports/handler.test.ts`
- `src/hooks/bundled/fundamental-review-memo/handler.ts`
- `src/hooks/bundled/fundamental-review-memo/handler.test.ts`
- `src/hooks/bundled/fundamental-collection-packets/handler.ts`
- `src/hooks/bundled/fundamental-collection-packets/handler.test.ts`
- `src/hooks/bundled/fundamental-collection-follow-up-tracker/handler.ts`
- `src/hooks/bundled/fundamental-collection-follow-up-tracker/handler.test.ts`
- `src/hooks/bundled/fundamental-manifest-patch-review/handler.ts`
- `src/hooks/bundled/fundamental-manifest-patch-review/handler.test.ts`
- `src/hooks/bundled/fundamental-dossier-drafts/handler.ts`
- `src/hooks/bundled/fundamental-dossier-drafts/handler.test.ts`

## Behavior change

- The full target-family chain now shares one code-level contract for:
  - bank JSON artifact paths
  - memory note filenames
- Tests now read the exact helper-backed note path instead of guessing by substring.
- The fundamental chain is now more consistent front-to-back:
  - core review chain
  - target family

## Proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/fundamental-target-packets/handler.test.ts src/hooks/bundled/fundamental-target-workfiles/handler.test.ts src/hooks/bundled/fundamental-target-deliverables/handler.test.ts src/hooks/bundled/fundamental-target-reports/handler.test.ts src/hooks/bundled/fundamental-review-memo/handler.test.ts src/hooks/bundled/fundamental-collection-packets/handler.test.ts src/hooks/bundled/fundamental-collection-follow-up-tracker/handler.test.ts src/hooks/bundled/fundamental-manifest-patch-review/handler.test.ts src/hooks/bundled/fundamental-dossier-drafts/handler.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/lobster-brain-registry.ts src/hooks/bundled/fundamental-target-packets/handler.ts src/hooks/bundled/fundamental-target-packets/handler.test.ts src/hooks/bundled/fundamental-target-workfiles/handler.ts src/hooks/bundled/fundamental-target-workfiles/handler.test.ts src/hooks/bundled/fundamental-target-deliverables/handler.ts src/hooks/bundled/fundamental-target-deliverables/handler.test.ts src/hooks/bundled/fundamental-target-reports/handler.ts src/hooks/bundled/fundamental-target-reports/handler.test.ts src/hooks/bundled/fundamental-review-memo/handler.ts src/hooks/bundled/fundamental-review-memo/handler.test.ts src/hooks/bundled/fundamental-collection-packets/handler.ts src/hooks/bundled/fundamental-collection-packets/handler.test.ts src/hooks/bundled/fundamental-collection-follow-up-tracker/handler.ts src/hooks/bundled/fundamental-collection-follow-up-tracker/handler.test.ts src/hooks/bundled/fundamental-manifest-patch-review/handler.ts src/hooks/bundled/fundamental-manifest-patch-review/handler.test.ts src/hooks/bundled/fundamental-dossier-drafts/handler.ts src/hooks/bundled/fundamental-dossier-drafts/handler.test.ts`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Out of scope

- This does not install the TypeScript hook chain into the live Python runtime.
- This does not registry-ize every remaining fundamental side path such as standalone output markdown folders.
- This only closes the core target-family JSON / note path contract seam.
