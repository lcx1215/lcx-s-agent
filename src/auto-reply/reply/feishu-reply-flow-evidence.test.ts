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

    expect(summary).toContain("Latest completed correlationId: new-corr");
    expect(summary).toContain(
      "Observed stage chain: inbound -> route -> dispatch_start -> outbound_attempt -> outbound_result -> dispatch_complete",
    );
    expect(summary).toContain("Reply-path status evidence: visible_reply_delivered");
    expect(summary).toContain("deliveryStatus=success");
    expect(summary).toContain("feishuCode=0");
    expect(summary).toContain("feishuMsg=success");
    expect(summary).toContain("outboundMessageType=post");
    expect(summary).toContain("receiveIdType=chat_id");
    expect(summary).toContain("usedReplyTarget=true");
    expect(summary).toContain("usedFallbackCreate=false");
    expect(summary).toContain("deliveryMessageId=om_123");
    expect(summary).toContain(
      "Boundary: this proves only the recorded reply delivery layer. It is not proof of source migration, build, restart, live probe, or full live-fixed state.",
    );
  });

  it("does not label a completed reply-flow record as delivered without a successful outbound result", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-reply-flow-"));
    const logPath = path.join(tempDir, "feishu-reply-flow.jsonl");
    const lines = [
      JSON.stringify({ correlationId: "failed-corr", stage: "inbound", recordedAtMs: 11 }),
      JSON.stringify({
        correlationId: "failed-corr",
        stage: "outbound_result",
        recordedAtMs: 15,
        deliveryStatus: "failed",
        feishuCode: 19002,
        feishuMsg: "invalid receive_id",
      }),
      JSON.stringify({
        correlationId: "failed-corr",
        stage: "dispatch_complete",
        recordedAtMs: 16,
      }),
    ];
    await fs.writeFile(logPath, `${lines.join("\n")}\n`, "utf8");

    const summary = await summarizeRecentFeishuReplyFlowEvidence(logPath);

    expect(summary).toContain("Latest completed correlationId: failed-corr");
    expect(summary).toContain("Reply-path status evidence: reply_attempt_recorded_but_not_success");
    expect(summary).toContain("deliveryStatus=failed");
    expect(summary).toContain("feishuCode=19002");
  });

  it("uses a fresh outbound result when dispatch complete has not been recorded yet", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-reply-flow-"));
    const logPath = path.join(tempDir, "feishu-reply-flow.jsonl");
    const lines = [
      JSON.stringify({
        correlationId: "stream-corr",
        stage: "outbound_attempt",
        recordedAtMs: 20,
        outboundMessageType: "interactive",
      }),
      JSON.stringify({
        correlationId: "stream-corr",
        stage: "outbound_result",
        recordedAtMs: 21,
        deliveryStatus: "success",
        feishuCode: 0,
        feishuMsg: "success",
        outboundMessageType: "interactive",
        receiveIdType: "chat_id",
        deliveryMessageId: "om_stream",
      }),
    ];
    await fs.writeFile(logPath, `${lines.join("\n")}\n`, "utf8");

    const summary = await summarizeRecentFeishuReplyFlowEvidence(logPath);

    expect(summary).toContain("Latest completed correlationId: stream-corr");
    expect(summary).toContain("Observed stage chain: outbound_attempt -> outbound_result");
    expect(summary).toContain("Reply-path status evidence: visible_reply_delivered");
    expect(summary).toContain("outboundMessageType=interactive");
    expect(summary).toContain("deliveryMessageId=om_stream");
  });

  it("uses gateway dispatch evidence when the reply-flow log is missing", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-reply-flow-"));
    const logPath = path.join(tempDir, "missing-reply-flow.jsonl");
    const gatewayLogPath = path.join(tempDir, "gateway.log");
    await fs.writeFile(
      gatewayLogPath,
      [
        "2026-04-27T16:41:08.052-04:00 [feishu] feishu[default]: Feishu[default] message in group oc_123: live-sync-check 84d8695",
        "2026-04-27T16:41:18.790-04:00 [feishu] feishu[default]: dispatch complete (queuedFinal=true, replies=1)",
      ].join("\n"),
      "utf8",
    );

    const summary = await summarizeRecentFeishuReplyFlowEvidence(logPath, gatewayLogPath);

    expect(summary).toContain("Recent Feishu/Lark Gateway Dispatch Evidence");
    expect(summary).toContain("Latest gateway message preview: live-sync-check 84d8695");
    expect(summary).toContain("Latest gateway dispatch status: queuedFinal=true, replies=1");
    expect(summary).toContain(
      "Reply-path status evidence: gateway_dispatch_completed_without_delivery_result",
    );
    expect(summary).toContain("weaker than feishu-reply-flow outbound_result evidence");
  });

  it("keeps newer gateway evidence ahead of stale reply-flow evidence", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-reply-flow-"));
    const logPath = path.join(tempDir, "feishu-reply-flow.jsonl");
    const gatewayLogPath = path.join(tempDir, "gateway.log");
    await fs.writeFile(
      logPath,
      [
        JSON.stringify({ correlationId: "stale-corr", stage: "inbound", recordedAtMs: 10 }),
        JSON.stringify({
          correlationId: "stale-corr",
          stage: "dispatch_complete",
          recordedAtMs: 20,
        }),
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      gatewayLogPath,
      [
        "2026-04-27T16:41:08.052-04:00 [feishu] feishu[default]: Feishu[default] message in group oc_123: newer live check",
        "2026-04-27T16:41:18.790-04:00 [feishu] feishu[default]: dispatch complete (queuedFinal=true, replies=1)",
      ].join("\n"),
      "utf8",
    );

    const summary = await summarizeRecentFeishuReplyFlowEvidence(logPath, gatewayLogPath);

    expect(summary).toContain("Recent Feishu/Lark Gateway Dispatch Evidence");
    expect(summary).toContain("newer live check");
    expect(summary).not.toContain("Latest completed correlationId: stale-corr");
  });
});
