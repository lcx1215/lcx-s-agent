import { describe, expect, it, vi } from "vitest";
import { handleFeishuCommand, normalizeFeishuCommandText } from "./feishu-command-handler.js";

describe("normalizeFeishuCommandText", () => {
  it("keeps explicit slash commands unchanged", () => {
    expect(normalizeFeishuCommandText("/new continue this line")).toBe("/new continue this line");
    expect(normalizeFeishuCommandText("/reset")).toBe("/reset");
  });

  it("keeps natural-language continuation and absorb prompts untouched", () => {
    expect(normalizeFeishuCommandText("继续")).toBe("继续");
    expect(normalizeFeishuCommandText("继续这个研究线。")).toBe("继续这个研究线。");
    expect(normalizeFeishuCommandText("- 继续这个研究线")).toBe("- 继续这个研究线");
    expect(normalizeFeishuCommandText("1. 继续这个研究线")).toBe("1. 继续这个研究线");
    expect(normalizeFeishuCommandText("\u200b继续这个研究线")).toBe("\u200b继续这个研究线");
    expect(normalizeFeishuCommandText("\u200b- 继续这个研究线")).toBe("\u200b- 继续这个研究线");
    expect(normalizeFeishuCommandText("把这些内容整理进当前基本面研究")).toBe(
      "把这些内容整理进当前基本面研究",
    );
    expect(normalizeFeishuCommandText("继续分析一下这家公司的财报差异")).toBe(
      "继续分析一下这家公司的财报差异",
    );
    expect(normalizeFeishuCommandText("把这些内容整理成一个表格")).toBe("把这些内容整理成一个表格");
    expect(
      normalizeFeishuCommandText("继续这个研究线，查一下最近英伟达 AI capex 指引和 QQQ 的关系"),
    ).toBe("继续这个研究线，查一下最近英伟达 AI capex 指引和 QQQ 的关系");
    expect(normalizeFeishuCommandText("查一下最近美国非农对 QQQ 和 TLT 的影响")).toBe(
      "查一下最近美国非农对 QQQ 和 TLT 的影响",
    );
  });

  it("keeps realistic research prompts out of reset alias handling", () => {
    const cases = [
      "把这些内容整理进当前基本面研究，并补一个 AAPL 和微软的 follow-up 清单",
      "查一下最近美国非农、通胀预期和 QQQ / TLT 的关系",
      "继续这个方法研究，但先检查这个 paper 有没有 leakage 和 overfitting 风险",
    ];

    for (const message of cases) {
      expect(normalizeFeishuCommandText(message)).toBe(message);
    }
  });
});

describe("handleFeishuCommand", () => {
  it("runs reset hooks only for explicit slash commands", async () => {
    const runBeforeReset = vi.fn(async () => {});

    const handled = await handleFeishuCommand(
      "/new 继续这个研究线",
      "agent:main:feishu:dm:ou-1",
      {
        runBeforeReset,
      },
      {
        cfg: {},
        sessionEntry: {},
        commandSource: "feishu",
        timestamp: 123,
      },
    );

    expect(handled).toBe(true);
    expect(runBeforeReset).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "new",
        context: expect.objectContaining({
          commandSource: "feishu",
        }),
      }),
      {
        agentId: "main",
        sessionKey: "agent:main:feishu:dm:ou-1",
      },
    );
  });

  it("does not treat realistic research prompts as reset commands", async () => {
    const runBeforeReset = vi.fn(async () => {});

    const messages = [
      "继续这个研究线",
      "把这些内容整理进当前基本面研究，并补一个 AAPL 和微软的 follow-up 清单",
      "查一下最近美国非农、通胀预期和 QQQ / TLT 的关系",
      "继续这个方法研究，但先检查这个 paper 有没有 leakage 和 overfitting 风险",
    ];

    for (const message of messages) {
      await expect(
        handleFeishuCommand(
          message,
          "agent:main:feishu:dm:ou-1",
          { runBeforeReset },
          {
            cfg: {},
            sessionEntry: {},
            commandSource: "feishu",
            timestamp: 123,
          },
        ),
      ).resolves.toBe(false);
    }

    expect(runBeforeReset).not.toHaveBeenCalled();
  });
});
