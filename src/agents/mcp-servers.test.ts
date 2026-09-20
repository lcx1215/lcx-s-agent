import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { ToolsMcpSchema } from "../config/zod-schema.agent-runtime.js";
import {
  buildMcpChildEnv,
  findMcpServer,
  inspectMcpServers,
  listEnabledMcpServers,
  resolveMcpServersFromConfig,
} from "./mcp-servers.js";

function cfgWith(servers: unknown): OpenClawConfig {
  return { tools: { mcp: { servers } } } as unknown as OpenClawConfig;
}

describe("mcp server resolution", () => {
  it("resolves a stdio and an http declaration", () => {
    const { servers, problems } = resolveMcpServersFromConfig(
      cfgWith({
        local_bars: { transport: "stdio", command: "node", args: ["server.js"] },
        vendor: { transport: "http", url: "https://mcp.example.com/mcp" },
      }),
    );
    expect(problems).toEqual([]);
    expect(servers.map((entry) => entry.name)).toEqual(["local_bars", "vendor"]);
    expect(servers[0].transport).toBe("stdio");
    expect(servers[0].enabled).toBe(true);
    expect(servers[1].transport).toBe("http");
  });

  it("reports rather than drops a malformed entry", () => {
    const { servers, problems } = resolveMcpServersFromConfig(
      cfgWith({
        good: { transport: "stdio", command: "node" },
        "bad name!": { transport: "stdio", command: "node" },
        broken: { transport: "stdio" },
        alien: { transport: "grpc", url: "grpc://x" },
      }),
    );
    expect(servers.map((entry) => entry.name)).toEqual(["good"]);
    expect(problems.map((entry) => entry.code).toSorted()).toEqual([
      "invalid_name",
      "missing_command",
      "unknown_transport",
    ]);
  });

  it("keeps a disabled server out of the enabled list but still declared", () => {
    const cfg = cfgWith({ off: { transport: "stdio", command: "node", enabled: false } });
    expect(findMcpServer(cfg, "off")?.enabled).toBe(false);
    expect(listEnabledMcpServers(cfg)).toEqual([]);
    expect(inspectMcpServers(cfg).serverCount).toBe(1);
    expect(inspectMcpServers(cfg).enabledCount).toBe(0);
  });

  it("returns an empty surface when nothing is declared", () => {
    const { servers, problems } = resolveMcpServersFromConfig({} as OpenClawConfig);
    expect(servers).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("redacts secret-bearing values in the inspection payload", () => {
    const inspection = inspectMcpServers(
      cfgWith({
        local: { transport: "stdio", command: "node", env: { API_TOKEN: "sk-secret" } },
        remote: { transport: "http", url: "https://x/mcp", headers: { Authorization: "Bearer t" } },
      }),
    );
    const serialized = JSON.stringify(inspection);
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("Bearer t");
    const local = inspection.servers.find((entry) => entry.name === "local");
    expect(local?.envKeys).toEqual(["API_TOKEN"]);
    const remote = inspection.servers.find((entry) => entry.name === "remote");
    expect(remote?.headerKeys).toEqual(["Authorization"]);
    expect(remote?.explicitProxy).toBe(false);
  });

  it("rejects a non-http(s) url and a non-positive timeout", () => {
    const { problems } = resolveMcpServersFromConfig(
      cfgWith({
        a: { transport: "http", url: "ftp://x/mcp" },
        b: { transport: "http", url: "not a url" },
        c: { transport: "stdio", command: "node", timeoutMs: 0 },
      }),
    );
    expect(problems.map((entry) => entry.code)).toEqual([
      "invalid_url",
      "invalid_url",
      "invalid_timeout",
    ]);
  });
});

describe("mcp server zod schema", () => {
  it("accepts the two declared transports", () => {
    const parsed = ToolsMcpSchema?.safeParse({
      servers: {
        a: { transport: "stdio", command: "node", args: ["x.js"] },
        b: { transport: "http", url: "https://x/mcp", proxyUrl: "http://proxy:3128" },
      },
    });
    expect(parsed?.success).toBe(true);
  });

  it("is strict about unknown keys and unknown transports", () => {
    expect(
      ToolsMcpSchema?.safeParse({
        servers: { a: { transport: "stdio", command: "node", nope: 1 } },
      }).success,
    ).toBe(false);
    expect(
      ToolsMcpSchema?.safeParse({ servers: { a: { transport: "grpc", url: "grpc://x" } } }).success,
    ).toBe(false);
    expect(ToolsMcpSchema?.safeParse({ servers: {} }).success).toBe(true);
  });
});

describe("buildMcpChildEnv", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    HTTPS_PROXY: "http://proxy.corp:3128",
    https_proxy: "http://proxy.corp:3128",
    NO_PROXY: "localhost",
    NODE_OPTIONS: "--require ./shim.js",
    CODEBUDDY_SESSION_ID: "abc",
    OPENCLAW_STATE_DIR: "/state",
  } as NodeJS.ProcessEnv;

  it("drops ambient proxy variables so egress is declared, not inherited", () => {
    const env = buildMcpChildEnv({}, parent);
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.https_proxy).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
  });

  it("drops session-scoped variables and NODE_OPTIONS", () => {
    const env = buildMcpChildEnv({}, parent);
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.CODEBUDDY_SESSION_ID).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.OPENCLAW_STATE_DIR).toBe("/state");
  });

  it("lets an explicit env declaration override the scrubbed parent", () => {
    const env = buildMcpChildEnv({ HTTPS_PROXY: "http://explicit:3128", PATH: "/custom" }, parent);
    expect(env.HTTPS_PROXY).toBe("http://explicit:3128");
    expect(env.PATH).toBe("/custom");
  });
});
