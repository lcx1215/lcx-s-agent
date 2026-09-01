# LCX Engine adoption decision

Snapshot: 2026-09-01. This document records the current local decision; it is
not a live deployment receipt.

## Decision

Keep LCX Engine as the product authority and treat OpenClaw as a replaceable
execution host. The active local execution host is now the exact beta
`2026.9.1-beta.1`, selected through a version-pinned LCX adapter. The former
fork remains a rollback/lineage artifact; it is not a second product brain or
an active result authority.

The supported direction is:

`LCX Engine -> beta host adapter -> OpenClaw beta -> channel adapter`

Domain capabilities, evidence boundaries, Skill preflight, and answer
governance belong to LCX Engine. Session lifecycle, model invocation, tools,
streaming, and retries belong to the selected host adapter. Channel transport
does not become answer authority.

The current adapter is deliberately a control-plane `before_prompt_build` hook.
It does not register a second executor, claim an `AgentHarnessV2` promotion, or
turn a host result into model-weight learning proof.

## Current evidence

- npm `latest` for `openclaw` is `2026.8.1`; the exact beta selected for the
  local runtime is `2026.9.1-beta.1`. See the [npm package metadata](https://www.npmjs.com/package/openclaw)
  and the versioned intake receipt.
- The official [v2026.8.1 release notes](https://docs.openclaw.ai/releases/2026.8.1)
  describe OpenClaw 2.0, including breaking OpenProse and OpenAI route
  migrations and upcoming plugin SDK migration gates.
- The official [Node requirement](https://docs.openclaw.ai/install/node) is
  Node 22.22.3+, 24.15+, or 25.9+. The active LaunchAgent now uses supported
  Node 24.18.0 and the beta entrypoint; its local gateway and health endpoints
  are healthy after the cutover.
- The official beta Feishu and Moonshot provider packages load through the beta
  host. Feishu is currently `enabled` but `configured: false`, so no external
  channel is being claimed as bound or user-visible.
- The old custom Feishu extension is not silently mixed into the beta: its
  legacy SDK import is incompatible with the beta package layout. Porting it is
  a separate adapter task; the official beta package is the active Feishu
  implementation.
- `src/engine/openclaw-harness.ts` maps the latest AgentHarness shape only at a
  structural boundary. It is explicit-only and is not registered against the
  beta runtime because the current product boundary only needs the supported
  hook adapter.

## Promotion and proof gates

The local host cutover is complete. Product/channel promotion still requires
independent proof of:

1. exact source, revision, license, dependency, and build evidence;
2. version-specific AgentHarness adapter compilation and no-channel smoke;
3. repeated comparison against the current host for general, finance, queue,
   fallback, streaming, and failure behavior;
4. no forbidden provider, credential, LaunchAgent, channel, or training side
   effects during the comparison;
5. a supported resident Node/runtime and a reversible cutover plan;
6. fresh external-channel and user-visible proof after any authorized restart.

Items 1, 2, and 5 are satisfied for the beta host; item 3 is not a full
behavioral equivalence claim, and item 6 is intentionally still open because
Feishu is not configured. The old fork is retained as the rollback point.

For a local structural check, run:

`pnpm lcx:engine:status`

That command is read-only and does not inspect or change provider, LaunchAgent,
training, or external-channel state.
