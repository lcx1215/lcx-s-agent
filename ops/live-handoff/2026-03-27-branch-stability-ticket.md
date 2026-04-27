# Ticket: branch stability

## Problem

Branching is still closer to intent than to repeatable operating reality.

L5 requires branch-level operating systems, not just route names or future plans.

## Required order

1. `technical_daily_branch`
2. `knowledge_maintenance_branch`
3. then consider `fundamental_research_branch`

## Why this order

- `technical_daily_branch` should prove a light/medium daily branch can run reliably
- `knowledge_maintenance_branch` should prove a maintenance branch can self-sustain and keep artifacts clean
- `fundamental_research_branch` is heavier and easier to over-expand before the baseline is ready

## Smallest safe scope

For each target branch:

1. verify repeated routing correctness
2. verify repeatable artifact generation
3. verify bounded memory / operating artifacts
4. verify Feishu acceptance phrases
5. verify handoff discipline when live changes are involved

## Out of scope

- no new branch family expansion
- no branch explosion
- no fundamental-first overgrowth

## Suggested acceptance

- branch runs repeatedly without silent drift
- branch outputs are stable and inspectable
- branch artifacts accumulate in a recognizable operating pattern
- branch behavior passes real Feishu acceptance checks

## Suggested owner

- Codex
