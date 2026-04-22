import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { summarizeRecentFeishuReplyFlowEvidence } from "./feishu-reply-flow-evidence.js";

describe("summarizeRecentFeishuReplyFlowEvidence", () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("summarizes the latest completed correlation chain with outbound metadata", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-reply-flow-"));
    const logPath = path.join(tempDir, "feishu-reply-flow.jsonl");
    const lines = [
      JSON.stringify({ correlationId: "old-corr", stage: "inbound", recordedAtMs: 1 }),
      JSON.stringify({ correlationId: "old-corr", stage: "dispatch_complete", recordedAtMs: 2 }),
      JSON.stringify({ correlationId: "new-corr", stage: "inbound", recordedAtMs: 11 }),
      JSON.stringify({ correlationId: "new-corr", stage: "route", recordedAtMs: 12 }),
      JSON.stringify({ correlationId: "new-corr", stage: "dispatch_start", recordedAtMs: 13 }),
      JSON.stringify({ correlationId: "new-corr", stage: "outbound_attempt", recordedAtMs: 14 }),
      JSON.stringify({
        correlationId: "new-corr",
        stage: "outbound_result",
        recordedAtMs: 15,
        deliveryStatus: "success",
        feishuCode: 0,
        feishuMsg: "success",
        outboundMessageType: "post",
        receiveIdType: "chat_id",
        usedReplyTarget: true,
        usedFallbackCreate: false,
        deliveryMessageId: "om_123",
      }),
      JSON.stringify({ correlationId: "new-corr", stage: "dispatch_complete", recordedAtMs: 16 }),
    ];
    await fs.writeFile(logPath, `${lines.join("\n")}\n`, "utf8");

    const summary = await summarizeRecentFeishuReplyFlowEvidence(logPath);

    expect(summary).toContain("Latest observed correlationId: new-corr");
    expect(summary).toContain("Latest observed status: completed");
    expect(summary).toContain(
      "Latest observed stage chain: inbound -> route -> dispatch_start -> outbound_attempt -> outbound_result -> dispatch_complete",
    );
    expect(summary).toContain("deliveryStatus=success");
    expect(summary).toContain("feishuCode=0");
    expect(summary).toContain("feishuMsg=success");
    expect(summary).toContain("outboundMessageType=post");
    expect(summary).toContain("receiveIdType=chat_id");
    expect(summary).toContain("usedReplyTarget=true");
    expect(summary).toContain("usedFallbackCreate=false");
    expect(summary).toContain("deliveryMessageId=om_123");
    expect(summary).toContain(
      "For user-facing verification conclusions, treat Latest completed as authoritative.",
    );
    expect(summary).toContain(
      "Treat Latest observed only as a local snapshot that may still advance before the reply is delivered.",
    );
    expect(summary).toContain("Latest completed matches latest observed.");
  });

  it("separates latest observed from latest completed when the newest flow is still in progress", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-reply-flow-"));
    const logPath = path.join(tempDir, "feishu-reply-flow.jsonl");
    const lines = [
      JSON.stringify({ correlationId: "done-corr", stage: "inbound", recordedAtMs: 1 }),
      JSON.stringify({ correlationId: "done-corr", stage: "route", recordedAtMs: 2 }),
      JSON.stringify({ correlationId: "done-corr", stage: "dispatch_start", recordedAtMs: 3 }),
      JSON.stringify({ correlationId: "done-corr", stage: "outbound_attempt", recordedAtMs: 4 }),
      JSON.stringify({ correlationId: "done-corr", stage: "outbound_result", recordedAtMs: 5 }),
      JSON.stringify({ correlationId: "done-corr", stage: "dispatch_complete", recordedAtMs: 6 }),
      JSON.stringify({ correlationId: "live-corr", stage: "inbound", recordedAtMs: 7 }),
      JSON.stringify({ correlationId: "live-corr", stage: "route", recordedAtMs: 8 }),
      JSON.stringify({ correlationId: "live-corr", stage: "dispatch_start", recordedAtMs: 9 }),
    ];
    await fs.writeFile(logPath, `${lines.join("\n")}\n`, "utf8");

    const summary = await summarizeRecentFeishuReplyFlowEvidence(logPath);

    expect(summary).toContain("Latest observed correlationId: live-corr");
    expect(summary).toContain("Latest observed status: in_progress_or_partial");
    expect(summary).toContain("Latest observed stage chain: inbound -> route -> dispatch_start");
    expect(summary).toContain("Latest completed correlationId: done-corr");
    expect(summary).toContain("Latest completed status: completed");
  });
});
