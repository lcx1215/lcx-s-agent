import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listAgentEntries,
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
} from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { writeFileWithinRoot } from "../../infra/fs-safe.js";
import {
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { hasInterSessionUserProvenance } from "../../sessions/input-provenance.js";
import type { HookEvent, HookHandler } from "../hooks.js";
import { generateSlugViaLLM } from "../llm-slug-generator.js";

export type SessionTurn = { role: "user" | "assistant"; text: string };
export type SessionEntryRecord = Record<string, unknown>;
export type ResolvedMemorySessionContext = {
  cfg?: OpenClawConfig;
  workspaceDir: string;
  memoryDir: string;
  sessionEntry: SessionEntryRecord;
  sessionId?: string;
  sessionFile?: string;
  displaySessionKey: string;
};

type ArtifactLogger = {
  info: (message: string) => void;
  error: (message: string, metadata?: Record<string, unknown>) => void;
};

type SessionArtifactContext = {
  event: HookEvent;
  cfg?: OpenClawConfig;
  workspaceDir: string;
  memoryDir: string;
  sessionId?: string;
  turns: SessionTurn[];
  now: Date;
  dateStr: string;
  timeStr: string;
};

export function compactText(text: string, max = 280): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

export function formatSessionTurns(turns: SessionTurn[]): string {
  return turns.map((turn) => `${turn.role}: ${turn.text}`).join("\n");
}

export async function loadSessionTurns(
  sessionFilePath: string,
  messageCount: number,
): Promise<SessionTurn[]> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const turns: SessionTurn[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== "message" || !entry.message) {
          continue;
        }
        const msg = entry.message;
        const role = msg.role;
        if ((role !== "user" && role !== "assistant") || !msg.content) {
          continue;
        }
        if (role === "user" && hasInterSessionUserProvenance(msg)) {
          continue;
        }
        const text = Array.isArray(msg.content)
          ? // oxlint-disable-next-line typescript/no-explicit-any
            msg.content.find((contentPart: any) => contentPart.type === "text")?.text
          : msg.content;
        if (!text || text.startsWith("/")) {
          continue;
        }
        turns.push({ role, text: String(text).trim() });
      } catch {
        // Ignore bad JSONL rows.
      }
    }

    return turns.slice(-messageCount);
  } catch {
    return [];
  }
}

