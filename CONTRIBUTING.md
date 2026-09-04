# Contributing to LCX Agent

This repository is the standalone LCX Agent project at
https://github.com/lcx1215/lcx-s-agent. Historical runtime names may remain in
compatibility surfaces while they are migrated; they are not project authority.

## Before changing code

- Describe the failure or user value, acceptance condition, and bounded scope.
- Check the nearest `AGENTS.md`, the current manifest/lockfile, and relevant
  runbook before editing.
- Keep unrelated worktree changes, tasks, branches, credentials, providers,
  training, and external-channel state untouched.

For multiple Codex windows, use
[`ops/engineering/LCX-GIT-DELIVERY-STANDARD.md`](ops/engineering/LCX-GIT-DELIVERY-STANDARD.md).
It defines the separation between tasks, forks, worktrees, branches, commits,
PRs, review, CI, merge, and cleanup.

## Development loop

1. Use one worktree and branch per independent writable task. Keep the default
   branch read-only while parallel work is active.
2. Make the smallest coherent change. Do not mix unrelated cleanup or refactors.
3. Stage only the files belonging to the task and record the commit SHA.
4. Run the minimum check required by the risk: focused checks for local changes;
   broader regression only for shared contracts, runtime, workflow, or security
   changes.
5. Converge related local work before pushing. Prefer one PR per coherent
   outcome, not one PR per window.

Typical local commands, when relevant:

```bash
pnpm tsgo
pnpm check
pnpm test -- <focused-pattern>
```

Use the package scripts and lockfile as the source of truth. Do not run the
full suite or live tests by habit when the changed surface does not require it.

## Pull requests

- Target the current project repository and default branch; qualify `gh`
  commands with `--repo lcx1215/lcx-s-agent`.
- Explain what changed, why, scope, checks run, known gaps, and whether the
  change is AI-assisted.
- Review the integrated PR head, not every child branch. Re-review only after a
  new commit SHA or a material risk change.
- CI, review, merge, release, deployment, training, and user-visible delivery
  are separate states. Report only the highest state proven by fresh evidence.
- Merge, publish, deploy, restart, external sends, and destructive cleanup
  require explicit authorization where applicable.

## Code and documentation

- Use the repository's TypeScript/ESM, strict typing, Oxlint, and Oxfmt rules.
- Avoid `any`, `@ts-nocheck`, prototype mutation, duplicate V2 paths, and
  unnecessary abstraction layers.
- Keep tests colocated with source when practical; add a focused regression for
  a repaired failure family.
- Keep docs generic: no secrets, tokens, personal paths, hostnames, phone
  numbers, live provider settings, or private transcripts.
- User-facing behavior should preserve LCX's finance research-only and
  evidence/provenance boundaries.

## Security and release

- Never commit credentials, API keys, private keys, or live configuration.
- Read [`SECURITY.md`](SECURITY.md) before security-advisory work.
- Read the current release documentation before versioning, packaging,
  tagging, publishing, or deployment. Do not change versions or publish without
  explicit authorization.

## Completion report

End with a concise record of:

```text
files/change | checks | commit | push/PR | CI/review | merge/cleanup | unknowns
```

If a state is not proven, say `unknown` or `blocked`; do not infer it from a
green local check or a task-sidebar icon.
