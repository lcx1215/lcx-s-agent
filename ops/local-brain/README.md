# LCX Local Brain Ops Quickstart

Use this when the chat context is gone and you need to quickly resume LCX local-brain work.

This runbook is dev/local only. It does not prove live Lark visibility, does not touch live sender config, does not edit provider config, and does not write protected memory.

## First Command

Start here:

```bash
cd /Users/liuchengxu/Desktop/lcx-s-openclaw
node --import tsx scripts/dev/lcx-system-doctor.ts --json
```

Read the `minimax-brain-training-guard` check first. It summarizes:

- active guard, MiniMax saturator, MiniMax teacher batch, and MLX processes
- latest guard start
- latest MiniMax teacher acceptance count and failure kinds
- latest local-brain dataset counts
- latest smoke timestamp
- latest stable eval and adapter path
- latest promoted adapter
- guard and quota log paths

If this command is `ok=true`, prefer continuing from the reported state instead of restarting training.

## Codex Skills To Load

When context is missing, load only the skills that match the current question. The most useful local skill files are:

```text
/Users/liuchengxu/.codex/skills/lcx-baseline-hardening/SKILL.md
/Users/liuchengxu/.codex/skills/lcx-evolution-loop/SKILL.md
/Users/liuchengxu/.codex/skills/agent-brain-eval/SKILL.md
/Users/liuchengxu/.codex/skills/finance-learning-researcher/SKILL.md
/Users/liuchengxu/.codex/skills/lark-live-loop-debugger/SKILL.md
/Users/liuchengxu/.codex/skills/lark-post-migration-probe/SKILL.md
/Users/liuchengxu/.codex/skills/agent-runtime-drift-auditor/SKILL.md
/Users/liuchengxu/.codex/skills/l4-regression-batterer/SKILL.md
/Users/liuchengxu/.codex/skills/skill-harvester/SKILL.md
```

List the full current local inventory with:

```bash
find /Users/liuchengxu/.codex/skills -maxdepth 2 -name SKILL.md | sort
```

Use them like this:

- `lcx-baseline-hardening`: bounded stability work, silent failure elimination, scoped verification.
- `lcx-evolution-loop`: realistic self-improvement loop from a user/Lark-style prompt.
- `agent-brain-eval`: judge whether the local brain actually learned and can apply a capability.
- `finance-learning-researcher`: finance, ETF, quant, factor timing, source-gated learning.
- `lark-live-loop-debugger`: Feishu/Lark live message, reply flow, routing, and visible reply diagnosis.
- `lark-post-migration-probe`: prove post-migration real Lark inbound plus visible reply.
- `agent-runtime-drift-auditor`: compare dev repo, live sidecar, daemon/runtime, and receipts for drift.
- `l4-regression-batterer`: legacy skill name; use it for L5 pressure tests with realistic Chinese finance/control-room prompts.
- `skill-harvester`: evaluate and isolate new external or local skills before letting them affect the agent.

The skills are operator guidance, not durable market memory. Do not copy their text into protected repo memory.

## External And General Skills

Some useful skills are not LCX-specific, but future coding windows should still know they exist. Load them only when the task matches:

```text
/Users/liuchengxu/.codex/skills/cli-system-doctor/SKILL.md
/Users/liuchengxu/.codex/skills/cli-json-noise-doctor/SKILL.md
/Users/liuchengxu/.codex/skills/live-sidecar-sync-doctor/SKILL.md
/Users/liuchengxu/.codex/skills/repo-migration-cleaner/SKILL.md
/Users/liuchengxu/.codex/skills/semantic-family-miner/SKILL.md
/Users/liuchengxu/.codex/skills/security-best-practices/SKILL.md
/Users/liuchengxu/.codex/skills/security-threat-model/SKILL.md
/Users/liuchengxu/.codex/skills/playwright/SKILL.md
/Users/liuchengxu/.codex/skills/playwright-interactive/SKILL.md
/Users/liuchengxu/.codex/skills/gh-fix-ci/SKILL.md
/Users/liuchengxu/.codex/skills/gh-address-comments/SKILL.md
/Users/liuchengxu/.codex/skills/yeet/SKILL.md
/Users/liuchengxu/.codex/skills/pdf/SKILL.md
/Users/liuchengxu/.codex/skills/doc/SKILL.md
/Users/liuchengxu/.codex/skills/transcribe/SKILL.md
```

Use these as support tools, not as LCX doctrine:

- `cli-system-doctor`: CLI-first diagnosis across build, typecheck, lint, and smoke paths.
- `cli-json-noise-doctor`: fix JSON commands polluted by logs or non-JSON output.
- `live-sidecar-sync-doctor`: dev/live-sidecar drift checks and bounded sync planning.
- `repo-migration-cleaner`: OpenClaw/lobster to LCX naming cleanup.
- `semantic-family-miner`: batch-mining historical semantics for regression only, not as the main natural-language brain.
- `security-best-practices` and `security-threat-model`: security review and trust-boundary checks.
- `playwright` and `playwright-interactive`: browser verification for UI or localhost work.
- `gh-fix-ci`, `gh-address-comments`, and `yeet`: GitHub/CI/publish workflows when explicitly needed.
- `pdf`, `doc`, and `transcribe`: local document and audio workflows.

Plugin-provided skills may also appear in a Codex session, for example Hugging Face, GitHub, browser, or web-app skills. Treat those as session capabilities, not repo-pinned guarantees. If an external skill is missing, use `skill-harvester` to evaluate and install it in an isolated folder before relying on it.

## Current Mainline Model

Mainline local model:

```text
Qwen/Qwen3-0.6B
```

