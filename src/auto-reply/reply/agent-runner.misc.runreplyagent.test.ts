import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore, saveSessionStore } from "../../config/sessions.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import type { TemplateContext } from "../templating.js";
import type { GetReplyOptions } from "../types.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();
const runCliAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const runtimeErrorMock = vi.fn();
const runtimeLogMock = vi.fn();

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => runWithModelFallbackMock(params),
}));

vi.mock("../../agents/pi-embedded.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/pi-embedded.js")>(
    "../../agents/pi-embedded.js",
  );
  return {
    ...actual,
    queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
    runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
  };
});

vi.mock("../../agents/cli-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/cli-runner.js")>(
    "../../agents/cli-runner.js",
  );
  return {
    ...actual,
    runCliAgent: (params: unknown) => runCliAgentMock(params),
  };
});

vi.mock("../../runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../../runtime.js")>("../../runtime.js");
  return {
    ...actual,
    defaultRuntime: {
      ...actual.defaultRuntime,
      log: (...args: unknown[]) => runtimeLogMock(...args),
      error: (...args: unknown[]) => runtimeErrorMock(...args),
      exit: vi.fn(),
    },
  };
});

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: vi.fn(),
    scheduleFollowupDrain: vi.fn(),
  };
});

const loadCronStoreMock = vi.fn();
vi.mock("../../cron/store.js", async () => {
  const actual = await vi.importActual<typeof import("../../cron/store.js")>("../../cron/store.js");
  return {
    ...actual,
    loadCronStore: (...args: unknown[]) => loadCronStoreMock(...args),
  };
});

import { runReplyAgent } from "./agent-runner.js";

type RunWithModelFallbackParams = {
  provider: string;
  model: string;
  run: (provider: string, model: string) => Promise<unknown>;
};

beforeEach(() => {
  runEmbeddedPiAgentMock.mockClear();
  runCliAgentMock.mockClear();
  runWithModelFallbackMock.mockClear();
  runtimeErrorMock.mockClear();
  runtimeLogMock.mockClear();
  loadCronStoreMock.mockClear();
  // Default: no cron jobs in store.
  loadCronStoreMock.mockResolvedValue({ version: 1, jobs: [] });
  resetSystemEventsForTest();

  // Default: no provider switch; execute the chosen provider+model.
  runWithModelFallbackMock.mockImplementation(
    async ({ provider, model, run }: RunWithModelFallbackParams) => ({
      result: await run(provider, model),
      provider,
      model,
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  resetSystemEventsForTest();
});

describe("runReplyAgent onAgentRunStart", () => {
  function createRun(params?: {
    provider?: string;
    model?: string;
    ask?: string;
    extraSystemPrompt?: string;
    opts?: GetReplyOptions;
  }) {
    const provider = params?.provider ?? "anthropic";
    const model = params?.model ?? "claude";
    const ask = params?.ask ?? "hello";
    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "webchat",
      OriginatingTo: "session:1",
      AccountId: "primary",
      MessageSid: "msg",
      ...(params?.ask !== undefined ? { CommandBody: ask } : {}),
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      prompt: ask,
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      ...(params?.ask !== undefined ? { commercialAuditAsk: ask, messageId: "msg" } : {}),
      run: {
        sessionId: "session",
        sessionKey: "main",
        messageProvider: "webchat",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        skillsSnapshot: {},
        provider,
        model,
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
        ...(params?.extraSystemPrompt !== undefined
          ? { extraSystemPrompt: params.extraSystemPrompt }
          : {}),
      },
    } as unknown as FollowupRun;

    return runReplyAgent({
      commandBody: ask,
      followupRun,
      queueKey: "main",
      resolvedQueue,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      opts: params?.opts,
      typing,
      sessionCtx,
      defaultModel: `${provider}/${model}`,
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });
  }

  it.each(["anthropic", "claude-cli"] as const)(
    "commercial planning advisory reaches the actual %s model callback before generation",
    async (provider) => {
      const ask = "当前 QQQ 的价格和数据来源有哪些缺口？";
      const model = provider === "claude-cli" ? "opus-4.5" : "claude";
      const target = provider === "claude-cli" ? runCliAgentMock : runEmbeddedPiAgentMock;
      target.mockResolvedValueOnce({ payloads: [], meta: {} });
      await createRun({
        provider,
        model,
        ask,
        extraSystemPrompt: "existing host instruction",
        opts: {
          runId: "planning-main-run",
          commercialAnswerAudit: {
            messageId: "msg",
            askSha256: crypto.createHash("sha256").update(ask).digest("hex"),
            input: { calculations: [] },
          },
        },
      });
      expect(target).toHaveBeenCalledTimes(1);
      const input = target.mock.calls[0][0] as {
        prompt: string;
        extraSystemPrompt: string;
        runId: string;
      };
      expect(input.prompt).toBe(ask);
      expect(input.runId).toBe("planning-main-run");
      expect(input.extraSystemPrompt).toContain(
        "existing host instruction\n\nLCX predecision advisory",
      );
      expect(input.extraSystemPrompt).toContain("finance_data_gateway");
      if (process.env.LCX_COMMERCIAL_PLANNING_PROOF_DIR) {
        await fs.mkdir(process.env.LCX_COMMERCIAL_PLANNING_PROOF_DIR, { recursive: true });
        await fs.writeFile(
          path.join(process.env.LCX_COMMERCIAL_PLANNING_PROOF_DIR, `main-${provider}.json`),
          JSON.stringify(
            {
              boundary:
                "actual_original_main_model_callback_with_model_transport_mock_no_semantic_adoption",
              input,
            },
            null,
            2,
          ) + "\n",
        );
      }
    },
  );
  it("commercial planning advisory leaves the actual legacy callback prompt unchanged", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({ payloads: [], meta: {} });
    await createRun({ extraSystemPrompt: "unchanged host prompt" });
    expect(runEmbeddedPiAgentMock.mock.calls[0][0].extraSystemPrompt).toBe("unchanged host prompt");
  });

  it("does not emit start callback when fallback fails before run start", async () => {
    runWithModelFallbackMock.mockRejectedValueOnce(
      new Error('No API key found for provider "anthropic".'),
    );
    const onAgentRunStart = vi.fn();

    const result = await createRun({
      opts: { runId: "run-no-start", onAgentRunStart },
    });

    expect(onAgentRunStart).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      text: expect.stringContaining("Agent failed before reply"),
      isError: true,
      replyToId: "msg",
    });
  });

  it("emits start callback when cli runner starts", async () => {
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          provider: "claude-cli",
          model: "opus-4.5",
        },
      },
    });
    const onAgentRunStart = vi.fn();

    const result = await createRun({
      provider: "claude-cli",
      model: "opus-4.5",
      opts: { runId: "run-started", onAgentRunStart },
    });

    expect(onAgentRunStart).toHaveBeenCalledTimes(1);
    expect(onAgentRunStart).toHaveBeenCalledWith("run-started");
    expect(result).toMatchObject({ text: "ok" });
  });
});

