---
summary: "CLI reference for `lcx devices` (device pairing + token rotation/revocation)"
read_when:
  - You are approving device pairing requests
  - You need to rotate or revoke device tokens
title: "devices"
---

# `lcx devices`

Manage device pairing requests and device-scoped tokens.

## Commands

### `lcx devices list`

List pending pairing requests and paired devices.

```
lcx devices list
lcx devices list --json
```

### `lcx devices remove <deviceId>`

Remove one paired device entry.

```
lcx devices remove <deviceId>
lcx devices remove <deviceId> --json
```

### `lcx devices clear --yes [--pending]`

Clear paired devices in bulk.

```
lcx devices clear --yes
lcx devices clear --yes --pending
lcx devices clear --yes --pending --json
```

### `lcx devices approve [requestId] [--latest]`

Approve a pending device pairing request. If `requestId` is omitted, LCX Agent
automatically approves the most recent pending request.

```
lcx devices approve
lcx devices approve <requestId>
lcx devices approve --latest
```

### `lcx devices reject <requestId>`

Reject a pending device pairing request.

```
lcx devices reject <requestId>
```

### `lcx devices rotate --device <id> --role <role> [--scope <scope...>]`

Rotate a device token for a specific role (optionally updating scopes).

```
lcx devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `lcx devices revoke --device <id> --role <role>`

Revoke a device token for a specific role.

```
lcx devices revoke --device <deviceId> --role node
```

## Common options

- `--url <url>`: Gateway WebSocket URL (defaults to `gateway.remote.url` when configured).
- `--token <token>`: Gateway token (if required).
- `--password <password>`: Gateway password (password auth).
- `--timeout <ms>`: RPC timeout.
- `--json`: JSON output (recommended for scripting).

Note: when you set `--url`, the CLI does not fall back to config or environment credentials.
Pass `--token` or `--password` explicitly. Missing explicit credentials is an error.

## Notes

- Token rotation returns a new token (sensitive). Treat it like a secret.
- These commands require `operator.pairing` (or `operator.admin`) scope.
- `devices clear` is intentionally gated by `--yes`.
- If pairing scope is unavailable on local loopback (and no explicit `--url` is passed), list/approve can use a local pairing fallback.
