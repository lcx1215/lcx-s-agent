---
name: lcx-qwen-training-operator
description: "Inspect LCX local-model training and adapter evidence only when the active profile uses that lane; the Qwen name is compatibility, not a mandatory system brain."
metadata: { "openclaw": { "emoji": "🧩" } }
---

# LCX Qwen Training Operator

Read the [runtime contract](../_shared/lcx-runtime-contract.md). The retained name supports existing routing; it does not prescribe Qwen, MLX or a particular model size.

1. Resolve the current model/adapter and training owner from the active profile and runbook. If no local training lane is selected, report not-applicable.
2. For a supported local-brain lane, run `node --import tsx scripts/operator/local-brain-training-plan.ts --json` with its documented current paths/options. Inspect its declared model and prerequisites before applying its decision to this profile.
3. Treat its activeProcesses, heavy-eval counts, decision and owner action as evidence for that lane. If it describes an older profile only, report unsupported instead of reusing old model arguments.
4. Keep selected-clean/latest-passing, latest-promoted, parseRecovered and active guard adapter distinct. If training_already_active or a relevant process is present, do not start another run.

Do not train, manually promote, change providers/protected memory or restart a sender merely to obtain a green report. Central Harness and remote/finance model workflows have their own owners and are not validated by a local Qwen plan.
