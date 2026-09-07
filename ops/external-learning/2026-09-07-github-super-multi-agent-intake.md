# GitHub Super Multi-Agent Pattern Intake

**Intake ID:** `github_super_multi_agent_intake_20260907`
**Date:** 2026-09-07
**Status:** first native protocol slice integrated; framework vendoring rejected

## Decision

LCX will absorb reusable execution contracts, not whole external runtimes.
The existing TypeScript `LogicalAgentPool` remains the only local orchestration
owner. The first slice adds:

- append-only run events with one run id and sequence;
- plan-fingerprinted checkpoints after completed tasks;
- fail-closed resume that reuses only a verified completed prefix;
- explicit dependency-backed handoff and ownership transfer receipts;
- input/output guardrails inside the shared model-pool boundary;
- existing bounded DAG fan-out/fan-in and one shared model slot.

No provider configuration, API key, training job, protected-memory writer,
external sender, trading action, or second state root was added. The code is a
native LCX implementation of the selected contracts; it is not copied source
from these repositories and does not add a framework dependency.

## Official sources reviewed

The pages below were read on 2026-09-07. URLs and licenses are recorded as
research evidence; future reuse must refresh the source revision and license.

| Source                                                                                                                                                           | Reusable contract                                                                                         | License / reuse boundary                                                   | LCX decision                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [LangGraph](https://github.com/langchain-ai/langgraph) and [persistence docs](https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/persistence.mdx)  | durable execution, thread-scoped checkpoints, resume, long-term stores, human interruption                | repository code MIT                                                        | Reimplement checkpoint, fingerprint, and resume semantics in the existing pool; do not add LangGraph runtime or a second store authority |
| [Microsoft Agent Framework workflow samples](https://github.com/microsoft/agent-framework/tree/main/python/samples/03-workflows)                                 | sequential/parallel workflow, step checkpointing, cancellation, sub-workflow, HITL resume, fan-out/fan-in | repository code follows its repository license; no code copied             | Map to the existing DAG scheduler, bounded concurrency, checkpoint store, and explicit handoff contract                                  |
| [OpenHands architecture](https://github.com/OpenHands/OpenHands)                                                                                                 | event stream as state backbone, action/observation loop, runtime/session separation                       | core repository MIT; `enterprise/` is a separate source-available boundary | Adopt typed local run events only; exclude enterprise code and do not create a second event/state runtime                                |
| [OpenAI Agents Python](https://github.com/openai/openai-agents-python) and [handoffs](https://github.com/openai/openai-agents-python/blob/main/docs/handoffs.md) | agents-as-tools/handoffs, guardrails, sessions, tracing, explicit ownership transfer                      | MIT                                                                        | Add dependency-backed handoff receipts and input/output guardrails; preserve LCX capability restrictions                                 |
| [Microsoft AutoGen](https://github.com/microsoft/autogen)                                                                                                        | layered message-passing and event-driven concepts                                                         | code MIT; docs have separate terms                                         | Do not adopt as a new base: the official README marks AutoGen maintenance mode and points to Microsoft Agent Framework as successor      |

## Pattern-to-owner map

| External pattern                  | LCX owner                               | Current proof                                                                                                        |
| --------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| event stream / trace              | `src/agents/logical-agent-pool.ts`      | `LogicalAgentRunEvent`, run id, monotonic sequence, event sink, immutable returned event list                        |
| durable step checkpoint           | injected `LogicalAgentCheckpointStore`  | `lcx_logical_agent_checkpoint_v1`, completed task index, result index, plan fingerprint                              |
| resumable workflow                | `runLogicalAgentPlan`                   | explicit `runId` + `resume`; rejects schema, run, fingerprint, task, agent, and dependency mismatch                  |
| manager / handoff                 | existing DAG plus `LogicalAgentHandoff` | handoff target must depend on source; context is dependency results; ownership transfer is receipt-only              |
| parallel fan-out / fan-in         | existing `LogicalAgentPool`             | dependency scheduler and bounded `maxConcurrency`; shared model invocation remains serialized                        |
| guardrails                        | `LogicalAgentPool` capability boundary  | input/output guardrails run inside task timeout; declared side effects still undergo immutable capability validation |
| human/external authority boundary | LCX governance and delivery owners      | no provider, external channel, protected memory, training, or trading authority is granted by this slice             |

## Acceptance gates for future expansion

This first slice is local core evidence, not model-learning, promotion,
deployment, external binding, or user-visible proof. A future framework or
adapter may advance only when it supplies:

1. exact source URL, revision, license, and read scope;
2. a mapping to an existing LCX owner and canonical ontology vocabulary;
3. deterministic replay and focused tests for timeout, duplicate work,
   permission escape, checkpoint mismatch, and recovery;
4. no new state root or hidden authority;
5. an explicit keep/downrank/discard decision after an adjacent real workflow;
6. separate evidence for runtime, model quality, promotion, external binding,
   and user-visible observation.

The canonical file-backed checkpoint adapter is now implemented at
`src/agents/logical-agent-pool-checkpoint-store.ts`. It uses the existing
`resolveStateDir()` owner, writes atomically below
`agents/logical-agent-checkpoints/`, hashes run ids into path components, and
has a restart-style test that loads the prefix through a fresh store instance.
It still requires a real local-model execution receipt before any claim about
model quality or finance-agent capability is made.
