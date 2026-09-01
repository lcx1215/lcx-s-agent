# Project Vision

This project aims to become a useful personal Agent system that can understand
real goals, do bounded work, learn from what happened, and remain inspectable
while it changes.

The vision is deliberately independent of any particular runtime, model,
provider, channel, deployment, Skill catalog, or Multi-Agent framework. Those
are replaceable means. The durable question is whether the system becomes more
useful, more reliable, and easier to understand for its owner.

## Direction

- Make natural-language work easier to start and easier to verify.
- Let one Agent, many Agents, tools, Skills, plugins, and external services
  cooperate through small observable boundaries.
- Turn real execution results and failures into the next improvement instead of
  relying on a large up-front design.
- Keep evidence, state, permissions, and side effects visible enough to audit.
- Support research, analysis, automation, and future capabilities without
  silently turning a helper into an authority.

## Learn by doing

The preferred evolution loop is:

```text
real goal
  -> smallest useful experiment
  -> observed result or failure
  -> local repair, adapter, or new hypothesis
  -> focused verification
  -> wider experiment, shadow path, or stop
```

The project should not require a complete architecture, migration plan, Skill
taxonomy, or provider matrix before it learns anything. A rule earns permanence
when a pattern repeats or a concrete failure shows that the rule helps.

## What should remain stable

- The owner can tell what the system actually did.
- Local proof, external delivery, deployment, and user-visible observation are
  not confused with one another.
- A stored source, model output, receipt, or successful demo is not inflated
  into learned capability or permanent readiness.
- New implementations can be isolated, compared, disabled, and rolled back.
- User data, credentials, parallel work, and durable evidence are preserved.
- External effects are intentional, scoped, and attributable.

## What may change freely

The project may replace or combine its Agent host, reasoning model, provider,
orchestration style, memory/state layer, interface, connector, deployment
target, evaluation harness, or Skill/plugin ecosystem. A new implementation
does not need to preserve old names or paths unless a real compatibility
consumer still exists.

When two implementations coexist, name the selected authority, experiment
owner, routing direction, evidence needed for adoption, and retirement or
rollback condition. Avoid a silent second brain or a result path that nobody
owns.

## Current profile

The current implementation is intentionally described outside this vision in
the repository's active runbook, manifests, tests, and runtime evidence. Read
the root [README](README.md) and [agent contract](AGENTS.md) first, then follow
the current profile. Historical names and inherited upstream material are not
automatic product direction.

## Contribution principle

Good contributions make the next experiment easier to run and the result easier
to trust. Prefer a small change with a clear owner and verification over a
large speculative framework. If an idea comes from another project, inspect its
license, behavior, dependencies, and side effects before adapting it.

## Security and responsibility

Capability is valuable only when the operator can understand and control its
risk. Keep security policy and vulnerability reporting in
[SECURITY.md](SECURITY.md). Changes to trust boundaries, credentials,
permissions, external messaging, or execution authority need focused security
review; compatibility is not a reason to weaken them.
