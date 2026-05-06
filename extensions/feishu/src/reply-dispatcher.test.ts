import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveFeishuAccountMock = vi.hoisted(() => vi.fn());
const getFeishuRuntimeMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());
const sendMarkdownCardFeishuMock = vi.hoisted(() => vi.fn());
const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveReceiveIdTypeMock = vi.hoisted(() => vi.fn());
const createReplyDispatcherWithTypingMock = vi.hoisted(() => vi.fn());
const addTypingIndicatorMock = vi.hoisted(() => vi.fn(async () => ({ messageId: "om_msg" })));
const removeTypingIndicatorMock = vi.hoisted(() => vi.fn(async () => {}));
const recordFeishuReplyFlowEventMock = vi.hoisted(() => vi.fn(async () => {}));
const streamingInstances = vi.hoisted(() => [] as any[]);

vi.mock("./accounts.js", () => ({ resolveFeishuAccount: resolveFeishuAccountMock }));
vi.mock("./runtime.js", () => ({ getFeishuRuntime: getFeishuRuntimeMock }));
vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
  sendMarkdownCardFeishu: sendMarkdownCardFeishuMock,
}));
vi.mock("./media.js", () => ({ sendMediaFeishu: sendMediaFeishuMock }));
vi.mock("./client.js", () => ({ createFeishuClient: createFeishuClientMock }));
vi.mock("./targets.js", () => ({ resolveReceiveIdType: resolveReceiveIdTypeMock }));
vi.mock("./typing.js", () => ({
  addTypingIndicator: addTypingIndicatorMock,
  removeTypingIndicator: removeTypingIndicatorMock,
}));
vi.mock("./streaming-card.js", () => ({
  FeishuStreamingSession: class {
    active = false;
    start = vi.fn(async () => {
      this.active = true;
    });
    update = vi.fn(async () => {});
    close = vi.fn(async () => {
      this.active = false;
    });
    isActive = vi.fn(() => this.active);
    getDeliveryMessageId = vi.fn(() => "om_stream");

    constructor() {
      streamingInstances.push(this);
    }
  },
}));
vi.mock("./reply-flow-audit.js", () => ({
  recordFeishuReplyFlowEvent: recordFeishuReplyFlowEventMock,
}));

import { createFeishuReplyDispatcher, normalizeFeishuDisplayText } from "./reply-dispatcher.js";

