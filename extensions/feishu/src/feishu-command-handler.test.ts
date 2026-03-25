import { describe, expect, it, vi } from "vitest";
import { handleFeishuCommand, normalizeFeishuCommandText } from "./feishu-command-handler.js";

describe("normalizeFeishuCommandText", () => {
  it("keeps explicit slash commands unchanged", () => {
    expect(normalizeFeishuCommandText("/new continue this line")).toBe("/new continue this line");
    expect(normalizeFeishuCommandText("/reset")).toBe("/reset");
  });

  it("maps high-confidence continue aliases into /new", () => {
    expect(normalizeFeishuCommandText("继续")).toBe("/new 继续");
    expect(normalizeFeishuCommandText("继续这个研究线。")).toBe("/new 继续这个研究线");
    expect(normalizeFeishuCommandText("把这些内容整理进当前基本面研究")).toBe(
      "/new 把这些内容整理进当前基本面研究",
    );
  });

  it("leaves regular natural language untouched", () => {
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
});

describe("handleFeishuCommand", () => {
  it("runs reset hooks for normalized natural-language aliases", async () => {
    const runBeforeReset = vi.fn(async () => {});

    const handled = await handleFeishuCommand(
      "继续这个研究线",
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
});
