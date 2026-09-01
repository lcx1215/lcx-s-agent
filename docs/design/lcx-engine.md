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

The active local gateway is a separate, version-pinned OpenClaw beta host:
`2026.9.1-beta.1`. Its LCX integration lives in
`extensions/lcx-engine/index.ts` and uses the same LCX planner as the in-repo
host wrappers. This keeps the product authority in `src/engine` while allowing
the gateway implementation to change independently.

The reply runner emits a separate `engine` event containing the bounded receipt
after a host completes. It contains contract, host, route, risk, timing, and
boundary metadata only; it is not a delivery, learning, or fresh-data proof.

The receipt records planning and host completion only. It does not prove model
learning, fresh market data, external delivery, or that a user saw the answer.

## OpenClaw beta integration

OpenClaw `2026.9.1-beta.1` is the active local host after an isolated,
no-channel smoke and a reversible LaunchAgent cutover. The integration shape is:

1. keep `src/engine` as the LCX authority;
2. run the deterministic planner in the beta `before_prompt_build` hook;
3. let OpenClaw beta own session, model, tool, streaming, and retry execution;
4. keep external-channel binding and user-visible proof as separate gates;
5. retain the former fork and its rollback backup until behavioral comparison
   and channel proof are complete.

`src/engine/openclaw-harness.ts` remains the LCX-side structural bridge for the
AgentHarness seam. The beta exposes `AgentHarnessV2`, but the current adapter is
intentionally hook-only: it does not register a second executor until the full
version-specific attempt contract and comparison evidence justify that change.

The official beta Feishu plugin is loaded but currently reports
`configured: false` and `running: false`. Therefore this runtime cutover is
not a claim that Lark is bound or that a user has seen a beta response. The
exact install, migration, health, and rollback evidence is kept in the local
beta intake receipt rather than in this architecture document.

The engine layer itself does not change provider configuration, authentication,
training, or channel delivery. The separately authorized local beta cutover
changed only the gateway LaunchAgent and host selection; its external-channel
and user-visible states remain independently audited.
