import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import {
  ToolInputError,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "./common.js";
import {
  ensureFeishuProbeRuntime,
  listMessagesFeishu,
  sendMessageFeishu,
} from "./feishu-live-probe.runtime.js";

const FEISHU_LIVE_PROBE_DIR = path.join("memory", "feishu-live-probes");
const FEISHU_SURFACE_IDS = [
  "control_room",
  "technical_daily",
  "fundamental_research",
  "knowledge_maintenance",
  "ops_audit",
  "learning_command",
  "watchtower",
] as const;

const FeishuLiveProbeSchema = Type.Object({
  surface: optionalStringEnum(FEISHU_SURFACE_IDS),
  chatId: Type.Optional(Type.String()),
  message: Type.String(),
  waitMs: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
  mustContainAny: Type.Optional(Type.Array(Type.String())),
  mustNotContain: Type.Optional(Type.Array(Type.String())),
  writeReceipt: Type.Optional(Type.Boolean()),
  accountId: Type.Optional(Type.String()),
});

type FeishuProbeMessage = {
  messageId: string;
  timestamp?: string;
  authorTag?: string;
  content: string;
};

type FeishuProbeStatus = "passed" | "failed" | "no_reply_observed" | "probe_message_not_found";

type FeishuProbeReceiptSummary = {
  createdAt: string;
  surface: string;
  chatId: string;
  status: string;
  repairHint?: string;
  path: string;
};

type SendProbeDeps = (params: {
  cfg: OpenClawConfig;
  chatId: string;
  message: string;
  accountId?: string;
}) => Promise<{ messageId?: string }>;

type ReadProbeDeps = (params: {
  cfg: OpenClawConfig;
  chatId: string;
  limit: number;
  accountId?: string;
}) => Promise<FeishuProbeMessage[]>;

function normalizeBlock(value?: string): string | undefined {
  const trimmed = value?.trim().replace(/\r\n/g, "\n");
  return trimmed ? trimmed : undefined;
}

function normalizeOneLine(value?: string): string {
  return normalizeBlock(value)?.replace(/\s+/g, " ") ?? "";
}

function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/g, "")
      .replace(/-+$/g, "") || "probe"
  );
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function redactLiveId(value: string): string {
  const normalized = normalizeOneLine(value);
  return normalized ? `redacted:${normalized.length}` : "redacted:0";
}

function redactAuthorTag(value?: string): string {
  const normalized = normalizeOneLine(value);
  if (!normalized) {
    return "unknown-author";
  }
  const [kind] = normalized.split(":", 1);
  return kind ? `${kind}:redacted` : "redacted-author";
}

function redactOptionalLiveId(value?: string): string {
  return value ? redactLiveId(value) : "";
}

function resolveFeishuSurfaceChatId(cfg: OpenClawConfig, surface?: string): string | null {
  const candidate = normalizeBlock(surface);
  if (!candidate) {
    return null;
  }
  const feishuConfig = cfg.channels?.feishu as
    | {
        surfaces?: Record<string, { chatId?: string }>;
      }
    | undefined;
  const chatId = feishuConfig?.surfaces?.[candidate]?.chatId?.trim();
  return chatId || null;
}

function resolveTargetChatId(params: { cfg: OpenClawConfig; surface?: string; chatId?: string }): {
  chatId: string;
  surfaceLabel: string;
} {
  const explicitChatId = normalizeBlock(params.chatId);
  if (explicitChatId) {
    return {
      chatId: explicitChatId,
      surfaceLabel: normalizeBlock(params.surface) || "custom_chat",
    };
  }
  const surface = normalizeBlock(params.surface);
  if (!surface) {
    throw new ToolInputError("surface or chatId required");
  }
  const resolved = resolveFeishuSurfaceChatId(params.cfg, surface);
  if (!resolved) {
    throw new ToolInputError(`No configured Feishu surface chatId for ${surface}`);
  }
  return { chatId: resolved, surfaceLabel: surface };
}

function extractMessageId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { messageId?: unknown; result?: unknown };
  if (typeof record.messageId === "string" && record.messageId.trim()) {
    return record.messageId.trim();
  }
  if (record.result && typeof record.result === "object") {
    const nested = record.result as { messageId?: unknown };
    if (typeof nested.messageId === "string" && nested.messageId.trim()) {
      return nested.messageId.trim();
    }
  }
  return undefined;
}

