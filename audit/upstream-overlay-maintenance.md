# Upstream Overlay Maintenance Policy

Date: 2026-03-16
Branch: `main`
Baseline: first shared-hotspot integration pass completed

This document defines how this repository should be maintained relative to `upstream/main`.

## Purpose

Use this policy when the goal is:

- keep Lobster aligned with useful upstream OpenClaw changes
- preserve Lobster-specific overlay behavior
- avoid pretending this repository is a normal fast-forwardable fork

## Current Model

Treat the repository as three classes of paths:

### 1. Upstream-owned substrate

Examples:

- general OpenClaw runtime and CLI surfaces
- most channel/setup/plugin infrastructure
- build and packaging surfaces

Default rule:

- prefer upstream behavior unless Lobster has an explicit reason to diverge

### 2. Shared hotspots

Examples:

- `src/hooks/bundled/session-memory/handler.ts`
- `src/hooks/bundled/session-memory/handler.test.ts`
- `src/agents/system-prompt.ts`
- `src/agents/system-prompt.test.ts`
- `src/hooks/bundled/README.md`

Default rule:

- do manual integration
- keep Lobster-specific behavior
- periodically absorb generic upstream fixes and guardrails

### 3. Lobster overlay

Examples:

- learning/frontier/fundamental bundled hooks
- shared memory helpers
- operating-loop artifacts
- local sync/audit scripts

Default rule:

- preserve locally
- do not expect upstream to own these paths
- only relocate or upstream them with an explicit product decision

## Maintenance Cycle

### Step 1. Audit first

Run:

```bash
scripts/upstream-sync-audit.sh
```

Or use the wrapper:

```bash
scripts/upstream-refresh-check.sh
```

Use the result to answer:

- is this still a diverged overlay repo
- which shared hotspots still overlap with upstream
- which paths remain local overlay

### Step 2. Decide the slice

Never start with a full `upstream/main` merge.

Choose one bounded slice:

- shared hotspot refresh
- surrounding runtime seam refresh
- documentation seam refresh
- explicit overlay extraction work

### Step 3. Integrate in this order

When doing a generic upstream refresh pass, use this order:

1. `src/hooks/bundled/session-memory/handler.ts`
2. `src/agents/system-prompt.ts`
3. `src/hooks/bundled/README.md`
4. neighboring scripts/runtime surfaces only if required by the above

### Step 4. Preserve local truths

Do not remove or weaken these local behaviors during upstream alignment:

- shared artifact-memory substrate
- Lobster memory recall rules
- learning/frontier/fundamental pipeline outputs
- manifest/readiness/snapshot/scoring-gate artifact chain
- documentation that explicitly marks Lobster overlay surfaces

### Step 5. Validate

Minimum validation after each bounded refresh:

- targeted lint for touched files
- targeted tests for touched shared hotspots
- `pnpm build`

### Step 6. Publish in small increments

After each bounded slice:

- commit only the slice
- push to `origin/main`
- record the outcome in `audit/` if the maintenance policy changed

## Stop Conditions

Stop and re-scope if any of these becomes true:

- the change requires a full-tree merge from `upstream/main`
- the change starts touching Lobster overlay paths outside the chosen slice
- the change would revert shared-helper architecture back to duplicated upstream implementations
- the change would blur the boundary between local overlay and upstream-owned substrate

## What “Aligned” Means Here

For this repository, “aligned with upstream” does not mean:

- history matches upstream
- fast-forward is possible
- all local differences are gone

It means:

- shared hotspots are periodically reviewed
- useful upstream behavior is re-absorbed in bounded slices
- Lobster overlay remains explicit and maintainable

## Current Status

As of 2026-03-16, the first shared-hotspot integration pass is complete:

- `session-memory` restored workspace-bound behavior on the shared helper substrate
- `system-prompt` re-absorbed current generic guardrails while keeping Lobster recall rules
- bundled-hook documentation now distinguishes core hooks from Lobster overlay hooks

## Summary

The maintenance rule is:

- audit first
- integrate in slices
- preserve overlay boundaries
- prefer repeated small manual refreshes over one big fake sync
