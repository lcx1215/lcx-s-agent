# LCX Local Brain Ops Quickstart

Use this when the chat context is gone and you need to quickly resume LCX local-brain work.

This runbook is dev/local only. It does not prove live Lark visibility, does not touch live sender config, does not edit provider config, and does not write protected memory.

## Fast Micro-Change Loop

For a small engineering change, do not start by scanning the whole repo or
running every gate. First classify the changed files and get the required
verification set for the affected lanes:

```bash
node --import tsx scripts/dev/lcx-change-impact-plan.ts --json
```

The planner reads the current git diff/status, assigns every touched file to a
master lane, and returns `recommendedFastCommands`. Use it before routine edits
to keep small work fast. It is dev/local only and reports `liveTouched=false`,
`providerConfigTouched=false`, and `protectedMemoryTouched=false`.

Run the heavier checkpoint after the focused checks, or immediately when the
planner reports elevated risk:

```bash
node --import tsx scripts/dev/lcx-system-doctor.ts --json
```

When a change may cause Codex, Claude Code, or another future agent to see only
one local detail while missing the larger workflow, run the LCX Agent Mind Model
god-view check:

```bash
node --import tsx scripts/dev/lcx-mind-model.ts --json
node --import tsx scripts/dev/lcx-flow-graph.ts --json
node --import tsx scripts/dev/lcx-context-recovery-exam.ts --json
node --import tsx scripts/dev/lcx-problem-cluster-radar.ts --json
node --import tsx scripts/dev/lcx-change-impact-plan.ts --json
node --import tsx scripts/dev/local-brain-training-plan.ts --json
node --import tsx scripts/dev/lcx-learning-sedimentation-bridge.ts --json
node --import tsx scripts/dev/lcx-learning-sedimentation-audit.ts --json
node --import tsx scripts/dev/lcx-learning-sedimentation-map.ts --json
node --import tsx scripts/dev/lcx-module-learning-absorption-gate.ts --json
node --import tsx scripts/dev/lcx-system-memory-sedimentation-gate.ts --json
```

This is a read-only `dev_mind_model_only` architecture audit. It checks whether
each main lane still has workflow closure across four surfaces: macro rule,
workflow entrypoint, proof/eval surface, and boundary flag. It covers context
recovery, change-impact planning, Qwen training, MiniMax teacher, adapter
promotion, Lark/Feishu live boundary, local automation, memory sedimentation,
finance research capability, and protected-memory/provider/live-sender
boundaries. It reports `liveTouched=false`, `providerConfigTouched=false`, and
`protectedMemoryTouched=false`; it does not prove live-visible-fixed.
It also checks the invariant registry for repeated failure families: surface
files must exist, local operator state must be fresh, temporary test HOME values
must not hide the real operator files, overlapping local-brain training must
stay visible, dev/live wording must stay separate, content claims need source
or unverified flags, and stored sources must not be treated as learned module
capability.

The LCX Agent Flow Graph is the waterflow exam. It verifies that each task
family has a start node, terminal node, required modules, filter valve list,
receipts, and bounded feedback edges. It is designed to catch wrong-flow before
it becomes a visible bug: dev proof must not jump to live-user-seen, stored
source must not jump to learned capability, hardened eval must not skip
promotion gate, and training/eval loops must not recirculate without overlap
guards or timeout/error receipts. Its proof surface is `flow_graph_exam`.
It also emits `diagnosticIndex`. Treat that as the fast operator triage table:
scenario family, detected failure class, owner entrypoint, fast check command,
required filters, evidence receipts, failure signals, and the
`dev_flow_graph_only` boundary. If a future window sees a workflow symptom, it
should use this index to find the owner path first instead of creating another
parallel doctor.
The Problem Cluster Radar is the current-issue aggregator for that governance
stack:

```bash
node --import tsx scripts/dev/lcx-problem-cluster-radar.ts --json
```

It reads existing owner outputs and emits `problemClusters`,
`actionableClusters`, `ownerEntrypoint`, and `sourceOwners`. It is not allowed to
become a second truth owner for training, eval, module learning, flow graph, or
context recovery. Its job is to group current red lights so a future Codex
window can see that, for example, eval timeout, parseRecovered promotion block,
module-learning absorption gap, stale recovery, or dirty worktree are active
problem clusters without manually rediscovering them from raw logs.
Run it automatically before non-trivial repairs, training/promotion judgments,
module-learning absorption claims, memory sedimentation claims, Lark/live
boundary claims, and broad "find more problems" work. Start with the radar to
get the cluster list, then follow each cluster's `ownerEntrypoint`; do not let
the radar replace those owners. If the training plan shows active
Qwen/MiniMax/MLX work, do not start a second heavy eval from this governance
stack.
It should not stay at only six obvious waterflows. The current minimum is 15
core waterflows, including Lark visible language, commercial answer pipeline,
provider council evidence, memory correction/downrank, same-philosophy
engineering consolidation, external skill or agent distillation, automation
repair locks, and finance data gateway reconciliation. The same-philosophy
consolidation clusters enforce that related mechanisms merge into one owner
scenario instead of becoming parallel systems.