async function sendFeishuProbe(params: {
  cfg: OpenClawConfig;
  chatId: string;
  message: string;
  accountId?: string;
}): Promise<{ messageId?: string }> {
  ensureFeishuProbeRuntime();
  const result = await sendMessageFeishu({
    cfg: params.cfg,
    to: `chat:${params.chatId}`,
    text: params.message,
    ...(params.accountId ? { accountId: params.accountId } : {}),
  });
  return { messageId: extractMessageId(result) };
}

async function readFeishuProbeMessages(params: {
  cfg: OpenClawConfig;
  chatId: string;
  limit: number;
  accountId?: string;
}): Promise<FeishuProbeMessage[]> {
  return (
    await listMessagesFeishu({
      cfg: params.cfg,
      chatId: params.chatId,
      limit: params.limit,
      ...(params.accountId ? { accountId: params.accountId } : {}),
    })
  ).map((message) => ({
    messageId: message.messageId,
    timestamp: message.timestamp,
    authorTag: message.authorTag,
    content: message.content,
  }));
}

function resolveProbeIndex(params: {
  messages: FeishuProbeMessage[];
  sentMessageId?: string;
  probeText: string;
}): number {
  if (params.sentMessageId) {
    const byId = params.messages.findIndex((message) => message.messageId === params.sentMessageId);
    if (byId >= 0) {
      return byId;
    }
  }
  const normalizedProbe = normalizeOneLine(params.probeText);
  return params.messages.findIndex(
    (message) => normalizeOneLine(message.content) === normalizedProbe,
  );
}

function evaluateProbeResult(params: {
  recentMessages: FeishuProbeMessage[];
  probeIndex: number;
  mustContainAny: string[];
  mustNotContain: string[];
}): {
  status: FeishuProbeStatus;
  reasons: string[];
  replyMessage?: FeishuProbeMessage;
  repairHint?: string;
} {
  if (params.probeIndex < 0) {
    return {
      status: "probe_message_not_found",
      reasons: ["The sent probe message was not found in the recent Feishu read window."],
    };
  }

  const laterMessages = params.recentMessages.slice(0, params.probeIndex);
  const replyMessage = laterMessages[0];
  if (!replyMessage) {
    const probeMessage = params.recentMessages[params.probeIndex];
    const appOnlyWindow =
      typeof probeMessage?.authorTag === "string" &&
      probeMessage.authorTag.startsWith("app:") &&
      params.recentMessages.every((message) => message.authorTag === probeMessage.authorTag);
    return {
      status: "no_reply_observed",
      reasons: [
        "No later Feishu message was observed after the probe within the read window.",
        ...(appOnlyWindow
          ? [
              "Recent probe window only shows app-authored messages, so this path does not prove the active live inbound handler is processing self-sent probes from the current repo/runtime.",
            ]
          : []),
      ],
      repairHint: appOnlyWindow
        ? "self_authored_probe_not_processed_or_live_ingress_not_migrated"
        : undefined,
    };
  }

  const replyText = normalizeOneLine(replyMessage.content).toLowerCase();
  const forbiddenHit = params.mustNotContain.find((phrase) =>
    replyText.includes(normalizeOneLine(phrase).toLowerCase()),
  );
  if (forbiddenHit) {
    return {
      status: "failed",
      reasons: [`Reply contains forbidden phrase: ${forbiddenHit}`],
      replyMessage,
    };
  }

  if (params.mustContainAny.length > 0) {
    const matched = params.mustContainAny.find((phrase) =>
      replyText.includes(normalizeOneLine(phrase).toLowerCase()),
    );
    if (!matched) {
      return {
        status: "failed",
        reasons: [
          `Reply did not contain any required phrase: ${params.mustContainAny.join(" | ")}`,
        ],
        replyMessage,
      };
    }
  }

  return {
    status: "passed",
    reasons: ["Later Feishu reply observed and simple acceptance checks passed."],
    replyMessage,
  };
}