describe("runReplyAgent reply tracing", () => {
  it("logs the selected model, active model, web search usage, and fallback state", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(async (params: Record<string, unknown>) => {
      await (
        params.onAgentEvent as
          | ((evt: { stream: string; data: Record<string, unknown> }) => Promise<void>)
          | undefined
      )?.({
        stream: "tool",
        data: { phase: "start", name: "web_search" },
      });
      return {
        payloads: [{ text: "ok" }],
        meta: {
          agentMeta: {
            provider: "custom-api-deepseek-com",
            model: "deepseek-chat",
          },
        },
      };
    });

    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "external",
      OriginatingTo: "chat:1",
      AccountId: "default",
      MessageSid: "msg",
    } as unknown as TemplateContext;
    const followupRun = {
      prompt: "macro",
      summaryLine: "macro",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session",
        sessionKey: "main",
        messageProvider: "external",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {
          tools: { web: { search: { provider: "kimi" } } },
        },
        skillsSnapshot: {},
        provider: "custom-api-deepseek-com",
        model: "deepseek-chat",
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;

    const result = await runReplyAgent({
      commandBody: "macro",
      followupRun,
      queueKey: "main",
      resolvedQueue: { mode: "interrupt" } as unknown as QueueSettings,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      typing,
      sessionCtx,
      defaultModel: "custom-api-deepseek-com/deepseek-chat",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    expect(result).toMatchObject({ text: "ok" });
    expect(runtimeLogMock).toHaveBeenCalledWith(expect.stringContaining("[reply-trace]"));
    expect(runtimeLogMock).toHaveBeenCalledWith(
      expect.stringContaining("active=custom-api-deepseek-com/deepseek-chat"),
    );
    expect(runtimeLogMock).toHaveBeenCalledWith(expect.stringContaining("web_search=kimi"));
    expect(runtimeLogMock).toHaveBeenCalledWith(expect.stringContaining("fallback=no"));
  });
});

describe("runReplyAgent authProfileId fallback scoping", () => {
  it("drops authProfileId when provider changes during fallback", async () => {
    runWithModelFallbackMock.mockImplementationOnce(
      async ({ run }: RunWithModelFallbackParams) => ({
        result: await run("openai-codex", "gpt-5.2"),
        provider: "openai-codex",
        model: "gpt-5.2",
      }),
    );

    runEmbeddedPiAgentMock.mockResolvedValue({ payloads: [{ text: "ok" }], meta: {} });

    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "telegram",
      OriginatingTo: "chat",
      AccountId: "primary",
      MessageSid: "msg",
      Surface: "telegram",
    } as unknown as TemplateContext;

    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: "/tmp/agent",
        sessionId: "session",
        sessionKey: "main",
        messageProvider: "telegram",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude-opus",
        authProfileId: "anthropic:openclaw",
        authProfileIdSource: "manual",
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        timeoutMs: 5_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;

    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 1,
      compactionCount: 0,
    };

    await runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: sessionKey,
      resolvedQueue,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      typing,
      sessionCtx,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath: undefined,
      defaultModel: "anthropic/claude-opus-4-5",
      agentCfgContextTokens: 100_000,
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as {
      authProfileId?: unknown;
      authProfileIdSource?: unknown;
      provider?: unknown;
    };

    expect(call.provider).toBe("openai-codex");
    expect(call.authProfileId).toBeUndefined();
    expect(call.authProfileIdSource).toBeUndefined();
  });
});

