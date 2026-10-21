import { randomUUID } from "node:crypto";
import { fetchWithSsrFGuard } from "lcx-agent/plugin-sdk";
import type { ResolvedExternalAccount } from "./types.js";

export type ExternalFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type ExternalOutboundRequest = {
  url: string;
  init: RequestInit & { body: string };
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

async function withinDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(1, deadline - Date.now()));
        onAbort = () => reject(signal?.reason ?? new Error("external response cancelled"));
        if (signal?.aborted) {
          onAbort();
        } else {
          signal?.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

async function readExternalErrorText(
  response: Response,
  deadline: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let remaining = 4096;
  let failure: string | undefined;
  let cleanupConfirmed = false;
  try {
    while (remaining > 0) {
      const chunk = await withinDeadline(
        reader.read(),
        deadline,
        "response body read deadline",
        signal,
      );
      if (chunk.done) {
        text += decoder.decode();
        break;
      }
      const selected = chunk.value.subarray(0, remaining);
      text += decoder.decode(selected, { stream: true });
      remaining -= selected.byteLength;
      if (remaining === 0) {
        text += " [diagnostic body truncated]";
      }
    }
  } catch (error) {
    failure = String(error);
  } finally {
    try {
      await withinDeadline(reader.cancel(), deadline, "response body cleanup deadline");
      cleanupConfirmed = true;
    } catch {
      cleanupConfirmed = false;
    } finally {
      reader.releaseLock();
    }
  }
  return [
    text,
    failure,
    failure || !cleanupConfirmed
      ? `cleanup_${cleanupConfirmed ? "confirmed" : "unconfirmed"}`
      : undefined,
  ]
    .filter(Boolean)
    .join("; ");
}

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
  const target = params.target.trim();
  if (!target) {
    throw new Error("external target is required");
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
    target,
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
  const deadline = Date.now() + params.account.timeoutMs;
  const request = buildExternalOutboundRequest(params);
  const { response, release } = await fetchWithSsrFGuard({
    url: request.url,
    init: request.init,
    additionalSensitiveHeaders:
      params.account.outboundAuth === "header" ? [params.account.outboundTokenHeader] : undefined,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
    timeoutMs: params.account.timeoutMs,
    auditContext: `external.outbound.${params.account.accountId}`,
  });
  let terminalFailure: unknown;
  let hadTerminalFailure = false;
  try {
    if (!response.ok) {
      const responseText = await readExternalErrorText(response, deadline, params.signal);
      throw new Error(
        `external endpoint returned HTTP ${response.status}: ${responseText || response.statusText}`,
      );
    }
    // The acknowledgement needs only the status. Dispose of an unread body
    // before releasing its dispatcher; an open response can otherwise retain it.
    if (response.body) {
      try {
        await withinDeadline(
          response.body.cancel(),
          deadline,
          "external response body cleanup unconfirmed",
        );
      } catch (cause) {
        throw new Error("external response body cleanup unconfirmed", { cause });
      }
    }
    params.signal?.throwIfAborted();
    if (Date.now() >= deadline) {
      throw new Error("external response deadline exceeded");
    }
    return {
      channel: "external" as const,
      messageId: request.messageId,
      chatId: params.target,
    };
  } catch (error) {
    terminalFailure = error;
    hadTerminalFailure = true;
    throw error;
  } finally {
    try {
      await withinDeadline(release(), deadline, "external dispatcher cleanup deadline");
    } catch (cause) {
      const priorFailure =
        terminalFailure instanceof Error ? terminalFailure.message : String(terminalFailure);
      throw new Error(
        `${hadTerminalFailure ? `${priorFailure}; ` : ""}external dispatcher cleanup unconfirmed`,
        { cause },
      );
    }
    if (!hadTerminalFailure) {
      params.signal?.throwIfAborted();
      if (Date.now() >= deadline) {
        throw new Error("external response deadline exceeded");
      }
    }
  }
}
