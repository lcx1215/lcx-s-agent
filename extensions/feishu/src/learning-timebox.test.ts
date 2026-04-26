import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findRunningFeishuLearningTimeboxSession,
  findLatestFeishuLearningTimeboxSession,
  peekFeishuLearningTimeboxSession,
  reconcileFeishuLearningTimeboxesOnStartup,
  resetFeishuLearningTimeboxesForTest,
  startFeishuLearningTimeboxSession,
} from "./learning-timebox.js";

const { mockRunFeishuLearningCouncil, mockSendMessageFeishu, mockRecordOperationalAnomaly } =
  vi.hoisted(() => ({
    mockRunFeishuLearningCouncil: vi.fn(),
    mockSendMessageFeishu: vi.fn(),
    mockRecordOperationalAnomaly: vi.fn(),
  }));

vi.mock("./learning-council.js", () => ({
  runFeishuLearningCouncil: mockRunFeishuLearningCouncil,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: mockSendMessageFeishu,
}));

vi.mock("../../../src/infra/operational-anomalies.js", () => ({
  recordOperationalAnomaly: mockRecordOperationalAnomaly,
}));

const TEST_CFG = {} as ClawdbotConfig;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 1_500;
  const intervalMs = options?.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function readJson(relativePath: string, workspaceDir: string): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(workspaceDir, relativePath), "utf-8"));
}

