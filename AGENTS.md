# LCX Agent Repository Contract

This file is the short, stable operating contract for
`lcx1215/lcx-s-agent`. Keep volatile commands, historical incidents, model
choices, provider details, and release procedures in the relevant runbook or
Skill. Do not turn this file into a transcript or a second registry.

## Precedence and working method

- Follow the user's current request, then this contract, then the nearest
  project runbook, manifest, and tests.
- Inspect current source, Git state, and runtime evidence before mutating.
- Use the smallest reversible change that closes a verified failure or adds
  directly useful behavior.
- Preserve unrelated changes, processes, credentials, and external state.
- If target, authority, permission, side effect, or evidence is unclear, stop
  only that mutation and report the exact gap.

## Stable product boundaries

- LCX Agent is the standalone product and repository identity. Any historical
  runtime identifier is compatibility-only and is not a product or repository
  authority.
- The repository is https://github.com/lcx1215/lcx-s-agent. Upstream OpenClaw remains the runtime lineage; it is not a second LCX source or release authority.
- Finance behavior is research-only: no direct buy/sell/add/reduce commands,
  position sizing instructions, or invented current numbers. Current data needs
  a source and timestamp; missing evidence must be stated plainly.
- A local test, receipt, replay, or stored text does not prove model learning,
  promotion, external-channel binding, deployment, or user-visible success.
- Provider configuration, authentication, training, protected memory, and
  external-channel sending are separate authorities. Do not modify them as a
  side effect of ordinary code or Git work.

## Architecture boundaries

- Keep one canonical ontology registry and its existing relation/state
  contracts. Additive vocabulary is safe; relation/state changes require a
  versioned migration manifest and focused verification.
- TypeScript owns routing, orchestration, safety gates, governance, recovery,
  and visible-flow control. Python is an engine for training, MLX/model
  execution, numerical work, or isolated tools; it is not a new workflow
  authority.
- Optional implementations, providers, models, tools, plugins, and channels
  are replaceable adapters. Do not hardcode one as the system's permanent
  brain or authority.
- Multi-Agent workers must have a declared role, scope, result responsibility,
  timeout/cancellation behavior, and a durable receipt. A worktree is
  isolation, not a second repository or truth owner.

## Multi-window Git delivery

The repository-specific procedure is
`ops/engineering/LCX-GIT-DELIVERY-STANDARD.md`; use it for worktrees, task
forks, branches, commits, pull requests, review, CI, and cleanup.

- `main`, or the resolved default branch, stays read-only while parallel work
  is active. Each writable task uses its own worktree/branch; read-only tasks
  do not need one.
- One integration surface combines selected work. Classify candidates as
  `merge`, `preserve`, `superseded`, or `unknown` before changing refs.
- A Codex window/task, task fork, Git worktree, Git branch, GitHub fork, commit,
  PR, CI result, review, and merge are different objects. UI colors are not
  Git evidence.
- An active writer blocks only an overlapping path, worktree, ref, or side
  effect. Send one pause request and recheck once; do not wait indefinitely for
  an invented owner. Unrelated work is preserved and does not block progress.
- Stage only proven paths. Never use blanket staging, broad cleanup, reset,
  force-push, or silent branch switching. Delete only an exact, preserved,
  unused target with authorization.
- Converge locally before pushing. Prefer one PR per coherent outcome and one
  review per commit SHA. Re-review only after a new SHA or material risk
  change.
- Report local change, commit, push, PR, CI, review, merge, cleanup, and
  external delivery as separate states.

## Verification and speed

Use the lowest sufficient gate; do not escalate by habit:

- G0: read-only/docs/ref bookkeeping — status, path review, and diff check.
- G1: localized code/test — G0 plus the touched test or package check.
- G2: shared contract/runtime/workflow/security — G1 plus targeted regression,
  type, or lint checks.
- G3: merge conflict, release, destructive cleanup, or external effect — fresh
  required CI/review and explicit authorization for the effect.

Reuse fresh evidence for the same commit SHA. Do not run the full repository
suite, live probes, or repeated full logs when the changed surface does not
require them. Parallelize independent read-only checks; serialize mutations.
Stop after the requested end-state predicates are proven.

## Implementation and repository basics

- Source is mainly TypeScript/ESM under `src/`; tests are colocated; extensions
  live under `extensions/`; docs live under `docs/`.
- Use the package manager and scripts declared by the current lockfile and
  manifest. Typical checks are `pnpm tsgo`, focused Vitest tests, and
  `pnpm check`; choose only what the risk tier needs.
- Keep strict types, avoid `any` and `@ts-nocheck`, use existing formatting and
  lint rules, and add concise comments only for non-obvious logic.
- Do not edit `node_modules` or generated output by hand. Keep dependencies,
  patches, version changes, and public API changes scoped and reviewable.
- Documentation should be generic and free of personal paths, hostnames,
  secrets, tokens, real phone numbers, or live configuration.

## GitHub, security, and release

- Resolve the current `origin` repository before any GitHub operation; qualify
  `gh` commands with `--repo OWNER/REPO`.
- Use the repository's commit helper when available and verify author/committer
  identity. Do not publish a Codex identity or invented email.
- Never commit credentials, tokens, private keys, live provider configuration,
  or personal data. Read `SECURITY.md` before advisory work.
- Read the current release documentation before tagging, packaging, publishing,
  or changing versions. Publishing, deployment, service restarts, external
  sends, and destructive cleanup require explicit scope and authorization.

## Skills, agents, and continuity

- Skills are instruction packages; Agents are role definitions; Plugins bundle
  capabilities; Prompts are templates. Do not treat one as another or copy
  stale provider/runtime instructions from a cache.
- In Codex Desktop chat, repo file references use absolute local file links;
  higher-priority app instructions require absolute local file links.
- Delegation is allowed only when the active Codex/platform rules and the user have allowed delegation; explicit user authorization is required for consequential delegation.
- Use the current context-recovery route for long tasks. Keep a short state
  card with objective, scope, decisions, evidence, blockers, and one next
  action; never store secrets or full transcripts.
- Finish with a concise evidence-backed report: what changed, what was checked,
  what remains unknown, and the next safe action.
