import { describe, expect, it } from "vitest";
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
