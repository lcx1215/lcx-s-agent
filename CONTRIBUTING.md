# Contributing

This is an evolving Agent project. Contributions may improve the current
implementation or explore a replacement runtime, orchestration style, Skill,
plugin, connector, or evaluation path. The repository contract is intentionally
implementation-neutral; read [AGENTS.md](AGENTS.md) and [README.md](README.md)
before choosing a technical direction.

## Start with the current source

Before editing:

1. inspect `git status --short --branch` and the current worktree ownership;
2. read the nearest runbook, manifest, lockfile, and relevant tests;
3. identify the smallest seam that can answer the next question;
4. preserve unrelated staged, unstaged, untracked, and durable evidence.

Do not copy commands, paths, model/provider choices, or architecture assumptions
from an old issue or inherited document without checking the current source.

## Change in small slices

Prefer:

- a focused change with one clear owner;
- a small adapter or compatibility seam when replacing an implementation;
- a shadow or experiment path when the new behavior is not yet trusted;
- a regression or contract test for a failure that actually occurred;
- a short receipt describing what was observed and what remains unknown.

Do not design the entire future Agent before running the first safe experiment.
Let real output and failure determine the next change. Promote a pattern to a
shared rule only after it repeats or a concrete failure shows that it helps.

## New Agent systems and external code

External repositories are implementation inputs, not authority. Before adopting
code from another project, inspect the exact revision, license, provenance,
dependencies, install scripts, permissions, network and credential behavior,
data handling, tests, and rollback path. Keep vendor-specific assumptions at
the edge. Do not copy secrets or execute unknown lifecycle scripts merely to
make a demo work.

A new Agent or Multi-Agent system may replace the current path when its useful
slice is locally observable, its failure modes are understood enough for the
scope, and it has a clear disable/rollback route. Do not create a silent second
repository, runtime, brain, or answer authority.

## Skills, plugins, and connectors

Use a Skill only when the task matches its scope. Verify its current source,
frontmatter, referenced files, owner paths, permissions, and side effects.
Compatibility copies, caches, and generated bundles are not automatically the
source of truth. Do not batch-rewrite or install a large Skill set just to make
the inventory uniform.

## Verification

Discover the package manager and checks from the current manifest and lockfile.
Run the least-cost check that can falsify the current hypothesis, then deepen
for risky or surprising results. Depending on the change, this may be a focused
unit/contract test, type check, lint/format check, integration check, or smoke
test. Report unavailable checks honestly.

For user-visible, external-channel, deployment, security, finance, or other
high-stakes changes, keep local verification separate from real-world
observation. Do not claim that a local replay, receipt, successful parse, or
passing demo proves the external outcome.

## Git and pull requests

- Stage and commit only files owned by the current contribution.
- Keep commit, push, pull/rebase, PR creation, review, merge, release, and
  deployment as separate states.
- Do not use blanket staging or destructive cleanup in a shared worktree.
- Do not remove branches, worktrees, or files without exact scope and explicit
  authorization.
- Explain the actual change and verification in the PR; do not claim checks,
  review, or deployment that did not happen.
- If AI assistance was used, describe it and state the real testing level.

## Security

Report security issues privately through the current process in
[SECURITY.md](SECURITY.md). Do not publish credentials, private data, exploit
details, or live configuration in issues, pull requests, fixtures, logs, or
screenshots. Changes that affect trust boundaries, authentication, permissions,
execution, or external messaging need focused security review.
