import { describe, expect, it } from "vitest";
import {
  isExternalInboundMessageAllowed,
  isExternalWebhookAuthorized,
  safeEqualToken,
} from "./security.js";
import type { ExternalInboundMessage, ResolvedExternalAccount } from "./types.js";

const account: ResolvedExternalAccount = {
  accountId: "default",
  enabled: true,
  webhookPath: "/external/messages",
  inboundAuth: "token",
  inboundToken: "secret-token",
  inboundTokenHeader: "authorization",
  outboundUrl: "https://example.test/messages",
  outboundAuth: "bearer",
  outboundToken: "outbound-token",
  outboundTokenHeader: "x-external-channel-token",
  timeoutMs: 10_000,
  textChunkLimit: 4_000,
  dmPolicy: "allowlist",
  allowFrom: ["user-1"],
  groupPolicy: "allowlist",
  groupAllowFrom: [],
  groups: { "conversation-1": { allowFrom: ["user-1"] } },
  configured: true,
};

function message(overrides: Partial<ExternalInboundMessage> = {}): ExternalInboundMessage {
  return {
    messageId: "message-1",
    text: "hello",
    senderId: "user-1",
    conversationId: "conversation-1",
    chatType: "direct",
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe("external channel security", () => {
  it("compares tokens without accepting empty values", () => {
    expect(safeEqualToken("Bearer secret-token", "secret-token")).toBe(true);
    expect(safeEqualToken("", "")).toBe(false);
    expect(safeEqualToken("wrong", "secret-token")).toBe(false);
  });

  it("authorizes the configured inbound header", () => {
    const req = { headers: { authorization: "Bearer secret-token" } } as never;
    expect(isExternalWebhookAuthorized(req, account)).toBe(true);
    const denied = { headers: { authorization: "wrong" } } as never;
    expect(isExternalWebhookAuthorized(denied, account)).toBe(false);
  });

  it("enforces direct and group policies", () => {
    expect(isExternalInboundMessageAllowed(account, message())).toBe(true);
    expect(isExternalInboundMessageAllowed(account, message({ senderId: "unknown-user" }))).toBe(
      false,
    );
    expect(isExternalInboundMessageAllowed(account, message({ chatType: "group" }))).toBe(true);
    expect(
      isExternalInboundMessageAllowed(
        account,
        message({ chatType: "group", senderId: "unknown-user" }),
      ),
    ).toBe(false);
    expect(
      isExternalInboundMessageAllowed(
        account,
        message({ chatType: "group", conversationId: "unknown-conversation" }),
      ),
    ).toBe(false);
  });
});
