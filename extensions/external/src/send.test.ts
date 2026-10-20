import { describe, expect, it } from "vitest";
import { externalChannelPlugin } from "./channel.js";
import { normalizeExternalTarget } from "./protocol.js";
import { buildExternalOutboundRequest } from "./send.js";
import type { ResolvedExternalAccount } from "./types.js";

const account: ResolvedExternalAccount = {
  accountId: "default",
  enabled: true,
  webhookPath: "/external/messages",
  inboundAuth: "none",
  inboundToken: "",
  inboundTokenHeader: "authorization",
  outboundUrl: "https://receiver.example/messages",
  outboundAuth: "header",
  outboundToken: "outbound-token",
  outboundTokenHeader: "x-api-key",
  timeoutMs: 5_000,
  textChunkLimit: 4_000,
  dmPolicy: "allowlist",
  allowFrom: [],
  groupPolicy: "allowlist",
  groupAllowFrom: [],
  groups: {},
  configured: true,
};

describe("external outbound protocol", () => {
  it("builds an authenticated idempotent JSON request", async () => {
    const request = buildExternalOutboundRequest({
      account,
      target: "conversation-1",
      text: "hello",
      mediaUrls: ["https://cdn.example/file.png"],
      replyToId: "message-0",
      threadId: 42,
      messageId: "message-1",
      timestamp: "2026-09-01T00:00:00.000Z",
    });

    expect(request.url).toBe(account.outboundUrl);
    expect(request.messageId).toBe("message-1");
    expect(new Headers(request.init.headers).get("content-type")).toBe("application/json");
    expect(new Headers(request.init.headers).get("idempotency-key")).toBe("message-1");
    expect(new Headers(request.init.headers).get("x-api-key")).toBe("outbound-token");
    expect(JSON.parse(String(request.init.body))).toEqual({
      version: 1,
      type: "message",
      channel: "external",
      accountId: "default",
      messageId: "message-1",
      target: "conversation-1",
      text: "hello",
      mediaUrls: ["https://cdn.example/file.png"],
      replyToId: "message-0",
      threadId: "42",
      timestamp: "2026-09-01T00:00:00.000Z",
    });
  });

  it("sends raw conversation IDs for routing targets without changing message identity", () => {
    for (const prefix of ["group", "room", "channel", "dm", "user", "direct", "conversation"]) {
      const request = buildExternalOutboundRequest({
        account,
        target: normalizeExternalTarget(`external:${prefix}:conversation-1`)!,
        text: "hello",
        messageId: "stable-id",
      });
      expect(JSON.parse(String(request.init.body)).target).toBe("conversation-1");
      expect(new Headers(request.init.headers).get("idempotency-key")).toBe("stable-id");
    }
    // Actual messaging resolution may run repeatedly before the final outbound resolver.
    for (const [input, expected] of [
      ["external:group:dm:123", "dm:123"],
      ["direct:group:123", "group:123"],
    ] as const) {
      const normalize = externalChannelPlugin.messaging!.normalizeTarget!;
      const routed = normalize(normalize(input)!);
      expect(routed).toBe(input);
      const resolved = externalChannelPlugin.outbound!.resolveTarget!({
        cfg: {},
        to: routed,
        mode: "explicit",
      });
      if (!resolved.ok) throw new Error("fixture target resolution failed");
      const request = buildExternalOutboundRequest({ account, target: resolved.to, text: "hello" });
      expect(JSON.parse(String(request.init.body)).target).toBe(expected);
    }
    // The inbound-reply path already has a raw ID, including any reserved-looking prefix.
    const raw = normalizeExternalTarget("external:group:dm:123")!;
    expect(
      JSON.parse(
        String(buildExternalOutboundRequest({ account, target: raw, text: "hello" }).init.body),
      ).target,
    ).toBe("dm:123");
    expect(
      JSON.parse(
        String(
          buildExternalOutboundRequest({ account, target: "group:123", text: "hello" }).init.body,
        ),
      ).target,
    ).toBe("group:123");
    expect(() => buildExternalOutboundRequest({ account, target: " ", text: "hello" })).toThrow(
      "external target is required",
    );
  });

  it("does not require an auth header for an explicit no-auth endpoint", () => {
    const request = buildExternalOutboundRequest({
      account: { ...account, outboundAuth: "none", outboundToken: "" },
      target: "conversation-1",
      text: "hello",
      messageId: "message-1",
    });
    expect(new Headers(request.init.headers).get("authorization")).toBeNull();
    expect(new Headers(request.init.headers).get("x-api-key")).toBeNull();
  });
});
