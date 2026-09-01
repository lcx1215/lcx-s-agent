---
summary: "Connect any software to OpenClaw through a JSON webhook and HTTP endpoint"
read_when:
  - You want to connect a custom app, workflow, or service to OpenClaw
  - You need a vendor-neutral inbound and outbound message contract
title: "External Message Channel"
---

# External Message Channel

The External Message Channel is a vendor-neutral adapter for software that can
send and receive HTTP requests. It accepts JSON messages on an inbound webhook,
runs them through the normal OpenClaw route and reply pipeline, and sends
replies as JSON `POST` requests to the configured endpoint.

It does not require a specific chat vendor, SDK, account system, or network
topology. Your application remains responsible for exposing the webhook and
receiving the outbound request.

## Configuration

```json5
{
  channels: {
    external: {
      enabled: true,
      webhookPath: "/external/messages",
      inboundAuth: "token",
      inboundToken: "${EXTERNAL_INBOUND_TOKEN}",
      outboundUrl: "https://your-service.example/openclaw/messages",
      outboundAuth: "bearer",
      outboundToken: "${EXTERNAL_OUTBOUND_TOKEN}",
      dmPolicy: "allowlist",
      allowFrom: ["operator-1"],
      groupPolicy: "allowlist",
      groups: {
        "support-room": { requireMention: true, allowFrom: ["operator-1"] },
      },
    },
  },
}
```

Use `inboundAuth: "none"` or `outboundAuth: "none"` only when the surrounding
network already provides equivalent authentication. Direct messages default to
an allowlist; group and channel messages require an explicit group entry when
`groupPolicy` is `allowlist`.

Multiple independent integrations can be configured under
`channels.external.accounts`. Use `defaultAccount` and account-scoped channel
bindings when more than one endpoint is needed.

## Inbound request

Send an HTTP `POST` with `Content-Type: application/json` to the configured
`webhookPath`. With token authentication, send the token in the configured
header (the default is `Authorization: Bearer <token>`).

```json
{
  "version": 1,
  "messageId": "source-message-123",
  "text": "Summarize the latest research packet.",
  "sender": { "id": "operator-1", "name": "Operator" },
  "conversation": {
    "id": "conversation-42",
    "type": "direct",
    "label": "Operator"
  },
  "timestamp": "2026-09-01T08:00:00.000Z",
  "replyToId": "source-message-122",
  "threadId": "thread-7",
  "metadata": { "source": "your-app" }
}
```

The adapter also accepts the common flat aliases `senderId`, `conversationId`
or `chatId`, `message` or `content`, and numeric Unix timestamps. A successful
request receives `202 Accepted` with `{ "ok": true, "messageId": "..." }`.

## Outbound request

Replies are sent as an HTTP `POST` to `outboundUrl`:

```json
{
  "version": 1,
  "type": "message",
  "channel": "external",
  "accountId": "default",
  "messageId": "reply-123",
  "target": "conversation-42",
  "text": "Here is the requested summary.",
  "replyToId": "source-message-123",
  "threadId": "thread-7",
  "timestamp": "2026-09-01T08:00:02.000Z"
}
```

The `Idempotency-Key` header equals `messageId`. Media replies add a
`mediaUrls` array. The adapter uses the shared SSRF guard, request timeout, and
one-shot delivery semantics; it does not retry an endpoint that returned an
error.

## Verify locally

```bash
pnpm exec vitest run extensions/external/src/accounts.test.ts \
  extensions/external/src/monitor.test.ts \
  extensions/external/src/protocol.test.ts \
  extensions/external/src/security.test.ts \
  extensions/external/src/send.test.ts
```

These tests use local fixtures and injected requests. They do not send a real
message or modify an external account.

The operational status boundary is:

- `core-ready`: local implementation and tests pass;
- `external-channel-bound`: an explicitly configured runtime is connected and
  its channel probe passes;
- `user-visible-observed`: a real external application sends an inbound
  message and the expected outbound reply is independently observed.

Local tests never upgrade themselves to the last state.