async function readJsonLines(relativePath: string, workspaceDir: string): Promise<any[]> {
  const raw = await fs.readFile(path.join(workspaceDir, relativePath), "utf-8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("startFeishuLearningTimeboxSession", () => {
  beforeEach(() => {
    resetFeishuLearningTimeboxesForTest();
    mockRunFeishuLearningCouncil.mockReset();
    mockSendMessageFeishu.mockReset();
    mockRecordOperationalAnomaly.mockReset();
    mockSendMessageFeishu.mockResolvedValue({
      messageId: "om_timebox_done",
      chatId: "oc_learning",
    });
  });

  afterEach(() => {
    resetFeishuLearningTimeboxesForTest();
  });

  it("runs a bounded multi-iteration session and writes receipts until completion", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-timebox-"));
    mockRunFeishuLearningCouncil
      .mockResolvedValue("## Council consensus\n- 额外轮次仍然先看机制链再信回测。")
      .mockResolvedValueOnce("## Council consensus\n- 第二轮学到先看样本外验证。")
      .mockResolvedValueOnce("## Council consensus\n- 第三轮学到先看机制链再信回测。");

    const result = await startFeishuLearningTimeboxSession({
      cfg: TEST_CFG,
      accountId: "acct-default",
      chatId: "oc_learning",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:group:oc_learning",
      messageId: "om_initial",
      userMessage: "你去学习一个小时，学前沿论文里值得学习的策略和概念",
      workspaceDir,
      initialCouncilReply: "## Council consensus\n- 第一轮学到先看可重复性。",
      intervalMsOverride: 10,
      durationMsOverride: 90,
    });

    expect(result.status).toBe("started");
    if (result.status !== "started") {
      throw new Error("expected timebox to start");
    }

    await waitForCondition(
      async () => {
        const nextState = await readJson(
          `memory/feishu-learning-timeboxes/${result.sessionId}.json`,
          workspaceDir,
        );
        return nextState.status === "completed" && nextState.iterationsCompleted >= 2;
      },
      { timeoutMs: 3_000, intervalMs: 25 },
    );

    const state = await readJson(
      `memory/feishu-learning-timeboxes/${result.sessionId}.json`,
      workspaceDir,
    );
    const receipts = await readJsonLines(
      `memory/feishu-learning-timeboxes/${result.sessionId}.receipts.jsonl`,
      workspaceDir,
    );

    expect(state).toMatchObject({
      status: "completed",
      processBound: true,
      iterationsFailed: 0,
    });
    expect(state.iterationsCompleted).toBeGreaterThanOrEqual(2);
    expect(String(state.lastLead)).toContain("机制链");
    expect(receipts[0]?.type).toBe("session_started");
    expect(receipts.at(-1)?.type).toBe("session_finished");
    expect(
      receipts.filter((receipt) => receipt.type === "iteration_completed").length,
    ).toBeGreaterThanOrEqual(2);
    expect(mockRunFeishuLearningCouncil.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct-default",
        to: "chat:oc_learning",
        text: expect.stringContaining("限时学习已结束"),
      }),
    );
  });

  it("prevents duplicate sessions in the same chat lane", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-timebox-"));

    const started = await startFeishuLearningTimeboxSession({
      cfg: TEST_CFG,
      accountId: "acct-default",
      chatId: "oc_learning",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:group:oc_learning",
      messageId: "om_initial",
      userMessage: "你去学习一个小时，学前沿论文里值得学习的策略和概念",
      workspaceDir,
      initialCouncilReply: "## Council consensus\n- 第一轮学到先看可重复性。",
      intervalMsOverride: 50,
      durationMsOverride: 200,
    });

    expect(started.status).toBe("started");
    if (started.status !== "started") {
      throw new Error("expected first timebox to start");
    }

    const second = await startFeishuLearningTimeboxSession({
      cfg: TEST_CFG,
      accountId: "acct-default",
      chatId: "oc_learning",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:group:oc_learning",
      messageId: "om_second",
      userMessage: "你去学习一小时，继续学前沿论文",
      workspaceDir,
      initialCouncilReply: "## Council consensus\n- 第二次即时学习。",
      intervalMsOverride: 50,
      durationMsOverride: 200,
    });

    expect(second).toMatchObject({
      status: "already_running",
      sessionId: started.sessionId,
    });
    expect(mockRunFeishuLearningCouncil).not.toHaveBeenCalled();
    expect(mockSendMessageFeishu).not.toHaveBeenCalled();
  });

  it("recognizes colloquial external-source timebox durations", () => {
    expect(
      peekFeishuLearningTimeboxSession({
        accountId: "acct-default",
        chatId: "oc_learning",
        userMessage: "去 Google 上学半个小时，学 agent 记忆怎么做",
      }),
    ).toEqual({ status: "eligible" });
    expect(
      peekFeishuLearningTimeboxSession({
        accountId: "acct-default",
        chatId: "oc_learning",
        userMessage: "从网上找资料持续学30分钟，主题是 finance agent workflow",
      }),
    ).toEqual({ status: "eligible" });
  });

  it("fails closed when the workspace dir is unavailable", async () => {
    const result = await startFeishuLearningTimeboxSession({
      cfg: TEST_CFG,
      accountId: "acct-default",
      chatId: "oc_learning",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:group:oc_learning",
      messageId: "om_initial",
      userMessage: "你去学习一个小时，学前沿论文里值得学习的策略和概念",
      initialCouncilReply: "## Council consensus\n- 第一轮学到先看可重复性。",
    });

    expect(result).toEqual({
      status: "failed_to_start",
      durationLabel: "1小时",
      reason: "workspace_unavailable",
    });
    expect(mockRecordOperationalAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "write_edit_failure",
        source: "feishu.learning_command",
      }),
    );
  });

  it("treats overdue in-memory sessions as non-running and reports the latest snapshot as overdue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T12:00:00.000Z"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-timebox-"));

    const started = await startFeishuLearningTimeboxSession({
      cfg: TEST_CFG,
      accountId: "acct-default",
      chatId: "oc_learning",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:group:oc_learning",
      messageId: "om_initial",
      userMessage: "你去学习一个小时，学前沿论文里值得学习的策略和概念",
      workspaceDir,
      initialCouncilReply: "## Council consensus\n- 第一轮学到先看可重复性。",
      intervalMsOverride: 60_000,
      durationMsOverride: 60_000,
    });

    expect(started.status).toBe("started");
    vi.setSystemTime(new Date("2026-04-08T12:02:00.000Z"));

    expect(
      findRunningFeishuLearningTimeboxSession({
        accountId: "acct-default",
        chatId: "oc_learning",
      }),
    ).toBeUndefined();
    expect(
      peekFeishuLearningTimeboxSession({
        accountId: "acct-default",
        chatId: "oc_learning",
        userMessage: "你去学习一个小时，继续学前沿论文",
      }),
    ).toEqual({ status: "eligible" });

    const latest = await findLatestFeishuLearningTimeboxSession({
      workspaceDir,
      accountId: "acct-default",
      chatId: "oc_learning",
    });
    expect(latest).toMatchObject({
      sessionId: started.status === "started" ? started.sessionId : undefined,
      status: "overdue",
    });

    vi.useRealTimers();
  });

  it("allows a new timebox to start after an overdue in-memory session is pruned", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-08T12:00:00.000Z"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-timebox-"));

    const first = await startFeishuLearningTimeboxSession({
      cfg: TEST_CFG,
      accountId: "acct-default",
      chatId: "oc_learning",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:group:oc_learning",
      messageId: "om_initial",
      userMessage: "你去学习一个小时，学前沿论文里值得学习的策略和概念",
      workspaceDir,
      initialCouncilReply: "## Council consensus\n- 第一轮学到先看可重复性。",
      intervalMsOverride: 60_000,
      durationMsOverride: 60_000,
    });

    expect(first.status).toBe("started");
    vi.setSystemTime(new Date("2026-04-08T12:02:00.000Z"));

    const second = await startFeishuLearningTimeboxSession({
      cfg: TEST_CFG,
      accountId: "acct-default",
      chatId: "oc_learning",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:group:oc_learning",
      messageId: "om_second",
      userMessage: "你去学习一个小时，继续学前沿论文",
      workspaceDir,
      initialCouncilReply: "## Council consensus\n- 第二轮重新开始。",
      intervalMsOverride: 60_000,
      durationMsOverride: 60_000,
    });

    expect(second.status).toBe("started");
    if (first.status === "started" && second.status === "started") {
      expect(second.sessionId).not.toBe(first.sessionId);
    }

    vi.useRealTimers();
  });

  it("records repeated iteration failures and finishes early", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-timebox-"));
    mockRunFeishuLearningCouncil.mockRejectedValue(new Error("provider boom"));

    const result = await startFeishuLearningTimeboxSession({
      cfg: TEST_CFG,
      accountId: "acct-default",
      chatId: "oc_learning",
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:group:oc_learning",
      messageId: "om_initial",
      userMessage: "你去学习一个小时，学前沿论文里值得学习的策略和概念",
      workspaceDir,
      initialCouncilReply: "## Council consensus\n- 第一轮学到先看可重复性。",
      intervalMsOverride: 10,
      durationMsOverride: 100,
    });

    expect(result.status).toBe("started");
    if (result.status !== "started") {
      throw new Error("expected timebox to start");
    }

    await sleep(60);

    const state = await readJson(
      `memory/feishu-learning-timeboxes/${result.sessionId}.json`,
      workspaceDir,
    );
    const receipts = await readJsonLines(
      `memory/feishu-learning-timeboxes/${result.sessionId}.receipts.jsonl`,
      workspaceDir,
    );

    expect(state).toMatchObject({
      status: "failed",
      iterationsCompleted: 0,
      iterationsFailed: 2,
    });
    expect(receipts.map((receipt) => receipt.type)).toEqual([
      "session_started",
      "iteration_failed",
      "iteration_failed",
      "session_finished",
    ]);
    expect(mockRecordOperationalAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "learning_quality_drift",
        source: "feishu.learning_command",
      }),
    );
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("限时学习提前结束"),
      }),
    );
  });

  it("reads the latest persisted non-running session for the same chat lane", async () => {
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-learning-timebox-latest-"),
    );
    const dir = path.join(workspaceDir, "memory", "feishu-learning-timeboxes");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "2026-04-07T10-00-00.000Z__oc-learning.json"),
      `${JSON.stringify(
        {
          version: 1,
          sessionId: "2026-04-07T10-00-00.000Z__oc-learning",
          laneKey: "learning_command:default:oc-learning",
          processBound: true,
          status: "completed",
          userMessage: "你去学习一个小时，学前沿论文里值得学习的策略和概念",
          startedAt: "2026-04-07T10:00:00.000Z",
          deadlineAt: "2026-04-07T11:00:00.000Z",
          lastHeartbeatAt: "2026-04-07T10:50:00.000Z",
          requestedDurationMinutes: 60,
          intervalMs: 600000,
          initialMessageId: "msg-1",
          initialLead: "先看滚动验证和样本外结果，再信回测。",
          iterationsCompleted: 3,
          iterationsFailed: 1,
          lastLead: "先看滚动验证和样本外结果，再信回测。",
          accountId: "default",
          chatId: "oc-learning",
          routeAgentId: "main",
          sessionKey: "agent:main:feishu:dm:oc-learning:surface:learning_command",
          receiptsPath:
            "memory/feishu-learning-timeboxes/2026-04-07T10-00-00.000Z__oc-learning.receipts.jsonl",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const latest = await findLatestFeishuLearningTimeboxSession({
      workspaceDir,
      accountId: "default",
      chatId: "oc-learning",
    });

    expect(latest).toEqual({
      sessionId: "2026-04-07T10-00-00.000Z__oc-learning",
      status: "completed",
      deadlineAt: "2026-04-07T11:00:00.000Z",
      lastHeartbeatAt: "2026-04-07T10:50:00.000Z",
      iterationsCompleted: 3,
      iterationsFailed: 1,
      receiptsPath:
        "memory/feishu-learning-timeboxes/2026-04-07T10-00-00.000Z__oc-learning.receipts.jsonl",
    });

    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("scans all configured agent workspaces for the latest session in the same chat lane", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-timebox-multi-"));
    const workspaceA = path.join(rootDir, "agent-a");
    const workspaceB = path.join(rootDir, "agent-b");
    await fs.mkdir(path.join(workspaceA, "memory", "feishu-learning-timeboxes"), {
      recursive: true,
    });
    await fs.mkdir(path.join(workspaceB, "memory", "feishu-learning-timeboxes"), {
      recursive: true,
    });

    const writeState = async (
      workspaceDir: string,
      sessionId: string,
      startedAt: string,
      status: string,
    ) => {
      await fs.writeFile(
        path.join(workspaceDir, "memory", "feishu-learning-timeboxes", `${sessionId}.json`),
        `${JSON.stringify(
          {
            version: 1,
            sessionId,
            laneKey: "learning_command:default:oc-learning",
            processBound: true,
            status,
            userMessage: "你去学习一个小时，学前沿论文里值得学习的策略和概念",
            startedAt,
            deadlineAt: "2026-04-07T11:00:00.000Z",
            lastHeartbeatAt: "2026-04-07T10:50:00.000Z",
            requestedDurationMinutes: 60,
            intervalMs: 600000,
            initialMessageId: "msg-1",
            initialLead: "先看滚动验证和样本外结果，再信回测。",
            iterationsCompleted: 2,
            iterationsFailed: 0,
            lastLead: "先看滚动验证和样本外结果，再信回测。",
            accountId: "default",
            chatId: "oc-learning",
            routeAgentId: "main",
            sessionKey: "agent:main:feishu:dm:oc-learning:surface:learning_command",
            receiptsPath: `memory/feishu-learning-timeboxes/${sessionId}.receipts.jsonl`,
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
    };

    await writeState(
      workspaceA,
      "2026-04-07T10-00-00.000Z__oc-learning",
      "2026-04-07T10:00:00.000Z",
      "completed",
    );
    await writeState(
      workspaceB,
      "2026-04-07T10-30-00.000Z__oc-learning",
      "2026-04-07T10:30:00.000Z",
      "interrupted",
    );

    const latest = await findLatestFeishuLearningTimeboxSession({
      cfg: {
        agents: {
          defaults: { workspace: workspaceA },
          list: [
            { id: "main", workspace: workspaceA, default: true },
            { id: "research", workspace: workspaceB },
          ],
        },
      } as ClawdbotConfig,
      accountId: "default",
      chatId: "oc-learning",
    });

    expect(latest).toMatchObject({
      sessionId: "2026-04-07T10-30-00.000Z__oc-learning",
      status: "interrupted",
    });

    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("reconciles stale running sessions on startup and notifies the chat once", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-timebox-"));
    const sessionId = "2026-04-08T12-00-00.000Z__oc_learning";
    const relativeStatePath = `memory/feishu-learning-timeboxes/${sessionId}.json`;
    await fs.mkdir(path.join(workspaceDir, "memory", "feishu-learning-timeboxes"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspaceDir, relativeStatePath),
      `${JSON.stringify(
        {
          version: 1,
          sessionId,
          laneKey: "learning_command:acct-default:oc_learning",
          processBound: true,
          status: "running",
          userMessage: "你去学习一个小时，学前沿论文里值得学习的策略和概念",
          startedAt: "2026-04-08T12:00:00.000Z",
          deadlineAt: "2026-04-08T13:00:00.000Z",
          lastHeartbeatAt: "2026-04-08T12:20:00.000Z",
          requestedDurationMinutes: 60,
          intervalMs: 600000,
          initialMessageId: "om_initial",
          initialLead: "第一轮学到先看可重复性。",
          iterationsCompleted: 2,
          iterationsFailed: 0,
          lastLead: "第三轮学到先看机制链再信回测。",
          accountId: "acct-default",
          chatId: "oc_learning",
          routeAgentId: "main",
          sessionKey: "agent:main:feishu:group:oc_learning",
          receiptsPath: `memory/feishu-learning-timeboxes/${sessionId}.receipts.jsonl`,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const runtime = { log: vi.fn(), error: vi.fn() };
    const result = await reconcileFeishuLearningTimeboxesOnStartup({
      cfg: TEST_CFG,
      runtime,
      workspaceDir,
    });

    const state = await readJson(relativeStatePath, workspaceDir);
    const receipts = await readJsonLines(
      `memory/feishu-learning-timeboxes/${sessionId}.receipts.jsonl`,
      workspaceDir,
    );

    expect(result).toEqual({
      scanned: 1,
      resumed: 0,
      interrupted: 1,
      notified: 1,
    });
    expect(state).toMatchObject({
      status: "interrupted",
      iterationsCompleted: 2,
    });
    expect(receipts.at(-1)).toMatchObject({
      type: "session_interrupted",
      sessionId,
      reason: "startup_reconcile",
      previousHeartbeatAt: "2026-04-08T12:20:00.000Z",
    });
    expect(mockRecordOperationalAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "learning_quality_drift",
        source: "feishu.learning_command",
        problem: "startup interrupted a process-bound learning timebox",
      }),
    );
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc_learning",
        text: expect.stringContaining("上次限时学习已中断"),
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "feishu: reconciled learning timeboxes at startup (resumed=0, interrupted=1)",
    );
  });

  it("reconciles stale running sessions from non-default agent workspaces", async () => {
    const defaultWorkspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-learning-timebox-main-"),
    );
    const researchWorkspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-learning-timebox-research-"),
    );
    const cfg = {
      agents: {
        list: [
          { id: "main", default: true, workspace: defaultWorkspaceDir },
          { id: "research", workspace: researchWorkspaceDir },
        ],
      },
    } as unknown as ClawdbotConfig;
    const sessionId = "2026-04-08T13-00-00.000Z__oc_research";
    const relativeStatePath = `memory/feishu-learning-timeboxes/${sessionId}.json`;
    await fs.mkdir(path.join(researchWorkspaceDir, "memory", "feishu-learning-timeboxes"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(researchWorkspaceDir, relativeStatePath),
      `${JSON.stringify(
        {
          version: 1,
          sessionId,
          laneKey: "learning_command:acct-default:oc_research",
          processBound: true,
          status: "running",
          userMessage: "你去学习一个小时，学前沿论文里值得学习的策略和概念",
          startedAt: "2026-04-08T13:00:00.000Z",
          deadlineAt: "2026-04-08T14:00:00.000Z",
          lastHeartbeatAt: "2026-04-08T13:15:00.000Z",
          requestedDurationMinutes: 60,
          intervalMs: 600000,
          initialMessageId: "om_initial",
          initialLead: "第一轮学到先看可重复性。",
          iterationsCompleted: 1,
          iterationsFailed: 0,
          lastLead: "第二轮学到先看样本外验证。",
          accountId: "acct-default",
          chatId: "oc_research",
          routeAgentId: "research",
          sessionKey: "agent:research:feishu:group:oc_research",
          receiptsPath: `memory/feishu-learning-timeboxes/${sessionId}.receipts.jsonl`,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const result = await reconcileFeishuLearningTimeboxesOnStartup({
      cfg,
    });

    const state = await readJson(relativeStatePath, researchWorkspaceDir);
    const receipts = await readJsonLines(
      `memory/feishu-learning-timeboxes/${sessionId}.receipts.jsonl`,
      researchWorkspaceDir,
    );

    expect(result).toEqual({
      scanned: 1,
      resumed: 0,
      interrupted: 1,
      notified: 1,
    });
    expect(state.status).toBe("interrupted");
    expect(receipts.at(-1)).toMatchObject({
      type: "session_interrupted",
      sessionId,
      previousHeartbeatAt: "2026-04-08T13:15:00.000Z",
    });
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc_research",
        text: expect.stringContaining("上次限时学习已中断"),
      }),
    );
  });

  it("resumes still-valid running sessions on startup instead of interrupting them", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-learning-timebox-"));
    const sessionId = "2026-04-08T12-00-00.000Z__oc_learning";
    const relativeStatePath = `memory/feishu-learning-timeboxes/${sessionId}.json`;
    await fs.mkdir(path.join(workspaceDir, "memory", "feishu-learning-timeboxes"), {
      recursive: true,
    });
    const now = Date.now();
    await fs.writeFile(
      path.join(workspaceDir, relativeStatePath),
      `${JSON.stringify(
        {
          version: 1,
          sessionId,
          laneKey: "learning_command:acct-default:oc_learning",
          processBound: true,
          status: "running",
          userMessage: "你去学习一个小时，学前沿论文里值得学习的策略和概念",
          startedAt: new Date(now - 60_000).toISOString(),
          deadlineAt: new Date(now + 120_000).toISOString(),
          lastHeartbeatAt: new Date(now - 30_000).toISOString(),
          requestedDurationMinutes: 60,
          intervalMs: 10,
          initialMessageId: "om_initial",
          initialLead: "第一轮学到先看可重复性。",
          iterationsCompleted: 1,
          iterationsFailed: 0,
          lastLead: "第二轮学到先看样本外验证。",
          accountId: "acct-default",
          chatId: "oc_learning",
          routeAgentId: "main",
          sessionKey: "agent:main:feishu:group:oc_learning",
          receiptsPath: `memory/feishu-learning-timeboxes/${sessionId}.receipts.jsonl`,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    mockRunFeishuLearningCouncil.mockResolvedValue(
      "## Council consensus\n- 恢复后继续先看样本外验证。",
    );

    const runtime = { log: vi.fn(), error: vi.fn() };
    const result = await reconcileFeishuLearningTimeboxesOnStartup({
      cfg: TEST_CFG,
      runtime,
      workspaceDir,
    });

    await waitForCondition(
      async () => {
        const nextState = await readJson(relativeStatePath, workspaceDir);
        return nextState.iterationsCompleted >= 2;
      },
      { timeoutMs: 2_000, intervalMs: 20 },
    );

    const state = await readJson(relativeStatePath, workspaceDir);
    const receipts = await readJsonLines(
      `memory/feishu-learning-timeboxes/${sessionId}.receipts.jsonl`,
      workspaceDir,
    );

    expect(result).toEqual({
      scanned: 1,
      resumed: 1,
      interrupted: 0,
      notified: 1,
    });
    expect(state.status).toBe("running");
    expect(state.iterationsCompleted).toBeGreaterThanOrEqual(2);
    expect(receipts.some((receipt) => receipt.type === "session_resumed")).toBe(true);
    expect(receipts.some((receipt) => receipt.type === "session_interrupted")).toBe(false);
    expect(mockSendMessageFeishu).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc_learning",
        text: expect.stringContaining("上次限时学习已恢复"),
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "feishu: reconciled learning timeboxes at startup (resumed=1, interrupted=0)",
    );
  });
});