Commercial-grade convergence does not mean deleting useful entrypoints. Keep
separate product/operator surfaces for the control room, doctor, training plan,
promotion audit, context recovery, flow graph, head-tail, live probe, and
module-learning review. Converge duplicated authority instead: Qwen/MiniMax
active process, eval, promotion, quota, and overlap truth is owned by
`local-brain-training-plan`; doctor and context recovery can report it, but they
should not carry a second independent ps/log parser or a separate promotion
decision.

Qwen capability consolidation also belongs to `local-brain-training-plan`.
Runtime should stay on one clean `latest-passing` adapter, but later r values
are not thrown away: their useful lessons must be distilled through
teacher/data/eval/promotion into the next unified clean adapter. Do not present
multiple r adapters as jointly served capability, and do not promote a candidate
with `parseRecovered` just because it scored 77/77.

World-class agent architecture is the target standard for future work, but it is
operational, not a slogan. In this repo it means: single factual owner per volatile
state family, simple control-room UX, specialized internal roles, source/eval
proof before durable claims, bounded feedback instead of open-ended loops,
recoverable state after context loss, and strict dev/live/protected-memory
boundaries. Use `lcx-mind-model`, `lcx-flow-graph`,
`lcx-head-tail-consistency`, `lcx-system-doctor`, `local-brain-training-plan`,
`lcx-context-recovery-exam`, `lcx-problem-cluster-radar`, and live probes as the
governance stack. If these surfaces disagree, treat it as architecture debt
before expanding features.

## Commercial L5 Blueprint

Use this as the current 1-6 execution plan. It is owned by the existing exam,
flow graph, runbook, and live-probe surfaces; do not create a parallel
blueprint lane.

1. Dev/live closure: keep `dev-ready`, `live-runtime-updated`, and
   `live-user-seen` separate. Migration needs build, restart, probe, real Lark
   inbound, outbound result, and visible reply evidence before any live claim.
2. Module-learning absorption: plan receipts, review rows, `application_ready`,
   `eval_absorbed`, and keep/downrank/discard are separate states. A stored
   source, reviewable receipt, or clean global eval is not per-module
   absorption by itself.
3. L5 battery and runtime drift: `lcx-agent-exam --l5` is the heavy local gate,
   and doctrine consistency must catch the L5 skill runtime PATH/pnpm drift
   that can break future windows before the repo itself is actually broken.
4. Commercial answer pipeline: the answer audit policy is that the model answer
   is candidate, Qwen is challenger/not final authority, local review has a
   bounded feedback budget, and the terminal decision is either adopt a visible
   answer or return a concrete failed reason. The dev owner is:

   ```bash
   node --import tsx scripts/dev/lcx-commercial-answer-pipeline.ts --json
   ```

   Use it before touching answer composition, Lark visible reply wording,
   model/Qwen review, source gates, or control-room summaries. It is dev-only:
   it does not call providers, live sender, or MLX, and it does not prove
   live-user-seen.

5. Live observability summary: Lark proof must converge through
   `lark-loop-diagnose`, channel probe, `feishu-reply-flow.jsonl`, and fresh
   real-user inbound/reply evidence. Synthetic replay and local smoke stay
   dev-only.
6. Product control room: default UX is one main control room with specialist
   detail on demand. Keep useful operator and specialist entrypoints, but every
   volatile status family needs one single factual owner and flow-graph
   consolidated entrypoint coverage.

`lcx-agent-exam --json` reports this plan as `commercialBlueprint` so a future
window can see which item is ready, blocked, needs receipts, or needs live
proof without rereading the chat.

The finance data gateway owner is `finance_data_gateway_snapshot`. Use it before
current market, price, fundamentals, macro, ETF, options, index-weight, vendor,
or portfolio-risk numbers reach Qwen, Lark, memory, or a visible summary. The
gateway requires provider role, source timestamp, timezone, field definition,
unit/currency, adjusted status, and source URL/artifact. Conflicted primary,
cross-check, or official/issuer evidence must route to data provenance review
instead of becoming an unstated model assumption.

