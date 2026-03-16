---
name: frontier-research
description: "Save a structured frontier research card to memory when a paper or method-heavy session resets"
homepage: https://docs.openclaw.ai/automation/hooks#frontier-research
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

# Frontier Research Hook

Automatically turns paper or method-heavy sessions into compact frontier research cards in workspace memory.

## What It Does

When you run `/new` or `/reset` after a frontier research session, this hook:

1. finds the prior transcript
2. detects whether it looks like paper / method / whitepaper analysis
3. infers a method family and a preliminary verdict
4. writes a compact research card into `memory/`

The goal is to help later method discussions remember:

- what kind of method was reviewed
- what the main claim was
- what leakage or overfitting risk mattered
- whether the idea should be archived, watched, or reproduced

## Output

Creates a file like:

```text
<workspace>/memory/YYYY-MM-DD-frontier-research-<slug>.md
```

## Intended Use

This hook is especially useful for:

- frontier finance / quant papers
- AI-for-finance methods
- whitepaper or technical blog reviews
- replication triage
- leakage / overfitting audits on model proposals
