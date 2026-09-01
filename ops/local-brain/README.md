# LCX Local Brain Ops Quickstart

Use this when the chat context is gone and you need to quickly resume LCX local-brain work.

This runbook is local only. It does not prove `user-visible-observed`, does
not touch the external sender compatibility path, does not edit provider config,
and does not write protected memory.

## Fast Micro-Change Loop

For a small engineering change, do not start by scanning the whole repo or
running every gate. First classify the changed files and get the required
verification set for the affected lanes:

```bash
node --import tsx scripts/operator/lcx-change-impact-plan.ts --json
```

The planner reads the current git diff/status, assigns every touched file to a
master lane, and returns `recommendedFastCommands`. Use it before routine edits
to keep small work fast. It is local only and reports `liveTouched=false`,
`providerConfigTouched=false`, and `protectedMemoryTouched=false`.

## Canonical Ontology

LCX Agent uses src/shared/lcx-ontology.ts as the single semantic registry.
It owns entity types, relations, modules, finance data/source/evidence
vocabularies, learning targets, task families, workflow nodes and filters,
evidence states, learning states, delivery milestones, and safety boundaries.
Taxonomy, contracts, learning tools, finance framework/data gateway, flow graph,
and evidence projection must import or validate against this registry; consumers
must not introduce a parallel vocabulary.
Relation types also carry subject/object entity-type contracts; a relation
without a registered contract is invalid. `unknown` and
`partial_json_object` are non-canonical task-family outcomes for sentinel or
parser reporting only, never semantic task meaning.
The registry is extended in place by default. A physical move requires a
versioned explicit migration, and parallel registries are forbidden.
The ontology evolution contract also assigns every vocabulary to one of five
vocabulary groups and distinguishes additive canonical values from breaking
semantic changes. Additive canonical values and compatibility aliases stay in
place after ontology audit, impact planning, and focused regression; renames,
removals, relation/state changes, classification changes, and source moves
require a version bump, a migration manifest, and the relevant head-tail,
flow-graph, and mind-model proofs.
The migration manifest schema is `lcx_ontology_migration_v1`; it records the
exact change kind, scope, before/after identifiers, affected vocabularies,
compatibility mode, rollback posture, and required proofs.

Lark/Feishu-specific identifiers in the registry are classified as adapter
implementation labels, not as core facts; old live/dev-shaped labels are
compatibility labels only. New semantic objects should use neutral adapter,
delivery, evidence, and boundary vocabulary.

Run the read-only ontology owner before changing cross-layer semantics:

    node --import tsx scripts/operator/lcx-ontology.ts --json

The owner checks registry uniqueness, alias targets, contract task-family
coverage, and integration anchors. It reports local_ontology_registry_only and
never changes providers, training, protected memory, or external-channel
sender state.

Run the heavier checkpoint after the focused checks, or immediately when the
planner reports elevated risk:

```bash
node --import tsx scripts/operator/lcx-system-doctor.ts --json
```

When a change may cause Codex, Claude Code, or another future agent to see only
one local detail while missing the larger workflow, run the LCX Agent Mind Model
god-view check:

```bash
node --import tsx scripts/operator/lcx-mind-model.ts --json
node --import tsx scripts/operator/lcx-flow-graph.ts --json
node --import tsx scripts/operator/lcx-universe-index.ts --json
node --import tsx scripts/operator/lcx-context-recovery-exam.ts --json
node --import tsx scripts/operator/lcx-problem-cluster-radar.ts --json
node --import tsx scripts/operator/lcx-governance-autopilot.ts --json
node --import tsx scripts/operator/lcx-commercial-acceptance-harness.ts --json
node --import tsx scripts/operator/lcx-change-impact-plan.ts --json
node --import tsx scripts/operator/lcx-live-fadeout-audit.ts --json
node --import tsx scripts/operator/lcx-ts-python-boundary.ts --json
node --import tsx scripts/operator/local-brain-training-plan.ts --json
node --import tsx scripts/operator/lcx-learning-sedimentation-bridge.ts --json
node --import tsx scripts/operator/lcx-learning-sedimentation-audit.ts --json
node --import tsx scripts/operator/lcx-learning-sedimentation-map.ts --json
node --import tsx scripts/operator/lcx-module-learning-absorption-gate.ts --json
node --import tsx scripts/operator/lcx-system-memory-sedimentation-gate.ts --json
```

This is a read-only `local_mind_model_only` architecture audit. It checks whether
each main lane still has workflow closure across four surfaces: macro rule,
workflow entrypoint, proof/eval surface, and boundary flag. It covers context
recovery, change-impact planning, Qwen training, MiniMax teacher, adapter
promotion, Lark/Feishu external-channel/user-visible boundary, local automation,
memory sedimentation, finance research capability, and
protected-memory/provider/external-sender boundaries. It reports
`liveTouched=false`, `providerConfigTouched=false`, and
`protectedMemoryTouched=false`; it does not prove `user-visible-observed` or
legacy `live-visible-fixed`.
It also checks the invariant registry for repeated failure families: surface
files must exist, local operator state must be fresh, temporary test HOME values
must not hide the real operator files, overlapping local-brain training must
stay visible, core/external-channel/user-visible wording must stay separate,
content claims need source or unverified flags, and stored sources must not be
treated as learned module capability.