describe("createFeishuReplyDispatcher streaming behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamingInstances.length = 0;
    sendMediaFeishuMock.mockResolvedValue(undefined);

    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
      },
    });

    resolveReceiveIdTypeMock.mockReturnValue("chat_id");
    createFeishuClientMock.mockReturnValue({});

    createReplyDispatcherWithTypingMock.mockImplementation((opts) => ({
      dispatcher: {},
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      _opts: opts,
    }));

    getFeishuRuntimeMock.mockReturnValue({
      channel: {
        text: {
          resolveTextChunkLimit: vi.fn(() => 4000),
          resolveChunkMode: vi.fn(() => "line"),
          resolveMarkdownTableMode: vi.fn(() => "preserve"),
          convertMarkdownTables: vi.fn((text) => text),
          chunkTextWithMode: vi.fn((text) => [text]),
        },
        reply: {
          createReplyDispatcherWithTyping: createReplyDispatcherWithTypingMock,
          resolveHumanDelayConfig: vi.fn(() => undefined),
        },
      },
    });
  });

  it("skips typing indicator when account typingIndicator is disabled", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "auto",
        streaming: true,
        typingIndicator: false,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("skips typing indicator for stale replayed messages", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Date.now() - 3 * 60_000,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("treats second-based timestamps as stale for typing suppression", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Math.floor((Date.now() - 3 * 60_000) / 1000),
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).not.toHaveBeenCalled();
  });

  it("keeps typing indicator for fresh messages", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
      messageCreateTimeMs: Date.now() - 30_000,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.onReplyStart?.();

    expect(addTypingIndicatorMock).toHaveBeenCalledTimes(1);
    expect(addTypingIndicatorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "om_parent",
      }),
    );
  });

  it("keeps auto mode plain text on non-streaming send path", async () => {
    sendMessageFeishuMock.mockResolvedValueOnce({ messageId: "om_text", chatId: "oc_chat" });
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
      replyFlowCorrelationId: "om_parent",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "plain text" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(recordFeishuReplyFlowEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "om_parent",
        stage: "outbound_attempt",
        sendMode: "message",
        replyKind: "final",
        textPreview: "plain text",
      }),
    );
    expect(recordFeishuReplyFlowEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "om_parent",
        stage: "outbound_result",
        deliveryStatus: "success",
        deliveryMessageId: "om_text",
      }),
    );
  });

  it("records failed direct sends before surfacing the error", async () => {
    sendMessageFeishuMock.mockRejectedValueOnce(new Error("feishu-send-failed"));
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_parent",
      replyFlowCorrelationId: "om_parent",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await expect(options.deliver({ text: "plain text" }, { kind: "final" })).rejects.toThrow(
      "feishu-send-failed",
    );

    expect(recordFeishuReplyFlowEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "om_parent",
        stage: "outbound_attempt",
        sendMode: "message",
        textPreview: "plain text",
      }),
    );
    expect(recordFeishuReplyFlowEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "om_parent",
        stage: "outbound_result",
        deliveryStatus: "failed",
        error: "Error: feishu-send-failed",
      }),
    );
  });

  it("normalizes markdown tables and code fences before sending to Feishu", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "raw",
        streaming: false,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver(
      {
        text: [
          "## 今日关注",
          "",
          "| 指标 | 数值 | 结论 |",
          "|------|------|------|",
          "| VIX | 27.44 | 偏高 |",
          "",
          "```json",
          '{ "repair_candidate": "continuation-routing" }',
          "```",
        ].join("\n"),
      },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: [
          "今日关注",
          "",
          "- 指标: VIX; 数值: 27.44; 结论: 偏高",
          "",
          '{ "repair_candidate": "continuation-routing" }',
        ].join("\n"),
      }),
    );
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("suppresses internal block payload delivery", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "internal reasoning chunk" }, { kind: "block" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
  });

  it("never sends tool-result payloads to external Feishu chats", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver(
      { text: "⚠️ 📝 Edit: in ~/.openclaw/workspace/MEMORY.md failed" },
      { kind: "tool" },
    );

    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
    expect(streamingInstances).toHaveLength(0);
  });

  it("uses streaming session for auto mode markdown payloads", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      rootId: "om_root_topic",
      replyFlowCorrelationId: "om_stream_parent",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].start).toHaveBeenCalledWith("oc_chat", "chat_id", {
      replyToMessageId: undefined,
      replyInThread: undefined,
      rootId: "om_root_topic",
    });
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
    expect(recordFeishuReplyFlowEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "om_stream_parent",
        stage: "outbound_attempt",
        sendMode: "streaming_card",
        outboundMessageType: "interactive",
      }),
    );
    expect(recordFeishuReplyFlowEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "om_stream_parent",
        stage: "outbound_result",
        sendMode: "streaming_card",
        deliveryStatus: "success",
        deliveryMessageId: "om_stream",
      }),
    );
  });

  it("closes streaming with block text when final reply is missing", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```md\npartial answer\n```" }, { kind: "block" });
    await options.onIdle?.();

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledWith("partial answer");
  });

  it("sends media-only payloads as attachments", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ mediaUrl: "https://example.com/a.png" }, { kind: "final" });

    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "oc_chat",
        mediaUrl: "https://example.com/a.png",
      }),
    );
    expect(sendMessageFeishuMock).not.toHaveBeenCalled();
    expect(sendMarkdownCardFeishuMock).not.toHaveBeenCalled();
  });

  it("falls back to legacy mediaUrl when mediaUrls is an empty array", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver(
      { text: "caption", mediaUrl: "https://example.com/a.png", mediaUrls: [] },
      { kind: "final" },
    );

    expect(sendMessageFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/a.png",
      }),
    );
  });

  it("sends attachments after streaming final markdown replies", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver(
      { text: "```ts\nconst x = 1\n```", mediaUrls: ["https://example.com/a.png"] },
      { kind: "final" },
    );

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledTimes(1);
    expect(streamingInstances[0].close).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledTimes(1);
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/a.png",
      }),
    );
  });

  it("passes replyInThread to sendMessageFeishu for plain text", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: true,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "plain text" }, { kind: "final" });

    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  it("drops blank reply targets before dispatch", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      replyToMessageId: "   ",
      rootId: "   ",
      replyInThread: true,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledWith("oc_chat", "chat_id", {
      replyToMessageId: undefined,
      replyInThread: true,
      rootId: undefined,
    });
    expect(sendMessageFeishuMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: "   " }),
    );
  });

  it("passes replyInThread to sendMarkdownCardFeishu for card text", async () => {
    resolveFeishuAccountMock.mockReturnValue({
      accountId: "main",
      appId: "app_id",
      appSecret: "app_secret",
      domain: "feishu",
      config: {
        renderMode: "card",
        streaming: false,
      },
    });

    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: true,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "card text" }, { kind: "final" });

    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  it("passes replyToMessageId and replyInThread to streaming.start()", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: true,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(1);
    expect(streamingInstances[0].start).toHaveBeenCalledWith("oc_chat", "chat_id", {
      replyToMessageId: "om_msg",
      replyInThread: true,
    });
  });

  it("disables streaming for thread replies and keeps reply metadata", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: false,
      threadReply: true,
      rootId: "om_root_topic",
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ text: "```ts\nconst x = 1\n```" }, { kind: "final" });

    expect(streamingInstances).toHaveLength(0);
    expect(sendMarkdownCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });

  it("passes replyInThread to media attachments", async () => {
    createFeishuReplyDispatcher({
      cfg: {} as never,
      agentId: "agent",
      runtime: {} as never,
      chatId: "oc_chat",
      replyToMessageId: "om_msg",
      replyInThread: true,
    });

    const options = createReplyDispatcherWithTypingMock.mock.calls[0]?.[0];
    await options.deliver({ mediaUrl: "https://example.com/a.png" }, { kind: "final" });

    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: "om_msg",
        replyInThread: true,
      }),
    );
  });
});

