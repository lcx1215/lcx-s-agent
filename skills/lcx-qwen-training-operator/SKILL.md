---
name: lcx-qwen-training-operator
description: Inspect Qwen training, guard, MLX, teacher, adapter, and overlap state without starting a second training or eval process.
metadata: { "openclaw": { "emoji": "🧭" } }
---

# Qwen Training Operator

Use this for training status, guard PID, quota/teacher supervision, adapter
selection, or a request to continue local-brain evolution.

## Workflow

1. Check heavy processes with `ps -axo pid=,ppid=,etime=,pcpu=,pmem=,state=,command=` and filter the known guard, teacher, eval, and MLX names.
2. Run `node --import tsx scripts/operator/local-brain-training-plan.ts --json`.
3. Treat `training_already_active` as a hard stop; use the plan's owner action
   rather than launching a parallel guard.
4. Keep latest-passing adapter, latest-promoted adapter, parseRecovered cases,
   and active guard adapter distinct in the report.

## Boundaries

- This skill is read-only unless a separately authorized training action is
  requested after the plan says it is safe.
- Never change provider config, protected memory, or external-channel sender.