The same command exposes a read-only `Global Evidence Projection` so Codex,
LCX, local automation, and every message adapter can consume one neutral
shape. The projection contains `Capability`, `Evidence`, `Action`, and
`Delivery` objects. It is not another truth owner: existing owner receipts
remain authoritative. `Delivery.adapterId` is always present and is `null`
until a delivery proof is attached; the projection does not send messages,
start training, change providers, or write protected memory.
Its boundary statuses are scoped to `projection_only`, so a
`not_touched_by_projection` value must not be read as a global runtime absence.
Only an independent owner proof with receipt id, timestamp, and matching
visibility can move Delivery from `unknown` to `bound` or `observed`.
Governance Autopilot republishes the validated object at the top-level
`globalEvidenceProjection` field of its latest receipt. Its `readStatus` is
`current`, `stale`, `missing`, or `invalid`; consumers must block adapter
actions whenever `blocked=true`, and continue to treat owner receipts as the
source of truth.
Every automation or communication adapter must enter through
`readGlobalEvidenceProjectionForAdapter` with a non-empty opaque reader id.
That reader id labels the consumer, not the delivery proof; the adapter must
not author projection facts, delivery proof, or owner decisions.
The current implementation proof covers the governance automation and the
read-only farm dashboard; that is contract wiring, not proof that every
future message adapter has consumed the projection.
The neutral answer boundary is `src/auto-reply/reply/dispatch-from-config.ts`:
it accepts an optional projection candidate and emits a reader receipt for the
caller. This is transport-neutral observation only; it is not injected into a
model prompt, and a blocked read does not rewrite or suppress the ordinary
reply path. Message adapters still need their own bounded migration proof.
Use `node --import tsx scripts/operator/lcx-projection-reader-audit.ts --json`
to inventory known adapter entrypoints. Its `ok` field only means the listed
entrypoints exist; `summary.readerContractReadyForAllAdapters` is the separate
readiness gate.

The LCX Agent Flow Graph is the waterflow exam. It verifies that each task
family has a start node, terminal node, required modules, filter valve list,
receipts, and bounded feedback edges. It is designed to catch wrong-flow before
it becomes a visible bug: local proof must not jump to `user-visible-observed` or
legacy `live-user-seen`, stored source must not jump to learned capability,
hardened eval must not skip promotion gate, and training/eval loops must not
recirculate without overlap guards or timeout/error receipts. Its proof surface
is `flow_graph_exam`.
It also emits `diagnosticIndex`. Treat that as the fast operator triage table:
scenario family, detected failure class, owner entrypoint, fast check command,
required filters, evidence receipts, failure signals, and the
`local_flow_graph_only` boundary. If a future window sees a workflow symptom, it
should use this index to find the owner path first instead of creating another
parallel doctor.
The LCX Agent Universe Index is the fastest total-coverage inventory:

```bash
node --import tsx scripts/operator/lcx-universe-index.ts --json
```

Use it when the task says all files, all code, all artifacts, all outputs, all
garbage, or "一切的一切". It indexes repo tracked and visible files, dirty and
untracked files, owner coverage, workspace state/log/memory/tmp artifacts, live
sidecar files, stale snapshots, large runtime artifacts, and
`garbageCandidates`. It is `local_universe_index_only`: inventory and cleanup
candidates only, no delete/migration/live authority, and always
`liveTouched=false`, `providerConfigTouched=false`, `protectedMemoryTouched=false`.
Route candidates back to the matching owner before repair or cleanup.
The Problem Cluster Radar is the current-issue aggregator for that governance
stack:

```bash
node --import tsx scripts/operator/lcx-problem-cluster-radar.ts --json
```

It reads existing owner outputs and emits `problemClusters`,
`actionableClusters`, `repairableSignals`, `ownerEntrypoint`, and
`sourceOwners`. It is not allowed to become a second truth owner for training,
eval, module learning, flow graph, or context recovery. Its job is to group
current red lights so a future Codex window can see that, for example, eval
timeout, parseRecovered promotion block, module-learning absorption gap, stale
recovery, dirty worktree, or a Codex-repairable teacher/output-contract
sub-signal are active problem clusters without manually rediscovering them from
raw logs. A blocked mixed cluster must not hide a sub-signal whose owner already
marked `codexRepairEligible=true`.
Run it automatically before non-trivial repairs, training/promotion judgments,
module-learning absorption claims, memory sedimentation claims, Lark
external-channel/user-visible boundary claims, and broad "find more problems"
work. Start with the radar to get the cluster list, then follow each cluster's
`ownerEntrypoint`; do not let the radar replace those owners. If the training
plan shows active
Qwen/MiniMax/MLX work, do not start a second heavy eval from this governance
stack.
The Governance Autopilot is the read-only automatic trigger for the same stack:

```bash
node --import tsx scripts/operator/lcx-governance-autopilot.ts --json
```

It runs problem radar, commercial acceptance, change impact, universe index,
external agent/blacktech upgrade radar, live fadeout audit, training plan, Lark
external-channel binding, mind model, flow graph, head-tail, and context
recovery; writes
`/Users/liuchengxu/.openclaw/workspace/state/lcx-governance-autopilot-latest.json`
and refreshes
`/Users/liuchengxu/.openclaw/workspace/state/lcx-evolution-promotion-digest-latest.json`
and
`/Users/liuchengxu/.openclaw/workspace/state/lcx-context-recovery-handoff-latest.md`;
it also writes the compact local failure index card
`/Users/liuchengxu/.openclaw/workspace/state/lcx-local-failure-trace-latest.json`
and appends
`/Users/liuchengxu/.openclaw/workspace/logs/lcx-local-failure-trace.jsonl`;
and it writes the plain-Chinese owner brief
`/Users/liuchengxu/.openclaw/workspace/state/lcx-owner-brief-latest.md`
with JSON at
`/Users/liuchengxu/.openclaw/workspace/state/lcx-owner-brief-latest.json`;
it also writes the owner control map
`/Users/liuchengxu/.openclaw/workspace/state/lcx-owner-control-map-latest.md`
with JSON at
`/Users/liuchengxu/.openclaw/workspace/state/lcx-owner-control-map-latest.json`;
and is refreshed by `/Users/liuchengxu/.openclaw/bin/lcx-local-operator-loop.sh`
inside `lcx-local-operator-latest.json` as `governanceAutopilot`. It is
`local_governance_autopilot_only`: read-only, no overlapping training, no
external-channel apply, no provider config, no protected memory, and no
external sender compatibility changes.
Owner write policy for the self-repair hands is intentionally narrow.
Governance autopilot may auto-add
`--write` to `lcx-self-repair-hands` only when a current owner signal changes:
candidate eval has failed/dirty/recovered cases, module-learning evidence is
incomplete, or SkillOpt reports a static/format gate gap. The de-duplication
key is `signalKey`, so the same signal writes at most once. The output is only
memory correction/downrank notes, training/eval candidate packets, repo patch
candidate plans, state, and logs under the workspace. It must not touch repo
source, git index/commit, external sender compatibility path, provider config,
protected memory, formal language corpus, training processes, train-slice
direct writes, or model-weight absorption claims.
The Commercial Acceptance Harness is the product-grade exam above those owners:

