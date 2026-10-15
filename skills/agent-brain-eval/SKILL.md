---
name: agent-brain-eval
description: "Evaluate LCX capability use and learning evidence against the active runtime; distinguish application, evaluation, model absorption, and promotion."
metadata: { "openclaw": { "emoji": "🧩" } }
---

# Agent Brain Eval

Use for an LCX capability-learning claim, regression, or reusable-behavior assessment. Read the [runtime contract](../_shared/lcx-runtime-contract.md) first.

1. Name the capability, current entry, active model/tool adapter, and acceptance cases. Use the current governance or capability owner and its receipts; a model is not the workflow authority.
2. For recovery evidence, use `node --import tsx scripts/operator/lcx-context-recovery-exam.ts --json`. Select focused prerequisite and adjacent-case tests from the actual changed lane.
3. Use `scripts/operator/local-brain-training-plan.ts` only when the active profile actually uses that local training lane. An unsupported or legacy-only plan cannot establish current model readiness.
4. Report source, application, evaluation, weight-learning, promotion, and user-visible evidence separately. A stored source, one answer, a Skill read, or one receipt is not `eval_absorbed`.

Do not start training or call models as a side effect of an assessment. Keep provider configuration, protected memory, execution authority, and external sends within their separately authorized owners.
