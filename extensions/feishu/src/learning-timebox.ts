import fs from "node:fs/promises";
import path from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import {
  listAgentIds,
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
} from "../../../src/agents/agent-scope.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { readFileWithinRoot, writeFileWithinRoot } from "../../../src/infra/fs-safe.js";
import { recordOperationalAnomaly } from "../../../src/infra/operational-anomalies.js";
import { runFeishuLearningCouncil } from "./learning-council.js";
import { sendMessageFeishu } from "./send.js";

export type LearningTimeboxRequest = {
  durationMinutes: number;
  durationLabel: string;
};

type LearningTimeboxState = {
  version: 1;
  sessionId: string;
  laneKey: string;
  processBound: true;
  status: "running" | "completed" | "failed" | "interrupted";
  userMessage: string;
  startedAt: string;
  deadlineAt: string;
  lastHeartbeatAt: string;
  requestedDurationMinutes: number;
  intervalMs: number;
  initialMessageId: string;
  initialLead: string;
  iterationsCompleted: number;
  iterationsFailed: number;
  lastLead: string;
  accountId: string;
  chatId: string;
  routeAgentId: string;
  sessionKey: string;
  receiptsPath: string;
};

type LearningTimeboxReceipt =
  | {
      type: "session_started";
      at: string;
      sessionId: string;
      requestedDurationMinutes: number;
      intervalMs: number;
      deadlineAt: string;
      processBound: true;
    }
  | {
      type: "iteration_completed";
      at: string;
      sessionId: string;
      iteration: number;
      lead: string;
      artifactMessageId: string;
    }
  | {
      type: "iteration_failed";
      at: string;
      sessionId: string;
      iteration: number;
      error: string;
    }
  | {
      type: "session_finished";
      at: string;
      sessionId: string;
      status: "completed" | "failed";
      iterationsCompleted: number;
      iterationsFailed: number;
      finalMessageId?: string;
    }
  | {
      type: "session_interrupted";
      at: string;
      sessionId: string;
      reason: "startup_reconcile";
      previousHeartbeatAt: string;
      deadlineAt: string;
    }
  | {
      type: "session_resumed";
      at: string;
      sessionId: string;
      reason: "startup_reconcile";
      previousHeartbeatAt: string;
      deadlineAt: string;
    };

type ActiveLearningTimebox = {
  state: LearningTimeboxState;
  timer?: NodeJS.Timeout;
  consecutiveFailures: number;
};

type LearningTimeboxStartResult =
  | { status: "not_requested" }
  | {
      status: "started";
      sessionId: string;
      deadlineAt: string;
      durationLabel: string;
      intervalMinutes: number;
      receiptsPath: string;
      processBound: true;
    }
  | {
      status: "already_running";
      sessionId: string;
      deadlineAt: string;
      durationLabel: string;
      receiptsPath: string;
    }
  | {
      status: "failed_to_start";
      durationLabel: string;
      reason: string;
    };

export type LearningTimeboxPreflightResult =
  | { status: "not_requested" }
  | { status: "eligible" }
  | ({ status: "already_running"; durationLabel: string } & ActiveLearningTimeboxSnapshot);

export type ActiveLearningTimeboxSnapshot = {
  sessionId: string;
  deadlineAt: string;
  receiptsPath: string;
};

export type LatestLearningTimeboxSnapshot = {
  sessionId: string;
  status: "running" | "completed" | "failed" | "interrupted" | "overdue";
  deadlineAt: string;
  lastHeartbeatAt: string;
  iterationsCompleted: number;
  iterationsFailed: number;
  receiptsPath: string;
};

const ACTIVE_LEARNING_TIMEBOXES = new Map<string, ActiveLearningTimebox>();
const DEFAULT_TIMEBOX_INTERVAL_MS = 10 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 2;

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildTimeboxLaneKey(params: { accountId: string; chatId: string }): string {
  return `learning_command:${params.accountId}:${params.chatId}`;
}

function buildTimeboxStateRelativePath(sessionId: string): string {
  return `memory/feishu-learning-timeboxes/${sessionId}.json`;
}

function buildTimeboxReceiptsRelativePath(sessionId: string): string {
  return `memory/feishu-learning-timeboxes/${sessionId}.receipts.jsonl`;
}

