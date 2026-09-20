---
summary: "CLI reference for `lcx reset` (reset local state/config)"
read_when:
  - You want to wipe local state while keeping the CLI installed
  - You want a dry-run of what would be removed
title: "reset"
---

# `lcx reset`

Reset local config/state (keeps the CLI installed).

```bash
lcx reset
lcx reset --dry-run
lcx reset --scope config+creds+sessions --yes --non-interactive
```
