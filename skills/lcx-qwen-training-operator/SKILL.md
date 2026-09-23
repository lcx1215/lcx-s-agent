---
name: lcx-qwen-training-operator
description: Inspect local-model training status when the active profile uses Qwen/MLX, and distinguish current adapter truth from stale receipts; never start overlapping work.
metadata: { "openclaw": { "emoji": "🧭" } }
---

# Qwen Training Operator

Use this for Qwen/local-model training status, guard/teacher supervision, or
adapter-selection questions when the current profile uses those components.

## Workflow

1. Resolve the current repository and run
   `node --import tsx scripts/operator/local-brain-training-plan.ts --json` first.
2. Treat its `activeProcesses`, heavy-eval counts, decision, and owner action as
   current process/training truth; do not duplicate the process check unless
   the owner is unavailable, and report that degradation if it is.
3. If `training_already_active` is present or a relevant training/eval process
   is active, do not start another run.
4. Keep selected-clean/latest-passing, latest-promoted, parseRecovered cases,
   active guard adapter, and the owner action distinct in the report.

## Boundaries

- Mention Qwen, MLX, teacher, or adapter details only when current owner output
  supports them; file names and old receipts do not establish the active model.
- Do not start overlapping training/evaluation, manually promote an adapter,
  or change provider config, protected memory, or the external-channel sender.
