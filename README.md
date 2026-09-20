# LCX Agent

![LCX Agent architecture](docs/assets/lcx-agent-architecture.png)

[![LCX Agent progress](docs/assets/lcx-agent-daily-progress-wave.svg)](docs/assets/lcx-agent-daily-progress-wave.svg)

LCX Agent is a standalone personal AI research operating system. It exposes a
vendor-neutral External Message Channel for connecting software over HTTP,
routes natural-language requests into specialist workflows, and keeps durable
evidence about what was read, tested, learned, promoted, or blocked.

The project is not an autonomous trading bot. Its finance scope is research
only: ETF, major asset, macro, large-cap company, risk, and timing discipline.
The goal is steady daily improvement with hard boundaries, not hype, hidden
execution, or fake user-visible proof.

## What It Does

| Layer        | Role                                                                     |
| ------------ | ------------------------------------------------------------------------ |
| Control room | External Message Channel natural-language entrypoint for one real user.  |
| Harness      | Permission, risk, eval, promotion, and user-visible proof gates.         |
| Hermes       | Context packets, handoffs, receipts, review artifacts, and message flow. |
| Local brain  | Qwen / MLX local adapter training, eval, and durable learning surfaces.  |
| Governance   | Doctor, radar, mind model, flow graph, head-tail, and recovery checks.   |

Product rule: 用户入口简单, internal roles can be specialized. The control-room
answer is readable first; specialist detail, receipts, eval proof, and protocol
labels stay behind operator surfaces unless the user asks for them.

## Core Boundaries

- `core-ready` is not `user-visible-observed`.
- A stored source is not learned capability.
- A receipt is not model-weight absorption.
- A `parseRecovered` eval case is not a clean promotion pass.
- One runtime uses one selected clean local-brain adapter, not stacked LoRAs.
- Finance outputs are research-only and are not investment advice.
- Current market, price, fundamental, ETF, option, macro, or vendor numbers must
  pass `finance_data_gateway_snapshot` / 金融数据网关 and carry provenance before
  reaching Qwen, the external message channel, memory, or a visible summary.
- Polymarket and prediction-market sources are research inputs only: no wallet
  connection, no order placement, no copy trading, no latency arbitrage. Use
  them as weak evidence only after market metadata packet, resolution ambiguity
  review, close time, orderbook/liquidity timestamp, thin-liquidity downrank
  decision, and source timestamp are present.

## Main Operator Commands

```bash
sed -n '1,220p' ops/local-brain/README.md
```

Recover current state in a compressed or new coding window:

```bash
node --import tsx scripts/operator/lcx-context-recovery-exam.ts --handoff
node --import tsx scripts/operator/lcx-governance-autopilot.ts --json
```

The governance autopilot writes snapshots under the active LCX state root:

```text
<LCX_STATE_ROOT>/workspace/state/lcx-governance-autopilot-latest.json
<LCX_STATE_ROOT>/workspace/state/lcx-evolution-promotion-digest-latest.json
<LCX_STATE_ROOT>/workspace/state/lcx-context-recovery-handoff-latest.md
```

Use those for orientation, then rerun owner commands before acting on volatile
runtime truth such as PIDs, active eval, selected adapters, and external-channel
binding status.

## Governance Stack

For non-trivial engineering, promotion, module learning, external-channel,
memory, or recovery work, run the owner stack instead of relying on chat history:

```bash
node --import tsx scripts/operator/lcx-problem-cluster-radar.ts --json
node --import tsx scripts/operator/lcx-commercial-acceptance-harness.ts --json
node --import tsx scripts/operator/lcx-change-impact-plan.ts --json
node --import tsx scripts/operator/local-brain-training-plan.ts --json
node --import tsx scripts/operator/lcx-external-channel-binding.ts --json
node --import tsx scripts/operator/lcx-live-fadeout-audit.ts --json
node --import tsx scripts/operator/lcx-mind-model.ts --json
node --import tsx scripts/operator/lcx-flow-graph.ts --json
node --import tsx scripts/operator/lcx-head-tail-consistency.ts --json
node --import tsx scripts/operator/lcx-context-recovery-exam.ts --json
```

`lcx-governance-autopilot.ts` runs that stack as a read-only coordinator: it
does not start training, mutate the external sender compatibility path, edit
provider config, touch protected memory, or claim `user-visible-observed`.

## Local Brain And Promotion

Before any heavy training, eval, or guard loop, check for active processes:

```bash
ps -axo pid,ppid,stat,etime,command | rg \
  'minimax-brain-training-guard|minimax-quota-brain-saturator|minimax-brain-teacher-batch|local-brain-distill-eval|mlx_lm (generate|lora)'
```

Promotion is strict: only a clean selected adapter with passing eval, no failed
cases, no parse errors, and no `parseRecovered` cases becomes the runtime
starting point. Later capability flows back through teacher data, dataset, eval,
and promotion into the next unified clean adapter.

## External Message Channel Proof

The External Message Channel is the communication adapter between the owner and
LCX Agent — not a second live brain or second runtime truth source. Any external
software, client, SDK, or connector is an integration implementation only; it
does not own model authority, runtime truth, or brain state.

Forward status names are `core-ready`, `external-channel-bound`, and
`user-visible-observed`. Legacy `live-*` fields may still appear during
migration; treat them as `legacy-*` compatibility labels such as
`legacy-live-visible-fixed`.