describe("runReplyAgent auto-compaction token update", () => {
  type EmbeddedRunParams = {
    prompt?: string;
    extraSystemPrompt?: string;
    onAgentEvent?: (evt: {
      stream?: string;
      data?: { phase?: string; willRetry?: boolean };
    }) => void;
  };

  async function seedSessionStore(params: {
    storePath: string;
    sessionKey: string;
    entry: Record<string, unknown>;
  }) {
    await fs.mkdir(path.dirname(params.storePath), { recursive: true });
    await fs.writeFile(
      params.storePath,
      JSON.stringify({ [params.sessionKey]: params.entry }, null, 2),
      "utf-8",
    );
  }

  function createBaseRun(params: {
    storePath: string;
    sessionEntry: Record<string, unknown>;
    config?: Record<string, unknown>;
    sessionFile?: string;
    workspaceDir?: string;
  }) {
    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "whatsapp",
      OriginatingTo: "+15550001111",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: "/tmp/agent",
        sessionId: "session",
        sessionKey: "main",
        messageProvider: "whatsapp",
        sessionFile: params.sessionFile ?? "/tmp/session.jsonl",
        workspaceDir: params.workspaceDir ?? "/tmp",
        config: params.config ?? {},
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude",
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;
    return { typing, sessionCtx, resolvedQueue, followupRun };
  }

  it("updates totalTokens after auto-compaction using lastCallUsage", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compact-tokens-"));
    const storePath = path.join(tmp, "sessions.json");
    await fs.writeFile(
      path.join(tmp, "AGENTS.md"),
      "## Session Startup\nRead the scoped fixture instructions.\n",
    );
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 181_000,
      compactionCount: 0,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedRunParams) => {
      // Simulate auto-compaction during agent run
      params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      params.onAgentEvent?.({ stream: "compaction", data: { phase: "end", willRetry: false } });
      return {
        payloads: [{ text: "done" }],
        meta: {
          agentMeta: {
            // Accumulated usage across pre+post compaction calls — inflated
            usage: { input: 190_000, output: 8_000, total: 198_000 },
            // Last individual API call's usage — actual post-compaction context
            lastCallUsage: { input: 10_000, output: 3_000, total: 13_000 },
            compactionCount: 1,
          },
        },
      };
    });

    // Disable memory flush so we isolate the auto-compaction path
    const config = {
      agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } },
    };
    const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
      storePath,
      sessionEntry,
      config,
      workspaceDir: tmp,
    });

    await runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      typing,
      sessionCtx,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath,
      defaultModel: "anthropic/claude-opus-4-5",
      agentCfgContextTokens: 200_000,
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    // totalTokens should reflect actual post-compaction context (~10k), not
    // the stale pre-compaction value (181k) or the inflated accumulated (190k)
    expect(stored[sessionKey].totalTokens).toBe(10_000);
    // compactionCount should be incremented
    expect(stored[sessionKey].compactionCount).toBe(1);
    await vi.waitFor(() => {
      expect(peekSystemEvents(sessionKey).join("\n")).toContain("scoped fixture instructions");
    });
  });

  it("updates totalTokens from lastCallUsage even without compaction", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-last-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 50_000,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          // Tool-use loop: accumulated input is higher than last call's input
          usage: { input: 75_000, output: 5_000, total: 80_000 },
          lastCallUsage: { input: 55_000, output: 2_000, total: 57_000 },
        },
      },
    });

    const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
      storePath,
      sessionEntry,
    });

    await runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      typing,
      sessionCtx,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath,
      defaultModel: "anthropic/claude-opus-4-5",
      agentCfgContextTokens: 200_000,
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8"));
    // totalTokens should use lastCallUsage (55k), not accumulated (75k)
    expect(stored[sessionKey].totalTokens).toBe(55_000);
  });

  it("does not enqueue legacy post-compaction audit warnings", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-no-audit-warning-"));
    const workspaceDir = path.join(tmp, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const sessionFile = path.join(tmp, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ type: "message", message: { role: "assistant", content: [] } })}\n`,
      "utf-8",
    );

    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      totalTokens: 10_000,
      compactionCount: 0,
    };

    await seedSessionStore({ storePath, sessionKey, entry: sessionEntry });

    runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedRunParams) => {
      params.onAgentEvent?.({ stream: "compaction", data: { phase: "start" } });
      params.onAgentEvent?.({ stream: "compaction", data: { phase: "end", willRetry: false } });
      return {
        payloads: [{ text: "done" }],
        meta: {
          agentMeta: {
            usage: { input: 11_000, output: 500, total: 11_500 },
            lastCallUsage: { input: 10_500, output: 500, total: 11_000 },
            compactionCount: 1,
          },
        },
      };
    });

    const config = {
      agents: { defaults: { compaction: { memoryFlush: { enabled: false } } } },
    };
    const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
      storePath,
      sessionEntry,
      config,
      sessionFile,
      workspaceDir,
    });

    await runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      typing,
      sessionCtx,
      sessionEntry,
      sessionStore: { [sessionKey]: sessionEntry },
      sessionKey,
      storePath,
      defaultModel: "anthropic/claude-opus-4-5",
      agentCfgContextTokens: 200_000,
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    await vi.waitFor(() => {
      expect(runtimeLogMock).toHaveBeenCalledWith(
        expect.stringContaining("Post-compaction workspace context unavailable"),
      );
    });
    const queuedSystemEvents = peekSystemEvents(sessionKey);
    expect(queuedSystemEvents.some((event) => event.includes("Post-Compaction Audit"))).toBe(false);
    expect(queuedSystemEvents.some((event) => event.includes("WORKFLOW_AUTO.md"))).toBe(false);
  });
});

describe("runReplyAgent block streaming", () => {
  it("coalesces duplicate text_end block replies", async () => {
    const onBlockReply = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(async (params) => {
      const block = params.onBlockReply as ((payload: { text?: string }) => void) | undefined;
      block?.({ text: "Hello" });
      block?.({ text: "Hello" });
      return {
        payloads: [{ text: "Final message" }],
        meta: {},
      };
    });

    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "discord",
      OriginatingTo: "channel:C1",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session",
        sessionKey: "main",
        messageProvider: "discord",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {
          agents: {
            defaults: {
              blockStreamingCoalesce: {
                minChars: 1,
                maxChars: 200,
                idleMs: 0,
              },
            },
          },
        },
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude",
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        timeoutMs: 1_000,
        blockReplyBreak: "text_end",
      },
    } as unknown as FollowupRun;

    const result = await runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      opts: { onBlockReply },
      typing,
      sessionCtx,
      defaultModel: "anthropic/claude-opus-4-5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: true,
      blockReplyChunking: {
        minChars: 1,
        maxChars: 200,
        breakPreference: "paragraph",
      },
      resolvedBlockStreamingBreak: "text_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0][0].text).toBe("Hello");
    expect(result).toBeUndefined();
  });

  it("returns the final payload when onBlockReply times out", async () => {
    vi.useFakeTimers();
    let sawAbort = false;

    const onBlockReply = vi.fn((_payload, context) => {
      return new Promise<void>((resolve) => {
        context?.abortSignal?.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            resolve();
          },
          { once: true },
        );
      });
    });

    runEmbeddedPiAgentMock.mockImplementationOnce(async (params) => {
      const block = params.onBlockReply as ((payload: { text?: string }) => void) | undefined;
      block?.({ text: "Chunk" });
      return {
        payloads: [{ text: "Final message" }],
        meta: {},
      };
    });

    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "discord",
      OriginatingTo: "channel:C1",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session",
        sessionKey: "main",
        messageProvider: "discord",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {
          agents: {
            defaults: {
              blockStreamingCoalesce: {
                minChars: 1,
                maxChars: 200,
                idleMs: 0,
              },
            },
          },
        },
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude",
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        timeoutMs: 1_000,
        blockReplyBreak: "text_end",
      },
    } as unknown as FollowupRun;

    const resultPromise = runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      opts: { onBlockReply, blockReplyTimeoutMs: 1 },
      typing,
      sessionCtx,
      defaultModel: "anthropic/claude-opus-4-5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: true,
      blockReplyChunking: {
        minChars: 1,
        maxChars: 200,
        breakPreference: "paragraph",
      },
      resolvedBlockStreamingBreak: "text_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    await vi.advanceTimersByTimeAsync(5);
    const result = await resultPromise;

    expect(sawAbort).toBe(true);
    expect(result).toMatchObject({ text: "Final message" });
  });
});

describe("runReplyAgent claude-cli routing", () => {
  function createRun() {
    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "webchat",
      OriginatingTo: "session:1",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session",
        sessionKey: "main",
        messageProvider: "webchat",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        skillsSnapshot: {},
        provider: "claude-cli",
        model: "opus-4.5",
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;

    return runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      typing,
      sessionCtx,
      defaultModel: "claude-cli/opus-4.5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });
  }

  it("uses claude-cli runner for claude-cli provider", async () => {
    const runId = "00000000-0000-0000-0000-000000000001";
    const randomSpy = vi.spyOn(crypto, "randomUUID").mockReturnValue(runId);
    const lifecyclePhases: string[] = [];
    const unsubscribe = onAgentEvent((evt) => {
      if (evt.runId !== runId) {
        return;
      }
      if (evt.stream !== "lifecycle") {
        return;
      }
      const phase = evt.data?.phase;
      if (typeof phase === "string") {
        lifecyclePhases.push(phase);
      }
    });
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          provider: "claude-cli",
          model: "opus-4.5",
        },
      },
    });

    const result = await createRun();
    unsubscribe();
    randomSpy.mockRestore();

    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(lifecyclePhases).toEqual(["start", "end"]);
    expect(result).toMatchObject({ text: "ok" });
  });
});

describe("runReplyAgent messaging tool suppression", () => {
  function createRun(
    messageProvider = "slack",
    opts: { storePath?: string; sessionKey?: string } = {},
  ) {
    const typing = createMockTypingController();
    const sessionKey = opts.sessionKey ?? "main";
    const sessionCtx = {
      Provider: messageProvider,
      OriginatingTo: "channel:C1",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session",
        sessionKey,
        messageProvider,
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude",
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;

    return runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      typing,
      sessionCtx,
      sessionKey,
      storePath: opts.storePath,
      defaultModel: "anthropic/claude-opus-4-5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });
  }

  it("drops replies when a messaging tool sent via the same provider + target", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      meta: {},
    });

    const result = await createRun("slack");

    expect(result).toBeUndefined();
  });

  it("delivers replies when tool provider does not match", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "discord", provider: "discord", to: "channel:C1" }],
      meta: {},
    });

    const result = await createRun("slack");

    expect(result).toMatchObject({ text: "hello world!" });
  });

  it("keeps final reply when text matches a cross-target messaging send", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentTargets: [{ tool: "discord", provider: "discord", to: "channel:C1" }],
      meta: {},
    });

    const result = await createRun("slack");

    expect(result).toMatchObject({ text: "hello world!" });
  });

  it("delivers replies when account ids do not match", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [
        {
          tool: "slack",
          provider: "slack",
          to: "channel:C1",
          accountId: "alt",
        },
      ],
      meta: {},
    });

    const result = await createRun("slack");

    expect(result).toMatchObject({ text: "hello world!" });
  });

  it("persists usage fields even when replies are suppressed", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-")),
      "sessions.json",
    );
    const sessionKey = "main";
    const entry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    await saveSessionStore(storePath, { [sessionKey]: entry });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      meta: {
        agentMeta: {
          usage: { input: 10, output: 5 },
          model: "claude-opus-4-5",
          provider: "anthropic",
        },
      },
    });

    const result = await createRun("slack", { storePath, sessionKey });

    expect(result).toBeUndefined();
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[sessionKey]?.inputTokens).toBe(10);
    expect(store[sessionKey]?.outputTokens).toBe(5);
    expect(store[sessionKey]?.totalTokens).toBeUndefined();
    expect(store[sessionKey]?.totalTokensFresh).toBe(false);
    expect(store[sessionKey]?.model).toBe("claude-opus-4-5");
  });

  it("persists totalTokens from promptTokens when snapshot is available", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-")),
      "sessions.json",
    );
    const sessionKey = "main";
    const entry: SessionEntry = { sessionId: "session", updatedAt: Date.now() };
    await saveSessionStore(storePath, { [sessionKey]: entry });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      meta: {
        agentMeta: {
          usage: { input: 10, output: 5 },
          promptTokens: 42_000,
          model: "claude-opus-4-5",
          provider: "anthropic",
        },
      },
    });

    const result = await createRun("slack", { storePath, sessionKey });

    expect(result).toBeUndefined();
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[sessionKey]?.totalTokens).toBe(42_000);
    expect(store[sessionKey]?.totalTokensFresh).toBe(true);
    expect(store[sessionKey]?.model).toBe("claude-opus-4-5");
  });

  it("persists totalTokens from promptTokens when provider omits usage", async () => {
    const storePath = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-")),
      "sessions.json",
    );
    const sessionKey = "main";
    const entry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      inputTokens: 111,
      outputTokens: 22,
    };
    await saveSessionStore(storePath, { [sessionKey]: entry });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "hello world!" }],
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      meta: {
        agentMeta: {
          promptTokens: 41_000,
          model: "claude-opus-4-5",
          provider: "anthropic",
        },
      },
    });

    const result = await createRun("slack", { storePath, sessionKey });

    expect(result).toBeUndefined();
    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[sessionKey]?.totalTokens).toBe(41_000);
    expect(store[sessionKey]?.totalTokensFresh).toBe(true);
    expect(store[sessionKey]?.inputTokens).toBe(111);
    expect(store[sessionKey]?.outputTokens).toBe(22);
  });
});

describe("runReplyAgent reminder commitment guard", () => {
  function createRun(params?: { sessionKey?: string; omitSessionKey?: boolean }) {
    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "telegram",
      OriginatingTo: "chat",
      AccountId: "primary",
      MessageSid: "msg",
      Surface: "telegram",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session",
        sessionKey: "main",
        messageProvider: "telegram",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude",
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;

    return runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      typing,
      sessionCtx,
      ...(params?.omitSessionKey ? {} : { sessionKey: params?.sessionKey ?? "main" }),
      defaultModel: "anthropic/claude-opus-4-5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });
  }

  it("appends guard note when reminder commitment is not backed by cron.add", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll remind you tomorrow morning." }],
      meta: {},
      successfulCronAdds: 0,
    });

    const result = await createRun();
    expect(result).toMatchObject({
      text: "I'll remind you tomorrow morning.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
    });
  });

  it("keeps reminder commitment unchanged when cron.add succeeded", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll remind you tomorrow morning." }],
      meta: {},
      successfulCronAdds: 1,
    });

    const result = await createRun();
    expect(result).toMatchObject({
      text: "I'll remind you tomorrow morning.",
    });
  });

  it("suppresses guard note when session already has an active cron job", async () => {
    loadCronStoreMock.mockResolvedValueOnce({
      version: 1,
      jobs: [
        {
          id: "existing-job",
          name: "monitor-task",
          enabled: true,
          sessionKey: "main",
          createdAtMs: Date.now() - 60_000,
          updatedAtMs: Date.now() - 60_000,
        },
      ],
    });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll ping you when it's done." }],
      meta: {},
      successfulCronAdds: 0,
    });

    const result = await createRun();
    expect(result).toMatchObject({
      text: "I'll ping you when it's done.",
    });
  });

  it("still appends guard note when cron jobs exist but not for the current session", async () => {
    loadCronStoreMock.mockResolvedValueOnce({
      version: 1,
      jobs: [
        {
          id: "unrelated-job",
          name: "daily-news",
          enabled: true,
          sessionKey: "other-session",
          createdAtMs: Date.now() - 60_000,
          updatedAtMs: Date.now() - 60_000,
        },
      ],
    });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll remind you tomorrow morning." }],
      meta: {},
      successfulCronAdds: 0,
    });

    const result = await createRun();
    expect(result).toMatchObject({
      text: "I'll remind you tomorrow morning.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
    });
  });

  it("still appends guard note when cron jobs for session exist but are disabled", async () => {
    loadCronStoreMock.mockResolvedValueOnce({
      version: 1,
      jobs: [
        {
          id: "disabled-job",
          name: "old-monitor",
          enabled: false,
          sessionKey: "main",
          createdAtMs: Date.now() - 60_000,
          updatedAtMs: Date.now() - 60_000,
        },
      ],
    });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll check back in an hour." }],
      meta: {},
      successfulCronAdds: 0,
    });

    const result = await createRun();
    expect(result).toMatchObject({
      text: "I'll check back in an hour.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
    });
  });

  it("still appends guard note when sessionKey is missing", async () => {
    loadCronStoreMock.mockResolvedValueOnce({
      version: 1,
      jobs: [
        {
          id: "existing-job",
          name: "monitor-task",
          enabled: true,
          sessionKey: "main",
          createdAtMs: Date.now() - 60_000,
          updatedAtMs: Date.now() - 60_000,
        },
      ],
    });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll ping you later." }],
      meta: {},
      successfulCronAdds: 0,
    });

    const result = await createRun({ omitSessionKey: true });
    expect(result).toMatchObject({
      text: "I'll ping you later.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
    });
  });

  it("still appends guard note when cron store read fails", async () => {
    loadCronStoreMock.mockRejectedValueOnce(new Error("store read failed"));

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "I'll remind you after lunch." }],
      meta: {},
      successfulCronAdds: 0,
    });

    const result = await createRun({ sessionKey: "main" });
    expect(result).toMatchObject({
      text: "I'll remind you after lunch.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
    });
  });
});

describe("runReplyAgent fallback reasoning tags", () => {
  type EmbeddedPiAgentParams = {
    enforceFinalTag?: boolean;
    prompt?: string;
  };

  function createRun(params?: {
    sessionEntry?: SessionEntry;
    sessionKey?: string;
    agentCfgContextTokens?: number;
  }) {
    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "whatsapp",
      OriginatingTo: "+15550001111",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const sessionKey = params?.sessionKey ?? "main";
    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: "/tmp/agent",
        sessionId: "session",
        sessionKey,
        messageProvider: "whatsapp",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude",
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;

    return runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      typing,
      sessionCtx,
      sessionEntry: params?.sessionEntry,
      sessionKey,
      defaultModel: "anthropic/claude-opus-4-5",
      agentCfgContextTokens: params?.agentCfgContextTokens,
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });
  }

  it("enforces <final> when the fallback provider requires reasoning tags", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {},
    });
    runWithModelFallbackMock.mockImplementationOnce(
      async ({ run }: RunWithModelFallbackParams) => ({
        result: await run("google-gemini-cli", "gemini-3"),
        provider: "google-gemini-cli",
        model: "gemini-3",
      }),
    );

    await createRun();

    const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as EmbeddedPiAgentParams | undefined;
    expect(call?.enforceFinalTag).toBe(true);
  });

  it("enforces <final> during memory flush on fallback providers", async () => {
    runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedPiAgentParams) => {
      if (params.prompt?.includes("Pre-compaction memory flush.")) {
        return { payloads: [], meta: {} };
      }
      return { payloads: [{ text: "ok" }], meta: {} };
    });
    runWithModelFallbackMock.mockImplementation(async ({ run }: RunWithModelFallbackParams) => ({
      result: await run("google-gemini-cli", "gemini-3"),
      provider: "google-gemini-cli",
      model: "gemini-3",
    }));

    await createRun({
      sessionEntry: {
        sessionId: "session",
        updatedAt: Date.now(),
        totalTokens: 1_000_000,
        compactionCount: 0,
      },
    });

    const flushCall = runEmbeddedPiAgentMock.mock.calls.find(([params]) =>
      (params as EmbeddedPiAgentParams | undefined)?.prompt?.includes(
        "Pre-compaction memory flush.",
      ),
    )?.[0] as EmbeddedPiAgentParams | undefined;

    expect(flushCall?.enforceFinalTag).toBe(true);
  });
});

describe("runReplyAgent response usage footer", () => {
  function createRun(params: { responseUsage: "tokens" | "full"; sessionKey: string }) {
    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "whatsapp",
      OriginatingTo: "+15550001111",
      AccountId: "primary",
      MessageSid: "msg",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;

    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
      responseUsage: params.responseUsage,
    };

    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        agentId: "main",
        agentDir: "/tmp/agent",
        sessionId: "session",
        sessionKey: params.sessionKey,
        messageProvider: "whatsapp",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude",
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;

    return runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      typing,
      sessionCtx,
      sessionEntry,
      sessionKey: params.sessionKey,
      defaultModel: "anthropic/claude-opus-4-5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });
  }

  it("appends session key when responseUsage=full", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          provider: "anthropic",
          model: "claude",
          usage: { input: 12, output: 3 },
        },
      },
    });

    const sessionKey = "agent:main:whatsapp:dm:+1000";
    const res = await createRun({ responseUsage: "full", sessionKey });
    const payload = Array.isArray(res) ? res[0] : res;
    expect(String(payload?.text ?? "")).toContain("Usage:");
    expect(String(payload?.text ?? "")).toContain(`· session \`${sessionKey}\``);
  });

  it("does not append session key when responseUsage=tokens", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "ok" }],
      meta: {
        agentMeta: {
          provider: "anthropic",
          model: "claude",
          usage: { input: 12, output: 3 },
        },
      },
    });

    const sessionKey = "agent:main:whatsapp:dm:+1000";
    const res = await createRun({ responseUsage: "tokens", sessionKey });
    const payload = Array.isArray(res) ? res[0] : res;
    expect(String(payload?.text ?? "")).toContain("Usage:");
    expect(String(payload?.text ?? "")).not.toContain("· session ");
  });
});