```bash
node --import tsx scripts/operator/lcx-commercial-acceptance-harness.ts --json
```

It consumes commercial answer pipeline, problem radar, flow graph, mind model,
external-channel status, training plan, short-intent fuzzer, visible-answer
quality fuzzer, and system doctor/provider council evidence. It is not a new
truth owner, does not send Lark messages, and does not start training.
The short-intent fuzzer is the owner that prevents the fixed short Lark canaries
from becoming a brittle whitelist:

```bash
node --import tsx scripts/operator/lcx-lark-short-intent-fuzzer.ts --json
```

It generates terse Lark-style variants by failure family and requires unknown
short asks to fail cleanly with owner evidence or a concrete missing-proof
reason, not a generic intro, direct action answer, or silent success.
The visible-answer quality fuzzer is the paired positive gate:

```bash
node --import tsx scripts/operator/lcx-visible-answer-quality-fuzzer.ts --json
```

It proves the system adopts concise useful answers for status, missing data,
portfolio risk, learning, model disagreement, async work, entry/exit, and
user-supplied arithmetic while still rejecting vague, generic, unsafe, or
over-conservative replies. This prevents the answer gate from becoming a pure
rejection machine.
The real Lark candidate capture/replay gate is the field-proof companion:

```bash
pnpm --silent openclaw capabilities lark-loop-diagnose --json
```

It must show that real Lark user utterances and final visible replies are
persisted under `memory/lark-language-routing-candidates/` and replayed through
the routing/visible-answer owners. Handoff receipts alone are not enough; if
`candidateArtifactCount=0` while handoff receipts exist, the system has only
inferred proof and commercial acceptance must block or watch it. This keeps the
entry/exit product loop from passing only synthetic canaries while real Lark
answers still leak wrong routing, silence, generic intros, or useless cautious
fallbacks.
The focused daily finance product owner is:

```bash
node --import tsx scripts/operator/lcx-directed-daily-research-brief.ts --json
```

Use `--write` only when the operator wants a durable daily packet written under
the workspace state and memory directories. This owner deliberately narrows the
main daily product to index options, semiconductor/AI compute-chain research,
timely-stock candidate radar, risk gates, invalidation, and learning
sedimentation. It does not fetch live data, send Lark messages, start training,
or produce trading instructions. Open Q&A remains a follow-up surface; the daily
packet is the dependable research surface.
Treat `blocked` gates as explicit acceptance gaps: post-migration natural Lark
canary missing, provider degradation, active Qwen guard, or owner-gated module
learning states are not green release proof.
It should not stay at only six obvious waterflows. The current minimum is 17
core waterflows, including universe index total coverage, Lark visible language,
commercial answer pipeline, commercial acceptance harness, provider council
evidence, memory correction/downrank, same-philosophy engineering
consolidation, external skill or agent distillation, automation repair locks,
and finance data gateway reconciliation. The same-philosophy consolidation clusters enforce that related
mechanisms merge into one owner scenario instead of becoming parallel systems.

The TS/Python boundary check keeps code ownership from scattering:

```bash
node --import tsx scripts/operator/lcx-ts-python-boundary.ts --json
```

Plain rule: TS is the main control room; Python is the engine room. Python is
allowed for training, MLX/model runs, data computation, and isolated tool
engines. Old Python workflow scripts must either be wrapped by a named TS owner
or moved to TS. The output lists `保留`, `包装`, and `迁走`; any new Python file
that is not classified is a red light.

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
recoverable state after context loss, and strict
core/external-channel/user-visible/protected-memory boundaries. Use
`lcx-mind-model`, `lcx-flow-graph`, `lcx-head-tail-consistency`,
`lcx-system-doctor`, `local-brain-training-plan`,
`lcx-context-recovery-exam`, `lcx-problem-cluster-radar`, and the
external-channel binding/probe owner as the governance stack. If these surfaces
disagree, treat it as architecture debt before expanding features.

## Commercial L5 Blueprint

Use this as the current 1-6 execution plan. It is owned by the existing exam,
flow graph, runbook, and live-probe surfaces; do not create a parallel
blueprint lane.