function renderProbeReceipt(params: {
  createdAt: string;
  surfaceLabel: string;
  chatId: string;
  status: FeishuProbeStatus;
  sentMessageId?: string;
  replyMessage?: FeishuProbeMessage;
  waitMs: number;
  limit: number;
  reasons: string[];
  repairHint?: string;
  probeText: string;
  recentMessages: FeishuProbeMessage[];
}): string {
  const lines = [
    "# Feishu Live Probe Receipt",
    "",
    `- created_at: ${params.createdAt}`,
    `- surface: ${params.surfaceLabel}`,
    `- chat_id: ${redactLiveId(params.chatId)}`,
    `- status: ${params.status}`,
    `- sent_message_id: ${redactOptionalLiveId(params.sentMessageId)}`,
    `- reply_message_id: ${redactOptionalLiveId(params.replyMessage?.messageId)}`,
    `- repair_hint: ${params.repairHint ?? ""}`,
    `- wait_ms: ${params.waitMs}`,
    `- read_limit: ${params.limit}`,
    "",
    "## Probe Prompt",
    params.probeText.trim(),
    "",
    "## Evaluation",
    ...params.reasons.map((reason) => `- ${reason}`),
    "",
    "## Reply Preview",
    params.replyMessage
      ? truncate(normalizeBlock(params.replyMessage.content) ?? "", 1200)
      : "No reply observed.",
    "",
    "## Recent Messages",
    ...params.recentMessages.map((message) => {
      const prefix = [
        `- ${message.timestamp ?? "unknown-time"}`,
        redactAuthorTag(message.authorTag),
        redactLiveId(message.messageId),
      ].join(" | ");
      return `${prefix}\n  ${truncate(normalizeBlock(message.content) ?? "", 500)}`;
    }),
    "",
  ];
  return lines.join("\n");
}

async function writeProbeReceipt(params: {
  workspaceDir: string;
  surfaceLabel: string;
  createdAt: string;
  content: string;
}): Promise<string> {
  const timestampSlug = params.createdAt.replace(/[:.]/g, "-");
  const fileName = `${timestampSlug}-${slugify(params.surfaceLabel)}.md`;
  const relPath = path.join(FEISHU_LIVE_PROBE_DIR, fileName);
  const absPath = path.join(params.workspaceDir, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, params.content, "utf8");
  return relPath;
}

function parseProbeReceiptSummary(
  content: string,
  relPath: string,
): FeishuProbeReceiptSummary | null {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "# Feishu Live Probe Receipt") {
    return null;
  }
  const metadata = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const match = /^- ([a-z_]+):\s*(.*)$/u.exec(line.trim());
    if (!match) {
      if (line.startsWith("## ")) {
        break;
      }
      continue;
    }
    const [, key, value] = match;
    if (key) {
      metadata.set(key, value.trim());
    }
  }
  const createdAt = metadata.get("created_at");
  const surface = metadata.get("surface");
  const chatId = metadata.get("chat_id");
  const status = metadata.get("status");
  if (!createdAt || !surface || !chatId || !status) {
    return null;
  }
  const repairHint = metadata.get("repair_hint")?.trim() || undefined;
  return {
    createdAt,
    surface,
    chatId,
    status,
    repairHint,
    path: relPath,
  };
}

function renderProbeIndex(entries: FeishuProbeReceiptSummary[]): string {
  return [
    "# Feishu Live Probe Index",
    "",
    "## Recent Probes",
    ...(entries.length > 0
      ? entries.map(
          (entry) =>
            `- ${entry.createdAt} | ${entry.surface} | ${entry.status}${entry.repairHint ? ` | ${entry.repairHint}` : ""} | ${entry.path}`,
        )
      : ["No probe receipts recorded yet."]),
    "",
  ].join("\n");
}

