---
name: l5-regression-batterer
description: Run bounded L5 baseline pressure tests with realistic Chinese finance and control-room prompts, then report failures by family.
metadata: { "openclaw": { "emoji": "🥊" } }
---

# L5 Regression Batterer

Use this for an explicit L5 pressure test or after a shared contract repair.

## Workflow

1. Confirm the repo and inspect active training/eval processes first.
2. Use the canonical Codex wrapper
   `/Users/liuchengxu/.codex/skills/l5-regression-batterer/scripts/l5-regression-batterer.sh --local`.
3. Keep tests local and bounded; classify failures by family instead of
   adding phrase-specific patches.
4. Record command, commit, pass/fail counts, and the next owner action.

## Boundaries

- This battery does not prove real external-message visibility or provider quality.
- Never launch it concurrently with a guard, teacher, MLX eval, or heavy
  training process.
