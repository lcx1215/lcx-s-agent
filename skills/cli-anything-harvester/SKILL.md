---
name: cli-anything-harvester
description: Evaluate CLI-Anything, CLI-Hub, or local-software wrappers before they are trusted, with a bounded JSON contract and explicit side-effect limits.
metadata: { "openclaw": { "emoji": "🛠️" } }
---

# CLI-Anything Harvester

Use this when a task proposes making a local app or GUI agent-native through a
CLI, MCP wrapper, or desktop bridge.

## Workflow

1. Check `skills/skill-quality-audit`, `skills/github-skill-supply-chain-audit`,
   and the external-agent upgrade radar before adding another path.
2. Define one command, input/output JSON schema, ownership, and a dry-run
   boundary before evaluating a wrapper.
3. Inspect source and dependencies; do not execute untrusted installer or
   desktop-control code during intake.
4. Keep a local proof and a reject/downrank decision. Distill only the
   reusable workflow pattern into an existing owner.

## Boundaries

- No bulk installation, credential capture, wallet/order access, or broad
  desktop authority.
- A wrapper is not runtime authority until its owner, contract, safety gate,
  and local regression proof exist.
