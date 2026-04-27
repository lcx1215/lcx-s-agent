import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import JSON5 from "json5";
import type { OpenClawConfig } from "../../config/config.js";
import type { CliBackendConfig } from "../../config/types.agent-defaults.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const McpContextSchema = Type.Object({});

const WORKSPACE_MCP_FILES = [
  ".mcp.json",
  "mcp.json",
  "claude-mcp.json",
  ".cursor/mcp.json",
  ".cursor/mcp.jsonc",
] as const;

type McpServerSummary = {
  name: string;
  command?: string;
  url?: string;
  transport?: string;
  argCount?: number;
  envKeys?: string[];
  envValues?: Record<string, string>;
};

type McpIntegrationHint = {
  kind: "openspace" | "memd" | "memlayer";
  serverName: string;
  source: "workspace" | "cli-backend";
  sourcePath: string;
  localOnlyRecommended: boolean;
  cloudEnabled: boolean;
  hostSkillDirsConfigured: boolean;
  workspaceConfigured: boolean;
  recommendedWriteScope: string;
  recommendedRole: "optional-skill-engine" | "supplemental-durable-memory";
  protectedSummaryWriteBlocked: boolean;
  reflectCapable?: boolean;
  checkpointCapable?: boolean;
};

type McpContextWarning = {
  kind: "openspace" | "memd" | "memlayer";
  serverName: string;
  sourcePath: string;
  level: "warning";
  issue: "missing_host_skill_dirs" | "missing_workspace" | "cloud_enabled" | "hosted_backend";
  message: string;
  recommendation: string;
};

type ParsedMcpConfig = {
  path: string;
  source: "workspace" | "cli-backend";
  exists: boolean;
  parseError?: string;
  serverCount?: number;
  serverNames?: string[];
  servers?: McpServerSummary[];
};

function resolveUserPathMaybe(rawPath: string): string {
  if (rawPath.startsWith("~/")) {
    return path.join(process.env.HOME ?? "~", rawPath.slice(2));
  }
  return rawPath;
}