1. External-channel closure: keep `core-ready`, `external-channel-bound`, and
   `user-visible-observed` separate. Lark/Feishu is the owner-agent external
   communication channel, not a second live brain or second runtime truth
   source. Lark official APIs, SDKs, and open-source connector code are only
   connector implementations; they never become model authority or brain state.
   Old `live-runtime-updated`, `live-user-seen`, and
   `live-visible-fixed` terms remain compatibility labels only:
   `legacy-live-runtime-updated`, `legacy-live-user-seen`, and
   `legacy-live-visible-fixed`. A transport claim still needs connector
   build/restart/probe when applicable, real Lark inbound, outbound result, and
   visible reply evidence before any user-visible claim.
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
   answer or return a concrete failed reason. The local owner is:

   ```bash
   node --import tsx scripts/operator/lcx-commercial-answer-pipeline.ts --json
   ```

   Use it before touching answer composition, Lark visible reply wording,
   model/Qwen review, source gates, or control-room summaries. It is local-only:
   it does not call providers, the external sender compatibility path, or MLX,
   and it does not prove `user-visible-observed` or legacy `live-user-seen`.
   MiniMax Agent, when available, is allowed to raise answer quality as an
   external draft maker and red-team reviewer. Its output is still only a
   candidate: LCX must run local contract audit, source/data gates, Qwen
   patch-only challenge when needed, review panel, and visible answer adoption
   before the draft reaches the user. MiniMax Agent must not become final
   visible-answer authority, send Lark replies directly, change provider config,
   write protected memory, or gain trade/execution authority.
   Because MiniMax is a fixed monthly-capacity resource for this operator, use
   it aggressively on complex finance answers by default: event risk, current
   market context, portfolio/position questions, options/leverage/loss-recovery
   asks, earnings, macro/liquidity/rates, model disagreement, source conflict,
   and high-value research summaries should all get MiniMax Agent draft/red-team
   pressure before the local adoption gate. Do not spend that pressure on tiny
   factual replies or let the visible answer mention internal agent machinery.

5. External-channel observability summary: Lark proof must converge through
   `lark-loop-diagnose`, channel probe, `feishu-reply-flow.jsonl`, and fresh
   real-user inbound/reply evidence. Synthetic replay and local smoke stay
   local-only.

   Lark external-channel binding has its own owner command:

   ```bash
   node --import tsx scripts/operator/lcx-external-channel-binding.ts --json
   ```

   It reads `local-brain-training-plan.externalChannelBinding` first and only
   falls back to `local-brain-training-plan.liveLarkBrainBinding` for backward
   compatibility. It is read-only by default. When it reports
   `ready_for_apply`, the bounded idle-only apply path is:

   ```bash
   node --import tsx scripts/operator/lcx-external-channel-binding.ts --apply --json
   ```

   The apply path is allowed to sync/build/restart the external-channel sidecar
   and run `lark-loop-diagnose` only when eval/MLX is idle. It may prove
   `external-channel-bound`, but it must still keep `user-visible-observed=false`
   until fresh real Lark inbound/outbound evidence exists.

   This binding owner is canonical for `external-channel-bound`.
   `lcx-external-channel-status.ts` is the canonical read-only external-channel
   status wrapper; its legacy promotion/drift evidence is read from the neutral
   `lcx-external-channel-compat.ts` owner. The old promote-live aliases and
   forwarding wrappers have been removed. The status wrapper must not override a
   clean `lcx-external-channel-binding.ts` apply result.

   The whole-system fadeout audit is:

   ```bash
   node --import tsx scripts/operator/lcx-live-fadeout-audit.ts --json
   ```

   It is read-only. It checks whether every main LCX owner and package alias
   points to external-channel/user-visible proof first, while classifying
   upstream live tests, historical `ops/external-channel-history` receipts, and temporary
   sidecar compatibility as allowed legacy/platform uses.

   Cloud migration uses the same owner boundary. Do not migrate the old
   `dev -> live` split to the cloud. The migration target is one LCX Agent core:
   `local LCX core -> cloud-runtime-ready -> external-channel-bound -> user-visible-observed`.
   `cloud-runtime-ready` means a supported-region control machine has the
   canonical repo, canonical `~/.openclaw` state, operator skills, receipts,
   selected-clean adapter proof, and governance owners. It is not a second live
   brain, not a second runtime truth source, and not `user-visible-observed`.
   Future Lark, WeChat, SMS, Slack, or other connectors bind as external
   communication adapters only.

6. Product control room: default UX is one main control room with specialist
   detail on demand. Keep useful operator and specialist entrypoints, but every
   volatile status family needs one single factual owner and flow-graph
   consolidated entrypoint coverage.
7. Product-grade acceptance: run
   `node --import tsx scripts/operator/lcx-commercial-acceptance-harness.ts --json`
   to judge release readiness across answer quality, radar clusters,
   external-channel status, training overlap, provider council, real short Lark
   canaries, module-learning absorption, finance data gateway, and async receipt
   boundaries.
   It reports
   `readyForCommercialRelease`; blocked gates are evidence, not a reason to
   claim green.

`lcx-agent-exam --json` reports this plan as `commercialBlueprint` so a future
window can see which item is ready, blocked, needs receipts, or needs
external-channel/user-visible proof without rereading the chat.

