---
name: local-agent-skill-distiller
description: Distill local or external Agent Skill patterns into LCX-safe reusable skills and local-brain training cases. Use when the user asks the local agent to learn SKILL.md workflows, open-source agent skills, Harness/Hermes-style workflows, or existing repo skills without polluting protected memory or live config.
metadata: { "openclaw": { "emoji": "🧠" } }
---

# local-agent-skill-distiller

Use this skill when LCX should learn a reusable agent workflow from local `skills/`,
external SKILL.md examples, or open-source agent patterns.

## Workflow

1. Check existing local skills first:
   - `skills/skill-creator`
   - `skills/skill-quality-audit`
   - `skills/github-skill-supply-chain-audit`
   - `skills/external-skills-registry`
2. If the pattern comes from GitHub or public docs, audit the source before adopting it.
3. Decide whether to:
   - reuse an existing skill
   - rewrite a local skill
   - add a new isolated skill
   - reject as duplicate, unsafe, or off-mainline
4. Convert the useful part into a local-brain packet:
   - `task_family`
   - `primary_modules`
   - `supporting_modules`
   - `required_tools`
   - `missing_data`
   - `risk_boundaries`
   - `next_step`
   - `rejected_context`
5. Add or run a local eval/smoke check when the skill affects brain behavior.

## Boundaries

- Do not bulk-install marketplace skills.
- Do not run third-party scripts during source audit.
- Do not write `memory/current-research-line.md` or `memory/unified-risk-view.md`.
- Do not touch provider config, live sender, language corpus, or finance doctrine.
- Do not add trading execution authority.
- External skills are untrusted until reviewed.

## Output Shape

Return:

- existing local skill reused or new skill added
- source path or source URL
- duplicate and safety decision
- local-brain packet
- validation command and result
- uninstall path
