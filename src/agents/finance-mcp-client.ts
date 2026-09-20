/**
 * Minimal MCP client for remote connectors over Streamable HTTP.
 *
 * Scope is deliberately narrow — `initialize`, `tools/list`, `tools/call` — because that is
 * exactly the surface the finance data vendors expose. Everything else is out of scope.
 *
 * Egress is explicit: the caller passes `proxyUrl`, and ambient proxy environment variables are
 * ignored by the guard, so the same code takes the same route on a laptop and on a cloud host.
 */

import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18" as const;

export type McpCallTransport = Readonly<{
  endpoint: string;
  headers?: Readonly<Record<string, string>>;
  proxyUrl?: string;
  timeoutMs?: number;
}>;

export type McpTool = Readonly<{
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}>;

export type McpToolCallResult = Readonly<{
  content: ReadonlyArray<Record<string, unknown>>;
  isError: boolean;
}>;

type JsonRpcResponse = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

function parseSsePayload(body: string): JsonRpcResponse | undefined {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const payload = trimmed.slice(5).trim();
    if (!payload) {
      continue;
    }
    try {
      return JSON.parse(payload) as JsonRpcResponse;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Decode one JSON-RPC message from either a JSON body or a streamable-HTTP SSE body. */
export function decodeMcpJsonRpc(body: string, contentType: string): JsonRpcResponse {
  if (contentType.includes("text/event-stream")) {
    const parsed = parseSsePayload(body);
    if (!parsed) {
      throw new Error("mcp: streamable http response contained no decodable event");
    }
    return parsed;
  }
  try {
    return JSON.parse(body) as JsonRpcResponse;
  } catch {
    throw new Error("mcp: response was not valid JSON-RPC");
  }
}

/**
 * Detect a vendor business error hidden inside an HTTP-200 `tools/call` payload.
 *
 * Observed in the wild: `isError: false` with a body of
 * `{"code":2003,"message":"Missing X-api-key","data":null}`. Left unflagged, that error reaches a
 * downstream answer as if it were data. The check is deliberately conservative — it only flags
 * payloads shaped like an error envelope (a non-success `code`, or a `message` with null `data`),
 * so ordinary data payloads are never dropped.
 */
export function detectVendorBusinessError(
  content: ReadonlyArray<Record<string, unknown>>,
): { code?: string | number; message?: string } | undefined {
  const first = content[0];
  if (typeof first?.text !== "string") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(first.text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const row = parsed as Record<string, unknown>;
  const code = row.code;
  const message = typeof row.message === "string" ? row.message : undefined;
  const successCode =
    code === 0 || code === 200 || code === "0" || code === "200" || code === undefined;
  if (successCode && !(message !== undefined && row.data === null)) {
    return undefined;
  }
  return {
    ...(code !== undefined ? { code: code as string | number } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

async function readJsonRpc(response: Response): Promise<JsonRpcResponse> {
  const body = await response.text();
  return decodeMcpJsonRpc(body, response.headers.get("content-type") ?? "");
}

async function postJsonRpc(
  transport: McpCallTransport,
  payload: Record<string, unknown>,
): Promise<{ message: JsonRpcResponse; sessionId?: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    ...transport.headers,
  };
  const result = await fetchWithSsrFGuard({
    url: transport.endpoint,
    init: { method: "POST", headers, body: JSON.stringify(payload) },
    ...(transport.proxyUrl ? { proxyUrl: transport.proxyUrl } : {}),
    ...(transport.timeoutMs ? { timeoutMs: transport.timeoutMs } : {}),
  });
  try {
    if (!result.response.ok) {
      throw new Error(`mcp: endpoint returned HTTP ${result.response.status}`);
    }
    const message = await readJsonRpc(result.response);
    const sessionId = result.response.headers.get("mcp-session-id") ?? undefined;
    return { message, sessionId };
  } finally {
    await result.release();
  }
}

export type McpSession = Readonly<{
  endpoint: string;
  protocolVersion: string;
  serverInfo?: Record<string, unknown>;
  headers: Readonly<Record<string, string>>;
  sessionId?: string;
  proxyUrl?: string;
  timeoutMs?: number;
}>;

/** `initialize` plus the required `notifications/initialized` handshake. */
export async function openMcpSession(transport: McpCallTransport): Promise<McpSession> {
  const { message, sessionId } = await postJsonRpc(transport, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "lcx-agent", version: "1.0.0" },
    },
  });
  if (message.error) {
    throw new Error(`mcp: initialize failed: ${message.error.message ?? "unknown error"}`);
  }
  const result = message.result ?? {};
  const negotiated =
    typeof result.protocolVersion === "string" ? result.protocolVersion : MCP_PROTOCOL_VERSION;
  const handshakeHeaders: Record<string, string> = { ...transport.headers };
  if (sessionId) {
    handshakeHeaders["mcp-session-id"] = sessionId;
  }
  const notified = await postJsonRpc(
    { ...transport, headers: handshakeHeaders },
    { jsonrpc: "2.0", method: "notifications/initialized" },
  );
  const activeSessionId = notified.sessionId ?? sessionId;
  return {
    endpoint: transport.endpoint,
    protocolVersion: negotiated,
    serverInfo:
      result.serverInfo && typeof result.serverInfo === "object"
        ? (result.serverInfo as Record<string, unknown>)
        : undefined,
    headers: {
      ...transport.headers,
      ...(activeSessionId ? { "mcp-session-id": activeSessionId } : {}),
    },
    sessionId: activeSessionId,
    ...(transport.proxyUrl ? { proxyUrl: transport.proxyUrl } : {}),
    ...(transport.timeoutMs ? { timeoutMs: transport.timeoutMs } : {}),
  };
}

function toTransport(session: McpSession): McpCallTransport {
  return {
    endpoint: session.endpoint,
    headers: session.headers,
    ...(session.proxyUrl ? { proxyUrl: session.proxyUrl } : {}),
    ...(session.timeoutMs ? { timeoutMs: session.timeoutMs } : {}),
  };
}

export async function mcpListTools(session: McpSession): Promise<McpTool[]> {
  const { message } = await postJsonRpc(toTransport(session), {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  if (message.error) {
    throw new Error(`mcp: tools/list failed: ${message.error.message ?? "unknown error"}`);
  }
  const tools = (message.result ?? {}).tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const tool = entry as Record<string, unknown>;
    if (typeof tool.name !== "string" || !tool.name.trim()) {
      return [];
    }
    return [
      {
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(tool.inputSchema && typeof tool.inputSchema === "object"
          ? { inputSchema: tool.inputSchema as Record<string, unknown> }
          : {}),
      },
    ];
  });
}

export async function mcpCallTool(
  session: McpSession,
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpToolCallResult> {
  const { message } = await postJsonRpc(toTransport(session), {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (message.error) {
    throw new Error(`mcp: tools/call failed: ${message.error.message ?? "unknown error"}`);
  }
  const result = message.result ?? {};
  const content = Array.isArray(result.content)
    ? result.content.flatMap((entry) =>
        entry && typeof entry === "object" ? [entry as Record<string, unknown>] : [],
      )
    : [];
  return { content, isError: result.isError === true };
}
