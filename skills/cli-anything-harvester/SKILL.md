---
name: cli-anything-harvester
description: Evaluate a proposed CLI, GUI bridge, MCP wrapper, or local-software adapter before trust, with a bounded contract and explicit side-effect limits.
---

# CLI-Anything Harvester

Use only when evaluating a proposed CLI, GUI bridge, or local-software wrapper
as an agent-callable tool. If the object is an Agent Skill directory, route it
through `skill-harvester`; in the LCX repository also use its focused
quality/supply-chain audit Skills when present. Run the LCX external-agent
radar only when that repository is the target; elsewhere use the target's
verified inventory or state that none was available.

Define the wrapper's single job, input/output contract, owner, dry-run mode,
and side effects. Inspect source and dependencies without running an untrusted
installer or desktop-control code. Keep it isolated until a local proof and a
keep/downrank/reject decision exist. No bulk install, credential capture,
wallet/order access, or broad desktop authority.