The context recovery exam is the compressed-window proof. It verifies that a
future Codex or Claude Code session can recover the agent's global workflow from
durable files, the latest local operator state, and the mind model instead of
needing the old chat transcript. The local operator loop should keep
`mindModel`, `flowGraph`, and `contextRecovery` fields in
`/Users/liuchengxu/.openclaw/workspace/state/lcx-local-operator-latest.json`.
The latest state must also be fresh; a stale but readable JSON file is treated
as a failed recovery signal.

For a new coding window that needs a one-screen current-state handoff, use the
same recovery owner instead of creating a separate handoff lane:

```bash
node --import tsx scripts/dev/lcx-context-recovery-exam.ts --handoff
node --import tsx scripts/dev/lcx-context-recovery-exam.ts --handoff --json
```

The handoff snapshot includes dirty files, affected lanes, unmatched-file
checks, fresh training-plan decisions, module-learning absorption blockers,
flow-graph counts, strict dev/live/protected-memory boundaries, and the exact
recovery commands. It is still dev/local evidence only; it does not prove
`live-runtime-updated`, `live-user-seen`, or Qwen model-weight absorption.

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

For training-specific automation, run the unified plan immediately after the
doctor:

```bash
node --import tsx scripts/dev/local-brain-training-plan.ts --json
```

This is the shared training coordinator for future Codex windows and recurring
automations. It reads the guard/quota logs and classifies the next action into
one of the existing lanes: keep the medium guard running, feed MiniMax
failure-focus curriculum, run teacher-quality repair, run promotion audit, or
enter Codex auto-repair mode through the repo repair lock. Use this plan before
creating a new training script, eval lane, automation prompt, or one-off fix.
It is dev/local only and must not be used to claim live Lark success.
It reads module-learning receipts from `~/.openclaw/workspace` by default, not
from the repo worktree. Use `--workspace PATH` only for isolated tests or an
explicit alternate workspace. The plan must surface
`module_learning_incomplete_evidence` when module-learning receipts are
reviewable but not `eval_absorbed`.

For learning sedimentation specifically, run:

```bash
node --import tsx scripts/dev/lcx-learning-sedimentation-bridge.ts --json
node --import tsx scripts/dev/lcx-learning-sedimentation-audit.ts --json
node --import tsx scripts/dev/lcx-learning-sedimentation-map.ts --json
node --import tsx scripts/dev/lcx-module-learning-absorption-gate.ts --json
node --import tsx scripts/dev/lcx-system-memory-sedimentation-gate.ts --json
```

The bridge is a dry-run `dev_learning_sedimentation_bridge_only` check by
default. It reads existing finance retrieval/apply receipts and turns them into
module-learning plan candidates with status such as `application_ready`; it does
not claim `eval_absorbed`. Use `--write-plan-receipts` only when the operator
intentionally wants local weak plan receipts to be reviewed by
`module-learning-pipeline-review`.

This is a read-only `dev_learning_sedimentation_audit_only` check. It audits the
existing non-module learning surfaces together: finance source/capability,
retrieval/apply receipts, brain distillation reviews, review-panel receipts,
correction/downrank notes, and module-learning plan/review receipts. If general
learning evidence exists but module plan/review is empty, it reports
`usable_but_module_specific_certification_gap` instead of pretending there is no
learning sedimentation at all. If bridge-generated module receipts are only
`application_ready`, it reports
`usable_with_module_review_but_no_eval_absorption`; that means the chain is
reviewable but still must not be claimed as Qwen/model-weight absorbed.

The sedimentation map is a read-only
`dev_learning_sedimentation_map_only` check. It separates the learning lanes:
finance source/capability sedimentation, local module learning
plan/review/absorption, brain-distillation training material, system
memory/correction/downrank notes, review-panel arbitration, operator runtime
continuity memory, and the language-routing corpus boundary. Use it when the
question is "what kind of learning evidence do we actually have?" A finance
source apply receipt, a system memory note, and accepted brain-distillation
training material are not the same thing as module `eval_absorbed`.

The system-memory sedimentation gate is a read-only
`dev_system_memory_sedimentation_gate_only` check. It looks only at local system
memory/correction/downrank evidence and protected repo memory cleanliness. It
may report `system_memory_recall_ready`, but it always keeps
`moduleLearningClaimAllowed=false`; system recall is not module learning, Qwen
weight absorption, or live-visible proof.

