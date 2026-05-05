import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type FeishuReplyFlowStage =
  | "dispatch_start"
  | "outbound_attempt"
  | "outbound_result"
  | "dispatch_error"
  | "dispatch_complete";

export type FeishuReplyFlowRecord = {
  correlationId: string;
  stage: FeishuReplyFlowStage;
  accountId?: string;
  messageId?: string;
  chatId?: string;
  agentId?: string;
  replyKind?: string;
  sendMode?: string;
  textPreview?: string;
  deliveryMessageId?: string;
  deliveryStatus?: "success" | "failed";
  feishuCode?: number;
  feishuMsg?: string;
  outboundMessageType?: string;
  receiveIdType?: string;
  usedReplyTarget?: boolean;
  usedFallbackCreate?: boolean;
  error?: string;
};

const FEISHU_REPLY_FLOW_LOG = path.join(
  os.homedir(),
  ".openclaw",
  "logs",
  "feishu-reply-flow.jsonl",
);

function trimPreview(text: string | undefined): string | undefined {
  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > 240 ? normalized.slice(0, 237) + "..." : normalized;
}

export async function recordFeishuReplyFlowEvent(
  record: FeishuReplyFlowRecord,
  logPath = FEISHU_REPLY_FLOW_LOG,
): Promise<void> {
  try {
    const recordedAtMs = Date.now();
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(
      logPath,
      `${JSON.stringify({
        kind: "feishu_reply_flow",
        ...record,
        textPreview: trimPreview(record.textPreview),
        recordedAtMs,
        recordedAt: new Date(recordedAtMs).toISOString(),
      })}\n`,
      "utf8",
    );
  } catch {
    // Reply-flow audit must never block the user-facing Lark reply path.
  }
}
