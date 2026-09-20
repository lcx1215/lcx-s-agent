---
summary: "CLI reference for `lcx qr` (generate a pairing QR code + setup code)"
read_when:
  - You want to pair the LCX Agent client with a gateway quickly
  - You need setup-code output for remote/manual sharing
title: "qr"
---

# `lcx qr`

Generate a pairing QR code and setup code from your current Gateway configuration.

## Usage

```bash
lcx qr
lcx qr --setup-code-only
lcx qr --json
lcx qr --remote
lcx qr --url wss://gateway.example/ws --token '<token>'
```

## Options

- `--remote`: use `gateway.remote.url` plus remote token/password from config
- `--url <url>`: override gateway URL used in payload
- `--public-url <url>`: override public URL used in payload
- `--token <token>`: override gateway token for payload
- `--password <password>`: override gateway password for payload
- `--setup-code-only`: print only setup code
- `--no-ascii`: skip ASCII QR rendering
- `--json`: emit JSON (`setupCode`, `gatewayUrl`, `auth`, `urlSource`)

## Notes

- `--token` and `--password` are mutually exclusive.
- With `--remote`, if effectively active remote credentials are configured as SecretRefs and you do not pass `--token` or `--password`, the command resolves them from the active gateway snapshot. If gateway is unavailable, the command fails fast.
- Without `--remote`, local `gateway.auth.password` SecretRefs are resolved when password auth can win (explicit `gateway.auth.mode="password"` or inferred password mode with no winning token from auth/env), and no CLI auth override is passed.
- Gateway version skew note: this command path requires a gateway that supports `secrets.resolve`; older gateways return an unknown-method error.
- After scanning, approve device pairing with:
  - `lcx devices list`
  - `lcx devices approve <requestId>`
