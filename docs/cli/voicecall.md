---
summary: "CLI reference for `lcx voicecall` (voice-call plugin command surface)"
read_when:
  - You use the voice-call plugin and want the CLI entry points
  - You want quick examples for `voicecall call|continue|status|tail|expose`
title: "voicecall"
---

# `lcx voicecall`

`voicecall` is a plugin-provided command. It only appears if the voice-call plugin is installed and enabled.

Primary doc:

- Voice-call plugin: [Voice Call](/plugins/voice-call)

## Common commands

```bash
lcx voicecall status --call-id <id>
lcx voicecall call --to "+15555550123" --message "Hello" --mode notify
lcx voicecall continue --call-id <id> --message "Any questions?"
lcx voicecall end --call-id <id>
```

## Exposing webhooks (Tailscale)

```bash
lcx voicecall expose --mode serve
lcx voicecall expose --mode funnel
lcx voicecall expose --mode off
```

Security note: only expose the webhook endpoint to networks you trust. Prefer Tailscale Serve over Funnel when possible.
