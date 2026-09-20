/**
 * Declared MCP server resolution.
 *
 * This module is the authorization boundary for MCP. A server is callable only if the operator
 * declared it in `tools.mcp.servers`; the agent supplies a *name*, never a command, a URL or an
 * argv. That split is deliberate: spawning a process or opening a remote connection is privileged,
 * so it is authorized by whoever writes the config, not by whatever the model decides at runtime.
 *
 * Resolution fails closed and reports rather than throws — one malformed declaration is surfaced as
 * a problem next to the usable servers, so a typo in one entry never silently disables the rest.
 */

import type { OpenClawConfig } from "../config/config.js";
import type {
  McpHttpServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
  McpToolsConfig,
  McpTransportId,
} from "../config/types.tools.js";

export const MCP_TRANSPORTS = ["stdio", "http"] as const;

/** Server names are handles the model passes as a tool argument; keep them to a safe alphabet. */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

export type ResolvedMcpServer = Readonly<{
  name: string;
  transport: McpTransportId;
  config: McpServerConfig;
  enabled: boolean;
  timeoutMs: number;
}>;

export type McpServerProblemCode =
  | "invalid_name"
  | "unknown_transport"
  | "missing_command"
  | "missing_url"
  | "invalid_url"
  | "invalid_args"
  | "invalid_env"
  | "invalid_headers"
  | "invalid_timeout"
  | "not_an_object";

export type McpServerProblem = Readonly<{
  name: string;
  code: McpServerProblemCode;
  message: string;
}>;

export type McpServerResolution = Readonly<{
  servers: readonly ResolvedMcpServer[];
  problems: readonly McpServerProblem[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTimeoutMs(value: unknown): number | undefined {
  if (value === undefined) {
    return DEFAULT_MCP_TIMEOUT_MS;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return undefined;
}

function normalizeStdio(
  name: string,
  raw: Record<string, unknown>,
): { config?: McpStdioServerConfig; problem?: McpServerProblem } {
  const command = raw.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    return { problem: { name, code: "missing_command", message: "stdio server needs `command`" } };
  }
  const timeoutMs = readTimeoutMs(raw.timeoutMs);
  if (timeoutMs === undefined) {
    return {
      problem: {
        name,
        code: "invalid_timeout",
        message: "`timeoutMs` must be a positive number of milliseconds",
      },
    };
  }
  const args = raw.args;
  if (
    args !== undefined &&
    !(Array.isArray(args) && args.every((item) => typeof item === "string"))
  ) {
    return {
      problem: { name, code: "invalid_args", message: "`args` must be an array of strings" },
    };
  }
  const env = raw.env;
  if (
    env !== undefined &&
    !(isRecord(env) && Object.values(env).every((item) => typeof item === "string"))
  ) {
    return {
      problem: { name, code: "invalid_env", message: "`env` must be a flat string map" },
    };
  }
  const config: McpStdioServerConfig = {
    transport: "stdio",
    command,
    ...(Array.isArray(args) ? { args: args } : {}),
    ...(isRecord(env) ? { env: env as Record<string, string> } : {}),
    ...(typeof raw.cwd === "string" && raw.cwd.length > 0 ? { cwd: raw.cwd } : {}),
    timeoutMs,
    ...(raw.enabled === false ? { enabled: false } : {}),
  };
  return { config };
}

function normalizeHttp(
  name: string,
  raw: Record<string, unknown>,
): { config?: McpHttpServerConfig; problem?: McpServerProblem } {
  const url = raw.url;
  if (typeof url !== "string" || url.trim().length === 0) {
    return { problem: { name, code: "missing_url", message: "http server needs `url`" } };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { problem: { name, code: "invalid_url", message: "`url` must be an absolute URL" } };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      problem: { name, code: "invalid_url", message: "`url` must use the http or https scheme" },
    };
  }
  const timeoutMs = readTimeoutMs(raw.timeoutMs);
  if (timeoutMs === undefined) {
    return {
      problem: {
        name,
        code: "invalid_timeout",
        message: "`timeoutMs` must be a positive number of milliseconds",
      },
    };
  }
  const headers = raw.headers;
  if (
    headers !== undefined &&
    !(isRecord(headers) && Object.values(headers).every((item) => typeof item === "string"))
  ) {
    return {
      problem: { name, code: "invalid_headers", message: "`headers` must be a flat string map" },
    };
  }
  const config: McpHttpServerConfig = {
    transport: "http",
    url,
    ...(isRecord(headers) ? { headers: headers as Record<string, string> } : {}),
    ...(typeof raw.proxyUrl === "string" && raw.proxyUrl.length > 0
      ? { proxyUrl: raw.proxyUrl }
      : {}),
    timeoutMs,
    ...(raw.enabled === false ? { enabled: false } : {}),
  };
  return { config };
}

function normalizeServer(
  name: string,
  raw: unknown,
): { server?: ResolvedMcpServer; problem?: McpServerProblem } {
  if (!MCP_SERVER_NAME_PATTERN.test(name)) {
    return {
      problem: {
        name,
        code: "invalid_name",
        message: "server name must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}",
      },
    };
  }
  if (!isRecord(raw)) {
    return {
      problem: { name, code: "not_an_object", message: "server declaration must be an object" },
    };
  }
  const transport = raw.transport;
  if (transport !== "stdio" && transport !== "http") {
    return {
      problem: {
        name,
        code: "unknown_transport",
        message: `transport must be one of ${MCP_TRANSPORTS.join(", ")}`,
      },
    };
  }
  const normalized = transport === "stdio" ? normalizeStdio(name, raw) : normalizeHttp(name, raw);
  if (normalized.problem || !normalized.config) {
    return { problem: normalized.problem };
  }
  const config = normalized.config;
  return {
    server: {
      name,
      transport,
      config,
      enabled: config.enabled !== false,
      timeoutMs: config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
    },
  };
}

/** Resolve every declared server. Malformed entries become problems, never silent omissions. */
export function resolveMcpServers(mcp: McpToolsConfig | undefined): McpServerResolution {
  const rawServers = mcp?.servers;
  if (!isRecord(rawServers)) {
    return { servers: [], problems: [] };
  }
  const servers: ResolvedMcpServer[] = [];
  const problems: McpServerProblem[] = [];
  for (const [name, raw] of Object.entries(rawServers)) {
    const result = normalizeServer(name, raw);
    if (result.server) {
      servers.push(result.server);
    } else if (result.problem) {
      problems.push(result.problem);
    }
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { servers, problems };
}

/** Convenience wrapper taking the whole config, mirroring `resolveWebToolsProxyUrl`. */
export function resolveMcpServersFromConfig(cfg?: OpenClawConfig): McpServerResolution {
  return resolveMcpServers(cfg?.tools?.mcp);
}

export function listEnabledMcpServers(cfg?: OpenClawConfig): ResolvedMcpServer[] {
  return resolveMcpServersFromConfig(cfg).servers.filter((server) => server.enabled);
}

export function findMcpServer(
  cfg: OpenClawConfig | undefined,
  name: string,
): ResolvedMcpServer | undefined {
  const wanted = name.trim();
  return resolveMcpServersFromConfig(cfg).servers.find((server) => server.name === wanted);
}

/**
 * Environment for a spawned stdio server.
 *
 * Two classes of variable are dropped rather than inherited:
 *
 * 1. Session-scoped variables (`CODEBUDDY_*`, `NODE_OPTIONS`, …). A child that inherits these
 *    behaves correctly on the day it is started and breaks later — the failure mode where a
 *    long-lived process accumulates session state and only restarting fixes it.
 * 2. Ambient proxy variables. Egress is declared, never inherited: a stdio server that needs a
 *    specific route must say so in its own `env`, so the same declaration takes the same route on a
 *    laptop behind a VPN and on a cloud host.
 */
const CHILD_ENV_DROP_PATTERNS: readonly RegExp[] = [
  /^(CODEBUDDY|CLAUDE_CODE|CURSOR|OPENCLAW_SESSION)_/iu,
  /^NODE_OPTIONS$/iu,
  /^https?_proxy$/iu,
  /^all_proxy$/iu,
  /^no_proxy$/iu,
];

export function buildMcpChildEnv(
  extra: Readonly<Record<string, string>> = {},
  parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) {
      continue;
    }
    if (CHILD_ENV_DROP_PATTERNS.some((pattern) => pattern.test(key))) {
      continue;
    }
    env[key] = value;
  }
  // Explicit declarations win over whatever the parent environment happened to have.
  for (const [key, value] of Object.entries(extra)) {
    env[key] = value;
  }
  return env;
}

