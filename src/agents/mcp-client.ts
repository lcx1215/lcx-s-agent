/**
 * Unified MCP connection surface over two transports.
 *
 * `stdio` spawns a local server and speaks newline-delimited JSON-RPC over stdin/stdout — the
 * transport most of the MCP ecosystem actually ships (`npx …`, `uvx …`, a local binary).
 * `http` is Streamable HTTP; its protocol implementation lives in `finance-mcp-client.ts`, which is
 * a general MCP client despite the finance-era name.
 *
 * Connections are one-shot: open, do the work, `close()`. No session pool is kept, so a crashed
 * server can never leave an orphan process behind the agent. The cost is a fresh `initialize`
 * handshake per call, which is the right trade until there is a measured reason to cache.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  MCP_PROTOCOL_VERSION,
  mcpCallTool,
  mcpListTools,
  openMcpSession,
  type McpCallTransport,
  type McpSession,
  type McpTool,
  type McpToolCallResult,
} from "./finance-mcp-client.js";
import { buildMcpChildEnv, DEFAULT_MCP_TIMEOUT_MS, type ResolvedMcpServer } from "./mcp-servers.js";

export type { McpTool, McpToolCallResult };

export type McpConnection = Readonly<{
  serverName: string;
  transport: "stdio" | "http";
  listTools: () => Promise<McpTool[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolCallResult>;
  close: () => Promise<void>;
}>;

type JsonRpcMessage = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

const MAX_STDERR_CHARS = 2000;

/** Wait for a child to exit, resolving either way so `close()` can never hang. */
function waitForExit(child: ChildProcessWithoutNullStreams, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function describeTransportError(
  prefix: string,
  child: ChildProcessWithoutNullStreams,
  stderr: string,
): string {
  const detail = stderr.trim().slice(-MAX_STDERR_CHARS);
  return detail ? `${prefix}: ${detail}` : prefix;
}

/**
 * Spawn a stdio MCP server and complete the `initialize` handshake.
 *
 * Non-JSON lines on stdout are skipped rather than fatal: real servers occasionally emit a log line
 * before the protocol starts, and one stray line should not cost the whole connection.
 */
async function connectStdio(server: ResolvedMcpServer): Promise<McpConnection> {
  if (server.config.transport !== "stdio") {
    throw new Error(`mcp: server ${server.name} is not a stdio server`);
  }
  const { command, args = [], env = {}, cwd, timeoutMs } = server.config;
  const timeout = timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, args, {
      env: buildMcpChildEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
    });
  } catch (err) {
    throw new Error(`mcp: failed to spawn ${command}`, { cause: err });
  }

  let buffer = "";
  let stderr = "";
  let failure: string | undefined;
  const pending = new Map<
    number,
    {
      resolve: (value: JsonRpcMessage) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  const failAll = (message: string) => {
    failure = message;
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    pending.clear();
  };

  child.on("error", (err) => {
    failAll(`mcp: ${server.name} process error: ${err.message}`);
  });
  child.on("exit", (code, signal) => {
    const reason = signal ? `killed by ${signal}` : `exited with code ${code}`;
    failAll(describeTransportError(`mcp: ${server.name} ${reason}`, child, stderr));
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) {
        continue;
      }
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        // Not protocol traffic; ignore rather than tear the connection down.
        continue;
      }
      if (typeof message.id !== "number") {
        continue;
      }
      const entry = pending.get(message.id);
      if (!entry) {
        continue;
      }
      pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.resolve(message);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < MAX_STDERR_CHARS) {
      stderr += chunk.slice(0, MAX_STDERR_CHARS - stderr.length);
    }
  });

  let nextId = 1;
  const write = (payload: Record<string, unknown>) => {
    if (failure) {
      throw new Error(failure);
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const request = (method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> =>
    new Promise<JsonRpcMessage>((resolve, reject) => {
      if (failure) {
        reject(new Error(failure));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            describeTransportError(
              `mcp: ${server.name} timed out after ${timeout}ms waiting for ${method}`,
              child,
              stderr,
            ),
          ),
        );
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      try {
        write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

  // Closing the stdin pipe is what a well-behaved server exits on; the signals are only a fallback
  // for one that does not, so a hung server can never leave an orphan process behind the agent.
  const close = async () => {
    failAll(`mcp: ${server.name} connection closed`);
    try {
      child.stdin.end();
    } catch {
      // The pipe is already gone; the signals below are what matter.
    }
    await waitForExit(child, 500);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child, 2000);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  };

  try {
    const init = await request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "lcx-agent", version: "1.0.0" },
    });
    if (init.error) {
      throw new Error(`mcp: initialize failed: ${init.error.message ?? "unknown error"}`);
    }
    // Notification: no id, no reply expected.
    write({ jsonrpc: "2.0", method: "notifications/initialized" });
  } catch (err) {
    await close();
    throw err;
  }

  return {
    serverName: server.name,
    transport: "stdio",
    listTools: async () => {
      const message = await request("tools/list", {});
      if (message.error) {
        throw new Error(`mcp: tools/list failed: ${message.error.message ?? "unknown error"}`);
      }
      return normalizeTools(message.result ?? {});
    },
    callTool: async (name, args) => {
      const message = await request("tools/call", { name, arguments: args ?? {} });
      if (message.error) {
        throw new Error(`mcp: tools/call failed: ${message.error.message ?? "unknown error"}`);
      }
      return normalizeCallResult(message.result ?? {});
    },
    close,
  };
}

function normalizeTools(result: Record<string, unknown>): McpTool[] {
  const tools = result.tools;
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

function normalizeCallResult(result: Record<string, unknown>): McpToolCallResult {
  const content = Array.isArray(result.content)
    ? result.content.flatMap((entry) =>
        entry && typeof entry === "object" ? [entry as Record<string, unknown>] : [],
      )
    : [];
  return { content, isError: result.isError === true };
}

async function connectHttp(server: ResolvedMcpServer): Promise<McpConnection> {
  if (server.config.transport !== "http") {
    throw new Error(`mcp: server ${server.name} is not an http server`);
  }
  const { url, headers = {}, proxyUrl, timeoutMs } = server.config;
  const transport: McpCallTransport = {
    endpoint: url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(proxyUrl ? { proxyUrl } : {}),
    timeoutMs: timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
  };
  let session: McpSession;
  try {
    session = await openMcpSession(transport);
  } catch (err) {
    throw new Error(`mcp: ${server.name} initialize failed`, { cause: err });
  }
  return {
    serverName: server.name,
    transport: "http",
    listTools: () => mcpListTools(session),
    callTool: (name, args) => mcpCallTool(session, name, args),
    close: async () => {
      // Streamable HTTP sessions are stateless from the caller's side; nothing to tear down.
    },
  };
}

/** Open a connection to a declared server. The caller owns `close()`. */
export function connectMcpServer(server: ResolvedMcpServer): Promise<McpConnection> {
  return server.transport === "stdio" ? connectStdio(server) : connectHttp(server);
}

/**
 * Run one unit of work against a declared server, closing the connection whatever happens.
 * Without this wrapper a thrown error mid-call would leave a spawned child alive.
 */
export async function withMcpServer<T>(
  server: ResolvedMcpServer,
  work: (connection: McpConnection) => Promise<T>,
): Promise<T> {
  const connection = await connectMcpServer(server);
  try {
    return await work(connection);
  } finally {
    await connection.close();
  }
}