| State                    | Meaning                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `core-ready`             | Local tests, smokes, replay, or evals passed in the repo.        |
| `external-channel-bound` | External transport routes to the selected clean LCX answer path. |
| `user-visible-observed`  | A real external inbound and outbound reply was observed.         |

Approved binding owner:

```bash
node --import tsx scripts/operator/lcx-external-channel-binding.ts --json
```

Only when it reports an idle `ready_for_apply` state use the bounded apply path:

```bash
node --import tsx scripts/operator/lcx-external-channel-binding.ts --apply --json
```

That owner is canonical for `external-channel-bound`. `local-brain-training-plan`
exposes `externalChannelBinding` as the primary planner field; older live-binding
fields are compatibility projections only. `lcx-external-channel-status.ts` is the
canonical read-only status wrapper, reading legacy drift evidence from the neutral
`lcx-external-channel-compat.ts` owner. It must not override a clean apply result.
Commercial acceptance may treat the channel as bound while still blocking release
on `post_migration_external_canary_missing` until fresh real inbound/outbound
evidence proves `user-visible-observed`.

The system-wide compatibility audit (also enforces the cloud boundary below):

```bash
node --import tsx scripts/operator/lcx-live-fadeout-audit.ts --json
```

## Cloud Migration Model

Cloud migration moves the same LCX Agent core to a supported-region cloud control
station; it does not create a second live brain.

```text
local LCX core
  -> cloud-runtime-ready
  -> external-channel-bound
  -> user-visible-observed
```

`cloud-runtime-ready` means the cloud control machine has one canonical repository
checkout, one canonical state root, synced operator skills, receipts, logs,
selected-clean adapter proof, and governance owners. It does **not** mean
external-channel delivery, `user-visible-observed`, or model-weight absorption.

Local system/factory rule: one LCX system and one factory/runtime, backed by
one canonical repository and state root. Local isolation and parallel work use linked Git
worktrees only; no second repository or deployment checkout is authoritative.
Feature branches belong to GitHub/GitLab collaboration, review, and release — not
to the local runtime model.

China cloud may mirror backup, static status, dashboard, or domestic helper
surfaces, but must not become the canonical repo, canonical state root, provider
authority, external-channel sender authority, or a second source of truth.
External software, WeChat, SMS, Slack, or any future channel are communication
adapters on top of the same answer path.

## Finance Research Discipline

Optimized for low-frequency research and risk control:

- fundamentals for filtering;
- technicals for timing;
- macro and liquidity context for regime awareness;
- hard risk gates for survival;
- red-team invalidation before durable conclusions.

Alternative sources — interviews, blogs, podcasts, social attention, market
stories — are weak evidence by default. They can create hypotheses and research
checks, but do not become causality, alpha, position sizing, or durable doctrine
without source registry, reading scope, validation, review, eval or training
absorption evidence, and keep/downrank/discard decisions.

Prediction-market material follows the same rule with extra execution boundaries.
Polymarket-style markets may be used for source registry, resolution criteria,
close-date context, liquidity/orderbook snapshots, microstructure warnings,
thin-liquidity downranking, counterevidence, and paper-only strategy audits. If
resolution is ambiguous, block the conclusion. If the orderbook is thin, downrank
the signal. If a strategy lacks fees, slippage, sample-out proof, or a failure
log, reject it as research evidence. They cannot become a trading engine,
wallet/key path, copy-trading feed, position-sizing authority, forecast
authority, or same-day prediction shortcut.

## Development

Requirements: Node.js 22+, pnpm 10+.

```bash
pnpm install
pnpm tsgo
pnpm test
```

Focused checks:

```bash
corepack pnpm exec oxfmt --check README.md AGENTS.md ops/local-brain/README.md
corepack pnpm exec vitest run test/lcx-governance-autopilot.test.ts
corepack pnpm exec vitest run test/lcx-external-channel-binding.test.ts
corepack pnpm exec vitest run test/local-brain-training-plan.test.ts
```

External Message Channel regressions:

```bash
corepack pnpm exec vitest run extensions/external/src/accounts.test.ts
corepack pnpm exec vitest run extensions/external/src/monitor.test.ts
corepack pnpm exec vitest run extensions/external/src/protocol.test.ts
corepack pnpm exec vitest run extensions/external/src/security.test.ts
corepack pnpm exec vitest run extensions/external/src/send.test.ts
```

## Repository Map

| Path                       | Purpose                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `extensions/external/src/` | Vendor-neutral JSON webhook, routing, reply, security, and outbound delivery code. |
| `scripts/operator/`        | Local-brain training, eval, governance, doctor, radar, and promotion tools.        |
| `src/agents/`              | Agent runtime, system prompt, tools, routing, and review surfaces.                 |
| `src/auto-reply/`          | User-visible command replies, truth surfaces, and reply-flow evidence.             |
| `ops/local-brain/`         | Operator runbook for local-brain training, eval, guard, and recovery.              |
| `docs/`                    | LCX Agent documentation and compatibility notes.                                   |

## Identity and compatibility

LCX Agent is the standalone product, codebase, and repository authority.
Historical runtime names, environment variables, package paths, app identifiers,
and `lobster_*` handles may remain only as explicit compatibility artifacts.
Each such surface needs a canonical LCX replacement, a migration/rollback note,
and focused verification before removal. Historical changelog entries and
wire-level compatibility names are not rewritten merely to make search results
look clean.

## License

MIT.
