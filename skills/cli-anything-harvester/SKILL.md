---
name: cli-anything-harvester
description: Evaluate a proposed CLI, GUI bridge, MCP wrapper, or local-software adapter before trust, with a bounded contract and explicit side-effect limits.
metadata: { "openclaw": { "emoji": "🛠️" } }
---

# CLI-Anything Harvester

Use this to evaluate a proposed CLI, GUI bridge, MCP wrapper, or local-software
adapter as an agent-callable tool. If the object is a `SKILL.md` directory,
route it through `skill-harvester` and the focused Skill audits instead.

## Workflow

1. Search existing owners. When the LCX repository is the target, run
   `node --import tsx scripts/operator/lcx-external-agent-upgrade-radar.ts --json`;
   otherwise use the target's verified inventory or state that none exists.
2. Define one command, input/output contract, owner, dry-run behavior, and
   side effects before evaluating a wrapper.
3. Inspect source and dependencies; do not execute an untrusted installer or
   desktop-control code during intake.
4. Keep the wrapper isolated until local proof and a keep/downrank/reject
   decision exist; distill only a reusable pattern into the existing owner.

## Boundaries

- No bulk installation, credential capture, wallet/order access, or broad
  desktop authority.
- A wrapper is not runtime authority until its owner, contract, safety gate,
  and local regression proof exist.
