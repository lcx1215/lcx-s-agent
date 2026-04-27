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
    expect(reviewContent).toContain("## Lobster Transfer");
    expect(reviewContent).toContain("foundation_template: risk-transmission");
    expect(reviewContent).toContain("请帮我证明这个矩阵为什么可对角化");
  });

  it("classifies volatility-heavy study sessions as time-series-and-volatility", async () => {
    const sessionContent = createMockSessionContent([
      { role: "user", content: "帮我复盘一下 GARCH 和 LSTM 波动率预测最容易错在哪里" },
      { role: "assistant", content: "先分清状态变量、观测量和样本外验证，再看拟合效果。" },
    ]);

    const { reviewContent } = await runResetWithSession({ sessionContent });

    expect(reviewContent).toContain("**Topic**: time-series-and-volatility");
    expect(reviewContent).toContain("foundation_template: risk-transmission");
  });

  it("classifies coding sessions as coding-and-systems", async () => {
    const sessionContent = createMockSessionContent([
      { role: "user", content: "帮我复盘一下这段 Python 代码的 shared state 和 debug 路径" },
      { role: "assistant", content: "先确认 failure mode、状态流和 proof test，再收最小补丁。" },
    ]);

    const { reviewContent } = await runResetWithSession({ sessionContent });

    expect(reviewContent).toContain("**Topic**: coding-and-systems");
    expect(reviewContent).toContain("foundation_template: execution-hygiene");
  });

  it("classifies paper reading and strategy audit study into durable learning topics", async () => {
    const sessionContent = createMockSessionContent([
      {
        role: "user",
        content:
          "帮我学习这篇论文和这个回测，重点看 OOS、walk-forward、过拟合，还有最值得迁移的方法。",
      },
      {
        role: "assistant",
        content: "先抓问题定义、评估协议、样本外检验和参数脆弱性，再谈策略是否可信。",
      },
    ]);

    const { reviewContent } = await runResetWithSession({ sessionContent });

    expect(reviewContent).toContain("**Topic**: paper-and-method-reading");
    expect(reviewContent).toContain("foundation_template: outcome-review");
  });

  it("classifies github and agent architecture study as architecture learning", async () => {
    const sessionContent = createMockSessionContent([
      {
        role: "user",
        content:
          "帮我学习这个 GitHub repo 和 AI 智能体架构，重点看 system design、workflow、shared state 和失败路径。",
      },
      {
        role: "assistant",
        content: "先写输入、状态、失败、验收四栏，再决定这套架构值不值得迁移。",
      },
    ]);

    const { reviewContent } = await runResetWithSession({ sessionContent });

    expect(reviewContent).toContain("**Topic**: agent-architecture-and-workflows");
    expect(reviewContent).toContain("foundation_template: execution-hygiene");
  });

  it("classifies earnings and macro study as fundamental or market-structure learning", async () => {
    const sessionContent = createMockSessionContent([
      {
        role: "user",
        content:
          "帮我学习这个财报和当前 market regime，重点抓业务驱动、风险、宏观传导和证伪条件。",
      },
      {
        role: "assistant",
        content: "先拆业务驱动和风险，再分清当前 regime 和主传导链。",
      },
    ]);

    const { reviewContent } = await runResetWithSession({ sessionContent });

    expect(
      reviewContent.includes("**Topic**: fundamental-reading-and-risk") ||
        reviewContent.includes("**Topic**: macro-and-market-structure"),
    ).toBe(true);
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