function buildTimeboxDirRelativePath(): string {
  return "memory/feishu-learning-timeboxes";
}

function isLearningTimeboxDeadlineExpired(deadlineAt: string): boolean {
  const deadlineMs = new Date(deadlineAt).getTime();
  return Number.isFinite(deadlineMs) && deadlineMs <= Date.now();
}

function normalizeLearningTimeboxReadStatus(
  state: Pick<LearningTimeboxState, "status" | "deadlineAt">,
): "running" | "completed" | "failed" | "interrupted" | "overdue" {
  if (state.status === "running" && isLearningTimeboxDeadlineExpired(state.deadlineAt)) {
    return "overdue";
  }
  return state.status;
}

function pruneExpiredActiveLearningTimebox(laneKey: string): ActiveLearningTimebox | undefined {
  const active = ACTIVE_LEARNING_TIMEBOXES.get(laneKey);
  if (!active) {
    return undefined;
  }
  if (active.state.status !== "running") {
    return active;
  }
  if (!isLearningTimeboxDeadlineExpired(active.state.deadlineAt)) {
    return active;
  }
  if (active.timer) {
    clearTimeout(active.timer);
    active.timer = undefined;
  }
  ACTIVE_LEARNING_TIMEBOXES.delete(laneKey);
  return undefined;
}

