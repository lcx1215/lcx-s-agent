---
name: live-sidecar-sync-doctor
description: Use for bounded drift checks and synchronization across a canonical repository, linked worktrees, external channels, sidecars, and runtime seams.
---

# Live Sidecar Sync Doctor

Use this when a local system and an external channel, daemon, or sidecar appear
out of sync. Resolve the active repository, source checkout, runtime target,
parity whitelist, and current owner from the nearest runbook, package scripts,
runtime manifest, and fresh process evidence. This Skill has no default repo or
sidecar path. A linked worktree is an isolated checkout, not automatically a
second authority.

## Workflow

1. Locate and run the current read-only drift owner. If using the helper shipped
   with this Skill, resolve its directory from the loaded Skill and set
   `LCX_EXTERNAL_CHANNEL_RUNTIME` only to the runtime target verified from the
   active profile/runbook; the helper has no default target and refuses an
   unset or missing one.
2. Read the drift report and use its missing-file, lockfile, config, and
   executable differences to choose the next smallest check.
3. Drift is evidence, not authorization to write. For a requested sync, confirm
   the exact source, target, whitelist, and rollback point; use `--apply` only
   within that explicit scope.
4. After a local sync, run only the checks declared by the active profile for
   that runtime. Restart or probe an external process only with explicit
   authorization.
5. Treat files that affect the external visible reply as sync-critical when
   the current profile says so; do not expand a whitelist merely to make a
   count look clean.

## Guardrails

- Keep scope to the currently declared runtime parity files.
- Display, dispatcher, and sender files are part of the visible reply surface
  when the active channel uses them, not cosmetic test-only code.
- Do not touch provider config, protected memory, trading execution, or unrelated generated artifacts.
- Do not call a sidecar sync user-visible proof. A real observation through the
  current channel is a separate check.
- If generated `.d.ts` files are the only reason desktop build hides a sidecar failure, do not copy them as the fix. Fix or sync the real source/config drift.

## Parity input

The helper accepts `LCX_RUNTIME_PARITY_MANIFEST`, a JSON file containing a `files` list of exact relative paths selected by the current runtime profile. It has no built-in legacy whitelist. Every source must exist and every destination must remain inside the supplied runtime; a missing or unsupported profile is reported before any copy. `--apply` changes only differing listed files and never deletes destination directories.

## Script

```bash
# Set this only to a verified, existing runtime target; the first call is read-only.
LCX_EXTERNAL_CHANNEL_RUNTIME="$VERIFIED_RUNTIME" LCX_RUNTIME_PARITY_MANIFEST="$PARITY_MANIFEST" "$SKILL_ROOT/scripts/live-sidecar-sync-doctor.sh"
# Use --apply only after the exact source, target, whitelist, and rollback point are authorized.
LCX_EXTERNAL_CHANNEL_RUNTIME="/verified/runtime/path" "$SKILL_ROOT/scripts/live-sidecar-sync-doctor.sh" --apply
```
