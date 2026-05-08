# LCX System Doctor

`scripts/dev/lcx-system-doctor.ts` is the CLI-first observability entrypoint for
LCX Agent dev health. It is read-only by default and does not probe live Lark,
restart daemons, change provider config, or write durable memory.

The default run also includes a `doctrine-consistency` gate. That gate catches
active-entrypoint drift such as stale stage language, tiny symptom-patch
rules, static local-brain adapter paths, invalid eval commands, upstream package
identity regressions, or missing L5 regression skill wiring.

## Fast Dev Check

```bash
node --import tsx scripts/dev/lcx-system-doctor.ts --json
```

Default coverage:

- git status
- required observability entrypoints
- local brain distillation dataset
- local brain dataset smoke
- local diff check

Default skips slower or live-touching checks. Skips are explicit in JSON.
`git-status` is summarized into branch, dirty state, modified/untracked counts,
and a short file list so the first pass is actionable without rerunning Git.
The plain-text output also prints dirty-tree counts and skipped check names.

## Brain Planning Check

```bash
node --import tsx scripts/dev/lcx-system-doctor.ts --json --brain-plan
```

Adds one MLX local-brain planning generation. This proves the selected local
adapter can produce a planning packet, but it still reports `liveTouched=false`.

## Deep Dev Check

```bash
node --import tsx scripts/dev/lcx-system-doctor.ts --json --deep
```

Adds:

- local brain strong eval
- full `pnpm build`

Use this before promotion or commit readiness checks.

## Live Probe

```bash
node --import tsx scripts/dev/lcx-system-doctor.ts --json --live
```

Adds live-facing checks:

- `openclaw capabilities lark-loop-diagnose --json`
- `openclaw channels status --probe --json`

Only use this when the goal is to prove live Lark/Feishu state. A default dev
doctor result is not a live-fixed claim.
