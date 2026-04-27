import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createFeishuLiveProbeTool } from "./feishu-live-probe-tool.js";

function buildConfig(): OpenClawConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        surfaces: {
          learning_command: {
            enabled: true,
            chatId: "oc_learning",
          },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("feishu_live_probe", () => {
  let workspaceDir: string | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = null;
    }
  });

  it("writes a failed receipt when no later reply is observed", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-live-probe-"));
    const tool = createFeishuLiveProbeTool({
      workspaceDir,
      config: buildConfig(),
      sendProbe: vi.fn().mockResolvedValue({ messageId: "msg-probe" }),
      readProbe: vi.fn().mockResolvedValue([
        {
          messageId: "msg-probe",
          timestamp: "2026-04-12T15:00:00.000Z",
          authorTag: "app:bot",
          content: "probe text",
        },
      ]),
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => new Date("2026-04-12T15:00:00.000Z"),
    });

    const result = await tool.execute("call-1", {
      surface: "learning_command",
      message: "probe text",
      waitMs: 10,
      limit: 5,
    });

    expect(result.details).toMatchObject({
      ok: false,
      status: "no_reply_observed",
      surface: "learning_command",
      chatId: "redacted:11",
      sentMessageId: "redacted:9",
      repairHint: "self_authored_probe_not_processed_or_live_ingress_not_migrated",
    });
    const receiptPath = (result.details as { receiptPath?: string }).receiptPath;
    const indexPath = (result.details as { indexPath?: string }).indexPath;
    expect(receiptPath).toBeTruthy();
    expect(indexPath).toBe("memory/feishu-live-probes/index.md");
    const receipt = await fs.readFile(path.join(workspaceDir, receiptPath as string), "utf8");
    expect(receipt).toContain("# Feishu Live Probe Receipt");
    expect(receipt).not.toContain("oc_learning");
    expect(receipt).not.toContain("msg-probe");
    expect(receipt).not.toContain("app:bot");
    expect(receipt).toContain("- chat_id: redacted:11");
    expect(receipt).toContain("- sent_message_id: redacted:9");
    expect(receipt).toContain("- status: no_reply_observed");
    expect(receipt).toContain(
      "- repair_hint: self_authored_probe_not_processed_or_live_ingress_not_migrated",
    );
    expect(receipt).toContain("No later Feishu message was observed after the probe");
    expect(receipt).toContain("The probe message was app-authored");
    const index = await fs.readFile(path.join(workspaceDir, indexPath as string), "utf8");
    expect(index).toContain("# Feishu Live Probe Index");
    expect(index).toContain("learning_command | no_reply_observed");
    expect(index).toContain("self_authored_probe_not_processed_or_live_ingress_not_migrated");
  });

  it("keeps the self-authored repair hint when older user messages are in the read window", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-live-probe-"));
    const tool = createFeishuLiveProbeTool({
      workspaceDir,
      config: buildConfig(),
      sendProbe: vi.fn().mockResolvedValue({ messageId: "msg-probe" }),
      readProbe: vi.fn().mockResolvedValue([
        {
          messageId: "msg-probe",
          timestamp: "2026-04-12T15:00:00.000Z",
          authorTag: "app:bot",
          content: "probe text",
        },
        {
          messageId: "msg-user-older",
          timestamp: "2026-04-12T14:59:00.000Z",
          authorTag: "user:owner",
          content: "older user message",
        },
      ]),
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => new Date("2026-04-12T15:00:00.000Z"),
    });

    const result = await tool.execute("call-older-user", {
      surface: "learning_command",
      message: "probe text",
      waitMs: 10,
      limit: 5,
    });

    expect(result.details).toMatchObject({
      ok: false,
      status: "no_reply_observed",
      repairHint: "self_authored_probe_not_processed_or_live_ingress_not_migrated",
    });
    expect((result.details as { reasons?: string[] }).reasons).toContain(
      "The probe message was app-authored, so this path does not prove the active live inbound handler is processing user-authored Feishu/Lark messages.",
    );
  });

  it("fails when the reply contains a forbidden phrase", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-live-probe-"));
    const tool = createFeishuLiveProbeTool({
      workspaceDir,
      config: buildConfig(),
      sendProbe: vi.fn().mockResolvedValue({ messageId: "msg-probe" }),
      readProbe: vi.fn().mockResolvedValue([
        {
          messageId: "msg-reply",
          timestamp: "2026-04-12T15:00:03.000Z",
          authorTag: "app:bot",
          content: "已识别主题：股市分析能力；已加入学习队列",
        },
        {
          messageId: "msg-probe",
          timestamp: "2026-04-12T15:00:00.000Z",
          authorTag: "app:bot",
          content: "打开我的浏览器分析，然后生成几个你未来半年最看好的股票",
        },
      ]),
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => new Date("2026-04-12T15:00:00.000Z"),
    });

    const result = await tool.execute("call-2", {
      surface: "learning_command",
      message: "打开我的浏览器分析，然后生成几个你未来半年最看好的股票",
      mustNotContain: ["已识别主题", "已加入学习队列"],
    });

    expect(result.details).toMatchObject({
      ok: false,
      status: "failed",
      replyMessageId: "redacted:9",
    });
    expect((result.details as { reasons?: string[] }).reasons).toContain(
      "Reply contains forbidden phrase: 已识别主题",
    );
  });

  it("passes when a later reply satisfies the acceptance checks", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-live-probe-"));
    const tool = createFeishuLiveProbeTool({
      workspaceDir,
      config: buildConfig(),
      sendProbe: vi.fn().mockResolvedValue({ messageId: "msg-probe" }),
      readProbe: vi.fn().mockResolvedValue([
        {
          messageId: "msg-reply",
          timestamp: "2026-04-12T15:00:05.000Z",
          authorTag: "app:bot",
          content: "先给结论：未来半年我最看好的方向是高质量大盘科技和防守型资产。",
        },
        {
          messageId: "msg-probe",
          timestamp: "2026-04-12T15:00:00.000Z",
          authorTag: "app:bot",
          content: "给我未来半年最看好的股票",
        },
      ]),
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => new Date("2026-04-12T15:00:00.000Z"),
    });

    const result = await tool.execute("call-3", {
      surface: "learning_command",
      message: "给我未来半年最看好的股票",
      mustContainAny: ["先给结论", "最看好的方向"],
      mustNotContain: ["已加入学习队列"],
    });

    expect(result.details).toMatchObject({
      ok: true,
      status: "passed",
      replyMessageId: "redacted:9",
    });
  });
});
