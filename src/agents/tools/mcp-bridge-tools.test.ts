import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createMcpCallToolTool, createMcpListToolsTool } from "./mcp-bridge-tools.js";

const FIXTURE = `
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
let b = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  b += c;
  let i = b.indexOf("\\n");
  while (i >= 0) {
    const line = b.slice(0, i).trim();
    b = b.slice(i + 1);
    i = b.indexOf("\\n");
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fixture", version: "0" } } });
    } else if (m.method === "tools/list") {
      send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "echo" }] } });
    } else if (m.method === "tools/call") {
      send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok " + JSON.stringify(m.params.arguments) }], isError: false } });
    }
  }
});
`;

let tmpDir: string;
let scriptPath: string;

function configWith(servers: unknown): OpenClawConfig {
  return { tools: { mcp: { servers } } } as unknown as OpenClawConfig;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lcx-mcp-bridge-"));
  scriptPath = path.join(tmpDir, "server.js");
  fs.writeFileSync(scriptPath, FIXTURE);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("mcp_list_tools", () => {
  it("returns the declaration surface without connecting when no server is given", async () => {
    const tool = createMcpListToolsTool({
      config: configWith({ local: { transport: "stdio", command: "node" } }),
    });
    const result = await tool.execute("call-1", {});
    const details = result.details as { serverCount: number; note: string };
    expect(details.serverCount).toBe(1);
    expect(details.note).toContain("nothing was contacted");
  });

  it("lists tools from a declared stdio server", async () => {
    const tool = createMcpListToolsTool({
      config: configWith({
        local: { transport: "stdio", command: process.execPath, args: [scriptPath] },
      }),
    });
    const details = (await tool.execute("call-1", { server: "local" })).details as {
      toolCount: number;
      tools: Array<{ name: string }>;
    };
    expect(details.toolCount).toBe(1);
    expect(details.tools[0]?.name).toBe("echo");
  });
});

describe("mcp_call_tool", () => {
  it("refuses a server that is not declared in config", async () => {
    const tool = createMcpCallToolTool({
      config: configWith({ local: { transport: "stdio", command: "node" } }),
    });
    await expect(
      tool.execute("call-1", { server: "attacker", tool: "exec", arguments: { cmd: "rm -rf /" } }),
    ).rejects.toThrow(/not declared/u);
  });

  it("refuses a declared but disabled server", async () => {
    const tool = createMcpCallToolTool({
      config: configWith({
        off: { transport: "stdio", command: process.execPath, args: [scriptPath], enabled: false },
      }),
    });
    await expect(tool.execute("call-1", { server: "off", tool: "echo" })).rejects.toThrow(
      /enabled: false/u,
    );
  });

  it("refuses when nothing is declared at all", async () => {
    const tool = createMcpCallToolTool({ config: {} as OpenClawConfig });
    await expect(tool.execute("call-1", { server: "x", tool: "y" })).rejects.toThrow(
      /no MCP servers are configured/u,
    );
  });

  it("requires a tool name", async () => {
    const tool = createMcpCallToolTool({
      config: configWith({ local: { transport: "stdio", command: "node" } }),
    });
    await expect(tool.execute("call-1", { server: "local", tool: "  " })).rejects.toThrow(
      /tool is required/u,
    );
  });

  it("calls a tool and marks the output untrusted", async () => {
    const tool = createMcpCallToolTool({
      config: configWith({
        local: { transport: "stdio", command: process.execPath, args: [scriptPath] },
      }),
    });
    const details = (
      await tool.execute("call-1", {
        server: "local",
        tool: "echo",
        arguments: { symbol: "600519.SH" },
      })
    ).details as {
      content: Array<{ text: string }>;
      isError: boolean;
      provenance: { untrusted: boolean; source: string };
    };
    expect(details.isError).toBe(false);
    expect(details.content[0]?.text).toContain("600519.SH");
    expect(details.provenance.untrusted).toBe(true);
    expect(details.provenance.source).toBe("mcp:local:echo");
  });
});