function normalizeForWorkspace(absPath: string, workspaceDir: string): string {
  const relative = path.relative(workspaceDir, absPath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return absPath;
}

function extractServerSummaries(parsed: unknown): McpServerSummary[] {
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const rawServers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (!rawServers || typeof rawServers !== "object" || Array.isArray(rawServers)) {
    return [];
  }
  return Object.entries(rawServers)
    .filter(([, value]) => value && typeof value === "object" && !Array.isArray(value))
    .map(([name, value]) => {
      const server = value as {
        command?: unknown;
        args?: unknown;
        url?: unknown;
        transport?: unknown;
        env?: unknown;
      };
      const env =
        server.env && typeof server.env === "object" && !Array.isArray(server.env)
          ? (server.env as Record<string, unknown>)
          : undefined;
      const envValues = env
        ? Object.fromEntries(
            Object.entries(env)
              .filter(
                ([key, value]) =>
                  typeof value === "string" && !/(key|token|secret|password)/i.test(key),
              )
              .map(([key, value]) => [key, value as string]),
          )
        : undefined;
      return {
        name,
        command: typeof server.command === "string" ? server.command : undefined,
        url: typeof server.url === "string" ? server.url : undefined,
        transport: typeof server.transport === "string" ? server.transport : undefined,
        argCount: Array.isArray(server.args) ? server.args.length : undefined,
        envKeys: env ? Object.keys(env).toSorted() : undefined,
        envValues,
      };
    });
}

function isOpenSpaceServer(summary: McpServerSummary): boolean {
  const command = summary.command?.toLowerCase() ?? "";
  const url = summary.url?.toLowerCase() ?? "";
  const name = summary.name.toLowerCase();
  return (
    name.includes("openspace") || command.includes("openspace-mcp") || url.includes("openspace")
  );
}

function isMemdServer(summary: McpServerSummary): boolean {
  const command = summary.command?.toLowerCase() ?? "";
  const url = summary.url?.toLowerCase() ?? "";
  const name = summary.name.toLowerCase();
  return (
    name === "memd" ||
    name.includes("memd") ||
    command.includes("@memd/mcp") ||
    url.includes("memd.dev")
  );
}

function isMemLayerServer(summary: McpServerSummary): boolean {
  const command = summary.command?.toLowerCase() ?? "";
  const url = summary.url?.toLowerCase() ?? "";
  const name = summary.name.toLowerCase();
  return name.includes("memlayer") || command.includes("memlayer") || url.includes("memlayer");
}

function buildIntegrationHints(configs: ParsedMcpConfig[]): McpIntegrationHint[] {
  const hints: McpIntegrationHint[] = [];
  for (const config of configs) {
    for (const server of config.servers ?? []) {
      if (isOpenSpaceServer(server)) {
        const envKeys = new Set(server.envKeys ?? []);
        const cloudEnabled = envKeys.has("OPENSPACE_API_KEY");
        hints.push({
          kind: "openspace",
          serverName: server.name,
          source: config.source,
          sourcePath: config.path,
          localOnlyRecommended: !cloudEnabled,
          cloudEnabled,
          hostSkillDirsConfigured: envKeys.has("OPENSPACE_HOST_SKILL_DIRS"),
          workspaceConfigured: envKeys.has("OPENSPACE_WORKSPACE"),
          recommendedWriteScope: "dedicated OpenSpace skills/workspace only",
          recommendedRole: "optional-skill-engine",
          protectedSummaryWriteBlocked: true,
        });
        continue;
      }
      if (isMemdServer(server)) {
        const envKeys = new Set(server.envKeys ?? []);
        const apiUrl = server.envValues?.MEMD_API_URL?.toLowerCase() ?? "";
        const transportUrl = server.url?.toLowerCase() ?? "";
        const cloudEnabled =
          envKeys.has("MEMD_API_KEY") ||
          apiUrl.includes("memd.dev") ||
          transportUrl.includes("memd.dev");
        hints.push({
          kind: "memd",
          serverName: server.name,
          source: config.source,
          sourcePath: config.path,
          localOnlyRecommended: true,
          cloudEnabled,
          hostSkillDirsConfigured: false,
          workspaceConfigured: false,
          recommendedWriteScope:
            "supplemental durable memory only; never overwrite protected summaries",
          recommendedRole: "supplemental-durable-memory",
          protectedSummaryWriteBlocked: true,
          checkpointCapable: true,
        });
        continue;
      }
      if (isMemLayerServer(server)) {
        hints.push({
          kind: "memlayer",
          serverName: server.name,
          source: config.source,
          sourcePath: config.path,
          localOnlyRecommended: true,
          cloudEnabled: false,
          hostSkillDirsConfigured: false,
          workspaceConfigured: false,
          recommendedWriteScope:
            "supplemental durable memory + reflect layer only; protected summaries stay local",
          recommendedRole: "supplemental-durable-memory",
          protectedSummaryWriteBlocked: true,
          reflectCapable: true,
        });
      }
    }
  }
  return hints;
}

function buildIntegrationWarnings(hints: McpIntegrationHint[]): McpContextWarning[] {
  const warnings: McpContextWarning[] = [];
  for (const hint of hints) {
    if (hint.kind !== "openspace") {
      continue;
    }
    if (!hint.hostSkillDirsConfigured) {
      warnings.push({
        kind: "openspace",
        serverName: hint.serverName,
        sourcePath: hint.sourcePath,
        level: "warning",
        issue: "missing_host_skill_dirs",
        message:
          "OpenSpace is configured without OPENSPACE_HOST_SKILL_DIRS, so evolved skills are not isolated to a dedicated host skills area.",
        recommendation:
          "Set OPENSPACE_HOST_SKILL_DIRS to a dedicated OpenSpace skills path before enabling skill capture or reuse.",
      });
    }
    if (!hint.workspaceConfigured) {
      warnings.push({
        kind: "openspace",
        serverName: hint.serverName,
        sourcePath: hint.sourcePath,
        level: "warning",
        issue: "missing_workspace",
        message:
          "OpenSpace is configured without OPENSPACE_WORKSPACE, so persistent skill evolution is not anchored to a dedicated workspace.",
        recommendation:
          "Set OPENSPACE_WORKSPACE to an isolated OpenSpace workspace before enabling persistent evolution.",
      });
    }
    if (hint.cloudEnabled) {
      warnings.push({
        kind: "openspace",
        serverName: hint.serverName,
        sourcePath: hint.sourcePath,
        level: "warning",
        issue: "cloud_enabled",
        message:
          "OpenSpace cloud sharing/API access is enabled for this server, which breaks the default local-only bounded integration posture.",
        recommendation:
          "Disable OPENSPACE_API_KEY unless the operator explicitly approves cloud-backed OpenSpace usage.",
      });
    }
  }
  for (const hint of hints) {
    if (hint.kind !== "memd") {
      continue;
    }
    if (hint.cloudEnabled) {
      warnings.push({
        kind: "memd",
        serverName: hint.serverName,
        sourcePath: hint.sourcePath,
        level: "warning",
        issue: "hosted_backend",
        message:
          "memd is configured against a hosted backend, which breaks the default local-first bounded-memory posture for Lobster.",
        recommendation:
          "Prefer a self-hosted or quarantined memd backend, and treat it as supplemental durable memory instead of a protected-summary source of truth.",
      });
    }
  }
  return warnings;
}

async function parseMcpConfigFile(params: {
  source: "workspace" | "cli-backend";
  absPath: string;
  workspaceDir: string;
}): Promise<ParsedMcpConfig> {
  const normalizedPath = normalizeForWorkspace(params.absPath, params.workspaceDir);
  try {
    const raw = await fs.readFile(params.absPath, "utf8");
    const parsed = JSON5.parse(raw);
    const servers = extractServerSummaries(parsed);
    return {
      path: normalizedPath,
      source: params.source,
      exists: true,
      serverCount: servers.length,
      serverNames: servers.map((entry) => entry.name),
      servers,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return {
        path: normalizedPath,
        source: params.source,
        exists: false,
      };
    }
    return {
      path: normalizedPath,
      source: params.source,
      exists: true,
      parseError: message,
    };
  }
}

async function collectWorkspaceMcpConfigs(workspaceDir: string): Promise<ParsedMcpConfig[]> {
  const candidates = WORKSPACE_MCP_FILES.map((entry) => path.join(workspaceDir, entry));
  const mcpDir = path.join(workspaceDir, ".mcp");
  try {
    const entries = await fs.readdir(mcpDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.endsWith(".json") && !entry.name.endsWith(".jsonc")) {
        continue;
      }
      candidates.push(path.join(mcpDir, entry.name));
    }
  } catch {
    // No .mcp directory is fine.
  }

  const deduped = Array.from(new Set(candidates.map((item) => path.normalize(item))));
  const results = await Promise.all(
    deduped.map((absPath) => parseMcpConfigFile({ source: "workspace", absPath, workspaceDir })),
  );
  return results.filter((entry) => entry.exists || entry.parseError);
}

