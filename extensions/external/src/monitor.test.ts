import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createExternalWebhookRequestHandler,
  resolveExternalCommandAuthorization,
} from "./monitor.js";
import type { ExternalWebhookTarget } from "./monitor.js";
import type { ResolvedExternalAccount } from "./types.js";

const account: ResolvedExternalAccount = {
  accountId: "default",
  enabled: true,
  webhookPath: "/external/messages",
  inboundAuth: "token",
  inboundToken: "inbound-token",
  inboundTokenHeader: "authorization",
  outboundUrl: "https://receiver.example/messages",
  outboundAuth: "none",
  outboundToken: "",
  outboundTokenHeader: "x-external-channel-token",
  timeoutMs: 10_000,
  textChunkLimit: 4_000,
  dmPolicy: "allowlist",
  allowFrom: ["user-1"],
  groupPolicy: "allowlist",
  groupAllowFrom: [],
  groups: {},
  configured: true,
};

function target(): ExternalWebhookTarget {
  return {
    account,
    config: {} as never,
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    },
    path: account.webhookPath,
  };
}

function request(body: unknown, authorization = "Bearer inbound-token") {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: "POST",
    url: "/external/messages",
    headers: {
      "content-type": "application/json",
      authorization,
    },
    socket: { remoteAddress: "127.0.0.1" },
  }) as never;
}

type TestResponse = {
  statusCode: number;
  headersSent: boolean;
  body: string;
  setHeader(name: string, value: string): void;
  end(value?: string): void;
  headers: Map<string, string>;
};

function response(): TestResponse {
  const headers = new Map<string, string>();
  return {
    statusCode: 200,
    headersSent: false,
    body: "",
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(value?: string) {
      this.body = value ?? "";
      this.headersSent = true;
    },
    headers,
  };
}

function replayGuard(result = true) {
  return {
    shouldProcessMessage: vi.fn(async () => result),
  };
}

describe("external webhook", () => {
  it("authenticates, normalizes, and acknowledges a standard message", async () => {
    const processMessage = vi.fn(async () => {});
    const dedupe = replayGuard();
    const targetsByPath = new Map([[account.webhookPath, [target()]]]);
    const handler = createExternalWebhookRequestHandler({
      targetsByPath,
      processMessage,
      replayGuard: dedupe,
    });
    const res = response();

    await handler(
      request({
        id: "message-1",
        text: "hello",
        senderId: "user-1",
        conversationId: "conversation-1",
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toEqual({ ok: true, messageId: "message-1" });
    expect(processMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "message-1",
        text: "hello",
        senderId: "user-1",
        conversationId: "conversation-1",
      }),
      expect.anything(),
    );
    expect(dedupe.shouldProcessMessage).toHaveBeenCalledWith({
      accountId: "default",
      messageId: "message-1",
    });
  });

  it("rejects an invalid token before reading the body", async () => {
    const processMessage = vi.fn(async () => {});
    const dedupe = replayGuard();
    const targetsByPath = new Map([[account.webhookPath, [target()]]]);
    const handler = createExternalWebhookRequestHandler({
      targetsByPath,
      processMessage,
      replayGuard: dedupe,
    });
    const res = response();

    await handler(request({ text: "hello" }, "wrong-token"), res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
    expect(processMessage).not.toHaveBeenCalled();
    expect(dedupe.shouldProcessMessage).not.toHaveBeenCalled();
  });

  it("acknowledges a replayed message without dispatching it again", async () => {
    const processMessage = vi.fn(async () => {});
    const dedupe = replayGuard(false);
    const targetsByPath = new Map([[account.webhookPath, [target()]]]);
    const handler = createExternalWebhookRequestHandler({
      targetsByPath,
      processMessage,
      replayGuard: dedupe,
    });
    const res = response();

    await handler(
      request({
        id: "message-replayed",
        text: "hello again",
        senderId: "user-1",
        conversationId: "conversation-1",
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body)).toEqual({
      ok: true,
      messageId: "message-replayed",
      duplicate: true,
    });
    expect(processMessage).not.toHaveBeenCalled();
  });
});

describe("external command authorization", () => {
  function commandRuntime() {
    return {
      text: { hasControlCommand: vi.fn(() => true) },
      commands: {
        shouldHandleTextCommands: vi.fn(() => true),
      },
      pairing: { readAllowFromStore: vi.fn(async () => []) },
    } as never;
  }

  it("uses the effective DM allowlist for control-command authorization", async () => {
    const runtime = commandRuntime();
    const allowed = await resolveExternalCommandAuthorization({
      message: {
        messageId: "message-1",
        text: "/status",
        senderId: "user-1",
        conversationId: "conversation-1",
        chatType: "direct",
        timestamp: Date.now(),
      },
      account,
      config: { commands: { useAccessGroups: true } } as never,
      channelRuntime: runtime,
    });
    const denied = await resolveExternalCommandAuthorization({
      message: {
        messageId: "message-2",
        text: "/status",
        senderId: "untrusted-user",
        conversationId: "conversation-1",
        chatType: "direct",
        timestamp: Date.now(),
      },
      account,
      config: { commands: { useAccessGroups: true } } as never,
      channelRuntime: runtime,
    });

    expect(allowed).toBe(true);
    expect(denied).toBe(false);
  });
});
