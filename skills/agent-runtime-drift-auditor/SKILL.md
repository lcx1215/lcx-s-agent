---
name: agent-runtime-drift-auditor
description: Compare the canonical repository, linked worktrees, runtime/sidecar, daemon, skills, and receipts for drift while preserving the single selected answer path.
metadata: { "openclaw": { "emoji": "🧩" } }
---

# Agent Runtime Drift Auditor

Use this when the canonical repository, a linked worktree, runtime, sidecar,
migration, or daemon state appears out of sync. Locally there is one LCX system
and one factory/runtime; linked worktrees are isolated checkouts of that same
repository, not additional repositories or runtime authorities. GitHub/GitLab
feature branches are remote collaboration, review, and release concepts only.

## Workflow

1. Run `node --import tsx scripts/operator/lcx-live-fadeout-audit.ts --json` and
   `node --import tsx scripts/operator/lcx-external-channel-status.ts --json`.
2. Compare source commit, runtime skill snapshot, selected-clean adapter, and
   receipt timestamps; label each mismatch instead of guessing which side is
   authoritative.
3. Route a possible channel change to
   `scripts/operator/lcx-external-channel-binding.ts`; use read-only status first.
4. Report core-ready, external-channel-bound, and user-visible-observed as
   separate states. Historical development-state labels may be recognized in
   old receipts or user input for compatibility, but they are not current local
   repository or runtime states. This workflow is not a second repository.

## Boundaries

- Do not apply sidecar migration, restart a daemon, or send Lark messages from
  an audit.
- Historical live receipts are not current user-visible evidence.
