# LCX Agent System Architecture Map

This document is an orientation map, not a second ontology, workflow owner,
dashboard, or readiness gate. The canonical owners listed below remain the
source of truth for their own contracts and receipts.

## One-line model

```text
owner intent
  -> canonical semantics
  -> TypeScript control and routing
  -> bounded workflow waterflow
  -> domain capabilities and tools
  -> evidence, review, and safe answer
  -> delivery adapter
  -> user-visible observation
```

Learning, optional models, and local automation are supporting loops around
this line. They may improve or observe a stage; they must not silently become a
new semantic registry, workflow authority, provider authority, protected-memory
writer, or delivery authority.

## The six architectural planes

| Plane                   | Responsibility                                                                                  | Canonical owner or surface                                                                                                                                                                       | Must not become                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Semantics               | Entity, relation, module, workflow, evidence, learning, delivery, and boundary vocabulary       | `src/shared/lcx-ontology.ts`; audit `scripts/operator/lcx-ontology.ts`                                                                                                                           | A second registry or ad-hoc cross-layer vocabulary                                                    |
| Control                 | Intent classification, routing, orchestration, safety gates, recovery, and visible-flow control | TypeScript under `src/agents/`, `src/auto-reply/`, and the named operator entrypoints                                                                                                            | A model-specific workflow or a Python workflow authority                                              |
| Waterflow               | Start/end nodes, required modules, filters, receipts, and bounded feedback edges                | `scripts/operator/lcx-flow-graph.ts`                                                                                                                                                             | A loose list of features or an unguarded feedback loop                                                |
| Capability              | Finance research, data gateway, modules, source registry, tools, and reviewable domain work     | Existing capability owners under `src/agents/` and their operator/test surfaces                                                                                                                  | A direct trading executor, unsourced current-data answer, or unreviewed claim                         |
| Evidence and governance | Projection, receipts, audits, recovery, impact planning, and problem routing                    | `scripts/operator/lcx-mind-model.ts`, `lcx-head-tail-consistency.ts`, `lcx-problem-cluster-radar.ts`, `lcx-context-recovery-exam.ts`, `lcx-universe-index.ts`, and `lcx-governance-autopilot.ts` | A second truth owner, a completion slogan, or a promotion shortcut                                    |
| Delivery                | Connect a proven answer path to an external communication adapter and collect visible proof     | `scripts/operator/lcx-external-channel-binding.ts`, `lcx-external-channel-status.ts`, and adapter code                                                                                           | A second brain, provider authority, or `user-visible-observed` without real inbound/outbound evidence |

The six planes are architectural responsibilities, not maturity levels. “High,
middle, and low” quality or model labels belong inside a capability or an
evaluation case; they do not create new planes, registries, or runtimes.

## Existing architecture stack: reconcile, do not duplicate

The repository already contains several named architectures. They are
different views of the same system, not competing top-level systems:

| Existing architecture or view                       | Canonical owner                                                                                                                                                                           | What it answers                                                                                              | Correct place in the stack                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **LCX Agent Mind Model / god-view**                 | `scripts/operator/lcx-mind-model.ts`                                                                                                                                                      | Are the major lanes visible and closed across rule, workflow, proof, and boundary?                           | Read-only architecture supervision; it observes owners and never executes their work.           |
| **Global Evidence Projection**                      | `src/shared/global-evidence-projection.ts`, `src/shared/global-evidence-projection-source.ts`, and `src/shared/global-evidence-projection-read.ts`                                        | Can different automation and adapter consumers read one neutral, bounded view of already-owned evidence?     | Read-only projection and reader contract; owner receipts remain authoritative.                  |
| **Canonical Ontology**                              | `src/shared/lcx-ontology.ts` and `scripts/operator/lcx-ontology.ts`                                                                                                                       | What do entities, relations, modules, workflows, states, evidence, and boundaries mean?                      | The single semantic registry; it is not a workflow or dashboard.                                |
| **LCX Agent Flow Graph / waterflow**                | `scripts/operator/lcx-flow-graph.ts`                                                                                                                                                      | Does each task family pass through the right nodes, modules, filters, receipts, and bounded feedback?        | Workflow topology and wrong-flow exam; it is not a second runtime.                              |
| **Head--Tail Consistency**                          | `scripts/operator/lcx-head-tail-consistency.ts`                                                                                                                                           | Does macro doctrine still supervise the micro prompts, taxonomy, tools, evals, and receipts?                 | Cross-layer contract check; it proves linkage, not capability quality.                          |
| **Macro--micro unified capability**                 | `src/agents/finance-brain-orchestration.ts`, `scripts/operator/local-brain-taxonomy.ts`, `scripts/operator/local-brain-contracts.ts`, finance framework tools, and module-learning owners | Can a broad objective become a bounded, reusable domain capability without losing evidence and risk gates?   | Capability decomposition inside the Capability plane; it is not another architecture plane.     |
| **Learning sedimentation / internalization**        | `scripts/operator/module-learning-pipeline-plan.ts`, `module-learning-pipeline-review.ts`, and the `lcx-learning-sedimentation-*` owners                                                  | Did a source become an applied and reviewed capability, rather than merely a stored artifact?                | A bounded learning loop around capabilities; it does not redefine runtime truth.                |
| **Continuity, inventory, and governance autopilot** | `lcx-context-recovery-exam.ts`, `lcx-universe-index.ts`, `lcx-problem-cluster-radar.ts`, and `lcx-governance-autopilot.ts`                                                                | Can a new window recover current state, route a problem to its owner, and refresh one compact evidence view? | Operational supervision and recovery; inventory and radar are not deletion or repair authority. |
| **Core / host / delivery boundary**                 | Current LCX control and answer path plus `lcx-external-channel-binding.ts` and `lcx-external-channel-status.ts`                                                                           | Which part is product/control authority, which part is an execution host, and which part is transport?       | Boundary and delivery plane; a host or channel is never a second LCX brain.                     |
| **Optional model and logical-agent implementation** | Qwen/MiniMax/adapters and the bounded logical-agent pool                                                                                                                                  | Can an implementation candidate execute, be evaluated, and possibly be promoted?                             | A subordinate implementation loop; it cannot redefine semantics, governance, or delivery proof. |

