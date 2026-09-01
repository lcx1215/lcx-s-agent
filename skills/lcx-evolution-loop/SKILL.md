---
name: lcx-evolution-loop
description: Run a realistic LCX self-improvement loop from a natural user-style request through evidence, repair, eval, and promotion gates.
metadata: { "openclaw": { "emoji": "🔁" } }
---

# LCX Evolution Loop

Use this when the agent must improve from a real failure or user/external-message-style
request.

## Workflow

1. Start with `node --import tsx scripts/operator/lcx-problem-cluster-radar.ts --json`
   and `node --import tsx scripts/operator/local-brain-training-plan.ts --json`.
2. Select one owner lane and one failure family; reuse existing receipts,
   evals, modules, or SkillOpt SOPs before adding a path.
3. Repair the shared contract, test an adjacent case, and run the matching
   eval/doctor proof.
4. Keep candidate, challenger, promotion, external-channel, and user-visible
   evidence separate in the final receipt.

## Boundaries

- Do not start overlapping Qwen/MiniMax/MLX work.
- Evolution evidence is not model-weight learning or live proof by naming.
