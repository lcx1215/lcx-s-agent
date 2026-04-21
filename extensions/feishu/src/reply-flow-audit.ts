import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type FeishuReplyFlowAuditStage =
  | "inbound"
  | "gate_drop"
  | "route"
  | "dispatch_start"
  | "dispatch_complete"
  | "dispatch_error"
  | "outbound_attempt"
  | "outbound_result";

export type FeishuReplyFlowAuditRecord = {
  kind: "feishu_reply_flow";
  stage: FeishuReplyFlowAuditStage;
  recordedAtMs: number;
  recordedAt: string;
  accountId?: string;
  messageId?: string;
  chatId?: string;
  chatType?: string;
  sessionKey?: string;
  agentId?: string;
  routeMatchedBy?: string;
  contentType?: string;
  textPreview?: string;
  replyKind?: string;
  sendMode?: "message" | "card" | "media";
  deliveryMessageId?: string;
  queuedFinal?: boolean;
  replyCount?: number;
  error?: string;
};

function resolveStateDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (stateOverride) {
    return stateOverride;
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), ["openclaw-vitest", String(process.pid)].join("-"));
  }
  return path.join(os.homedir(), ".openclaw");
}

export function resolveFeishuReplyFlowAuditPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDirFromEnv(env), "logs", "feishu-reply-flow.jsonl");
}

function sanitizePreview(text?: string): string | undefined {
  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, 280);
}

export async function recordFeishuReplyFlowAudit(
  params: Omit<
    FeishuReplyFlowAuditRecord,
    "kind" | "recordedAtMs" | "recordedAt" | "textPreview"
  > & {
    textPreview?: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<FeishuReplyFlowAuditRecord> {
  const recordedAtMs = Date.now();
  const record: FeishuReplyFlowAuditRecord = {
    kind: "feishu_reply_flow",
    stage: params.stage,
    recordedAtMs,
    recordedAt: new Date(recordedAtMs).toISOString(),
    accountId: params.accountId,
    messageId: params.messageId,
    chatId: params.chatId,
    chatType: params.chatType,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    routeMatchedBy: params.routeMatchedBy,
    contentType: params.contentType,
    textPreview: sanitizePreview(params.textPreview),
    replyKind: params.replyKind,
    sendMode: params.sendMode,
    deliveryMessageId: params.deliveryMessageId,
    queuedFinal: params.queuedFinal,
    replyCount: params.replyCount,
    error: params.error,
  };

  const filePath = resolveFeishuReplyFlowAuditPath(params.env);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}
