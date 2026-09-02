# External Message Channel Acceptance Runbook

This runbook covers the vendor-neutral message adapter in
`extensions/external`. It is an operator guide, not proof that a person saw a
reply.

## Contract

- Inbound: `POST /external/webhook` with a JSON message envelope.
- Outbound: HTTP `POST` to the configured `outbound.url` with the same stable
  envelope shape and an `Idempotency-Key` header.
- Authentication: inbound `Authorization: Bearer ...` by default; outbound
  authentication is optional and can use a configured header.
- Direct and group messages are controlled by `dmPolicy` / `groupPolicy` and
  their allowlists.
- The adapter accepts JSON only and applies request-size, timeout, and SSRF
  guards.

## Local verification

Run the focused contract tests from the repository root:

```bash
pnpm exec vitest run \
  extensions/external/src/accounts.test.ts \
  extensions/external/src/monitor.test.ts \
  extensions/external/src/protocol.test.ts \
  extensions/external/src/security.test.ts \
  extensions/external/src/send.test.ts
```

Also run `git diff --check` and the repository's supported type/lint checks
for touched files.

## Binding a real software endpoint

Before binding any real endpoint, record the exact URL, account id, auth
source, allowlists, timeout, and rollback path in an operator-owned deployment
configuration. This repository change does not write accounts, OS services,
provider credentials, or external systems.

After an explicitly authorized deployment:

1. verify the process health endpoint and route registration;
2. send one controlled inbound JSON message from the target software;
3. verify the outbound HTTP request at that software;
4. correlate `messageId`, `replyToId`, and `Idempotency-Key` in logs;
5. record failures separately from local test results.

`core-verified` and `external-channel-bound` do not imply
`user-visible-observed`; the last state requires independent observation at the
target software.
