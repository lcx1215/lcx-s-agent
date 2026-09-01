---
name: agent-runtime-drift-auditor
description: Compare the dev repo, runtime/sidecar, daemon, skills, and receipts for drift while preserving the single selected answer path.
metadata: { "openclaw": { "emoji": "🧩" } }
---

# Agent Runtime Drift Auditor

Use this when dev, runtime, sidecar, migration, or daemon state appears out of
sync.

## Workflow

1. Run `node --import tsx scripts/operator/lcx-live-fadeout-audit.ts --json` and
   `node --import tsx scripts/operator/lcx-external-channel-status.ts --json`.
2. Compare source commit, runtime skill snapshot, selected-clean adapter, and
   receipt timestamps; label each mismatch instead of guessing which side is
   authoritative.
3. Route a possible channel change to
   `scripts/operator/lcx-external-channel-binding.ts`; use read-only status first.
4. Report dev-ready, external-channel-bound, and user-visible-observed as
   separate states.

## Boundaries

- Do not apply sidecar migration, restart a daemon, or send Lark messages from
  an audit.
- Historical live receipts are not current user-visible evidence.