The absorption gate is a read-only
`dev_module_learning_absorption_gate_only` check. It joins the latest
module-learning review with hardened-eval evidence and blocks promotion of a
learning receipt from `application_ready` to `eval_absorbed` unless each receipt
has per-receipt eval/training evidence, a fresh adjacent application task, and a
keep/downrank/discard decision. A clean global hardened eval is useful evidence,
but by itself it is not per-module absorption proof.

For a judge-style all-lane exam, run:

```bash
node --import tsx scripts/dev/lcx-agent-exam.ts --json
```

This is read-only by default. It combines doctor, training-plan, promotion
audit, module-learning review, thinking-hierarchy integrity, work-status
boundary integrity, memory-sedimentation integrity, automation coordination,
Lark/Feishu boundary, and optional L5 evidence into one table-like verdict. It
does not start training, does not run heavy MLX eval, does not touch provider
config, and does not prove live-visible-fixed. Use `--live` only when you
intentionally want channel/Lark probe evidence, and still require fresh real
inbound plus visible reply before claiming live-visible-fixed. Use `--l5` for
the heavier local L5 regression battery.

The default system doctor includes doctrine-consistency and head-tail
consistency gates. Doctrine consistency fails when active entrypoints drift back
toward stale stage wording, tiny symptom-patch rules, static brain adapters,
invalid eval commands, upstream package identity, or missing L5 regression skill
wiring. Head-tail consistency fails when macro doctrine/prompt/runbook changes
and micro implementation tails no longer supervise each other. It covers module
learning and broader engineering details: dev/live boundary, protected memory,
Lark/Feishu visible reply, local automation, memory sedimentation, finance
capability, eval/review output, and fast change-impact planning.

## Context Recovery And Daily Continuity

When Codex context is missing, do not reconstruct the system from memory. Use
the durable local operator state first:

```bash
sed -n '1,220p' /Users/liuchengxu/.openclaw/workspace/state/lcx-local-operator-latest.json
tail -n 5 /Users/liuchengxu/.openclaw/workspace/logs/lcx-local-operator-loop.jsonl
tail -n 5 /Users/liuchengxu/.openclaw/workspace/logs/codex-archive-lcx-automation-threads.log
```

The intended daily structure is:

- Local launchd automation runs the lightweight operator loop and Codex-thread
  cleanup without opening new Codex conversations.
- The single visible Codex automation is `LCX Agent Operator Digest`; it reads
  the local operator state and reports only the most important blocker or next
  action.
- Small repairs must name their master lane before coding: Qwen training,
  MiniMax teacher, adapter promotion, Lark/Feishu reply, local automation,
  memory sedimentation, finance capability, or dev/live boundary.
- Durable proof beats chat memory. Prefer tests, smoke/eval output,
  `lcx-system-doctor`, `local-brain-training-plan`, local automation receipts,
  log anchors, and git commits.
- Keep evidence labels strict: dev/local proof is not live-visible proof;
  source storage is not learning; system-level internalization is not Qwen
  weight absorption; `parseRecovered` is not a clean promotion pass.

## Prior-Work Reuse Gate

Before adding a new local-brain contract, eval, teacher prompt, skill, receipt,
automation, or internalization workflow, check whether a similar mechanism
already exists. Start with targeted search instead of inventing a parallel lane:

```bash
rg -n "<keyword>|<task_family>|<case_id>|<module_id>" \
  scripts/dev test ops/local-brain AGENTS.md README.md docs src extensions
find /Users/liuchengxu/.codex/skills -maxdepth 2 -name SKILL.md | sort
```

Prefer extending existing source registry, capability-card, retrieval/apply,
eval, skill-harvester, receipt, and runbook paths. If a new path is still
needed, leave the decision in the artifact or summary as:

```text
prior_art_checked=<files_or_receipts>
decision=reuse|extend|new
why_existing_path_was_insufficient=<short_reason>
```

For papers, open-source projects, external skills, and finance research modules,
this gate is mandatory before claiming anything was learned or internalized.

## All-Module Internalization Chain

Do not treat the source-to-learning chain as a factor-only mechanism. Any local
brain module that claims it learned from the web, a paper, a repo, a tool, a
skill, a transcript, or another external artifact must leave this evidence:

```text
target_module_id_or_module_family
source_url_or_local_source_path
actual_reading_scope
source_registry_record
module_specific_capability_rule
capability_card_or_retrieval_receipt
application_validation_receipt
training_or_eval_absorption_evidence
fresh_adjacent_application_task
module_specific_safety_boundary
keep_downrank_or_discard_decision
```

