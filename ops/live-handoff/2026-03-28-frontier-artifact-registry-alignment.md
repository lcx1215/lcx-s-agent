# 2026-03-28 frontier artifact registry alignment

## Exact failure mode

The frontier study chain still depended on scattered literal filenames and substring matches:

- `frontier-research-weekly`
- `frontier-research-bootstrap`

That meant:

- producer order lived in one place
- bootstrap priority lived in another place
- tests repeated literal filenames again

This was the same contract-drift bug already removed from learning and fundamental.

## Why it was dangerous

- unattended frontier study could silently stop injecting the right upgrade/review/backlog notes after a rename
- bootstrap behavior depended on scattered literals instead of one registry
- tests could keep passing by coincidence even if the family contract drifted

## Smallest safe patch

- extend `src/hooks/bundled/lobster-brain-registry.ts` with frontier recall artifact specs
- add:
  - `FRONTIER_RECALL_ARTIFACT_SPECS`
  - `FRONTIER_WEEKLY_MEMORY_NOTES`
  - `FRONTIER_BOOTSTRAP_PRIORITY_SECTIONS`
  - `FRONTIER_RESEARCH_CARD_PREFIX`
  - `buildFrontierRecallFilename(...)`
- switch:
  - `frontier-research-weekly`
  - `frontier-research-bootstrap`
  - matching tests
    to use the registry instead of repeating names

## Files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `src/hooks/bundled/frontier-research-weekly/handler.ts`
- `src/hooks/bundled/frontier-research-weekly/handler.test.ts`
- `src/hooks/bundled/frontier-research-bootstrap/handler.ts`
- `src/hooks/bundled/frontier-research-bootstrap/handler.test.ts`

## Proof tests

- `corepack pnpm exec vitest run src/hooks/bundled/frontier-research/handler.test.ts src/hooks/bundled/frontier-research-weekly/handler.test.ts src/hooks/bundled/frontier-research-bootstrap/handler.test.ts src/agents/system-prompt.test.ts`
- `corepack pnpm exec oxlint src/hooks/bundled/lobster-brain-registry.ts src/hooks/bundled/frontier-research-weekly/handler.ts src/hooks/bundled/frontier-research-weekly/handler.test.ts src/hooks/bundled/frontier-research-bootstrap/handler.ts src/hooks/bundled/frontier-research-bootstrap/handler.test.ts src/hooks/bundled/frontier-research/handler.ts src/hooks/bundled/frontier-research/handler.test.ts src/agents/system-prompt.ts src/agents/system-prompt.test.ts`

## Result

The frontier family is now aligned with the same single-source-of-truth pattern already used by:

- learning recall artifacts
- fundamental artifact chain

That makes multi-day unattended study less likely to drift on a filename or bootstrap-order change.

## Explicit status

- `dev-fixed: yes`
- `live-fixed: no`