The finance data gateway owner is `finance_data_gateway_snapshot`. Use it before
current market, price, fundamentals, macro, ETF, options, index-weight, vendor,
or portfolio-risk numbers reach Qwen, Lark, memory, or a visible summary. The
gateway requires provider role, source timestamp, timezone, field definition,
unit/currency, adjusted status, and source URL/artifact. Conflicted primary,
cross-check, or official/issuer evidence must route to data provenance review
instead of becoming an unstated model assumption.
If current data collection or learning review cannot finish in the foreground
reply, the visible Lark experience must say queued/completion/failure boundary
plainly and must not claim the data, source, or module has already been
absorbed.

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
node --import tsx scripts/operator/lcx-context-recovery-exam.ts --handoff
node --import tsx scripts/operator/lcx-context-recovery-exam.ts --handoff --json
```

The handoff snapshot includes dirty files, affected lanes, unmatched-file
checks, fresh training-plan decisions, module-learning absorption blockers,
flow-graph counts, strict core/external-channel/user-visible/protected-memory
boundaries, and the exact recovery commands. It is still local evidence
only; it does not prove `external-channel-bound`, `user-visible-observed`,
legacy `live-runtime-updated`, legacy `live-user-seen`, or Qwen model-weight
absorption.
The governance autopilot also refreshes a shorter machine-written handoff
capsule at
`/Users/liuchengxu/.openclaw/workspace/state/lcx-context-recovery-handoff-latest.md`.
Use that capsule for fast orientation in a compressed or new coding window, but
rerun `local-brain-training-plan` before acting on volatile PID, eval, adapter,
or external-channel binding truth.

## First Command

Start here:

```bash
cd /Users/liuchengxu/Desktop/lcx-s-openclaw
node --import tsx scripts/operator/lcx-system-doctor.ts --json
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
node --import tsx scripts/operator/local-brain-training-plan.ts --json
```

This is the shared training coordinator for future Codex windows and recurring
automations. It reads the guard/quota logs and classifies the next action into
one of the existing lanes: keep the medium guard running, feed MiniMax
failure-focus curriculum, run teacher-quality repair, run promotion audit, or
enter Codex auto-repair mode through the repo repair lock. Use this plan before
creating a new training script, eval lane, automation prompt, or one-off fix.
It is local only and must not be used to claim `user-visible-observed`.
When `lcx-problem-cluster-radar` reports `pendingVerificationSignals`, treat it
as dev repaired but not owner-verified: do not patch the same lane again until
the owning training, teacher, eval, or promotion command reruns and clears or
reopens the signal.
It reads module-learning receipts from `~/.openclaw/workspace` by default, not
from the repo worktree. Use `--workspace PATH` only for isolated tests or an
explicit alternate workspace. The plan must surface
`module_learning_incomplete_evidence` when module-learning receipts are
reviewable but not `eval_absorbed`.

For learning sedimentation specifically, run:

```bash
node --import tsx scripts/operator/lcx-learning-sedimentation-bridge.ts --json
node --import tsx scripts/operator/lcx-learning-sedimentation-audit.ts --json
node --import tsx scripts/operator/lcx-learning-sedimentation-map.ts --json
node --import tsx scripts/operator/lcx-module-learning-absorption-gate.ts --json
node --import tsx scripts/operator/lcx-system-memory-sedimentation-gate.ts --json
```

The bridge is a dry-run `local_learning_sedimentation_bridge_only` check by
default. It reads existing finance retrieval/apply receipts and turns them into
module-learning plan candidates with status such as `application_ready`; it does
not claim `eval_absorbed`. Use `--write-plan-receipts` only when the operator
intentionally wants local weak plan receipts to be reviewed by
`module-learning-pipeline-review`.

This is a read-only `local_learning_sedimentation_audit_only` check. It audits the
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
`local_learning_sedimentation_map_only` check. It separates the learning lanes:
finance source/capability sedimentation, local module learning
plan/review/absorption, brain-distillation training material, system
memory/correction/downrank notes, review-panel arbitration, operator runtime
continuity memory, and the language-routing corpus boundary. Use it when the
question is "what kind of learning evidence do we actually have?" A finance
source apply receipt, a system memory note, and accepted brain-distillation
training material are not the same thing as module `eval_absorbed`.

The system-memory sedimentation gate is a read-only
`local_system_memory_sedimentation_gate_only` check. It looks only at local system
memory/correction/downrank evidence and protected repo memory cleanliness. It
may report `system_memory_recall_ready`, but it always keeps
`moduleLearningClaimAllowed=false`; system recall is not module learning, Qwen
weight absorption, or user-visible proof.

The absorption gate is a read-only
`local_module_learning_absorption_gate_only` check. It joins the latest
module-learning review with hardened-eval evidence and blocks promotion of a
learning receipt from `application_ready` to `eval_absorbed` unless each receipt
has per-receipt eval/training evidence, a fresh adjacent application task, and a
keep/downrank/discard decision. A clean global hardened eval is useful evidence,
but by itself it is not per-module absorption proof.

For a judge-style all-lane exam, run:

```bash
node --import tsx scripts/operator/lcx-agent-exam.ts --json
```

This is read-only by default. It combines doctor, training-plan, promotion
audit, module-learning review, thinking-hierarchy integrity, work-status
boundary integrity, memory-sedimentation integrity, automation coordination,
Lark/Feishu boundary, and optional L5 evidence into one table-like verdict. It
does not start training, does not run heavy MLX eval, does not touch provider
config, and does not prove `user-visible-observed` or legacy
`live-visible-fixed`. Use `--live` only when you intentionally want
channel/Lark probe evidence, and still require fresh real Lark inbound plus visible reply before claiming `user-visible-observed`. Use `--l5` for the heavier local
L5 regression battery.

The default system doctor includes doctrine-consistency and head-tail
consistency gates. Doctrine consistency fails when active entrypoints drift back
toward stale stage wording, tiny symptom-patch rules, static brain adapters,
invalid eval commands, upstream package identity, or missing L5 regression skill
wiring. Head-tail consistency fails when macro doctrine/prompt/runbook changes
and micro implementation tails no longer supervise each other. It covers module
learning and broader engineering details: core/external-channel/user-visible
boundary, protected memory, Lark/Feishu visible reply, local automation, memory
sedimentation, finance capability, eval/review output, and fast change-impact
planning.

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
  memory sedimentation, finance capability, or core/external-channel/user-visible
  boundary.
- Durable proof beats chat memory. Prefer tests, smoke/eval output,
  `lcx-system-doctor`, `local-brain-training-plan`, local automation receipts,
  log anchors, and git commits.
- Keep evidence labels strict: local proof is not user-visible proof;
  source storage is not learning; system-level internalization is not Qwen
  weight absorption; `parseRecovered` is not a clean promotion pass.

If only `lcx-local-operator-latest.json` is stale and the goal is to refresh
local recovery evidence without invoking the normal supervisor, use the
explicit observe-only mode:

```bash
LCX_LOCAL_OPERATOR_OBSERVE_ONLY=true \
  /Users/liuchengxu/.openclaw/bin/lcx-local-operator-loop.sh
