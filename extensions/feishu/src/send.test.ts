import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  editMessageFeishu,
  getMessageFeishu,
  listMessagesFeishu,
  sendMarkdownCardFeishu,
} from "./send.js";

const {
  mockClientCreate,
  mockClientGet,
  mockClientList,
  mockClientUpdate,
  mockCreateFeishuClient,
  mockResolveFeishuAccount,
} = vi.hoisted(() => ({
  mockClientCreate: vi.fn(),
  mockClientGet: vi.fn(),
  mockClientList: vi.fn(),
  mockClientUpdate: vi.fn(),
  mockCreateFeishuClient: vi.fn(),
  mockResolveFeishuAccount: vi.fn(),
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: mockResolveFeishuAccount,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      text: {
        resolveMarkdownTableMode: () => "plain",
        convertMarkdownTables: (text: string) => text,
      },
    },
  }),
}));

describe("Feishu visible send normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveFeishuAccount.mockReturnValue({
      accountId: "default",
      configured: true,
    });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          create: mockClientCreate,
          update: mockClientUpdate,
        },
      },
    });
    mockClientCreate.mockResolvedValue({
      code: 0,
      data: {
        message_id: "om_card",
      },
    });
    mockClientUpdate.mockResolvedValue({
      code: 0,
      data: {
        message_id: "om_edit",
      },
    });
  });

  it("normalizes markdown card text before direct outbound sends", async () => {
    await sendMarkdownCardFeishu({
      cfg: {} as ClawdbotConfig,
      to: "chat:oc_card",
      text: [
        "Learning council run: partial / degraded execution.",
        "| 项目 | 状态 |",
        "|---|---|",
        "| 学习 | failedReason |",
        "Lane receipt: contract=challenge (configured role: minimax); runtime provider=minimax-portal; runtime model=MiniMax-M2.7",
      ].join("\n"),
    });

    const content = JSON.parse(mockClientCreate.mock.calls[0]![0].data.content) as {
      body?: { elements?: Array<{ content?: string }> };
    };
    const cardText = content.body?.elements?.[0]?.content ?? "";
    expect(cardText).toContain("学习审阅只部分完成");
    expect(cardText).toContain("- 项目: 学习; 状态: 失败原因");
    expect(cardText).toContain("审阅通道：能力=challenge");
    expect(cardText).not.toContain("Learning council run:");
    expect(cardText).not.toContain("Lane receipt:");
  });

  it("normalizes edited text before updating a visible Feishu message", async () => {
    await editMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_edit",
      text: [
        "failedReason: no_url_or_local_source_provided",
        "targetSurface: protocol_truth_surface",
      ].join("\n"),
    });

    const content = JSON.parse(mockClientUpdate.mock.calls[0]![0].data.content) as {
      zh_cn?: { content?: Array<Array<{ text?: string }>> };
    };
    const messageText = content.zh_cn?.content?.[0]?.[0]?.text ?? "";
    expect(messageText).toContain("失败原因: 没有提供链接、本地文件或完整来源");
    expect(messageText).toContain("目标工作面: 协议真相检查入口 (protocol_truth_surface)");
    expect(messageText).not.toContain("failedReason");
    expect(messageText).not.toContain("targetSurface");
  });
});

describe("getMessageFeishu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveFeishuAccount.mockReturnValue({
      accountId: "default",
      configured: true,
    });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          get: mockClientGet,
          list: mockClientList,
        },
      },
    });
  });

  it("extracts text content from interactive card elements", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_1",
            chat_id: "oc_1",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                elements: [
                  { tag: "markdown", content: "hello markdown" },
                  { tag: "div", text: { content: "hello div" } },
                ],
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_1",
    });

    expect(result).toEqual(
      expect.objectContaining({
        messageId: "om_1",
        chatId: "oc_1",
        contentType: "interactive",
        content: "hello markdown\nhello div",
      }),
    );
  });

  it("extracts text content from post messages", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_post",
            chat_id: "oc_post",
            msg_type: "post",
            body: {
              content: JSON.stringify({
                zh_cn: {
                  title: "Summary",
                  content: [[{ tag: "text", text: "post body" }]],
                },
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_post",
    });

    expect(result).toEqual(
      expect.objectContaining({
        messageId: "om_post",
        chatId: "oc_post",
        contentType: "post",
        content: "Summary\n\npost body",
      }),
    );
  });

  it("returns text placeholder instead of raw JSON for unsupported message types", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_file",
            chat_id: "oc_file",
            msg_type: "file",
            body: {
              content: JSON.stringify({ file_key: "file_v3_123" }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_file",
    });

    expect(result).toEqual(
      expect.objectContaining({
        messageId: "om_file",
        chatId: "oc_file",
        contentType: "file",
        content: "[file message]",
      }),
    );
  });

  it("supports single-object response shape from Feishu API", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        message_id: "om_single",
        chat_id: "oc_single",
        msg_type: "text",
        body: {
          content: JSON.stringify({ text: "single payload" }),
        },
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_single",
    });

    expect(result).toEqual(
      expect.objectContaining({
        messageId: "om_single",
        chatId: "oc_single",
        contentType: "text",
        content: "single payload",
      }),
    );
  });
});

describe("listMessagesFeishu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveFeishuAccount.mockReturnValue({
      accountId: "default",
      configured: true,
    });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          get: mockClientGet,
          list: mockClientList,
        },
      },
    });
  });

  it("lists recent chat messages in descending create-time order", async () => {
    mockClientList.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_latest",
            root_id: "om_root",
            thread_id: "omt_1",
            chat_id: "oc_chat",
            msg_type: "text",
            create_time: "1712900000000",
            sender: {
              id: "ou_operator",
              id_type: "open_id",
              sender_type: "user",
            },
            body: {
              content: JSON.stringify({ text: "latest reply" }),
            },
          },
          {
            message_id: "om_older",
            chat_id: "oc_chat",
            msg_type: "interactive",
            create_time: "1712890000000",
            sender: {
              id: "cli_bot",
              id_type: "app_id",
              sender_type: "app",
            },
            body: {
              content: JSON.stringify({
                elements: [{ tag: "markdown", content: "older card" }],
              }),
            },
          },
        ],
      },
    });

    const result = await listMessagesFeishu({
      cfg: {} as ClawdbotConfig,
      chatId: "oc_chat",
      limit: 2,
    });

    expect(mockClientList).toHaveBeenCalledWith({
      params: {
        container_id_type: "chat",
        container_id: "oc_chat",
        sort_type: "ByCreateTimeDesc",
        page_size: 2,
      },
    });
    expect(result).toEqual([
      expect.objectContaining({
        messageId: "om_latest",
        chatId: "oc_chat",
        rootId: "om_root",
        threadId: "omt_1",
        senderOpenId: "ou_operator",
        authorTag: "user:ou_operator",
        content: "latest reply",
        timestamp: "2024-04-12T05:33:20.000Z",
      }),
      expect.objectContaining({
        messageId: "om_older",
        chatId: "oc_chat",
        authorTag: "app:cli_bot",
        content: "older card",
      }),
    ]);
  });

  it("returns an empty list when Feishu list API fails", async () => {
    mockClientList.mockResolvedValueOnce({ code: 999, msg: "permission denied" });

    const result = await listMessagesFeishu({
      cfg: {} as ClawdbotConfig,
      chatId: "oc_chat",
    });

    expect(result).toEqual([]);
  });
});