describe("runReplyAgent transient HTTP retry", () => {
  it("retries once after transient 521 HTML failure and then succeeds", async () => {
    vi.useFakeTimers();
    runEmbeddedPiAgentMock
      .mockRejectedValueOnce(
        new Error(
          `521 <!DOCTYPE html><html lang="en-US"><head><title>Web server is down</title></head><body>Cloudflare</body></html>`,
        ),
      )
      .mockResolvedValueOnce({
        payloads: [{ text: "Recovered response" }],
        meta: {},
      });

    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "telegram",
      MessageSid: "msg",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session",
        sessionKey: "main",
        messageProvider: "telegram",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude",
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;

    const runPromise = runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      typing,
      sessionCtx,
      defaultModel: "anthropic/claude-opus-4-5",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    await vi.advanceTimersByTimeAsync(2_500);
    const result = await runPromise;

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(runtimeErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Transient HTTP provider error before reply"),
    );

    const payload = Array.isArray(result) ? result[0] : result;
    expect(payload?.text).toContain("Recovered response");
  });
});

describe("original reply outlet council completion handoff", () => {
  const ask = "Kimi、MiniMax、DeepSeek 三个模型意见不一致时，谁来裁决？";
  const candidate =
    "Kimi、MiniMax、DeepSeek 已完成独立审阅，各自角色产出已经分别记录。裁决原则：证据排序优先，先查原始来源、时间戳和可复现的事实，再比较反例和证据缺口。LCX 本地 gate 和审阅流程是最终裁判，不按模型多数票、模型名气或本地记忆直接选结论。当前没有原始来源，分歧维持未解决；下一步补原文与数据口径。";
  const messageId = "offline-council-handoff";
  const proofs: Record<string, unknown> = {};
  async function evidence() {
    const sourcePath = process.env.LCX_WATERFLOW_REPLY_COUNCIL_ARTIFACT;
    const content = sourcePath
      ? await fs.readFile(sourcePath, "utf8")
      : JSON.stringify({
          version: 2,
          generatedAt: "2026-10-11T00:00:00Z",
          messageId,
          userMessage: ask,
          status: "full",
          roles: [
            ["kimi", "moonshot", "kimi-k2.6"],
            ["minimax", "minimax-portal", "MiniMax-M2.7"],
            ["deepseek", "custom-api-deepseek-com", "deepseek-v4-flash"],
          ].map(([role, provider, model]) => ({
            role,
            model: `${provider}/${model}`,
            actualProvider: provider,
            actualModel: model,
            requestedModelHealth: "healthy",
            success: true,
            text: "来源缺失，分歧仍未解决。",
          })),
        });
    return {
      messageId,
      content,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    };
  }
  async function run(
    params: {
      text?: string;
      userMessage?: string;
      currentMessageId?: string;
      providerEvidence?: Awaited<ReturnType<typeof evidence>>;
      partials?: string[];
      blocks?: string[];
      aborted?: boolean;
      modelTimedOut?: boolean;
    } = {},
  ) {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "reply-council-handoff-"));
    const emitted: string[] = [];
    const events: unknown[] = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.data.phase === "provider_council_completion_gate") {
        events.push(event);
      }
    });
    try {
      const controller = new AbortController();
      if (params.aborted) {
        controller.abort();
      }
      runEmbeddedPiAgentMock.mockImplementation(
        async (options: {
          onPartialReply?: (payload: { text: string }) => Promise<void>;
          onBlockReply?: (payload: { text: string }) => Promise<void>;
        }) => {
          for (const text of params.partials ?? []) {
            await options.onPartialReply?.({ text });
          }
          for (const text of params.blocks ?? []) {
            await options.onBlockReply?.({ text });
          }
          return {
            payloads: [{ text: params.text ?? candidate }],
            meta: {
              agentMeta: { provider: "anthropic", model: "claude" },
              timedOut: params.modelTimedOut,
            },
          };
        },
      );
      const userMessage = params.userMessage ?? ask;
      const followupRun = {
        prompt: userMessage,
        summaryLine: userMessage,
        enqueuedAt: Date.now(),
        run: {
          sessionId: "offline-council",
          sessionKey: "offline-council",
          messageProvider: "webchat",
          sessionFile: path.join(workspaceDir, "session.jsonl"),
          workspaceDir,
          config: {},
          skillsSnapshot: {},
          provider: "anthropic",
          model: "claude",
          thinkLevel: "low",
          verboseLevel: "off",
          elevatedLevel: "off",
          bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
          timeoutMs: 1000,
          blockReplyBreak: "message_end",
        },
      } as unknown as FollowupRun;
      const result = await runReplyAgent({
        commandBody: userMessage,
        followupRun,
        queueKey: "offline-council",
        resolvedQueue: { mode: "interrupt" },
        shouldSteer: false,
        shouldFollowup: false,
        isActive: false,
        isStreaming: false,
        opts: {
          abortSignal: controller.signal,
          providerCouncilEvidence: params.providerEvidence,
          onPartialReply: (payload) => {
            if (payload.text) {
              emitted.push(payload.text);
            }
          },
          onBlockReply: (payload) => {
            if (payload.text) {
              emitted.push(payload.text);
            }
          },
        },
        typing: createMockTypingController(),
        sessionCtx: {
          Provider: "webchat",
          OriginatingTo: "offline-council",
          AccountId: "offline",
          MessageSid: params.currentMessageId ?? messageId,
        } as unknown as TemplateContext,
        defaultModel: "anthropic/claude",
        resolvedVerboseLevel: "off",
        isNewSession: false,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: "message_end",
        shouldInjectGroupIntro: false,
        typingMode: "instant",
      });
      return { result, emitted, events };
    } finally {
      unsubscribe();
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  }
  afterEach(async () => {
    const dir = process.env.LCX_WATERFLOW_PROOF_DIR;
    if (dir) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "commercial-reply-outlet-proof.json"),
        JSON.stringify(
          {
            boundary: "original_runReplyAgent_with_local_model_and_delivery_substitutes",
            naturalExternalDelivery: "not_proven",
            proofs,
          },
          null,
          2,
        ),
      );
    }
  });
  it("rejects the same unsupported completion in the actual final reply owner", async () => {
    const value = await run();
    expect(JSON.stringify(value.result)).toContain("无法核实");
    expect(JSON.stringify(value.result)).not.toContain("已完成独立审阅");
    expect(value.events.length).toBeGreaterThan(0);
    proofs.missing = value;
  });
  it("keeps original writer evidence effective through the final reply owner", async () => {
    const input = await evidence();
    const value = await run({ providerEvidence: input });
    expect(JSON.stringify(value.result)).toContain("已完成独立审阅");
    expect(JSON.stringify(value.events)).toContain(input.sha256);
    proofs.valid = { sourceSha256: input.sha256, ...value };
  });
  it("uses current inbound identity rather than trusting an old caller identity", async () => {
    const value = await run({
      providerEvidence: await evidence(),
      currentMessageId: "another-message",
    });
    expect(JSON.stringify(value.result)).toContain("无法核实");
    expect(JSON.stringify(value.events)).toContain("provider_council_message_scope_conflict");
    proofs.wrongMessage = value;
  });
  it("guards partial and directly flushed block replies before delivery callbacks", async () => {
    const value = await run({ partials: [candidate], blocks: [candidate] });
    expect(value.emitted.length).toBeGreaterThan(0);
    expect(value.emitted.every((text) => !text.includes("已完成独立审阅"))).toBe(true);
    proofs.streaming = value;
  });
  it("keeps split completion claims inside the same stream scope", async () => {
    const value = await run({ partials: ["Kimi、MiniMax、DeepSeek ", "已完成独立审阅。"] });
    expect(value.emitted.every((text) => !text.includes("已完成独立审阅"))).toBe(true);
    proofs.split = value;
  });
  it("does not let a valid receipt restore completion after cancellation", async () => {
    const value = await run({ providerEvidence: await evidence(), aborted: true });
    expect(JSON.stringify(value.result)).not.toContain("已完成独立审阅");
    proofs.cancelled = value;
  });
  it("keeps an internally timed-out model result from restoring completion", async () => {
    const value = await run({ providerEvidence: await evidence(), modelTimedOut: true });
    expect(JSON.stringify(value.result)).not.toContain("已完成独立审阅");
    proofs.modelTimedOut = value;
  });
  it("keeps sufficient arithmetic on the existing simple path", async () => {
    const value = await run({ userMessage: "100 的 10% 是多少？", text: "100 的 10% 是 10。" });
    expect(JSON.stringify(value.result)).toContain("100 的 10% 是 10");
    expect(value.events).toEqual([]);
    proofs.arithmetic = value;
  });
});
