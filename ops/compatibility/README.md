# Compatibility surfaces

This directory records compatibility inputs without turning them into runtime
authority. The registry is intentionally separate from Skill installation and
registration.

## Regular Codex Skill copies

The current compatibility registry contains 34 regular directories discovered
under the compatibility Skill root. Each entry is checked individually for:

- directory and `SKILL.md` identity;
- current `SKILL.md` SHA-256, so a later change is visible;
- a small static side-effect triage (external write, destructive/overwriting,
  install/network, orchestration/Git, or read-only/unknown);
- manifest coverage; and
- name collisions with the primary Skill root.

Run the read-only owner from the repository root:

```bash
node --import tsx scripts/operator/lcx-compat-skill-audit.ts \
  --primary-root "${LCX_PRIMARY_SKILL_ROOT:-$HOME/.codex/skills}" \
  --compatibility-root "${LCX_COMPATIBILITY_SKILL_ROOT:-$HOME/.agents/skills}" \
  --json
```

The static class is triage, not a security approval. A regular copy remains
`compatibility-only` until its source, runtime registration, owner, permissions,
and behavior are separately proven. A clean registry check means only that the
known entries and collision checks are coherent; it does not authorize
execution, network access, external writes, Git operations, or deletion.

Do not bulk-rewrite, relocate, or delete these copies from this repository. If
one is needed, review that entry and its referenced commands as a separate
change with an exact target, rollback path, and focused verification.