```

This mode skips cleanup, system-doctor/governance channel owners, daemon
restart, and training restart; it runs only the local training-plan,
mind-model, flow-graph, and context-recovery observations. The receipt remains
`local_observability_only` and is not a release or Lark-visible proof.

If the goal is to refresh the complete local operator receipt while still
forbidding cleanup and training restart, use the explicit guards below. This
runs the current `scripts/operator/*` owners, then a subsequent standalone
doctor can consume the refreshed operator state:

```bash
LCX_LOCAL_OPERATOR_SKIP_CLEANUP=true \
LCX_LOCAL_OPERATOR_SKIP_TRAINING_RESTART=true \
  /Users/liuchengxu/.openclaw/bin/lcx-local-operator-loop.sh
```

The receipt records both guards. They are local observability controls only;
they do not prove external-channel binding, user-visible observation, model
training, or promotion.

## Prior-Work Reuse Gate

Before adding a new local-brain contract, eval, teacher prompt, skill, receipt,
automation, or internalization workflow, check whether a similar mechanism
already exists. Start with targeted search instead of inventing a parallel lane:

```bash
rg -n "<keyword>|<task_family>|<case_id>|<module_id>" \
  scripts/operator test ops/local-brain AGENTS.md README.md docs src extensions
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

For broad external-agent upgrades, run the external agent upgrade radar before
building a new path:

```bash
node --import tsx scripts/operator/lcx-external-agent-upgrade-radar.ts --json
```

The current source families include AutoSkill / Skills-Coach, Agent Lightning,
LongMemEval-V2 / AgentRunbook, MemX-style local-first memory provenance,
LightMem / LycheeMemory, OpenTelemetry GenAI / AgentSight, OWASP Agentic /
SMCP, ClawBench / WildClawBench, Agent S / CLI-Anything, multi-agent
orchestration frameworks such as LangGraph / OpenAI Agents / CrewAI /
Microsoft Agent Framework, and prediction-market research sources such as
Polymarket, PolyClaw, Polybot, Polyseer, PolyBench, and PolySwarm. They must
land in existing owners such as SkillOpt-lite, governance autopilot, problem
radar, context recovery, learning sedimentation, commercial acceptance, flow
graph, finance data gateway, security review, skill-harvester, and
cli-anything-harvester. This is not direct runtime authority: no direct install,
no provider config, no external channel sender, no protected memory mutation, no wallet
connection, no order placement, no copy trading, and no latency arbitrage.
Treat the radar as local-only architecture wiring until a concrete probe,
eval/receipt, live migration, and fresh Lark visible proof all exist.

The radar also tracks six prioritized blacktech mechanisms:

```text
1. SkillOpt v2 lifecycle
2. native-runtime long-task battery
3. unified trajectory schema
4. local-first memory provenance
5. agent trace and side-effect observability
6. secure tool/skill permission layer
```

These mechanisms are owner slots, not granted authority. SkillOpt v2 still
needs targeted eval, regression eval, train-slice, clean promotion, and
user-visible proof before model-weight or channel claims. Runtime batteries are dev
canaries until real Lark proof. Trajectory and trace receipts are local
observability, not a runtime RL server or eBPF/TLS interception. Secure tool
permissioning blocks untrusted tools until allowlist, least privilege,
credential scope, audit log, and uninstall path are proven.
Every mechanism must expose the same automatic workflow contract through
`lcx-external-agent-upgrade-radar`: automatic trigger, owner gate, autopilot
surface, next safe local probe, next automation action, proof chain, and
forbidden authorities. `lcx-governance-autopilot` and context recovery surface
that contract in their compact outputs, and `lcx-problem-cluster-radar` treats
missing contract fields as architecture drift. This is what lets future
operators use the mechanisms automatically instead of relying on chat memory.

Future agents should not wait for the user to remember these names. Natural
language mentions of AutoSkill, Skills-Coach, Agent Lightning,
LongMemEval/AgentRunbook, MemX, memory provenance, LightMem/LycheeMemory,
OpenTelemetry, AgentSight, OWASP Agentic, SMCP, ClawBench/WildClawBench,
Agent S, CLI-Anything,
LangGraph, OpenAI Agents handoffs, CrewAI, Microsoft Agent Framework,
Polymarket, PolyClaw, Polybot, Polyseer, PolyBench, PolySwarm, prediction
markets, CLOB, or orderbooks must autocue `skill-harvester`,
`cli-anything-harvester`, finance data provenance, security review,
SkillOpt-lite, governance autopilot, or the flow graph as appropriate, run the
external upgrade radar, and then follow the named owner.
`lcx-context-recovery-exam` verifies this autocue path;
`lcx-problem-cluster-radar` consumes the external radar so missing candidates,
owner drift, direct runtime authority, missing blacktech autopilot contracts, or
"perfect integration" overclaims become repairable clusters instead of silent
architecture debt.

Prediction-market sources are weak evidence, not trading instructions. A valid
research packet needs market id or URL, one real market metadata packet,
resolution criteria, resolution ambiguity review, close date/timezone, source
timestamp, orderbook/liquidity timestamp, thin-liquidity downrank thresholds,
microstructure warning, slippage/fee assumptions, sample-out validation,
counterevidence, paper-strategy failure log, review-panel status, and
keep/downrank/discard decision. Ambiguous resolution blocks conclusions. Thin
orderbooks are downranked. Strategy work stays paper-only; if fees, slippage,
sample-out proof, or failure logs are missing, the strategy is rejected as
research evidence. It must not connect wallets, place orders, copy trades, route
private keys, size positions, claim forecast authority, or chase latency
arbitrage.

The default operator goal is proactive error discovery and snapshot refresh.
For non-trivial engineering, "continue", system hardening, live migration,
module learning, external project absorption, or memory/update work, start with
the owner/radar/recovery stack before asking the user what to check. Repair the
bounded owner lane when the radar marks it repairable; when a gate blocks repair,
name the owner command and blocker instead of waiting for manual reminders.

Keep the architecture upgrade-ready even when the current local brain is small.
Future models, tools, papers, benchmarks, skills, and desktop/CLI-control
upgrades should enter through `skill-harvester`, source/license/write-scope
review, `lcx-external-agent-upgrade-radar`, existing-owner mapping, eval or
receipt proof, and core/external-channel/user-visible migration gates. Do not install, trust, or serve a
new technology directly because it looks promising; make it a bounded pattern
inside the existing owner stack first.

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
node --import tsx scripts/operator/module-learning-pipeline-plan.ts \
  --target-module options_volatility \
  --source <source-url-or-local-path> \
  --actual-reading-scope "<what was actually read>" \
  --existing-artifact scripts/operator/local-brain-distill-eval.ts \
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

When `writeReceipt=true`, the tool writes a local receipt under:

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
provider config, or protected-memory mutation. Treat that review as local
status evidence only; it is not user-visible proof and it does not mean Qwen
weights absorbed the lesson unless eval or training evidence is present.

The default system doctor runs the same review in no-write mode:

```bash
node --import tsx scripts/operator/lcx-system-doctor.ts --json
node --import tsx scripts/operator/lcx-module-learning-absorption-gate.ts --json
```

Weak module-learning receipts appear in the `module-learning-pipeline-review`
check. Ordinary in-progress statuses do not fail the doctor, but boundary
violations do.

The absorption gate should report `hold_at_application_ready` while same-day
receipts are still weak. That is expected and prevents `core-ready` learning
evidence from being overstated as model-weight absorption.

When clean hardened eval evidence exists and the operator intentionally wants to
close the same-day module-learning lane, the absorption gate can write local
evidence and superseding `eval_absorbed` plan receipts:

```bash
node --import tsx scripts/operator/lcx-module-learning-absorption-gate.ts \
  --write-absorbed-plan-receipts --json
node --import tsx scripts/operator/module-learning-pipeline-review.ts --json
node --import tsx scripts/operator/lcx-module-learning-absorption-gate.ts --json
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

For the automation lane that should leave a daily local receipt, run:

```bash
node --import tsx scripts/operator/module-learning-pipeline-review.ts --json
```

Use `--no-write` for a dry run. The script writes only
`~/.openclaw/workspace/memory/module-learning-pipeline-reviews/<YYYY-MM-DD>.json`
by default; it must not be used as user-visible proof or model-weight absorption proof
by itself. Use `--workspace PATH` only for isolated tests or an explicit
alternate local workspace.

The training coordinator also includes the same no-write review in its JSON:

```bash
node --import tsx scripts/operator/local-brain-training-plan.ts --json
```

Module-learning plan/review receipts are also Qwen training material now. The
dataset builder reads `memory/module-learning-pipeline-plan-receipts` and
`memory/module-learning-pipeline-reviews` into source kinds
`module_learning_plan_receipt` and `module_learning_review_receipt`; the bounded
train-slice repeats them with the other high-signal non-review receipts. This
only teaches the local brain the internalization contract and module-specific
rules. It does not make `application_ready` receipts become `eval_absorbed`;
the absorption gate above still owns that claim.

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
/Users/liuchengxu/.codex/skills/lcx-module-learning-absorption-operator/SKILL.md
/Users/liuchengxu/.codex/skills/lcx-commercial-answer-pipeline-operator/SKILL.md
/Users/liuchengxu/.codex/skills/lcx-promotion-and-adapter-truth-operator/SKILL.md
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
- `agent-runtime-drift-auditor`: compare repo, live sidecar, daemon/runtime, and receipts for drift.
- `lcx-qwen-training-operator`: check Qwen 24-hour training/eval/backoff/restart supervision without creating overlap.
- `lcx-workflow-waterflow-auditor`: check god-view workflow closure, waterflow routing, head-tail consistency, and memory sedimentation gaps.
- `lcx-module-learning-absorption-operator`: check online/source learning and module absorption without confusing stored-only, application-ready, and eval-absorbed states.
- `lcx-commercial-answer-pipeline-operator`: check commercial answer adoption, short Lark intent expansion, bounded model/Qwen review, visible reply cleanliness, failed-reason output, and whether backend/runtime proof terms were translated before reaching Lark users.
- `lcx-promotion-and-adapter-truth-operator`: check latest-passing vs latest-promoted, parseRecovered promotion blocks, active guard mismatch, and blocked challenger capability.
- `l5-regression-batterer`: L5 baseline pressure tests with realistic Chinese finance/control-room prompts.
- `l4-regression-batterer`: legacy compatibility alias only; prefer the L5 skill in new work.
- `skill-harvester`: evaluate and isolate new external or local skills before letting them affect the agent.
- `cli-anything-harvester`: evaluate CLI-Anything, CLI-Hub, GUI/local software CLI wrappers, and safe agent-native software-control plans before any wrapper is trusted.

The skills are operator guidance, not durable market memory. Do not copy their text into protected repo memory.
Runtime-visible LCX skills must also be present in the OpenClaw managed skill
snapshot under `/Users/liuchengxu/.openclaw/skills/`. It is acceptable for that
managed path to symlink back to the canonical Codex skill folder under
`/Users/liuchengxu/.codex/skills/`, but `lcx-context-recovery-exam` must prove
the local runtime can see and autocue the skill before claiming the agent will
use it without reminders.
The local reply path also has deterministic skill preflight for common LCX
operator asks. Natural-language requests about Qwen training, whole-system
waterflow, agent brain learning, Lark user-visible proof, runtime drift, finance
learning, CLI-Anything, and skill harvesting should be cued to one installed
skill before the model answers. Explicit `/skill ...` commands still win.

SkillOpt-lite extends that preflight with eval-derived SOP skills under
`/Users/liuchengxu/.openclaw/workspace/memory/skillopt-lite/`. It can be used in
three separate ways, and these boundaries must stay separate:

- immediate preflight: load the matched `best_skill.md` as context before answer
  planning; this is usable by the next agent immediately, but is not model
  weight absorption.
- runtime self-use hook: the external-channel/local reply runner calls
  `src/auto-reply/reply/skillopt-autocue.ts` from
  `src/auto-reply/reply/get-reply-run.ts`, so accepted SkillOpt SOP files in the
  shared workspace can guide the same answer path that Lark uses after bounded
  source sync/promotion. Do not add a second live-only skill format.
- governance coverage: `lcx-mind-model` and `lcx-flow-graph` must keep the
  SkillOpt runtime hook visible as a supervised waterflow, not only as a helper
  script. Context recovery and governance autopilot should therefore preserve
  both the immediate preflight boundary and the stronger proof chain.
- SkillOpt family: failed, parse-error, and parseRecovered eval cases may grow
  narrow skills such as finance data provenance, local-memory conflict,
  sentiment/vendor source gates, module-learning absorption, and Lark
  external-channel boundary checks.
- proof chain: a candidate skill only becomes a learned runtime capability after
  targeted eval, regression eval, train-slice/training evidence, clean hardened
  adapter promotion truth, and then the Lark external-channel binding owner
  plus fresh inbound/outbound Lark evidence proves `user-visible-observed`.

Fast inspection:

```bash
node --import tsx scripts/operator/lcx-skillopt-lite.ts --phase candidate-edit --no-write --json
node --import tsx scripts/operator/lcx-skillopt-lite.ts --phase candidate-edit --no-write --json --task "NVDA 还能不能拿，要不要买一点？"
```

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
- `live-sidecar-sync-doctor`: linked-worktree and external-sidecar drift checks with bounded sync planning.
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
node --import tsx scripts/operator/minimax-brain-training-guard.ts \
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
window idle. The guard also keeps a short evolution window after each round so
owner checks, monotonic ledger, module-learning review, promotion truth, and
external-channel binding readiness can settle before the next heavy round
starts.

```bash
node --import tsx scripts/operator/minimax-brain-training-guard.ts \
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
  --evolution-cooldown-minutes 10 \
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
node --import tsx scripts/operator/minimax-quota-brain-saturator.ts --write
```

This writes brain distillation review artifacts only. It must not write language corpus, external channel sender config, provider config, protected repo memory, or finance doctrine.

## Dataset And Smoke

Rebuild and check the local brain dataset:

```bash
node --import tsx scripts/operator/local-brain-distill-dataset.ts --json
node --import tsx scripts/operator/local-brain-distill-smoke.ts --json
```

Expected boundary:

```text
local_auxiliary_thought_flow_only
```

Expected `notTouched` includes:

```text
external_channel_sender
provider_config
protected_repo_memory
formal_lark_routing_corpus
finance_doctrine
```

## Hardened Eval

Run hardened eval against the latest selected adapter:

```bash
node --import tsx scripts/operator/local-brain-distill-eval.ts \
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
node --import tsx scripts/operator/local-brain-promotion-audit.ts --json
```

Expected boundary:

```text
local_brain_promotion_audit_only
```

Treat `promotionDecision=safe` as dev promotion-audit evidence only. It does not
promote an adapter by itself and it is not user-visible proof.

### Capability Hierarchy Gate

Local-brain evals must preserve a simple-to-complex hierarchy. A complex case may
declare prerequisite cases, and `local-brain-distill-eval.ts` auto-includes them
when a complex `--case-id` is selected. This prevents a false state where the
brain passes a hard scenario but fails the simple Lark-style ask.

Example:

```bash
node --import tsx scripts/operator/local-brain-distill-eval.ts \
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
node --import tsx scripts/operator/local-brain-distill-eval.ts \
  --contract-only \
  --summary-only \
  --json
```

`200/200 promotionReady=true` under `--contract-only` means the dev routing and
output contract closed for those cases. It is not `user-visible-observed` proof
and not model-weight absorption proof.

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
node --import tsx scripts/operator/minimax-brain-training-guard.ts \
  --resolve-current-adapter \
  --bootstrap-if-missing \
  --model Qwen/Qwen3-0.6B \
  --log /Users/liuchengxu/.openclaw/workspace/logs/minimax-brain-training-guard-medium.jsonl
```

## Status Interpretation

Use these words precisely:

- `core-ready`: local scripts, dataset, smoke, eval, and receipts pass.
- `training-active`: guard or teacher/eval process is currently running.
- `promotion-ready`: hardened eval passed and the adapter is selected by latest-passing.
- `external-channel-bound`: the Lark channel sidecar has been synced to the
  verified dev snapshot and restarted/probed.
- `user-visible-observed`: only after external-channel binding plus a fresh real Lark inbound plus visible reply.

Do not call local training or synthetic replay `user-visible-observed`; a channel
probe is transport evidence only. Old `live-visible-fixed` wording is a legacy
compatibility label for the same boundary, not a shortcut around the fresh
real Lark inbound plus visible reply proof.

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
