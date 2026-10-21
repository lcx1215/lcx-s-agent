import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createExternalWebhookRequestHandler,
  processExternalMessage,
  resolveExternalCommandAuthorization,
} from "./monitor.js";
import type { ExternalWebhookTarget } from "./monitor.js";
import { normalizeExternalTarget } from "./protocol.js";
import { createExternalReplayGuard } from "./replay-guard.js";
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
    claimMessage: vi.fn(async () => (result ? { settle: vi.fn(async () => {}) } : undefined)),
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
    expect(dedupe.claimMessage).toHaveBeenCalledWith({
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
    expect(dedupe.claimMessage).not.toHaveBeenCalled();
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

it("persists an opaque inbound conversation ID so a later last-target delivery cannot change it", async () => {
  const finalize = vi.fn((context) => context);
  const record = vi.fn(async () => undefined);
  const core = {
    routing: {
      resolveAgentRoute: () => ({
        agentId: "main",
        accountId: "default",
        sessionKey: "agent:main:external:direct:group:123",
      }),
    },
    session: {
      resolveStorePath: () => "/unused",
      readSessionUpdatedAt: () => undefined,
      recordSessionMetaFromInbound: record,
    },
    text: { hasControlCommand: () => false },
    commands: { shouldHandleTextCommands: () => true },
    pairing: { readAllowFromStore: async () => [] },
    reply: {
      resolveEnvelopeFormatOptions: () => ({}),
      formatAgentEnvelope: ({ body }: { body: string }) => body,
      finalizeInboundContext: finalize,
      dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => undefined),
    },
  };
  await processExternalMessage(
    {
      messageId: "opaque-id",
      senderId: "user-1",
      conversationId: "group:123",
      chatType: "direct",
      text: "hello",
      timestamp: Date.now(),
    },
    { ...target(), channelRuntime: core as never },
  );
  const context = finalize.mock.calls[0][0];
  expect(context.To).toBe("external:conversation:group:123");
  expect(context.OriginatingTo).toBe(context.To);
  expect(normalizeExternalTarget(context.OriginatingTo)).toBe("group:123");
  expect(record).toHaveBeenCalledWith(
    expect.objectContaining({ ctx: expect.objectContaining({ OriginatingTo: context.To }) }),
  );
});

it("allows redelivery after the original pre-dispatch runtime failure", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "external-replay-recovery-"));
  try {
    const selected = target();
    const handler = createExternalWebhookRequestHandler({
      targetsByPath: new Map([[account.webhookPath, [selected]]]),
      replayGuard: createExternalReplayGuard({ stateDir }),
    });
    const body = {
      id: "retry-before-dispatch",
      senderId: "user-1",
      conversationId: "conversation-1",
      text: "hello",
    };
    await handler(request(body), response() as never);
    await vi.waitFor(() => expect(selected.runtime.error).toHaveBeenCalledTimes(1));
    await handler(request(body), response() as never);
    await vi.waitFor(() => expect(selected.runtime.error).toHaveBeenCalledTimes(2));
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

it("retains unknown processing failures across restart instead of blindly redelivering", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "external-replay-unknown-"));
  try {
    const selected = target();
    const processMessage = vi.fn(async () => {
      throw new Error("delivery may already have occurred");
    });
    const createHandler = () =>
      createExternalWebhookRequestHandler({
        targetsByPath: new Map([[account.webhookPath, [selected]]]),
        processMessage,
        replayGuard: createExternalReplayGuard({ stateDir }),
      });
    const body = {
      id: "unknown-dispatch",
      senderId: "user-1",
      conversationId: "conversation-1",
      text: "hello",
    };
    await createHandler()(request(body), response() as never);
    await vi.waitFor(() =>
      expect(selected.runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("outcome=delivery_unknown"),
      ),
    );
    const duplicate = response();
    await createHandler()(request(body), duplicate as never);
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(duplicate.body)).toMatchObject({ duplicate: true });
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

it("reports swallowed dispatcher reply errors as unknown after entering the original dispatch boundary", async () => {
  const selected = target();
  const core = {
    routing: {
      resolveAgentRoute: () => ({
        agentId: "main",
        accountId: "default",
        sessionKey: "agent:main:external:direct:1",
      }),
    },
    session: {
      resolveStorePath: () => "/unused",
      readSessionUpdatedAt: () => undefined,
      recordSessionMetaFromInbound: async () => undefined,
    },
    text: { hasControlCommand: () => false },
    commands: { shouldHandleTextCommands: () => true },
    pairing: { readAllowFromStore: async () => [] },
    reply: {
      resolveEnvelopeFormatOptions: () => ({}),
      formatAgentEnvelope: ({ body }: { body: string }) => body,
      finalizeInboundContext: (context: unknown) => context,
      dispatchReplyWithBufferedBlockDispatcher: vi.fn(
        async (input: {
          dispatcherOptions: { onError: (error: Error, info: { kind: "final" }) => void };
        }) => {
          input.dispatcherOptions.onError(new Error("transport result unknown"), { kind: "final" });
        },
      ),
    },
  };
  await expect(
    processExternalMessage(
      {
        messageId: "swallowed",
        senderId: "user-1",
        conversationId: "1",
        chatType: "direct",
        text: "hello",
        timestamp: Date.now(),
      },
      { ...selected, channelRuntime: core as never },
    ),
  ).rejects.toThrow("delivery outcome unknown");
  expect(core.reply.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
});
