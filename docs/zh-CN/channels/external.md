---
summary: "通过 JSON Webhook 和 HTTP 端点连接任意外部软件"
read_when:
  - 你想把自定义应用、工作流或服务接入 OpenClaw
  - 你需要与厂商无关的入站和出站消息契约
title: 外部消息通道
---

# 外部消息通道

外部消息通道是一个与厂商无关的适配器，面向能够发送和接收 HTTP 请求的
软件。它在入站 Webhook 接收 JSON 消息，经 OpenClaw 正常路由和回复管道处理，
再把回复以 JSON `POST` 请求发送到配置的端点。

它不要求特定聊天厂商、SDK、账号体系或网络拓扑。Webhook 的提供方和出站
请求的接收方由你的外部软件负责。

## 配置

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

除非外围网络已经提供等价认证，否则不要关闭入站或出站认证。私信默认是
允许列表；当 `groupPolicy` 为 `allowlist` 时，群组和频道消息必须配置明确的
群组条目。

多个独立集成可以配置在 `channels.external.accounts` 下；需要多个端点时，
配合 `defaultAccount` 和按账号绑定使用。

## 入站请求

向 `webhookPath` 发送带有 `Content-Type: application/json` 的 HTTP `POST`。
启用令牌认证时，将令牌放在配置的请求头中（默认是
`Authorization: Bearer <token>`）。

```json
{
  "version": 1,
  "messageId": "source-message-123",
  "text": "总结最新的研究包。",
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

同时支持常见的扁平字段别名 `senderId`、`conversationId` 或 `chatId`，
`message` 或 `content`，以及数字 Unix 时间戳。请求成功返回 `202 Accepted`，
响应体为 `{ "ok": true, "messageId": "..." }`。

## 出站请求

回复会以 HTTP `POST` 发送到 `outboundUrl`：

```json
{
  "version": 1,
  "type": "message",
  "channel": "external",
  "accountId": "default",
  "messageId": "reply-123",
  "target": "conversation-42",
  "text": "这是请求的摘要。",
  "replyToId": "source-message-123",
  "threadId": "thread-7",
  "timestamp": "2026-09-01T08:00:02.000Z"
}
```

请求头 `Idempotency-Key` 等于 `messageId`。媒体回复会增加 `mediaUrls` 数组。
适配器使用共享 SSRF 防护和请求超时机制；端点返回错误时不会自动重试。

## 本地验证

```bash
pnpm exec vitest run extensions/external/src/accounts.test.ts \
  extensions/external/src/monitor.test.ts \
  extensions/external/src/protocol.test.ts \
  extensions/external/src/security.test.ts \
  extensions/external/src/send.test.ts
```

这些测试只使用本地 fixture 和注入请求，不会发送真实消息，也不会修改外部账号。

运行状态边界如下：

- `core-ready`：本地实现和测试通过；
- `external-channel-bound`：明确配置的运行时已连接且通道探测通过；
- `user-visible-observed`：真实外部软件发来入站消息，并独立观察到预期出站回复。

本地测试不会自行把状态升级到最后一级。
