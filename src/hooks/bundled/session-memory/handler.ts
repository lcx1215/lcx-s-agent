/**
 * Session memory hook handler
 *
 * Saves session context to memory when /new or /reset command is triggered
 * Creates a new dated memory file with LLM-generated slug
 */

import os from "node:os";
import path from "node:path";
import { writeFileWithinRoot } from "../../../infra/fs-safe.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { resolveHookConfig } from "../../config.js";
import type { HookHandler } from "../../hooks.js";
import {
  formatSessionTurns,
  generateArtifactSlug,
  loadSessionTurnsWithResetFallback,
  resolveMemorySessionContext,
  type SessionTurn,
} from "../artifact-memory.js";

const log = createSubsystemLogger("hooks/session-memory");

/**
 * Save session context to memory when /new or /reset command is triggered
 */
const saveSessionToMemory: HookHandler = async (event) => {
  // Only trigger on reset/new commands
  const isResetCommand = event.action === "new" || event.action === "reset";
  if (event.type !== "command" || !isResetCommand) {
    return;
  }

  try {
    log.debug("Hook triggered for reset/new command", { action: event.action });

    const context = event.context || {};
    const {
      cfg,
      memoryDir,
      sessionEntry,
      sessionId: resolvedSessionId,
      sessionFile,
      displaySessionKey,
    } = await resolveMemorySessionContext({
      event,
      fallbackToLatestNonReset: true,
    });

    // Get today's date for filename
    const now = new Date(event.timestamp);
    const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD

    log.debug("Session context resolved", {
      sessionId: resolvedSessionId,
      sessionFile,
      hasCfg: Boolean(cfg),
    });

    // Read message count from hook config (default: 15)
    const hookConfig = resolveHookConfig(cfg, "session-memory");
    const messageCount =
      typeof hookConfig?.messages === "number" && hookConfig.messages > 0
        ? hookConfig.messages
        : 15;

    let sessionContent: string | null = null;
    let sessionTurns: SessionTurn[] = [];

    if (sessionFile) {
      // Get recent conversation content, with fallback to rotated reset transcript.
      sessionTurns = await loadSessionTurnsWithResetFallback(sessionFile, messageCount);
      sessionContent = sessionTurns.length > 0 ? formatSessionTurns(sessionTurns) : null;
      log.debug("Session content loaded", {
        length: sessionContent?.length ?? 0,
        messageCount,
      });
    }

    const timeSlug = now.toISOString().split("T")[1].split(".")[0].replace(/:/g, "").slice(0, 4);
    const allowLlmSlug = hookConfig?.llmSlug !== false;
    const slug =
      sessionContent && sessionFile
        ? await generateArtifactSlug({
            turns: sessionTurns,
            cfg: allowLlmSlug ? cfg : undefined,
            fallbackSlug: timeSlug,
          })
        : timeSlug;
    if (slug === timeSlug) {
      log.debug("Using fallback timestamp slug", { slug });
    } else {
      log.debug("Generated slug", { slug });
    }

    // Create filename with date and slug
    const filename = `${dateStr}-${slug}.md`;
    const memoryFilePath = path.join(memoryDir, filename);
    log.debug("Memory file path resolved", {
      filename,
      path: memoryFilePath.replace(os.homedir(), "~"),
    });

    // Format time as HH:MM:SS UTC
    const timeStr = now.toISOString().split("T")[1].split(".")[0];

    // Extract context details
    const sessionId = (sessionEntry.sessionId as string) || "unknown";
    const source = (context.commandSource as string) || "unknown";

    // Build Markdown entry
    const entryParts = [
      `# Session: ${dateStr} ${timeStr} UTC`,
      "",
      `- **Session Key**: ${displaySessionKey}`,
      `- **Session ID**: ${sessionId}`,
      `- **Source**: ${source}`,
      "",
    ];

    // Include conversation content if available
    if (sessionContent) {
      entryParts.push("## Conversation Summary", "", sessionContent, "");
    }

    const entry = entryParts.join("\n");

    // Write under memory root with alias-safe file validation.
    await writeFileWithinRoot({
      rootDir: memoryDir,
      relativePath: filename,
      data: entry,
      encoding: "utf-8",
    });
    log.debug("Memory file written successfully");

    // Log completion (but don't send user-visible confirmation - it's internal housekeeping)
    const relPath = memoryFilePath.replace(os.homedir(), "~");
    log.info(`Session context saved to ${relPath}`);
  } catch (err) {
    if (err instanceof Error) {
      log.error("Failed to save session memory", {
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
      });
    } else {
      log.error("Failed to save session memory", { error: String(err) });
    }
  }
};

export default saveSessionToMemory;