function resolveCliBackendMcpPath(args?: string[]): { configPath?: string; strict: boolean } {
  const argv = Array.isArray(args) ? args : [];
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--mcp-config") {
      configPath = argv[i + 1];
      continue;
    }
    if (argv[i]?.startsWith("--mcp-config=")) {
      configPath = argv[i].slice("--mcp-config=".length);
    }
  }
  return {
    configPath,
    strict: argv.includes("--strict-mcp-config"),
  };
}

async function collectCliBackendMcpConfigs(params: {
  config?: OpenClawConfig;
  workspaceDir: string;
}): Promise<
  Array<
    ParsedMcpConfig & {
      backendId: string;
      strict: boolean;
      declaredPath?: string;
    }
  >
> {
  const cliBackends = params.config?.agents?.defaults?.cliBackends ?? {};
  const entries = Object.entries(cliBackends);
  const parsed = await Promise.all(
    entries.map(async ([backendId, backend]) => {
      const resolved = resolveCliBackendMcpPath((backend as CliBackendConfig | undefined)?.args);
      if (!resolved.configPath) {
        return {
          backendId,
          strict: resolved.strict,
          declaredPath: undefined,
          path: "",
          source: "cli-backend" as const,
          exists: false,
        };
      }
      const rawPath = resolveUserPathMaybe(resolved.configPath);
      const absPath = path.isAbsolute(rawPath)
        ? rawPath
        : path.resolve(params.workspaceDir, rawPath);
      const file = await parseMcpConfigFile({
        source: "cli-backend",
        absPath,
        workspaceDir: params.workspaceDir,
      });
      return {
        ...file,
        backendId,
        strict: resolved.strict,
        declaredPath: resolved.configPath,
      };
    }),
  );
  return parsed.filter((entry) => entry.declaredPath);
}

export function createMcpContextTool(options?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "MCP Context",
    name: "mcp_context",
    description:
      "Inspect repo-local MCP context and CLI MCP config wiring before guessing what MCP-backed context exists. Returns workspace MCP files, configured mcpServers, CLI backend MCP config paths, memory.qmd.mcporter status, and bounded integration hints for OpenSpace or external durable-memory MCP servers.",
    parameters: McpContextSchema,
    execute: async () => {
      const [workspaceConfigs, cliBackendConfigs] = await Promise.all([
        collectWorkspaceMcpConfigs(workspaceDir),
        collectCliBackendMcpConfigs({ config: options?.config, workspaceDir }),
      ]);
      const integrationHints = buildIntegrationHints([...workspaceConfigs, ...cliBackendConfigs]);
      const warnings = buildIntegrationWarnings(integrationHints);
      const mcporter = options?.config?.memory?.qmd?.mcporter;
      const totalServerCount =
        workspaceConfigs.reduce((sum, entry) => sum + (entry.serverCount ?? 0), 0) +
        cliBackendConfigs.reduce((sum, entry) => sum + (entry.serverCount ?? 0), 0);
      return jsonResult({
        workspaceDir,
        found:
          workspaceConfigs.length > 0 || cliBackendConfigs.length > 0 || mcporter?.enabled === true,
        workspaceConfigs,
        cliBackendConfigs,
        qmdMcporter: {
          enabled: mcporter?.enabled === true,
          serverName: mcporter?.serverName ?? "qmd",
          startDaemon: mcporter?.startDaemon !== false,
        },
        integrationHints,
        warnings,
        summary: {
          workspaceConfigCount: workspaceConfigs.length,
          cliBackendConfigCount: cliBackendConfigs.length,
          totalServerCount,
          warningCount: warnings.length,
        },
        recommendation:
          workspaceConfigs.length === 0 &&
          cliBackendConfigs.length === 0 &&
          mcporter?.enabled !== true
            ? "No MCP context surfaced from this workspace or current OpenClaw config."
            : undefined,
      });
    },
  };
}
