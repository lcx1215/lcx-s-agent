# Runtime Seams Integration Audit

Date: 2026-03-16
Branch: `main`
Compared against: `upstream/main`

This audit covers the first outer runtime seam pass after the shared-hotspot pass.

## Scope

- `scripts/committer`
- `scripts/copy-hook-metadata.ts`
- `scripts/copy-export-html-templates.ts`
- local sync/audit helper scripts in `scripts/`

## Status

The first runtime seam pass is complete for the highest-value shared script:

- `scripts/committer` has been brought back in line with upstream's git-lock retry behavior.

## 1. scripts/committer

### Why it mattered

This script is part of the repository's normal operator workflow and is used in a multi-agent environment.

That makes git lock handling materially important:

- multiple local processes may stage or commit around the same time
- transient `.git/*.lock` contention should not fail immediately if a short retry would succeed

### Local issue before this pass

Local `scripts/committer` had drifted away from upstream's retry loop and only kept a narrower stale-lock fallback path.

That meant:

- less resilience under transient git lock contention
- more avoidable commit failures in the exact environment this repository expects

### Action taken

This pass restored upstream-style git lock handling:

- retry around staged restore/add
- retry around commit
- optional stale lock deletion only after retry exhaustion when `--force` is used

### Ongoing rule

Treat `scripts/committer` as a shared runtime seam:

- prefer upstream robustness fixes
- do not carry local simplifications here without a concrete reason

## 2. copy-hook-metadata / copy-export-html-templates

### Observed drift

Local versions currently differ from upstream mostly in log verbosity:

- upstream keeps `OPENCLAW_BUILD_VERBOSE`
- local always logs copied files and ends with a simple `Done`

### Integration judgment

This is low-priority drift.

It does not currently change:

- build correctness
- copied outputs
- Lobster overlay behavior

### Current policy

Do not spend integration budget on this until one of these becomes true:

- build logs become too noisy in practice
- upstream changes the copy semantics
- the scripts become part of a broader build-surface refresh

## 3. Local sync/audit scripts

Examples:

- `scripts/auto-sync-repo.sh`
- `scripts/sync-upstream-fork.sh`
- `scripts/upstream-sync-audit.sh`

### Integration judgment

These are Lobster/local maintenance overlay, not shared runtime seams.

They should be preserved locally unless the maintenance model itself changes.

## Next outer runtime seam priorities

If a later pass is needed, inspect in this order:

1. hook/build scripts whose behavior affects artifact packaging
2. surrounding script surfaces touched by upstream build pipeline changes
3. logging-only script drift last

## Summary

The first runtime seam pass confirms:

- shared operator tooling is worth aligning when it improves robustness
- build-log-only drift is usually not worth immediate refresh
- local sync/audit scripts remain explicit overlay
