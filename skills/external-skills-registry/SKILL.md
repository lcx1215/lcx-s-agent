---
name: external-skills-registry
description: List, audit, or uninstall externally inspired Agent Skills added to this repo. Use when asking what GitHub skills were installed, where they came from, why they exist, or how to remove them cleanly.
metadata: { "openclaw": { "emoji": "📦" } }
---

# external-skills-registry

Use this skill to keep externally inspired skills auditable and removable.

## Installed External-Inspired Skills

These are local skills derived from public GitHub patterns, not vendored third-party code.

| Skill                             | Local path                               | Source inspiration                                                                                                                                           | Why installed                                                                                                  | Uninstall                          |
| --------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `semantic-routing`                | `skills/semantic-routing`                | `https://github.com/aurelio-labs/semantic-router`                                                                                                            | Guides semantic-family routing before adding more one-off regex phrases.                                       | Archive exact authorized directory |
| `skill-quality-audit`             | `skills/skill-quality-audit`             | `https://github.com/anthropics/skills`                                                                                                                       | Prevents bulk skill imports, overtriggering, and prompt/context pollution.                                     | Archive exact authorized directory |
| `ml-research-loop`                | `skills/ml-research-loop`                | `https://github.com/huggingface/ml-intern`                                                                                                                   | Adapts ML-intern-style paper-to-experiment-to-report loops without vendoring or executing code.                | Archive exact authorized directory |
| `hf-paper-intake`                 | `skills/hf-paper-intake`                 | `https://github.com/huggingface/skills/tree/main/skills/huggingface-papers`                                                                                  | Adds bounded paper metadata intake for arXiv/Hugging Face papers before research-loop handoff.                 | Archive exact authorized directory |
| `hf-dataset-inspector`            | `skills/hf-dataset-inspector`            | `https://github.com/huggingface/skills/tree/main/skills/huggingface-datasets`                                                                                | Adds read-only dataset suitability inspection before local experiments or evals.                               | Archive exact authorized directory |
| `github-skill-supply-chain-audit` | `skills/github-skill-supply-chain-audit` | `https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills` and `https://github.com/anthropics/skills` | Adds a pre-install audit gate for GitHub-hosted skills, provenance, hidden scripts, and prompt-injection risk. | Archive exact authorized directory |
| `local-agent-skill-distiller`     | `skills/local-agent-skill-distiller`     | `https://docs.openhands.dev/overview/skills` and `https://huggingface.co/docs/hub/en/agents-skills`                                                          | Converts local or external skill patterns into LCX-safe skills plus local-brain training/eval packets.         | Archive exact authorized directory |

## Removal Rule

Before uninstalling, check whether any repo tests or docs refer to the skill path:

```bash
rg "skills/<skill-name>|<skill-name>"
```

Remove only after the current user authorizes that exact scope, the source is recoverably preserved, and native/project/user pointers and callers have been reviewed. Update the ownership manifest and pointer bridge together, then run:

```bash
python3 skills/skill-creator/scripts/quick_validate.py skills/skill-creator
git diff --check -- skills
```

If the removed skill affected external-message routing behavior, also run the relevant external-channel routing tests.

## Install Rule

Do not bulk-install marketplace skills. Add one skill at a time, with:

- source GitHub URL
- local path
- why it helps Lobster now
- validation command
- uninstall command
