---
name: agent-runtime-drift-auditor
description: "Audit LCX source, Skill, entry and runtime drift; compare the declared gateway, serve, scheduler or channel without assuming a local model or sidecar."
metadata: { "openclaw": { "emoji": "🧩" } }
---

# Agent Runtime Drift Auditor

Read the [runtime contract](../_shared/lcx-runtime-contract.md). Use one canonical repository; linked worktrees isolate changes, and a deployed checkout is a runtime target.

1. Resolve the actual source commit, process/entry, state root, loaded Skill files, configured adapter and receipt timestamps.
2. Compare only the declared parity surface. `gateway` and `serve` are equal entry surfaces with different capability coverage; the finance scheduler and external channel also need their own evidence.
3. For legacy vocabulary or compatibility drift, use `scripts/operator/lcx-live-fadeout-audit.ts`. Use `scripts/operator/lcx-external-channel-status.ts --json` only when a communication adapter is relevant.
4. Compare a selected-clean adapter only when the current profile has one. Missing Qwen/MLX/sidecar evidence is not a whole-system failure for a profile that does not use it.
5. Report core-ready, external-channel-bound and user-visible-observed separately. Historical development-state labels are compatibility evidence.

An audit does not apply migration, restart a daemon, change providers, send messages or place orders. Route an authorized legacy binding to its existing owner after verifying that the owner supports the active profile.
