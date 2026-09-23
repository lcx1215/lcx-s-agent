---
name: agent-runtime-drift-auditor
description: Compare canonical source and a specific runtime entry/sidecar for drift while preserving one source of truth and labeling capability coverage.
metadata: { "openclaw": { "emoji": "🧩" } }
---

# Agent Runtime Drift Auditor

Use this when the canonical repository, a linked worktree, a specific runtime
entry, sidecar, migration, or daemon state appears out of sync. There is one
canonical repository, but `gateway` and `serve` are explicit, equal runtime
entry surfaces with different capability coverage. Linked worktrees are
isolated checkouts of that same repository, not additional source authorities.
GitHub/GitLab feature branches are remote collaboration, review, and release
concepts only.

## Workflow

1. Run `node --import tsx scripts/operator/lcx-live-fadeout-audit.ts --json` and
   `node --import tsx scripts/operator/lcx-external-channel-status.ts --json`.
2. Identify the entry surface for each observation. Compare source commit,
   runtime skill snapshot, selected-clean adapter, and receipt timestamps;
   label each mismatch instead of guessing which side is authoritative. A
   healthy result on one surface does not prove the other.
3. Route a possible channel change to
   `scripts/operator/lcx-external-channel-binding.ts`; use read-only status first.
4. Report core-ready, external-channel-bound, and user-visible-observed as
   separate states. Historical development-state labels may be recognized in
   old receipts or user input for compatibility, but they are not current local
   repository or runtime states. This workflow is not a second repository.

## Boundaries

- Do not apply sidecar migration, restart a daemon, or send external messages from
  an audit.
- Historical live receipts are not current user-visible evidence.
