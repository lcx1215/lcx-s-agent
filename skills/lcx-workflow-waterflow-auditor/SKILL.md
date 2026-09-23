---
name: lcx-workflow-waterflow-auditor
description: Audit LCX workflow closure, waterflow, head-tail consistency, recovery snapshots, and memory-sedimentation gaps from one owner view.
metadata: { "openclaw": { "emoji": "🕸️" } }
---

# Workflow Waterflow Auditor

Use this for whole-system, macro/micro, self-healing, snapshot, or memory
sedimentation reviews.

## Workflow

1. Run `node --import tsx scripts/operator/lcx-problem-cluster-radar.ts --json`.
2. Run only the owner checks needed for identified clusters, such as
   `node --import tsx scripts/operator/lcx-mind-model.ts --json`,
   `node --import tsx scripts/operator/lcx-flow-graph.ts --json`, or
   `node --import tsx scripts/operator/lcx-head-tail-consistency.ts --json`.
3. Follow each problem cluster to its owner; do not duplicate owner truth in a
   second dashboard or parallel repair lane.
4. Report a missing head rule, workflow entrypoint, proof surface, or boundary
   flag separately, including which entry/runtime surface the evidence covers.

## Boundaries

- Governance is local-only observability; it does not prove external-channel delivery or user-visible behavior.
- Do not infer user-visible proof, model-weight absorption, or external-channel
  binding from a healthy graph.
