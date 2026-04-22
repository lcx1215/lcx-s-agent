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

  const latestObserved = Array.from(groups.entries()).toSorted(
    (a, b) => b[1].latestRecordedAtMs - a[1].latestRecordedAtMs,
  )[0];
  const latestCompleted = Array.from(groups.entries())
    .filter(([, entry]) => typeof entry.completedAtMs === "number")
    .toSorted((a, b) => (b[1].completedAtMs ?? 0) - (a[1].completedAtMs ?? 0))[0];
  if (!latestObserved && !latestCompleted) {
    return undefined;
  }

  const summarizeEntry = (
    label: string,
    correlationId: string,
    entry: {
      stages: Set<string>;
      outboundResult?: FeishuReplyFlowRecord;
      completedAtMs?: number;
    },
  ): string[] => {
    const observedStages = FEISHU_REPLY_FLOW_STAGE_ORDER.filter((stage) => entry.stages.has(stage));
    const outbound = entry.outboundResult;
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
    const status = entry.completedAtMs ? "completed" : "in_progress_or_partial";
    return [
      `${label} correlationId: ${correlationId}`,
      `${label} status: ${status}`,
      `${label} stage chain: ${observedStages.join(" -> ") || "(none)"}`,
      outboundFields.length > 0
        ? `${label} outbound_result: ${outboundFields.join(", ")}`
        : `${label} outbound_result: unavailable`,
    ];
  };

  const lines = [
    "## Recent Feishu/Lark Reply Flow Evidence",
    "Use this local artifact summary as the primary truth for Feishu/Lark reply-path verification questions.",
    "Do not treat generic watchdog send lines or unrelated daily-brief artifacts as stronger evidence than this reply-flow record.",
    "For user-facing verification conclusions, treat Latest completed as authoritative.",
    "Treat Latest observed only as a local snapshot that may still advance before the reply is delivered.",
  ];

  if (latestObserved) {
    lines.push(...summarizeEntry("Latest observed", latestObserved[0], latestObserved[1]));
  }
  if (latestCompleted && latestCompleted[0] !== latestObserved?.[0]) {
    lines.push(...summarizeEntry("Latest completed", latestCompleted[0], latestCompleted[1]));
  } else if (latestCompleted) {
    lines.push("Latest completed matches latest observed.");
  }

  return lines.join("\n");
}