function parseLearningTimeboxRequest(userMessage: string): LearningTimeboxRequest | undefined {
  const normalized = userMessage.trim();
  if (/(一个小时|一小时)/iu.test(normalized)) {
    return { durationMinutes: 60, durationLabel: "1小时" };
  }
  if (/(两个小时|两小时|二小时)/iu.test(normalized)) {
    return { durationMinutes: 120, durationLabel: "2小时" };
  }
  if (/(半小时|半个小时|half an hour)/iu.test(normalized)) {
    return { durationMinutes: 30, durationLabel: "半小时" };
  }
  const hourMatch = normalized.match(
    /(?:(\d+(?:\.\d+)?)\s*个?\s*小时|(\d+(?:\.\d+)?)\s*h(?:our)?s?\b)/iu,
  );
  if (hourMatch) {
    const raw = hourMatch[1] ?? hourMatch[2];
    const hours = Number(raw);
    if (Number.isFinite(hours) && hours > 0) {
      return {
        durationMinutes: Math.round(hours * 60),
        durationLabel: `${raw}小时`,
      };
    }
  }
  const minuteMatch = normalized.match(
    /(?:(\d+(?:\.\d+)?)\s*分(?:钟)?|(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?\b)/iu,
  );
  if (minuteMatch) {
    const raw = minuteMatch[1] ?? minuteMatch[2];
    const minutes = Number(raw);
    if (Number.isFinite(minutes) && minutes > 0) {
      return {
        durationMinutes: Math.round(minutes),
        durationLabel: `${raw}分钟`,
      };
    }
  }
  return undefined;
}

export function peekFeishuLearningTimeboxSession(params: {
  accountId: string;
  chatId: string;
  userMessage: string;
}): LearningTimeboxPreflightResult {
  const request = parseLearningTimeboxRequest(params.userMessage);
  if (!request) {
    return { status: "not_requested" };
  }
  const existing = findRunningFeishuLearningTimeboxSession(params);
  if (existing) {
    return {
      status: "already_running",
      sessionId: existing.sessionId,
      deadlineAt: existing.deadlineAt,
      durationLabel: request.durationLabel,
      receiptsPath: existing.receiptsPath,
    };
  }
  return { status: "eligible" };
}

export function findRunningFeishuLearningTimeboxSession(params: {
  accountId: string;
  chatId: string;
}): ActiveLearningTimeboxSnapshot | undefined {
  const laneKey = buildTimeboxLaneKey({
    accountId: params.accountId,
    chatId: params.chatId,
  });
  const existing = pruneExpiredActiveLearningTimebox(laneKey);
  if (!existing || existing.state.status !== "running") {
    return undefined;
  }
  return {
    sessionId: existing.state.sessionId,
    deadlineAt: existing.state.deadlineAt,
    receiptsPath: existing.state.receiptsPath,
  };
}

export async function findLatestFeishuLearningTimeboxSession(params: {
  cfg?: ClawdbotConfig;
  workspaceDir?: string;
  accountId: string;
  chatId: string;
}): Promise<LatestLearningTimeboxSnapshot | undefined> {
  const laneKey = buildTimeboxLaneKey({
    accountId: params.accountId,
    chatId: params.chatId,
  });
  const active = pruneExpiredActiveLearningTimebox(laneKey);
  if (active) {
    return {
      sessionId: active.state.sessionId,
      status: normalizeLearningTimeboxReadStatus(active.state),
      deadlineAt: active.state.deadlineAt,
      lastHeartbeatAt: active.state.lastHeartbeatAt,
      iterationsCompleted: active.state.iterationsCompleted,
      iterationsFailed: active.state.iterationsFailed,
      receiptsPath: active.state.receiptsPath,
    };
  }

  let latest: LearningTimeboxState | undefined;
  const workspaceDirs =
    params.cfg || params.workspaceDir
      ? resolveLearningTimeboxWorkspaceDirs({
          cfg: (params.cfg ?? {}) as ClawdbotConfig,
          workspaceDir: params.workspaceDir,
        })
      : [];
  for (const workspaceDir of workspaceDirs) {
    const dirPath = path.join(workspaceDir, buildTimeboxDirRelativePath());
    let fileNames: string[] = [];
    try {
      fileNames = await fs.readdir(dirPath);
    } catch {
      continue;
    }
    for (const fileName of fileNames) {
      if (!fileName.endsWith(".json") || fileName.endsWith(".receipts.jsonl")) {
        continue;
      }
      try {
        const sessionId = fileName.replace(/\.json$/u, "");
        const state = JSON.parse(
          (
            await readFileWithinRoot({
              rootDir: workspaceDir,
              relativePath: buildTimeboxStateRelativePath(sessionId),
              maxBytes: 256_000,
            })
          ).buffer.toString("utf-8"),
        ) as LearningTimeboxState;
        if (state.laneKey !== laneKey) {
          continue;
        }
        if (!latest) {
          latest = state;
          continue;
        }
        const latestStartedAt = new Date(latest.startedAt).getTime();
        const currentStartedAt = new Date(state.startedAt).getTime();
        if (
          Number.isFinite(currentStartedAt) &&
          (!Number.isFinite(latestStartedAt) || currentStartedAt > latestStartedAt)
        ) {
          latest = state;
        }
      } catch {
        continue;
      }
    }
  }

  if (!latest) {
    return undefined;
  }

  return {
    sessionId: latest.sessionId,
    status: normalizeLearningTimeboxReadStatus(latest),
    deadlineAt: latest.deadlineAt,
    lastHeartbeatAt: latest.lastHeartbeatAt,
    iterationsCompleted: latest.iterationsCompleted,
    iterationsFailed: latest.iterationsFailed,
    receiptsPath: latest.receiptsPath,
  };
}

function extractLeadLineFromCouncilReply(replyText: string): string {
  const lines = replyText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const bullet = lines.find((line) => /^-\s+/.test(line));
  if (bullet) {
    return bullet.replace(/^-\s+/, "").trim();
  }
  return lines.find((line) => !/^#+\s+/.test(line)) ?? "本轮没有提炼出稳定结论。";
}

function resolveTimeboxIntervalMs(request: LearningTimeboxRequest, overrideMs?: number): number {
  if (typeof overrideMs === "number" && Number.isFinite(overrideMs) && overrideMs > 0) {
    return overrideMs;
  }
  if (request.durationMinutes <= 30) {
    return 5 * 60 * 1000;
  }
  return DEFAULT_TIMEBOX_INTERVAL_MS;
}

function formatDurationLabelFromMinutes(minutes: number): string {
  if (minutes === 30) {
    return "半小时";
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return Number.isInteger(hours) ? `${hours}小时` : `${minutes}分钟`;
  }
  return `${minutes}分钟`;
}

function resolveLearningTimeboxWorkspaceDir(params: {
  cfg: ClawdbotConfig;
  workspaceDir?: string;
}): string | undefined {
  const explicit = params.workspaceDir?.trim();
  if (explicit) {
    return explicit;
  }
  const cfg = params.cfg as OpenClawConfig;
  const agentId = resolveDefaultAgentId(cfg);
  return resolveAgentWorkspaceDir(cfg, agentId);
}

function resolveLearningTimeboxWorkspaceDirs(params: {
  cfg: ClawdbotConfig;
  workspaceDir?: string;
}): string[] {
  const explicit = params.workspaceDir?.trim();
  if (explicit) {
    return [explicit];
  }
  const cfg = params.cfg as OpenClawConfig;
  const dirs = listAgentIds(cfg)
    .map((agentId) => resolveAgentWorkspaceDir(cfg, agentId))
    .filter((dir): dir is string => typeof dir === "string" && dir.trim().length > 0);
  return Array.from(new Set(dirs));
}

async function writeTimeboxState(params: {
  workspaceDir: string;
  state: LearningTimeboxState;
}): Promise<void> {
  await writeFileWithinRoot({
    rootDir: params.workspaceDir,
    relativePath: buildTimeboxStateRelativePath(params.state.sessionId),
    data: `${JSON.stringify(params.state, null, 2)}\n`,
    encoding: "utf-8",
    mkdir: true,
  });
}

async function appendTimeboxReceipt(params: {
  workspaceDir: string;
  sessionId: string;
  receipt: LearningTimeboxReceipt;
}): Promise<void> {
  const relativePath = buildTimeboxReceiptsRelativePath(params.sessionId);
  let existing = "";
  try {
    existing = (
      await readFileWithinRoot({
        rootDir: params.workspaceDir,
        relativePath,
        maxBytes: 512_000,
      })
    ).buffer.toString("utf-8");
  } catch {
    existing = "";
  }
  const next = `${existing}${JSON.stringify(params.receipt)}\n`;
  await writeFileWithinRoot({
    rootDir: params.workspaceDir,
    relativePath,
    data: next,
    encoding: "utf-8",
    mkdir: true,
  });
}

async function sendTimeboxSummary(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  chatId: string;
  state: LearningTimeboxState;
  durationLabel: string;
}): Promise<string | undefined> {
  const summary = [
    params.state.status === "completed" ? "限时学习已结束" : "限时学习提前结束",
    `- 时长: ${params.durationLabel}`,
    `- 追加轮次: ${params.state.iterationsCompleted}`,
    `- 失败轮次: ${params.state.iterationsFailed}`,
    `- 最后一轮学到: ${params.state.lastLead || params.state.initialLead}`,
    "- 说明: 这是进程内 session；如果网关重启或进程退出，这类 session 会中断。",
    `- session: ${params.state.sessionId}`,
  ].join("\n");
  const result = await sendMessageFeishu({
    cfg: params.cfg,
    to: `chat:${params.chatId}`,
    text: summary,
    accountId: params.accountId,
  });
  return result.messageId;
}

async function finishLearningTimeboxSession(params: {
  laneKey: string;
  workspaceDir: string;
  cfg: ClawdbotConfig;
  durationLabel: string;
  status: "completed" | "failed";
}): Promise<void> {
  const active = ACTIVE_LEARNING_TIMEBOXES.get(params.laneKey);
  if (!active) {
    return;
  }
  if (active.timer) {
    clearTimeout(active.timer);
    active.timer = undefined;
  }
  active.state.status = params.status;
  active.state.lastHeartbeatAt = new Date().toISOString();
  await writeTimeboxState({
    workspaceDir: params.workspaceDir,
    state: active.state,
  });
  let finalMessageId: string | undefined;
  try {
    finalMessageId = await sendTimeboxSummary({
      cfg: params.cfg,
      accountId: active.state.accountId,
      chatId: active.state.chatId,
      state: active.state,
      durationLabel: params.durationLabel,
    });
  } catch (error) {
    await recordOperationalAnomaly({
      cfg: params.cfg as OpenClawConfig,
      workspaceDir: params.workspaceDir,
      category: "provider_degradation",
      severity: "medium",
      source: "feishu.learning_command",
      foundationTemplate: "outcome-review",
      problem: "failed to send learning timebox completion summary",
      evidence: [
        `session_id=${active.state.sessionId}`,
        `chat_id=${active.state.chatId}`,
        `error=${String(error)}`,
      ],
      impact:
        "the timeboxed learning session finished, but the operator did not receive the completion summary",
      suggestedScope:
        "smallest-safe-patch only; inspect Feishu send health or completion-summary delivery for learning timeboxes",
    });
  }
  await appendTimeboxReceipt({
    workspaceDir: params.workspaceDir,
    sessionId: active.state.sessionId,
    receipt: {
      type: "session_finished",
      at: new Date().toISOString(),
      sessionId: active.state.sessionId,
      status: params.status,
      iterationsCompleted: active.state.iterationsCompleted,
      iterationsFailed: active.state.iterationsFailed,
      finalMessageId,
    },
  });
  ACTIVE_LEARNING_TIMEBOXES.delete(params.laneKey);
}

async function scheduleNextIteration(params: {
  laneKey: string;
  workspaceDir: string;
  cfg: ClawdbotConfig;
  durationLabel: string;
  intervalMs: number;
  delayMsOverride?: number;
}): Promise<void> {
  const active = ACTIVE_LEARNING_TIMEBOXES.get(params.laneKey);
  if (!active || active.state.status !== "running") {
    return;
  }
  const remainingMs = new Date(active.state.deadlineAt).getTime() - Date.now();
  if (remainingMs <= 0) {
    await finishLearningTimeboxSession({
      laneKey: params.laneKey,
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
      durationLabel: params.durationLabel,
      status:
        active.state.iterationsCompleted > 0 || active.state.initialLead ? "completed" : "failed",
    });
    return;
  }
  const nextDelayMs =
    typeof params.delayMsOverride === "number" &&
    Number.isFinite(params.delayMsOverride) &&
    params.delayMsOverride >= 0
      ? Math.min(params.delayMsOverride, remainingMs)
      : Math.min(params.intervalMs, remainingMs);
  active.timer = setTimeout(async () => {
    const current = ACTIVE_LEARNING_TIMEBOXES.get(params.laneKey);
    if (!current || current.state.status !== "running") {
      return;
    }
    if (Date.now() >= new Date(current.state.deadlineAt).getTime()) {
      await finishLearningTimeboxSession({
        laneKey: params.laneKey,
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
        durationLabel: params.durationLabel,
        status:
          current.state.iterationsCompleted > 0 || current.state.initialLead
            ? "completed"
            : "failed",
      });
      return;
    }

    const nextIteration = current.state.iterationsCompleted + current.state.iterationsFailed + 1;
    try {
      const reply = await runFeishuLearningCouncil({
        cfg: params.cfg,
        userMessage: current.state.userMessage,
        routeAgentId: current.state.routeAgentId,
        sessionKey: current.state.sessionKey,
        messageId: `${current.state.initialMessageId}-timebox-${nextIteration}`,
        workspaceDir: params.workspaceDir,
      });
      current.state.iterationsCompleted += 1;
      current.consecutiveFailures = 0;
      current.state.lastHeartbeatAt = new Date().toISOString();
      current.state.lastLead = extractLeadLineFromCouncilReply(reply);
      await writeTimeboxState({
        workspaceDir: params.workspaceDir,
        state: current.state,
      });
      await appendTimeboxReceipt({
        workspaceDir: params.workspaceDir,
        sessionId: current.state.sessionId,
        receipt: {
          type: "iteration_completed",
          at: new Date().toISOString(),
          sessionId: current.state.sessionId,
          iteration: nextIteration,
          lead: current.state.lastLead,
          artifactMessageId: `${current.state.initialMessageId}-timebox-${nextIteration}`,
        },
      });
    } catch (error) {
      current.state.iterationsFailed += 1;
      current.consecutiveFailures += 1;
      current.state.lastHeartbeatAt = new Date().toISOString();
      await writeTimeboxState({
        workspaceDir: params.workspaceDir,
        state: current.state,
      });
      await appendTimeboxReceipt({
        workspaceDir: params.workspaceDir,
        sessionId: current.state.sessionId,
        receipt: {
          type: "iteration_failed",
          at: new Date().toISOString(),
          sessionId: current.state.sessionId,
          iteration: nextIteration,
          error: String(error),
        },
      });
      await recordOperationalAnomaly({
        cfg: params.cfg as OpenClawConfig,
        workspaceDir: params.workspaceDir,
        category: "learning_quality_drift",
        severity: "medium",
        source: "feishu.learning_command",
        foundationTemplate: "outcome-review",
        problem: "background learning timebox iteration failed",
        evidence: [
          `session_id=${current.state.sessionId}`,
          `iteration=${nextIteration}`,
          `error=${String(error)}`,
        ],
        impact:
          "the timeboxed learning session did not complete one scheduled iteration, so the operator may receive fewer study passes than requested",
        suggestedScope:
          "smallest-safe-patch only; inspect learning timebox iteration execution or role-level provider health",
      });
      if (current.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        await finishLearningTimeboxSession({
          laneKey: params.laneKey,
          workspaceDir: params.workspaceDir,
          cfg: params.cfg,
          durationLabel: params.durationLabel,
          status: "failed",
        });
        return;
      }
    }
    await scheduleNextIteration(params);
  }, nextDelayMs);
}

export async function startFeishuLearningTimeboxSession(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  chatId: string;
  routeAgentId: string;
  sessionKey: string;
  messageId: string;
  userMessage: string;
  workspaceDir?: string;
  initialCouncilReply: string;
  intervalMsOverride?: number;
  durationMsOverride?: number;
}): Promise<LearningTimeboxStartResult> {
  const request = parseLearningTimeboxRequest(params.userMessage);
  if (!request) {
    return { status: "not_requested" };
  }
  if (!params.workspaceDir?.trim()) {
    await recordOperationalAnomaly({
      cfg: params.cfg as OpenClawConfig,
      category: "write_edit_failure",
      severity: "medium",
      source: "feishu.learning_command",
      foundationTemplate: "outcome-review",
      problem: "failed to start learning timebox because workspace dir is unavailable",
      evidence: [
        `chat_id=${params.chatId}`,
        `message_id=${params.messageId}`,
        `requested_duration=${request.durationLabel}`,
      ],
      impact:
        "the timeboxed learning request was downgraded to a single learning pass because no workspace-backed receipts could be written",
      suggestedScope:
        "smallest-safe-patch only; restore workspace resolution before starting bounded learning timeboxes",
    });
    return {
      status: "failed_to_start",
      durationLabel: request.durationLabel,
      reason: "workspace_unavailable",
    };
  }

  const laneKey = buildTimeboxLaneKey({
    accountId: params.accountId,
    chatId: params.chatId,
  });
  const existing = pruneExpiredActiveLearningTimebox(laneKey);
  if (existing && existing.state.status === "running") {
    return {
      status: "already_running",
      sessionId: existing.state.sessionId,
      deadlineAt: existing.state.deadlineAt,
      durationLabel: request.durationLabel,
      receiptsPath: existing.state.receiptsPath,
    };
  }

  const startedAtMs = Date.now();
  const durationMs =
    typeof params.durationMsOverride === "number" &&
    Number.isFinite(params.durationMsOverride) &&
    params.durationMsOverride > 0
      ? params.durationMsOverride
      : request.durationMinutes * 60 * 1000;
  const intervalMs = resolveTimeboxIntervalMs(request, params.intervalMsOverride);
  const sessionId = `${new Date(startedAtMs).toISOString().replaceAll(":", "-")}__${sanitizePathSegment(
    params.chatId,
  )}`;
  const state: LearningTimeboxState = {
    version: 1,
    sessionId,
    laneKey,
    processBound: true,
    status: "running",
    userMessage: params.userMessage,
    startedAt: new Date(startedAtMs).toISOString(),
    deadlineAt: new Date(startedAtMs + durationMs).toISOString(),
    lastHeartbeatAt: new Date(startedAtMs).toISOString(),
    requestedDurationMinutes: request.durationMinutes,
    intervalMs,
    initialMessageId: params.messageId,
    initialLead: extractLeadLineFromCouncilReply(params.initialCouncilReply),
    iterationsCompleted: 0,
    iterationsFailed: 0,
    lastLead: extractLeadLineFromCouncilReply(params.initialCouncilReply),
    accountId: params.accountId,
    chatId: params.chatId,
    routeAgentId: params.routeAgentId,
    sessionKey: params.sessionKey,
    receiptsPath: buildTimeboxReceiptsRelativePath(sessionId),
  };
  ACTIVE_LEARNING_TIMEBOXES.set(laneKey, {
    state,
    consecutiveFailures: 0,
  });
  await writeTimeboxState({
    workspaceDir: params.workspaceDir,
    state,
  });
  await appendTimeboxReceipt({
    workspaceDir: params.workspaceDir,
    sessionId,
    receipt: {
      type: "session_started",
      at: new Date().toISOString(),
      sessionId,
      requestedDurationMinutes: request.durationMinutes,
      intervalMs,
      deadlineAt: state.deadlineAt,
      processBound: true,
    },
  });
  await scheduleNextIteration({
    laneKey,
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    durationLabel: request.durationLabel,
    intervalMs,
  });
  return {
    status: "started",
    sessionId,
    deadlineAt: state.deadlineAt,
    durationLabel: request.durationLabel,
    intervalMinutes: Math.max(1, Math.round(intervalMs / 60_000)),
    receiptsPath: state.receiptsPath,
    processBound: true,
  };
}

