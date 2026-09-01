import { randomUUID } from "node:crypto";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk";
import type { ResolvedExternalAccount } from "./types.js";

export type ExternalFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ExternalOutboundRequest = {
  url: string;
  init: RequestInit;
  messageId: string;
};

export type ExternalOutboundMessage = {
  account: ResolvedExternalAccount;
  target: string;
  text: string;
  mediaUrls?: string[];
  replyToId?: string | null;
  threadId?: string | number | null;
  messageId?: string;
  timestamp?: string;
};

function buildAuthHeaders(account: ResolvedExternalAccount, headers: Headers): void {
  if (account.outboundAuth === "none" || !account.outboundToken) {
    return;
  }
  if (account.outboundAuth === "bearer") {
    headers.set("authorization", `Bearer ${account.outboundToken}`);
    return;
  }
  headers.set(account.outboundTokenHeader, account.outboundToken);
}

export function buildExternalOutboundRequest(
  params: ExternalOutboundMessage,
): ExternalOutboundRequest {
  const { account } = params;
  if (!account.outboundUrl) {
    throw new Error("external outboundUrl is not configured");
  }
  const messageId = params.messageId?.trim() || randomUUID();
  const headers = new Headers({
    "content-type": "application/json",
    "idempotency-key": messageId,
  });
  buildAuthHeaders(account, headers);
  const body = {
    version: 1,
    type: "message",
    channel: "external",
    accountId: account.accountId,
    messageId,
    target: params.target,
    text: params.text,
    ...(params.mediaUrls?.length ? { mediaUrls: params.mediaUrls } : {}),
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
    ...(params.threadId !== undefined && params.threadId !== null
      ? { threadId: String(params.threadId) }
      : {}),
    timestamp: params.timestamp ?? new Date().toISOString(),
  };
  return {
    url: account.outboundUrl,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    messageId,
  };
}

export async function sendExternalMessage(
  params: ExternalOutboundMessage & {
    fetchImpl?: ExternalFetch;
    signal?: AbortSignal;
  },
) {
  const request = buildExternalOutboundRequest(params);
  const { response, release } = await fetchWithSsrFGuard({
    url: request.url,
    init: request.init,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
    timeoutMs: params.account.timeoutMs,
    auditContext: `external.outbound.${params.account.accountId}`,
  });
  try {
    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new Error(
        `external endpoint returned HTTP ${response.status}: ${responseText || response.statusText}`,
      );
    }
    return {
      channel: "external" as const,
      messageId: request.messageId,
      chatId: params.target,
    };
  } finally {
    await release();
  }
}
