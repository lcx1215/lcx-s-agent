# LCX Codex Coding Harness

LCX now exposes `codex_coding_harness` as a guarded coding capability. It is a
thin LCX control layer over the existing OpenClaw ACP runtime; it is not a
second agent runtime and does not replace the normal `sessions_spawn` path.

## What is actually absorbed

- DeepSeek Harness's useful session ideas are scoped into an append-only,
  versioned coding trajectory. The trajectory can be validated, replayed,
  resumed, forked, and serialized as JSONL.
- Codex's coding executor is reached through ACP. The LCX layer waits for the
  actual run, observes the child history, observes the worktree, and records a
  bounded receipt.
- The existing OpenClaw ACP policy, sandbox boundary, session manager, and
  plugin registry remain the authority for runtime execution.

The full DeepSeek Cordis tree and the Codex Rust `app-server` are intentionally
not copied into LCX. That would create a second authority for sessions,
plugins, approvals, and runtime lifecycle. If ACP later stops exposing a
required Codex event or approval, add a narrow adapter at the ACP seam instead
of importing the whole runtime.

## Coding proof contract

The tool is owner-only and accepts an absolute `cwd`. Before starting Codex it
requires a clean, named branch that is not `main` or `master`. A result is
`verified` only when all of these are true:

1. ACP accepted an actual Codex run.
2. The run completed and its child history was observable.
3. The worktree contains an observed change after the run.
4. The requested verification argv completed with exit code 0.

Without the verification command the result is deliberately
`completed-unverified`; a process start, assistant text, or receipt alone is
not a coding proof. A timeout requests deletion of the newly created child
session while preserving its transcript, and reports whether cleanup was
confirmed.

Example tool input:

```json
{
  "task": "Add the parser and its focused tests.",
  "cwd": "/absolute/path/to/a/clean/feature-worktree",
  "agentId": "codex",
  "verify": ["pnpm", "exec", "vitest", "run", "src/parser.test.ts"],
  "timeoutSeconds": 900
}
```

The verification command is argv-based and allowlisted; shell strings are not
accepted. The receipt intentionally keeps task/reply data bounded and
redacted, and it does not claim model learning, provider configuration,
external-channel delivery, or user-visible success.

## Additional candidates

The next candidates are worth evaluating, but are not copied in this slice:

- Codex `app-server` approval and backpressure events: absorb only if the
  current ACP adapter cannot expose a concrete event required by a coding
  gate. Existing OpenClaw already owns ACP queueing, cancellation, approval,
  and sandbox policy.
- DeepSeek projection seams and event-schema migrations: useful for a future
  cross-runtime trace registry, but the coding trajectory first needs repeated
  real runs before it becomes a system-wide source.
- Hermes skill improvement and trajectory compression: keep as a challenger
  for LCX's learning/evaluation loop. Do not let imported skills or memories
  become LCX governance, provider, or protected-memory authority.
