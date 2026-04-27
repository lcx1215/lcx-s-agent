---
name: knowledge-validation-weekly
description: "Write one weekly knowledge validation report from benchmark-style and daily real-task validation notes"
homepage: https://docs.openclaw.ai/automation/hooks#knowledge-validation-weekly
metadata:
  {
    "openclaw":
      {
        "emoji": "🧪",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Knowledge Validation Weekly Hook

Writes one compact weekly validation artifact so Lobster's finance knowledge, code ability, and supervision reasoning can be judged through externalized benchmark notes and real task notes, not just self-written confidence.

## What It Does

When you run `/new` or `/reset`, this hook:

1. scans weekly benchmark-style validation notes
2. scans weekly daily real-task validation notes
3. groups strongest, weakest, and hallucination-prone domains
4. pulls correction candidates and repair-ticket candidates into one operator-visible report
5. writes one compact weekly validation note to `memory/`

## Expected Input Notes

Use compact notes shaped like the knowledge-validation protocol with fields such as:

- `validation_type`
- `benchmark_family`
- `task_family`
- `domain`
- `confidence_mode`
- `factual_quality`
- `reasoning_quality`
- `hallucination_risk`
- `verdict`

## Output

Creates:

- `<workspace>/memory/YYYY-Www-knowledge-validation-weekly.md`

## Guardrails

- This is a validation and supervision artifact, not an execution artifact.
- It separates factual quality from reasoning quality.
- It separates low-fidelity output from high-confidence output.
- It tracks capability-family coverage so finance, code-system reasoning, and supervision do not get blurred together.
- It must not claim mastery without benchmark or task evidence.
