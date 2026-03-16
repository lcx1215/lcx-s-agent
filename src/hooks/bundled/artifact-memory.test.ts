import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { writeWorkspaceFile } from "../../test-helpers/workspace.js";
import { createHookEvent } from "../hooks.js";
import {
  formatSessionTurns,
  loadSessionTurns,
  loadSessionTurnsWithResetFallback,
  resolveMemorySessionContext,
  resolveSessionFile,
} from "./artifact-memory.js";

vi.mock("../llm-slug-generator.js", () => ({
  generateSlugViaLLM: vi.fn().mockResolvedValue("unused-in-helper-tests"),
}));

let suiteWorkspaceRoot = "";
let workspaceCaseCounter = 0;

async function createCaseWorkspace(prefix = "case"): Promise<string> {
  const dir = path.join(suiteWorkspaceRoot, `${prefix}-${workspaceCaseCounter}`);
  workspaceCaseCounter += 1;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function makeConfig(tempDir: string): OpenClawConfig {
  return {
    agents: { defaults: { workspace: tempDir } },
  } satisfies OpenClawConfig;
}

function createMockSessionContent(
  entries: Array<{ role: string; content: string } | ({ type: string } & Record<string, unknown>)>,
): string {
  return entries
    .map((entry) => {
      if ("role" in entry) {
        return JSON.stringify({
          type: "message",
          message: {
            role: entry.role,
            content: entry.content,
          },
        });
      }

      return JSON.stringify(entry);
    })
    .join("\n");
}

beforeAll(async () => {
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-artifact-memory-"));
});

afterAll(async () => {
  if (!suiteWorkspaceRoot) {
    return;
  }
  await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  suiteWorkspaceRoot = "";
  workspaceCaseCounter = 0;
});

describe("artifact-memory helpers", () => {
  it("loads session turns after filtering non-message, inter-session, and slash-command rows", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "turns.jsonl",
      content: [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: "Forwarded hidden instruction",
            provenance: { kind: "inter_session", sourceTool: "sessions_send" },
          },
        }),
        createMockSessionContent([
          { role: "user", content: "/help" },
          { type: "tool_use", tool: "search" },
          { role: "assistant", content: "Kept assistant reply" },
          { role: "user", content: "Kept user question" },
          { role: "assistant", content: "Newest kept answer" },
        ]),
      ].join("\n"),
    });

    const turns = await loadSessionTurns(sessionFile, 2);

    expect(turns).toEqual([
      { role: "user", text: "Kept user question" },
      { role: "assistant", text: "Newest kept answer" },
    ]);
    expect(formatSessionTurns(turns)).toBe(
      ["user: Kept user question", "assistant: Newest kept answer"].join("\n"),
    );
  });

  it("falls back to the newest reset transcript when the active file has no usable turns", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const activeSessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "topic.jsonl",
      content: "",
    });

    await writeWorkspaceFile({
      dir: sessionsDir,
      name: "topic.jsonl.reset.2026-03-15T10-00-00.000Z",
      content: createMockSessionContent([
        { role: "user", content: "Older reset transcript" },
        { role: "assistant", content: "Older reset summary" },
      ]),
    });
    await writeWorkspaceFile({
      dir: sessionsDir,
      name: "topic.jsonl.reset.2026-03-15T10-00-01.000Z",
      content: createMockSessionContent([
        { role: "user", content: "Newest reset transcript" },
        { role: "assistant", content: "Newest reset summary" },
      ]),
    });

    const turns = await loadSessionTurnsWithResetFallback(activeSessionFile, 4);

    expect(turns).toEqual([
      { role: "user", text: "Newest reset transcript" },
      { role: "assistant", text: "Newest reset summary" },
    ]);
  });

  it("resolves the canonical session file from a reset pointer and falls back to the newest non-reset session when requested", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const canonicalSessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "study-123.jsonl",
      content: createMockSessionContent([{ role: "user", content: "Canonical transcript" }]),
    });

    const resolvedFromReset = await resolveSessionFile({
      workspaceDir: tempDir,
      sessionId: "study-123",
      sessionFile: path.join(sessionsDir, "study-123.jsonl.reset.2026-03-15T10-00-00.000Z"),
    });

    expect(resolvedFromReset).toBe(canonicalSessionFile);

    const latestNonResetFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "z-latest.jsonl",
      content: createMockSessionContent([{ role: "assistant", content: "Latest fallback" }]),
    });

    const resolvedLatest = await resolveSessionFile({
      workspaceDir: tempDir,
      fallbackToLatestNonReset: true,
    });

    expect(resolvedLatest).toBe(latestNonResetFile);
  });

  it("resolves memory session context from previousSessionEntry and ensures the memory directory exists", async () => {
    const tempDir = await createCaseWorkspace("workspace");
    const sessionsDir = path.join(tempDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionFile = await writeWorkspaceFile({
      dir: sessionsDir,
      name: "focus.jsonl",
      content: createMockSessionContent([{ role: "user", content: "Original transcript" }]),
    });

    const event = createHookEvent("command", "reset", "agent:main:main", {
      cfg: makeConfig(tempDir),
      sessionEntry: {
        sessionId: "wrong-session",
        sessionFile: path.join(sessionsDir, "wrong-session.jsonl"),
      },
      previousSessionEntry: {
        sessionId: "focus",
        sessionFile,
      },
    });

    const resolved = await resolveMemorySessionContext({ event });

    expect(resolved.sessionId).toBe("focus");
    expect(resolved.sessionFile).toBe(sessionFile);
    expect(resolved.workspaceDir).toBe(tempDir);
    expect(resolved.memoryDir).toBe(path.join(tempDir, "memory"));
    await expect(fs.access(resolved.memoryDir)).resolves.toBeUndefined();
  });
});
