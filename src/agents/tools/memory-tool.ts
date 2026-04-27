import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import { resolveMemoryBackendConfig } from "../../memory/backend-config.js";
import { isFileMissingError, statRegularFile } from "../../memory/fs-utils.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { isMemoryPath } from "../../memory/internal.js";
import type { MemorySearchResult } from "../../memory/types.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
});

const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number()),
});

const PROTECTED_SUMMARY_PATHS = [
  "memory/current-research-line.md",
  "memory/unified-risk-view.md",
  "MEMORY.md",
] as const;

async function resolvePresentProtectedSummaryPaths(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<string[]> {
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const available = await Promise.all(
    PROTECTED_SUMMARY_PATHS.map(async (relPath) => {
      try {
        await fs.access(path.join(workspaceDir, relPath));
        return relPath;
      } catch {
        return undefined;
      }
    }),
  );
  return available.flatMap((relPath) => (relPath ? [relPath] : []));
}

async function checkMemoryPathExists(params: {
  cfg: OpenClawConfig;
  agentId: string;
  relPath: string;
}): Promise<boolean> {
  const trimmed = params.relPath.trim();
  if (!trimmed) {
    return false;
  }
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const absPath = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(workspaceDir, trimmed);
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function readMemoryFileDirectly(params: {
  cfg: OpenClawConfig;
  agentId: string;
  relPath: string;
  from?: number;
  lines?: number;
}): Promise<{ text: string; path: string; missing?: true }> {
  const rawPath = params.relPath.trim();
  if (!rawPath) {
    throw new Error("path required");
  }
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const absPath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(workspaceDir, rawPath);
  const normalizedRelPath = path.relative(workspaceDir, absPath).replace(/\\/g, "/");
  const inWorkspace =
    normalizedRelPath.length > 0 &&
    !normalizedRelPath.startsWith("..") &&
    !path.isAbsolute(normalizedRelPath);
  if (!(inWorkspace && isMemoryPath(normalizedRelPath)) || !absPath.endsWith(".md")) {
    throw new Error("path required");
  }

  const statResult = await statRegularFile(absPath);
  if (statResult.missing) {
    return { text: "", path: normalizedRelPath, missing: true };
  }

  let content: string;
  try {
    content = await fs.readFile(absPath, "utf-8");
  } catch (err) {
    if (isFileMissingError(err)) {
      return { text: "", path: normalizedRelPath, missing: true };
    }
    throw err;
  }

  if (!params.from && !params.lines) {
    return { text: content, path: normalizedRelPath };
  }
  const fileLines = content.split("\n");
  const start = Math.max(1, params.from ?? 1);
  const count = Math.max(1, params.lines ?? fileLines.length);
  const slice = fileLines.slice(start - 1, start - 1 + count);
  return { text: slice.join("\n"), path: normalizedRelPath };
}

function buildPrimaryAnchorRule(primaryAnchors: string[]): string {
  if (primaryAnchors.length === 0) {
    return "No protected summary files are present in this workspace yet; retrieved snippets remain supplemental recall and should not be presented as canonical current-state truth.";
  }
  return "Protected summaries present in this workspace are the canonical first anchors for current state; retrieved snippets are supporting recall until re-verified.";
}

function resolveMemoryToolContext(options: { config?: OpenClawConfig; agentSessionKey?: string }) {
  const cfg = options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: options.agentSessionKey,
    config: cfg,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  return { cfg, agentId };
}

export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;
  return {
    label: "Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall contract: when prior work, decisions, dates, people, preferences, or todos matter, anchor first on protected summaries when present, then use the broad memory recall surface over MEMORY.md + memory/*.md (and optional session transcripts). The retrieval implementation may be semantic, hybrid, keyword, or future upgraded recall; protected summaries remain the primary anchors for current state. If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.",
    parameters: MemorySearchSchema,
    execute: async (_toolCallId, params) => {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = readNumberParam(params, "maxResults");
      const minScore = readNumberParam(params, "minScore");
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        return jsonResult(await buildMemorySearchUnavailableResult({ error, cfg, agentId }));
      }
      try {
        const citationsMode = resolveMemoryCitationsMode(cfg);
        const includeCitations = shouldIncludeCitations({
          mode: citationsMode,
          sessionKey: options.agentSessionKey,
        });
        const rawResults = await manager.search(query, {
          maxResults,
          minScore,
          sessionKey: options.agentSessionKey,
        });
        const status = manager.status();
        const decorated = decorateCitations(rawResults, includeCitations);
        const resolved = resolveMemoryBackendConfig({ cfg, agentId });
        const results =
          status.backend === "qmd"
            ? clampResultsByInjectedChars(decorated, resolved.qmd?.limits.maxInjectedChars)
            : decorated;
        const searchMode = (status.custom as { searchMode?: string } | undefined)?.searchMode;
        const primaryAnchors = await resolvePresentProtectedSummaryPaths({ cfg, agentId });
        return jsonResult({
          results,
          provider: status.provider,
          model: status.model,
          fallback: status.fallback,
          citations: citationsMode,
          mode: searchMode,
          retrievalKind: resolveMemoryRetrievalKind({
            backend: status.backend,
            mode: searchMode,
          }),
          retrievalContract: "supplemental_recall",
          primaryAnchors,
          primaryAnchorRule: buildPrimaryAnchorRule(primaryAnchors),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult(
          await buildMemorySearchUnavailableResult({ error: message, cfg, agentId }),
        );
      }
    },
  };
}

export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(options);
  if (!ctx) {
    return null;
  }
  const { cfg, agentId } = ctx;
  return {
    label: "Memory Get",
    name: "memory_get",
    description:
      "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; read protected summaries directly first when current-state truth matters, or use after memory_search to pull only the needed lines and keep context small.",
    parameters: MemoryGetSchema,
    execute: async (_toolCallId, params) => {
      const relPath = readStringParam(params, "path", { required: true });
      const from = readNumberParam(params, "from", { integer: true });
      const lines = readNumberParam(params, "lines", { integer: true });
      const { manager, error } = await getMemorySearchManager({
        cfg,
        agentId,
      });
      if (!manager) {
        try {
          return jsonResult(
            await readMemoryFileDirectly({
              cfg,
              agentId,
              relPath,
              from: from ?? undefined,
              lines: lines ?? undefined,
            }),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ path: relPath, text: "", disabled: true, error: error ?? message });
        }
      }
      try {
        const result = await manager.readFile({
          relPath,
          from: from ?? undefined,
          lines: lines ?? undefined,
        });
        const exists = await checkMemoryPathExists({ cfg, agentId, relPath });
        return jsonResult(exists ? result : { ...result, missing: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ path: relPath, text: "", disabled: true, error: message });
      }
    },
  };
}

