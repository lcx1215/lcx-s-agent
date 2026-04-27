# Ticket: bookkeeping hardening

## Problem

Lobster still exposes bookkeeping as fragile file-edit behavior.

Observed bad pattern:

- main task may succeed
- memory update may fail
- user-facing semantics can still collapse into an `Edit failed` style message or implicit continuity loss

## Why it matters

- task completion and state recording are not clearly separated
- continuity becomes unreliable
- later turns can look like model stupidity when the real issue is bookkeeping failure
- this blocks L5

## Smallest safe scope

1. separate `task result` from `bookkeeping result`
2. introduce structured `memory_write_failed`
3. add pending / retry / anomaly trace
4. ensure bookkeeping failure does not silently erase continuity
5. add proof tests

## Out of scope

- no memory architecture rewrite
- no database migration
- no broad refactor of all memory writers

## Suggested acceptance

- no raw `Edit failed` bookkeeping contract remains user-facing
- failures are visible as structured status
- retry / pending / anomaly trace is inspectable
- later continuity can recover instead of acting fully amnesic

## Suggested owner

- Codex
