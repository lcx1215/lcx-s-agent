import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectMcpServer, withMcpServer } from "./mcp-client.js";
import type { ResolvedMcpServer } from "./mcp-servers.js";

/**
 * A real MCP server over stdio. Written to disk rather than inlined so the test exercises the
 * actual spawn path — an in-process fake would prove nothing about the transport.
 */
const FIXTURE_SOURCE = `
process.stdout.write("booting fixture\\n");
if (process.env.MCP_FIXTURE_PID_FILE) {
  fs.writeFileSync(process.env.MCP_FIXTURE_PID_FILE, String(process.pid));
}
let buffer = "";
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i = buffer.indexOf("\\n");
  while (i >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    i = buffer.indexOf("\\n");
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fixture", version: "0" } } });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "echo arguments", inputSchema: { type: "object" } }] } });
    } else if (msg.method === "tools/call") {
      if (msg.params && msg.params.name === "fail") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "fixture failure" } });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(msg.params) }], isError: false } });
      }
    }
  }
});
`;

let tmpDir: string;
let scriptPath: string;
let pidFile: string;

function server(overrides: Partial<ResolvedMcpServer> = {}): ResolvedMcpServer {
  return {
    name: "fixture",
    transport: "stdio",
    enabled: true,
    timeoutMs: 10_000,
    config: {
      transport: "stdio",
      command: process.execPath,
      args: [scriptPath],
      env: { MCP_FIXTURE_PID_FILE: pidFile },
    },
    ...overrides,
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !pidAlive(pid);
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lcx-mcp-"));
  scriptPath = path.join(tmpDir, "fixture-server.js");
  pidFile = path.join(tmpDir, "child.pid");
  fs.writeFileSync(scriptPath, `const fs = require("node:fs");\n${FIXTURE_SOURCE}`);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("mcp stdio transport", () => {
  it("completes the handshake and lists tools over a real child process", async () => {
    const tools = await withMcpServer(server(), (connection) => connection.listTools());
    expect(tools).toEqual([
      {
        name: "echo",
        description: "echo arguments",
        inputSchema: { type: "object" },
      },
    ]);
  });

  it("calls a tool and returns its content", async () => {
    const result = await withMcpServer(server(), (connection) =>
      connection.callTool("echo", { symbol: "600519.SH" }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    const text = result.content[0]?.text;
    expect(typeof text).toBe("string");
    expect(JSON.parse(text as string)).toEqual({
      name: "echo",
      arguments: { symbol: "600519.SH" },
    });
  });

  it("tolerates a non-protocol line on stdout before the handshake", async () => {
    // The fixture writes "booting fixture" first; a strict parser would die on it.
    const connection = await connectMcpServer(server());
    try {
      expect(await connection.listTools()).toHaveLength(1);
    } finally {
      await connection.close();
    }
  });

  it("rejects a JSON-RPC error instead of returning it as data", async () => {
    await expect(
      withMcpServer(server(), (connection) => connection.callTool("fail", {})),
    ).rejects.toThrow(/fixture failure/u);
  });

  it("closes the child process, including when the work throws", async () => {
    await expect(
      withMcpServer(server(), async () => {
        throw new Error("work blew up");
      }),
    ).rejects.toThrow("work blew up");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);
    expect(await waitUntilGone(pid)).toBe(true);
  });

  it("reports a spawn failure instead of hanging", async () => {
    await expect(
      withMcpServer(
        server({ config: { transport: "stdio", command: "/definitely/not/a/binary" } }),
        (connection) => connection.listTools(),
      ),
    ).rejects.toThrow(/process error|spawn/u);
  });

  it("reports an immediately exiting server with its exit code", async () => {
    await expect(
      withMcpServer(
        server({
          config: {
            transport: "stdio",
            command: process.execPath,
            args: ["-e", "process.exit(3)"],
          },
        }),
        (connection) => connection.listTools(),
      ),
    ).rejects.toThrow(/exited with code 3/u);
  });

  it("times out instead of waiting forever on a silent server", async () => {
    await expect(
      withMcpServer(
        server({
          timeoutMs: 300,
          config: {
            transport: "stdio",
            command: process.execPath,
            args: ["-e", "setInterval(()=>{},1000)"],
            timeoutMs: 300,
          },
        }),
        (connection) => connection.listTools(),
      ),
    ).rejects.toThrow(/timed out/u);
  });
});
