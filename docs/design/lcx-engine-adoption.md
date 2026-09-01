# LCX Engine adoption decision

Snapshot: 2026-09-01. This document records the current local decision; it is
not a live deployment receipt.

## Decision

Keep LCX Engine as the product authority and treat OpenClaw as a replaceable
execution host. The current host remains the fork's embedded/CLI runtime. The
latest upstream OpenClaw is an isolated host candidate, not a second product
brain and not a reason to overwrite the current runtime.

The supported direction is:

`LCX Engine -> host adapter -> OpenClaw execution -> existing channel adapter`

Domain capabilities, evidence boundaries, Skill preflight, and answer
governance belong to LCX Engine. Session lifecycle, model invocation, tools,
streaming, and retries belong to the selected host adapter. Channel transport
does not become answer authority.

## Current evidence

- npm `latest` for `openclaw` is `2026.8.1`; the current beta tag is
  `2026.9.1-beta.1`. See the [npm package metadata](https://www.npmjs.com/package/openclaw).
- The official [v2026.8.1 release notes](https://docs.openclaw.ai/releases/2026.8.1)
  describe OpenClaw 2.0, including breaking OpenProse and OpenAI route
  migrations and upcoming plugin SDK migration gates.
- The official [Node requirement](https://docs.openclaw.ai/install/node) is
  Node 22.22.3+, 24.15+, or 25.9+. The resident LaunchAgent is still on Node
  22.14.0 and the live runtime reports `2026.3.3`, so a direct latest-version
  replacement is not currently a safe operation.
- `src/engine/openclaw-harness.ts` maps the latest AgentHarness shape only at a
  structural boundary. It is explicit-only and is not registered against the
  old fork SDK.

## Promotion gates

An upstream host can be promoted only after all of these are independently
proven:

1. exact source, revision, license, dependency, and build evidence;
2. version-specific AgentHarness adapter compilation and no-channel smoke;
3. repeated comparison against the current host for general, finance, queue,
   fallback, streaming, and failure behavior;
4. no forbidden provider, credential, LaunchAgent, channel, or training side
   effects during the comparison;
5. a supported resident Node/runtime and a reversible cutover plan;
6. fresh external-channel and user-visible proof after any authorized restart.

Until then, the right action is **keep/adapt/shadow**, not install-overwrite.

For a local structural check, run:

`pnpm lcx:engine:status`

That command is read-only and does not inspect or change provider, LaunchAgent,
training, or external-channel state.
