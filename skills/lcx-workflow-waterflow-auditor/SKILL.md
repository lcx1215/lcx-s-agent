---
name: lcx-workflow-waterflow-auditor
description: "Audit current LCX workflow and Harness closure, feedback, recovery and evidence owners; a healthy graph does not prove trading, learning or channel delivery."
metadata: { "openclaw": { "emoji": "🧩" } }
---

# Workflow Waterflow Auditor

Read the [runtime contract](../_shared/lcx-runtime-contract.md).

1. Resolve the request's entry and existing owner. Use `scripts/operator/lcx-problem-cluster-radar.ts --json` for relevant cross-lane clusters.
2. Select only required checks, such as `scripts/operator/lcx-mind-model.ts`, `scripts/operator/lcx-flow-graph.ts` or `scripts/operator/lcx-head-tail-consistency.ts`; avoid repeating overlapping audits.
3. Trace rule → workflow → evidence → consumer → feedback. Central Harness closure needs its actual perception/proposal/gate/action/feedback receipts. Paper closure separately needs authorized intent, broker order/fill, reconciliation and canonical book evidence.
4. Report a missing head rule, workflow entrypoint, proof surface, boundary flag or feedback consumer and name its owner. Do not create a second dashboard or authority.

Governance is local-only observability. A graph does not prove model-weight absorption, automatic execution, external-channel binding or user-visible behavior. Optional model/channel absence is scoped degradation, not an invented universal dependency.
