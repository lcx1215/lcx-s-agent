# 2026-03-28 fundamental front-half registry alignment

## Exact failure mode

The fundamental chain was only partially registry-backed.

Already aligned:
- `fundamental-review-queue`
- `fundamental-review-brief`
- `fundamental-review-plan`
- `fundamental-review-workbench`
- target-family back-half artifacts

Still hand-rolling paths:
- `fundamental-readiness`
- `fundamental-snapshot-bridge`
- `fundamental-snapshot`
- `fundamental-scoring-gate`
- `fundamental-risk-handoff`

That meant the same JSON/note path contract was duplicated across handlers and tests on the front half of the chain.

## Why it was dangerous

- the fundamental pipeline stayed half-clean and half-literal
- future renames or directory moves could silently desync front-half handlers from tests
- maintainers would still have to remember filename conventions instead of reading one registry

## Smallest safe patch

- extend `src/hooks/bundled/lobster-brain-registry.ts` with front-half stage specs
- switch front-half handlers to:
  - `buildFundamentalArtifactJsonPath(...)`
  - `buildFundamentalArtifactNoteFilename(...)`
- switch matching tests to read the same helper-derived paths

## Files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `src/hooks/bundled/fundamental-manifest-bridge/handler.ts`
- `src/hooks/bundled/fundamental-manifest-bridge/handler.test.ts`
- `src/hooks/bundled/fundamental-snapshot-bridge/handler.ts`
- `src/hooks/bundled/fundamental-snapshot-bridge/handler.test.ts`
- `src/hooks/bundled/fundamental-snapshot/handler.ts`
- `src/hooks/bundled/fundamental-snapshot/handler.test.ts`
- `src/hooks/bundled/fundamental-scoring-gate/handler.ts`
- `src/hooks/bundled/fundamental-scoring-gate/handler.test.ts`
- `src/hooks/bundled/fundamental-risk-handoff/handler.ts`
- `src/hooks/bundled/fundamental-risk-handoff/handler.test.ts`

## Proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/fundamental-manifest-bridge/handler.test.ts src/hooks/bundled/fundamental-snapshot-bridge/handler.test.ts src/hooks/bundled/fundamental-snapshot/handler.test.ts src/hooks/bundled/fundamental-scoring-gate/handler.test.ts src/hooks/bundled/fundamental-risk-handoff/handler.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/lobster-brain-registry.ts src/hooks/bundled/fundamental-manifest-bridge/handler.ts src/hooks/bundled/fundamental-manifest-bridge/handler.test.ts src/hooks/bundled/fundamental-snapshot-bridge/handler.ts src/hooks/bundled/fundamental-snapshot-bridge/handler.test.ts src/hooks/bundled/fundamental-snapshot/handler.ts src/hooks/bundled/fundamental-snapshot/handler.test.ts src/hooks/bundled/fundamental-scoring-gate/handler.ts src/hooks/bundled/fundamental-scoring-gate/handler.test.ts src/hooks/bundled/fundamental-risk-handoff/handler.ts src/hooks/bundled/fundamental-risk-handoff/handler.test.ts`

## Result

The fundamental chain is now registry-backed from:

- readiness
- snapshot bridge
- snapshot
- scoring gate
- risk handoff
- review queue
- review brief
- review plan
- review workbench
- target-family downstream artifacts

## Explicit status

- `dev-fixed: yes`
- `live-fixed: no`
