# Runtime Seams Integration Audit

Date: 2026-03-16
Branch: `main`
Compared against: `upstream/main`

This audit covers the first outer runtime seam pass after the shared-hotspot pass.

## Scope

- `scripts/committer`
- `scripts/copy-hook-metadata.ts`
- `scripts/copy-export-html-templates.ts`
- `scripts/bundle-a2ui.sh`
- local sync/audit helper scripts in `scripts/`

## Status

The first runtime seam pass is complete for the two highest-value shared scripts:

- `scripts/committer` has been brought back in line with upstream's git-lock retry behavior.
- `scripts/bundle-a2ui.sh` now preserves the local safer hash invocation while restoring upstream-compatible local `rolldown` fallback paths.

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

## 3. bundle-a2ui.sh

### Observed drift

Local `scripts/bundle-a2ui.sh` differs from upstream in two meaningful places:

- the hash computation now uses stdin-fed Node source plus `process.argv.slice(2)` instead of `--eval` plus `slice(1)`
- the rolldown execution path was simplified to:
  - use `rolldown` if present on PATH
  - otherwise fall back to `pnpm dlx rolldown`

Upstream still carries extra fallbacks for specific local `node_modules/.pnpm/.../rolldown/bin/cli.mjs` paths.

### Integration judgment

This is the only build-copy surface in this pass with potential correctness impact.

Reason:

- the copy scripts still produce the same files
- `bundle-a2ui.sh` can affect whether bundling succeeds in constrained environments

### Current assessment

This seam has now been partially realigned:

- the local stdin-fed hash invocation is retained
- upstream-compatible local `rolldown` binary fallbacks are restored

That means the immediate build-compatibility risk is reduced without reverting the local hash-call cleanup.

### Current policy

Treat `scripts/bundle-a2ui.sh` as a monitored shared build seam:

- keep the current hash invocation unless it proves incorrect
- prefer retaining upstream-compatible bundler fallbacks
- revisit only if upstream changes bundling behavior again or build failures reappear

## 4. Local sync/audit scripts

Examples:

- `scripts/auto-sync-repo.sh`
- `scripts/sync-upstream-fork.sh`
- `scripts/upstream-sync-audit.sh`

### Integration judgment

These are Lobster/local maintenance overlay, not shared runtime seams.

They should be preserved locally unless the maintenance model itself changes.

## Next outer runtime seam priorities

If a later pass is needed, inspect in this order:

1. `scripts/bundle-a2ui.sh`
2. hook/build scripts whose behavior affects artifact packaging
3. surrounding script surfaces touched by upstream build pipeline changes
4. logging-only script drift last

## Summary

The first runtime seam pass confirms:

- shared operator tooling is worth aligning when it improves robustness
- build-log-only drift is usually not worth immediate refresh
- `bundle-a2ui.sh` is the only build-copy seam in this pass with non-trivial compatibility risk
- local sync/audit scripts remain explicit overlay
