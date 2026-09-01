# LCX Engine boundary

The repository is an LCX product built on a replaceable OpenClaw host. The
engine boundary prevents the product layer from becoming another fork-specific
runner and gives future hosts one contract to implement.

## Ownership

| Layer                     | Owner          | Responsibility                                                                                |
| ------------------------- | -------------- | --------------------------------------------------------------------------------------------- |
| LCX Engine                | LCX            | deterministic preflight, domain routing, evidence and answer contracts, governance boundaries |
| OpenClaw host adapter     | adapter        | session, tools, model invocation, streaming, retries, and process lifecycle                   |
| Message adapter           | channel owner  | inbound/outbound transport only; no answer authority                                          |
| External Agent candidates | candidate lane | shadow comparison and evidence collection; no runtime authority                               |

`src/engine/lcx-engine.ts` is the control-plane entry point. Its service
registry exposes the existing finance orchestration, answer grounding, evidence
projection, and Skill preflight modules without moving their native ownership.
`runLcxEngine` creates a bounded receipt and delegates execution to a host.

## Current host

`src/engine/openclaw-host.ts` wraps both existing execution paths as
`openclaw.embedded` and `openclaw.cli`. Current behavior remains compatible:
general requests do not receive extra engine instructions; finance requests
receive deterministic preflight context in the host system prompt.

The reply runner emits a separate `engine` event containing the bounded receipt
after a host completes. It contains contract, host, route, risk, timing, and
boundary metadata only; it is not a delivery, learning, or fresh-data proof.

The receipt records planning and host completion only. It does not prove model
learning, fresh market data, external delivery, or that a user saw the answer.

## Latest OpenClaw migration

OpenClaw v2026.8.1 is a staging host candidate. Its AgentHarness/plugin seam is
the next adapter target. The migration sequence is:

1. keep `src/engine` as the LCX authority;
2. implement one v2026.8.1 harness adapter behind the same host contract;
3. shadow the current embedded host on bounded local contracts;
4. promote only after source, build, repeated behavior, rollback, and forbidden
   side-effect checks pass;
5. upgrade the resident Node/runtime and restart the external channel only as a
   separately authorized operation.

`src/engine/openclaw-harness.ts` now provides the LCX-side structural bridge for
that seam. It uses the explicit-only harness id `lcx-engine`, forwards the
`LcxEngineHostContext` to the host, and falls back to the built-in OpenClaw
runtime unless the runtime is explicitly selected. It is intentionally not a
direct `AgentHarness` SDK implementation: v2026.8.1 owns the full
`AgentHarnessAttemptParams` type, so a version-specific plugin still has to
translate that type and register it through OpenClaw's plugin API.

No external channel, provider, training process, or LaunchAgent is changed by
the engine layer.