This applies to factor, options, indexes, macro, fundamentals, technical timing,
commodities, FX, event-risk, Lark/Feishu workflow, agent workflow, memory, eval,
ops, and skill modules. A stored source, summary, or dataset row is not enough
to say the module learned it. Use `stored_only`, `retrieval_ready`,
`application_ready`, or `eval_absorbed` style wording until the matching proof
exists.

Use the read-only planning tool before running or inventing a module-specific
learning pipeline:

```text
module_learning_pipeline_plan
```

CLI wrapper:

```bash
node --import tsx scripts/dev/module-learning-pipeline-plan.ts \
  --target-module options_volatility \
  --source <source-url-or-local-path> \
  --actual-reading-scope "<what was actually read>" \
  --existing-artifact scripts/dev/local-brain-distill-eval.ts \
  --write \
  --json
```

It maps every supported `targetModule` onto the required evidence,
module-specific capability rule, application-validation task, and existing tool
bridge:

```text
factor_research
options_volatility
global_index_regime
macro_rates_inflation
company_fundamentals_value
financial_modeling_valuation_qc
thesis_catalyst_lifecycle
data_provenance_quality
research_artifact_qc
technical_timing
commodities_oil_gold
fx_currency_liquidity
event_driven
portfolio_risk_gates
lark_feishu_workflow
agent_workflow_memory
ops_audit
skill_pattern_distillation
```

Finance research modules should reuse
`finance_learning_pipeline_orchestrator` where possible. Lark/Feishu, ops,
`finance_learning_memory`, and skill modules must keep module-specific receipts
and must not be claimed as learned from storage alone.

When `writeReceipt=true`, the tool writes a dev/local receipt under:

```text
~/.openclaw/workspace/memory/module-learning-pipeline-plan-receipts/<YYYY-MM-DD>/
```

Use `--workspace PATH` only for isolated tests or an explicit alternate local
workspace. Do not write these receipts into repo `memory/`; the review,
training-plan, doctor, and agent exam all read the local OpenClaw workspace.

The receipt status is evidence-derived: `missing_evidence`, `stored_only`,
`retrieval_ready`, `application_ready`, or `eval_absorbed`. Do not upgrade a
module beyond the returned status in summaries, Lark replies, or training
handoffs.

Use the review tool to inspect same-day module-learning proof before claiming
cross-module learning progress:

```text
module_learning_pipeline_review
```

It reads only:

```text
~/.openclaw/workspace/memory/module-learning-pipeline-plan-receipts/<YYYY-MM-DD>/
```

When `writeReview` is not false, it writes:

```text
memory/module-learning-pipeline-reviews/<YYYY-MM-DD>.json
```

The review flags weak module-learning receipts that are still `stored_only`,
`retrieval_ready`, or `application_ready`, plus any receipt that claims live,
provider config, or protected-memory mutation. Treat that review as dev/local
status evidence only; it is not live-visible proof and it does not mean Qwen
weights absorbed the lesson unless eval or training evidence is present.

The default system doctor runs the same review in no-write mode:

```bash
node --import tsx scripts/dev/lcx-system-doctor.ts --json
node --import tsx scripts/dev/lcx-module-learning-absorption-gate.ts --json
```

Weak module-learning receipts appear in the `module-learning-pipeline-review`
check. Ordinary in-progress statuses do not fail the doctor, but boundary
violations do.

The absorption gate should report `hold_at_application_ready` while same-day
receipts are still weak. That is expected and prevents `dev-ready` learning
evidence from being overstated as model-weight absorption.

When clean hardened eval evidence exists and the operator intentionally wants to
close the same-day module-learning lane, the absorption gate can write dev/local
evidence and superseding `eval_absorbed` plan receipts:

```bash
node --import tsx scripts/dev/lcx-module-learning-absorption-gate.ts \
  --write-absorbed-plan-receipts --json
node --import tsx scripts/dev/module-learning-pipeline-review.ts --json
node --import tsx scripts/dev/lcx-module-learning-absorption-gate.ts --json
```

The review uses active receipts for `receiptFiles`, `applicationReady`,
`evalAbsorbed`, and `weakModuleLearning`. `rawReceiptFiles` includes historical
receipts too, and `supersededReceiptFiles` names old `application_ready`
receipts replaced by newer `eval_absorbed` receipts. Do not delete the old
receipts to make the count look clean; they are the audit trail.

