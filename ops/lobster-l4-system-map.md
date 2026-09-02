# Lobster L4 System Map

This file is the shortest useful map of the current Lobster system in the canonical repository.
It exists to reduce future maintenance cost, stop duplicate seams from growing, and
make it obvious where new work belongs.

## 1. Product Shape

Lobster is a low-frequency research operating system.

Mainline:

- one main control room
- internal specialist orchestration
- summary first
- branch detail only when needed

Not mainline:

- autonomous trading
- execution approval theater
- HFT
- free-form memory sprawl

## 2. Active Runtime Layers

### Layer A: Entry Surfaces

These are where real operator input enters:

- `extensions/external/src/*`
  - vendor-neutral JSON webhook ingress and HTTP JSON delivery
- `src/commands/channels/status.ts`
  - operator-facing channel/runtime status
- `src/auto-reply/reply/agent-runner.ts`
  - runtime reply execution seam

### Layer B: Shared Brain / Prompting Layer

These decide how the system thinks before it acts:

- `src/agents/system-prompt.ts`
- `src/agents/openclaw-tools.ts`
- `src/agents/pi-tools.host-edit.ts`
- `src/agents/pi-embedded-helpers/*`

Responsibilities:

- doctrine
- memory recall order
- study / math / quant default recall
- operator-facing bounded write rules

### Layer C: Specialist Hook Families

These materialize structured artifacts.

#### Learning / Correction

- `src/hooks/bundled/learning-review/*`
- `src/hooks/bundled/learning-review-weekly/*`
- `src/hooks/bundled/learning-review-bootstrap/*`
- `src/hooks/bundled/correction-loop/*`
- `src/hooks/bundled/knowledge-validation-weekly/*`
- `src/hooks/bundled/memory-hygiene-weekly/*`

#### Frontier / Method

- `src/hooks/bundled/frontier-research/*`
- `src/hooks/bundled/frontier-research-weekly/*`
- `src/hooks/bundled/frontier-research-bootstrap/*`

#### Fundamental Artifact Chain

- `src/hooks/bundled/fundamental-intake/*`
- `src/hooks/bundled/fundamental-manifest-bridge/*`
- `src/hooks/bundled/fundamental-snapshot-bridge/*`
- `src/hooks/bundled/fundamental-snapshot/*`
- `src/hooks/bundled/fundamental-scoring-gate/*`
- `src/hooks/bundled/fundamental-risk-handoff/*`
- `src/hooks/bundled/fundamental-review-queue/*`
- `src/hooks/bundled/fundamental-review-brief/*`
- `src/hooks/bundled/fundamental-review-plan/*`
- `src/hooks/bundled/fundamental-review-workbench/*`
- `src/hooks/bundled/fundamental-target-packets/*`
- `src/hooks/bundled/fundamental-target-workfiles/*`
- `src/hooks/bundled/fundamental-target-deliverables/*`
- `src/hooks/bundled/fundamental-dossier-drafts/*`
- `src/hooks/bundled/fundamental-target-reports/*`
- `src/hooks/bundled/fundamental-review-memo/*`
- `src/hooks/bundled/fundamental-collection-follow-up-tracker/*`

#### Operating / Control

- `src/hooks/bundled/operating-loop/*`
- `src/hooks/bundled/operating-daily-workface/*`
- `src/hooks/bundled/operating-weekly-review/*`

### Layer D: Guardrail / Integrity Layer

These are the places that should keep the system clean and repairable:

- `src/hooks/bundled/fundamental-artifact-errors.ts`
- `src/infra/operational-anomalies.ts`
- External channel monitor / protocol / security / delivery surfaces under
  `extensions/external/src/*`

## 3. External Message Channel Contract

The channel transport contract lives in:

- `extensions/external/src/protocol.ts`
- `extensions/external/src/monitor.ts`
- `extensions/external/src/send.ts`

The adapter supports:

- direct, group, and channel conversations
- JSON webhook inbound messages with token or network-boundary authentication
- JSON HTTP outbound replies with idempotency, reply, thread, and media fields
- normal OpenClaw routing and reply dispatch through the shared agent runtime

Rule:

- the external adapter transports messages; the shared agent runtime owns intent
  routing and specialist selection
- keep the wire contract vendor-neutral and explicit
- do not let a connector become a second brain or a second source of truth

## 4. What Counts As The L4 Brain In The Local System

The local system brain is not one file or repository. It is the combination of:

- `src/agents/system-prompt.ts`
- durable learning hooks
- weekly aggregation hooks
- operating-loop overlays
- surface routing contracts

This means:

- do not bolt “brain behavior” into random extension files
- prefer changing prompt/memory/hook contracts before inventing another side path

## 5. Current Maintenance Rules

- Prefer extending an existing family over adding a new bundle.
- Prefer one upstream artifact contract over multiple downstream reinterpretations.
- Prefer bounded control-room routing over adding specialist command sprawl.
- Prefer active-system cleanup over historical install-script cleanup.
- If a file is only historical scaffolding, do not treat it as an active runtime source of truth.

## 6. Current L4-to-L5 Blockers

These are the real blockers, not vague ambition:

- active state surfaces must stay single-source and non-contradictory
- learning outputs must become durable and callable, not just archived
- specialist chains must remain ordered and non-overlapping
- the External Message Channel must stay human-readable and route into the same brain
- anomaly / artifact-error surfaces must keep failure explicit

## 7. Rule For Future Contributors

Before adding any new hook, surface, or artifact:

1. identify which existing family owns the seam
2. prove why extending that family is insufficient
3. show how the new piece avoids duplicate state, duplicate routing, and duplicate memory

If you cannot do that, the default answer should be:

- extend an existing seam
- or do not add it yet