async function rebuildProbeIndex(workspaceDir: string): Promise<string> {
  const probeDir = path.join(workspaceDir, FEISHU_LIVE_PROBE_DIR);
  let fileNames: string[] = [];
  try {
    fileNames = (await fs.readdir(probeDir)).filter((fileName) => fileName.endsWith(".md"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const entries: FeishuProbeReceiptSummary[] = [];
  for (const fileName of fileNames) {
    if (fileName === "index.md") {
      continue;
    }
    const relPath = path.join(FEISHU_LIVE_PROBE_DIR, fileName);
    try {
      const content = await fs.readFile(path.join(workspaceDir, relPath), "utf8");
      const parsed = parseProbeReceiptSummary(content, relPath);
      if (parsed) {
        entries.push(parsed);
      }
    } catch {}
  }
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const indexRelPath = path.join(FEISHU_LIVE_PROBE_DIR, "index.md");
  await fs.mkdir(path.dirname(path.join(workspaceDir, indexRelPath)), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, indexRelPath),
    renderProbeIndex(entries.slice(0, 20)),
    "utf8",
  );
  return indexRelPath;
}

export function createFeishuLiveProbeTool(options?: {
  workspaceDir?: string;
  config?: OpenClawConfig;
  sendProbe?: SendProbeDeps;
  readProbe?: ReadProbeDeps;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  const sendProbe = options?.sendProbe ?? sendFeishuProbe;
  const readProbe = options?.readProbe ?? readFeishuProbeMessages;
  const sleep =
    options?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options?.now ?? (() => new Date());

  return {
    label: "Feishu Live Probe",
    name: "feishu_live_probe",
    description:
      "Send a bounded Feishu live acceptance probe to a configured Lobster surface, wait briefly, read recent chat messages back through the same repo/runtime, evaluate simple must-contain / must-not-contain checks, and write a receipt under memory/feishu-live-probes. Use this to verify live reply behavior after repairs without pretending dev tests are live proof.",
    parameters: FeishuLiveProbeSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = options?.config ?? loadConfig();
      const probeText = readStringParam(params, "message", { required: true });
      const mustContainAny = readStringArrayParam(params, "mustContainAny") ?? [];
      const mustNotContain = readStringArrayParam(params, "mustNotContain") ?? [];
      const waitMsRaw = readNumberParam(params, "waitMs");
      const waitMs = Math.max(0, Math.min(Math.trunc(waitMsRaw ?? 6_000), 30_000));
      const limitRaw = readNumberParam(params, "limit");
      const limit = Math.max(3, Math.min(Math.trunc(limitRaw ?? 8), 20));
      const writeReceipt = params.writeReceipt !== false;
      const accountId = readStringParam(params, "accountId");
      const target = resolveTargetChatId({
        cfg,
        surface: readStringParam(params, "surface"),
        chatId: readStringParam(params, "chatId"),
      });

      const createdAt = now().toISOString();
      const sendResult = await sendProbe({
        cfg,
        chatId: target.chatId,
        message: probeText,
        accountId: accountId ?? undefined,
      });
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      const recentMessages = await readProbe({
        cfg,
        chatId: target.chatId,
        limit,
        accountId: accountId ?? undefined,
      });
      const probeIndex = resolveProbeIndex({
        messages: recentMessages,
        sentMessageId: sendResult.messageId,
        probeText,
      });
      const evaluation = evaluateProbeResult({
        recentMessages,
        probeIndex,
        mustContainAny,
        mustNotContain,
      });

      let receiptPath: string | undefined;
      let indexPath: string | undefined;
      if (writeReceipt) {
        receiptPath = await writeProbeReceipt({
          workspaceDir,
          surfaceLabel: target.surfaceLabel,
          createdAt,
          content: renderProbeReceipt({
            createdAt,
            surfaceLabel: target.surfaceLabel,
            chatId: target.chatId,
            status: evaluation.status,
            sentMessageId: sendResult.messageId,
            replyMessage: evaluation.replyMessage,
            waitMs,
            limit,
            reasons: evaluation.reasons,
            repairHint: evaluation.repairHint,
            probeText,
            recentMessages,
          }),
        });
        indexPath = await rebuildProbeIndex(workspaceDir);
      }

      return jsonResult({
        ok: evaluation.status === "passed",
        status: evaluation.status,
        surface: target.surfaceLabel,
        chatId: redactLiveId(target.chatId),
        sentMessageId: sendResult.messageId ? redactLiveId(sendResult.messageId) : null,
        replyMessageId: evaluation.replyMessage?.messageId
          ? redactLiveId(evaluation.replyMessage.messageId)
          : null,
        replyPreview: evaluation.replyMessage
          ? truncate(normalizeBlock(evaluation.replyMessage.content) ?? "", 280)
          : null,
        reasons: evaluation.reasons,
        repairHint: evaluation.repairHint ?? null,
        receiptPath,
        indexPath,
        recentMessages: recentMessages.map((message) => ({
          messageId: redactLiveId(message.messageId),
          timestamp: message.timestamp ?? null,
          authorTag: redactAuthorTag(message.authorTag),
          content: truncate(normalizeBlock(message.content) ?? "", 280),
        })),
      });
    },
  };
}
