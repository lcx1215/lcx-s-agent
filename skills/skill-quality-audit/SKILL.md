---
name: skill-quality-audit
description: Audit, tighten, or decide whether to import an Agent Skill; use for third-party/local candidates, vague or overtriggering descriptions, duplication, or unnecessary context load.
metadata: { "openclaw": { "emoji": "🔎" } }
---

# Skill Quality Audit

Use this before adding or expanding a local, external, or third-party Skill, or
when an existing Skill overtriggers, duplicates another capability, or adds
unnecessary context.

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
- fit with the target runtime's documented owners, contracts, and authority
  boundaries

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

## Validation and Decision

Separate syntax validation from behavior: valid frontmatter does not prove
good trigger fit, safety, or runtime use. Test one realistic should-trigger
request and one close should-not-trigger request when the Skill is materially
changed. For a local repository package, use its validator when available; in
this repository, run:

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/<skill-name>
```

For external-message-facing changes, also run the relevant channel regression
tests. Report syntax, trigger behavior, runtime execution, and external
visibility as separate evidence levels.

Do not install or register a candidate as a side effect of an audit. Use the
exact user-authorized destination and source revision for any later import.
