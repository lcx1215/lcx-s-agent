---
name: skill-quality-audit
description: Audit, tighten, or decide whether to install an Agent Skill. Use before importing GitHub skills, when a skill may overtrigger, when skill descriptions are vague, or when the user wants installed skills to improve agent speed without polluting context.
metadata: { "openclaw": { "emoji": "🔎" } }
---

# skill-quality-audit

Use this skill before adding or expanding skills from GitHub or local experiments.

## Goal

Only keep skills that improve agent speed and reliability without bloating the prompt or creating unsafe hidden behavior.

## Install Decision

Install or keep a skill only if it has:

- a specific trigger description
- a bounded job
- a small context footprint
- clear inputs and outputs
- no hidden network or credential behavior
- no broad "always use me" claims
- obvious fit with Lobster's current operating loop

Reject or rewrite a skill if it:

- duplicates an existing local skill
- tries to become a general system prompt
- bundles unrelated workflows
- asks the agent to trust external outputs blindly
- adds broad marketplace content without a concrete route to value

## Audit Checklist

1. Does the `description` say when to trigger, not just what the skill is?
2. Is the body concise enough to load during real work?
3. Are details moved to `references/` only when needed?
4. Are scripts deterministic and inspectable?
5. Does the skill require credentials, network access, or external tools?
6. Is there a validation command?
7. Is there a should-trigger and should-not-trigger eval shape?

## Local Validation

For local repo skills, run:

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/<skill-name>
```

For Lark-facing skills, also run the relevant Feishu/Lark regression tests after behavior changes.

## Public Patterns Reviewed

- Anthropic Skills: skills are folders with `SKILL.md`, optional scripts, references, and assets.
- Anthropic skill-creator: descriptions are the primary triggering mechanism and should be tested with realistic positives and near-misses.
- Public skill directories are useful for patterns, but should not be bulk-installed into Lobster without audit.