function resolveMemoryCitationsMode(cfg: OpenClawConfig): MemoryCitationsMode {
  const mode = cfg.memory?.citations;
  if (mode === "on" || mode === "off" || mode === "auto") {
    return mode;
  }
  return "auto";
}

function decorateCitations(results: MemorySearchResult[], include: boolean): MemorySearchResult[] {
  if (!include) {
    return results.map((entry) => ({ ...entry, citation: undefined }));
  }
  return results.map((entry) => {
    const citation = formatCitation(entry);
    const snippet = `${entry.snippet.trim()}\n\nSource: ${citation}`;
    return { ...entry, citation, snippet };
  });
}

function formatCitation(entry: MemorySearchResult): string {
  const lineRange =
    entry.startLine === entry.endLine
      ? `#L${entry.startLine}`
      : `#L${entry.startLine}-L${entry.endLine}`;
  return `${entry.path}${lineRange}`;
}

function clampResultsByInjectedChars(
  results: MemorySearchResult[],
  budget?: number,
): MemorySearchResult[] {
  if (!budget || budget <= 0) {
    return results;
  }
  let remaining = budget;
  const clamped: MemorySearchResult[] = [];
  for (const entry of results) {
    if (remaining <= 0) {
      break;
    }
    const snippet = entry.snippet ?? "";
    if (snippet.length <= remaining) {
      clamped.push(entry);
      remaining -= snippet.length;
    } else {
      const trimmed = snippet.slice(0, Math.max(0, remaining));
      clamped.push({ ...entry, snippet: trimmed });
      break;
    }
  }
  return clamped;
}

async function buildMemorySearchUnavailableResult(params: {
  error: string | undefined;
  cfg: OpenClawConfig;
  agentId: string;
}) {
  const primaryAnchors = await resolvePresentProtectedSummaryPaths({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const reason =
    (params.error ?? "memory search unavailable").trim() || "memory search unavailable";
  const isQuotaError = /insufficient_quota|quota|429/.test(reason.toLowerCase());
  const warning = isQuotaError
    ? "Memory search is unavailable because the embedding provider quota is exhausted."
    : "Memory search is unavailable due to an embedding/provider error.";
  const action = isQuotaError
    ? "Top up or switch embedding provider, then retry memory_search. Until then, fall back to direct memory_get reads on any protected summaries that are present."
    : "Check embedding provider configuration and retry memory_search. Until then, fall back to direct memory_get reads on any protected summaries that are present.";
  return {
    results: [],
    disabled: true,
    unavailable: true,
    retrievalContract: "supplemental_recall",
    primaryAnchors,
    primaryAnchorRule: buildPrimaryAnchorRule(primaryAnchors),
    error: reason,
    warning,
    action,
    fallbackStrategy:
      primaryAnchors.length > 0
        ? "Read any protected summaries present in this workspace directly with memory_get before declaring recall degraded."
        : "No protected summary files are present in this workspace yet; surface recall as degraded instead of pretending the primary anchors were checked.",
    fallbackPaths: primaryAnchors,
  };
}

function resolveMemoryRetrievalKind(params: {
  backend?: string;
  mode?: string;
}): "semantic" | "hybrid" | "keyword" | "vector" | "upgraded" {
  const mode = params.mode?.toLowerCase();
  if (mode === "deep_search" || mode === "query") {
    return "upgraded";
  }
  if (mode === "search") {
    return "keyword";
  }
  if (mode === "vector_search" || mode === "vsearch") {
    return "vector";
  }
  if (mode?.includes("hybrid")) {
    return "hybrid";
  }
  if (params.backend === "qmd") {
    return "upgraded";
  }
  return "semantic";
}

function shouldIncludeCitations(params: {
  mode: MemoryCitationsMode;
  sessionKey?: string;
}): boolean {
  if (params.mode === "on") {
    return true;
  }
  if (params.mode === "off") {
    return false;
  }
  // auto: show citations in direct chats; suppress in groups/channels by default.
  const chatType = deriveChatTypeFromSessionKey(params.sessionKey);
  return chatType === "direct";
}

function deriveChatTypeFromSessionKey(sessionKey?: string): "direct" | "group" | "channel" {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return "direct";
  }
  const tokens = new Set(parsed.rest.toLowerCase().split(":").filter(Boolean));
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("group")) {
    return "group";
  }
  return "direct";
}
