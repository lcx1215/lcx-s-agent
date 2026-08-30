---
name: lcx-module-learning-absorption-operator
description: Audit online/source learning and module internalization, keeping stored-only, application-ready, and eval-absorbed states separate.
metadata: { "openclaw": { "emoji": "📚" } }
---

# Module Learning Absorption Operator

Use this for source learning, module sedimentation, or questions about whether
an applied receipt became reusable capability.

## Workflow

1. Run `node --import tsx scripts/dev/module-learning-pipeline-review.ts --json --no-write`.
2. Run `node --import tsx scripts/dev/lcx-module-learning-absorption-gate.ts --json`.
3. Check each receipt for source scope, retrieval/apply evidence, adjacent
   application, eval/training proof, and keep/downrank/discard decision.
4. Report weak receipts and the exact next proof owner; do not promote by
   aggregate counts.

## Boundaries

- Stored source or a summary is not `eval_absorbed`.
- Do not write protected memory, mix language-routing corpus with brain data,
  or start training from this audit.