export type LearningTimeboxStartupReconcileResult = {
  scanned: number;
  resumed: number;
  interrupted: number;
  notified: number;
};

export async function reconcileFeishuLearningTimeboxesOnStartup(params: {
  cfg: ClawdbotConfig;
  runtime?: { log?: (...args: any[]) => void; error?: (...args: any[]) => void };
  workspaceDir?: string;
}): Promise<LearningTimeboxStartupReconcileResult> {
  const workspaceDirs = resolveLearningTimeboxWorkspaceDirs(params);
  if (workspaceDirs.length === 0) {
    return { scanned: 0, resumed: 0, interrupted: 0, notified: 0 };
  }

  let scanned = 0;
  let resumed = 0;
  let interrupted = 0;
  let notified = 0;
  for (const workspaceDir of workspaceDirs) {
    const dirPath = path.join(workspaceDir, buildTimeboxDirRelativePath());
    let fileNames: string[] = [];
    try {
      fileNames = await fs.readdir(dirPath);
    } catch {
      continue;
    }

    for (const fileName of fileNames) {
      if (!fileName.endsWith(".json") || fileName.endsWith(".receipts.jsonl")) {
        continue;
      }
      scanned += 1;
      const sessionId = fileName.replace(/\.json$/u, "");
      let state: LearningTimeboxState;
      try {
        state = JSON.parse(
          (
            await readFileWithinRoot({
              rootDir: workspaceDir,
              relativePath: buildTimeboxStateRelativePath(sessionId),
              maxBytes: 256_000,
            })
          ).buffer.toString("utf-8"),
        ) as LearningTimeboxState;
      } catch {
        continue;
      }
      if (state.status !== "running") {
        continue;
      }

      const previousHeartbeatAt = state.lastHeartbeatAt;
      const now = Date.now();
      const deadlineMs = new Date(state.deadlineAt).getTime();
      const nextDueMs = new Date(state.lastHeartbeatAt).getTime() + state.intervalMs;
      if (Number.isFinite(deadlineMs) && deadlineMs > now) {
        ACTIVE_LEARNING_TIMEBOXES.set(state.laneKey, {
          state,
          consecutiveFailures: 0,
        });
        await appendTimeboxReceipt({
          workspaceDir,
          sessionId: state.sessionId,
          receipt: {
            type: "session_resumed",
            at: new Date().toISOString(),
            sessionId: state.sessionId,
            reason: "startup_reconcile",
            previousHeartbeatAt: previousHeartbeatAt,
            deadlineAt: state.deadlineAt,
          },
        });
        await scheduleNextIteration({
          laneKey: state.laneKey,
          workspaceDir,
          cfg: params.cfg,
          durationLabel: formatDurationLabelFromMinutes(state.requestedDurationMinutes),
          intervalMs: state.intervalMs,
          delayMsOverride: Math.max(0, nextDueMs - now),
        });
        resumed += 1;
        try {
          await sendMessageFeishu({
            cfg: params.cfg,
            to: `chat:${state.chatId}`,
            accountId: state.accountId,
            text: [
              "上次限时学习已恢复",
              `- 时长请求: ${state.requestedDurationMinutes} 分钟`,
              `- 已完成轮次: ${state.iterationsCompleted}`,
              `- 失败轮次: ${state.iterationsFailed}`,
              `- 上次心跳: ${previousHeartbeatAt}`,
              "- 原因: 网关重启后，未到期的进程内 session 已按当前状态续跑。",
              `- session: ${state.sessionId}`,
            ].join("\n"),
          });
          notified += 1;
        } catch (error) {
          params.runtime?.error?.(
            `feishu: failed to notify resumed learning timebox ${state.sessionId}: ${String(error)}`,
          );
        }
        continue;
      }

      state.status = "interrupted";
      state.lastHeartbeatAt = new Date().toISOString();
      await writeTimeboxState({
        workspaceDir,
        state,
      });
      await appendTimeboxReceipt({
        workspaceDir,
        sessionId: state.sessionId,
        receipt: {
          type: "session_interrupted",
          at: new Date().toISOString(),
          sessionId: state.sessionId,
          reason: "startup_reconcile",
          previousHeartbeatAt,
          deadlineAt: state.deadlineAt,
        },
      });
      interrupted += 1;

      await recordOperationalAnomaly({
        cfg: params.cfg as OpenClawConfig,
        workspaceDir,
        category: "learning_quality_drift",
        severity: "medium",
        source: "feishu.learning_command",
        foundationTemplate: "outcome-review",
        problem: "startup interrupted a process-bound learning timebox",
        evidence: [
          `session_id=${state.sessionId}`,
          `chat_id=${state.chatId}`,
          `deadline_at=${state.deadlineAt}`,
          `previous_heartbeat_at=${previousHeartbeatAt}`,
        ],
        impact:
          "a bounded learning session was left in running state after process exit or restart, so the operator could wrongly assume it was still progressing",
        suggestedScope:
          "smallest-safe-patch only; use startup reconciliation and interrupted-session receipts for process-bound learning timeboxes",
      });

      try {
        await sendMessageFeishu({
          cfg: params.cfg,
          to: `chat:${state.chatId}`,
          accountId: state.accountId,
          text: [
            "上次限时学习已中断",
            `- 时长请求: ${state.requestedDurationMinutes} 分钟`,
            `- 已完成轮次: ${state.iterationsCompleted}`,
            `- 失败轮次: ${state.iterationsFailed}`,
            `- 上次心跳: ${previousHeartbeatAt}`,
            "- 原因: 这是进程内 session；网关重启或进程退出后不会自动续跑。",
            `- session: ${state.sessionId}`,
          ].join("\n"),
        });
        notified += 1;
      } catch (error) {
        params.runtime?.error?.(
          `feishu: failed to notify interrupted learning timebox ${state.sessionId}: ${String(error)}`,
        );
        await recordOperationalAnomaly({
          cfg: params.cfg as OpenClawConfig,
          workspaceDir,
          category: "provider_degradation",
          severity: "medium",
          source: "feishu.learning_command",
          foundationTemplate: "outcome-review",
          problem: "failed to notify interrupted learning timebox on startup",
          evidence: [
            `session_id=${state.sessionId}`,
            `chat_id=${state.chatId}`,
            `error=${String(error)}`,
          ],
          impact:
            "the interrupted session was reconciled on disk, but the operator did not receive the interruption notice",
          suggestedScope:
            "smallest-safe-patch only; inspect Feishu send health for startup interruption notices",
        });
      }
    }
  }

  if (resumed > 0 || interrupted > 0) {
    params.runtime?.log?.(
      `feishu: reconciled learning timeboxes at startup (resumed=${resumed}, interrupted=${interrupted})`,
    );
  }
  return { scanned, resumed, interrupted, notified };
}

export function resetFeishuLearningTimeboxesForTest(): void {
  for (const active of ACTIVE_LEARNING_TIMEBOXES.values()) {
    if (active.timer) {
      clearTimeout(active.timer);
    }
  }
  ACTIVE_LEARNING_TIMEBOXES.clear();
}