async function listResetSiblingCandidates(sessionFilePath: string): Promise<string[]> {
  try {
    const dir = path.dirname(sessionFilePath);
    const base = path.basename(sessionFilePath);
    const resetPrefix = `${base}.reset.`;
    const files = await fs.readdir(dir);
    return files
      .filter((name) => name.startsWith(resetPrefix))
      .toSorted()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export async function loadSessionTurnsWithResetFallback(
  sessionFilePath: string,
  messageCount: number,
): Promise<SessionTurn[]> {
  const primaryTurns = await loadSessionTurns(sessionFilePath, messageCount);
  if (primaryTurns.length > 0) {
    return primaryTurns;
  }

  const resetCandidates = await listResetSiblingCandidates(sessionFilePath);
  if (resetCandidates.length === 0) {
    return primaryTurns;
  }

  const latestResetPath = resetCandidates.at(-1);
  return latestResetPath ? loadSessionTurns(latestResetPath, messageCount) : primaryTurns;
}

async function findPreviousSessionFile(params: {
  sessionsDir: string;
  currentSessionFile?: string;
  sessionId?: string;
  fallbackToLatestNonReset?: boolean;
}): Promise<string | undefined> {
  try {
    const files = await fs.readdir(params.sessionsDir);
    const fileSet = new Set(files);
    const trimmedSessionId = params.sessionId?.trim();

    if (params.currentSessionFile) {
      const base = path.basename(params.currentSessionFile).split(".reset.")[0];
      if (base && fileSet.has(base)) {
        return path.join(params.sessionsDir, base);
      }
    }

    if (trimmedSessionId) {
      const canonical = `${trimmedSessionId}.jsonl`;
      if (fileSet.has(canonical)) {
        return path.join(params.sessionsDir, canonical);
      }
      const topicVariants = files
        .filter(
          (name) =>
            name.startsWith(`${trimmedSessionId}-topic-`) &&
            name.endsWith(".jsonl") &&
            !name.includes(".reset."),
        )
        .toSorted()
        .toReversed();
      if (topicVariants.length > 0) {
        return path.join(params.sessionsDir, topicVariants[0]);
      }
    }

    if (params.fallbackToLatestNonReset) {
      const nonResetJsonl = files
        .filter((name) => name.endsWith(".jsonl") && !name.includes(".reset."))
        .toSorted()
        .toReversed();
      if (nonResetJsonl.length > 0) {
        return path.join(params.sessionsDir, nonResetJsonl[0]);
      }
    }
  } catch {
    // Ignore lookup errors.
  }
  return undefined;
}

export async function resolveSessionFile(params: {
  workspaceDir: string;
  sessionId?: string;
  sessionFile?: string;
  fallbackToLatestNonReset?: boolean;
}): Promise<string | undefined> {
  const sessionsDirs = new Set<string>();
  if (params.sessionFile) {
    sessionsDirs.add(path.dirname(params.sessionFile));
  }
  sessionsDirs.add(path.join(params.workspaceDir, "sessions"));

  for (const sessionsDir of sessionsDirs) {
    const recovered = await findPreviousSessionFile({
      sessionsDir,
      currentSessionFile: params.sessionFile,
      sessionId: params.sessionId,
      fallbackToLatestNonReset: params.fallbackToLatestNonReset,
    });
    if (recovered) {
      return recovered;
    }
  }
  return params.sessionFile;
}

export async function generateArtifactSlug(params: {
  turns: SessionTurn[];
  cfg?: OpenClawConfig;
  slugPrefix?: string;
  fallbackSlug: string;
}): Promise<string> {
  const isTestEnv =
    process.env.OPENCLAW_TEST_FAST === "1" ||
    process.env.VITEST === "true" ||
    process.env.VITEST === "1" ||
    process.env.NODE_ENV === "test";

  if (!isTestEnv && params.cfg) {
    const sessionContent = params.turns.map((turn) => `${turn.role}: ${turn.text}`).join("\n");
    const llmSlug = await generateSlugViaLLM({ sessionContent, cfg: params.cfg });
    if (llmSlug) {
      return params.slugPrefix ? `${params.slugPrefix}-${llmSlug}` : llmSlug;
    }
  }

  return params.fallbackSlug;
}

export async function resolveMemorySessionContext(params: {
  event: HookEvent;
  fallbackToLatestNonReset?: boolean;
}): Promise<ResolvedMemorySessionContext> {
  const context = params.event.context || {};
  const cfg = context.cfg as OpenClawConfig | undefined;
  const contextWorkspaceDir =
    typeof context.workspaceDir === "string" && context.workspaceDir.trim().length > 0
      ? context.workspaceDir
      : undefined;
  const agentId = resolveAgentIdFromSessionKey(params.event.sessionKey);
  const workspaceDir =
    contextWorkspaceDir ||
    (cfg
      ? resolveAgentWorkspaceDir(cfg, agentId)
      : path.join(resolveStateDir(process.env, os.homedir), "workspace"));
  const memoryDir = path.join(workspaceDir, "memory");
  await fs.mkdir(memoryDir, { recursive: true });

  const sessionEntry = (context.previousSessionEntry ||
    context.sessionEntry ||
    {}) as SessionEntryRecord;
  const sessionId = sessionEntry.sessionId as string | undefined;
  const sessionFile = await resolveSessionFile({
    workspaceDir,
    sessionId,
    sessionFile: sessionEntry.sessionFile as string | undefined,
    fallbackToLatestNonReset: params.fallbackToLatestNonReset,
  });
  let displaySessionKey = params.event.sessionKey;
  if (cfg && contextWorkspaceDir) {
    const workspaceAgentId = resolveAgentIdForWorkspaceDir(cfg, contextWorkspaceDir);
    const parsed = parseAgentSessionKey(params.event.sessionKey);
    if (workspaceAgentId && parsed && workspaceAgentId !== parsed.agentId) {
      displaySessionKey = toAgentStoreSessionKey({
        agentId: workspaceAgentId,
        requestKey: parsed.rest,
      });
    }
  }

  return {
    cfg,
    workspaceDir,
    memoryDir,
    sessionEntry,
    sessionId,
    sessionFile,
    displaySessionKey,
  };
}

function resolveAgentIdForWorkspaceDir(
  cfg: OpenClawConfig,
  workspaceDir: string,
): string | undefined {
  const targetDir = path.resolve(workspaceDir);
  const candidateAgentIds = new Set<string>();

  candidateAgentIds.add(resolveDefaultAgentId(cfg));
  for (const entry of listAgentEntries(cfg)) {
    if (typeof entry.id === "string" && entry.id.trim().length > 0) {
      candidateAgentIds.add(entry.id);
    }
  }

  for (const candidateAgentId of candidateAgentIds) {
    const candidateDir = path.resolve(resolveAgentWorkspaceDir(cfg, candidateAgentId));
    if (candidateDir === targetDir) {
      return candidateAgentId;
    }
  }

  return undefined;
}

export function createSessionArtifactHandler(params: {
  logger: ArtifactLogger;
  successMessage: string;
  failureMessage: string;
  messageCount: number;
  slugPrefix?: string;
  shouldPersist: (turns: SessionTurn[]) => boolean;
  fallbackSlug: (turns: SessionTurn[]) => string;
  renderContent: (context: SessionArtifactContext) => string;
}): HookHandler {
  return async (event) => {
    if (event.type !== "command" || (event.action !== "new" && event.action !== "reset")) {
      return;
    }

    try {
      const { cfg, workspaceDir, memoryDir, sessionId, sessionFile } =
        await resolveMemorySessionContext({ event });
      if (!sessionFile) {
        return;
      }

      const turns = await loadSessionTurns(sessionFile, params.messageCount);
      if (!params.shouldPersist(turns)) {
        return;
      }

      const now = new Date(event.timestamp);
      const dateStr = now.toISOString().split("T")[0];
      const timeStr = now.toISOString().split("T")[1].split(".")[0];
      const slug = await generateArtifactSlug({
        turns,
        cfg,
        slugPrefix: params.slugPrefix,
        fallbackSlug: params.fallbackSlug(turns),
      });
      const filename = `${dateStr}-${slug}.md`;
      const entry = params.renderContent({
        event,
        cfg,
        workspaceDir,
        memoryDir,
        sessionId,
        turns,
        now,
        dateStr,
        timeStr,
      });

      await writeFileWithinRoot({
        rootDir: memoryDir,
        relativePath: filename,
        data: entry,
        encoding: "utf-8",
      });

      params.logger.info(
        `${params.successMessage} saved to ${path.join(memoryDir, filename).replace(os.homedir(), "~")}`,
      );
    } catch (err) {
      if (err instanceof Error) {
        params.logger.error(params.failureMessage, {
          errorName: err.name,
          errorMessage: err.message,
          stack: err.stack,
        });
      } else {
        params.logger.error(params.failureMessage, { error: String(err) });
      }
    }
  };
}
