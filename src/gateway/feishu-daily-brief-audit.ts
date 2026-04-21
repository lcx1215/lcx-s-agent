import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { CronEvent } from "../cron/service/state.js";
import type { CronJob } from "../cron/types.js";

export type FeishuDailyBriefDeliveryAuditRecord = {
  kind: "feishu_daily_brief_delivery";
  source: "gateway_cron_finished";
  recordedAtMs: number;
  recordedAt: string;
  jobId: string;
  jobName: string;
  deliveryMode: string;
  deliveryChannel: "feishu";
  accountId?: string;
  sessionId?: string;
  text: string;
};

function trimToOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isFeishuDailyBriefJob(job: CronJob | undefined): job is CronJob {
  if (!job) {
    return false;
  }
  if (job.delivery?.channel !== "feishu") {
    return false;
  }
  const name = trimToOptionalString(job.name)?.toLowerCase() ?? "";
  const description = trimToOptionalString(job.description)?.toLowerCase() ?? "";
  return name.includes("daily brief") || description.includes("daily brief");
}

export function resolveFeishuDailyBriefAuditPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "logs", "feishu-daily-brief-delivery.jsonl");
}

export async function recordGatewayCronFeishuDailyBriefAudit(params: {
  job: CronJob | undefined;
  event: CronEvent;
  env?: NodeJS.ProcessEnv;
}): Promise<FeishuDailyBriefDeliveryAuditRecord | null> {
  if (!isFeishuDailyBriefJob(params.job)) {
    return null;
  }
  if (params.event.action !== "finished" || params.event.deliveryStatus !== "delivered") {
    return null;
  }
  const text = trimToOptionalString(params.event.summary);
  if (!text) {
    return null;
  }

  const recordedAtMs = Date.now();
  const record: FeishuDailyBriefDeliveryAuditRecord = {
    kind: "feishu_daily_brief_delivery",
    source: "gateway_cron_finished",
    recordedAtMs,
    recordedAt: new Date(recordedAtMs).toISOString(),
    jobId: params.job.id,
    jobName: params.job.name,
    deliveryMode: params.job.delivery?.mode ?? "unknown",
    deliveryChannel: "feishu",
    accountId: trimToOptionalString(params.job.delivery?.accountId),
    sessionId: trimToOptionalString(params.event.sessionId),
    text,
  };

  const filePath = resolveFeishuDailyBriefAuditPath(params.env);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf-8");
  return record;
}
