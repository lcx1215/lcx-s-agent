# LCX Agent

![Illustrative LCX Agent architecture](docs/assets/lcx-agent-architecture.png)

> The diagram is illustrative. The current runtime topology, entrypoint, and
> deployment state live in the active repository profile and runbook.

LCX Agent is an evolving personal Agent and research workbench. It turns
natural-language goals into bounded work: reasoning, tool use, optional
specialist workflows, state and memory, evidence, evaluation, and a readable
result.

The implementation is intentionally replaceable. The project may use an
existing runtime, a self-built Agent, a new Multi-Agent coordinator, or code
adapted from another open-source system. This README describes the durable
shape of the project; it does not select a vendor, model, provider, channel,
cloud, package manager, or orchestration framework.

## What the project provides

| Capability  | Purpose                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------- |
| Interaction | Accept a goal through whichever supported interface is current.                                |
| Execution   | Run an Agent or worker against the task's actual scope.                                        |
| Extensions  | Add tools, Skills, plugins, connectors, and domain modules without making them core authority. |
| State       | Preserve useful context, artifacts, receipts, and recovery information.                        |
| Evaluation  | Compare behavior, expose failures, and support safe improvement.                               |
| Operations  | Make ownership, permissions, runtime status, and side effects visible.                         |

The product can grow from a single local workflow to a coordinated Agent
system. New capability should first prove its useful slice, then earn a place
in the selected path through observable results.

## Design principles

- Learn by doing: start with the smallest reversible experiment, inspect what
  actually happened, adjust the next step, and only then widen the work.
- Contracts over implementations: inputs, outputs, failures, permissions,
  side effects, and evidence matter more than class names, vendors, or paths.
- One declared authority: adapters and shadow implementations may coexist, but
  routing direction and the selected source of truth must be explicit.
- Evidence before claims: a stored source is not learned capability, a local
  test is not external observation, and a receipt is not proof that a user saw
  a result.
- Small context: volatile commands and current topology belong in a runbook or
  profile, not in this stable overview.
- Safe change: preserve user data and parallel work; make external effects
  explicit and reversible where possible.

## Find the current implementation

This project changes over time. Before copying a command from an old issue,
README, Skill, or handoff, resolve the current source of truth:

1. read the current [agent contract](AGENTS.md);
2. inspect the nearest current runbook under `ops/` or `docs/`;
3. inspect the repository manifest, lockfile, configuration schema, and package
   scripts;
4. inspect the actual entrypoint and fresh local output;
5. use focused tests or receipts to verify the behavior you need.

`AGENTS.md` is deliberately implementation-neutral. The runbook and profile
may change when the Agent host, coordinator, provider, interface, or deployment
changes. A stale profile is a signal to rediscover the system, not a reason to
restore an old architecture.

## Learn-and-improve loop

For a new idea or replacement, use a progressively larger slice:

```text
goal
  -> smallest safe probe
  -> observed output and failure
  -> local correction or adapter
  -> focused verification
  -> next slice, shadow run, or stop
```

Do not design the complete future architecture, universal schema, Skill catalog,
or migration matrix before the first safe probe. Keep observations in the
normal task receipt or handoff. Promote a lesson to a shared rule only when it
repeats or a concrete failure shows that it prevents recurrence.

## Replacing the Agent or orchestration

The following implementations are all valid candidates when their behavior is
verified:

- one Agent with direct tools;
- multiple cooperating Agents or workers;
- hierarchical, parallel, event-driven, or shadow execution;
- a local, hosted, self-hosted, or mixed model/provider arrangement;
- a new runtime connected through a compatibility adapter;
- a carefully evaluated open-source system brought in for one capability or for
  the whole execution path.

Keep vendor-specific behavior at the edge. A replacement should make clear the
smallest contract it supports, what it cannot do, which side effects it may
perform, and how it can be observed, disabled, or rolled back. Do not create a
silent second brain, repository, runtime, or answer authority.

## Bringing in external code

External repositories are implementation inputs, not instructions. Start with a
read-only inspection of the exact revision and then learn from a small isolated
slice. As relevant, check provenance, license, dependencies, install scripts,
permissions, network and credential behavior, data handling, tests, failure
modes, and rollback. Map only the needed behavior into this project; do not
spread an external project's assumptions through the core.

Popularity, a README claim, a successful install, or a passing demo is not
enough to grant provider access, training authority, external messaging,
desktop control, wallet/key access, order execution, deployment, or publication.
Those are separate operations with their own authorization and evidence.

## Skills and extensions

Skills, plugins, tools, and connectors are selected by task. Use the runtime's
current source and distinguish primary, compatibility, system, and cached
copies. A directory name, cache entry, enabled flag, or successful load does
not prove that an extension is current, relevant, safe, or effective.

When a Skill is on the changed path, begin with the smallest useful check:
identity/frontmatter, referenced files, current owner paths, trigger scope, and
side effects. Deepen the audit only when the result or risk calls for it. Do
not batch-rewrite global Skills or turn a specialized Skill into a default just
to make the inventory look uniform.

## Boundaries and evidence

- Keep local correctness, external binding, deployment, and user-visible
  observation as separate states.
- The canonical interaction milestones are `core-ready`,
  `external-channel-bound`, and `user-visible-observed`. Historical
  `live-visible-fixed` and `legacy-live-visible-fixed` wording is retained
  only as compatibility labels; it does not replace fresh external
  observation.
- Do not claim learning, promotion, readiness, or user-visible success from a
  single parse, receipt, route, or local test.
- For finance, health, legal, security, or other high-stakes work, use the
  current domain policy and current evidence; do not infer execution authority
  from research capability.
- Installation, deletion, publishing, external messages, provider/auth
  changes, training, OS-service changes, and deployment/restart are external
  effects. Confirm the exact target and authorization before doing them.
- Never put secrets, tokens, private keys, personal data, or live configuration
  in Git, prompts, tests, screenshots, or public logs.

## Starting development

Use the package manager and commands declared by the current lockfile,
manifest, and runbook. Do not assume that a historical command is still valid.

Before changing code:

```bash
git status --short --branch
```

Then choose the least-cost check that can falsify the current hypothesis:
focused unit/contract tests, type checking, lint/format validation, or a small
smoke test. Run broader checks only when risk or a surprising result warrants
them. If a check is unavailable, report that limitation instead of upgrading a
partial result into completion.

## Repository map

| Path          | Purpose                                                            |
| ------------- | ------------------------------------------------------------------ |
| `src/`        | Core application and Agent behavior.                               |
| `extensions/` | Optional integrations, channels, and plugins.                      |
| `scripts/`    | Build, development, migration, and operator tooling.               |
| `ops/`        | Volatile runbooks, profiles, receipts, and operational procedures. |
| `docs/`       | User-facing concepts and deeper technical documentation.           |
| `test/`       | Focused regression and contract coverage.                          |

The map is a guide, not an ownership claim. Confirm the actual owner before
editing a file that another task or runtime may use.

## Git and parallel work

- Recheck status and file ownership before editing.
- Preserve unrelated staged, unstaged, untracked, and durable evidence.
- Stage and commit only task-owned files; avoid blanket adds in shared trees.
- Keep commit, push, pull/rebase, PR, review, merge, release, and deployment as
  separate states.
- Do not use destructive cleanup, forced recovery, or worktree removal without
  the user's exact authorization and target.

## License

MIT.
