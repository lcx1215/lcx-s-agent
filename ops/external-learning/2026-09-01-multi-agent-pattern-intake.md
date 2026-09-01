# Multi-agent Pattern Intake

**Intake ID:** `multi_agent_pattern_intake_20260901`
**Date:** 2026-09-01
**Status:** architecture pattern intake only; no runtime adoption

## Scope and boundary

This record captures reusable orchestration patterns from official OpenAI and
Anthropic sources and maps them into LCX's one canonical ontology. It is not a
provider preference, runtime authority grant, model-learning claim, training
instruction, external-channel change, or production architecture decision.

The implementation owner is
`scripts/operator/lcx-multi-agent-pattern-shadow.ts`. It runs deterministic
replay before live: it runs deterministic replay first, then an explicitly
supplied isolated JSON executor in a separate live phase. It has no external side effect: it does not call Lark, change provider configuration, start
training, write protected memory, or execute trades.

## Official sources and reading scope

| Source                                                                                                                           | Version / commit evidence                                                         | License / scope                                                                                                                                                 | What was read                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [OpenAI Agents Python](https://github.com/openai/openai-agents-python)                                                           | Release `v0.22.0`, observed commit `4df9ecf` on 2026-09-01                        | `MIT` (`LICENSE`)                                                                                                                                               | Repository overview, release metadata, and agent-pattern material                             |
| [OpenAI Agents handoffs](https://github.com/openai/openai-agents-python/blob/main/examples/agent_patterns/README.md)             | `main` page; release context above                                                | `MIT` via the parent repository                                                                                                                                 | Manager/supervisor and handoff examples; ownership and context transfer semantics             |
| [OpenAI Codex multi-agent spec](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs) | `main` page; exact commit was not pinned because the direct remote read timed out | `Apache-2.0` (`LICENSE`)                                                                                                                                        | Task spawning, child lifecycle and bounded orchestration concepts                             |
| [Anthropic Claude Agent SDK Python](https://github.com/anthropics/claude-agent-sdk-python)                                       | Release `v0.2.149`, observed commit `9597fc9` on 2026-09-01                       | `MIT` (`LICENSE`)                                                                                                                                               | SDK overview, agent execution boundary, and tool/result handling                              |
| [Anthropic research-agent demo](https://github.com/anthropics/claude-agent-sdk-demos/tree/main/research-agent)                   | `main` page; exact commit was not pinned because the direct remote read timed out | No repository-level `LICENSE` was observed at the fetched path; verify before reuse                                                                             | Parallel research roles, synthesis, and evidence aggregation                                  |
| [Anthropic managed agents](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/managed-agents-multiagent.md) | `main` page; exact commit was not pinned because the direct remote read timed out | No top-level `LICENSE` was observed; repository README says licenses vary, with many Apache 2.0 and some source-available skills; verify this path before reuse | Coordinator, per-thread context, shared workspace, persistent thread and ownership boundaries |

The source version fields above are evidence of what was inspected, not a
claim that the current pages will remain unchanged. Before any future source
reuse, refresh the source, license, commit/release, and actual reading scope.

## Pattern cards

### Manager

- **Shape:** one coordinator calls specialist roles as bounded tools, in a
  deterministic sequence, then keeps final answer ownership.
- **LCX mapping:** `orchestrationPattern=manager`,
  `delegationMode=manager_as_tool`, `ownershipMode=root_final_owner`.
- **Good fit:** dependent gates where later work needs the output of an earlier
  risk or evidence check; a single terminal decision is important.
- **Failure modes:** serial latency, coordinator overreach, repeated context
  transfer, and a root that silently treats an unverified child result as fact.
- **Permission boundary:** children receive only the declared tool allowlist;
  the manager owns aggregation but gains no external sender, provider,
  protected-memory, training, or trading authority.
- **Cost/latency:** usually more child calls and a longer critical path; exact
  cost is unknown unless the executor returns usage.

### Handoff

- **Shape:** a router transfers the complete task context to one specialist;
  that specialist owns the terminal answer.
- **LCX mapping:** `orchestrationPattern=handoff`,
  `delegationMode=handoff`, `ownershipMode=specialist_final_owner`.
- **Good fit:** a clearly identified domain owner can carry the whole contract
  without a supervisor synthesizing competing outputs.
- **Failure modes:** context loss, premature routing, specialist authority
  leakage, and ambiguous final ownership after interruption.
- **Permission boundary:** handoff transfers context, not authority. The
  specialist remains inside the same allowlist and must leave a final-owner and
  recovery receipt.
- **Cost/latency:** commonly fewer calls and a short path, but one specialist
  failure can block the whole result; missing usage remains `unknown`.

### Parallel Worker

- **Shape:** a root fans out independent workers, then joins their reports and
  owns the final answer.
- **LCX mapping:** `orchestrationPattern=parallel_worker`,
  `delegationMode=parallel_fanout`, `ownershipMode=root_final_owner`.
- **Good fit:** independent evidence or challenge tasks with disjoint write
  sets and a bounded join contract.
- **Failure modes:** duplicated work, race conditions, inconsistent evidence,
  join-order bias, and hard-to-recover partial completion.
- **Permission boundary:** workers use disjoint workspaces and the exact same
  declared allowlist; parallelism never authorizes Lark, provider config,
  protected memory, training, or trade execution.
- **Cost/latency:** wall-clock can approach the slowest worker, while total
  usage and duplicate-artifact risk can increase.

## Neutral crosswalk

| Neutral LCX concept | OpenAI pattern reading                      | Anthropic pattern reading                        | LCX canonical value      |
| ------------------- | ------------------------------------------- | ------------------------------------------------ | ------------------------ |
| Topology            | manager / handoff / parallel delegation     | coordinator / managed thread / parallel research | `orchestrationPattern`   |
| Role                | agent, specialist, evaluator                | coordinator, researcher, synthesizer             | `agentRole`              |
| Delegation          | tool call, handoff, fan-out                 | child thread, managed agent                      | `delegationMode`         |
| Execution           | queued, running, completed, failed          | thread lifecycle and interruption                | `executionState`         |
| Message             | child result, report, final answer          | thread result, evidence, synthesis               | `communicationKind`      |
| Context             | inherited, transferred, summarized          | per-thread context with shared task scope        | `contextScope`           |
| Workspace           | isolated task/worktree or shared resource   | shared container/filesystem with scoped threads  | `workspaceScope`         |
| Final ownership     | root aggregation or specialist handoff      | coordinator synthesis or specialist result       | `ownershipMode`          |
| Proof               | trace, tool attribution, permission, replay | result/event/thread evidence                     | `orchestrationProofKind` |
| Recovery            | retry/resume/restart state                  | persistent thread or interrupted run             | `interruptionRecovery`   |

These are neutral workflow terms. Provider names, model names, credentials,
and transport details remain opaque runtime metadata and must not become
ontology canonical values.

## Shadow comparison contract

The same case, answer contract, timeout, tool allowlist, model selection, and
workspace isolation are used for all patterns:

```text
case: single_stock_loss_recovery_risk_triage_v1
ask:  我NVDA亏20%，该割肉还是补仓？
baseline failure: safe_but_empty_thesis_list
```

Replay injects the safe-but-empty candidate, direct trade language, blocked
permission attempt, timeout, and interruption fixtures. Live runs are opt-in,
five normal repetitions per pattern, with one separate recovery probe only
when the executor declares that capability. The comparison records quality,
the eight-item evidence denominator, wall-clock and critical-path latency,
exact/estimated/missing usage, duplicate task/artifact counts, blocked versus
escaped permission violations, lost work, and duplicate final output.
Each run receipt carries the stable experiment idempotency key plus a distinct
final-output delivery key, so an explicit retry cannot deliver the same final
answer twice.

The CLI keeps the default replay and live experiment IDs separate, so a blocked
live probe cannot overwrite the latest replay summary. An executor response with
an unknown canonical enum is retained only as `unknown` capability evidence; it
cannot be counted as a verified event, permission, or side-effect receipt.

The eight evidence items are: position weight, cost basis, investment thesis,
holding period, risk budget/max drawdown, leverage/options exposure, fresh
source/timestamp, and invalidation condition. Explicitly naming a missing item
counts as coverage; guessing does not.

The wide-trial gate is deliberately weak: quality at least 3/5, median
evidence coverage at least 75%, zero escaped permission violations, no direct
trade advice or external side effect, and replay recovery passing. A pass only
permits another shadow round. It never promotes a runtime topology.

## Evolution rule

The new vocabulary, task family, workflow nodes, and filters are additive to
`lcx_ontology_v1`. The canonical source remains
`src/shared/lcx-ontology.ts`; no entity type, relation contract, or state chain
was changed. A future rename, removal, relation/state change, classification
change, or canonical-source move must create a versioned migration manifest
before implementation. There is one registry and one shadow owner; there is
no second ontology or second runtime state root.
