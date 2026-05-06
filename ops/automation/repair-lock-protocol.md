# LCX Automation Repair Lock Protocol

This protocol is for Codex automations that run in `AUTO_REPAIR_MODE`.

Automations may always inspect logs, read artifacts, and report findings. Before editing files,
creating dev receipts, running formatters that write, or starting any repair patch, the automation
must acquire the repo-local repair lock:

```bash
node --import tsx scripts/dev/lcx-automation-repair-lock.ts \
  --mode acquire \
  --lane <automation-id> \
  --worktree /Users/liuchengxu/Desktop/lcx-s-openclaw \
  --json
```

If the command returns `"acquired": false`, the automation must stay read-only and report:

```text
CODEX_REPAIR_LOCKED
```

Include the returned `status`, `reason`, current lock owner if present, and dirty files if present.
Do not use `--allow-dirty` unless the user explicitly asks for an emergency manual repair.

If the command returns `"acquired": true`, keep the returned `token`. After the repair and
verification, release the lock:

```bash
node --import tsx scripts/dev/lcx-automation-repair-lock.ts \
  --mode release \
  --lane <automation-id> \
  --token <token> \
  --worktree /Users/liuchengxu/Desktop/lcx-s-openclaw \
  --json
```

The lock is not a training lock. It must not stop MiniMax/Qwen training, quota saturation,
read-only doctor checks, Lark evidence checks, or health dashboards. It only gates write-mode
automation repair.

Never claim a repair happened if the lock was not acquired.
