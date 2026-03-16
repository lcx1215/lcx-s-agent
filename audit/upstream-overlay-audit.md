# Upstream Overlay Audit

Date: 2026-03-16
Branch: `main`
Source remote: `upstream/main`
Publish remote: `origin/main`

## Current State

- This repository is not a normal fork that can be kept current with a simple fast-forward from `upstream/main`.
- The current branch and `upstream/main` have diverged heavily.
- The current local branch also contains a deliberate Lobster-specific overlay that does not exist upstream.

Observed audit state on 2026-03-16:

- `sync-status` was `diverged-from-upstream`
- local-only commits were already greater than `5`
- upstream-only commits were already greater than `19000`
- exact counts are intentionally treated as dynamic; use `scripts/upstream-sync-audit.sh` for the current numbers

## What Is Local Overlay

These paths are local-only and should currently be treated as Lobster overlay, not as paths that upstream is expected to own:

- `src/hooks/bundled/artifact-memory.ts`
- `src/hooks/bundled/bootstrap-memory.ts`
- `src/hooks/bundled/weekly-memory.ts`
- `src/hooks/bundled/upgrade-memory.ts`
- `src/hooks/bundled/operating-loop/handler.ts`
- `src/hooks/bundled/fundamental-intake/handler.ts`
- `src/hooks/bundled/fundamental-manifest-bridge/handler.ts`
- `src/hooks/bundled/fundamental-snapshot-bridge/handler.ts`
- `src/hooks/bundled/fundamental-snapshot/handler.ts`
- `src/hooks/bundled/fundamental-scoring-gate/handler.ts`
- `src/hooks/bundled/learning-review/handler.ts`
- `src/hooks/bundled/frontier-research/handler.ts`
- `src/hooks/bundled/learning-review-weekly/handler.ts`
- `src/hooks/bundled/frontier-research-weekly/handler.ts`
- `src/hooks/bundled/learning-review-bootstrap/handler.ts`
- `src/hooks/bundled/frontier-research-bootstrap/handler.ts`
- `scripts/auto-sync-repo.sh`
- `scripts/sync-upstream-fork.sh`
- `scripts/upstream-sync-audit.sh`

Interpretation:

- These are not merge noise.
- These are the current Lobster product-specific layer.
- Future upstream refresh work should preserve these as overlay unless there is an explicit plan to upstream them or relocate them.

## Shared Hotspots

These paths exist both locally and upstream, so they are the highest-value manual integration points:

- `src/hooks/bundled/session-memory/handler.ts`
- `src/hooks/bundled/session-memory/handler.test.ts`
- `src/agents/system-prompt.ts`
- `src/agents/system-prompt.test.ts`
- `src/agents/subagent-announce.ts`
- `src/hooks/bundled/README.md`

Interpretation:

- These files are where future upstream changes are most likely to collide with Lobster-specific behavior.
- These should be reviewed on every upstream refresh cycle.
- They are the best candidates for future seam extraction if collision frequency stays high.

## Upstream Motion Areas

Recent upstream-only commits are concentrated in:

- status surfaces
- plugin and channel setup wiring
- onboarding and plugin lazy-loading
- CLI/runtime build and packaging scripts

Interpretation:

- The current upstream change stream is not centered on the Lobster fundamental/memory overlay itself.
- The biggest medium-term integration risk is not the fundamental pipeline; it is surrounding runtime surfaces and shared infrastructure drift.

## Integration Priority

### Priority 1

Always manually inspect:

- `src/hooks/bundled/session-memory/handler.ts`
- `src/agents/system-prompt.ts`
- `src/agents/subagent-announce.ts`
- `src/hooks/bundled/README.md`

### Priority 2

Track for surrounding drift, but do not merge blindly:

- `scripts/*`
- plugin/setup-related runtime surfaces
- hook metadata copy/build scripts

### Priority 3

Preserve as local overlay unless there is a deliberate product decision:

- all Lobster memory hooks
- all Lobster fundamental hooks
- operating loop and related review artifacts
- local sync/audit helper scripts

## Recommended Strategy

Do not attempt a full merge of `upstream/main` into this branch yet.

Recommended path:

1. Treat Lobster hook runtime as a persistent local overlay.
2. Use `scripts/upstream-sync-audit.sh` before any upstream refresh attempt.
3. Review shared hotspots first.
4. Refresh upstream only in bounded slices, starting with shared hotspots and surrounding script/runtime seams.
5. Consider a later structural extraction of the Lobster overlay if repeated upstream refreshes keep colliding on the same files.

See also:

- `audit/upstream-overlay-maintenance.md` for the standing maintenance policy and slice order.

## Non-Goals

This audit does not claim:

- that the repository is already aligned with upstream
- that the overlay should be upstreamed now
- that a safe automatic rebase/merge path already exists

## Summary

The practical model is:

- upstream provides the moving OpenClaw substrate
- this repository carries a Lobster-specific overlay on top
- future sync work should be handled as overlay maintenance, not as naive fork synchronization
