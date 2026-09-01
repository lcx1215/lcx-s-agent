# LCX Engine beta adapter

This package connects the LCX Engine control plane to OpenClaw
`2026.9.1-beta.1`.

It owns deterministic request preflight: route classification, risk tier,
required capabilities, and evidence boundaries. OpenClaw remains the
replaceable execution host. The adapter does not invoke a model, send a
channel message, start training, or produce a model-learning receipt.

The runtime entrypoint is `index.js`; `index.ts` is the source-development
entrypoint. The adapter is installed as a version-pinned local plugin and
requires OpenClaw's `before_prompt_build` conversation-hook permission.

The official beta Feishu plugin is a separate host/channel package. Its
presence does not mean the channel is configured or that a user-visible
inbound/outbound proof exists.