The global learning-sedimentation audit may show historical `evalAbsorbed`
counts while today's active receipts still have `weakModuleLearning > 0`. That
state is only partial absorption. It must not print
`usable_and_module_certifiable` until `weakModuleLearning=0` and boundary
violations are also zero.
The learning-sedimentation map should mirror this: use
`partial_eval_absorption_with_weak_receipts` for mixed historical/active
evidence, `boundary_violation_blocks_absorption` for boundary drift, and reserve
`module_eval_absorbed_receipts_clean` for the clean ready state.

For the automation lane that should leave a daily dev/local receipt, run:

```bash
node --import tsx scripts/dev/module-learning-pipeline-review.ts --json
```

Use `--no-write` for a dry run. The script writes only
`~/.openclaw/workspace/memory/module-learning-pipeline-reviews/<YYYY-MM-DD>.json`
by default; it must not be used as live proof or model-weight absorption proof
by itself. Use `--workspace PATH` only for isolated tests or an explicit
alternate local workspace.

The training coordinator also includes the same no-write review in its JSON:

```bash
node --import tsx scripts/dev/local-brain-training-plan.ts --json
```

Look at `moduleLearningReview` and the `module_learning_incomplete_evidence`
decision before claiming cross-module learning improved. This keeps automation
from confusing "training is active" with "every module-learning source has been
absorbed."
If `lcx-context-recovery-exam` reports
`local_operator_latest_matches_current_workflow_surface` as false, refresh the
local operator receipt before trusting compressed-context recovery; a recent
timestamp alone is not enough when the current worktree's flow graph changed.
Training state is more volatile than the hourly operator receipt. The recovery
exam runs a fresh `local-brain-training-plan` and exposes
`operatorDecisionIdsMatchCurrent`; use the fresh plan for active guard,
candidate, promotion, and module-learning decisions when that flag is false.
Expected in-progress candidate movement should not become an actionable warning
when the stable operator fields still match; the fresh training plan is the
commercial runtime owner for volatile training facts.

The local-brain contracts, eval case, and MiniMax teacher curriculum also require
`module_learning_pipeline_review_status` for all-module source learning. A
`module_learning_pipeline_plan` receipt is therefore only a planning artifact
until review, application, and eval/training evidence close the loop.

Alternative finance sources follow the same module-learning lane, not a separate
special lane. Management interviews, investor blogs, podcasts, social sentiment,
viral executive meetings, and market-attention stories are weak evidence until a
source registry entry, actual reading scope, reliability grade, primary source
or transcript, official follow-up, fundamental follow-through, market
follow-through window, retrieval/apply evidence, eval or training absorption,
module-learning review, and keep/downrank/discard decision are all present. The
only allowed interim status is hypothesis-only or downranked; these sources must
not become direct causality, standalone alpha, sizing authority, or durable
doctrine by themselves.

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
/Users/liuchengxu/.codex/skills/lcx-qwen-training-operator/SKILL.md
/Users/liuchengxu/.codex/skills/lcx-workflow-waterflow-auditor/SKILL.md
/Users/liuchengxu/.codex/skills/l5-regression-batterer/SKILL.md
/Users/liuchengxu/.codex/skills/l4-regression-batterer/SKILL.md
/Users/liuchengxu/.codex/skills/skill-harvester/SKILL.md
/Users/liuchengxu/.codex/skills/cli-anything-harvester/SKILL.md
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
- `lcx-qwen-training-operator`: check Qwen 24-hour training/eval/backoff/restart supervision without creating overlap.
- `lcx-workflow-waterflow-auditor`: check god-view workflow closure, waterflow routing, head-tail consistency, and memory sedimentation gaps.
- `l5-regression-batterer`: L5 baseline pressure tests with realistic Chinese finance/control-room prompts.
- `l4-regression-batterer`: legacy compatibility alias only; prefer the L5 skill in new work.
- `skill-harvester`: evaluate and isolate new external or local skills before letting them affect the agent.
- `cli-anything-harvester`: evaluate CLI-Anything, CLI-Hub, GUI/local software CLI wrappers, and safe agent-native software-control plans before any wrapper is trusted.