Reason: this machine has 8 GB memory. A Qwen3 1.7B pilot was mechanism-valid but overloaded the machine, with very high load average and stuck processes. Do not switch the main recurring local training lane to 1.7B on this machine.

The 1.7B path is useful only as a future shadow/bootstrap mechanism on stronger hardware.

## Resolve Current Adapter

Use this to see which local adapter the guard will use:

```bash
node --import tsx scripts/dev/minimax-brain-training-guard.ts \
  --resolve-current-adapter \
  --model Qwen/Qwen3-0.6B \
  --log /Users/liuchengxu/.openclaw/workspace/logs/minimax-brain-training-guard-medium.jsonl
```

The expected current selection pattern is:

```text
selectionMode=latest-passing
adapterPrefix=.../thought-flow-v1-qwen3-0.6b-minimax-guard
```

The guard now filters `latest-passing` by model-specific adapter prefix, so a future Qwen3 1.7B bootstrap cannot accidentally reuse a Qwen3 0.6B adapter.

## Continue Normal 0.6B Training

Use this for the normal medium-intensity local loop. The MiniMax teacher now runs as a
continuous sidecar, so slow local Qwen eval/train steps do not leave the 5-hour MiniMax
window idle.

```bash
node --import tsx scripts/dev/minimax-brain-training-guard.ts \
  --duration-minutes 285 \
  --batch-limit 20 \
  --teacher-profile minimax-plus-brain \
  --teacher-duration-minutes 12 \
  --teacher-concurrency 6 \
  --teacher-sidecar \
  --teacher-sidecar-max-calls 900 \
  --teacher-sidecar-batch-limit 36 \
  --teacher-sidecar-concurrency 8 \
  --train-every 3 \
  --eval-every 1 \
  --train-iters 40 \
  --load-max 100 \
  --train-load-max 12 \
  --log /Users/liuchengxu/.openclaw/workspace/logs/minimax-brain-training-guard-medium.jsonl
```

The `--train-load-max 12` guard is intentional. It allows MiniMax sample generation and eval to continue while skipping local MLX LoRA training when the machine is already under pressure.

## MiniMax Sample Generation Only

Use this when you only want MiniMax to create more reviewed teacher samples:

```bash
node --import tsx scripts/dev/minimax-quota-brain-saturator.ts --write
```

This writes brain distillation review artifacts only. It must not write language corpus, live sender config, provider config, protected repo memory, or finance doctrine.

## Dataset And Smoke

Rebuild and check the local brain dataset:

```bash
node --import tsx scripts/dev/local-brain-distill-dataset.ts --json
node --import tsx scripts/dev/local-brain-distill-smoke.ts --json
```

Expected boundary:

```text
local_auxiliary_thought_flow_only
```

Expected `notTouched` includes:

```text
live_sender
provider_config
protected_repo_memory
formal_lark_routing_corpus
finance_doctrine
```

## Hardened Eval

Run hardened eval against the latest selected adapter:

```bash
node --import tsx scripts/dev/local-brain-distill-eval.ts \
  --model Qwen/Qwen3-0.6B \
  --adapter /Users/liuchengxu/.openclaw/local-brain-trainer/adapters/thought-flow-v1-qwen3-0.6b-minimax-guard-2026-05-05T16-27-05-938Z-r6 \
  --hardened \
  --summary-only \
  --json
```

If the adapter path is stale, run the resolve-current-adapter command first and replace the path.

Promotion is acceptable only when:

```text
promotionReady=true
failedCaseIds=[]
```

## Logs

Main logs:

```text
/Users/liuchengxu/.openclaw/workspace/logs/minimax-brain-training-guard-medium.jsonl
/Users/liuchengxu/.openclaw/workspace/logs/minimax-quota-brain-saturator-2026-05-05.jsonl
/Users/liuchengxu/.openclaw/workspace/logs/minimax-brain-training-launchd.out.log
/Users/liuchengxu/.openclaw/workspace/logs/minimax-brain-training-launchd.err.log
```

Remember: these logs use UTC timestamps. Local machine time is EDT during this run, so `17:35Z` means `13:35 EDT`.

## Launchd Cadence

Check the saved recurring local training job:

```bash
launchctl list | rg 'lcx.minimax.brain'
```

Expected label pattern:

```text
lcx.minimax.brain.medium.2026-05-05T06-28-30Z
```

If the launchd command contains an old explicit `--current-adapter ...T05-00-48...r2`, replace it with a command that omits `--current-adapter` so the guard uses `latest-passing`.

## Status Interpretation

Use these words precisely:

- `dev-ready`: local scripts, dataset, smoke, eval, and receipts pass.
- `training-active`: guard or teacher/eval process is currently running.
- `promotion-ready`: hardened eval passed and the adapter is selected by latest-passing.
- `live-visible-fixed`: only after build, restart, probe, and a fresh real Lark inbound plus visible reply.

Do not call local training or synthetic replay `live-visible-fixed`.

## Do Not Do

- Do not edit `memory/current-research-line.md`.
- Do not edit `memory/unified-risk-view.md`.
- Do not mix language routing corpus with brain distillation artifacts.
- Do not restore the old local semantic family route as the primary natural-language brain.
- Do not claim Qwen model-internal learning without retained artifacts and eval evidence.
- Do not switch recurring local training to Qwen3 1.7B on this 8 GB machine.
- Do not claim MiniMax VLM success unless a real non-mock VLM probe succeeds.

## Useful Related Docs

```text
docs/tools/local-brain-distillation.md
docs/tools/local-brain-open-evals.md
ops/local-brain/README.md
```
