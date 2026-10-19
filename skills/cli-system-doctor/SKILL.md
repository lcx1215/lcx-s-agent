---
name: cli-system-doctor
description: Use for evidence-bounded CLI diagnosis across build, typecheck, lint, tests, runtime health, conditional external probes, and dirty-tree evidence.
---

# CLI System Doctor

Use this when the user asks whether the current system is healthy, whether a
CLI or workflow change helped, or wants an evidence-bounded error sweep.

## LCX repository owner

Resolve the current entry and architecture before choosing a doctor lane. The Central Agent Harness, finance scheduler and communication adapter have separate runtime/receipt evidence. When this repository is active, `node --import tsx scripts/operator/lcx-system-doctor.ts --json` is the broad local observability owner. Read individual checks, failures, skips, and the reported boundary; a green summary is not proof of every runtime surface or end-to-end behavior.

- The default omits the live channel status probe. `--live` invokes the configured channel's `status --probe`; use it only when that external probe is relevant and in scope.
- `--brain-plan` runs a local model plan. `--deep` includes that plan, a local eval hardcoded to `Qwen/Qwen3-0.6B`, and `pnpm build`; do not treat that model-specific result as evidence for a different active profile. Prefer targeted checks unless broader compute/build coverage is needed.
- Report whether evidence came from `gateway`, `serve`, or another explicit runtime surface. The doctor is local observability, not a substitute for surface-specific or user-visible proof.

## Standard Sweep

Start with the smallest read-only observation that can answer the current
question: repository status, the active manifest/runbook, a focused command, or
fresh runtime output. Choose the package manager, test runner, entrypoint, and
channel probe from the current profile; do not assume a particular command
sequence or that a gateway/channel exists. Add a broader build, type, lint,
integration, or external probe only when the first result or the risk requires
it. Finish with a diff/format check when files were changed.

## Reporting

Summarize by subsystem:

- repo cleanliness
- build/type/lint
- targeted tests
- external-channel or interface probe, if relevant
- language/learning loop, if relevant
- local versus external boundary

## Guardrails

- Do not let huge command output dominate the answer.
- Extract the actionable error and the exact failing subsystem.
- If a command starts a long-running process, report that state and do not
  claim completion until it exits or is intentionally stopped.
