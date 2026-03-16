import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import { createHookEvent } from "../../hooks.js";
import type { HookHandler } from "../../hooks.js";

vi.mock("../../llm-slug-generator.js", () => ({
  generateSlugViaLLM: vi.fn().mockResolvedValue("math-review"),
}));

let handler: HookHandler;
let suiteWorkspaceRoot = "";
let workspaceCaseCounter = 0;

async function createCaseWorkspace(prefix = "case"): Promise<string> {
  const dir = path.join(suiteWorkspaceRoot, `${prefix}-${workspaceCaseCounter}`);
  workspaceCaseCounter += 1;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-review-"));
});

afterAll(async () => {
  if (!suiteWorkspaceRoot) {
    return;
  }
  await fs.rm(suiteWorkspaceRoot, { recursive: true, force: true });
  suiteWorkspaceRoot = "";
  workspaceCaseCounter = 0;
});

function createMockSessionContent(entries: Array<{ role: string; content: string }>): string {
  return entries
    .map((entry) =>
      JSON.stringify({
        type: "message",
        message: {
          role: entry.role,
          content: entry.content,
        },
      }),
    )
    .join("\n");
}

function makeConfig(tempDir: string): OpenClawConfig {
  return {
    agents: { defaults: { workspace: tempDir } },
  } satisfies OpenClawConfig;
}

async function runResetWithSession(params: {
  sessionContent: string;
}): Promise<{ files: string[]; reviewContent: string }> {
  const tempDir = await createCaseWorkspace("workspace");
  const sessionsDir = path.join(tempDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionFile = await writeWorkspaceFile({
    dir: sessionsDir,
    name: "study-session.jsonl",
    content: params.sessionContent,
  });

  const event = createHookEvent("command", "reset", "agent:main:main", {
    cfg: makeConfig(tempDir),
    previousSessionEntry: {
      sessionId: "study-123",
      sessionFile,
    },
  });

  await handler(event);

  const memoryDir = path.join(tempDir, "memory");
  const files = await fs.readdir(memoryDir);
  const reviewFile = files.find((name) => name.includes("review")) ?? "";
  const reviewContent = reviewFile
    ? await fs.readFile(path.join(memoryDir, reviewFile), "utf-8")
    : "";
  return { files, reviewContent };
}

describe("learning-review hook", () => {
  it("writes a structured review note for math-heavy sessions", async () => {
    const sessionContent = createMockSessionContent([
      { role: "user", content: "请帮我证明这个矩阵为什么可对角化" },
      { role: "assistant", content: "先看特征值与线性无关的特征向量个数。" },
      { role: "user", content: "再帮我复盘一下我最容易错在哪里" },
      { role: "assistant", content: "你最容易跳过维度和特征结构检查。" },
    ]);

    const { files, reviewContent } = await runResetWithSession({ sessionContent });

    expect(files.some((name) => name.includes("review"))).toBe(true);
    expect(reviewContent).toContain("# Learning Review:");
    expect(reviewContent).toContain("**Topic**: linear-algebra");
    expect(reviewContent).toContain("mistake_pattern:");
    expect(reviewContent).toContain("core_principle:");
    expect(reviewContent).toContain("micro_drill:");
    expect(reviewContent).toContain("transfer_hint:");
    expect(reviewContent).toContain("请帮我证明这个矩阵为什么可对角化");
  });

  it("does nothing for non-study sessions", async () => {
    const sessionContent = createMockSessionContent([
      { role: "user", content: "帮我起个产品名" },
      { role: "assistant", content: "可以考虑更短、更容易记住的名字。" },
    ]);

    const { files } = await runResetWithSession({ sessionContent });

    expect(files.some((name) => name.includes("review"))).toBe(false);
  });
});