export type McpServerSummary = Readonly<{
  name: string;
  transport: McpTransportId;
  enabled: boolean;
  /** stdio only. Never includes argv values that look like secrets. */
  command?: string;
  argCount?: number;
  /** stdio only. Key names never values. */
  envKeys?: readonly string[];
  cwd?: string;
  /** http only. */
  url?: string;
  /** http only. Key names, never values. */
  headerKeys?: readonly string[];
  /** http only. Whether an explicit proxy route is declared. */
  explicitProxy?: boolean;
  timeoutMs: number;
}>;

export type McpServerInspection = Readonly<{
  boundary: "mcp_servers_declaration_only";
  serverCount: number;
  enabledCount: number;
  servers: readonly McpServerSummary[];
  problems: readonly McpServerProblem[];
  transportsInUse: readonly McpTransportId[];
  surfaces: readonly string[];
  riskBoundaries: readonly string[];
}>;

function summarize(server: ResolvedMcpServer): McpServerSummary {
  const base = {
    name: server.name,
    transport: server.transport,
    enabled: server.enabled,
    timeoutMs: server.timeoutMs,
  };
  if (server.config.transport === "stdio") {
    return {
      ...base,
      command: server.config.command,
      ...(server.config.args ? { argCount: server.config.args.length } : {}),
      ...(server.config.env ? { envKeys: Object.keys(server.config.env).toSorted() } : {}),
      ...(server.config.cwd ? { cwd: server.config.cwd } : {}),
    };
  }
  return {
    ...base,
    url: server.config.url,
    ...(server.config.headers ? { headerKeys: Object.keys(server.config.headers).toSorted() } : {}),
    explicitProxy: typeof server.config.proxyUrl === "string",
  };
}

/**
 * Redacted view of the declared surface. Secret-bearing values (`env`, `headers`) are reduced to
 * key names, so this is safe to return to a model or to log.
 */
export function inspectMcpServers(cfg?: OpenClawConfig): McpServerInspection {
  const { servers, problems } = resolveMcpServersFromConfig(cfg);
  return {
    boundary: "mcp_servers_declaration_only",
    serverCount: servers.length,
    enabledCount: servers.filter((server) => server.enabled).length,
    servers: servers.map(summarize),
    problems,
    transportsInUse: [...new Set(servers.map((server) => server.transport))].toSorted(),
    surfaces: ["mcp_list_tools", "mcp_call_tool", "mcp_context"],
    riskBoundaries: [
      "declaration_only",
      "config_is_the_authorization_boundary",
      "no_model_supplied_command_or_url",
      "stdio_egress_declared_not_inherited",
      "http_egress_explicit_proxy_only",
      "secrets_never_returned",
    ],
  };
}