describe("normalizeFeishuDisplayText", () => {
  it("turns heavy markdown into operator-readable plain text", () => {
    expect(
      normalizeFeishuDisplayText(
        [
          "# 标题",
          "",
          "| 项目 | 状态 |",
          "|------|------|",
          "| 学习 | 正常 |",
          "",
          "```ts",
          "const x = 1;",
          "```",
        ].join("\n"),
      ),
    ).toBe(["标题", "", "- 项目: 学习; 状态: 正常", "", "const x = 1;"].join("\n"));
  });

  it("turns internal learning status lines into readable Lark text", () => {
    expect(
      normalizeFeishuDisplayText(
        [
          "Learning council run: delayed / no visible completion yet.",
          "Status -",
          "failedReason: learning_council_reply_timeout_after_5000ms",
          "foregroundStatus: timeout_already_reported",
          "targetSurface: learning_command",
          "Boundary: do not treat this turn as application_ready or durable learning.",
        ].join("\n"),
      ),
    ).toBe(
      [
        "学习流程已经开始，但前台等待时间内还没形成最终答案。",
        "当前状态",
        "- 失败原因: 学习审阅超过前台等待时间 (learning_council_reply_timeout_after_5000ms)",
        "- 前台状态: 前台已经先告诉你超时，后台还会补发结果",
        "- 目标工作面: learning_command",
        "- 边界: do not treat this turn as 已通过验证，可作为研究能力使用 or durable learning.",
      ].join("\n"),
    );
  });

  it("makes queue receipts readable before they reach Lark", () => {
    expect(
      normalizeFeishuDisplayText(
        [
          "done - family=live_scheduling_queue; targetSurface=learning_command; effectiveSurface=learning_command;",
          "queued - requested work items remain pending in order; do not treat queued work as completed until a later receipt proves the specific item ran.",
          "next step - run the first queued item only, then return with its receipt/proof before starting the next item.",
          "proof - handoff receipt: memory/example.json; dispatch=direct_queue_guard;",
        ].join("\n"),
      ),
    ).toBe(
      [
        "已收到：这是排队/调度请求；本次只完成队列识别，没有把排队任务说成已经完成。",
        "队列状态：requested work items remain pending in order; do not treat queued work as completed until a later receipt proves the specific item ran.",
        "下一步：run the first queued item only, then return with its receipt/proof before starting the next item.",
        "证据：交接回执: memory/example.json; dispatch=direct_queue_guard;",
      ].join("\n"),
    );
  });
});