The skills are operator guidance, not durable market memory. Do not copy their text into protected repo memory.
The local reply path also has deterministic skill preflight for common LCX
operator asks. Natural-language requests about Qwen training, whole-system
waterflow, agent brain learning, Lark live proof, runtime drift, finance
learning, CLI-Anything, and skill harvesting should be cued to one installed
skill before the model answers. Explicit `/skill ...` commands still win.

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
/Users/liuchengxu/.codex/skills/security-ownership-map/SKILL.md
/Users/liuchengxu/.codex/skills/playwright/SKILL.md
/Users/liuchengxu/.codex/skills/playwright-interactive/SKILL.md
/Users/liuchengxu/.codex/skills/jupyter-notebook/SKILL.md
/Users/liuchengxu/.codex/skills/gh-fix-ci/SKILL.md
/Users/liuchengxu/.codex/skills/gh-address-comments/SKILL.md
/Users/liuchengxu/.codex/skills/yeet/SKILL.md
/Users/liuchengxu/.codex/skills/pdf/SKILL.md
/Users/liuchengxu/.codex/skills/doc/SKILL.md
/Users/liuchengxu/.codex/skills/transcribe/SKILL.md
/Users/liuchengxu/.codex/skills/screenshot/SKILL.md
/Users/liuchengxu/.codex/skills/self-improving-for-codex/SKILL.md
/Users/liuchengxu/.codex/skills/cli-anything-harvester/SKILL.md
```

Use these as support tools, not as LCX doctrine:

- `cli-system-doctor`: CLI-first diagnosis across build, typecheck, lint, and smoke paths.
- `cli-json-noise-doctor`: fix JSON commands polluted by logs or non-JSON output.
- `live-sidecar-sync-doctor`: dev/live-sidecar drift checks and bounded sync planning.
- `repo-migration-cleaner`: OpenClaw/lobster to LCX naming cleanup.
- `semantic-family-miner`: batch-mining historical semantics for regression only, not as the main natural-language brain.
- `security-best-practices`, `security-threat-model`, and `security-ownership-map`: security review, trust-boundary checks, and security ownership topology when explicitly requested.
- `playwright` and `playwright-interactive`: browser verification for UI or localhost work.
- `jupyter-notebook`: finance research, data experiments, and tutorials that need a notebook artifact; do not treat notebooks as trading execution.
- `gh-fix-ci`, `gh-address-comments`, and `yeet`: GitHub/CI/publish workflows when explicitly needed.
- `pdf`, `doc`, and `transcribe`: local document and audio workflows.
- `screenshot`: desktop or Lark/Feishu visual evidence capture when the user asks or when a visible UI proof is needed.
- `self-improving-for-codex`: Codex-global memory loop maintenance only; do not use it to replace LCX Agent's repo-local operator, doctor, memory, or training receipts.
- `cli-anything-harvester`: CLI-Anything/CLI-Hub and local software wrapper evaluation only; keep wrappers isolated with JSON contracts, safety boundaries, and local proof before promoting any pattern.

Keep deployment, external service, and content-production skills such as
`cloudflare-deploy`, `netlify-deploy`, `render-deploy`, `vercel-deploy`,
`notion-*`, `linear`, `sentry`, `figma`, `imagegen`, `speech`, and platform
publishing workflows in Codex global scope unless the user explicitly asks for
that tool. They are not default LCX Agent runtime capabilities and must not
become finance-brain, Lark, provider, or live-sender authority.

Do not migrate `chronicle` into LCX Agent. Treat it as a Codex-session
observation aid with sensitive context boundaries, not as durable agent memory
or runtime workflow.

Plugin-provided skills may also appear in a Codex session, for example Hugging Face, GitHub, browser, or web-app skills. Treat those as session capabilities, not repo-pinned guarantees. If an external skill is missing, use `skill-harvester` to evaluate and install it in an isolated folder before relying on it. If the request is specifically about CLI-Anything, CLI-Hub, controlling local software through a CLI wrapper, or making desktop software agent-native, use `cli-anything-harvester` first and only distill verified workflow patterns back into LCX Agent.

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
  --bootstrap-if-missing \
  --model Qwen/Qwen3-0.6B \
  --log /Users/liuchengxu/.openclaw/workspace/logs/minimax-brain-training-guard-medium.jsonl
```

The expected current selection pattern is:

```text
selectionMode=latest-passing
adapterPrefix=.../thought-flow-v1-qwen3-0.6b-minimax-guard
```

Read `selectedAdapter` and `trainingSeedAdapter` separately. `selectedAdapter`
means strict promotion-ready selection. `trainingSeedAdapter` is a best-evidence
fallback for continuing local Qwen work when no strict promotion-ready adapter
exists yet; it must not be reported as promotion-ready.

The guard now filters `latest-passing` by model-specific adapter prefix, so a future Qwen3 1.7B bootstrap cannot accidentally reuse a Qwen3 0.6B adapter.