### Macro--micro unified capability rule

“Macro” and “micro” are two zoom levels over one governed path, not two
systems and not two separate memories:

```text
product objective and doctrine
  -> ontology entity / relation / module / workflow vocabulary
  -> task family and flow-graph scenario
  -> domain capability, module contract, and required tools
  -> concrete source, data field, task case, and evidence gate
  -> tool/eval execution and receipt
  -> review decision and reusable capability or explicit failure
  -> safe answer and delivery proof
```

At the macro level, the system decides the objective, architecture plane,
task family, safety boundary, and proof standard. At the micro level, it
selects only the relevant module ids, source fields, tool calls, eval cases,
receipts, and keep/downrank/discard decision. The macro contract must constrain
the micro execution; the micro receipt must feed back into the macro view. A
large module taxonomy, a long prompt, or a successful single case is not by
itself unified capability.

The practical reuse rule is:

```text
new semantic meaning       -> extend the ontology in place
new supervision view       -> extend mind model/projection, no second dashboard
new workflow family        -> extend the flow graph and its owner proof
new domain capability      -> extend the module/finance framework contract
new learned rule           -> use source -> retrieval -> apply -> eval -> review
new delivery path          -> use binding/status and fresh visible evidence
new model or agent pool    -> remain an optional observed implementation
```

This is the architecture-level answer to “high, middle, and low”: quality
levels may be measured inside a capability, case, or receipt, but they do not
become additional global layers. Future work should map a proposed object to
one row above, then **reuse, merge, or extend** that owner's surface before
creating a new name or directory.

## Governance head vocabulary

The following terms are compact supervision anchors. They make the architecture
legible to the owner checks without expanding the root contract into a second
runbook:

- **Context-Limited Continuity Doctrine** — start from fixed evidence, and
  reject recovery when the operator latest state must be fresh condition is not
  met.
- **Governance Stack Autopilot** — keep one visible high-level automation and
  do not start overlapping training.
- **LCX Agent Universe Index Doctrine** — inventory is a map, not deletion
  authority; its boundary is `local_universe_index_only`.
- **World-Class Agent Architecture Doctrine** — require operator-grade
  engineering quality, measured capability and operational cleanliness, and
  no fake user-visible-observed claim.
- The model lane is an **optional observed implementation**, not the substrate
  of the mind model and not a new brain. The governance radar is similarly
  local_problem_cluster_radar_only; its boundary includes no external-channel
  sender authority.
- Visible replies contain no internal labels. Speculative market claims need
  source evidence or an explicit unverified flag. `user-visible-observed proof`
  is a separate delivery gate from `core-verified`.
- `finance_learning_memory` is the learned rules and retrieval/apply substrate;
  storage alone is not absorption.
- **TS Main Control / Python Engine** — TypeScript owns workflow control;
  Python remains behind the named engine boundary and
  `lcx-ts-python-boundary`.

The **LCX Agent Flow Graph** is the waterflow owner for wrong-flow detection;
its merge contract includes `same_philosophy_merge_required`. The finance data
gateway exposes `finance_data_gateway_snapshot` as evidence, not as a source of
unverified current numbers. The **LCX Agent Universe Index Doctrine** remains
inventory-only and is not deletion authority.

These anchors are not extra authorities. They are the head vocabulary that
must remain connected to the workflow, proof, and boundary surfaces below.

## Cloud and repository boundary

The migration model is one LCX Agent core on a supported-region control
machine:

```text
local LCX core -> cloud-runtime-ready -> external-channel-bound -> user-visible-observed
```

The deployment keeps one canonical Git repository and one canonical repo/state
authority. It is not a second live system and not a second runtime truth
source. External, WeChat, and SMS are communication adapters on top of the same
answer path; they do not become the brain or the control plane.

The **Local system/factory rule** is one core, one repository, and one state authority. **Feature branches belong to GitHub/GitLab collaboration** for review and release; they do not create another local runtime. **System-wide live fadeout truth belongs** to the neutral external-channel status and binding owners, with legacy live terms retained only as compatibility evidence.

