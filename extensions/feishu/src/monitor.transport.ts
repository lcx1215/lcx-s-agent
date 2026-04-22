import * as crypto from "crypto";
import * as http from "http";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  applyBasicWebhookRequestGuards,
  type RuntimeEnv,
  installRequestBodyLimitGuard,
} from "openclaw/plugin-sdk";
import { createFeishuWSClient } from "./client.js";
import {
  botOpenIds,
  FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
  FEISHU_WEBHOOK_MAX_BODY_BYTES,
  feishuWebhookRateLimiter,
  httpServers,
  recordWebhookStatus,
  wsClients,
} from "./monitor.state.js";
import type { ResolvedFeishuAccount } from "./types.js";

export type MonitorTransportParams = {
  account: ResolvedFeishuAccount;
  accountId: string;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  eventDispatcher: Lark.EventDispatcher;
};

function pickFeishuHeaderValue(headers: http.IncomingHttpHeaders, key: string): string | undefined {
  const value = headers[key];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" ? value : undefined;
}

function isFeishuCardActionPayload(data: unknown): boolean {
  if (!data || typeof data !== "object") {
    return false;
  }
  const payload = data as {
    header?: { event_type?: unknown };
    event?: { type?: unknown };
  };
  return (
    payload.header?.event_type === "card.action.trigger" ||
    payload.event?.type === "card.action.trigger"
  );
}

export function verifyFeishuCardActionWebhook(params: {
  data: unknown;
  headers: http.IncomingHttpHeaders;
  verificationToken?: string;
}): boolean {
  const verificationToken = params.verificationToken?.trim();
  if (!verificationToken) {
    return true;
  }

  if (!params.data || typeof params.data !== "object") {
    return false;
  }
  const payload = params.data as {
    header?: { token?: unknown };
    verification_token?: unknown;
  };

  const bodyToken =
    typeof payload.verification_token === "string" ? payload.verification_token.trim() : "";
  if (bodyToken && bodyToken === verificationToken) {
    return true;
  }

  const headerToken = typeof payload.header?.token === "string" ? payload.header.token.trim() : "";
  if (headerToken && headerToken === verificationToken) {
    return true;
  }

  const timestamp = pickFeishuHeaderValue(params.headers, "x-lark-request-timestamp")?.trim();
  const nonce = pickFeishuHeaderValue(params.headers, "x-lark-request-nonce")?.trim();
  const signature = pickFeishuHeaderValue(params.headers, "x-lark-signature")?.trim();
  if (!timestamp || !nonce || !signature) {
    return false;
  }

  const computedSignature = crypto
    .createHash("sha1")
    .update(`${timestamp}${nonce}${verificationToken}${JSON.stringify(params.data)}`)
    .digest("hex");
  return computedSignature === signature;
}

async function readWebhookRequestJson(req: http.IncomingMessage): Promise<unknown> {
  let chunks = "";
  for await (const chunk of req) {
    chunks += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  try {
    return JSON.parse(chunks);
  } catch {
    return "";
  }
}

function isWebhookJsonObject(data: unknown): data is Record<string, unknown> {
  return typeof data === "object" && data !== null;
}

export async function monitorWebSocket({
  account,
  accountId,
  runtime,
  abortSignal,
  eventDispatcher,
}: MonitorTransportParams): Promise<void> {
  const log = runtime?.log ?? console.log;
  log(`feishu[${accountId}]: starting WebSocket connection...`);

  const wsClient = createFeishuWSClient(account);
  wsClients.set(accountId, wsClient);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      wsClients.delete(accountId);
      botOpenIds.delete(accountId);
    };

    const handleAbort = () => {
      log(`feishu[${accountId}]: abort signal received, stopping`);
      cleanup();
      resolve();
    };

    if (abortSignal?.aborted) {
      cleanup();
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    try {
      wsClient.start({ eventDispatcher });
      log(`feishu[${accountId}]: WebSocket client started`);
    } catch (err) {
      cleanup();
      abortSignal?.removeEventListener("abort", handleAbort);
      reject(err);
    }
  });
}

export async function monitorWebhook({
  account,
  accountId,
  runtime,
  abortSignal,
  eventDispatcher,
}: MonitorTransportParams): Promise<void> {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const port = account.config.webhookPort ?? 3000;
  const path = account.config.webhookPath ?? "/feishu/events";
  const host = account.config.webhookHost ?? "127.0.0.1";

  log(`feishu[${accountId}]: starting Webhook server on ${host}:${port}, path ${path}...`);

  const server = http.createServer();

  server.on("request", (req, res) => {
    res.on("finish", () => {
      recordWebhookStatus(runtime, accountId, path, res.statusCode);
    });

    const rateLimitKey = `${accountId}:${path}:${req.socket.remoteAddress ?? "unknown"}`;
    if (
      !applyBasicWebhookRequestGuards({
        req,
        res,
        rateLimiter: feishuWebhookRateLimiter,
        rateLimitKey,
        nowMs: Date.now(),
        requireJsonContentType: true,
      })
    ) {
      return;
    }

    const guard = installRequestBodyLimitGuard(req, res, {
      maxBytes: FEISHU_WEBHOOK_MAX_BODY_BYTES,
      timeoutMs: FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
      responseFormat: "text",
    });
    if (guard.isTripped()) {
      return;
    }

    void Promise.resolve()
      .then(async () => {
        if (req.url !== path) {
          return;
        }

        const data = await readWebhookRequestJson(req);
        if (!isWebhookJsonObject(data)) {
          res.statusCode = 400;
          res.end("Bad Request");
          return;
        }
        const { isChallenge, challenge } = Lark.generateChallenge(data, {
          encryptKey: eventDispatcher.encryptKey,
        });
        if (isChallenge) {
          res.end(JSON.stringify(challenge));
          return;
        }

        if (
          isFeishuCardActionPayload(data) &&
          !verifyFeishuCardActionWebhook({
            data,
            headers: req.headers,
            verificationToken: account.verificationToken,
          })
        ) {
          error(`feishu[${accountId}]: rejected unverified card action callback`);
          res.statusCode = 401;
          res.end("Unauthorized");
          return;
        }

        const value = await eventDispatcher.invoke(
          Object.assign(Object.create({ headers: req.headers }), data),
        );
        res.end(JSON.stringify(value));
      })
      .catch((err) => {
        if (!guard.isTripped()) {
          error(`feishu[${accountId}]: webhook handler error: ${String(err)}`);
        }
      })
      .finally(() => {
        guard.dispose();
      });
  });

  httpServers.set(accountId, server);

  return new Promise((resolve, reject) => {
    const closeServer = async () => {
      if (!server.listening) {
        return;
      }
      await new Promise<void>((closeResolve) => {
        server.close(() => closeResolve());
      });
    };

    const cleanup = () => {
      httpServers.delete(accountId);
      botOpenIds.delete(accountId);
    };

    const handleAbort = async () => {
      log(`feishu[${accountId}]: abort signal received, stopping Webhook server`);
      await closeServer();
      cleanup();
      resolve();
    };

    if (abortSignal?.aborted) {
      void handleAbort();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    server.listen(port, host, () => {
      log(`feishu[${accountId}]: Webhook server listening on ${host}:${port}`);
    });

    server.on("error", (err) => {
      error(`feishu[${accountId}]: Webhook server error: ${err}`);
      abortSignal?.removeEventListener("abort", handleAbort);
      reject(err);
    });
  });
}
