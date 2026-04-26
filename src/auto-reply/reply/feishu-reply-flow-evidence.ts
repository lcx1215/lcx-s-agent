import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type FeishuReplyFlowRecord = {
  correlationId?: string;
  stage?: string;
  recordedAtMs?: number;
  deliveryStatus?: string;
  feishuCode?: number;
  feishuMsg?: string;
  outboundMessageType?: string;
  receiveIdType?: string;
  usedReplyTarget?: boolean;
  usedFallbackCreate?: boolean;
  deliveryMessageId?: string;
};

const DEFAULT_FEISHU_REPLY_FLOW_LOG = path.join(
  os.homedir(),
  ".openclaw",
  "logs",
  "feishu-reply-flow.jsonl",
);

const FEISHU_REPLY_FLOW_STAGE_ORDER = [
  "inbound",
  "route",
  "dispatch_start",
  "outbound_attempt",
  "outbound_result",
  "dispatch_error",
  "dispatch_complete",
] as const;

async function readTailText(filePath: string, maxBytes = 262_144): Promise<string | undefined> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const stat = await handle.stat();
      if (stat.size <= 0) {
        return undefined;
      }
      const start = Math.max(0, stat.size - maxBytes);
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      const text = buffer.toString("utf8");
      return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export async function summarizeRecentFeishuReplyFlowEvidence(
  logPath = DEFAULT_FEISHU_REPLY_FLOW_LOG,
): Promise<string | undefined> {
  const tail = await readTailText(logPath);
  if (!tail?.trim()) {
    return undefined;
  }

  const groups = new Map<
    string,
    {
      latestRecordedAtMs: number;
      completedAtMs?: number;
      stages: Set<string>;
      outboundResult?: FeishuReplyFlowRecord;
    }
  >();

  for (const line of tail.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: FeishuReplyFlowRecord;
    try {
      parsed = JSON.parse(trimmed) as FeishuReplyFlowRecord;
    } catch {
      continue;
    }
    const correlationId = parsed.correlationId?.trim();
    if (!correlationId) {
      continue;
    }
    const entry = groups.get(correlationId) ?? {
      latestRecordedAtMs: 0,
      stages: new Set<string>(),
    };
    const recordedAtMs =
      typeof parsed.recordedAtMs === "number" && Number.isFinite(parsed.recordedAtMs)
        ? parsed.recordedAtMs
        : 0;
    entry.latestRecordedAtMs = Math.max(entry.latestRecordedAtMs, recordedAtMs);
    if (parsed.stage?.trim()) {
      entry.stages.add(parsed.stage.trim());
    }
    if (parsed.stage === "dispatch_complete") {
      entry.completedAtMs = recordedAtMs;
    }
    if (parsed.stage === "outbound_result") {
      entry.outboundResult = parsed;
    }
    groups.set(correlationId, entry);
  }

  const latestCompleted = Array.from(groups.entries())
    .filter(([, entry]) => typeof entry.completedAtMs === "number")
    .toSorted((a, b) => (b[1].completedAtMs ?? 0) - (a[1].completedAtMs ?? 0))[0];
  if (!latestCompleted) {
    return undefined;
  }

  const [correlationId, entry] = latestCompleted;
  const observedStages = FEISHU_REPLY_FLOW_STAGE_ORDER.filter((stage) => entry.stages.has(stage));
  const outbound = entry.outboundResult;
  const outboundSucceeded = outbound?.deliveryStatus === "success" && outbound.feishuCode === 0;
  const replyPathStatus = outboundSucceeded
    ? "visible_reply_delivered"
    : outbound
      ? "reply_attempt_recorded_but_not_success"
      : "dispatch_completed_without_outbound_result";
  const outboundFields = [
    outbound?.deliveryStatus ? `deliveryStatus=${outbound.deliveryStatus}` : null,
    typeof outbound?.feishuCode === "number" ? `feishuCode=${outbound.feishuCode}` : null,
    outbound?.feishuMsg ? `feishuMsg=${outbound.feishuMsg}` : null,
    outbound?.outboundMessageType ? `outboundMessageType=${outbound.outboundMessageType}` : null,
    outbound?.receiveIdType ? `receiveIdType=${outbound.receiveIdType}` : null,
    typeof outbound?.usedReplyTarget === "boolean"
      ? `usedReplyTarget=${String(outbound.usedReplyTarget)}`
      : null,
    typeof outbound?.usedFallbackCreate === "boolean"
      ? `usedFallbackCreate=${String(outbound.usedFallbackCreate)}`
      : null,
    outbound?.deliveryMessageId ? `deliveryMessageId=${outbound.deliveryMessageId}` : null,
  ].filter(Boolean);

  return [
    "## Recent Feishu/Lark Reply Flow Evidence",
    "Use this local artifact summary as the primary truth for Feishu/Lark reply-path verification questions.",
    "Do not treat generic watchdog send lines or unrelated daily-brief artifacts as stronger evidence than this reply-flow record.",
    `Latest completed correlationId: ${correlationId}`,
    `Observed stage chain: ${observedStages.join(" -> ") || "(none)"}`,
    `Reply-path status evidence: ${replyPathStatus}`,
    outboundFields.length > 0
      ? `Latest outbound_result: ${outboundFields.join(", ")}`
      : "Latest outbound_result: unavailable",
    "Boundary: this proves only the recorded reply delivery layer. It is not proof of source migration, build, restart, live probe, or full live-fixed state.",
  ].join("\n");
}