```text
one LCX Agent core | supported-region control machine | canonical repo | one canonical state root | not a second live system | not a second runtime truth source | External, WeChat, SMS | System-wide live fadeout truth belongs
```

## What surrounds the planes

### Optional implementation loop

Qwen, MiniMax teacher work, adapters, and the bounded logical-agent pool are
implementation evidence. Their path is:

```text
candidate implementation
  -> bounded execution/eval
  -> promotion decision
  -> selected clean adapter (if proven)
  -> ordinary control path
```

This loop is subordinate to the control plane. It cannot redefine ontology,
skip workflow filters, claim learning from stored text, bind a delivery adapter,
or modify provider/protected-memory authority by naming a model or passing one
local check.

### Learning and memory loop

```text
source
  -> reading/retrieval
  -> capability application
  -> eval absorption
  -> review
  -> keep/downrank/discard
  -> durable memory or module claim
```

`stored_only` is not learned capability. Model-weight absorption, system-memory
recall, and user-visible success are independent claims with independent proof.

### Local governance loop

```text
observe current state
  -> route to the existing owner
  -> make one bounded change
  -> run the owner proof
  -> refresh the recovery/evidence surface
```

The universe index inventories and assigns component coverage; the problem
radar groups; the mind model checks architecture closure; the flow graph checks
waterflow; the change-impact plan assigns a master lane. None of these is
deletion, training, promotion, or external-delivery authority.

### Total component governance contract

`lcx-universe-index` is the single inventory owner for scale. Its governance
coverage contract is `lcx_component_governance_v1` and applies to every
repository-tracked-and-visible path, not only to the files changed in the
current diff. This is the union of `git ls-files` and the visible filesystem
walk, so tracked-but-ignored files cannot escape governance.
Each component record carries:

```text
inventoryOwner -> routeOwner -> category -> proofSurface -> boundary -> disposition
```

The coverage owner also verifies that every non-null `routeOwner` resolves to
an existing canonical owner surface; a label without a real route is not
accepted as governance.

`governed_source` means the component has a route to an existing engineering,
architecture, test, or delivery owner. `inventory_only` means it remains fully
visible and counted but is a historical, temporary, binary, or other artifact
that cannot silently become source/runtime authority. `review_required` means
the path has no explicit rule and makes the coverage check fail. Workspace
state, logs, memory, tmp, and live-sidecar files remain separately counted as
inventory areas under the same Universe Index boundary; they are not omitted
just because they are not repository source.

This gives the system a scale invariant:

```text
component count may grow from 1,000 to 10,000
governed count must grow with it
review_required count must remain 0
unknown components must block completion
```

The contract is intentionally path/category based rather than a manually
maintained list of every file. Adding a file under an owned surface inherits
the route and proof; adding a new surface requires an explicit governance rule
and focused regression. This is how total coverage scales without creating a
second registry or requiring a new architecture name for every component.

## Head-to-tail contract for every important lane

An architectural lane is not complete because a file or feature exists. It
must have all four surfaces:

1. **Head rule** — the stable product/doctrine boundary.
2. **Workflow entrypoint** — the executable owner that routes or checks it.
3. **Proof surface** — a test, receipt, eval, or audit owned by that lane.
4. **Boundary flag** — an explicit statement of what the lane cannot prove or
   mutate.

The relevant proof is the owner command, not this map. Use the smallest route
that answers the question:

```text
semantic question       -> lcx-ontology
wrong-flow question     -> lcx-flow-graph
architecture closure    -> lcx-mind-model + lcx-head-tail-consistency
changed-file ownership  -> lcx-change-impact-plan
compressed recovery     -> lcx-context-recovery-exam
full inventory          -> lcx-universe-index
visible delivery        -> lcx-external-channel-binding/status
training or promotion   -> local-brain-training-plan and its owners
```

## Current convergence order

Work from large to small and stop at the first unclosed interface:

1. Establish one physical checkout, one active writer, and one selected
   integration surface.
2. Keep the semantic registry and major planes stable; do not add another
   top-level dimension to represent ambition or model quality.
3. Make each plane's head, workflow, proof, and boundary agree.
4. Close one broken handoff in the core control/waterflow path.
5. Only then repair capability-specific failures.
6. Treat training, adapter promotion, module absorption, and external delivery
   as later gates, not as the starting point for architecture cleanup.

## Read-only architecture checkpoint

Run the following owner checks after a meaningful architecture change:

```bash
node --import tsx scripts/operator/lcx-problem-cluster-radar.ts --json
node --import tsx scripts/operator/lcx-mind-model.ts --json
node --import tsx scripts/operator/lcx-flow-graph.ts --json
node --import tsx scripts/operator/lcx-head-tail-consistency.ts --json
node --import tsx scripts/operator/lcx-ontology.ts --json
node --import tsx scripts/operator/lcx-ts-python-boundary.ts --json
node --import tsx scripts/operator/lcx-change-impact-plan.ts --json
```

These commands are local audits. They do not prove training absorption,
promotion, external-channel binding, or `user-visible-observed`.