When no strict `promotionReady=true` adapter exists, the guard may still choose a
best-effort training seed so local Qwen does not restart from the base model. That
seed must be chosen by eval evidence, not by newest timestamp. The current rule
prefers the non-promotion candidate with the strongest eval shape: more passed
cases first, then broader coverage, then pass rate, then fewer failures. This
prevents a newer weak candidate from replacing an older stronger seed such as a
`53/59` candidate.

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
  --train-every 2 \
  --eval-every 1 \
  --train-iters 40 \
  --load-max 100 \
  --train-load-max 12 \
  --log /Users/liuchengxu/.openclaw/workspace/logs/minimax-brain-training-guard-medium.jsonl
```

The `--train-load-max 12` guard is intentional. It allows MiniMax sample generation and eval to continue while skipping local MLX LoRA training when the machine is already under pressure.

The guard passes `--failure-focus` to the MiniMax sidecar. Each teacher batch can
mix in targeted prompts generated from the latest failed hardened eval cases, so
MiniMax spends part of the quota on Qwen's current weak spots instead of only
generic synthetic prompts.

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
  --adapter latest-passing \
  --hardened \
  --summary-only \
  --json
```

The eval result reports `adapterSelectionStatus`. Treat
`best_effort_training_seed` as a dev training seed, not as promotion-ready.

Promotion is acceptable only when:

```text
promotionReady=true
failedCaseIds=[]
```

For a lightweight read-only promotion audit that resolves `latest-passing`,
checks it against the latest guard-log eval, and reports a standardized
decision without moving/deleting/promoting adapters, run:

```bash
node --import tsx scripts/dev/local-brain-promotion-audit.ts --json
```

Expected boundary:

```text
dev_local_brain_promotion_audit_only
```

Treat `promotionDecision=safe` as dev promotion-audit evidence only. It does not
promote an adapter by itself and it is not live-visible proof.

### Capability Hierarchy Gate

Local-brain evals must preserve a simple-to-complex hierarchy. A complex case may
declare prerequisite cases, and `local-brain-distill-eval.ts` auto-includes them
when a complex `--case-id` is selected. This prevents a false state where the
brain passes a hard scenario but fails the simple Lark-style ask.

Example:

```bash
node --import tsx scripts/dev/local-brain-distill-eval.ts \
  --contract-only \
  --case-id commodity_fx_inflation_inventory_portfolio_loop \
  --summary-only \
  --json
```

Expected hierarchy evidence includes:

```text
autoIncludedPrerequisiteCaseIds=["short_lark_commodity_learning_intake"]
promotionReady=true
```

If a complex eval is added, add or reuse a simple prerequisite. The simple case
must pass before the complex case can support promotion.

The contract-only eval registry currently targets 200 cases. The expansion is
kept as generated high-signal variants in `local-brain-distill-eval.ts`, grouped
by realistic Lark short asks, core finance research loops, module learning,
alternative sources, local memory activation, abstraction transfer, and
adversarial boundaries. Do not hand-write a parallel eval registry for the same
families; extend the existing registry, keep prerequisite coverage, and prove it
with:

```bash
node --import tsx scripts/dev/local-brain-distill-eval.ts \
  --contract-only \
  --summary-only \
  --json
```

`200/200 promotionReady=true` under `--contract-only` means the dev routing and
output contract closed for those cases. It is not live-user-seen proof and not
model-weight absorption proof.

When a user provides one concrete example, treat it as a seed for a generic
capability contract, not as the whole repair scope. The fix should cover the
original example, a simpler prerequisite entry, and at least one adjacent
non-identical scenario so the brain cannot pass by memorizing one phrase.

For abstraction-transfer repairs, leave five-part evidence in the patch summary,
receipt, eval, or doctor output: `original example`, `abstracted failure family`,
`adjacent non-identical scenario`, `shared contract`, and `regression proof`.

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

Persistent LaunchAgent path:

```text
/Users/liuchengxu/Library/LaunchAgents/lcx.minimax.brain.medium.2026-05-05T06-28-30Z.plist
```

It uses `RunAtLoad` plus `KeepAlive`, so the medium guard restarts after a 285
minute guard cycle or after a machine reboot. The guard lock still prevents
overlapping local-brain training.

If the launchd command contains an old explicit `--current-adapter ...T05-00-48...r2`, replace it with a command that omits `--current-adapter` so the guard uses `latest-passing`.

If logs show `best_effort_training_seed_selected`, verify that the selected seed
is the highest-scoring retained candidate, not merely the newest adapter
directory:

```bash
node --import tsx scripts/dev/minimax-brain-training-guard.ts \
  --resolve-current-adapter \
  --bootstrap-if-missing \
  --model Qwen/Qwen3-0.6B \
  --log /Users/liuchengxu/.openclaw/workspace/logs/minimax-brain-training-guard-medium.jsonl
```

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
