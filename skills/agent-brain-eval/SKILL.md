---
name: agent-brain-eval
description: Judge whether a local-brain capability is actually learned and reusable, separating stored-only, application-ready, and eval-absorbed evidence.
metadata: { "openclaw": { "emoji": "🧪" } }
---

# Agent Brain Eval

Use this for claims that the local agent learned a skill, internalized a
module, or can really use a new workflow.

## Workflow

1. Check the current owner evidence with `node --import tsx scripts/operator/lcx-context-recovery-exam.ts --json` and `node --import tsx scripts/operator/local-brain-training-plan.ts --json`.
2. Separate `stored_only`, `application_ready`, and `eval_absorbed`; a receipt or a good answer alone is not absorption proof.
3. Prefer a targeted prerequisite and adjacent-case eval before any broader claim.
4. Report the exact failed reason, evidence path, and next owner action.

## Boundaries

- Do not start training or a heavy eval from this skill by default.
- Do not modify provider config, protected memory, the language corpus, or a
  live sender.
- Do not call local replay, a channel probe, or a model answer
  `user-visible-observed`.
