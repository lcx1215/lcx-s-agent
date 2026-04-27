# Long-Term Memory Bounded Integration

## Purpose

This document defines how external long-term memory systems may attach to Lobster without becoming a second uncontrolled source of truth.

## Current Candidate Systems

- `memd`
  - good fit for:
    - durable decisions
    - checkpoints
    - progress logs
    - task carryover
- `MemLayer`
  - good fit for:
    - supplemental recall
    - reflect / consolidation
    - time-travel memory inspection

## Allowed Role

External long-term memory is allowed only as:

- supplemental durable recall
- checkpoint / audit / carryover support
- optional reflect layer

It is not allowed to become:

- the primary doctrine source
- the primary risk summary source
- the primary market-thesis source

## Protected Summary Boundary

External long-term memory must not silently overwrite or replace:

- `memory/current-research-line.md`
- `memory/unified-risk-view.md`

Promotion from external memory into protected summaries requires:

- local artifact re-verification
- bounded human-auditable write path
- explicit evidence that the promoted item is still fresh and decision-relevant

## Local-First Preference

Prefer:

- local or self-hosted storage
- isolated workspace-scoped memory
- explicit receipts

Avoid by default:

- hosted cloud memory backends
- community-shared memory
- silent promotion into protected state

## Recommended Practical Use

Use external long-term memory for:

- persistent task carryover
- session checkpoints
- recurring workflow facts
- reusable coding / research patterns
- append-only audit context

Do not use it as the final authority for:

- current market stance
- current risk gate
- protected operating summary
- doctrine rewrites
