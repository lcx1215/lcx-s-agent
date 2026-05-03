import fs from "node:fs/promises";
import path from "node:path";
import type { ClawdbotConfig, ReplyPayload, RuntimeEnv } from "openclaw/plugin-sdk";
import {
  buildAgentMediaPayload,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  createScopedPairingAccess,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
  normalizeAgentId,
  recordPendingHistoryEntryIfEnabled,
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk";
import { resolveAgentWorkspaceDir } from "../../../src/agents/agent-scope.js";
import { createFinanceLearningPipelineOrchestratorTool } from "../../../src/agents/tools/finance-learning-pipeline-orchestrator-tool.js";
import { resolveProtocolInfoQuestionKind } from "../../../src/auto-reply/reply/commands-protocol-families.js";
import { buildProtocolInfoReply } from "../../../src/auto-reply/reply/commands-protocol-info.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { isCorrectionLoopInput } from "../../../src/hooks/bundled/correction-loop/detection.js";
import {
  buildFeishuFinanceDoctrineCalibrationFilename,
  buildFeishuWorkReceiptFilename,
  buildKnowledgeArtifactDir,
  buildLearningCouncilArtifactJsonRelativePath,
  buildKnowledgeValidationWeeklyControlRoomSummary,
  buildLobsterWorkfaceControlRoomSummary,
  buildPortfolioAnswerScorecardControlRoomSummary,
  isFeishuWorkReceiptFilename,
  parseCurrentResearchLineArtifact,
  parseLearningCouncilRuntimeArtifact,
  parseFeishuSurfaceLanePanelArtifact,
  parseFeishuWorkReceiptArtifact,
  parseLobsterWorkfaceArtifact,
  parseFeishuSurfaceLineArtifact,
  renderFeishuFinanceDoctrineCalibrationArtifact,
  renderFeishuWorkReceiptArtifact,
  renderFeishuSurfaceLaneHealthArtifact,
  renderFeishuSurfaceLanePanelArtifact,
  renderFeishuSurfaceLineArtifact,
  isKnowledgeValidationWeeklyArtifactFilename,
  isLobsterWorkfaceFilename,
  isOperatingWeeklyArtifactFilename,
} from "../../../src/hooks/bundled/lobster-brain-registry.js";
import { recordOperationalAnomaly } from "../../../src/infra/operational-anomalies.js";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { applyFeishuDailyBriefQualityGate } from "./daily-brief-quality-gate.js";
import { tryRecordMessage, tryRecordMessagePersistent } from "./dedup.js";
import { normalizeFeishuDisplayText } from "./display-text.js";
import { maybeCreateDynamicAgent } from "./dynamic-agent.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { normalizeFeishuCommandText } from "./feishu-command-handler.js";
import {
  looksLikeBatchQueueScopeAsk,
  looksLikeBoundedPriorityScopeAsk,
  looksLikeCapabilityClaimScopeAsk,
  looksLikeClassifyWorkScopeAsk,
  looksLikeClarificationBoundaryScopeAsk,
  looksLikeCompletionProofScopeAsk,
  looksLikeDurableMemoryScopeAsk,
  looksLikeEvidenceShapeScopeAsk,
  looksLikeExecutionAuthorityScopeAsk,
  looksLikeExplicitResearchLineContinuationAsk,
  looksLikeFailureReportScopeAsk,
  looksLikeFinanceLearningPipelineAsk,
  looksLikeHoldingsRevalidationAsk,
  looksLikeHighStakesRiskScopeAsk,
  looksLikeInstructionConflictScopeAsk,
  looksLikeLearningInternalizationAuditAsk,
  looksLikeLearningTimeboxStatusAsk,
  looksLikeLearningWorkflowAuditAsk,
  looksLikeMarketIntelligencePacketAsk,
  looksLikeNegatedScopeCorrectionAsk,
  looksLikeOutOfScopeBoundaryAsk,
  looksLikeProgressStatusScopeAsk,
  looksLikeResultShapeScopeAsk,
  looksLikeRoleExpansionScopeAsk,
  looksLikeSourceCoverageScopeAsk,
  looksLikeTemporalScopeControlAsk,
} from "./intent-matchers.js";
import { createGatewayLarkApiRouteProvider } from "./lark-api-route-provider.js";
import {
  renderLarkFinanceBrainOrchestrationNotice,
  writeLarkLanguageHandoffReceipt,
  type LarkLanguageHandoffReceiptArtifact,
} from "./lark-language-handoff-receipts.js";
import {
  buildLarkPendingRoutingCandidateCorpus,
  evaluateLarkRoutingCandidateCorpus,
  writeLarkRoutingCandidatePromotionReview,
  type LarkPendingRoutingCandidate,
  type LarkRoutingCandidateEvaluation,
} from "./lark-routing-candidate-corpus.js";
import { LARK_ROUTING_CORPUS, resolveLarkAgentInstructionHandoff } from "./lark-routing-corpus.js";
import { runFeishuLearningCouncil } from "./learning-council.js";
import {
  findLatestFeishuLearningTimeboxSession,
  findRunningFeishuLearningTimeboxSession,
  peekFeishuLearningTimeboxSession,
  startFeishuLearningTimeboxSession,
} from "./learning-timebox.js";
import { runFeishuMarketIntelligencePacket } from "./market-intelligence.js";
import { downloadMessageResourceFeishu } from "./media.js";
import { extractMentionTargets, isMentionForwardRequest } from "./mention.js";
import {
  resolveFeishuGroupConfig,
  resolveFeishuReplyPolicy,
  resolveFeishuAllowlistMatch,
  isFeishuGroupAllowed,
} from "./policy.js";
import { parsePostContent } from "./post.js";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import { getFeishuRuntime } from "./runtime.js";
import { getMessageFeishu, sendMessageFeishu } from "./send.js";
import {
  buildFeishuControlRoomOrchestrationNotice,
  buildFeishuSurfaceNotice,
  looksLikeDailyOperatingBrief,
  resolveFeishuClassifiedPublishResult,
  resolveFeishuControlRoomOrchestration,
  resolveFeishuSurfaceRouting,
  type FeishuControlRoomOrchestrationPlan,
  type FeishuChatSurfaceName,
  type ResolvedFeishuSurfaceRouting,
} from "./surfaces.js";
import type {
  FeishuConfig,
  FeishuMessageContext,
  FeishuMediaInfo,
  ResolvedFeishuAccount,
} from "./types.js";
import type { DynamicAgentCreationConfig } from "./types.js";

// --- Permission error extraction ---
// Extract permission grant URL from Feishu API error response.
type PermissionError = {
  code: number;
  message: string;
  grantUrl?: string;
};

const IGNORED_PERMISSION_SCOPE_TOKENS = ["contact:contact.base:readonly"];

// Feishu API sometimes returns incorrect scope names in permission error
// responses (e.g. "contact:contact.base:readonly" instead of the valid
// "contact:user.base:readonly"). This map corrects known mismatches.
const FEISHU_SCOPE_CORRECTIONS: Record<string, string> = {
  "contact:contact.base:readonly": "contact:user.base:readonly",
};

function correctFeishuScopeInUrl(url: string): string {
  let corrected = url;
  for (const [wrong, right] of Object.entries(FEISHU_SCOPE_CORRECTIONS)) {
    corrected = corrected.replaceAll(encodeURIComponent(wrong), encodeURIComponent(right));
    corrected = corrected.replaceAll(wrong, right);
  }
  return corrected;
}

function shouldSuppressPermissionErrorNotice(permissionError: PermissionError): boolean {
  const message = permissionError.message.toLowerCase();
  return IGNORED_PERMISSION_SCOPE_TOKENS.some((token) => message.includes(token));
}

function extractPermissionError(err: unknown): PermissionError | null {
  if (!err || typeof err !== "object") return null;

  // Axios error structure: err.response.data contains the Feishu error
  const axiosErr = err as { response?: { data?: unknown } };
  const data = axiosErr.response?.data;
  if (!data || typeof data !== "object") return null;

  const feishuErr = data as {
    code?: number;
    msg?: string;
    error?: { permission_violations?: Array<{ uri?: string }> };
  };

  // Feishu permission error code: 99991672
  if (feishuErr.code !== 99991672) return null;

  // Extract the grant URL from the error message (contains the direct link)
  const msg = feishuErr.msg ?? "";
  const urlMatch = msg.match(/https:\/\/[^\s,]+\/app\/[^\s,]+/);
  const grantUrl = urlMatch?.[0] ? correctFeishuScopeInUrl(urlMatch[0]) : undefined;

  return {
    code: feishuErr.code,
    message: msg,
    grantUrl,
  };
}

// --- Sender name resolution (so the agent can distinguish who is speaking in group chats) ---
// Cache display names by sender id (open_id/user_id) to avoid an API call on every message.
const SENDER_NAME_TTL_MS = 10 * 60 * 1000;
const senderNameCache = new Map<string, { name: string; expireAt: number }>();

// Cache permission errors to avoid spamming the user with repeated notifications.
// Key: appId or "default", Value: timestamp of last notification
const permissionErrorNotifiedAt = new Map<string, number>();
const PERMISSION_ERROR_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

type SenderNameResult = {
  name?: string;
  permissionError?: PermissionError;
};

function resolveSenderLookupIdType(senderId: string): "open_id" | "user_id" | "union_id" {
  const trimmed = senderId.trim();
  if (trimmed.startsWith("ou_")) {
    return "open_id";
  }
  if (trimmed.startsWith("on_")) {
    return "union_id";
  }
  return "user_id";
}

async function resolveFeishuSenderName(params: {
  account: ResolvedFeishuAccount;
  senderId: string;
  log: (...args: any[]) => void;
}): Promise<SenderNameResult> {
  const { account, senderId, log } = params;
  if (!account.configured) return {};

  const normalizedSenderId = senderId.trim();
  if (!normalizedSenderId) return {};

  const cached = senderNameCache.get(normalizedSenderId);
  const now = Date.now();
  if (cached && cached.expireAt > now) return { name: cached.name };

  try {
    const client = createFeishuClient(account);
    const userIdType = resolveSenderLookupIdType(normalizedSenderId);

    // contact/v3/users/:user_id?user_id_type=<open_id|user_id|union_id>
    const res: any = await client.contact.user.get({
      path: { user_id: normalizedSenderId },
      params: { user_id_type: userIdType },
    });

    const name: string | undefined =
      res?.data?.user?.name ||
      res?.data?.user?.display_name ||
      res?.data?.user?.nickname ||
      res?.data?.user?.en_name;

    if (name && typeof name === "string") {
      senderNameCache.set(normalizedSenderId, { name, expireAt: now + SENDER_NAME_TTL_MS });
      return { name };
    }

    return {};
  } catch (err) {
    // Check if this is a permission error
    const permErr = extractPermissionError(err);
    if (permErr) {
      if (shouldSuppressPermissionErrorNotice(permErr)) {
        log(`feishu: ignoring stale permission scope error: ${permErr.message}`);
        return {};
      }
      log(`feishu: permission error resolving sender name: code=${permErr.code}`);
      return { permissionError: permErr };
    }

    // Best-effort. Don't fail message handling if name lookup fails.
    log(`feishu: failed to resolve sender name for ${normalizedSenderId}: ${String(err)}`);
    return {};
  }
}

export type FeishuMessageEvent = {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    chat_id: string;
    chat_type: "p2p" | "group" | "private";
    message_type: string;
    content: string;
    create_time?: string;
    mentions?: Array<{
      key: string;
      id: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
  };
};

export type FeishuBotAddedEvent = {
  chat_id: string;
  operator_id: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  external: boolean;
  operator_tenant_key?: string;
};

type GroupSessionScope = "group" | "group_sender" | "group_topic" | "group_topic_sender";

type ResolvedFeishuGroupSession = {
  peerId: string;
  parentPeer: { kind: "group"; id: string } | null;
  groupSessionScope: GroupSessionScope;
  replyInThread: boolean;
  threadReply: boolean;
};

function resolveFeishuGroupSession(params: {
  chatId: string;
  senderOpenId: string;
  messageId: string;
  rootId?: string;
  threadId?: string;
  groupConfig?: {
    groupSessionScope?: GroupSessionScope;
    topicSessionMode?: "enabled" | "disabled";
    replyInThread?: "enabled" | "disabled";
  };
  feishuCfg?: {
    groupSessionScope?: GroupSessionScope;
    topicSessionMode?: "enabled" | "disabled";
    replyInThread?: "enabled" | "disabled";
  };
}): ResolvedFeishuGroupSession {
  const { chatId, senderOpenId, messageId, rootId, threadId, groupConfig, feishuCfg } = params;

  const normalizedThreadId = threadId?.trim();
  const normalizedRootId = rootId?.trim();
  const threadReply = Boolean(normalizedThreadId || normalizedRootId);
  const replyInThread =
    (groupConfig?.replyInThread ?? feishuCfg?.replyInThread ?? "disabled") === "enabled" ||
    threadReply;

  const legacyTopicSessionMode =
    groupConfig?.topicSessionMode ?? feishuCfg?.topicSessionMode ?? "disabled";
  const groupSessionScope: GroupSessionScope =
    groupConfig?.groupSessionScope ??
    feishuCfg?.groupSessionScope ??
    (legacyTopicSessionMode === "enabled" ? "group_topic" : "group");

  // Keep topic session keys stable across the "first turn creates thread" flow:
  // first turn may only have message_id, while the next turn carries root_id/thread_id.
  // Prefer root_id first so both turns stay on the same peer key.
  const topicScope =
    groupSessionScope === "group_topic" || groupSessionScope === "group_topic_sender"
      ? (normalizedRootId ?? normalizedThreadId ?? (replyInThread ? messageId : null))
      : null;

  let peerId = chatId;
  switch (groupSessionScope) {
    case "group_sender":
      peerId = `${chatId}:sender:${senderOpenId}`;
      break;
    case "group_topic":
      peerId = topicScope ? `${chatId}:topic:${topicScope}` : chatId;
      break;
    case "group_topic_sender":
      peerId = topicScope
        ? `${chatId}:topic:${topicScope}:sender:${senderOpenId}`
        : `${chatId}:sender:${senderOpenId}`;
      break;
    case "group":
    default:
      peerId = chatId;
      break;
  }

  const parentPeer =
    topicScope &&
    (groupSessionScope === "group_topic" || groupSessionScope === "group_topic_sender")
      ? {
          kind: "group" as const,
          id: chatId,
        }
      : null;

  return {
    peerId,
    parentPeer,
    groupSessionScope,
    replyInThread,
    threadReply,
  };
}

function parseMessageContent(content: string, messageType: string): string {
  if (messageType === "post") {
    // Extract text content from rich text post
    const { textContent } = parsePostContent(content);
    return textContent;
  }

  try {
    const parsed = JSON.parse(content);
    if (messageType === "text") {
      return parsed.text || "";
    }
    if (messageType === "share_chat") {
      // Preserve available summary text for merged/forwarded chat messages.
      if (parsed && typeof parsed === "object") {
        const share = parsed as {
          body?: unknown;
          summary?: unknown;
          share_chat_id?: unknown;
        };
        if (typeof share.body === "string" && share.body.trim().length > 0) {
          return share.body.trim();
        }
        if (typeof share.summary === "string" && share.summary.trim().length > 0) {
          return share.summary.trim();
        }
        if (typeof share.share_chat_id === "string" && share.share_chat_id.trim().length > 0) {
          return `[Forwarded message: ${share.share_chat_id.trim()}]`;
        }
      }
      return "[Forwarded message]";
    }
    if (messageType === "merge_forward") {
      // Return placeholder; actual content fetched asynchronously in handleFeishuMessage
      return "[Merged and Forwarded Message - loading...]";
    }
    return content;
  } catch {
    return content;
  }
}

function normalizeFeishuMessageId(value: string | undefined): string {
  return value?.trim() || "";
}

function normalizeOptionalFeishuMessageId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

/**
 * Parse merge_forward message content and fetch sub-messages.
 * Returns formatted text content of all sub-messages.
 */
function parseMergeForwardContent(params: {
  content: string;
  log?: (...args: any[]) => void;
}): string {
  const { content, log } = params;
  const maxMessages = 50;

  // For merge_forward, the API returns all sub-messages in items array
  // with upper_message_id pointing to the merge_forward message.
  // The 'content' parameter here is actually the full API response items array as JSON.
  log?.(`feishu: parsing merge_forward sub-messages from API response`);

  let items: Array<{
    message_id?: string;
    msg_type?: string;
    body?: { content?: string };
    sender?: { id?: string };
    upper_message_id?: string;
    create_time?: string;
  }>;

  try {
    items = JSON.parse(content);
  } catch {
    log?.(`feishu: merge_forward items parse failed`);
    return "[Merged and Forwarded Message - parse error]";
  }

  if (!Array.isArray(items) || items.length === 0) {
    return "[Merged and Forwarded Message - no sub-messages]";
  }

  // Filter to only sub-messages (those with upper_message_id, skip the merge_forward container itself)
  const subMessages = items.filter((item) => item.upper_message_id);

  if (subMessages.length === 0) {
    return "[Merged and Forwarded Message - no sub-messages found]";
  }

  log?.(`feishu: merge_forward contains ${subMessages.length} sub-messages`);

  // Sort by create_time
  subMessages.sort((a, b) => {
    const timeA = parseInt(a.create_time || "0", 10);
    const timeB = parseInt(b.create_time || "0", 10);
    return timeA - timeB;
  });

  // Format output
  const lines: string[] = ["[Merged and Forwarded Messages]"];
  const limitedMessages = subMessages.slice(0, maxMessages);

  for (const item of limitedMessages) {
    const msgContent = item.body?.content || "";
    const msgType = item.msg_type || "text";
    const formatted = formatSubMessageContent(msgContent, msgType);
    lines.push(`- ${formatted}`);
  }

  if (subMessages.length > maxMessages) {
    lines.push(`... and ${subMessages.length - maxMessages} more messages`);
  }

  return lines.join("\n");
}

/**
 * Format sub-message content based on message type.
 */
function formatSubMessageContent(content: string, contentType: string): string {
  try {
    const parsed = JSON.parse(content);
    switch (contentType) {
      case "text":
        return parsed.text || content;
      case "post": {
        const { textContent } = parsePostContent(content);
        return textContent;
      }
      case "image":
        return "[Image]";
      case "file":
        return `[File: ${parsed.file_name || "unknown"}]`;
      case "audio":
        return "[Audio]";
      case "video":
        return "[Video]";
      case "sticker":
        return "[Sticker]";
      case "merge_forward":
        return "[Nested Merged Forward]";
      default:
        return `[${contentType}]`;
    }
  } catch {
    return content;
  }
}

function checkBotMentioned(
  event: FeishuMessageEvent,
  botOpenId?: string,
  botName?: string,
): boolean {
  if (!botOpenId) return false;
  // Check for @all (@_all in Feishu) — treat as mentioning every bot
  const rawContent = event.message.content ?? "";
  if (rawContent.includes("@_all")) return true;
  const mentions = event.message.mentions ?? [];
  if (mentions.length > 0) {
    return mentions.some((m) => {
      if (m.id.open_id !== botOpenId) return false;
      // Guard against Feishu WS open_id remapping in multi-app groups:
      // if botName is known and mention name differs, this is a false positive.
      if (botName && m.name && m.name !== botName) return false;
      return true;
    });
  }
  // Post (rich text) messages may have empty message.mentions when they contain docs/paste
  if (event.message.message_type === "post") {
    const { mentionedOpenIds } = parsePostContent(event.message.content);
    return mentionedOpenIds.some((id) => id === botOpenId);
  }
  return false;
}

function normalizeMentions(
  text: string,
  mentions?: FeishuMessageEvent["message"]["mentions"],
  botStripId?: string,
): string {
  if (!mentions || mentions.length === 0) return text;

  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapeName = (value: string) => value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let result = text;

  for (const mention of mentions) {
    const mentionId = mention.id.open_id;
    const replacement =
      botStripId && mentionId === botStripId
        ? ""
        : mentionId
          ? `<at user_id="${mentionId}">${escapeName(mention.name)}</at>`
          : `@${mention.name}`;

    result = result.replace(new RegExp(escaped(mention.key), "g"), () => replacement).trim();
  }

  return result;
}

/**
 * Parse media keys from message content based on message type.
 */
function parseMediaKeys(
  content: string,
  messageType: string,
): {
  imageKey?: string;
  fileKey?: string;
  fileName?: string;
} {
  try {
    const parsed = JSON.parse(content);
    const imageKey = normalizeFeishuExternalKey(parsed.image_key);
    const fileKey = normalizeFeishuExternalKey(parsed.file_key);
    switch (messageType) {
      case "image":
        return { imageKey };
      case "file":
        return { fileKey, fileName: parsed.file_name };
      case "audio":
        return { fileKey };
      case "video":
      case "media":
        // Video/media has both file_key (video) and image_key (thumbnail)
        return { fileKey, imageKey };
      case "sticker":
        return { fileKey };
      default:
        return {};
    }
  } catch {
    return {};
  }
}

/**
 * Map Feishu message type to messageResource.get resource type.
 * Feishu messageResource API supports only: image | file.
 */
export function toMessageResourceType(messageType: string): "image" | "file" {
  return messageType === "image" ? "image" : "file";
}

/**
 * Infer placeholder text based on message type.
 */
function inferPlaceholder(messageType: string): string {
  switch (messageType) {
    case "image":
      return "<media:image>";
    case "file":
      return "<media:document>";
    case "audio":
      return "<media:audio>";
    case "video":
    case "media":
      return "<media:video>";
    case "sticker":
      return "<media:sticker>";
    default:
      return "<media:document>";
  }
}

/**
 * Resolve media from a Feishu message, downloading and saving to disk.
 * Similar to Discord's resolveMediaList().
 */
async function resolveFeishuMediaList(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  messageType: string;
  content: string;
  maxBytes: number;
  log?: (msg: string) => void;
  accountId?: string;
}): Promise<FeishuMediaInfo[]> {
  const { cfg, messageId, messageType, content, maxBytes, log, accountId } = params;

  // Only process media message types (including post for embedded images)
  const mediaTypes = ["image", "file", "audio", "video", "media", "sticker", "post"];
  if (!mediaTypes.includes(messageType)) {
    return [];
  }

  const out: FeishuMediaInfo[] = [];
  const core = getFeishuRuntime();

  // Handle post (rich text) messages with embedded images/media.
  if (messageType === "post") {
    const { imageKeys, mediaKeys: postMediaKeys } = parsePostContent(content);
    if (imageKeys.length === 0 && postMediaKeys.length === 0) {
      return [];
    }

    if (imageKeys.length > 0) {
      log?.(`feishu: post message contains ${imageKeys.length} embedded image(s)`);
    }
    if (postMediaKeys.length > 0) {
      log?.(`feishu: post message contains ${postMediaKeys.length} embedded media file(s)`);
    }

    for (const imageKey of imageKeys) {
      try {
        // Embedded images in post use messageResource API with image_key as file_key
        const result = await downloadMessageResourceFeishu({
          cfg,
          messageId,
          fileKey: imageKey,
          type: "image",
          accountId,
        });

        let contentType = result.contentType;
        if (!contentType) {
          contentType = await core.media.detectMime({ buffer: result.buffer });
        }

        const saved = await core.channel.media.saveMediaBuffer(
          result.buffer,
          contentType,
          "inbound",
          maxBytes,
        );

        out.push({
          path: saved.path,
          contentType: saved.contentType,
          placeholder: "<media:image>",
        });

        log?.(`feishu: downloaded embedded image ${imageKey}, saved to ${saved.path}`);
      } catch (err) {
        log?.(`feishu: failed to download embedded image ${imageKey}: ${String(err)}`);
      }
    }

    for (const media of postMediaKeys) {
      try {
        const result = await downloadMessageResourceFeishu({
          cfg,
          messageId,
          fileKey: media.fileKey,
          type: "file",
          accountId,
        });

        let contentType = result.contentType;
        if (!contentType) {
          contentType = await core.media.detectMime({ buffer: result.buffer });
        }

        const saved = await core.channel.media.saveMediaBuffer(
          result.buffer,
          contentType,
          "inbound",
          maxBytes,
        );

        out.push({
          path: saved.path,
          contentType: saved.contentType,
          placeholder: "<media:video>",
        });

        log?.(`feishu: downloaded embedded media ${media.fileKey}, saved to ${saved.path}`);
      } catch (err) {
        log?.(`feishu: failed to download embedded media ${media.fileKey}: ${String(err)}`);
      }
    }

    return out;
  }

  // Handle other media types
  const mediaKeys = parseMediaKeys(content, messageType);
  if (!mediaKeys.imageKey && !mediaKeys.fileKey) {
    return [];
  }

  try {
    let buffer: Buffer;
    let contentType: string | undefined;
    let fileName: string | undefined;

    // For message media, always use messageResource API
    // The image.get API is only for images uploaded via im/v1/images, not for message attachments
    const fileKey = mediaKeys.fileKey || mediaKeys.imageKey;
    if (!fileKey) {
      return [];
    }

    const resourceType = toMessageResourceType(messageType);
    const result = await downloadMessageResourceFeishu({
      cfg,
      messageId,
      fileKey,
      type: resourceType,
      accountId,
    });
    buffer = result.buffer;
    contentType = result.contentType;
    fileName = result.fileName || mediaKeys.fileName;

    // Detect mime type if not provided
    if (!contentType) {
      contentType = await core.media.detectMime({ buffer });
    }

    // Save to disk using core's saveMediaBuffer
    const saved = await core.channel.media.saveMediaBuffer(
      buffer,
      contentType,
      "inbound",
      maxBytes,
      fileName,
    );

    out.push({
      path: saved.path,
      contentType: saved.contentType,
      placeholder: inferPlaceholder(messageType),
    });

    log?.(`feishu: downloaded ${messageType} media, saved to ${saved.path}`);
  } catch (err) {
    log?.(`feishu: failed to download ${messageType} media: ${String(err)}`);
  }

  return out;
}

// --- Broadcast support ---
// Resolve broadcast agent list for a given peer (group) ID.
// Returns null if no broadcast config exists or the peer is not in the broadcast list.
export function resolveBroadcastAgents(cfg: ClawdbotConfig, peerId: string): string[] | null {
  const broadcast = (cfg as Record<string, unknown>).broadcast;
  if (!broadcast || typeof broadcast !== "object") return null;
  const agents = (broadcast as Record<string, unknown>)[peerId];
  if (!Array.isArray(agents) || agents.length === 0) return null;
  return agents as string[];
}

// Build a session key for a broadcast target agent by replacing the agent ID prefix.
// Session keys follow the format: agent:<agentId>:<channel>:<peerKind>:<peerId>
export function buildBroadcastSessionKey(
  baseSessionKey: string,
  originalAgentId: string,
  targetAgentId: string,
): string {
  const prefix = `agent:${originalAgentId}:`;
  if (baseSessionKey.startsWith(prefix)) {
    return `agent:${targetAgentId}:${baseSessionKey.slice(prefix.length)}`;
  }
  return baseSessionKey;
}

export function buildSurfaceScopedSessionKey(
  baseSessionKey: string,
  targetSurface?: FeishuChatSurfaceName,
): string {
  if (!targetSurface || targetSurface === "control_room") {
    return baseSessionKey;
  }

  const suffix = `:surface:${targetSurface}`;
  if (baseSessionKey.endsWith(suffix)) {
    return baseSessionKey;
  }

  return `${baseSessionKey}${suffix}`;
}

/**
 * Build media payload for inbound context.
 * Similar to Discord's buildDiscordMediaPayload().
 */
export function parseFeishuMessageEvent(
  event: FeishuMessageEvent,
  botOpenId?: string,
  botName?: string,
): FeishuMessageContext {
  const rawContent = parseMessageContent(event.message.content, event.message.message_type);
  const mentionedBot = checkBotMentioned(event, botOpenId, botName);
  const hasAnyMention = (event.message.mentions?.length ?? 0) > 0;
  // In p2p, the bot mention is a pure addressing prefix with no semantic value;
  // strip it so slash commands like @Bot /help still have a leading /.
  // Non-bot mentions (e.g. mention-forward targets) are still normalized to <at> tags.
  const content = normalizeMentions(
    rawContent,
    event.message.mentions,
    event.message.chat_type === "p2p" ? botOpenId : undefined,
  );
  const senderOpenId = event.sender.sender_id.open_id?.trim();
  const senderUserId = event.sender.sender_id.user_id?.trim();
  const senderFallbackId = senderOpenId || senderUserId || "";

  const ctx: FeishuMessageContext = {
    chatId: event.message.chat_id.trim(),
    messageId: normalizeFeishuMessageId(event.message.message_id),
    senderId: senderUserId || senderOpenId || "",
    // Keep the historical field name, but fall back to user_id when open_id is unavailable
    // (common in some mobile app deliveries).
    senderOpenId: senderFallbackId,
    chatType: event.message.chat_type,
    mentionedBot,
    hasAnyMention,
    rootId: normalizeOptionalFeishuMessageId(event.message.root_id),
    parentId: normalizeOptionalFeishuMessageId(event.message.parent_id),
    threadId: normalizeOptionalFeishuMessageId(event.message.thread_id),
    content,
    contentType: event.message.message_type,
  };

  // Detect mention forward request: message mentions bot + at least one other user
  if (isMentionForwardRequest(event, botOpenId)) {
    const mentionTargets = extractMentionTargets(event, botOpenId);
    if (mentionTargets.length > 0) {
      ctx.mentionTargets = mentionTargets;
    }
  }

  return ctx;
}

export function buildFeishuAgentBody(params: {
  ctx: Pick<
    FeishuMessageContext,
    "content" | "senderName" | "senderOpenId" | "mentionTargets" | "messageId" | "hasAnyMention"
  >;
  quotedContent?: string;
  permissionErrorForAgent?: PermissionError;
  botOpenId?: string;
  surfaceNotice?: string;
  continuationNotice?: string;
}): string {
  const {
    ctx,
    quotedContent,
    permissionErrorForAgent,
    botOpenId,
    surfaceNotice,
    continuationNotice,
  } = params;
  const intentNotice = inferFeishuResearchIntentNotice(ctx.content);
  const systemNotices = buildFeishuAgentSystemNotices({
    surfaceNotice,
    continuationNotice,
    intentNotice,
  });
  let messageBody = buildFeishuAgentPromptBody({
    content: ctx.content,
    quotedContent,
    systemNotices,
  });

  // DMs already have per-sender sessions, but this label still improves attribution.
  const speaker = ctx.senderName ?? ctx.senderOpenId;
  messageBody = `${speaker}: ${messageBody}`;

  if (ctx.hasAnyMention) {
    const botIdHint = botOpenId?.trim();
    messageBody +=
      `\n\n[System: The content may include mention tags in the form <at user_id="...">name</at>. ` +
      `Treat these as real mentions of Feishu entities (users or bots).]`;
    if (botIdHint) {
      messageBody += `\n[System: If user_id is "${botIdHint}", that mention refers to you.]`;
    }
  }

  if (ctx.mentionTargets && ctx.mentionTargets.length > 0) {
    const targetNames = ctx.mentionTargets.map((t) => t.name).join(", ");
    messageBody += `\n\n[System: Your reply will automatically @mention: ${targetNames}. Do not write @xxx yourself.]`;
  }

  // Keep message_id on its own line so shared message-id hint stripping can parse it reliably.
  messageBody = `[message_id: ${ctx.messageId}]\n${messageBody}`;

  if (permissionErrorForAgent) {
    const grantUrl = permissionErrorForAgent.grantUrl ?? "";
    messageBody += `\n\n[System: The bot encountered a Feishu API permission error. Please inform the user about this issue and provide the permission grant URL for the admin to authorize. Permission grant URL: ${grantUrl}]`;
  }

  return messageBody;
}

function buildFeishuAgentSystemNotices(params: {
  surfaceNotice?: string;
  continuationNotice?: string;
  intentNotice?: string;
}): string | undefined {
  const noticeBlock = [params.surfaceNotice, params.continuationNotice, params.intentNotice]
    .filter(Boolean)
    .join("\n");
  return noticeBlock || undefined;
}

function buildFeishuAgentPromptBody(params: {
  content: string;
  quotedContent?: string;
  systemNotices?: string;
}): string {
  const { content, quotedContent, systemNotices } = params;
  const baseBody = quotedContent ? `[Replying to: "${quotedContent}"]\n\n${content}` : content;
  if (!systemNotices) {
    return baseBody;
  }
  if (quotedContent) {
    return `[Replying to: "${quotedContent}"]\n\n${systemNotices}\n\n${content}`;
  }
  return `${systemNotices}\n\n${content}`;
}

export function buildFeishuPromptSurfaceNotice(params: {
  surfaceRouting: ResolvedFeishuSurfaceRouting;
  controlRoomOrchestration?: FeishuControlRoomOrchestrationPlan;
}): string {
  const { surfaceRouting, controlRoomOrchestration } = params;
  const promptSurfaceRouting = resolveFeishuPromptSurfaceRouting({
    surfaceRouting,
    controlRoomOrchestration,
  });
  const baseSurfaceNotice = buildFeishuSurfaceNotice(promptSurfaceRouting);
  return [baseSurfaceNotice, buildFeishuControlRoomOrchestrationNotice(controlRoomOrchestration)]
    .filter(Boolean)
    .join("\n");
}

function resolveFeishuPromptSurfaceRouting(params: {
  surfaceRouting: ResolvedFeishuSurfaceRouting;
  controlRoomOrchestration?: FeishuControlRoomOrchestrationPlan;
}): ResolvedFeishuSurfaceRouting {
  const { surfaceRouting, controlRoomOrchestration } = params;
  if (controlRoomOrchestration && surfaceRouting.currentSurface === "control_room") {
    return {
      ...surfaceRouting,
      targetSurface: "control_room",
      suppressedIntentSurface: undefined,
    };
  }
  return surfaceRouting;
}

export function resolveFeishuEffectiveStateSurface(params: {
  surfaceRouting: ResolvedFeishuSurfaceRouting;
  controlRoomOrchestration?: FeishuControlRoomOrchestrationPlan;
}): FeishuChatSurfaceName | undefined {
  const { surfaceRouting, controlRoomOrchestration } = params;

  // Broad control-room aggregate asks should keep one control-room state surface
  // instead of silently inheriting the first inferred specialist lane.
  if (
    surfaceRouting.currentSurface === "control_room" &&
    controlRoomOrchestration?.mode === "aggregate" &&
    controlRoomOrchestration.includeDailyWorkface === true
  ) {
    return "control_room";
  }

  return surfaceRouting.targetSurface;
}

type FeishuReplyDispatcherShape = {
  sendToolResult: (payload: ReplyPayload) => boolean;
  sendBlockReply: (payload: ReplyPayload) => boolean;
  sendFinalReply: (payload: ReplyPayload) => boolean;
  waitForIdle: () => Promise<void>;
  getQueuedCounts: () => Record<string, number>;
  markComplete: () => void;
};

type FeishuFinalTextSendResult = {
  queuedFinal: boolean;
  counts: { final: number };
};

function logFeishuNonLedgerEarlyReturn(params: {
  log: (message: string) => void;
  accountId: string;
  reason: string;
  chatId?: string;
  messageId?: string;
}): void {
  const parts = [`feishu[${params.accountId}]: non-ledger early return`, `reason=${params.reason}`];
  if (params.chatId) {
    parts.push(`chat=${params.chatId}`);
  }
  if (params.messageId) {
    parts.push(`message=${params.messageId}`);
  }
  parts.push("boundary=not_a_truth_surface_reply");
  params.log(parts.join(" "));
}

async function sendFeishuFinalTextReply(params: {
  replyRuntime: ReturnType<typeof getFeishuRuntime>["channel"]["reply"];
  dispatcher: FeishuReplyDispatcherShape;
  markDispatchIdle: () => void;
  text: string;
}): Promise<FeishuFinalTextSendResult> {
  return params.replyRuntime.withReplyDispatcher({
    dispatcher: params.dispatcher,
    onSettled: params.markDispatchIdle,
    run: async () => {
      const queuedFinal = params.dispatcher.sendFinalReply({ text: params.text });
      return { queuedFinal, counts: { final: queuedFinal ? 1 : 0 } };
    },
  });
}

function renderFeishuProtocolTruthSurfaceReply(params: {
  userMessage: string;
  family: string;
  confidence: number;
  rationale?: string;
}): string {
  if (
    /(source_required|source required|no url|without url|do not give a url|不给.*(url|source|链接|网址|来源|材料|文件)|没有.*(url|source|链接|网址|来源|材料|文件)|缺.*(url|source|链接|网址|来源|材料|文件))/iu.test(
      params.userMessage,
    )
  ) {
    return [
      `family: ${params.family}`,
      "source_required: true",
      "failedReason: no_url_or_local_source_provided",
      "next step: ask the user for an explicit URL, local file path, or pasted source before running any learning pipeline.",
      "boundary: do not search, fetch, learn, retain, or claim application_ready from a vague external-source reference.",
      `proof: ${params.rationale ?? "the utterance asks for source_required handling and provides no concrete URL or local source."}`,
      `original: ${params.userMessage}`,
    ].join("\n");
  }

  return [
    "我是 LCX Agent / OpenClaw 的 Lark 控制室入口。",
    "",
    "当前可用能力:",
    "- 可以把自然语言请求分到 control_room、learning_command、technical_daily、fundamental_research、knowledge_maintenance、ops_audit 等工作面。",
    "- 可以在本地 workspace 内跑有 receipt 的 finance learning pipeline；成功时必须出现 application_ready 或明确 failedReason。",
    "- 可以把学习、复盘、审计、路由和工作回执写成可检查 artifact，而不是只靠聊天记忆。",
    "",
    "不可用边界:",
    "- 这不是自动交易执行器，不会批准下单、付款、删文件、生产发布或其它高风险动作。",
    "- 没有新鲜来源或工具证明时，不能把旧证据说成今天的 live 事实。",
    "- dev-fixed 和 live-fixed 必须分开；只有 build/restart/probe/真实 Lark 可见回复都通过，才算 live-fixed。",
    "",
    "下一步会做什么:",
    "- 对每条真实 Lark 消息先分类，再走对应工作面；如果缺 source、权限、证据或 receipt，就直接说失败原因。",
    "- 继续用真实简单问题打入口，优先修静默失败、错路由、假成功和 artifact 不落账。",
    "",
    `本次识别: family=${params.family}, confidence=${params.confidence.toFixed(2)}`,
    params.rationale ? `识别理由: ${params.rationale}` : undefined,
    `原始问题: ${params.userMessage}`,
    "边界: 这是 protocol truth surface 的确定性回复，不是普通自由聊天生成。",
  ]
    .filter(Boolean)
    .join("\n");
}

function shouldUseFeishuProtocolTruthIdentityReply(text: string): boolean {
  return (
    /(你是谁|现在你是谁|who are you|what are you|身份|不要讲大话|别讲大话|下一步会做什么|next step)/iu.test(
      text,
    ) && /(能做什么|可用能力|能力|capabilit|边界|不能做什么|不可用)/iu.test(text)
  );
}

function shouldUseFeishuProtocolStatusReadbackReply(text: string): boolean {
  return (
    resolveProtocolInfoQuestionKind(text) === "status_readback" &&
    /(status audit|current evidence|dev-fixed|live-fixed|unverified|acceptance code|proof|failedreason|what did you just fix|当前证据|当前 proof|刚才.*修|修了什么)/iu.test(
      text,
    )
  );
}

function shouldUseFeishuSourceRequiredTruthReply(text: string): boolean {
  return (
    /(learn|learning|google|webpage|网页|学习|source|url|local source|本地 source|来源|链接|网址|材料|文件)/iu.test(
      text,
    ) &&
    /(source_required|source required|no url|without url|do not give a url|不给.*(url|source|链接|网址|来源|材料|文件)|没有.*(url|source|链接|网址|来源|材料|文件)|缺.*(url|source|链接|网址|来源|材料|文件)|不提供.*(url|source|链接|网址|来源|材料|文件))/iu.test(
      text,
    )
  );
}

async function createAndSendFeishuFinalTextReply(params: {
  replyRuntime: ReturnType<typeof getFeishuRuntime>["channel"]["reply"];
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyTargetMessageId: string;
  skipReplyToInMessages: boolean;
  replyInThread: boolean;
  rootId?: string;
  threadReply: boolean;
  mentionTargets?: FeishuMessageContext["mentionTargets"];
  accountId: string;
  messageCreateTimeMs?: number;
  text: string;
}): Promise<FeishuFinalTextSendResult> {
  const { dispatcher, markDispatchIdle } = createFeishuReplyDispatcher({
    cfg: params.cfg,
    agentId: params.agentId,
    runtime: params.runtime,
    chatId: params.chatId,
    replyToMessageId: params.replyTargetMessageId,
    skipReplyToInMessages: params.skipReplyToInMessages,
    replyInThread: params.replyInThread,
    rootId: params.rootId,
    threadReply: params.threadReply,
    mentionTargets: params.mentionTargets,
    accountId: params.accountId,
    messageCreateTimeMs: params.messageCreateTimeMs,
  });
  return sendFeishuFinalTextReply({
    replyRuntime: params.replyRuntime,
    dispatcher,
    markDispatchIdle,
    text: params.text,
  });
}

type FeishuFinanceLearningPipelineSource =
  | { kind: "local_file"; localFilePath: string }
  | { kind: "manual_paste"; pastedText: string };

function extractFeishuFinanceLearningLocalFilePath(content: string): string | undefined {
  const match = content.match(
    /(?:^|[\s"'“”‘’（(：:])((?:memory|docs|test|tests|src|extensions|ops|scripts)\/[^\s"'“”‘’）),，。；;]+?\.(?:md|markdown|txt|html?))(?:$|[\s"'“”‘’）),，。；;])/iu,
  );
  return match?.[1];
}

function isSubstantiveManualFinanceSource(text: string): boolean {
  const normalized = text.trim();
  return (
    normalized.length >= 600 &&
    /(capability|method|strategy|risk|regime|portfolio|factor|timing|etf|finance|financial|market|evidence|causal|能力|方法|策略|风险|组合|因子|择时|金融|市场|证据|机制)/iu.test(
      normalized,
    )
  );
}

function resolveFeishuFinanceLearningPipelineSource(params: {
  content: string;
  quotedContent?: string;
}): FeishuFinanceLearningPipelineSource | undefined {
  const localFilePath = extractFeishuFinanceLearningLocalFilePath(params.content);
  if (localFilePath) {
    return { kind: "local_file", localFilePath };
  }
  const inlineSourceMatch = params.content.match(
    /(?:文章|source|材料|原文|正文|content)\s*[:：]\s*([\s\S]{600,})$/iu,
  );
  const inlineSource = inlineSourceMatch?.[1]?.trim();
  if (inlineSource && isSubstantiveManualFinanceSource(inlineSource)) {
    return { kind: "manual_paste", pastedText: inlineSource };
  }
  if (params.quotedContent && isSubstantiveManualFinanceSource(params.quotedContent)) {
    return { kind: "manual_paste", pastedText: params.quotedContent };
  }
  return undefined;
}

async function validateFeishuFinanceLearningLocalSource(params: {
  workspaceDir: string;
  localFilePath: string;
}): Promise<{ ok: true } | { ok: false; reason: string; resolvedPath: string }> {
  const resolvedWorkspace = path.resolve(params.workspaceDir);
  const resolvedPath = path.resolve(resolvedWorkspace, params.localFilePath);
  if (
    resolvedPath !== resolvedWorkspace &&
    !resolvedPath.startsWith(`${resolvedWorkspace}${path.sep}`)
  ) {
    return { ok: false, reason: "local_source_outside_workspace", resolvedPath };
  }
  try {
    await fs.access(resolvedPath);
    return { ok: true };
  } catch {
    return { ok: false, reason: "local_source_not_found", resolvedPath };
  }
}

function renderFeishuFinanceLearningPipelineMissingSourceReply(): string {
  return [
    "我识别到这是金融能力学习入口，但还缺安全 source，所以没有假装已经学完。",
    "",
    "- 已识别: market_capability_learning_intake",
    "- 后端: finance_learning_pipeline_orchestrator",
    "- learningInternalizationStatus: not_started",
    "- failedReason: safe_local_or_manual_source_required",
    "- 还缺: workspace-relative `.md` / `.txt` / `.html` 文件路径，或直接粘贴/引用一段完整金融研究材料",
    "- 未产生: retrievalReceiptPath / retrievalReviewPath",
    "",
    "下一步把本地材料路径发来，例如 `memory/articles/example.md`，或回复/引用一段完整文章，我再走 source intake、extract、attach、inspect 和 retrieval review。",
  ].join("\n");
}

function looksLikeLearningTimeboxStartRequest(content: string): boolean {
  return (
    /(学|学习|研究|读|看|补).{0,12}(半个?小时|一个小时|一小时|两个小时|两小时|二小时|\d+(?:\.\d+)?\s*个?\s*小时|\d+(?:\.\d+)?\s*分(?:钟)?|\d+(?:\.\d+)?\s*h(?:our)?s?\b|\d+(?:\.\d+)?\s*m(?:in(?:ute)?s?)?\b)/u.test(
      content,
    ) ||
    /(半个?小时|一个小时|一小时|两个小时|两小时|二小时|\d+(?:\.\d+)?\s*个?\s*小时|\d+(?:\.\d+)?\s*分(?:钟)?|\d+(?:\.\d+)?\s*h(?:our)?s?\b|\d+(?:\.\d+)?\s*m(?:in(?:ute)?s?)?\b).{0,12}(学|学习|研究|读|看|补)/u.test(
      content,
    )
  );
}

function renderFeishuFinanceLearningPipelineReply(details: Record<string, unknown>): string {
  if (details.ok !== true) {
    const extractionGap =
      details.extractionGap && typeof details.extractionGap === "object"
        ? (details.extractionGap as Record<string, unknown>)
        : {};
    const missingFields = Array.isArray(extractionGap.missingFields)
      ? extractionGap.missingFields.filter((item): item is string => typeof item === "string")
      : [];
    return [
      "金融能力学习流水线没有完成。",
      "",
      `- learningInternalizationStatus: not_started`,
      `- failedReason: ${String(details.reason ?? "unknown")}`,
      `- failed step: ${String(details.failedStep ?? "unknown")}`,
      `- reason: ${String(details.reason ?? "unknown")}`,
      `- error: ${String(details.errorMessage ?? "none")}`,
      ...(missingFields.length > 0 ? [`- extraction gap: ${missingFields.join(", ")}`] : []),
      `- receipt: ${String(details.retrievalReceiptPath ?? "not_created")}`,
      `- review: ${String(details.retrievalReviewPath ?? "not_created")}`,
      "",
      "这次没有把失败说成学会；需要先修正 source 或 extraction gap，再重跑。",
    ].join("\n");
  }
  const retrievalFirstLearning =
    details.retrievalFirstLearning && typeof details.retrievalFirstLearning === "object"
      ? (details.retrievalFirstLearning as Record<string, unknown>)
      : {};
  const reviewCounts =
    retrievalFirstLearning.retrievalReviewCounts &&
    typeof retrievalFirstLearning.retrievalReviewCounts === "object"
      ? (retrievalFirstLearning.retrievalReviewCounts as Record<string, unknown>)
      : {};
  const applicationValidation =
    details.applicationValidation && typeof details.applicationValidation === "object"
      ? (details.applicationValidation as Record<string, unknown>)
      : {};
  const answerSkeleton =
    applicationValidation.answerSkeleton && typeof applicationValidation.answerSkeleton === "object"
      ? (applicationValidation.answerSkeleton as Record<string, unknown>)
      : {};
  const answerScaffold =
    answerSkeleton.answerScaffold && typeof answerSkeleton.answerScaffold === "object"
      ? (answerSkeleton.answerScaffold as Record<string, unknown>)
      : {};
  const usableAnswerContract =
    answerSkeleton.usableAnswerContract && typeof answerSkeleton.usableAnswerContract === "object"
      ? (answerSkeleton.usableAnswerContract as Record<string, unknown>)
      : {};
  const usableAnswerLines = Array.isArray(usableAnswerContract.requiredVisibleLines)
    ? usableAnswerContract.requiredVisibleLines.filter(
        (line): line is string => typeof line === "string" && line.trim().length > 0,
      )
    : [];
  return [
    "金融能力学习流水线已完成 dev 验收。",
    "",
    `- learningInternalizationStatus: ${String(
      retrievalFirstLearning.learningInternalizationStatus ?? "missing",
    )}`,
    `- failedReason: ${String(retrievalFirstLearning.failedReason ?? "none")}`,
    `- retained candidates: ${String(details.retainedCandidateCount ?? 0)}`,
    `- receipt: ${String(retrievalFirstLearning.retrievalReceiptPath ?? "missing")}`,
    `- review: ${String(retrievalFirstLearning.retrievalReviewPath ?? "missing")}`,
    `- retrievable after learning: ${String(reviewCounts.retrievableAfterLearning ?? "unknown")}`,
    `- weak learning receipts: ${String(reviewCounts.weakLearningReceipts ?? "unknown")}`,
    `- application validation: ${String(
      applicationValidation.applicationValidationStatus ?? "missing",
    )}`,
    `- answer scaffold: ${String(answerScaffold.status ?? "missing")}`,
    `- synthesis mode: ${String(applicationValidation.synthesisMode ?? "missing")}`,
    `- usage receipt: ${String(applicationValidation.usageReceiptPath ?? "missing")}`,
    `- usage review: ${String(applicationValidation.usageReviewPath ?? "missing")}`,
    "- automation: this message refreshed retrieval review and apply usage review; no daily manual command was required",
    `- apply mode: ${String(applicationValidation.applicationMode ?? "missing")}`,
    `- applied candidates: ${String(applicationValidation.candidateCount ?? "unknown")}`,
    `- usable answer contract: ${String(usableAnswerContract.status ?? "missing")}`,
    ...(usableAnswerLines.length > 0
      ? ["- usable answer lines:", ...usableAnswerLines.slice(0, 6).map((line) => `  - ${line}`)]
      : []),
    `- apply boundary: ${String(answerSkeleton.noActionBoundary ?? "missing")}`,
    "",
    "边界: 这是 research-only 学习，不是交易执行；语言 corpus 没有混入金融学习 artifact。",
  ].join("\n");
}

const CLASSIFIED_PUBLISH_DEDUP_TTL_MS = 6 * 60 * 60 * 1000;
const classifiedPublishSeenAt = new Map<string, number>();
const DAILY_WORKFACE_PUBLISH_DEDUP_TTL_MS = 6 * 60 * 60 * 1000;
const dailyWorkfaceSeenAt = new Map<string, number>();

type DailyWorkfaceArtifact = {
  filename: string;
  content: string;
  controlRoomSummary: string;
};

type PortfolioScorecardArtifact = {
  filename: string;
  content: string;
  controlRoomSummary: string;
};

type ValidationWeeklyArtifact = {
  filename: string;
  content: string;
  controlRoomSummary: string;
};

type LearningTimeboxSnapshot = {
  sessionId: string;
  status?: "running" | "completed" | "failed" | "interrupted" | "overdue";
  deadlineAt: string;
  receiptsPath: string;
  lastHeartbeatAt?: string;
  iterationsCompleted?: number;
  iterationsFailed?: number;
};

type LearningTimeboxStartResult = Awaited<ReturnType<typeof startFeishuLearningTimeboxSession>>;

type ParsedCurrentResearchLine = NonNullable<ReturnType<typeof parseCurrentResearchLineArtifact>>;

type ResolvedFeishuResearchContinuation =
  | { kind: "none" }
  | { kind: "anchored"; notice: string }
  | { kind: "clarify"; text: string };

type FeishuSurfaceLineArtifact = {
  heading: string;
  relativePath: string;
  content: string;
};

type FeishuSurfaceLineIndexRow = {
  surface: FeishuChatSurfaceName;
  chat: string;
  laneKey: string;
  lastUpdated: string;
  sessionKey: string;
  turnCount: number;
};

const FEISHU_LEARNING_STATUS_PROTECTED_ANCHORS = [
  "memory/current-research-line.md",
  "memory/unified-risk-view.md",
  "MEMORY.md",
] as const;

const FEISHU_BROAD_KNOWLEDGE_ADOPTION_RE =
  /(hermes(?:-agent)?|nous(?:research)?|github cli|gh cli|\bgh\b|memory provider|memory providers|context file|context files|context reference|context references|skills hub|skill installer|skills system|plugin system|plugins|install(?:er|ation|ability)?|setup wizard|setup flow|doctor|migrate|migration|claw migrate|install\.sh|curl -fsSL|AGENTS\.md|CLAUDE\.md|SOUL\.md)/iu;

type FeishuSurfaceLaneHealth = {
  status: "stable" | "crowded";
  activeLanes: number;
  crowdedChats: string[];
  busiestLane?: string;
};

type FeishuWorkReceiptIndexRow = {
  handledAt: string;
  surface: string;
  chatId: string;
  sessionKey: string;
  messageId: string;
  requestedAction: string;
  scope: string;
  timeframe: string;
  outputShape: string;
  repairDisposition: string;
  userMessage: string;
  finalReplySummary: string;
};

type FeishuRepairQueueRow = {
  queueKind: "operator_repair" | "adoption_distillation";
  issueKey: string;
  issueLabel: string;
  hits: number;
  latestHandledAt: string;
  latestSurface: string;
  latestChatId: string;
  requestedAction: string;
  scope: string;
  outputShape: string;
  nextNarrowingStep: string;
  latestAsk: string;
  latestReplySummary: string;
};

type FeishuRepairQueueSeed = Omit<FeishuRepairQueueRow, "hits"> & {
  groupingKey: string;
};

function normalizeClassifiedPublishFingerprint(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function isLowSignalClassifiedSlice(text: string): boolean {
  const normalized = normalizeClassifiedPublishFingerprint(text);
  return (
    normalized.length < 20 ||
    /^(no major update|nothing new|same as before|keep watching|monitor only|continue watching)\b/i.test(
      normalized,
    )
  );
}

function shouldSuppressDuplicateClassifiedSlice(params: {
  chatId: string;
  heading: string;
  body: string;
}) {
  const fingerprint = `${params.chatId}:${params.heading}:${normalizeClassifiedPublishFingerprint(params.body)}`;
  const now = Date.now();
  const previousSeenAt = classifiedPublishSeenAt.get(fingerprint) ?? 0;
  if (now - previousSeenAt < CLASSIFIED_PUBLISH_DEDUP_TTL_MS) {
    return true;
  }
  classifiedPublishSeenAt.set(fingerprint, now);
  return false;
}

function sanitizeSurfaceLedgerSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function loadLatestDailyWorkface(params: {
  cfg: ClawdbotConfig;
  agentId: string;
}): Promise<DailyWorkfaceArtifact | undefined> {
  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg as OpenClawConfig, params.agentId);
    const memoryDir = path.join(workspaceDir, "memory");
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    const latest = entries
      .filter((entry) => entry.isFile() && isLobsterWorkfaceFilename(entry.name))
      .map((entry) => entry.name)
      .toSorted()
      .at(-1);
    if (!latest) {
      return undefined;
    }
    const content = await fs.readFile(path.join(memoryDir, latest), "utf-8");
    return {
      filename: latest,
      content,
      controlRoomSummary: buildLobsterWorkfaceControlRoomSummary({ filename: latest, content }),
    };
  } catch {
    return undefined;
  }
}

async function loadExistingFeishuSurfaceLineContent(params: {
  workspaceDir: string;
  targetSurface?: FeishuChatSurfaceName;
  chatId: string;
}): Promise<string | undefined> {
  if (!params.targetSurface) {
    return undefined;
  }
  const chatStem = sanitizeSurfaceLedgerSegment(params.chatId) || "chat";
  const filePath = path.join(
    params.workspaceDir,
    "memory",
    "feishu-surface-lines",
    `${params.targetSurface}-${chatStem}.md`,
  );
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

async function buildLearningStatusEvidenceLines(params: {
  cfg: ClawdbotConfig;
  agentId: string;
}): Promise<string[]> {
  const unavailableLines = [
    "- 最近落账: 当前无法读取 latest lobster-workface 学习包状态。",
    "- Protected anchors: state unavailable.",
  ];
  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg as OpenClawConfig, params.agentId);
    const memoryDir = path.join(workspaceDir, "memory");
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    const latestWorkface = entries
      .filter((entry) => entry.isFile() && isLobsterWorkfaceFilename(entry.name))
      .map((entry) => entry.name)
      .toSorted()
      .at(-1);
    const lines: string[] = [];

    if (!latestWorkface) {
      lines.push("- 最近落账: 还没找到最新 lobster-workface 学习包。");
    } else {
      const workfaceContent = await fs.readFile(path.join(memoryDir, latestWorkface), "utf-8");
      const parsed = parseLobsterWorkfaceArtifact(workfaceContent);
      const cueFields = [
        parsed?.learningKeep ? "retain" : undefined,
        parsed?.learningDiscard ? "discard" : undefined,
        parsed?.learningReplay ? "replay" : undefined,
        parsed?.learningNextEval ? "next eval" : undefined,
      ].filter((field): field is string => Boolean(field));
      lines.push(
        cueFields.length === 4
          ? `- 最近落账: ${latestWorkface} 已记录 ${cueFields.join(" / ")}。`
          : cueFields.length > 0
            ? `- 最近落账: ${latestWorkface} 存在，但 learning carryover cue 还不完整；目前只看到 ${cueFields.join(" / ")}。`
            : `- 最近落账: ${latestWorkface} 存在，但还没看到 learning carryover cue。`,
      );
    }

    const anchorStates = await Promise.all(
      FEISHU_LEARNING_STATUS_PROTECTED_ANCHORS.map(async (relPath) => {
        try {
          await fs.access(path.join(workspaceDir, relPath));
          return { relPath, present: true };
        } catch {
          return { relPath, present: false };
        }
      }),
    );
    const present = anchorStates.filter((entry) => entry.present).map((entry) => entry.relPath);
    const missing = anchorStates.filter((entry) => !entry.present).map((entry) => entry.relPath);
    lines.push(
      present.length > 0 || missing.length > 0
        ? `- Protected anchors: ${present.length > 0 ? `present ${present.join(", ")}` : "present none"}${missing.length > 0 ? `; missing ${missing.join(", ")}` : ""}.`
        : "- Protected anchors: state unavailable.",
    );
    return lines;
  } catch {
    return unavailableLines;
  }
}

async function buildDailyArtifactAvailabilitySummary(params: {
  cfg: ClawdbotConfig;
  agentId: string;
}): Promise<string | undefined> {
  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg as OpenClawConfig, params.agentId);
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.readdir(memoryDir, { withFileTypes: true });
    return undefined;
  } catch {
    return "Daily artifacts: latest workface / portfolio scorecard / validation radar state unavailable.";
  }
}

function buildDailyImprovementPulse(workface?: DailyWorkfaceArtifact): string | undefined {
  if (!workface) {
    return undefined;
  }
  const parsed = parseLobsterWorkfaceArtifact(workface.content);
  if (!parsed) {
    return undefined;
  }
  const parseConcreteCount = (value?: string): number | undefined => {
    const parsedCount = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : undefined;
  };
  const normalizePulseFragment = (value?: string): string | undefined =>
    value?.trim().replace(/[.。]+$/u, "") || undefined;
  const learnedCount = parseConcreteCount(parsed.learningItems);
  const correctedCount = parseConcreteCount(parsed.correctionNotes);

  const improvementParts = [
    learnedCount ? `learned ${learnedCount}` : undefined,
    correctedCount ? `corrected ${correctedCount}` : undefined,
    parsed.learningKeep ? `keep ${normalizePulseFragment(parsed.learningKeep)}` : undefined,
    parsed.learningDiscard
      ? `discard ${normalizePulseFragment(parsed.learningDiscard)}`
      : undefined,
    parsed.learningImproveLobster
      ? `improve lobster ${normalizePulseFragment(parsed.learningImproveLobster)}`
      : undefined,
    parsed.learningReplay ? `replay ${normalizePulseFragment(parsed.learningReplay)}` : undefined,
    parsed.learningNextEval
      ? `next eval ${normalizePulseFragment(parsed.learningNextEval)}`
      : undefined,
  ].filter((part): part is string => Boolean(part));

  if (improvementParts.length === 0) {
    return undefined;
  }
  return `Improvement pulse: ${improvementParts.join("; ")}.`;
}

async function loadLatestPortfolioScorecard(params: {
  cfg: ClawdbotConfig;
  agentId: string;
}): Promise<PortfolioScorecardArtifact | undefined> {
  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg as OpenClawConfig, params.agentId);
    const memoryDir = path.join(workspaceDir, "memory");
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    const latest = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          isOperatingWeeklyArtifactFilename(entry.name, "portfolio-answer-scorecard"),
      )
      .map((entry) => entry.name)
      .toSorted()
      .at(-1);
    if (!latest) {
      return undefined;
    }
    const content = await fs.readFile(path.join(memoryDir, latest), "utf-8");
    return {
      filename: latest,
      content,
      controlRoomSummary: buildPortfolioAnswerScorecardControlRoomSummary({
        filename: latest,
        content,
      }),
    };
  } catch {
    return undefined;
  }
}

async function loadLatestValidationWeekly(params: {
  cfg: ClawdbotConfig;
  agentId: string;
}): Promise<ValidationWeeklyArtifact | undefined> {
  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg as OpenClawConfig, params.agentId);
    const memoryDir = path.join(workspaceDir, "memory");
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    const latest = entries
      .filter((entry) => entry.isFile() && isKnowledgeValidationWeeklyArtifactFilename(entry.name))
      .map((entry) => entry.name)
      .toSorted()
      .at(-1);
    if (!latest) {
      return undefined;
    }
    const content = await fs.readFile(path.join(memoryDir, latest), "utf-8");
    return {
      filename: latest,
      content,
      controlRoomSummary:
        buildKnowledgeValidationWeeklyControlRoomSummary(content) ??
        "Validation radar: latest weekly report available.",
    };
  } catch {
    return undefined;
  }
}

function summarizeLearningStatusEvidenceLines(lines?: string[]): string | undefined {
  const summary = (lines ?? [])
    .map((line) => line.replace(/^- /u, "").trim())
    .filter(Boolean)
    .join(" ");
  return summary || undefined;
}

function summarizeSurfaceLineReply(text: string): string {
  const lines = text
    .replace(/```[\s\S]*?```/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^#{1,6}\s+/.test(line));
  const preservedLines = lines.filter(
    (line) =>
      line.startsWith("Learning loop:") ||
      line.startsWith("Improvement pulse:") ||
      line.startsWith("Daily artifacts:") ||
      line.startsWith("- 最近落账:") ||
      line.startsWith("- Protected anchors:"),
  );
  const normalizeSummaryText = (value: string): string => value.replace(/\s+/g, " ").trim();

  if (preservedLines.length === 0) {
    return normalizeSummaryText(lines.slice(0, 3).join(" ")).slice(0, 420);
  }

  const preservedSummary = normalizeSummaryText(Array.from(new Set(preservedLines)).join(" "));
  const preservedSet = new Set(preservedLines);
  const regularSummary = normalizeSummaryText(
    lines
      .filter((line) => !preservedSet.has(line))
      .slice(0, 2)
      .join(" "),
  );
  const regularBudget = Math.max(0, 420 - preservedSummary.length - (regularSummary ? 1 : 0));
  const trimmedRegularSummary = regularSummary.slice(0, regularBudget).trim();

  // Reserve space for workflow truth so long front-matter cannot crowd it out
  // of the shared surface ledger summary.
  return normalizeSummaryText(
    [trimmedRegularSummary, preservedSummary].filter(Boolean).join(" "),
  ).slice(0, 420);
}

function inferFeishuWorkReceiptRepairDisposition(
  userMessage: string,
): "none" | "correction_loop" | "repair_ticket_candidate" {
  if (!isCorrectionLoopInput(userMessage)) {
    return "none";
  }
  return /(重复|反复|再次|又出现|连续|same issue|again|repeated|recurring|repeat)/iu.test(
    userMessage,
  )
    ? "repair_ticket_candidate"
    : "correction_loop";
}

function inferFeishuWorkReceiptTimeframe(userMessage: string): string {
  const normalized = userMessage.trim().toLowerCase();
  if (/(未来半年|半年|6个月|six months)/iu.test(normalized)) {
    return "next_6_months";
  }
  if (/(今天|今日|today|现在|立刻|马上|immediately|right now)/iu.test(normalized)) {
    return "today_or_immediate";
  }
  if (/(昨天|昨日|yesterday)/iu.test(normalized)) {
    return "yesterday";
  }
  if (/(本周|这周|this week)/iu.test(normalized)) {
    return "this_week";
  }
  if (/(下周|next week)/iu.test(normalized)) {
    return "next_week";
  }
  if (/(最近|近期|recent|latest)/iu.test(normalized)) {
    return "recent_window";
  }
  if (/(长期|long term|long[-\\s]?horizon)/iu.test(normalized)) {
    return "long_horizon";
  }
  return "unspecified";
}

function inferFeishuWorkReceiptRequestedAction(params: {
  userMessage: string;
  targetSurface?: FeishuChatSurfaceName;
  repairDisposition: "none" | "correction_loop" | "repair_ticket_candidate";
}): string {
  const normalized = params.userMessage.trim().toLowerCase();
  if (params.repairDisposition !== "none") {
    return "repair_previous_answer";
  }
  if (looksLikeLearningTimeboxStatusAsk(params.userMessage)) {
    return "check_learning_status";
  }
  if (looksLikeLearningInternalizationAuditAsk(params.userMessage)) {
    return "audit_learning_internalization";
  }
  if (looksLikeLearningWorkflowAuditAsk(params.userMessage)) {
    return "audit_learning_workflow";
  }
  if (looksLikeHoldingsRevalidationAsk(params.userMessage)) {
    return "revalidate_existing_thesis";
  }
  if (looksLikeDailyOperatingBrief(params.userMessage)) {
    return "summarize_system_state";
  }
  if (
    /(实现|写代码|改代码|创建文件|patch|修一下|修复|fix\b|implement|write code|create file)/iu.test(
      normalized,
    )
  ) {
    return "implement_or_edit_system";
  }
  if (
    params.targetSurface === "learning_command" ||
    /(学习|学一下|去学|研究一下|内化|补一下|study|learn)/iu.test(normalized)
  ) {
    return "start_or_continue_learning";
  }
  if (
    /(分析|研究|总结|看看|浏览器|browser|筛|挑|生成几个|top ideas|shortlist)/iu.test(normalized)
  ) {
    return "analyze_or_summarize";
  }
  return "respond_to_request";
}

function inferFeishuWorkReceiptScope(params: {
  userMessage: string;
  targetSurface?: FeishuChatSurfaceName;
  repairDisposition: "none" | "correction_loop" | "repair_ticket_candidate";
}): string {
  if (params.repairDisposition !== "none") {
    return "answer_repair";
  }
  if (looksLikeHoldingsRevalidationAsk(params.userMessage)) {
    return "holdings_thesis";
  }
  if (looksLikeLearningInternalizationAuditAsk(params.userMessage)) {
    return "learning_internalization";
  }
  if (looksLikeLearningWorkflowAuditAsk(params.userMessage)) {
    return "learning_workflow";
  }
  if (looksLikeLearningTimeboxStatusAsk(params.userMessage)) {
    return "learning_status";
  }
  if (looksLikeDailyOperatingBrief(params.userMessage)) {
    return "control_room_daily_brief";
  }
  switch (params.targetSurface) {
    case "learning_command":
      return "learning_command";
    case "technical_daily":
      return "macro_or_technical_research";
    case "fundamental_research":
      return "fundamental_research";
    case "knowledge_maintenance":
      return "knowledge_maintenance";
    case "ops_audit":
      return "ops_audit";
    case "watchtower":
      return "watchtower";
    case "control_room":
      return "control_room_general";
    default:
      return "general";
  }
}

function inferFeishuWorkReceiptOutputShape(params: {
  userMessage: string;
  finalReplyText: string;
  requestedAction: string;
  repairDisposition: "none" | "correction_loop" | "repair_ticket_candidate";
}): string {
  const normalized = params.userMessage.trim().toLowerCase();
  if (params.repairDisposition === "repair_ticket_candidate") {
    return "correction_note_plus_repair_ticket_candidate";
  }
  if (params.repairDisposition === "correction_loop") {
    return "correction_note";
  }
  if (/^## (Learning status|Timebox status)\b/mu.test(params.finalReplyText)) {
    return "status_brief";
  }
  if (looksLikeDailyOperatingBrief(params.userMessage)) {
    return "daily_brief";
  }
  if (
    /(几个|几只|top|候选|shortlist|最看好)/iu.test(normalized) &&
    /(股票|标的|stock|stocks|names?)/iu.test(normalized)
  ) {
    return "shortlist_with_reasons";
  }
  if (
    params.requestedAction === "audit_learning_internalization" ||
    params.requestedAction === "audit_learning_workflow"
  ) {
    return "audit_summary";
  }
  if (params.requestedAction === "revalidate_existing_thesis") {
    return "thesis_revalidation_summary";
  }
  if (params.requestedAction === "implement_or_edit_system") {
    return "patch_or_artifact";
  }
  return "plain_answer";
}

function inferFeishuWorkReceiptReadPathLines(params: {
  requestedAction: string;
  scope: string;
  repairDisposition: "none" | "correction_loop" | "repair_ticket_candidate";
}): string[] {
  if (params.repairDisposition !== "none") {
    return [
      "- recent correction notes or correction-loop receipts",
      "- memory/current-research-line.md",
      "- matching memory/local-memory/*.md durable cards",
      ...(params.repairDisposition === "repair_ticket_candidate"
        ? ["- repair-ticket candidate evidence when the same failure repeats"]
        : []),
    ];
  }
  if (params.requestedAction === "check_learning_status") {
    return [
      "- latest timebox receipt or session status",
      "- latest lobster-workface carryover cue",
      "- protected anchors: memory/current-research-line.md, memory/unified-risk-view.md when present, MEMORY.md",
    ];
  }
  if (params.requestedAction === "summarize_system_state") {
    return [
      "- latest lobster-workface artifact",
      "- latest portfolio-answer scorecard and validation weekly when present",
      "- current learning-status evidence and protected-anchor presence",
    ];
  }
  if (
    params.requestedAction === "revalidate_existing_thesis" ||
    params.scope === "holdings_thesis"
  ) {
    return [
      "- memory/current-research-line.md",
      "- MEMORY.md",
      "- latest carryover cue and correction notes",
      "- matching memory/local-memory/*.md durable cards",
    ];
  }
  if (
    params.requestedAction === "start_or_continue_learning" ||
    params.requestedAction === "audit_learning_internalization" ||
    params.requestedAction === "audit_learning_workflow"
  ) {
    return [
      "- memory/current-research-line.md",
      "- MEMORY.md",
      "- latest carryover cue and correction notes",
      "- matching memory/local-memory/*.md durable cards",
    ];
  }
  if (params.requestedAction === "implement_or_edit_system") {
    return [
      "- memory/current-research-line.md",
      "- MEMORY.md",
      "- matching workflow memory cards",
      "- current code surface under repair",
    ];
  }
  return [
    "- memory/current-research-line.md",
    "- MEMORY.md",
    "- latest carryover cue and correction notes",
    "- matching memory/local-memory/*.md durable cards",
  ];
}

async function persistFeishuWorkReceipt(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  targetSurface?: FeishuChatSurfaceName;
  replyContract?: FeishuControlRoomOrchestrationPlan["replyContract"];
  chatId: string;
  sessionKey: string;
  messageId: string;
  userMessage: string;
  finalReplyText?: string;
  handledAt: string;
  replySummary: string;
}) {
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg as OpenClawConfig, params.agentId);
  const receiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");
  await ensureFeishuWorkReceiptArtifacts({ receiptsDir });

  if (!params.targetSurface || !params.finalReplyText?.trim()) {
    return;
  }
  const repairDisposition = inferFeishuWorkReceiptRepairDisposition(params.userMessage);
  const requestedAction = inferFeishuWorkReceiptRequestedAction({
    userMessage: params.userMessage,
    targetSurface: params.targetSurface,
    repairDisposition,
  });
  const scope = inferFeishuWorkReceiptScope({
    userMessage: params.userMessage,
    targetSurface: params.targetSurface,
    repairDisposition,
  });
  const outputShape = inferFeishuWorkReceiptOutputShape({
    userMessage: params.userMessage,
    finalReplyText: params.finalReplyText,
    requestedAction,
    repairDisposition,
  });
  const fileName = buildFeishuWorkReceiptFilename({
    handledAt: params.handledAt,
    surface: params.targetSurface,
    messageId: params.messageId,
  });
  const financeDoctrineProof = extractFeishuFinanceDoctrineProof({
    targetSurface: params.targetSurface,
    replyContract: params.replyContract,
    finalReplyText: params.finalReplyText,
  });
  const content = renderFeishuWorkReceiptArtifact({
    handledAt: params.handledAt,
    surface: params.targetSurface,
    chatId: params.chatId,
    sessionKey: params.sessionKey,
    messageId: params.messageId,
    userMessage: params.userMessage.replace(/\s+/g, " ").trim(),
    requestedAction,
    scope,
    timeframe: inferFeishuWorkReceiptTimeframe(params.userMessage),
    outputShape,
    repairDisposition,
    readPathLines: inferFeishuWorkReceiptReadPathLines({
      requestedAction,
      scope,
      repairDisposition,
    }),
    finalReplySummary: params.replySummary,
    financeDoctrineProof,
  });
  await fs.writeFile(path.join(receiptsDir, fileName), content, "utf-8");
  const calibrationReview = extractHoldingsRevalidationCalibrationReview({
    targetSurface: params.targetSurface,
    replyContract: params.replyContract,
    finalReplyText: params.finalReplyText,
  });
  if (calibrationReview) {
    await persistFeishuFinanceDoctrineCalibration({
      receiptsDir,
      handledAt: params.handledAt,
      chatId: params.chatId,
      currentReceiptFileName: fileName,
      review: calibrationReview,
    });
  }
  const indexRows = await writeFeishuWorkReceiptIndex({ receiptsDir });
  await writeFeishuWorkRepairQueue({ receiptsDir, rows: indexRows });
}

async function recordFeishuWorkReceiptPersistFailure(params: {
  cfg: ClawdbotConfig;
  targetSurface?: FeishuChatSurfaceName;
  chatId: string;
  messageId: string;
  error: unknown;
}) {
  await recordOperationalAnomaly({
    cfg: params.cfg,
    category: "write_edit_failure",
    severity: "medium",
    source: "feishu.work_receipts",
    problem: "failed to persist feishu work receipt artifacts",
    evidence: [
      "failure_stage=work_receipt",
      `surface=${params.targetSurface ?? "none"}`,
      `chat_id=${params.chatId}`,
      `message_id=${params.messageId}`,
      `error=${String(params.error)}`,
    ],
    impact:
      "the visible Feishu reply still landed, but the structured work receipt for later repair/debug review is missing",
    suggestedScope:
      "keep reply capture honest and restore the receipt write path before broadening any new debugging workflow",
  });
}

function trimSurfaceLineEntries(entries: string[], maxEntries = 5): string[] {
  return entries.filter(Boolean).slice(0, maxEntries);
}

function parseSurfaceLineIndexRow(content: string): FeishuSurfaceLineIndexRow | undefined {
  const parsed = parseFeishuSurfaceLineArtifact(content);
  if (!parsed) {
    return undefined;
  }
  return {
    surface: parsed.surface as FeishuChatSurfaceName,
    chat: parsed.chatId,
    laneKey: parsed.laneKey,
    lastUpdated: parsed.lastUpdated,
    sessionKey: parsed.sessionKey,
    turnCount: parsed.recentTurnEntries.length,
  };
}

function parseWorkReceiptIndexRow(content: string): FeishuWorkReceiptIndexRow | undefined {
  const parsed = parseFeishuWorkReceiptArtifact(content);
  if (!parsed) {
    return undefined;
  }
  return {
    handledAt: parsed.handledAt,
    surface: parsed.surface,
    chatId: parsed.chatId,
    sessionKey: parsed.sessionKey,
    messageId: parsed.messageId,
    requestedAction: parsed.requestedAction,
    scope: parsed.scope,
    timeframe: parsed.timeframe,
    outputShape: parsed.outputShape,
    repairDisposition: parsed.repairDisposition,
    userMessage: parsed.userMessage,
    finalReplySummary: parsed.finalReplySummary,
  };
}

function inferFeishuRepairIssueKey(row: FeishuWorkReceiptIndexRow): string | undefined {
  if (row.repairDisposition === "none") {
    return undefined;
  }
  const normalized = `${row.userMessage} ${row.finalReplySummary}`.toLowerCase();
  if (
    /词不达意|imprecise|不精准|没答到点|没有答到点|没抓到重点|重点不对|答偏|偏题|跑题/u.test(
      normalized,
    )
  ) {
    return "language_precision_drift";
  }
  if (/动作和范围|scope|requested action|我问的是|不是让你|先说动作|先说范围/u.test(normalized)) {
    return "task_bracket_misread";
  }
  if (/时间框架|timeframe|半年|今天|本周|长期|短期/u.test(normalized)) {
    return "timeframe_mismatch";
  }
  if (/长文|太长|太短|output|格式|先给结论|先列/u.test(normalized)) {
    return "output_shape_mismatch";
  }
  return "general_answer_repair";
}

function looksLikeBroadKnowledgeAdoptionAsk(userMessage: string): boolean {
  return FEISHU_BROAD_KNOWLEDGE_ADOPTION_RE.test(userMessage);
}

function describeFeishuRepairIssue(issueKey: string): string {
  switch (issueKey) {
    case "language_precision_drift":
      return "language precision drift";
    case "task_bracket_misread":
      return "task bracket misread";
    case "timeframe_mismatch":
      return "timeframe mismatch";
    case "output_shape_mismatch":
      return "output-shape mismatch";
    default:
      return "general answer repair";
  }
}

function describeFeishuRepairNextStep(issueKey: string): string {
  switch (issueKey) {
    case "language_precision_drift":
      return "Narrow on requested action, scope, timeframe, and output shape before rewriting the substance.";
    case "task_bracket_misread":
      return "State the current task bracket first, rule out the previous misread, then answer only the requested action.";
    case "timeframe_mismatch":
      return "Pin the requested timeframe before picking evidence, judgment horizon, or recommendation shape.";
    case "output_shape_mismatch":
      return "Match the requested output shape first, then expand only if the operator asks for more detail.";
    default:
      return "Restate the task bracket and run one highest-information next check before rewriting the answer.";
  }
}

function describeFeishuRepairQueueKind(kind: FeishuRepairQueueRow["queueKind"]): string {
  return kind === "adoption_distillation" ? "adoption distillation" : "operator repair";
}

const HOLDINGS_REVALIDATION_DOCTRINE_FIELD_PATTERNS = [
  {
    field: "base_case",
    pattern: /^(?:[-*]\s+|\d+\.\s+)?Base case\s*[:：]\s*(.+)$/iu,
  },
  {
    field: "bear_case",
    pattern: /^(?:[-*]\s+|\d+\.\s+)?Bear case\s*[:：]\s*(.+)$/iu,
  },
  {
    field: "what_changes_my_mind",
    pattern: /^(?:[-*]\s+|\d+\.\s+)?What changes my mind\s*[:：]\s*(.+)$/iu,
  },
  {
    field: "why_no_action_may_be_better",
    pattern: /^(?:[-*]\s+|\d+\.\s+)?Why no action may be better\s*[:：]\s*(.+)$/iu,
  },
] as const;

const HOLDINGS_REVALIDATION_CALIBRATION_FIELD_PATTERNS = [
  {
    field: "observed_outcome",
    pattern: /^(?:[-*]\s+|\d+\.\s+)?Observed outcome\s*[:：]\s*(.+)$/iu,
  },
  {
    field: "closest_scenario",
    pattern: /^(?:[-*]\s+|\d+\.\s+)?Closest scenario\s*[:：]\s*(.+)$/iu,
  },
  {
    field: "change_my_mind_triggered",
    pattern: /^(?:[-*]\s+|\d+\.\s+)?Change-my-mind triggered\s*[:：]\s*(.+)$/iu,
  },
  {
    field: "conviction_looked",
    pattern: /^(?:[-*]\s+|\d+\.\s+)?Conviction looked\s*[:：]\s*(.+)$/iu,
  },
] as const;

function extractFeishuFinanceDoctrineProof(params: {
  targetSurface?: FeishuChatSurfaceName;
  replyContract?: FeishuControlRoomOrchestrationPlan["replyContract"];
  finalReplyText?: string;
}) {
  if (
    params.targetSurface !== "control_room" ||
    params.replyContract !== "holdings_thesis_revalidation" ||
    !params.finalReplyText?.trim()
  ) {
    return undefined;
  }
  const lines = params.finalReplyText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const outputEvidenceLines: string[] = [];
  const doctrineFieldsUsed: string[] = [];
  for (const { field, pattern } of HOLDINGS_REVALIDATION_DOCTRINE_FIELD_PATTERNS) {
    const matchedLine = lines.find((line) => pattern.test(line));
    if (!matchedLine) {
      return undefined;
    }
    doctrineFieldsUsed.push(field);
    outputEvidenceLines.push(matchedLine);
  }
  return {
    consumer: "holdings_thesis_revalidation",
    doctrineFieldsUsed,
    outputEvidenceLines,
    proves:
      "the captured control-room finance reply explicitly exposed the doctrine-labeled fields in the final output",
    doesNotProve:
      "the scenario framing is correct, calibrated, or economically superior; it only proves those fields appeared in the retained reply text",
  };
}

function normalizeCalibrationScenario(
  value: string,
): "base_case" | "bear_case" | "unclear" | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "base_case" || normalized === "base case") {
    return "base_case";
  }
  if (normalized === "bear_case" || normalized === "bear case") {
    return "bear_case";
  }
  if (normalized === "unclear") {
    return "unclear";
  }
  return undefined;
}

function normalizeCalibrationTriggered(value: string): "yes" | "no" | "unclear" | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "yes" || normalized === "no" || normalized === "unclear") {
    return normalized;
  }
  return undefined;
}

function normalizeCalibrationConviction(
  value: string,
): "too_high" | "too_low" | "about_right" | "unclear" | undefined {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  if (
    normalized === "too_high" ||
    normalized === "too_low" ||
    normalized === "about_right" ||
    normalized === "unclear"
  ) {
    return normalized;
  }
  return undefined;
}

function extractHoldingsRevalidationCalibrationReview(params: {
  targetSurface?: FeishuChatSurfaceName;
  replyContract?: FeishuControlRoomOrchestrationPlan["replyContract"];
  finalReplyText?: string;
}) {
  if (
    params.targetSurface !== "control_room" ||
    params.replyContract !== "holdings_thesis_revalidation" ||
    !params.finalReplyText?.trim()
  ) {
    return undefined;
  }
  const lines = params.finalReplyText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const observedOutcomeLine = lines.find((line) =>
    HOLDINGS_REVALIDATION_CALIBRATION_FIELD_PATTERNS[0].pattern.test(line),
  );
  const closestScenarioLine = lines.find((line) =>
    HOLDINGS_REVALIDATION_CALIBRATION_FIELD_PATTERNS[1].pattern.test(line),
  );
  const changeMyMindTriggeredLine = lines.find((line) =>
    HOLDINGS_REVALIDATION_CALIBRATION_FIELD_PATTERNS[2].pattern.test(line),
  );
  const convictionLookedLine = lines.find((line) =>
    HOLDINGS_REVALIDATION_CALIBRATION_FIELD_PATTERNS[3].pattern.test(line),
  );
  const observedOutcome = observedOutcomeLine?.replace(
    HOLDINGS_REVALIDATION_CALIBRATION_FIELD_PATTERNS[0].pattern,
    "$1",
  );
  const scenarioClosestToOutcome = closestScenarioLine
    ? normalizeCalibrationScenario(
        closestScenarioLine.replace(
          HOLDINGS_REVALIDATION_CALIBRATION_FIELD_PATTERNS[1].pattern,
          "$1",
        ),
      )
    : undefined;
  const changeMyMindTriggered = changeMyMindTriggeredLine
    ? normalizeCalibrationTriggered(
        changeMyMindTriggeredLine.replace(
          HOLDINGS_REVALIDATION_CALIBRATION_FIELD_PATTERNS[2].pattern,
          "$1",
        ),
      )
    : undefined;
  const convictionLooksTooHighOrLow = convictionLookedLine
    ? normalizeCalibrationConviction(
        convictionLookedLine.replace(
          HOLDINGS_REVALIDATION_CALIBRATION_FIELD_PATTERNS[3].pattern,
          "$1",
        ),
      )
    : undefined;
  if (
    !observedOutcome?.trim() ||
    !scenarioClosestToOutcome ||
    !changeMyMindTriggered ||
    !convictionLooksTooHighOrLow
  ) {
    return undefined;
  }
  return {
    observedOutcome: observedOutcome.trim(),
    scenarioClosestToOutcome,
    changeMyMindTriggered,
    convictionLooksTooHighOrLow,
    baseCaseDirectionallyCloser:
      scenarioClosestToOutcome === "base_case"
        ? "yes"
        : scenarioClosestToOutcome === "bear_case"
          ? "no"
          : "unclear",
  } as const;
}

async function persistFeishuFinanceDoctrineCalibration(params: {
  receiptsDir: string;
  handledAt: string;
  chatId: string;
  currentReceiptFileName: string;
  review: {
    observedOutcome: string;
    scenarioClosestToOutcome: "base_case" | "bear_case" | "unclear";
    baseCaseDirectionallyCloser: "yes" | "no" | "unclear";
    changeMyMindTriggered: "yes" | "no" | "unclear";
    convictionLooksTooHighOrLow: "too_high" | "too_low" | "about_right" | "unclear";
  };
}) {
  const entries = await fs.readdir(params.receiptsDir, { withFileTypes: true });
  const priorDoctrineReceipt = (
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && isFeishuWorkReceiptFilename(entry.name))
        .map(async (entry) => {
          if (entry.name === params.currentReceiptFileName) {
            return undefined;
          }
          const content = await fs.readFile(path.join(params.receiptsDir, entry.name), "utf-8");
          const parsed = parseFeishuWorkReceiptArtifact(content);
          if (
            !parsed ||
            parsed.chatId !== params.chatId ||
            !parsed.financeDoctrineProof ||
            parsed.financeDoctrineProof.consumer !== "holdings_thesis_revalidation" ||
            parsed.handledAt >= params.handledAt
          ) {
            return undefined;
          }
          return {
            fileName: entry.name,
            handledAt: parsed.handledAt,
          };
        }),
    )
  )
    .filter((entry): entry is { fileName: string; handledAt: string } => Boolean(entry))
    .sort((a, b) => b.handledAt.localeCompare(a.handledAt))[0];

  if (!priorDoctrineReceipt) {
    return;
  }

  const fileName = buildFeishuFinanceDoctrineCalibrationFilename({
    reviewDate: params.handledAt,
    consumer: "holdings_thesis_revalidation",
    linkedReceipt: priorDoctrineReceipt.fileName,
  });
  const content = renderFeishuFinanceDoctrineCalibrationArtifact({
    reviewDate: params.handledAt,
    consumer: "holdings_thesis_revalidation",
    linkedReceipt: `memory/feishu-work-receipts/${priorDoctrineReceipt.fileName}`,
    observedOutcome: params.review.observedOutcome,
    scenarioClosestToOutcome: params.review.scenarioClosestToOutcome,
    baseCaseDirectionallyCloser: params.review.baseCaseDirectionallyCloser,
    changeMyMindTriggered: params.review.changeMyMindTriggered,
    convictionLooksTooHighOrLow: params.review.convictionLooksTooHighOrLow,
    notes: `derived from later holdings_thesis_revalidation reply in memory/feishu-work-receipts/${params.currentReceiptFileName}`,
  });
  await fs.writeFile(path.join(params.receiptsDir, fileName), content, "utf-8");
}

async function loadLearningCouncilRuntimeArtifactForMessage(params: {
  receiptsDir: string;
  messageId: string;
}) {
  const workspaceDir = path.dirname(path.dirname(params.receiptsDir));
  const directPath = path.join(
    workspaceDir,
    buildLearningCouncilArtifactJsonRelativePath(params.messageId),
  );
  try {
    const content = await fs.readFile(directPath, "utf-8");
    const parsed = parseLearningCouncilRuntimeArtifact(content);
    if (parsed?.messageId === params.messageId) {
      return parsed;
    }
  } catch {}

  const artifactsDir = path.join(workspaceDir, buildKnowledgeArtifactDir("learningCouncils"));
  const entries = await fs.readdir(artifactsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      const content = await fs.readFile(path.join(artifactsDir, entry.name), "utf-8");
      const parsed = parseLearningCouncilRuntimeArtifact(content);
      if (parsed?.messageId === params.messageId) {
        return parsed;
      }
    } catch {}
  }
  return undefined;
}

async function collectAdoptionDistillationRepairSeeds(params: {
  receiptsDir: string;
  rows: FeishuWorkReceiptIndexRow[];
}): Promise<FeishuRepairQueueSeed[]> {
  const seeds: FeishuRepairQueueSeed[] = [];
  for (const row of params.rows) {
    if (
      row.requestedAction !== "start_or_continue_learning" ||
      row.repairDisposition !== "none" ||
      !looksLikeBroadKnowledgeAdoptionAsk(row.userMessage)
    ) {
      continue;
    }
    const artifact = await loadLearningCouncilRuntimeArtifactForMessage({
      receiptsDir: params.receiptsDir,
      messageId: row.messageId,
    });
    const improvementLines =
      artifact?.runPacket?.lobsterImprovementLines
        ?.map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 3) ?? [];
    for (const line of improvementLines) {
      const normalizedLine = normalizeClassifiedPublishFingerprint(line);
      seeds.push({
        queueKind: "adoption_distillation",
        issueKey: "adoption_distillation_candidate",
        issueLabel: "Lobster improvement cue",
        groupingKey: `adoption_distillation_candidate:${normalizedLine}`,
        latestHandledAt: row.handledAt,
        latestSurface: row.surface,
        latestChatId: row.chatId,
        requestedAction: row.requestedAction,
        scope: row.scope,
        outputShape: row.outputShape,
        nextNarrowingStep: line,
        latestAsk: row.userMessage,
        latestReplySummary: row.finalReplySummary,
      });
    }
  }
  return seeds;
}

async function writeFeishuWorkReceiptIndex(params: {
  receiptsDir: string;
}): Promise<FeishuWorkReceiptIndexRow[]> {
  const entries = await fs.readdir(params.receiptsDir, { withFileTypes: true }).catch(() => []);
  const rows: FeishuWorkReceiptIndexRow[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isFeishuWorkReceiptFilename(entry.name)) {
      continue;
    }
    try {
      const content = await fs.readFile(path.join(params.receiptsDir, entry.name), "utf-8");
      const parsed = parseWorkReceiptIndexRow(content);
      if (parsed) {
        rows.push(parsed);
      }
    } catch {}
  }

  const sortedRows = rows.toSorted((a, b) => b.handledAt.localeCompare(a.handledAt));
  const recentRows = sortedRows.slice(0, 12);
  const content = [
    "# Feishu Work Receipt Index",
    "",
    `- **Tracked Receipts**: ${sortedRows.length}`,
    "",
    "## Recent Receipts",
    ...(recentRows.length > 0
      ? recentRows.flatMap((row) => [
          `- ${row.handledAt} · ${row.surface} / ${row.chatId} · ${row.requestedAction} · ${row.scope} · ${row.outputShape} · repair ${row.repairDisposition}`,
          `  - Ask: ${row.userMessage}`,
          `  - Reply: ${row.finalReplySummary}`,
        ])
      : ["- No Feishu work receipts are recorded yet."]),
    "",
  ].join("\n");

  await fs.writeFile(path.join(params.receiptsDir, "index.md"), content, "utf-8");
  return sortedRows;
}

export async function ensureFeishuWorkReceiptArtifacts(params: {
  receiptsDir: string;
}): Promise<void> {
  await fs.mkdir(params.receiptsDir, { recursive: true });
  const indexPath = path.join(params.receiptsDir, "index.md");
  const repairQueuePath = path.join(params.receiptsDir, "repair-queue.md");
  const emptyIndex = [
    "# Feishu Work Receipt Index",
    "",
    "- **Tracked Receipts**: 0",
    "",
    "## Recent Receipts",
    "- No Feishu work receipts are recorded yet.",
    "",
  ].join("\n");
  const emptyRepairQueue = [
    "# Feishu Work Repair Queue",
    "",
    "- **Active Repair Clusters**: 0",
    "",
    "## Next Priority Self-Repair",
    "- No repair-minded work receipts are queued right now.",
    "",
    "## Active Repair Queue",
    "- No repair-minded work receipts are queued right now.",
    "",
  ].join("\n");

  await fs.access(indexPath).catch(async () => {
    await fs.writeFile(indexPath, emptyIndex, "utf-8");
  });
  await fs.access(repairQueuePath).catch(async () => {
    await fs.writeFile(repairQueuePath, emptyRepairQueue, "utf-8");
  });
}

async function writeFeishuWorkRepairQueue(params: {
  receiptsDir: string;
  rows: FeishuWorkReceiptIndexRow[];
}): Promise<FeishuRepairQueueRow[]> {
  const operatorSeeds = params.rows
    .map((row): FeishuRepairQueueSeed | undefined => {
      const issueKey = inferFeishuRepairIssueKey(row);
      if (!issueKey) {
        return undefined;
      }
      return {
        queueKind: "operator_repair",
        issueKey,
        issueLabel: describeFeishuRepairIssue(issueKey),
        groupingKey: `${issueKey}:${row.requestedAction}:${row.scope}:${row.outputShape}`,
        latestHandledAt: row.handledAt,
        latestSurface: row.surface,
        latestChatId: row.chatId,
        requestedAction: row.requestedAction,
        scope: row.scope,
        outputShape: row.outputShape,
        nextNarrowingStep: describeFeishuRepairNextStep(issueKey),
        latestAsk: row.userMessage,
        latestReplySummary: row.finalReplySummary,
      };
    })
    .filter((entry): entry is FeishuRepairQueueSeed => Boolean(entry));
  const adoptionSeeds = await collectAdoptionDistillationRepairSeeds(params);
  const allSeeds = [...operatorSeeds, ...adoptionSeeds];

  const grouped = new Map<string, FeishuRepairQueueRow>();
  for (const seed of allSeeds) {
    const existing = grouped.get(seed.groupingKey);
    if (!existing) {
      grouped.set(seed.groupingKey, {
        queueKind: seed.queueKind,
        issueKey: seed.issueKey,
        issueLabel: seed.issueLabel,
        hits: 1,
        latestHandledAt: seed.latestHandledAt,
        latestSurface: seed.latestSurface,
        latestChatId: seed.latestChatId,
        requestedAction: seed.requestedAction,
        scope: seed.scope,
        outputShape: seed.outputShape,
        nextNarrowingStep: seed.nextNarrowingStep,
        latestAsk: seed.latestAsk,
        latestReplySummary: seed.latestReplySummary,
      });
      continue;
    }
    existing.hits += 1;
    if (seed.latestHandledAt.localeCompare(existing.latestHandledAt) > 0) {
      existing.latestHandledAt = seed.latestHandledAt;
      existing.latestSurface = seed.latestSurface;
      existing.latestChatId = seed.latestChatId;
      existing.requestedAction = seed.requestedAction;
      existing.scope = seed.scope;
      existing.outputShape = seed.outputShape;
      existing.nextNarrowingStep = seed.nextNarrowingStep;
      existing.latestAsk = seed.latestAsk;
      existing.latestReplySummary = seed.latestReplySummary;
    }
  }

  const sortedRows = Array.from(grouped.values()).toSorted((a, b) => {
    if (b.hits !== a.hits) {
      return b.hits - a.hits;
    }
    const handledAtOrder = b.latestHandledAt.localeCompare(a.latestHandledAt);
    if (handledAtOrder !== 0) {
      return handledAtOrder;
    }
    if (a.queueKind !== b.queueKind) {
      return a.queueKind === "adoption_distillation" ? -1 : 1;
    }
    return a.issueLabel.localeCompare(b.issueLabel);
  });
  const priorityRow = sortedRows[0];
  const content = [
    "# Feishu Work Repair Queue",
    "",
    `- **Active Repair Clusters**: ${sortedRows.length}`,
    "",
    "## Next Priority Self-Repair",
    ...(priorityRow
      ? [
          `- ${describeFeishuRepairQueueKind(priorityRow.queueKind)} · ${priorityRow.issueLabel} · hits ${priorityRow.hits} · latest ${priorityRow.latestHandledAt}`,
          `  - Latest Surface: ${priorityRow.latestSurface} / ${priorityRow.latestChatId}`,
          `  - Requested Shape: ${priorityRow.requestedAction} / ${priorityRow.scope} / ${priorityRow.outputShape}`,
          `  - Next Narrowing Step: ${priorityRow.nextNarrowingStep}`,
          `  - Latest Ask: ${priorityRow.latestAsk}`,
          `  - Latest Reply: ${priorityRow.latestReplySummary}`,
        ]
      : ["- No repair-minded work receipts are queued right now."]),
    "",
    "## Active Repair Queue",
    ...(sortedRows.length > 0
      ? sortedRows.flatMap((row) => [
          `- ${describeFeishuRepairQueueKind(row.queueKind)} · ${row.issueLabel} · hits ${row.hits} · latest ${row.latestHandledAt} · ${row.requestedAction} / ${row.scope} / ${row.outputShape}`,
          `  - Latest Surface: ${row.latestSurface} / ${row.latestChatId}`,
          `  - Next Narrowing Step: ${row.nextNarrowingStep}`,
          `  - Latest Ask: ${row.latestAsk}`,
          `  - Latest Reply: ${row.latestReplySummary}`,
        ])
      : ["- No repair-minded work receipts are queued right now."]),
    "",
  ].join("\n");

  await fs.writeFile(path.join(params.receiptsDir, "repair-queue.md"), content, "utf-8");
  return sortedRows;
}

async function writeFeishuSurfaceLineIndex(params: {
  memoryDir: string;
}): Promise<FeishuSurfaceLineIndexRow[]> {
  const entries = await fs.readdir(params.memoryDir, { withFileTypes: true }).catch(() => []);
  const rows: FeishuSurfaceLineIndexRow[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "index.md") {
      continue;
    }
    try {
      const content = await fs.readFile(path.join(params.memoryDir, entry.name), "utf-8");
      const parsed = parseSurfaceLineIndexRow(content);
      if (parsed) {
        rows.push(parsed);
      }
    } catch {}
  }

  const sortedRows = rows.toSorted((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));
  const content = renderFeishuSurfaceLanePanelArtifact({
    activeLanes: sortedRows.length,
    laneMeterLines:
      sortedRows.length > 0
        ? sortedRows.map(
            (row) =>
              `- ${row.surface} / ${row.chat}: ${row.turnCount} turn${row.turnCount === 1 ? "" : "s"} · session ${row.sessionKey} · updated ${row.lastUpdated}`,
          )
        : ["- No active surface lanes are recorded yet."],
  });

  await fs.writeFile(path.join(params.memoryDir, "index.md"), content, "utf-8");
  return sortedRows;
}

function assessFeishuSurfaceLaneHealth(rows: FeishuSurfaceLineIndexRow[]): FeishuSurfaceLaneHealth {
  const crowdedChats = Array.from(
    rows.reduce((map, row) => {
      const surfaces = map.get(row.chat) ?? new Set<FeishuChatSurfaceName>();
      if (row.surface !== "control_room" && row.surface !== "watchtower") {
        surfaces.add(row.surface);
      }
      map.set(row.chat, surfaces);
      return map;
    }, new Map<string, Set<FeishuChatSurfaceName>>()),
  )
    .filter(([, surfaces]) => surfaces.size >= 3)
    .map(([chat]) => chat)
    .toSorted();

  const busiestLane = rows.toSorted((a, b) => b.turnCount - a.turnCount)[0];
  return {
    status: rows.length >= 8 || crowdedChats.length > 0 ? "crowded" : "stable",
    activeLanes: rows.length,
    crowdedChats,
    busiestLane: busiestLane ? `${busiestLane.surface} / ${busiestLane.chat}` : undefined,
  };
}

async function writeFeishuSurfaceLaneHealth(params: {
  memoryDir: string;
  rows: FeishuSurfaceLineIndexRow[];
}): Promise<FeishuSurfaceLaneHealth> {
  const health = assessFeishuSurfaceLaneHealth(params.rows);
  const content = renderFeishuSurfaceLaneHealthArtifact({
    status: health.status,
    activeLanes: health.activeLanes,
    crowdedChats: health.crowdedChats,
    busiestLane: health.busiestLane,
    guidanceLines:
      health.status === "stable"
        ? [
            "- Lane load is healthy. Keep specialist work in dedicated chats and use control_room for orchestration.",
          ]
        : [
            "- Lane load is getting crowded. Keep each specialist line focused and move mixed requests back to control_room.",
            "- If one chat keeps carrying too many specialist lanes, split the work across dedicated windows before quality drifts.",
          ],
  });

  await fs.writeFile(path.join(params.memoryDir, "health.md"), content, "utf-8");
  return health;
}

async function persistFeishuSurfaceLine(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  targetSurface?: FeishuChatSurfaceName;
  replyContract?: FeishuControlRoomOrchestrationPlan["replyContract"];
  chatId: string;
  sessionKey: string;
  messageId: string;
  userMessage: string;
  finalReplyText?: string;
}): Promise<FeishuSurfaceLineArtifact | undefined> {
  if (!params.targetSurface) {
    return undefined;
  }

  const workspaceDir = resolveAgentWorkspaceDir(params.cfg as OpenClawConfig, params.agentId);
  const memoryDir = path.join(workspaceDir, "memory", "feishu-surface-lines");
  const chatStem = sanitizeSurfaceLedgerSegment(params.chatId) || "chat";
  const fileName = `${params.targetSurface}-${chatStem}.md`;
  const filePath = path.join(memoryDir, fileName);
  const laneKey = `${params.targetSurface}:${chatStem}`;
  const now = new Date().toISOString();
  const replySummary = params.finalReplyText
    ? summarizeSurfaceLineReply(params.finalReplyText)
    : "reply summary unavailable";
  const latestEntry = [
    `### ${now} · ${params.messageId}`,
    `- User: ${params.userMessage.replace(/\s+/g, " ").trim()}`,
    `- Reply summary: ${replySummary}`,
    `- Session Key: ${params.sessionKey}`,
  ].join("\n");

  let priorEntries: string[] = [];
  try {
    const existing = await fs.readFile(filePath, "utf-8");
    const marker = "\n## Recent Turns\n";
    const markerIndex = existing.indexOf(marker);
    if (markerIndex >= 0) {
      priorEntries = existing
        .slice(markerIndex + marker.length)
        .split(/\n(?=### )/u)
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
  } catch {}

  const entries = trimSurfaceLineEntries([latestEntry, ...priorEntries]);
  const content = renderFeishuSurfaceLineArtifact({
    surface: params.targetSurface,
    chatId: params.chatId,
    laneKey,
    lastUpdated: now,
    sessionKey: params.sessionKey,
    recentTurnEntries: entries,
  });

  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
  try {
    await persistFeishuWorkReceipt({
      cfg: params.cfg,
      agentId: params.agentId,
      targetSurface: params.targetSurface,
      replyContract: params.replyContract,
      chatId: params.chatId,
      sessionKey: params.sessionKey,
      messageId: params.messageId,
      userMessage: params.userMessage,
      finalReplyText: params.finalReplyText,
      handledAt: now,
      replySummary,
    });
  } catch (error) {
    await recordFeishuWorkReceiptPersistFailure({
      cfg: params.cfg,
      targetSurface: params.targetSurface,
      chatId: params.chatId,
      messageId: params.messageId,
      error,
    });
  }
  const indexRows = await writeFeishuSurfaceLineIndex({ memoryDir });
  const laneHealth = await writeFeishuSurfaceLaneHealth({ memoryDir, rows: indexRows });
  if (laneHealth.status !== "stable") {
    const evidence = [`active_lanes=${laneHealth.activeLanes}`];
    if (laneHealth.crowdedChats.length > 0) {
      evidence.push(`crowded_chats=${laneHealth.crowdedChats.join(",")}`);
    }
    if (laneHealth.busiestLane) {
      evidence.push(`busiest_lane=${laneHealth.busiestLane}`);
    }
    await recordOperationalAnomaly({
      cfg: params.cfg as OpenClawConfig,
      category: "lane_overload",
      severity: laneHealth.crowdedChats.length > 0 ? "medium" : "low",
      source: "feishu.surface_memory",
      problem:
        laneHealth.crowdedChats.length > 0
          ? "one or more chats are carrying too many specialist lanes"
          : "active feishu surface lane count is growing toward crowding",
      evidence,
      impact:
        "lane isolation still holds, but the operator surface topology is getting crowded and may drift into mixed-context usage",
      foundationTemplate: "execution-hygiene",
      suggestedScope:
        "keep specialist chats pinned, keep mixed requests in control_room, and inspect whether crowded lanes need tighter workflow boundaries before changing routing logic",
      fingerprint:
        laneHealth.crowdedChats.length > 0
          ? `crowded:${laneHealth.crowdedChats.join(",")}`
          : `active-lanes:${laneHealth.activeLanes >= 8 ? "8plus" : laneHealth.activeLanes}`,
    });
  }
  return {
    heading: `${params.targetSurface} line memory`,
    relativePath: path.join("memory", "feishu-surface-lines", fileName).split(path.sep).join("/"),
    content,
  };
}

async function recordFeishuSurfacePersistFailure(params: {
  cfg: ClawdbotConfig;
  targetSurface?: FeishuChatSurfaceName;
  effectiveSurface?: FeishuChatSurfaceName;
  chatId: string;
  messageId: string;
  error: unknown;
}) {
  await recordOperationalAnomaly({
    cfg: params.cfg,
    category: "write_edit_failure",
    severity: "medium",
    source: "feishu.surface_memory",
    problem: "failed to persist feishu surface line",
    evidence: [
      "failure_stage=surface_line",
      `surface=${params.targetSurface ?? "none"}`,
      `effective_surface=${params.effectiveSurface ?? params.targetSurface ?? "none"}`,
      `chat_id=${params.chatId}`,
      `message_id=${params.messageId}`,
      `error=${String(params.error)}`,
    ],
    impact: "the specialist line kept working, but the bounded memory ledger was not updated",
  });
}

type LarkLanguageRoutingCandidateCaptureArtifact = {
  schemaVersion: 1;
  boundary: "language_routing_only";
  source: "feishu_final_reply_capture";
  generatedAt: string;
  agentId: string;
  targetSurface?: FeishuChatSurfaceName;
  effectiveSurface?: FeishuChatSurfaceName;
  chatId: string;
  sessionKey: string;
  messageId: string;
  noFinanceLearningArtifact: true;
  candidates: LarkPendingRoutingCandidate[];
  evaluation: {
    schemaVersion: 1;
    boundary: "language_routing_only";
    evaluatedAt: string;
    counts: {
      total: number;
      accepted: number;
      rejected: number;
      discarded: number;
    };
    acceptedCases: LarkRoutingCandidateEvaluation["acceptedCase"][];
    evaluations: LarkRoutingCandidateEvaluation[];
  };
};

type LarkLanguageRoutingCandidateCaptureResult = {
  relativePath: string;
  dateKey: string;
  workspaceDir: string;
};

function buildLarkLanguageCandidateCaptureFileName(messageId: string): string {
  const stem = sanitizeSurfaceLedgerSegment(messageId) || "message";
  return `${stem}.json`;
}

async function persistLarkLanguageRoutingCandidateCapture(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  targetSurface?: FeishuChatSurfaceName;
  effectiveSurface?: FeishuChatSurfaceName;
  chatId: string;
  sessionKey: string;
  messageId: string;
  userMessage: string;
  finalReplyText: string;
  apiReplyPayloads?: readonly unknown[];
}): Promise<LarkLanguageRoutingCandidateCaptureResult | undefined> {
  const userMessage = params.userMessage.trim();
  const finalReplyText = params.finalReplyText.trim();
  if (!userMessage && !finalReplyText) {
    return undefined;
  }

  const generatedAt = new Date().toISOString();
  const userCorpus = userMessage
    ? buildLarkPendingRoutingCandidateCorpus({
        source: "lark_user_utterance",
        payloads: [userMessage],
        generatedAt,
      })
    : undefined;
  const replyCorpus = finalReplyText
    ? buildLarkPendingRoutingCandidateCorpus({
        source: "lark_visible_reply",
        payloads: [finalReplyText],
        generatedAt,
      })
    : undefined;
  const apiCorpus =
    params.apiReplyPayloads && params.apiReplyPayloads.length > 0
      ? buildLarkPendingRoutingCandidateCorpus({
          source: "api_reply",
          payloads: params.apiReplyPayloads,
          generatedAt,
        })
      : undefined;
  const candidates = [
    ...(apiCorpus?.candidates ?? []),
    ...(userCorpus?.candidates ?? []),
    ...(replyCorpus?.candidates ?? []),
  ];
  const evaluation = evaluateLarkRoutingCandidateCorpus({
    cfg: (params.cfg.channels?.feishu ?? {}) as FeishuConfig,
    corpus: {
      schemaVersion: 1,
      boundary: "language_routing_only",
      generatedAt,
      candidates,
    },
    evaluatedAt: generatedAt,
  });
  const artifact: LarkLanguageRoutingCandidateCaptureArtifact = {
    schemaVersion: 1,
    boundary: "language_routing_only",
    source: "feishu_final_reply_capture",
    generatedAt,
    agentId: params.agentId,
    targetSurface: params.targetSurface,
    effectiveSurface: params.effectiveSurface,
    chatId: params.chatId,
    sessionKey: params.sessionKey,
    messageId: params.messageId,
    noFinanceLearningArtifact: true,
    candidates,
    evaluation,
  };

  const workspaceDir = resolveAgentWorkspaceDir(params.cfg as OpenClawConfig, params.agentId);
  const dateStem = generatedAt.slice(0, 10);
  const memoryDir = path.join(workspaceDir, "memory", "lark-language-routing-candidates", dateStem);
  const fileName = buildLarkLanguageCandidateCaptureFileName(params.messageId);
  const filePath = path.join(memoryDir, fileName);
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
  return {
    relativePath: path
      .join("memory", "lark-language-routing-candidates", dateStem, fileName)
      .split(path.sep)
      .join("/"),
    dateKey: dateStem,
    workspaceDir,
  };
}

async function persistLarkLanguageRoutingCandidateCaptureWithFailureReceipt(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  targetSurface?: FeishuChatSurfaceName;
  effectiveSurface?: FeishuChatSurfaceName;
  chatId: string;
  sessionKey: string;
  messageId: string;
  userMessage: string;
  finalReplyText: string;
  apiReplyPayloads?: readonly unknown[];
}) {
  let capture: LarkLanguageRoutingCandidateCaptureResult | undefined;
  try {
    capture = await persistLarkLanguageRoutingCandidateCapture(params);
  } catch (error) {
    await recordOperationalAnomaly({
      cfg: params.cfg,
      category: "write_edit_failure",
      severity: "medium",
      source: "feishu.lark_language_routing_candidates",
      problem: "failed to persist lark language-routing candidate capture",
      evidence: [
        "failure_stage=language_routing_candidate_capture",
        "boundary=language_routing_only",
        "finance_learning_artifact=false",
        `surface=${params.targetSurface ?? "none"}`,
        `effective_surface=${params.effectiveSurface ?? params.targetSurface ?? "none"}`,
        `chat_id=${params.chatId}`,
        `message_id=${params.messageId}`,
        `error=${String(error)}`,
      ],
      impact:
        "the Feishu reply was still delivered, but this turn did not enter the pending language-routing review queue",
      suggestedScope:
        "repair the independent lark-language-routing-candidates artifact path before promoting new routing corpus cases",
    });
    return;
  }
  if (!capture) {
    return;
  }
  try {
    await writeLarkRoutingCandidatePromotionReview({
      workspaceDir: capture.workspaceDir,
      dateKey: capture.dateKey,
      existingCorpus: LARK_ROUTING_CORPUS,
    });
  } catch (error) {
    await recordOperationalAnomaly({
      cfg: params.cfg,
      category: "write_edit_failure",
      severity: "medium",
      source: "feishu.lark_language_routing_review",
      problem: "failed to refresh lark language-routing daily review",
      evidence: [
        "failure_stage=language_routing_daily_review",
        "boundary=language_routing_only",
        "finance_learning_artifact=false",
        `candidate_path=${capture.relativePath}`,
        `date_key=${capture.dateKey}`,
        `chat_id=${params.chatId}`,
        `message_id=${params.messageId}`,
        `error=${String(error)}`,
      ],
      impact:
        "the pending language-routing candidate was captured, but the same-day review and patch artifacts were not refreshed",
      suggestedScope:
        "rerun lark_language_corpus_review for the date before promoting new routing corpus cases",
    });
  }
}

async function persistLarkLanguageHandoffReceiptWithFailureReceipt(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  targetSurface?: FeishuChatSurfaceName;
  effectiveSurface?: FeishuChatSurfaceName;
  chatId: string;
  sessionKey: string;
  messageId: string;
  userMessage: string;
  handoff: Awaited<ReturnType<typeof resolveLarkAgentInstructionHandoff>>;
}): Promise<
  | {
      relativePath: string;
      artifact: LarkLanguageHandoffReceiptArtifact;
    }
  | undefined
> {
  try {
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg as OpenClawConfig, params.agentId);
    return await writeLarkLanguageHandoffReceipt({
      workspaceDir,
      agentId: params.agentId,
      targetSurface: params.targetSurface,
      effectiveSurface: params.effectiveSurface,
      chatId: params.chatId,
      sessionKey: params.sessionKey,
      messageId: params.messageId,
      userMessage: params.userMessage,
      handoff: params.handoff,
    });
  } catch (error) {
    await recordOperationalAnomaly({
      cfg: params.cfg,
      category: "write_edit_failure",
      severity: "medium",
      source: "feishu.lark_language_handoff_receipt",
      problem: "failed to persist lark language handoff receipt",
      evidence: [
        "failure_stage=language_handoff_receipt",
        "boundary=language_handoff_only",
        "finance_learning_artifact=false",
        `surface=${params.targetSurface ?? "none"}`,
        `effective_surface=${params.effectiveSurface ?? params.targetSurface ?? "none"}`,
        `chat_id=${params.chatId}`,
        `message_id=${params.messageId}`,
        `family=${params.handoff.family}`,
        `source=${params.handoff.source}`,
        `backend_tool=${params.handoff.backendToolContract?.toolName ?? "none"}`,
        `error=${String(error)}`,
      ],
      impact:
        "the Feishu turn can still continue, but this language-routing decision did not leave an audit receipt",
      suggestedScope:
        "repair the independent lark-language-handoff-receipts artifact path before relying on handoff receipts for routing eval",
    });
    return undefined;
  }
}

type FeishuInternalizedLearningProof =
  | {
      status: "found";
      rule: string;
      evidencePath: string;
      receiptPath: string;
      reviewPath: string;
      futureUse: string;
      boundary: string;
    }
  | {
      status: "missing";
      failedReason: string;
      searchedPath: string;
    };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

async function findLatestFeishuInternalizedLearningProof(params: {
  workspaceDir: string;
}): Promise<FeishuInternalizedLearningProof> {
  const receiptRoot = path.join(
    params.workspaceDir,
    "memory",
    "finance-learning-retrieval-receipts",
  );
  const searchedPath = "memory/finance-learning-retrieval-receipts";
  let dateDirs: string[];
  try {
    dateDirs = (await fs.readdir(receiptRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return {
      status: "missing",
      failedReason: "no_finance_learning_retrieval_receipts",
      searchedPath,
    };
  }

  for (const dateDir of dateDirs) {
    const datePath = path.join(receiptRoot, dateDir);
    const files = (await fs.readdir(datePath, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .reverse();

    for (const file of files) {
      const absolutePath = path.join(datePath, file);
      let artifact: Record<string, unknown>;
      try {
        artifact = JSON.parse(await fs.readFile(absolutePath, "utf-8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      const retrievalFirstLearning = asRecord(artifact.retrievalFirstLearning);
      const applicationValidation = asRecord(artifact.applicationValidation);
      const learningStatus = firstString(
        retrievalFirstLearning.learningInternalizationStatus,
        applicationValidation.status,
        applicationValidation.applicationValidationStatus,
      );
      if (learningStatus !== "application_ready") {
        continue;
      }

      const postAttachRetrieval = asRecord(artifact.postAttachCapabilityRetrieval);
      const preflightRetrieval = asRecord(artifact.preflightCapabilityRetrieval);
      const candidates = Array.isArray(postAttachRetrieval.candidates)
        ? postAttachRetrieval.candidates
        : Array.isArray(preflightRetrieval.candidates)
          ? preflightRetrieval.candidates
          : [];
      const candidate = asRecord(candidates[0]);
      const reuseGuidance = asRecord(candidate.reuseGuidance);
      const rule = firstString(
        candidate.methodSummary,
        reuseGuidance.implementationCheck,
        candidate.capabilityName,
      );
      const evidencePath = firstString(
        candidate.sourceArticlePath,
        ...(Array.isArray(artifact.normalizedArticleArtifactPaths)
          ? artifact.normalizedArticleArtifactPaths
          : []),
      );
      const futureUse = firstString(
        reuseGuidance.useFor,
        reuseGuidance.implementationCheck,
        candidate.implementationRequirements,
      );
      if (!rule || !evidencePath || !futureUse) {
        return {
          status: "missing",
          failedReason: "missing_internalized_rule_evidence",
          searchedPath,
        };
      }

      const receiptPath = `memory/finance-learning-retrieval-receipts/${dateDir}/${file}`;
      return {
        status: "found",
        rule,
        evidencePath,
        receiptPath,
        reviewPath: firstString(
          retrievalFirstLearning.retrievalReviewPath,
          `memory/finance-learning-retrieval-reviews/${dateDir}.json`,
        )!,
        futureUse,
        boundary: firstString(
          candidate.riskAndFailureModes,
          reuseGuidance.doNotUseFor,
          "research_only; no trading execution approval",
        )!,
      };
    }
  }

  return {
    status: "missing",
    failedReason: "no_application_ready_learning_receipt",
    searchedPath,
  };
}

function renderFeishuKnowledgeInternalizationAuditHandoffReply(params: {
  handoff: Awaited<ReturnType<typeof resolveLarkAgentInstructionHandoff>>;
  handoffReceiptPath?: string;
  targetSurface?: FeishuChatSurfaceName;
  effectiveSurface?: FeishuChatSurfaceName;
  proof: FeishuInternalizedLearningProof;
}): string {
  const lines = [
    "已识别为学习结果复盘/内化审计请求，没有重新学习。",
    `- family: ${params.handoff.family}`,
    `- confidence: ${params.handoff.confidence.toFixed(2)}`,
    `- targetSurface: ${params.targetSurface ?? params.handoff.targetSurface ?? "unknown"}`,
    `- effectiveSurface: ${params.effectiveSurface ?? params.targetSurface ?? "unknown"}`,
    `- handoff receipt: ${params.handoffReceiptPath ?? "write_failed_or_unavailable"}`,
    params.proof.status === "found"
      ? "- learningInternalizationStatus: application_ready"
      : "- learningInternalizationStatus: not_application_ready",
    `- failedReason: ${params.proof.status === "found" ? "none" : params.proof.failedReason}`,
    ...(params.proof.status === "found"
      ? [
          `- 已内化规则: ${params.proof.rule}`,
          `- 证据文件: ${params.proof.evidencePath}`,
          `- learning receipt: ${params.proof.receiptPath}`,
          `- review: ${params.proof.reviewPath}`,
          `- 以后怎么用: ${params.proof.futureUse}`,
          `- 风险边界: ${params.proof.boundary}`,
        ]
      : [`- searched: ${params.proof.searchedPath}`]),
    "- boundary: this reply is a language/knowledge audit handoff only; it did not create a new finance learning artifact and did not approve trades.",
  ];
  if (params.handoff.apiCandidate?.rationale) {
    lines.push(`- rationale: ${params.handoff.apiCandidate.rationale}`);
  }
  return lines.join("\n");
}

function renderFeishuLiveSchedulingQueueReply(params: {
  handoff: Awaited<ReturnType<typeof resolveLarkAgentInstructionHandoff>>;
  handoffReceiptPath?: string;
  targetSurface?: FeishuChatSurfaceName;
  effectiveSurface?: FeishuChatSurfaceName;
}): string {
  return [
    `done — family=live_scheduling_queue; targetSurface=${params.targetSurface ?? params.handoff.targetSurface ?? "unknown"}; effectiveSurface=${params.effectiveSurface ?? params.targetSurface ?? "unknown"}; only the queue contract was classified, no queued work was executed in this reply.`,
    "queued — requested work items remain pending in order; do not treat queued work as completed until a later receipt proves the specific item ran.",
    "next step — run the first queued item only, then return with its receipt/proof before starting the next item.",
    `proof — handoff receipt: ${params.handoffReceiptPath ?? "write_failed_or_unavailable"}; dispatch=direct_queue_guard; model_worker=not_called; boundary=state_report_only_no_trade_no_file_mutation.`,
  ].join("\n");
}

async function persistFeishuSurfaceLineWithFailureReceipt(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  targetSurface?: FeishuChatSurfaceName;
  effectiveSurface?: FeishuChatSurfaceName;
  replyContract?: FeishuControlRoomOrchestrationPlan["replyContract"];
  chatId: string;
  sessionKey: string;
  messageId: string;
  userMessage: string;
  finalReplyText: string;
}) {
  try {
    await persistFeishuSurfaceLine({
      cfg: params.cfg,
      agentId: params.agentId,
      targetSurface: params.targetSurface,
      replyContract: params.replyContract,
      chatId: params.chatId,
      sessionKey: params.sessionKey,
      messageId: params.messageId,
      userMessage: params.userMessage,
      finalReplyText: params.finalReplyText,
    });
  } catch (error) {
    await recordFeishuSurfacePersistFailure({
      cfg: params.cfg,
      targetSurface: params.targetSurface,
      effectiveSurface: params.effectiveSurface,
      chatId: params.chatId,
      messageId: params.messageId,
      error,
    });
  }
}

type FeishuSurfaceLinePersistContext = {
  cfg: ClawdbotConfig;
  agentId: string;
  targetSurface?: FeishuChatSurfaceName;
  effectiveSurface?: FeishuChatSurfaceName;
  replyContract?: FeishuControlRoomOrchestrationPlan["replyContract"];
  chatId: string;
  sessionKey: string;
  messageId: string;
  userMessage: string;
  apiReplyPayloads?: readonly unknown[];
};

function buildFeishuSurfaceLinePersistContext(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  effectiveStateSurface?: FeishuChatSurfaceName;
  replyContract?: FeishuControlRoomOrchestrationPlan["replyContract"];
  chatId: string;
  sessionKey: string;
  messageId: string;
  userMessage: string;
  apiReplyPayloads?: readonly unknown[];
}): FeishuSurfaceLinePersistContext {
  return {
    cfg: params.cfg,
    agentId: params.agentId,
    targetSurface: params.effectiveStateSurface,
    effectiveSurface: params.effectiveStateSurface,
    replyContract: params.replyContract,
    chatId: params.chatId,
    sessionKey: params.sessionKey,
    messageId: params.messageId,
    userMessage: params.userMessage,
    apiReplyPayloads: params.apiReplyPayloads,
  };
}

async function createSendAndPersistFeishuDirectSurfaceReply(
  params: {
    replyRuntime: ReturnType<typeof getFeishuRuntime>["channel"]["reply"];
    runtime: RuntimeEnv;
    replyTargetMessageId: string;
    skipReplyToInMessages: boolean;
    replyInThread: boolean;
    rootId?: string;
    threadReply: boolean;
    mentionTargets?: FeishuMessageContext["mentionTargets"];
    accountId: string;
    messageCreateTimeMs?: number;
    text: string;
  } & FeishuSurfaceLinePersistContext,
): Promise<void> {
  const sendResult = await createAndSendFeishuFinalTextReply({
    replyRuntime: params.replyRuntime,
    cfg: params.cfg,
    agentId: params.agentId,
    runtime: params.runtime,
    chatId: params.chatId,
    replyTargetMessageId: params.replyTargetMessageId,
    skipReplyToInMessages: params.skipReplyToInMessages,
    replyInThread: params.replyInThread,
    rootId: params.rootId,
    threadReply: params.threadReply,
    mentionTargets: params.mentionTargets,
    accountId: params.accountId,
    messageCreateTimeMs: params.messageCreateTimeMs,
    text: params.text,
  });

  await persistCapturedFeishuSurfaceLine({
    cfg: params.cfg,
    agentId: params.agentId,
    targetSurface: params.targetSurface,
    effectiveSurface: params.effectiveSurface,
    replyContract: params.replyContract,
    chatId: params.chatId,
    sessionKey: params.sessionKey,
    messageId: params.messageId,
    userMessage: params.userMessage,
    finalReplyText: sendResult.queuedFinal ? params.text : undefined,
    dispatchQueuedFinal: sendResult.queuedFinal,
    dispatchFinalCount: sendResult.counts.final,
    apiReplyPayloads: params.apiReplyPayloads,
  });
}

async function persistCapturedFeishuSurfaceLine(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  targetSurface?: FeishuChatSurfaceName;
  effectiveSurface?: FeishuChatSurfaceName;
  replyContract?: FeishuControlRoomOrchestrationPlan["replyContract"];
  chatId: string;
  sessionKey: string;
  messageId: string;
  userMessage: string;
  finalReplyText?: string;
  dispatchQueuedFinal?: boolean;
  dispatchFinalCount?: number;
  apiReplyPayloads?: readonly unknown[];
}) {
  const finalReplyText = params.finalReplyText?.trim();
  if (!finalReplyText) {
    const dispatchEvidence: string[] = [];
    if (params.dispatchQueuedFinal !== undefined) {
      dispatchEvidence.push(`dispatch_queued_final=${params.dispatchQueuedFinal}`);
    }
    if (params.dispatchFinalCount !== undefined) {
      dispatchEvidence.push(`dispatch_final_count=${params.dispatchFinalCount}`);
    }
    await recordOperationalAnomaly({
      cfg: params.cfg,
      category: "write_edit_failure",
      severity: "medium",
      source: "feishu.surface_memory",
      problem: "skipped feishu surface line persist because no final reply text was captured",
      evidence: [
        "failure_stage=final_reply_capture",
        "final_reply_captured=false",
        `surface=${params.targetSurface ?? "none"}`,
        `effective_surface=${params.effectiveSurface ?? params.targetSurface ?? "none"}`,
        `chat_id=${params.chatId}`,
        `message_id=${params.messageId}`,
        ...dispatchEvidence,
      ],
      impact:
        "bounded memory skipped ledger update instead of writing a fake reply summary because this turn did not produce a capturable final reply",
      suggestedScope:
        "keep surface ledgers tied only to real final replies and inspect degraded reply paths that bypass final reply capture before changing routing logic",
    });
    return;
  }

  await persistFeishuSurfaceLineWithFailureReceipt({
    cfg: params.cfg,
    agentId: params.agentId,
    targetSurface: params.targetSurface,
    effectiveSurface: params.effectiveSurface,
    replyContract: params.replyContract,
    chatId: params.chatId,
    sessionKey: params.sessionKey,
    messageId: params.messageId,
    userMessage: params.userMessage,
    finalReplyText,
  });
  await persistLarkLanguageRoutingCandidateCaptureWithFailureReceipt({
    cfg: params.cfg,
    agentId: params.agentId,
    targetSurface: params.targetSurface,
    effectiveSurface: params.effectiveSurface,
    chatId: params.chatId,
    sessionKey: params.sessionKey,
    messageId: params.messageId,
    userMessage: params.userMessage,
    finalReplyText,
    apiReplyPayloads: params.apiReplyPayloads,
  });
}

function createSurfaceLineCaptureDispatcher(params: { dispatcher: FeishuReplyDispatcherShape }): {
  dispatcher: FeishuReplyDispatcherShape;
  getLastFinalReplyText: () => string | undefined;
} {
  let lastFinalReplyText: string | undefined;
  return {
    dispatcher: {
      ...params.dispatcher,
      sendFinalReply: (payload: ReplyPayload) => {
        const text = payload.text?.trim();
        const queued = params.dispatcher.sendFinalReply(payload);
        if (queued && text) {
          lastFinalReplyText = text;
        }
        return queued;
      },
    },
    getLastFinalReplyText: () => lastFinalReplyText,
  };
}

function shouldSuppressDuplicateDailyWorkface(params: {
  chatId: string;
  filename: string;
  content: string;
}) {
  const fingerprint = `${params.chatId}:${params.filename}:${normalizeClassifiedPublishFingerprint(params.content)}`;
  const now = Date.now();
  const previousSeenAt = dailyWorkfaceSeenAt.get(fingerprint) ?? 0;
  if (now - previousSeenAt < DAILY_WORKFACE_PUBLISH_DEDUP_TTL_MS) {
    return true;
  }
  dailyWorkfaceSeenAt.set(fingerprint, now);
  return false;
}

type FeishuPendingPublish = {
  promise: Promise<unknown>;
  target: string;
  label: string;
};

async function waitForFeishuDispatcherAndPublishes(params: {
  dispatcher: FeishuReplyDispatcherShape;
  cfg: ClawdbotConfig;
  source: string;
  pendingPublishes: FeishuPendingPublish[];
}): Promise<void> {
  await params.dispatcher.waitForIdle();
  if (params.pendingPublishes.length > 0) {
    const results = await Promise.allSettled(
      params.pendingPublishes.map((publish) => publish.promise),
    );
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status !== "rejected") {
        continue;
      }
      const publish = params.pendingPublishes[index];
      await recordOperationalAnomaly({
        cfg: params.cfg,
        category: "write_edit_failure",
        severity: "medium",
        source: params.source,
        problem: "failed to publish feishu secondary surface message",
        evidence: [
          `target=${publish?.target ?? "unknown"}`,
          `label=${publish?.label ?? "unknown"}`,
          `error=${String(result.reason)}`,
        ],
        impact:
          "the primary Feishu reply may have landed, but one secondary publish target did not receive its artifact",
        suggestedScope:
          "treat this as partial delivery: preserve the primary reply, inspect the secondary target, and do not call the classified publish fully live-fixed until the target publish is verified",
      });
    }
  }
}

function createClassifiedPublishDispatcher(params: {
  dispatcher: FeishuReplyDispatcherShape;
  cfg: ClawdbotConfig;
  accountId: string;
  controlRoomOrchestration?: {
    mode: "aggregate" | "expand";
    specialistSurfaces: import("./surfaces.js").FeishuSpecialistSurfaceName[];
    publishMode: import("./surfaces.js").FeishuPublishMode;
  };
}): FeishuReplyDispatcherShape {
  const orchestration = params.controlRoomOrchestration;
  if (!orchestration || orchestration.mode !== "aggregate") {
    return params.dispatcher;
  }

  const pendingPublishes: FeishuPendingPublish[] = [];

  return {
    ...params.dispatcher,
    sendFinalReply: (payload: ReplyPayload) => {
      const text = payload.text?.trim();
      if (!text) {
        return params.dispatcher.sendFinalReply(payload);
      }

      const classified = resolveFeishuClassifiedPublishResult({
        cfg: params.cfg.channels?.feishu,
        publishMode: orchestration.publishMode,
        specialistSurfaces: orchestration.specialistSurfaces,
        text,
      });
      const publishedHeadings: string[] = [];
      const draftHeadings = classified.draftArtifacts.map((artifact) =>
        artifact.heading.toLowerCase(),
      );
      const suppressedHeadings: string[] = [];

      for (const target of classified.publishTargets) {
        const artifact = classified.publishableArtifacts.find(
          (candidate) => candidate.type === target.artifactType,
        );
        if (!artifact || !target.chatId) {
          continue;
        }
        if (isLowSignalClassifiedSlice(artifact.body)) {
          suppressedHeadings.push(`low-signal ${artifact.heading.toLowerCase()}`);
          continue;
        }
        if (
          shouldSuppressDuplicateClassifiedSlice({
            chatId: target.chatId,
            heading: artifact.heading,
            body: artifact.body,
          })
        ) {
          suppressedHeadings.push(`duplicate ${artifact.heading.toLowerCase()}`);
          continue;
        }

        pendingPublishes.push({
          promise: sendMessageFeishu({
            cfg: params.cfg,
            to: `chat:${target.chatId}`,
            text: normalizeFeishuDisplayText(`## ${artifact.heading}\n${artifact.body}`),
            accountId: params.accountId,
          }),
          target: `chat:${target.chatId}`,
          label: artifact.heading,
        });
        publishedHeadings.push(artifact.heading.toLowerCase());
      }

      const distributionParts: string[] = [];
      if (publishedHeadings.length > 0) {
        distributionParts.push(`published ${publishedHeadings.join(", ")}`);
      }
      if (draftHeadings.length > 0) {
        distributionParts.push(`held as draft ${draftHeadings.join(", ")}`);
      }
      if (suppressedHeadings.length > 0) {
        distributionParts.push(`suppressed ${suppressedHeadings.join(", ")}`);
      }
      const distributionSummary =
        distributionParts.length > 0
          ? `Distribution: ${distributionParts.join("; ")}.`
          : "Distribution: summary only.";

      return params.dispatcher.sendFinalReply({
        ...payload,
        text: `${classified.controlSummary}\n\n${distributionSummary}`.trim(),
      });
    },
    waitForIdle: async () => {
      await waitForFeishuDispatcherAndPublishes({
        dispatcher: params.dispatcher,
        cfg: params.cfg,
        source: "feishu.classified_publish",
        pendingPublishes,
      });
    },
  };
}

function createDailyWorkfacePublishDispatcher(params: {
  dispatcher: FeishuReplyDispatcherShape;
  cfg: ClawdbotConfig;
  accountId: string;
  isDailyBrief?: boolean;
  dailyWorkface?: DailyWorkfaceArtifact;
  portfolioScorecard?: PortfolioScorecardArtifact;
  validationWeekly?: ValidationWeeklyArtifact;
  learningTimeboxSummary?: string;
  improvementPulse?: string;
  dailyArtifactAvailabilitySummary?: string;
  priorSurfaceLineContent?: string;
  watchtowerChatId?: string;
}): FeishuReplyDispatcherShape {
  if (
    !params.dailyWorkface &&
    !params.portfolioScorecard &&
    !params.validationWeekly &&
    !params.learningTimeboxSummary &&
    !params.improvementPulse &&
    !params.dailyArtifactAvailabilitySummary
  ) {
    return params.dispatcher;
  }

  const pendingPublishes: FeishuPendingPublish[] = [];

  return {
    ...params.dispatcher,
    sendFinalReply: (payload: ReplyPayload) => {
      const text = payload.text?.trim();
      if (!text) {
        return params.dispatcher.sendFinalReply(payload);
      }

      if (
        params.watchtowerChatId &&
        params.dailyWorkface &&
        !shouldSuppressDuplicateDailyWorkface({
          chatId: params.watchtowerChatId,
          filename: params.dailyWorkface.filename,
          content: params.dailyWorkface.content,
        })
      ) {
        pendingPublishes.push({
          promise: sendMessageFeishu({
            cfg: params.cfg,
            to: `chat:${params.watchtowerChatId}`,
            text: normalizeFeishuDisplayText(params.dailyWorkface.content),
            accountId: params.accountId,
          }),
          target: `chat:${params.watchtowerChatId}`,
          label: params.dailyWorkface.filename,
        });
      }

      if (
        params.watchtowerChatId &&
        params.portfolioScorecard &&
        !shouldSuppressDuplicateDailyWorkface({
          chatId: params.watchtowerChatId,
          filename: params.portfolioScorecard.filename,
          content: params.portfolioScorecard.content,
        })
      ) {
        pendingPublishes.push({
          promise: sendMessageFeishu({
            cfg: params.cfg,
            to: `chat:${params.watchtowerChatId}`,
            text: normalizeFeishuDisplayText(params.portfolioScorecard.content),
            accountId: params.accountId,
          }),
          target: `chat:${params.watchtowerChatId}`,
          label: params.portfolioScorecard.filename,
        });
      }

      if (
        params.watchtowerChatId &&
        params.validationWeekly &&
        !shouldSuppressDuplicateDailyWorkface({
          chatId: params.watchtowerChatId,
          filename: params.validationWeekly.filename,
          content: params.validationWeekly.content,
        })
      ) {
        pendingPublishes.push({
          promise: sendMessageFeishu({
            cfg: params.cfg,
            to: `chat:${params.watchtowerChatId}`,
            text: normalizeFeishuDisplayText(params.validationWeekly.content),
            accountId: params.accountId,
          }),
          target: `chat:${params.watchtowerChatId}`,
          label: params.validationWeekly.filename,
        });
      }

      const summaryParts = [
        text,
        params.dailyWorkface?.controlRoomSummary,
        params.portfolioScorecard?.controlRoomSummary,
        params.validationWeekly?.controlRoomSummary,
        params.learningTimeboxSummary,
        params.improvementPulse,
        params.dailyArtifactAvailabilitySummary,
      ].filter(Boolean) as string[];

      const finalText = params.isDailyBrief
        ? applyFeishuDailyBriefQualityGate({
            text,
            dailyWorkfaceSummary: params.dailyWorkface?.controlRoomSummary,
            portfolioScorecardSummary: params.portfolioScorecard?.controlRoomSummary,
            validationWeeklySummary: params.validationWeekly?.controlRoomSummary,
            learningTimeboxSummary: params.learningTimeboxSummary,
            improvementPulse: params.improvementPulse,
            dailyArtifactAvailabilitySummary: params.dailyArtifactAvailabilitySummary,
            priorSurfaceLineContent: params.priorSurfaceLineContent,
          }).text
        : summaryParts.join("\n\n").trim();

      return params.dispatcher.sendFinalReply({
        ...payload,
        text: finalText,
      });
    },
    waitForIdle: async () => {
      await waitForFeishuDispatcherAndPublishes({
        dispatcher: params.dispatcher,
        cfg: params.cfg,
        source: "feishu.daily_workface_publish",
        pendingPublishes,
      });
    },
  };
}

function buildLearningTimeboxControlRoomSummary(params: {
  chatId: string;
  activeTimebox?: LearningTimeboxSnapshot;
  evidenceLines?: string[];
}): string {
  const evidenceSummary = summarizeLearningStatusEvidenceLines(params.evidenceLines);
  if (!params.activeTimebox) {
    return evidenceSummary
      ? `Learning loop: no active timebox in ${params.chatId}. ${evidenceSummary}`
      : `Learning loop: no active timebox in ${params.chatId}.`;
  }
  if (params.activeTimebox.status && params.activeTimebox.status !== "running") {
    return evidenceSummary
      ? `Learning loop: latest session ${params.activeTimebox.sessionId} is ${params.activeTimebox.status}, chat ${params.chatId}, last heartbeat ${params.activeTimebox.lastHeartbeatAt ?? "unknown"}, completed ${params.activeTimebox.iterationsCompleted ?? 0}, failed ${params.activeTimebox.iterationsFailed ?? 0}. ${evidenceSummary}`
      : `Learning loop: latest session ${params.activeTimebox.sessionId} is ${params.activeTimebox.status}, chat ${params.chatId}, last heartbeat ${params.activeTimebox.lastHeartbeatAt ?? "unknown"}, completed ${params.activeTimebox.iterationsCompleted ?? 0}, failed ${params.activeTimebox.iterationsFailed ?? 0}.`;
  }
  return evidenceSummary
    ? `Learning loop: active session ${params.activeTimebox.sessionId}, chat ${params.chatId}, deadline ${params.activeTimebox.deadlineAt}. ${evidenceSummary}`
    : `Learning loop: active session ${params.activeTimebox.sessionId}, chat ${params.chatId}, deadline ${params.activeTimebox.deadlineAt}.`;
}

function buildFeishuLearningTimeboxAlreadyRunningReply(params: {
  sessionId: string;
  deadlineAt: string;
  learningStatusEvidence: string[];
  judgment: string;
}): string {
  return [
    "## Timebox status",
    `- 当前已有一个限时学习 session 在运行：${params.sessionId}，预计结束 ${params.deadlineAt}。`,
    ...params.learningStatusEvidence,
    params.judgment,
  ].join("\n");
}

function clearFeishuGroupHistoryAfterDispatch(params: {
  isGroup: boolean;
  chatHistories?: Map<string, HistoryEntry[]>;
  historyKey?: string;
  historyLimit: number;
}): void {
  if (!params.isGroup || !params.historyKey || !params.chatHistories) {
    return;
  }
  clearHistoryEntriesIfEnabled({
    historyMap: params.chatHistories,
    historyKey: params.historyKey,
    limit: params.historyLimit,
  });
}

async function sendAndPersistFeishuLearningTimeboxAlreadyRunningReply(
  params: {
    replyRuntime: ReturnType<typeof getFeishuRuntime>["channel"]["reply"];
    dispatcher: FeishuReplyDispatcherShape;
    markDispatchIdle: () => void;
    isGroup: boolean;
    chatHistories?: Map<string, HistoryEntry[]>;
    historyKey?: string;
    historyLimit: number;
    sessionId: string;
    deadlineAt: string;
    learningStatusEvidence: string[];
    judgment: string;
  } & FeishuSurfaceLinePersistContext,
): Promise<void> {
  const timeboxStatusText = buildFeishuLearningTimeboxAlreadyRunningReply({
    sessionId: params.sessionId,
    deadlineAt: params.deadlineAt,
    learningStatusEvidence: params.learningStatusEvidence,
    judgment: params.judgment,
  });
  const sendResult = await sendFeishuFinalTextReply({
    replyRuntime: params.replyRuntime,
    dispatcher: params.dispatcher,
    markDispatchIdle: params.markDispatchIdle,
    text: timeboxStatusText,
  });
  clearFeishuGroupHistoryAfterDispatch({
    isGroup: params.isGroup,
    chatHistories: params.chatHistories,
    historyKey: params.historyKey,
    historyLimit: params.historyLimit,
  });
  await persistCapturedFeishuSurfaceLine({
    cfg: params.cfg,
    agentId: params.agentId,
    targetSurface: params.targetSurface,
    effectiveSurface: params.effectiveSurface,
    replyContract: params.replyContract,
    chatId: params.chatId,
    sessionKey: params.sessionKey,
    messageId: params.messageId,
    userMessage: params.userMessage,
    finalReplyText: sendResult.queuedFinal ? timeboxStatusText : undefined,
    dispatchQueuedFinal: sendResult.queuedFinal,
    dispatchFinalCount: sendResult.counts.final,
  });
}

async function buildFeishuLearningCouncilReplyText(params: {
  councilText: string;
  timeboxStart: LearningTimeboxStartResult;
  getLearningStatusEvidence: () => Promise<string[]>;
}): Promise<string> {
  const { councilText, timeboxStart } = params;
  if (timeboxStart.status === "started") {
    return [
      councilText,
      "",
      "## Timebox status",
      `- 已启动进程内限时学习 ${timeboxStart.durationLabel}，默认每 ${timeboxStart.intervalMinutes} 分钟追加一轮；预计结束 ${timeboxStart.deadlineAt}。`,
      ...(await params.getLearningStatusEvidence()),
      "- 说明: 这是进程内 session；如果网关重启或进程退出，这类 session 会中断，但 receipts 会保留。",
    ].join("\n");
  }
  if (timeboxStart.status === "already_running") {
    return [
      councilText,
      "",
      "## Timebox status",
      `- 当前已有一个限时学习 session 在运行：${timeboxStart.sessionId}，预计结束 ${timeboxStart.deadlineAt}。`,
      ...(await params.getLearningStatusEvidence()),
      "- 当前判断: 这次不再重复启动新的后台 session，避免同一 chat 的学习任务互相覆盖。",
    ].join("\n");
  }
  if (timeboxStart.status === "failed_to_start") {
    return [
      councilText,
      "",
      "## Timebox status",
      `- 你请求了持续学习 ${timeboxStart.durationLabel}，但当前只完成这一轮审计式学习。`,
      ...(await params.getLearningStatusEvidence()),
      "- 当前判断: 限时学习 session 启动失败；这次不会假装后台已经在持续运行。",
    ].join("\n");
  }
  return councilText;
}

function buildControlRoomLearningStatusReply(params: {
  learningStatusChatId: string;
  activeLearningTimebox?: LearningTimeboxSnapshot;
  learningStatusEvidence: string[];
}): string {
  const { activeLearningTimebox, learningStatusChatId, learningStatusEvidence } = params;
  if (!activeLearningTimebox) {
    return [
      "## Learning status",
      "- 当前没有正在运行的限时学习 session。",
      `- 检查 chat: ${learningStatusChatId}`,
      ...learningStatusEvidence,
      "- 当前判断: 如果你要继续后台学习，需要重新下达明确的限时学习请求。",
    ].join("\n");
  }

  if (activeLearningTimebox.status && activeLearningTimebox.status !== "running") {
    return [
      "## Learning status",
      `- 最近一条限时学习 session：${activeLearningTimebox.sessionId}。`,
      `- 学习 chat: ${learningStatusChatId}`,
      `- 最近状态: ${activeLearningTimebox.status}`,
      `- 上次心跳: ${activeLearningTimebox.lastHeartbeatAt ?? "unknown"}`,
      `- 已完成轮次: ${activeLearningTimebox.iterationsCompleted ?? 0}`,
      `- 失败轮次: ${activeLearningTimebox.iterationsFailed ?? 0}`,
      ...learningStatusEvidence,
      "- 当前判断: 现在没有 active timebox；如果要继续后台学习，需要重新下达明确的限时学习请求。",
    ].join("\n");
  }

  return [
    "## Learning status",
    `- 当前有一个限时学习 session 正在运行：${activeLearningTimebox.sessionId}。`,
    `- 学习 chat: ${learningStatusChatId}`,
    `- 预计结束: ${activeLearningTimebox.deadlineAt}`,
    ...learningStatusEvidence,
    "- 当前判断: 学习循环仍在继续，不需要再重复下达新的持续学习命令。",
  ].join("\n");
}

function normalizeContinuationProbe(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[。！？!?.,，]+$/gu, "")
    .trim();
}

function looksLikeExplicitCurrentResearchLineContinuation(text: string): boolean {
  const normalized = normalizeContinuationProbe(text);
  return (
    looksLikeExplicitResearchLineContinuationAsk(normalized) ||
    /(继续(?:当前|这个)?研究线|继续当前线|继续这条研究线|继续当前这条线|当前研究线下一步|当前线下一步|研究线下一步|把这个整理进当前研究线|整理进当前研究线|整理到当前研究线|并入当前研究线)/u.test(
      normalized,
    ) ||
    /^(continue (?:this |the )?(?:current )?research line|continue the current line|organize this into the current research line|what(?:'s| is) the next step on the current line|next step on the current line)$/u.test(
      normalized,
    )
  );
}

function looksLikeWeakResearchContinuation(text: string): boolean {
  const normalized = normalizeContinuationProbe(text);
  return /^(继续|继续做|继续这个|继续一下|下一步|下一步呢|continue|continue this|next step)$/u.test(
    normalized,
  );
}

function shouldUseFrontEndResearchContinuation(params: {
  surfaceRouting: ResolvedFeishuSurfaceRouting;
}): boolean {
  const { currentSurface, targetSurface } = params.surfaceRouting;
  return (
    (!currentSurface && !targetSurface) ||
    currentSurface === "control_room" ||
    targetSurface === "control_room"
  );
}

async function loadCurrentResearchLineForContinuation(params: {
  workspaceDir: string;
}): Promise<
  | { status: "present"; parsed: ParsedCurrentResearchLine }
  | { status: "missing" }
  | { status: "malformed" }
> {
  try {
    const content = await fs.readFile(
      path.join(params.workspaceDir, "memory", "current-research-line.md"),
      "utf-8",
    );
    const parsed = parseCurrentResearchLineArtifact(content);
    if (!parsed) {
      return { status: "malformed" };
    }
    return { status: "present", parsed };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "malformed" };
  }
}

function buildAnchoredResearchContinuationNotice(anchor: ParsedCurrentResearchLine): string {
  return [
    "[System: Treat this as explicit continuation of the current research line, not as a loose follow-up.]",
    "[System: Resolve it against memory/current-research-line.md first, not against loose recent chat, quoted content, or stale side threads.]",
    `[System: Current focus = ${anchor.currentFocus}]`,
    `[System: Current line status = ${anchor.lineStatus}]`,
    `[System: Top decision = ${anchor.topDecision}]`,
    anchor.currentSessionSummary
      ? `[System: Current session summary = ${anchor.currentSessionSummary}]`
      : undefined,
    `[System: Next step = ${anchor.nextStep}]`,
    `[System: Research guardrail = ${anchor.researchGuardrail}]`,
    "[System: If the ask conflicts with this anchor or is still too weak to continue safely, say so explicitly and ask a narrow clarification instead of drifting.]",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildResearchContinuationClarification(params: {
  reason: "ambiguous" | "missing" | "malformed" | "paused" | "superseded";
  anchor?: ParsedCurrentResearchLine;
}): string {
  if (params.reason === "missing") {
    return [
      "我现在不能直接继续“当前研究线”。",
      "- 原因: memory/current-research-line.md 还不存在，当前没有可复用的研究线锚点。",
      "- 请直接点名要继续的主题，或者先重建当前研究线锚点。",
    ].join("\n");
  }
  if (params.reason === "malformed") {
    return [
      "我现在不能直接继续“当前研究线”。",
      "- 原因: memory/current-research-line.md 存在但解析失败，不能把它当成当前真相。",
      "- 请先修复这个锚点，或者直接点名要继续的主题。",
    ].join("\n");
  }
  if (params.reason === "paused") {
    return [
      "我现在不自动续上这条研究线。",
      `- 当前研究线: ${params.anchor?.currentFocus ?? "unknown"}`,
      "- 原因: 当前 line_status = paused。",
      `- 当前 top decision: ${params.anchor?.topDecision ?? "unknown"}`,
      `- 当前 next step: ${params.anchor?.nextStep ?? "unknown"}`,
      "- 如果你要恢复这条线，请明确说“恢复当前研究线”；否则请直接点名新的主题。",
    ].join("\n");
  }
  if (params.reason === "superseded") {
    return [
      "我现在不自动恢复这条已经被替换的研究线。",
      `- 当前研究线: ${params.anchor?.currentFocus ?? "unknown"}`,
      "- 原因: 当前 line_status = superseded。",
      `- 当前 top decision: ${params.anchor?.topDecision ?? "unknown"}`,
      `- 当前 next step: ${params.anchor?.nextStep ?? "unknown"}`,
      "- 请直接点名你要重开的旧主题，或者给出新的当前线。",
    ].join("\n");
  }
  return [
    "我先不假装已经知道你要继续哪条研究线。",
    ...(params.anchor
      ? [
          `- 当前研究线: ${params.anchor.currentFocus}`,
          `- 当前状态: ${params.anchor.lineStatus}`,
          `- 当前 top decision: ${params.anchor.topDecision}`,
          `- 当前 next step: ${params.anchor.nextStep}`,
        ]
      : []),
    "- 如果你是要继续当前研究线，请直接说“继续当前研究线”或“当前研究线下一步是什么”；如果不是，请直接点名主题。",
  ].join("\n");
}

async function resolveFeishuResearchContinuation(params: {
  workspaceDir: string;
  userMessage: string;
  surfaceRouting: ResolvedFeishuSurfaceRouting;
}): Promise<ResolvedFeishuResearchContinuation> {
  if (!shouldUseFrontEndResearchContinuation({ surfaceRouting: params.surfaceRouting })) {
    return { kind: "none" };
  }

  const strongContinuation = looksLikeExplicitCurrentResearchLineContinuation(params.userMessage);
  const weakContinuation =
    !strongContinuation && looksLikeWeakResearchContinuation(params.userMessage);
  if (!strongContinuation && !weakContinuation) {
    return { kind: "none" };
  }

  const anchor = await loadCurrentResearchLineForContinuation({
    workspaceDir: params.workspaceDir,
  });
  if (strongContinuation) {
    if (anchor.status === "present") {
      if (anchor.parsed.lineStatus === "paused" || anchor.parsed.lineStatus === "superseded") {
        return {
          kind: "clarify",
          text: buildResearchContinuationClarification({
            reason: anchor.parsed.lineStatus,
            anchor: anchor.parsed,
          }),
        };
      }
      return { kind: "anchored", notice: buildAnchoredResearchContinuationNotice(anchor.parsed) };
    }
    return {
      kind: "clarify",
      text: buildResearchContinuationClarification({
        reason: anchor.status === "missing" ? "missing" : "malformed",
      }),
    };
  }

  return {
    kind: "clarify",
    text: buildResearchContinuationClarification({
      reason:
        anchor.status === "present"
          ? "ambiguous"
          : anchor.status === "missing"
            ? "missing"
            : "malformed",
      anchor: anchor.status === "present" ? anchor.parsed : undefined,
    }),
  };
}

type FeishuScopeNoticeRule = {
  matched: boolean;
  notice: string;
};

function createFeishuScopeNoticeRule(matched: boolean, notice: string): FeishuScopeNoticeRule {
  return { matched, notice };
}

function buildFeishuScopeNotices(content: string): string[] {
  // Keep high-priority boundaries before formatting/status guards so later
  // prompt additions do not bury authority, freshness, or proof constraints.
  const scopeNoticeRules: FeishuScopeNoticeRule[] = [
    createFeishuScopeNoticeRule(
      looksLikeNegatedScopeCorrectionAsk(content),
      "[System: Negated-scope correction detected. Do not execute or elaborate the action the operator negated. First separate: 1. not requested / excluded, 2. actually requested after 而是 / 我问的是 / 只要 / instead / rather, 3. the smallest useful answer for that requested target. If the requested target is still unclear, ask a narrow clarification instead of continuing along the rejected path.]",
    ),
    createFeishuScopeNoticeRule(
      looksLikeTemporalScopeControlAsk(content),
      "[System: Temporal-scope guard detected. Before answering, pin the requested evidence window: current / same-day, recent-window, or historical. Do not answer a current/today question from stale prior evidence, and do not rewrite a historical/previous-turn question as a fresh current-state claim. If old evidence is all that exists, label it stale/prior explicitly.]",
    ),
    createFeishuScopeNoticeRule(
      looksLikeBoundedPriorityScopeAsk(content),
      "[System: Bounded-priority scope detected. Pick exactly one highest-value semantic family or patch point for this turn. State the next step before acting, keep the writable surface narrow, avoid opening parallel branches, and end with the proof command or verification artifact. If several directions are possible, choose the one that closes the most concrete failure mode now.]",
    ),
    createFeishuScopeNoticeRule(
      looksLikeCompletionProofScopeAsk(content),
      "[System: Completion-proof guard detected. Separate planned, started, attempted, completed, and verified. Do not treat a notice, plan, understanding, claim, or started run as completion. Name the proof artifact, command output, receipt, or durable file that proves the completed state; if no proof exists, say no proof exists and label the state honestly.]",
    ),
    createFeishuScopeNoticeRule(
      looksLikeExecutionAuthorityScopeAsk(content),
      "[System: Execution-authority guard detected. Separate research advice, code/workspace edits, local UI operation, live visible-surface probes, simulated/paper actions, build/restart/deploy actions, and real external execution. Operator permission to control the computer or run a Lark/Feishu visible probe is current-action scoped and does not automatically carry over to later turns or authorize build, restart, deploy, production migration, account action, payment, deletion, or trading. A newer stop, pause, do-not-live, or do-not-probe instruction overrides older permission for the affected live action. Treat risky live actions as per-action permission: if the specific action was not approved in the current instruction, label it not authorized. Do not claim real trades, account actions, production changes, sends, deletes, payments, deploys, or restarts were performed unless this exact environment actually performed them and has proof. Research-only or unapproved actions must be labeled as not executed / no authority, with any allowed next step stated separately.]",
    ),
    createFeishuScopeNoticeRule(
      looksLikeSourceCoverageScopeAsk(content),
      "[System: Source-coverage guard detected. Separate actual searched/read sources from intended or missing coverage. Do not claim exhaustive, complete, all-source, or Google-wide learning unless the sources and search capability prove it. State source count/type when known, sample limits, unavailable search/tool limits, unknowns, and what conclusions are only partial-source inferences.]",
    ),
    createFeishuScopeNoticeRule(
      looksLikeDurableMemoryScopeAsk(content),
      "[System: Durable-memory guard detected. Separate ephemeral chat context, ordinary artifacts/notes, durable memory files, protected memory, and recall-order integration. Do not claim something is remembered long-term, protected, or recallable unless a durable artifact exists and the relevant recall path is actually wired. If it is only understood in this turn or written as an unreferenced note, label that boundary plainly.]",
    ),
    createFeishuScopeNoticeRule(
      looksLikeClassifyWorkScopeAsk(content),
      "[System: Classify-work guard detected. Before acting, classify the requested work by task family, target surface or role, evidence state, action boundary, and expected output contract. State that classification briefly, then perform only the smallest next step that fits it. Do not hard-code against the literal sentence if the broader semantic family is clear.]",
    ),
    createFeishuScopeNoticeRule(
      looksLikeCapabilityClaimScopeAsk(content),
      "[System: Capability-claim guard detected. Separate current real capability, design target, local/dev-fixed change, live-fixed state, configuration or credential gaps, and stale prior evidence. For dev-to-live handoff requests, separate source patch, build, restart, live probe, and visible Lark/Feishu reply evidence. If an acceptance phrase or equivalent semantic acceptance condition is required, define it before judging the live probe, then report whether the visible reply matched it. Do not say a tool, provider, automation, memory path, routing path, or Lark/Feishu integration is working now unless current proof supports it. Name the proof, probe, receipt, or acceptance phrase; otherwise label it unverified, unavailable, or dev-only.]",
    ),
    createFeishuScopeNoticeRule(
      looksLikeClarificationBoundaryScopeAsk(content),
      "[System: Clarification-boundary guard detected. If the target, scope, timeframe, action boundary, evidence requirement, file/path, surface/role, or output contract is underspecified, ask exactly one narrow clarification question before acting. Do not guess a broad task, silently expand scope, or convert ambiguous continuation into implementation, memory write, search, or live action.]",
    ),
    createFeishuScopeNoticeRule(
      looksLikeInstructionConflictScopeAsk(content),
      "[System: Instruction-conflict guard detected. Before acting, name the conflicting instructions or mutually exclusive constraints, identify the higher-priority constraint, and perform only the smallest compatible next step. Do not blend incompatible commands such as write-but-do-not-edit, latest-search-without-network, execute-but-no-authority, or continue-but-do-not-continue.]",
    ),
    createFeishuScopeNoticeRule(
      looksLikeOutOfScopeBoundaryAsk(content),
      "[System: Out-of-scope boundary detected. Before acting, separate excluded work, allowed in-scope work, and the smallest compatible next action. If live probe, build, restart, deploy, migration, or production work is excluded or paused, stop that lane and do not continue it from older context. Do not perform excluded work, do not add adjacent cleanup or new branches, and do not claim out-of-scope items were handled. If proof is required, prove only the in-scope change.]",
    ),
    createFeishuScopeNoticeRule(
      looksLikeHighStakesRiskScopeAsk(content),
      "[System: High-stakes risk guard detected. Before answering, classify the risk category, authority boundary, evidence freshness, and allowed response mode. For trading/account, legal, medical, payment, deletion, deployment, or production actions, do not execute or imply approval authority. Give research-only or safety-oriented guidance, ask for missing critical context when needed, and name what proof would be required before any real action.]",
    ),
    createFeishuScopeNoticeRule(
      looksLikeResultShapeScopeAsk(content),
      "[System: Result-shape guard detected. Preserve the requested output contract: ordering, brevity, table/checklist/bullets, required sections, and any excluded sections. Do not replace a requested concise answer with a long essay. If the requested format conflicts with safety or proof requirements, keep safety/proof and state the format limitation briefly.]",
    ),
    createFeishuScopeNoticeRule(
      looksLikeEvidenceShapeScopeAsk(content),
      "[System: Evidence-shape guard detected. Use a fixed evidence shape when making claims: claim, source or receipt, verification status, inference boundary, and missing-evidence gap. For live probe receipts, include tested phrase, target chat/thread when known, acceptance phrase or semantic acceptance condition when defined, visible reply or missing reply, whether the reply matches the tested phrase, timestamp, and acceptance condition, core semantic slots required for equivalence, matched slots, missing slots, pass/fail judgment, dev/live boundary, and next action. If required slots are missing, do not mark the probe as pass. Separate verified facts, inferred claims, stale evidence, and unknowns. Do not invent citations or collapse missing proof into confidence language.]",
    ),
    createFeishuScopeNoticeRule(
      looksLikeFailureReportScopeAsk(content),
      "[System: Failure-report guard detected. If anything is failed, blocked, incomplete, degraded, unverified, delayed, timed out, missing a visible reply, showing only a stale reply, or missing proof, report it with a fixed shape: current status, blocker or failing seam, impact, proof or missing proof, attempted repair if any, and next smallest action. For live probes, a sent message without a matching visible reply is not pass; a reply from the wrong chat, wrong thread, older timestamp, or non-matching tested phrase is also not pass. Label it blocked, degraded, in progress, or unverified. Do not use success wording for degraded or partial states.]",
    ),
    createFeishuScopeNoticeRule(
      looksLikeProgressStatusScopeAsk(content),
      "[System: Progress-status guard detected. Report progress with a fixed shape: done, in progress, blocked, not started, remaining work, proof or receipts, and next smallest action. Do not treat started, sent, queued, or waiting-for-visible-reply as done, and do not answer a status request with only a plan or encouragement.]",
    ),
    createFeishuScopeNoticeRule(
      looksLikeRoleExpansionScopeAsk(content),
      "[System: Role-expansion guard detected. Keep the control-room summary first unless the operator explicitly asks for specialist-only output. Treat specialist roles or surfaces as targeted detail expansions, not replacements for the main summary. When expanding, name the requested role or surface and keep unrelated specialist lanes out of scope.]",
    ),
    createFeishuScopeNoticeRule(
      looksLikeBatchQueueScopeAsk(content),
      "[System: Batch-queue guard detected. Treat multiple requested items as a queue, not as permission to fan out indefinitely. If the operator is giving a scheduling or output contract, apply that contract to the current request instead of rejecting it as missing payload unless a concrete target is truly absent. State priority order, queued versus done status, the single current item, and the next smallest action. Do not mark queued work as completed, and do not run parallel branches unless explicitly requested.]",
    ),
  ];
  return scopeNoticeRules.filter((rule) => rule.matched).map((rule) => rule.notice);
}

function inferFeishuResearchIntentNotice(content: string): string | undefined {
  const trimmed = content.trim();
  const normalized = content.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const scopeNotices = buildFeishuScopeNotices(content);
  const withScopeNotices = (notice: string) =>
    scopeNotices.length > 0 ? `${scopeNotices.join("\n")}\n${notice}` : notice;

  const correctionLoopInput = isCorrectionLoopInput(trimmed);
  const looksRepeatedCorrection =
    /(重复|反复|再次|又出现|连续|same issue|again|repeated|recurring|repeat)/u.test(normalized);

  if (correctionLoopInput) {
    return withScopeNotices(
      `[System: Treat this as operator correction-loop input, not as ordinary chat. Start with one short human sentence that plainly acknowledges what was wrong and what changes now. Then convert it into a structured correction note with these sections in order: 1. prior claim or behavior, 2. what was wrong, 3. evidence or user-observed failure, 4. replacement rule or corrected stance, 5. confidence downgrade on the old rule, 6. follow-up or watch item. Do not argue with the feedback, do not hide it, and do not rewrite history as if the prior mistake never happened. Keep the note compact, high-signal, and suitable for durable memory. ${
        looksRepeatedCorrection
          ? "This looks repeated or recurring, so after the correction note add one short repair-ticket candidate with: Category, Problem, Evidence, Impact, Suggested scope. Do not propose a broad refactor."
          : "If the same failure mode appears repeatedly, escalate it later as a repair-ticket candidate instead of silently absorbing it into doctrine."
      }]`,
    );
  }

  const hasMacroCue =
    /(非农|cpi|ppi|fomc|通胀|通胀预期|利率|美债|收益率|期限溢价|美元|油价|就业|加息|降息|qqq|tlt|spy|iwm|dxy|etf|指数|大类资产|风险|潜在收益|美股|macro|inflation|payroll|treasury|yield|duration|fomc|rates?)/u.test(
      normalized,
    );
  const hasFundamentalCue =
    /(基本面|财报|年报|季报|指引|电话会|公司|企业|issuer|company|watchlist|follow-up|follow up|fundamental|annual report|quarterly report|investor presentation)/u.test(
      normalized,
    );
  const hasFrontierCue =
    /(paper|论文|方法|method|frontier|leakage|overfitting|复现|replication|baseline|ds\b|data science|数据科学|统计学|统计检验|显著性|显著性检验|回归|bootstrap|样本外|out[-\s]?of[-\s]?sample|交叉验证|cross[-\s]?validation|walk[-\s]?forward|稳健性|因子检验|因子测试)/u.test(
      normalized,
    );
  const hasLearningCue =
    /(学学|学习|去学|上学|学一下|复盘|开源|github|repo|开源项目|新技术|日频技术|日频策略|源码|技术栈|原理|教程|文档|文章|llm|large language model|大语言模型|金融智能体|自我提升|启发|内化|study|learn|open source|daily[-\s]?frequency|中文理解|英文理解|中英理解|双语理解|bilingual|multilingual|language understanding|language comprehension|术语映射|术语对照|翻译歧义|语义理解|自然语言理解|ds\b|data science|数据科学|统计学|统计检验|显著性|显著性检验|回归|bootstrap|样本外|out[-\s]?of[-\s]?sample|交叉验证|cross[-\s]?validation|walk[-\s]?forward|稳健性|因子检验|因子测试)/u.test(
      normalized,
    );
  const hasPositionCue =
    /(买|买入|卖|卖出|加仓|减仓|持有|持仓|补仓|止盈|止损|要不要买|要不要卖|该不该买|该不该卖|该不该加|该不该减|should i buy|should i sell|should i add|should i reduce|should i hold|add to position|reduce position|current holdings|position sizing|risk\/reward on)/u.test(
      normalized,
    );
  const hasSearchHealthCue =
    /(网络搜索可以用吗|网络搜索能用吗|搜索可以用吗|搜索能用吗|搜索能力|检索能力|web search available|is web search available|search health|search status|search ability)/u.test(
      normalized,
    );
  const hasExternalSourceLearningCue = looksLikeSourceCoverageScopeAsk(content);
  if (
    looksLikeExplicitCurrentResearchLineContinuation(trimmed) ||
    looksLikeWeakResearchContinuation(trimmed)
  ) {
    return undefined;
  }
  const hasContinuationCue =
    /^(继续|继续做|继续这个|下一步|按优先级学|扎实补好|好的|好|ok|okay|continue|next step)\b/u.test(
      trimmed,
    ) || /^(继续|下一步|按优先级学|扎实补好|continue|next step)/u.test(normalized);
  const hasExplicitImplementationCue =
    /(写代码|写出|实现|开始实现|完整实现|生成代码|保存|落盘|创建文件|patch|改代码|implement|write code|write file|save|create file)/u.test(
      normalized,
    );

  if (hasExplicitImplementationCue) {
    return withScopeNotices(
      "[System: Treat this as explicit implementation work. First infer the concrete work target, then stay bounded: state the root cause or design gap, make the smallest safe patch or artifact, and keep the scope local to what the operator actually asked for. Do not silently expand into adjacent refactors, broad architecture changes, or extra file churn.]",
    );
  }

  if (
    hasContinuationCue &&
    !hasExplicitImplementationCue &&
    !hasMacroCue &&
    !hasFundamentalCue &&
    !hasFrontierCue &&
    !hasLearningCue &&
    !hasPositionCue
  ) {
    return withScopeNotices(
      "[System: Treat this as a bounded continuation turn inside the current Feishu lane. Reply with the next concrete step, current status, and one small follow-up in plain language first. Do not silently escalate a terse continuation or approval into long code generation, file creation, workspace writes, or multi-step implementation work unless the operator explicitly asks to implement, write, save, create a file, or patch something.]",
    );
  }

  if (hasSearchHealthCue) {
    return withScopeNotices(
      "[System: Treat this as a live search/provider health question. Check current runtime status before answering. Distinguish clearly between current availability and stale past failures. If web search is working now, say so directly in plain language. If it is degraded now, name the current failing seam instead of reusing an old generic fallback.]",
    );
  }

  if (looksLikeLearningInternalizationAuditAsk(content)) {
    return withScopeNotices(
      "[System: Treat this as a learning-internalization audit, not as a broad system overview and not as a fresh learning request. Start by checking the recent learning outputs, protected summaries when present, the latest learning carryover cue (retain / discard / replay / next eval), reusable rules, and any correction notes tied to this topic. Answer in plain language first: 1. what appears to have been genuinely internalized, 2. what still looks like shallow summary or surface enthusiasm, 3. what evidence proves the learning changed Lobster's reusable behavior, 4. what should be downgraded or discarded, 5. one short next step. If you cannot find a protected-summary anchor, carryover cue, durable rule, or discard signal, say that explicitly instead of pretending the learning really stuck.]",
    );
  }

  if (looksLikeLearningWorkflowAuditAsk(content)) {
    return withScopeNotices(
      "[System: Treat this as a learning-workflow audit, not as a fresh learning request and not as a broad system overview. Start by checking the recent learning outputs, the latest learning carryover cue (retain / discard / replay / next eval), protected summaries when present, learning-session receipts or timebox state when available, and whether the result actually changed Lobster's reusable behavior. Answer in plain language first: 1. what reached protected summaries or other durable memory versus what only exists as a report, 2. whether the latest learning workflow completed, failed, was interrupted, or only looked active, 3. what evidence shows the learning changed future behavior, 4. where the workflow is stuck or overstating success, 5. one short next step.]",
    );
  }

  if (looksLikeHoldingsRevalidationAsk(content)) {
    return withScopeNotices(
      "[System: Treat this as a holdings-thesis revalidation question, not as a simple buy/sell stance prompt. Start by retrieving the prior holding analysis, old thesis summary, memory/current-research-line.md when present, and any correction note or durable memory anchor if available; if the old thesis cannot be found, say that explicitly and lower confidence instead of pretending it was reviewed. Re-check whether the earlier holding analysis still stands under the latest market and business context. Use the right finance foundations instead of fresh market storytelling: portfolio-sizing-discipline for size humility, risk-transmission for the live driver path, behavior-error-correction for urgency or stubbornness, catalyst-map for confirm/break events, and business-quality when issuer structure matters. Keep the answer concise and evidence-first: 1. what still holds, 2. what has weakened or broken, 3. what fresh market or business evidence matters most now, 4. what would invalidate the old thesis, 5. one short next-step judgment. Do not collapse it into a pure technical take, and do not force an execution call if the real issue is whether the old thesis still survives.]",
    );
  }

  if (hasPositionCue && (hasMacroCue || hasFundamentalCue || /[A-Z]{2,5}/.test(content))) {
    return withScopeNotices(
      "[System: Treat this as a portfolio or position-management question, not as prediction theater and not as direct execution authority. Use a fixed reply structure with these sections in order when possible: 1. current stance, 2. key reasons, 3. main counter-case / risk, 4. action triggers, 5. confidence, 6. one-line summary. Use exact markdown headings when possible: ## Current Stance, ## Key Reasons, ## Main Counter-Case / Risk, ## Action Triggers, ## Confidence, ## One-Line Summary. In current stance, use one plain label only: hold, watch, reduce, do not add yet, or add only if conditions trigger. Apply sizing discipline explicitly: name any concentration risk, distinguish conviction from actual size, and default low confidence toward smaller size or wait. If macro or cross-asset context matters, explain the live driver and transmission path instead of hand-wavy market color. In action triggers, separate what would justify adding, what would justify reducing, and what means wait. Use execution hygiene too: if event risk, liquidity, or volatility makes the setup noisy, say wait explicitly. Also check for behavior-error drift: urgency theater, confirmation bias, narrative overreach, or emotional discomfort with waiting. If known events matter, map the real catalysts too: what would confirm, what would break, and what is mostly noise. Keep key reasons to the top 2-3 points. Keep confidence to low, medium, or high plus one short justification. Make the one-line summary exactly one sentence. Keep it concise, disciplined, and risk-controlled. No hype, no fake certainty, and no long rambling essay.]",
    );
  }
  if (hasMacroCue && !hasFundamentalCue && !hasFrontierCue && !hasExternalSourceLearningCue) {
    return withScopeNotices(
      "[System: Treat this as macro and major-asset research. Skip textbook 101 summaries and generic index quote recaps unless the user explicitly asks for basics. Prefer a concise watchlist-style risk review over raw price tables: name the major index or asset exposures that matter, the current structural narrative, what is already priced by consensus, where the marginal surprise or pricing gap still is, and which cross-asset signals (rates, dollar, duration, credit, or related risk assets) confirm or contradict the story. For current market, index, rate, or macro-event questions, use web search first if available so the answer is anchored in fresh facts instead of stale priors. Anchor any risk/reward ranking to fresh hard datapoints when available, such as current rates or rate expectations, relevant ETF or index moves, and supporting cross-asset signals; do not pad with stale quote tables. Do not let technical signal tables, buy/sell badges, or quote recaps become the main conclusion. Do not default to vague liquidity-stress explanations unless fresh cross-asset evidence supports them. If the user asks in plain language about a few indices, interpret that as a request for current risk/reward framing, not a request for a market data dump. If the live-data layer looks stale or cached, say so explicitly, name the missing anchors, and refuse to fake a confident ranking. When freshness is weak, stale, cached, or provider-limited, do not present high-specificity market figures, exact levels, exact percentages, or exact point estimates as if they were freshly verified in this turn; use directional wording or explicitly label any inherited number as stale, prior, or illustrative instead. End with one short red-team note explaining what new data or regime shift would invalidate the view. Do not silently convert it into a fundamental intake or issuer watchlist task unless the user explicitly asks. If the answer is still generic, say so instead of pretending it is decision-useful.]",
    );
  }
  if (hasFundamentalCue && !hasFrontierCue) {
    return withScopeNotices(
      "[System: Treat this as fundamental research or watchlist maintenance. Prefer current fundamental artifacts, follow-up trackers, and review memos. Judge the company through business quality, not just surface valuation: industry structure, pricing power, capital allocation, management credibility, and principal structural risks. If known events matter, build a simple catalyst map: what could confirm, what could break, and what is mostly noise. Speak plain language first: what matters about the business, what is attractive, what is risky, and what to follow up next. Do not rewrite it into a reset alias.]",
    );
  }
  if (hasFrontierCue && !hasFundamentalCue) {
    return withScopeNotices(
      "[System: Treat this as method or paper research. Focus on leakage, overfitting, replication risk, and method quality. For broad paper-learning requests, keep a fixed source receipt: papers actually searched or read, source coverage limits, retained methods that can change future work, discarded hype or stale ideas, replay trigger for when to reuse the lesson, next eval for how to verify the lesson later, and the next reusable behavior change. Speak human-first: what this method is actually useful for, what is dangerous, and whether it changes daily Lobster usage now. Do not rewrite it into a fundamental intake.]",
    );
  }
  if (looksLikeFinanceLearningPipelineAsk(content)) {
    return withScopeNotices(
      "[System: Treat this as a finance learning pipeline request, not as generic learning-council prose and not as language-corpus training. Preserve the raw user wording as learningIntent. Use finance_learning_pipeline_orchestrator only when there is safe local/manual source content or a clearly provided source artifact; otherwise ask for or record the missing source intake instead of pretending learning completed. A completed backend learning loop should produce inspect-ready candidates plus retrievalReceiptPath and retrievalReviewPath. Keep Lark routing corpus samples separate from finance learning artifacts, and do not grant trading execution authority.]",
    );
  }
  if ((hasLearningCue || hasExternalSourceLearningCue) && !hasFundamentalCue && !hasFrontierCue) {
    return withScopeNotices(
      "[System: Treat this as learning or open-source study work. Start from the active Lobster brain, not from a blank slate: when present, anchor first on memory/current-research-line.md and MEMORY.md, then the latest learning carryover cue and any relevant local durable memory cards before deciding what is worth learning now. Preserve the user's raw learning objective as the learningIntent for downstream finance learning pipeline calls so existing capability cards are retrieved before new retention and again after attachment. Keep language-interface routing samples separate from brain-learning artifacts: routing corpus candidates can improve intent classification, but only source intake, extraction, attachment, and inspect-ready finance pipeline outputs can become capability cards. Focus on extracting concepts, implementation ideas, pitfalls, and next study steps. If the topic is Chinese/English understanding, prioritize terminology mapping, ambiguity reduction, workflow-trigger understanding, and plain-language reporting rather than generic language tutoring. If the user says 日频技术 or 日频策略 without extra qualifiers, interpret it as finance or quant methods for daily-frequency research by default, not Japanese-language technology or generic HFT hype. For external-source learning requests such as Google, web, GitHub, papers, blogs, docs, competitors, or peer projects, keep a fixed learning receipt: sources actually searched or read, source coverage limits, retained rules that can change future work, discarded noise or stale ideas, replay trigger for when to reuse the lesson, next eval for how to verify the lesson later, and the next reusable behavior change. Explain the result in plain language first: what was learned, what is still weak, and what changes for Lobster now. Keep the distillation useful for both Lobster's general meta-capability and the full finance research pipeline. If source coverage or search breadth is weak in this turn, say so explicitly instead of pretending the learning set was broad. Do not rewrite it into a fundamental intake or reset alias.]",
    );
  }

  return scopeNotices.length > 0 ? scopeNotices.join("\n") : undefined;
}

export async function handleFeishuMessage(params: {
  cfg: ClawdbotConfig;
  event: FeishuMessageEvent;
  botOpenId?: string;
  botName?: string;
  runtime?: RuntimeEnv;
  chatHistories?: Map<string, HistoryEntry[]>;
  accountId?: string;
}): Promise<void> {
  const { cfg, event, botOpenId, botName, runtime, chatHistories, accountId } = params;

  // Resolve account with merged config
  const account = resolveFeishuAccount({ cfg, accountId });
  const feishuCfg = account.config;

  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  // Dedup: synchronous memory guard prevents concurrent duplicate dispatch
  // before the async persistent check completes.
  const messageId = event.message.message_id;
  const memoryDedupeKey = `${account.accountId}:${messageId}`;
  if (!tryRecordMessage(memoryDedupeKey)) {
    log(`feishu: skipping duplicate message ${messageId} (memory dedup)`);
    return;
  }
  // Persistent dedup survives restarts and reconnects.
  if (!(await tryRecordMessagePersistent(messageId, account.accountId, log))) {
    log(`feishu: skipping duplicate message ${messageId}`);
    return;
  }

  let ctx = parseFeishuMessageEvent(event, botOpenId, botName);
  const isGroup = ctx.chatType === "group";
  const isDirect = !isGroup;
  const senderUserId = event.sender.sender_id.user_id?.trim() || undefined;

  // Handle merge_forward messages: fetch full message via API then expand sub-messages
  if (event.message.message_type === "merge_forward") {
    log(
      `feishu[${account.accountId}]: processing merge_forward message, fetching full content via API`,
    );
    try {
      // Websocket event doesn't include sub-messages, need to fetch via API
      // The API returns all sub-messages in the items array
      const client = createFeishuClient(account);
      const response = (await client.im.message.get({
        path: { message_id: event.message.message_id },
      })) as { code?: number; data?: { items?: unknown[] } };

      if (response.code === 0 && response.data?.items && response.data.items.length > 0) {
        log(
          `feishu[${account.accountId}]: merge_forward API returned ${response.data.items.length} items`,
        );
        const expandedContent = parseMergeForwardContent({
          content: JSON.stringify(response.data.items),
          log,
        });
        ctx = { ...ctx, content: expandedContent };
      } else {
        log(`feishu[${account.accountId}]: merge_forward API returned no items`);
        ctx = { ...ctx, content: "[Merged and Forwarded Message - could not fetch]" };
      }
    } catch (err) {
      log(`feishu[${account.accountId}]: merge_forward fetch failed: ${String(err)}`);
      ctx = { ...ctx, content: "[Merged and Forwarded Message - fetch error]" };
    }
  }

  // Resolve sender display name (best-effort) so the agent can attribute messages correctly.
  // Optimization: skip if disabled to save API quota (Feishu free tier limit).
  let permissionErrorForAgent: PermissionError | undefined;
  if (feishuCfg?.resolveSenderNames ?? true) {
    const senderResult = await resolveFeishuSenderName({
      account,
      senderId: ctx.senderOpenId,
      log,
    });
    if (senderResult.name) ctx = { ...ctx, senderName: senderResult.name };

    // Track permission error to inform agent later (with cooldown to avoid repetition)
    if (senderResult.permissionError) {
      const appKey = account.appId ?? "default";
      const now = Date.now();
      const lastNotified = permissionErrorNotifiedAt.get(appKey) ?? 0;

      if (now - lastNotified > PERMISSION_ERROR_COOLDOWN_MS) {
        permissionErrorNotifiedAt.set(appKey, now);
        permissionErrorForAgent = senderResult.permissionError;
      }
    }
  }

  log(
    `feishu[${account.accountId}]: received message from ${ctx.senderOpenId} in ${ctx.chatId} (${ctx.chatType})`,
  );

  // Log mention targets if detected
  if (ctx.mentionTargets && ctx.mentionTargets.length > 0) {
    const names = ctx.mentionTargets.map((t) => t.name).join(", ");
    log(`feishu[${account.accountId}]: detected @ forward request, targets: [${names}]`);
  }

  const normalizedCommandText = normalizeFeishuCommandText(ctx.content);
  if (normalizedCommandText !== ctx.content) {
    log(
      `feishu[${account.accountId}]: normalized natural-language control input to ${normalizedCommandText.split(/\s+/, 2)[0]}`,
    );
  }

  const historyLimit = Math.max(
    0,
    feishuCfg?.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupConfig = isGroup
    ? resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: ctx.chatId })
    : undefined;
  const groupSession = isGroup
    ? resolveFeishuGroupSession({
        chatId: ctx.chatId,
        senderOpenId: ctx.senderOpenId,
        messageId: ctx.messageId,
        rootId: ctx.rootId,
        threadId: ctx.threadId,
        groupConfig,
        feishuCfg,
      })
    : null;
  const groupHistoryKey = isGroup ? (groupSession?.peerId ?? ctx.chatId) : undefined;
  const dmPolicy = feishuCfg?.dmPolicy ?? "pairing";
  const surfaceRouting = resolveFeishuSurfaceRouting({
    cfg: feishuCfg,
    chatId: ctx.chatId,
    content: ctx.content,
    normalizedCommandText,
  });
  const controlRoomOrchestration = resolveFeishuControlRoomOrchestration({
    currentSurface: surfaceRouting.currentSurface,
    targetSurface: surfaceRouting.targetSurface,
    content: ctx.content,
    normalizedCommandText,
  });
  if (surfaceRouting.targetSurface) {
    log(
      `feishu[${account.accountId}]: surface route current=${surfaceRouting.currentSurface ?? "none"} target=${surfaceRouting.targetSurface} source=${surfaceRouting.source}`,
    );
  }
  if (surfaceRouting.currentSurface && surfaceRouting.suppressedIntentSurface) {
    void Promise.resolve(
      recordOperationalAnomaly({
        cfg: cfg as OpenClawConfig,
        category: "role_drift",
        severity: "medium",
        source: "feishu.surface_routing",
        problem: `suppressed cross-surface drift from ${surfaceRouting.currentSurface} toward ${surfaceRouting.suppressedIntentSurface}`,
        evidence: [
          `chat ${ctx.chatId} is explicitly bound to ${surfaceRouting.currentSurface}`,
          `message ${ctx.messageId} also matched ${surfaceRouting.suppressedIntentSurface}`,
          `preview: ${ctx.content.replace(/\s+/g, " ").slice(0, 160)}`,
        ],
        impact:
          "without lane pinning, specialist conversations can jump workflows and contaminate the wrong session",
        suggestedScope:
          "keep specialist chats pinned to their configured lane; only route across surfaces via control_room or explicit operator intent",
      }),
    ).catch(() => {});
  }
  if (controlRoomOrchestration) {
    log(
      `feishu[${account.accountId}]: control-room orchestration mode=${controlRoomOrchestration.mode} specialists=${controlRoomOrchestration.specialistSurfaces.join(",")}`,
    );
  }
  const configAllowFrom = feishuCfg?.allowFrom ?? [];
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const rawBroadcastAgents = isGroup ? resolveBroadcastAgents(cfg, ctx.chatId) : null;
  const broadcastAgents = rawBroadcastAgents
    ? [...new Set(rawBroadcastAgents.map((id) => normalizeAgentId(id)))]
    : null;

  let requireMention = false; // DMs never require mention; groups may override below
  if (isGroup) {
    if (groupConfig?.enabled === false) {
      log(`feishu[${account.accountId}]: group ${ctx.chatId} is disabled`);
      logFeishuNonLedgerEarlyReturn({
        log,
        accountId: account.accountId,
        reason: "group_disabled",
        chatId: ctx.chatId,
        messageId: ctx.messageId,
      });
      return;
    }
    const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
    const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.feishu !== undefined,
      groupPolicy: feishuCfg?.groupPolicy,
      defaultGroupPolicy,
    });
    warnMissingProviderGroupPolicyFallbackOnce({
      providerMissingFallbackApplied,
      providerKey: "feishu",
      accountId: account.accountId,
      log,
    });
    const groupAllowFrom = feishuCfg?.groupAllowFrom ?? [];
    // DEBUG: log(`feishu[${account.accountId}]: groupPolicy=${groupPolicy}`);

    // Check if this GROUP is allowed (groupAllowFrom contains group IDs like oc_xxx, not user IDs)
    const groupAllowed = isFeishuGroupAllowed({
      groupPolicy,
      allowFrom: groupAllowFrom,
      senderId: ctx.chatId, // Check group ID, not sender ID
      senderName: undefined,
    });

    if (!groupAllowed) {
      log(
        `feishu[${account.accountId}]: group ${ctx.chatId} not in groupAllowFrom (groupPolicy=${groupPolicy})`,
      );
      logFeishuNonLedgerEarlyReturn({
        log,
        accountId: account.accountId,
        reason: "group_not_allowed",
        chatId: ctx.chatId,
        messageId: ctx.messageId,
      });
      return;
    }

    // Sender-level allowlist: per-group allowFrom takes precedence, then global groupSenderAllowFrom
    const perGroupSenderAllowFrom = groupConfig?.allowFrom ?? [];
    const globalSenderAllowFrom = feishuCfg?.groupSenderAllowFrom ?? [];
    const effectiveSenderAllowFrom =
      perGroupSenderAllowFrom.length > 0 ? perGroupSenderAllowFrom : globalSenderAllowFrom;
    if (effectiveSenderAllowFrom.length > 0) {
      const senderAllowed = isFeishuGroupAllowed({
        groupPolicy: "allowlist",
        allowFrom: effectiveSenderAllowFrom,
        senderId: ctx.senderOpenId,
        senderIds: [senderUserId],
        senderName: ctx.senderName,
      });
      if (!senderAllowed) {
        log(`feishu: sender ${ctx.senderOpenId} not in group ${ctx.chatId} sender allowlist`);
        logFeishuNonLedgerEarlyReturn({
          log,
          accountId: account.accountId,
          reason: "group_sender_not_allowed",
          chatId: ctx.chatId,
          messageId: ctx.messageId,
        });
        return;
      }
    }

    ({ requireMention } = resolveFeishuReplyPolicy({
      isDirectMessage: false,
      globalConfig: feishuCfg,
      groupConfig,
    }));

    if (requireMention && !ctx.mentionedBot) {
      log(`feishu[${account.accountId}]: message in group ${ctx.chatId} did not mention bot`);
      // Record to pending history for non-broadcast groups only. For broadcast groups,
      // the mentioned handler's broadcast dispatch writes the turn directly into all
      // agent sessions — buffering here would cause duplicate replay when this account
      // later becomes active via buildPendingHistoryContextFromMap.
      if (!broadcastAgents && chatHistories && groupHistoryKey) {
        recordPendingHistoryEntryIfEnabled({
          historyMap: chatHistories,
          historyKey: groupHistoryKey,
          limit: historyLimit,
          entry: {
            sender: ctx.senderOpenId,
            body: `${ctx.senderName ?? ctx.senderOpenId}: ${ctx.content}`,
            timestamp: Date.now(),
            messageId: ctx.messageId,
          },
        });
      }
      logFeishuNonLedgerEarlyReturn({
        log,
        accountId: account.accountId,
        reason: "group_requires_mention",
        chatId: ctx.chatId,
        messageId: ctx.messageId,
      });
      return;
    }
  } else {
  }

  try {
    const core = getFeishuRuntime();
    const pairing = createScopedPairingAccess({
      core,
      channel: "feishu",
      accountId: account.accountId,
    });
    const shouldComputeCommandAuthorized = core.channel.commands.shouldComputeCommandAuthorized(
      normalizedCommandText,
      cfg,
    );
    const storeAllowFrom =
      !isGroup &&
      dmPolicy !== "allowlist" &&
      (dmPolicy !== "open" || shouldComputeCommandAuthorized)
        ? await pairing.readAllowFromStore().catch(() => [])
        : [];
    const effectiveDmAllowFrom = [...configAllowFrom, ...storeAllowFrom];
    const dmAllowed = resolveFeishuAllowlistMatch({
      allowFrom: effectiveDmAllowFrom,
      senderId: ctx.senderOpenId,
      senderIds: [senderUserId],
      senderName: ctx.senderName,
    }).allowed;

    if (isDirect && dmPolicy !== "open" && !dmAllowed) {
      if (dmPolicy === "pairing") {
        const { code, created } = await pairing.upsertPairingRequest({
          id: ctx.senderOpenId,
          meta: { name: ctx.senderName },
        });
        if (created) {
          log(`feishu[${account.accountId}]: pairing request sender=${ctx.senderOpenId}`);
          try {
            await sendMessageFeishu({
              cfg,
              to: `chat:${ctx.chatId}`,
              text: core.channel.pairing.buildPairingReply({
                channel: "feishu",
                idLine: `Your Feishu user id: ${ctx.senderOpenId}`,
                code,
              }),
              accountId: account.accountId,
            });
          } catch (err) {
            log(
              `feishu[${account.accountId}]: pairing reply failed for ${ctx.senderOpenId}: ${String(err)}`,
            );
          }
        }
      } else {
        log(
          `feishu[${account.accountId}]: blocked unauthorized sender ${ctx.senderOpenId} (dmPolicy=${dmPolicy})`,
        );
      }
      logFeishuNonLedgerEarlyReturn({
        log,
        accountId: account.accountId,
        reason: dmPolicy === "pairing" ? "dm_pairing_gate" : "dm_not_allowed",
        chatId: ctx.chatId,
        messageId: ctx.messageId,
      });
      return;
    }

    const commandAllowFrom = isGroup
      ? (groupConfig?.allowFrom ?? configAllowFrom)
      : effectiveDmAllowFrom;
    const senderAllowedForCommands = resolveFeishuAllowlistMatch({
      allowFrom: commandAllowFrom,
      senderId: ctx.senderOpenId,
      senderIds: [senderUserId],
      senderName: ctx.senderName,
    }).allowed;
    const commandAuthorized = shouldComputeCommandAuthorized
      ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
          useAccessGroups,
          authorizers: [
            { configured: commandAllowFrom.length > 0, allowed: senderAllowedForCommands },
          ],
        })
      : undefined;

    // In group chats, the session is scoped to the group, but the *speaker* is the sender.
    // Using a group-scoped From causes the agent to treat different users as the same person.
    const feishuFrom = `feishu:${ctx.senderOpenId}`;
    const feishuTo = isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderOpenId}`;
    const peerId = isGroup ? (groupSession?.peerId ?? ctx.chatId) : ctx.senderOpenId;
    const parentPeer = isGroup ? (groupSession?.parentPeer ?? null) : null;
    const replyInThread = isGroup ? (groupSession?.replyInThread ?? false) : false;

    if (isGroup && groupSession) {
      log(
        `feishu[${account.accountId}]: group session scope=${groupSession.groupSessionScope}, peer=${peerId}`,
      );
    }

    let route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "feishu",
      accountId: account.accountId,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: peerId,
      },
      parentPeer,
    });

    // Dynamic agent creation for DM users
    // When enabled, creates a unique agent instance with its own workspace for each DM user.
    let effectiveCfg = cfg;
    if (!isGroup && route.matchedBy === "default") {
      const dynamicCfg = feishuCfg?.dynamicAgentCreation as DynamicAgentCreationConfig | undefined;
      if (dynamicCfg?.enabled) {
        const runtime = getFeishuRuntime();
        const result = await maybeCreateDynamicAgent({
          cfg,
          runtime,
          senderOpenId: ctx.senderOpenId,
          dynamicCfg,
          log: (msg) => log(msg),
        });
        if (result.created) {
          effectiveCfg = result.updatedCfg;
          // Re-resolve route with updated config
          route = core.channel.routing.resolveAgentRoute({
            cfg: result.updatedCfg,
            channel: "feishu",
            accountId: account.accountId,
            peer: { kind: "direct", id: ctx.senderOpenId },
          });
          log(
            `feishu[${account.accountId}]: dynamic agent created, new route: ${route.sessionKey}`,
          );
        }
      }
    }

    const effectiveStateSurface = resolveFeishuEffectiveStateSurface({
      surfaceRouting,
      controlRoomOrchestration,
    });
    const effectiveSessionKey = buildSurfaceScopedSessionKey(
      route.sessionKey,
      effectiveStateSurface,
    );

    const dailyWorkface =
      controlRoomOrchestration?.includeDailyWorkface === true
        ? await loadLatestDailyWorkface({
            cfg: effectiveCfg,
            agentId: route.agentId,
          })
        : undefined;
    const validationWeekly =
      controlRoomOrchestration?.includeDailyWorkface === true
        ? await loadLatestValidationWeekly({
            cfg: effectiveCfg,
            agentId: route.agentId,
          })
        : undefined;
    const portfolioScorecard =
      controlRoomOrchestration?.includeDailyWorkface === true
        ? await loadLatestPortfolioScorecard({
            cfg: effectiveCfg,
            agentId: route.agentId,
          })
        : undefined;
    const watchtowerChatId = feishuCfg?.surfaces?.watchtower?.chatId?.trim() || undefined;
    const learningCommandChatId = feishuCfg?.surfaces?.learning_command?.chatId?.trim();
    const learningStatusChatId = learningCommandChatId || ctx.chatId;
    const controlRoomDailyActiveLearningTimebox =
      controlRoomOrchestration?.includeDailyWorkface === true
        ? (findRunningFeishuLearningTimeboxSession({
            accountId: account.accountId,
            chatId: learningStatusChatId,
          }) ??
          (await findLatestFeishuLearningTimeboxSession({
            cfg: effectiveCfg,
            accountId: account.accountId,
            chatId: learningStatusChatId,
          }).catch(() => undefined)))
        : undefined;
    const learningStatusEvidenceForControlRoom =
      controlRoomOrchestration?.includeDailyWorkface === true
        ? await buildLearningStatusEvidenceLines({
            cfg: effectiveCfg,
            agentId: route.agentId,
          })
        : undefined;
    const isDailyOperatingBrief = looksLikeDailyOperatingBrief(ctx.content);
    const shouldForceLearningTimeboxSummary =
      controlRoomOrchestration?.includeDailyWorkface === true && isDailyOperatingBrief;
    const learningTimeboxSummary =
      controlRoomOrchestration?.includeDailyWorkface === true &&
      (controlRoomDailyActiveLearningTimebox ||
        dailyWorkface ||
        portfolioScorecard ||
        validationWeekly ||
        shouldForceLearningTimeboxSummary)
        ? buildLearningTimeboxControlRoomSummary({
            chatId: learningStatusChatId,
            activeTimebox: controlRoomDailyActiveLearningTimebox,
            evidenceLines: learningStatusEvidenceForControlRoom,
          })
        : undefined;
    const dailyImprovementPulse =
      controlRoomOrchestration?.includeDailyWorkface === true
        ? buildDailyImprovementPulse(dailyWorkface)
        : undefined;
    const dailyArtifactAvailabilitySummary = shouldForceLearningTimeboxSummary
      ? await buildDailyArtifactAvailabilitySummary({
          cfg: effectiveCfg,
          agentId: route.agentId,
        })
      : undefined;
    const workspaceDir = resolveAgentWorkspaceDir(effectiveCfg as OpenClawConfig, route.agentId);
    const priorSurfaceLineContent =
      controlRoomOrchestration?.includeDailyWorkface === true && isDailyOperatingBrief
        ? await loadExistingFeishuSurfaceLineContent({
            workspaceDir,
            targetSurface: effectiveStateSurface,
            chatId: ctx.chatId,
          })
        : undefined;
    const researchContinuation = await resolveFeishuResearchContinuation({
      workspaceDir,
      userMessage: ctx.content,
      surfaceRouting,
    });
    const workReceiptsDir = path.join(workspaceDir, "memory", "feishu-work-receipts");

    try {
      await ensureFeishuWorkReceiptArtifacts({ receiptsDir: workReceiptsDir });
    } catch (error) {
      await recordFeishuWorkReceiptPersistFailure({
        cfg,
        targetSurface: effectiveStateSurface,
        chatId: ctx.chatId,
        messageId: ctx.messageId,
        error,
      });
    }
    // Parse message create_time (Feishu uses millisecond epoch string).
    const messageCreateTimeMs = event.message.create_time
      ? parseInt(event.message.create_time, 10)
      : undefined;
    const replyTargetMessageId = ctx.rootId ?? ctx.messageId;
    const threadReply = isGroup ? (groupSession?.threadReply ?? false) : false;
    const currentSurfaceForStatus = surfaceRouting.currentSurface as string | undefined;
    const targetSurfaceForStatus = surfaceRouting.targetSurface as string | undefined;
    const shouldAnswerLearningStatusInControlRoom =
      (currentSurfaceForStatus === "control_room" ||
        targetSurfaceForStatus === "control_room" ||
        (!targetSurfaceForStatus && currentSurfaceForStatus === "control_room")) &&
      controlRoomOrchestration?.includeDailyWorkface !== true &&
      looksLikeLearningTimeboxStatusAsk(ctx.content);

    if (shouldAnswerLearningStatusInControlRoom) {
      if (broadcastAgents) {
        if (!(await tryRecordMessagePersistent(ctx.messageId, "broadcast", log))) {
          log(
            `feishu[${account.accountId}]: broadcast already claimed by another account for message ${ctx.messageId}; skipping`,
          );
          logFeishuNonLedgerEarlyReturn({
            log,
            accountId: account.accountId,
            reason: "broadcast_learning_status_already_claimed",
            chatId: ctx.chatId,
            messageId: ctx.messageId,
          });
          return;
        }
      }
      const learningStatusStateSurface: FeishuChatSurfaceName = "control_room";
      const learningStatusSessionKey = buildSurfaceScopedSessionKey(
        route.sessionKey,
        learningStatusStateSurface,
      );
      const learningStatusEvidence = await buildLearningStatusEvidenceLines({
        cfg: effectiveCfg,
        agentId: route.agentId,
      });
      const activeLearningTimebox =
        findRunningFeishuLearningTimeboxSession({
          accountId: account.accountId,
          chatId: learningStatusChatId,
        }) ??
        (await findLatestFeishuLearningTimeboxSession({
          cfg: effectiveCfg,
          accountId: account.accountId,
          chatId: learningStatusChatId,
        }).catch(() => undefined));
      const learningStatusText = buildControlRoomLearningStatusReply({
        learningStatusChatId,
        activeLearningTimebox,
        learningStatusEvidence,
      });
      await createSendAndPersistFeishuDirectSurfaceReply({
        replyRuntime: core.channel.reply,
        runtime: runtime as RuntimeEnv,
        replyTargetMessageId,
        skipReplyToInMessages: !isGroup,
        replyInThread,
        rootId: ctx.rootId,
        threadReply,
        mentionTargets: ctx.mentionTargets,
        accountId: account.accountId,
        messageCreateTimeMs,
        text: learningStatusText,
        ...buildFeishuSurfaceLinePersistContext({
          cfg,
          agentId: route.agentId,
          effectiveStateSurface: learningStatusStateSurface,
          replyContract: controlRoomOrchestration?.replyContract,
          chatId: ctx.chatId,
          sessionKey: learningStatusSessionKey,
          messageId: ctx.messageId,
          userMessage: ctx.content,
        }),
      });

      clearFeishuGroupHistoryAfterDispatch({
        isGroup,
        chatHistories,
        historyKey: groupHistoryKey,
        historyLimit,
      });
      return;
    }

    if (researchContinuation.kind === "clarify") {
      if (broadcastAgents) {
        if (!(await tryRecordMessagePersistent(ctx.messageId, "broadcast", log))) {
          log(
            `feishu[${account.accountId}]: broadcast already claimed by another account for message ${ctx.messageId}; skipping`,
          );
          logFeishuNonLedgerEarlyReturn({
            log,
            accountId: account.accountId,
            reason: "broadcast_clarification_already_claimed",
            chatId: ctx.chatId,
            messageId: ctx.messageId,
          });
          return;
        }
      }

      const clarificationStateSurface: FeishuChatSurfaceName = "control_room";
      await createSendAndPersistFeishuDirectSurfaceReply({
        replyRuntime: core.channel.reply,
        runtime: runtime as RuntimeEnv,
        replyTargetMessageId,
        skipReplyToInMessages: !isGroup,
        replyInThread,
        rootId: ctx.rootId,
        threadReply,
        mentionTargets: ctx.mentionTargets,
        accountId: account.accountId,
        messageCreateTimeMs,
        text: researchContinuation.text,
        ...buildFeishuSurfaceLinePersistContext({
          cfg,
          agentId: route.agentId,
          effectiveStateSurface: clarificationStateSurface,
          replyContract: controlRoomOrchestration?.replyContract,
          chatId: ctx.chatId,
          sessionKey: buildSurfaceScopedSessionKey(route.sessionKey, clarificationStateSurface),
          messageId: ctx.messageId,
          userMessage: ctx.content,
        }),
      });

      clearFeishuGroupHistoryAfterDispatch({
        isGroup,
        chatHistories,
        historyKey: groupHistoryKey,
        historyLimit,
      });
      return;
    }

    const preview = ctx.content.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isGroup
      ? `Feishu[${account.accountId}] message in group ${ctx.chatId}`
      : `Feishu[${account.accountId}] DM from ${ctx.senderOpenId}`;

    // Do not enqueue inbound user previews as system events.
    // System events are prepended to future prompts and can be misread as
    // authoritative transcript turns.
    log(`feishu[${account.accountId}]: ${inboundLabel}: ${preview}`);

    // Resolve media from message
    const mediaMaxBytes = (feishuCfg?.mediaMaxMb ?? 30) * 1024 * 1024; // 30MB default
    const mediaList = await resolveFeishuMediaList({
      cfg,
      messageId: ctx.messageId,
      messageType: event.message.message_type,
      content: event.message.content,
      maxBytes: mediaMaxBytes,
      log,
      accountId: account.accountId,
    });
    const mediaPayload = buildAgentMediaPayload(mediaList);

    // Fetch quoted/replied message content if parentId exists
    let quotedContent: string | undefined;
    if (ctx.parentId) {
      try {
        const quotedMsg = await getMessageFeishu({
          cfg,
          messageId: ctx.parentId,
          accountId: account.accountId,
        });
        if (quotedMsg) {
          quotedContent = quotedMsg.content;
          log(
            `feishu[${account.accountId}]: fetched quoted message: ${quotedContent?.slice(0, 100)}`,
          );
        }
      } catch (err) {
        log(`feishu[${account.accountId}]: failed to fetch quoted message: ${String(err)}`);
      }
    }

    const larkInstructionHandoff = await resolveLarkAgentInstructionHandoff({
      cfg: feishuCfg,
      utterance: ctx.content,
      chatId: ctx.chatId,
      apiProvider: createGatewayLarkApiRouteProvider({
        routeAgentId: route.agentId,
        sessionKey: effectiveSessionKey,
        messageId: ctx.messageId,
      }),
    });
    const larkApiReplyPayloads = larkInstructionHandoff.apiCandidate
      ? [larkInstructionHandoff.apiCandidate]
      : undefined;
    const larkHandoffReceipt = await persistLarkLanguageHandoffReceiptWithFailureReceipt({
      cfg,
      agentId: route.agentId,
      targetSurface: surfaceRouting.targetSurface,
      effectiveSurface: effectiveStateSurface,
      chatId: ctx.chatId,
      sessionKey: effectiveSessionKey,
      messageId: ctx.messageId,
      userMessage: ctx.content,
      handoff: larkInstructionHandoff,
    });
    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const surfaceNotice = [
      buildFeishuPromptSurfaceNotice({
        surfaceRouting,
        controlRoomOrchestration,
      }),
      larkInstructionHandoff.notice,
      renderLarkFinanceBrainOrchestrationNotice(
        larkHandoffReceipt?.artifact.financeBrainOrchestration,
      ),
    ]
      .filter(Boolean)
      .join("\n");
    const messageBody = buildFeishuAgentBody({
      ctx,
      quotedContent,
      permissionErrorForAgent,
      botOpenId,
      surfaceNotice,
      continuationNotice:
        researchContinuation.kind === "anchored" ? researchContinuation.notice : undefined,
    });
    const envelopeFrom = isGroup ? `${ctx.chatId}:${ctx.senderOpenId}` : ctx.senderOpenId;
    if (permissionErrorForAgent) {
      // Keep the notice in a single dispatch to avoid duplicate replies (#27372).
      log(`feishu[${account.accountId}]: appending permission error notice to message body`);
    }

    const body = core.channel.reply.formatAgentEnvelope({
      channel: "Feishu",
      from: envelopeFrom,
      timestamp: new Date(),
      envelope: envelopeOptions,
      body: messageBody,
    });

    let combinedBody = body;
    const historyKey = groupHistoryKey;

    if (isGroup && historyKey && chatHistories) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: chatHistories,
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          core.channel.reply.formatAgentEnvelope({
            channel: "Feishu",
            // Preserve speaker identity in group history as well.
            from: `${ctx.chatId}:${entry.sender}`,
            timestamp: entry.timestamp,
            body: entry.body,
            envelope: envelopeOptions,
          }),
      });
    }

    const inboundHistory =
      isGroup && historyKey && historyLimit > 0 && chatHistories
        ? (chatHistories.get(historyKey) ?? []).map((entry) => ({
            sender: entry.sender,
            body: entry.body,
            timestamp: entry.timestamp,
          }))
        : undefined;

    // Keep the user's natural-language body for the model, but feed the
    // normalized command text into the command path so explicit Feishu aliases
    // can reuse the existing /new and /reset flow.
    // --- Shared context builder for dispatch ---
    const buildCtxPayloadForAgent = (
      agentSessionKey: string,
      agentAccountId: string,
      wasMentioned: boolean,
    ) =>
      core.channel.reply.finalizeInboundContext({
        Body: combinedBody,
        BodyForAgent: messageBody,
        InboundHistory: inboundHistory,
        ReplyToId: ctx.parentId,
        RootMessageId: ctx.rootId,
        RawBody: normalizedCommandText,
        CommandBody: normalizedCommandText,
        From: feishuFrom,
        To: feishuTo,
        SessionKey: agentSessionKey,
        AccountId: agentAccountId,
        ChatType: isGroup ? "group" : "direct",
        GroupSubject: isGroup ? ctx.chatId : undefined,
        SenderName: ctx.senderName ?? ctx.senderOpenId,
        SenderId: ctx.senderOpenId,
        Provider: "feishu" as const,
        Surface: "feishu" as const,
        MessageSid: ctx.messageId,
        ReplyToBody: quotedContent ?? undefined,
        Timestamp: Date.now(),
        WasMentioned: wasMentioned,
        CommandAuthorized: commandAuthorized,
        OriginatingChannel: "feishu" as const,
        OriginatingTo: feishuTo,
        GroupSystemPrompt: isGroup ? groupConfig?.systemPrompt?.trim() || undefined : undefined,
        ...mediaPayload,
      });

    if (broadcastAgents) {
      // Cross-account dedup: in multi-account setups, Feishu delivers the same
      // event to every bot account in the group. Only one account should handle
      // broadcast dispatch to avoid duplicate agent sessions and race conditions.
      // Uses a shared "broadcast" namespace (not per-account) so the first handler
      // to reach this point claims the message; subsequent accounts skip.
      if (!(await tryRecordMessagePersistent(ctx.messageId, "broadcast", log))) {
        log(
          `feishu[${account.accountId}]: broadcast already claimed by another account for message ${ctx.messageId}; skipping`,
        );
        logFeishuNonLedgerEarlyReturn({
          log,
          accountId: account.accountId,
          reason: "broadcast_dispatch_already_claimed",
          chatId: ctx.chatId,
          messageId: ctx.messageId,
        });
        return;
      }

      // --- Broadcast dispatch: send message to all configured agents ---
      const strategy =
        ((cfg as Record<string, unknown>).broadcast as Record<string, unknown> | undefined)
          ?.strategy || "parallel";
      const activeAgentId =
        ctx.mentionedBot || !requireMention ? normalizeAgentId(route.agentId) : null;
      const agentIds = (cfg.agents?.list ?? []).map((a: { id: string }) => normalizeAgentId(a.id));
      const hasKnownAgents = agentIds.length > 0;
      const canDispatchActiveAgent =
        activeAgentId !== null &&
        broadcastAgents.includes(activeAgentId) &&
        (!hasKnownAgents || agentIds.includes(activeAgentId));
      if (activeAgentId && !canDispatchActiveAgent) {
        await recordOperationalAnomaly({
          cfg,
          category: "write_edit_failure",
          severity: "medium",
          source: "feishu.broadcast",
          problem: "broadcast dispatch has no active visible reply agent",
          evidence: [
            `active_agent=${activeAgentId}`,
            `broadcast_agents=${broadcastAgents.join(",") || "none"}`,
            `known_agents=${agentIds.join(",") || "none"}`,
            `chat_id=${ctx.chatId}`,
            `message_id=${ctx.messageId}`,
          ],
          impact:
            "broadcast observer sessions may still run, but no configured active agent can send the visible Feishu reply",
          suggestedScope:
            "add the routed active agent to the broadcast list or adjust routing before treating broadcast delivery as healthy",
        });
      }

      log(
        `feishu[${account.accountId}]: broadcasting to ${broadcastAgents.length} agents (strategy=${strategy}, active=${activeAgentId ?? "none"})`,
      );

      const dispatchForAgent = async (agentId: string) => {
        if (hasKnownAgents && !agentIds.includes(normalizeAgentId(agentId))) {
          log(
            `feishu[${account.accountId}]: broadcast agent ${agentId} not found in agents.list; skipping`,
          );
          logFeishuNonLedgerEarlyReturn({
            log,
            accountId: account.accountId,
            reason: "broadcast_unknown_agent",
            chatId: ctx.chatId,
            messageId: ctx.messageId,
          });
          return;
        }

        const agentSessionKey = buildBroadcastSessionKey(
          effectiveSessionKey,
          route.agentId,
          agentId,
        );
        const agentCtx = buildCtxPayloadForAgent(
          agentSessionKey,
          route.accountId,
          ctx.mentionedBot && agentId === activeAgentId,
        );

        if (agentId === activeAgentId) {
          // Active agent: real Feishu dispatcher (responds on Feishu)
          const { dispatcher, replyOptions, markDispatchIdle } = createFeishuReplyDispatcher({
            cfg,
            agentId,
            runtime: runtime as RuntimeEnv,
            chatId: ctx.chatId,
            replyToMessageId: replyTargetMessageId,
            skipReplyToInMessages: !isGroup,
            replyInThread,
            rootId: ctx.rootId,
            threadReply,
            mentionTargets: ctx.mentionTargets,
            accountId: account.accountId,
            messageCreateTimeMs,
          });
          const surfaceLineCapture = createSurfaceLineCaptureDispatcher({
            dispatcher,
          });
          const effectiveDispatcher = createClassifiedPublishDispatcher({
            dispatcher: createDailyWorkfacePublishDispatcher({
              dispatcher: surfaceLineCapture.dispatcher,
              cfg,
              accountId: account.accountId,
              isDailyBrief: isDailyOperatingBrief,
              dailyWorkface,
              portfolioScorecard,
              validationWeekly,
              learningTimeboxSummary,
              improvementPulse: dailyImprovementPulse,
              dailyArtifactAvailabilitySummary,
              priorSurfaceLineContent,
              watchtowerChatId,
            }),
            cfg,
            accountId: account.accountId,
            controlRoomOrchestration,
          });

          log(
            `feishu[${account.accountId}]: broadcast active dispatch agent=${agentId} (session=${agentSessionKey})`,
          );
          const { queuedFinal, counts } = await core.channel.reply.withReplyDispatcher({
            dispatcher: effectiveDispatcher,
            onSettled: () => markDispatchIdle(),
            run: () =>
              core.channel.reply.dispatchReplyFromConfig({
                ctx: agentCtx,
                cfg,
                dispatcher: effectiveDispatcher,
                replyOptions,
              }),
          });

          await persistCapturedFeishuSurfaceLine({
            ...buildFeishuSurfaceLinePersistContext({
              cfg,
              agentId,
              effectiveStateSurface,
              replyContract: controlRoomOrchestration?.replyContract,
              chatId: ctx.chatId,
              sessionKey: agentSessionKey,
              messageId: ctx.messageId,
              userMessage: ctx.content,
              apiReplyPayloads: larkApiReplyPayloads,
            }),
            finalReplyText: surfaceLineCapture.getLastFinalReplyText(),
            dispatchQueuedFinal: queuedFinal,
            dispatchFinalCount: counts.final,
          });
        } else {
          // Observer agent: no-op dispatcher (session entry + inference, no Feishu reply).
          // Strip CommandAuthorized so slash commands (e.g. /reset) don't silently
          // mutate observer sessions — only the active agent should execute commands.
          delete (agentCtx as Record<string, unknown>).CommandAuthorized;
          const noopDispatcher = {
            sendToolResult: () => false,
            sendBlockReply: () => false,
            sendFinalReply: () => false,
            waitForIdle: async () => {},
            getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
            markComplete: () => {},
          };

          log(
            `feishu[${account.accountId}]: broadcast observer dispatch agent=${agentId} (session=${agentSessionKey})`,
          );
          await core.channel.reply.withReplyDispatcher({
            dispatcher: noopDispatcher,
            run: () =>
              core.channel.reply.dispatchReplyFromConfig({
                ctx: agentCtx,
                cfg,
                dispatcher: noopDispatcher,
              }),
          });
        }
      };

      if (strategy === "sequential") {
        for (const agentId of broadcastAgents) {
          try {
            await dispatchForAgent(agentId);
          } catch (err) {
            log(
              `feishu[${account.accountId}]: broadcast dispatch failed for agent=${agentId}: ${String(err)}`,
            );
            await recordOperationalAnomaly({
              cfg,
              category: "write_edit_failure",
              severity: "high",
              source: "feishu.dispatch",
              problem: "broadcast dispatch failed",
              evidence: [
                `account=${account.accountId}`,
                `agent=${agentId}`,
                `message_id=${ctx.messageId}`,
                `error=${String(err)}`,
              ],
              impact: "one or more broadcast reply paths failed during active user operation",
            });
          }
        }
      } else {
        const results = await Promise.allSettled(broadcastAgents.map(dispatchForAgent));
        for (let i = 0; i < results.length; i++) {
          if (results[i].status === "rejected") {
            log(
              `feishu[${account.accountId}]: broadcast dispatch failed for agent=${broadcastAgents[i]}: ${String((results[i] as PromiseRejectedResult).reason)}`,
            );
            await recordOperationalAnomaly({
              cfg,
              category: "write_edit_failure",
              severity: "high",
              source: "feishu.dispatch",
              problem: "broadcast dispatch failed",
              evidence: [
                `account=${account.accountId}`,
                `agent=${broadcastAgents[i]}`,
                `message_id=${ctx.messageId}`,
                `error=${String((results[i] as PromiseRejectedResult).reason)}`,
              ],
              impact: "one or more broadcast reply paths failed during active user operation",
            });
          }
        }
      }

      clearFeishuGroupHistoryAfterDispatch({
        isGroup,
        chatHistories,
        historyKey,
        historyLimit,
      });

      log(
        `feishu[${account.accountId}]: broadcast dispatch complete for ${broadcastAgents.length} agents`,
      );
    } else {
      // --- Single-agent dispatch (existing behavior) ---
      const ctxPayload = buildCtxPayloadForAgent(
        effectiveSessionKey,
        route.accountId,
        ctx.mentionedBot,
      );

      const { dispatcher, replyOptions, markDispatchIdle } = createFeishuReplyDispatcher({
        cfg,
        agentId: route.agentId,
        runtime: runtime as RuntimeEnv,
        chatId: ctx.chatId,
        replyToMessageId: replyTargetMessageId,
        skipReplyToInMessages: !isGroup,
        replyInThread,
        rootId: ctx.rootId,
        threadReply,
        mentionTargets: ctx.mentionTargets,
        accountId: account.accountId,
        messageCreateTimeMs,
      });
      const surfaceLineCapture = createSurfaceLineCaptureDispatcher({
        dispatcher,
      });
      const effectiveDispatcher = createClassifiedPublishDispatcher({
        dispatcher: createDailyWorkfacePublishDispatcher({
          dispatcher: surfaceLineCapture.dispatcher,
          cfg,
          accountId: account.accountId,
          isDailyBrief: isDailyOperatingBrief,
          dailyWorkface,
          portfolioScorecard,
          validationWeekly,
          learningTimeboxSummary,
          improvementPulse: dailyImprovementPulse,
          dailyArtifactAvailabilitySummary,
          priorSurfaceLineContent,
          watchtowerChatId,
        }),
        cfg,
        accountId: account.accountId,
        controlRoomOrchestration,
      });

      if (shouldUseFeishuProtocolStatusReadbackReply(ctx.content)) {
        const statusReadbackReply = buildProtocolInfoReply({
          text: ctx.content,
          cfg: effectiveCfg as OpenClawConfig,
        });
        const statusReadbackText = [
          statusReadbackReply?.text ??
            "🧭 Status readback\nfailedReason: protocol_status_readback_unavailable",
          `Handoff receipt: ${larkHandoffReceipt?.relativePath ?? "write_failed_or_unavailable"}`,
          "Direct dispatch: protocol_status_readback_guard; model_worker=not_called; boundary=current_evidence_only_no_trade_no_file_mutation.",
        ].join("\n");
        const statusReadbackSendResult = await sendFeishuFinalTextReply({
          replyRuntime: core.channel.reply,
          dispatcher: effectiveDispatcher,
          markDispatchIdle,
          text: statusReadbackText,
        });

        clearFeishuGroupHistoryAfterDispatch({
          isGroup,
          chatHistories,
          historyKey,
          historyLimit,
        });

        await persistCapturedFeishuSurfaceLine({
          ...buildFeishuSurfaceLinePersistContext({
            cfg,
            agentId: route.agentId,
            effectiveStateSurface: "control_room",
            replyContract: controlRoomOrchestration?.replyContract,
            chatId: ctx.chatId,
            sessionKey: buildSurfaceScopedSessionKey(route.sessionKey, "control_room"),
            messageId: ctx.messageId,
            userMessage: ctx.content,
            apiReplyPayloads: larkApiReplyPayloads,
          }),
          finalReplyText: statusReadbackSendResult.queuedFinal ? statusReadbackText : undefined,
          dispatchQueuedFinal: statusReadbackSendResult.queuedFinal,
          dispatchFinalCount: statusReadbackSendResult.counts.final,
        });
        return;
      }

      if (shouldUseFeishuSourceRequiredTruthReply(ctx.content)) {
        const sourceRequiredTruthText = renderFeishuProtocolTruthSurfaceReply({
          userMessage: ctx.content,
          family:
            larkInstructionHandoff.family === "unknown"
              ? "protocol_truth_surface"
              : larkInstructionHandoff.family,
          confidence: larkInstructionHandoff.confidence,
          rationale: larkInstructionHandoff.apiCandidate?.rationale,
        });
        const sourceRequiredTruthSendResult = await sendFeishuFinalTextReply({
          replyRuntime: core.channel.reply,
          dispatcher: effectiveDispatcher,
          markDispatchIdle,
          text: sourceRequiredTruthText,
        });

        clearFeishuGroupHistoryAfterDispatch({
          isGroup,
          chatHistories,
          historyKey,
          historyLimit,
        });

        await persistCapturedFeishuSurfaceLine({
          ...buildFeishuSurfaceLinePersistContext({
            cfg,
            agentId: route.agentId,
            effectiveStateSurface: "control_room",
            replyContract: controlRoomOrchestration?.replyContract,
            chatId: ctx.chatId,
            sessionKey: buildSurfaceScopedSessionKey(route.sessionKey, "control_room"),
            messageId: ctx.messageId,
            userMessage: ctx.content,
            apiReplyPayloads: larkApiReplyPayloads,
          }),
          finalReplyText: sourceRequiredTruthSendResult.queuedFinal
            ? sourceRequiredTruthText
            : undefined,
          dispatchQueuedFinal: sourceRequiredTruthSendResult.queuedFinal,
          dispatchFinalCount: sourceRequiredTruthSendResult.counts.final,
        });
        return;
      }

      if (larkInstructionHandoff.family === "live_scheduling_queue") {
        const queueReplyText = renderFeishuLiveSchedulingQueueReply({
          handoff: larkInstructionHandoff,
          handoffReceiptPath: larkHandoffReceipt?.relativePath,
          targetSurface: surfaceRouting.targetSurface,
          effectiveSurface: effectiveStateSurface,
        });
        const queueSendResult = await sendFeishuFinalTextReply({
          replyRuntime: core.channel.reply,
          dispatcher: effectiveDispatcher,
          markDispatchIdle,
          text: queueReplyText,
        });

        clearFeishuGroupHistoryAfterDispatch({
          isGroup,
          chatHistories,
          historyKey,
          historyLimit,
        });

        await persistCapturedFeishuSurfaceLine({
          ...buildFeishuSurfaceLinePersistContext({
            cfg,
            agentId: route.agentId,
            effectiveStateSurface,
            replyContract: controlRoomOrchestration?.replyContract,
            chatId: ctx.chatId,
            sessionKey: effectiveSessionKey,
            messageId: ctx.messageId,
            userMessage: ctx.content,
            apiReplyPayloads: larkApiReplyPayloads,
          }),
          finalReplyText: queueSendResult.queuedFinal ? queueReplyText : undefined,
          dispatchQueuedFinal: queueSendResult.queuedFinal,
          dispatchFinalCount: queueSendResult.counts.final,
        });
        return;
      }

      if (larkInstructionHandoff.family === "knowledge_internalization_audit") {
        const internalizedLearningProof = await findLatestFeishuInternalizedLearningProof({
          workspaceDir: resolveAgentWorkspaceDir(effectiveCfg as OpenClawConfig, route.agentId),
        });
        const auditReplyText = renderFeishuKnowledgeInternalizationAuditHandoffReply({
          handoff: larkInstructionHandoff,
          handoffReceiptPath: larkHandoffReceipt?.relativePath,
          targetSurface: surfaceRouting.targetSurface,
          effectiveSurface: effectiveStateSurface,
          proof: internalizedLearningProof,
        });
        const auditSendResult = await sendFeishuFinalTextReply({
          replyRuntime: core.channel.reply,
          dispatcher: effectiveDispatcher,
          markDispatchIdle,
          text: auditReplyText,
        });

        clearFeishuGroupHistoryAfterDispatch({
          isGroup,
          chatHistories,
          historyKey,
          historyLimit,
        });

        await persistCapturedFeishuSurfaceLine({
          ...buildFeishuSurfaceLinePersistContext({
            cfg,
            agentId: route.agentId,
            effectiveStateSurface,
            replyContract: controlRoomOrchestration?.replyContract,
            chatId: ctx.chatId,
            sessionKey: effectiveSessionKey,
            messageId: ctx.messageId,
            userMessage: ctx.content,
            apiReplyPayloads: larkApiReplyPayloads,
          }),
          finalReplyText: auditSendResult.queuedFinal ? auditReplyText : undefined,
          dispatchQueuedFinal: auditSendResult.queuedFinal,
          dispatchFinalCount: auditSendResult.counts.final,
        });
        return;
      }

      if (larkInstructionHandoff.family === "protocol_truth_surface") {
        const protocolInfoReply = shouldUseFeishuProtocolTruthIdentityReply(ctx.content)
          ? null
          : buildProtocolInfoReply({
              text: ctx.content,
              cfg: effectiveCfg as OpenClawConfig,
            });
        const protocolTruthText =
          protocolInfoReply?.text ??
          renderFeishuProtocolTruthSurfaceReply({
            userMessage: ctx.content,
            family: larkInstructionHandoff.family,
            confidence: larkInstructionHandoff.confidence,
            rationale: larkInstructionHandoff.apiCandidate?.rationale,
          });
        const protocolTruthSendResult = await sendFeishuFinalTextReply({
          replyRuntime: core.channel.reply,
          dispatcher: effectiveDispatcher,
          markDispatchIdle,
          text: protocolTruthText,
        });

        clearFeishuGroupHistoryAfterDispatch({
          isGroup,
          chatHistories,
          historyKey,
          historyLimit,
        });

        await persistCapturedFeishuSurfaceLine({
          ...buildFeishuSurfaceLinePersistContext({
            cfg,
            agentId: route.agentId,
            effectiveStateSurface: "control_room",
            replyContract: controlRoomOrchestration?.replyContract,
            chatId: ctx.chatId,
            sessionKey: buildSurfaceScopedSessionKey(route.sessionKey, "control_room"),
            messageId: ctx.messageId,
            userMessage: ctx.content,
            apiReplyPayloads: larkApiReplyPayloads,
          }),
          finalReplyText: protocolTruthSendResult.queuedFinal ? protocolTruthText : undefined,
          dispatchQueuedFinal: protocolTruthSendResult.queuedFinal,
          dispatchFinalCount: protocolTruthSendResult.counts.final,
        });
        return;
      }

      const shouldUseLearningCommandBackend =
        surfaceRouting.targetSurface === "learning_command" ||
        (larkInstructionHandoff.targetSurface === "learning_command" &&
          larkInstructionHandoff.backendToolContract?.toolName ===
            "finance_learning_pipeline_orchestrator");

      if (shouldUseLearningCommandBackend) {
        if (looksLikeMarketIntelligencePacketAsk(ctx.content)) {
          log(
            `feishu[${account.accountId}]: running bounded market-intelligence packet for message ${ctx.messageId}`,
          );
          const learningWorkspaceDir = resolveAgentWorkspaceDir(
            cfg as OpenClawConfig,
            route.agentId,
          );
          const packetText = await runFeishuMarketIntelligencePacket({
            cfg,
            userMessage: ctx.content,
            routeAgentId: route.agentId,
            sessionKey: effectiveSessionKey,
            messageId: ctx.messageId,
            workspaceDir: learningWorkspaceDir,
          });

          const packetSendResult = await sendFeishuFinalTextReply({
            replyRuntime: core.channel.reply,
            dispatcher: effectiveDispatcher,
            markDispatchIdle,
            text: packetText,
          });

          clearFeishuGroupHistoryAfterDispatch({
            isGroup,
            chatHistories,
            historyKey,
            historyLimit,
          });

          await persistCapturedFeishuSurfaceLine({
            ...buildFeishuSurfaceLinePersistContext({
              cfg,
              agentId: route.agentId,
              effectiveStateSurface,
              replyContract: controlRoomOrchestration?.replyContract,
              chatId: ctx.chatId,
              sessionKey: effectiveSessionKey,
              messageId: ctx.messageId,
              userMessage: ctx.content,
              apiReplyPayloads: larkApiReplyPayloads,
            }),
            finalReplyText: packetSendResult.queuedFinal ? packetText : undefined,
            dispatchQueuedFinal: packetSendResult.queuedFinal,
            dispatchFinalCount: packetSendResult.counts.final,
          });
          return;
        }
        const shouldRunFinanceLearningPipelineBackend =
          (larkInstructionHandoff.backendToolContract?.toolName ===
            "finance_learning_pipeline_orchestrator" ||
            looksLikeFinanceLearningPipelineAsk(ctx.content)) &&
          !looksLikeLearningTimeboxStartRequest(ctx.content);
        if (shouldRunFinanceLearningPipelineBackend) {
          const learningWorkspaceDir = resolveAgentWorkspaceDir(
            cfg as OpenClawConfig,
            route.agentId,
          );
          const pipelineSource = resolveFeishuFinanceLearningPipelineSource({
            content: ctx.content,
            quotedContent,
          });
          if (!pipelineSource) {
            const missingSourceText = renderFeishuFinanceLearningPipelineMissingSourceReply();
            const missingSourceSendResult = await sendFeishuFinalTextReply({
              replyRuntime: core.channel.reply,
              dispatcher: effectiveDispatcher,
              markDispatchIdle,
              text: missingSourceText,
            });

            clearFeishuGroupHistoryAfterDispatch({
              isGroup,
              chatHistories,
              historyKey,
              historyLimit,
            });

            await persistCapturedFeishuSurfaceLine({
              ...buildFeishuSurfaceLinePersistContext({
                cfg,
                agentId: route.agentId,
                effectiveStateSurface,
                replyContract: controlRoomOrchestration?.replyContract,
                chatId: ctx.chatId,
                sessionKey: effectiveSessionKey,
                messageId: ctx.messageId,
                userMessage: ctx.content,
                apiReplyPayloads: larkApiReplyPayloads,
              }),
              finalReplyText: missingSourceSendResult.queuedFinal ? missingSourceText : undefined,
              dispatchQueuedFinal: missingSourceSendResult.queuedFinal,
              dispatchFinalCount: missingSourceSendResult.counts.final,
            });
            return;
          }
          if (pipelineSource.kind === "local_file") {
            const sourceValidation = await validateFeishuFinanceLearningLocalSource({
              workspaceDir: learningWorkspaceDir,
              localFilePath: pipelineSource.localFilePath,
            });
            if (!sourceValidation.ok) {
              const invalidSourceText = renderFeishuFinanceLearningPipelineReply({
                ok: false,
                reason: sourceValidation.reason,
                failedStep: "source_intake",
                errorMessage: `${sourceValidation.reason}: ${pipelineSource.localFilePath}`,
                retrievalReceiptPath: "not_created",
                retrievalReviewPath: "not_created",
              });
              const invalidSourceSendResult = await sendFeishuFinalTextReply({
                replyRuntime: core.channel.reply,
                dispatcher: effectiveDispatcher,
                markDispatchIdle,
                text: invalidSourceText,
              });

              clearFeishuGroupHistoryAfterDispatch({
                isGroup,
                chatHistories,
                historyKey,
                historyLimit,
              });

              await persistCapturedFeishuSurfaceLine({
                ...buildFeishuSurfaceLinePersistContext({
                  cfg,
                  agentId: route.agentId,
                  effectiveStateSurface,
                  replyContract: controlRoomOrchestration?.replyContract,
                  chatId: ctx.chatId,
                  sessionKey: effectiveSessionKey,
                  messageId: ctx.messageId,
                  userMessage: ctx.content,
                  apiReplyPayloads: larkApiReplyPayloads,
                }),
                finalReplyText: invalidSourceSendResult.queuedFinal ? invalidSourceText : undefined,
                dispatchQueuedFinal: invalidSourceSendResult.queuedFinal,
                dispatchFinalCount: invalidSourceSendResult.counts.final,
              });
              return;
            }
          }

          const pipelineTool = createFinanceLearningPipelineOrchestratorTool({
            workspaceDir: learningWorkspaceDir,
          });
          const pipelineResult = await pipelineTool.execute(
            `${ctx.messageId}:finance-learning-pipeline`,
            {
              sourceName: "Lark manual finance learning source",
              sourceType: "manual_article_source",
              ...(pipelineSource.kind === "local_file"
                ? { localFilePath: pipelineSource.localFilePath }
                : { pastedText: pipelineSource.pastedText }),
              title: "Lark finance capability learning request",
              retrievalNotes:
                "Operator provided a Lark-triggered finance learning source for bounded research-only source intake, extraction, attachment, retrieval receipt, and retrieval review.",
              allowedActionAuthority: "research_only",
              learningIntent:
                larkInstructionHandoff.backendToolContract?.learningIntent ?? ctx.content,
              maxRetrievedCapabilities: 5,
              applicationValidationQuery: ctx.content,
              maxAppliedCapabilities: 3,
            },
          );
          const pipelineReplyText = renderFeishuFinanceLearningPipelineReply({
            ...(pipelineResult.details as Record<string, unknown>),
          });
          const pipelineSendResult = await sendFeishuFinalTextReply({
            replyRuntime: core.channel.reply,
            dispatcher: effectiveDispatcher,
            markDispatchIdle,
            text: pipelineReplyText,
          });

          clearFeishuGroupHistoryAfterDispatch({
            isGroup,
            chatHistories,
            historyKey,
            historyLimit,
          });

          await persistCapturedFeishuSurfaceLine({
            ...buildFeishuSurfaceLinePersistContext({
              cfg,
              agentId: route.agentId,
              effectiveStateSurface,
              replyContract: controlRoomOrchestration?.replyContract,
              chatId: ctx.chatId,
              sessionKey: effectiveSessionKey,
              messageId: ctx.messageId,
              userMessage: ctx.content,
              apiReplyPayloads: larkApiReplyPayloads,
            }),
            finalReplyText: pipelineSendResult.queuedFinal ? pipelineReplyText : undefined,
            dispatchQueuedFinal: pipelineSendResult.queuedFinal,
            dispatchFinalCount: pipelineSendResult.counts.final,
          });
          return;
        }
        log(
          `feishu[${account.accountId}]: running real learning council for message ${ctx.messageId}`,
        );
        let cachedLearningStatusEvidence: string[] | undefined;
        const getLearningStatusEvidence = async (): Promise<string[]> => {
          if (cachedLearningStatusEvidence) {
            return cachedLearningStatusEvidence;
          }
          cachedLearningStatusEvidence = await buildLearningStatusEvidenceLines({
            cfg,
            agentId: route.agentId,
          });
          return cachedLearningStatusEvidence;
        };
        const activeTimebox = findRunningFeishuLearningTimeboxSession({
          accountId: account.accountId,
          chatId: ctx.chatId,
        });
        if (activeTimebox) {
          await sendAndPersistFeishuLearningTimeboxAlreadyRunningReply({
            replyRuntime: core.channel.reply,
            dispatcher: effectiveDispatcher,
            markDispatchIdle,
            isGroup,
            chatHistories,
            historyKey,
            historyLimit,
            ...buildFeishuSurfaceLinePersistContext({
              cfg,
              agentId: route.agentId,
              effectiveStateSurface,
              replyContract: controlRoomOrchestration?.replyContract,
              chatId: ctx.chatId,
              sessionKey: effectiveSessionKey,
              messageId: ctx.messageId,
              userMessage: ctx.content,
              apiReplyPayloads: larkApiReplyPayloads,
            }),
            sessionId: activeTimebox.sessionId,
            deadlineAt: activeTimebox.deadlineAt,
            learningStatusEvidence: await getLearningStatusEvidence(),
            judgment: "- 当前判断: 这次不会再插入新的即时学习，避免同一 chat 的学习轨迹互相污染。",
          });
          return;
        }
        const timeboxPreflight = peekFeishuLearningTimeboxSession({
          accountId: account.accountId,
          chatId: ctx.chatId,
          userMessage: ctx.content,
        });
        const persistedRunningTimebox = await findLatestFeishuLearningTimeboxSession({
          cfg: effectiveCfg,
          accountId: account.accountId,
          chatId: ctx.chatId,
        });
        if (persistedRunningTimebox?.status === "running") {
          await sendAndPersistFeishuLearningTimeboxAlreadyRunningReply({
            replyRuntime: core.channel.reply,
            dispatcher: effectiveDispatcher,
            markDispatchIdle,
            isGroup,
            chatHistories,
            historyKey,
            historyLimit,
            ...buildFeishuSurfaceLinePersistContext({
              cfg,
              agentId: route.agentId,
              effectiveStateSurface,
              replyContract: controlRoomOrchestration?.replyContract,
              chatId: ctx.chatId,
              sessionKey: effectiveSessionKey,
              messageId: ctx.messageId,
              userMessage: ctx.content,
              apiReplyPayloads: larkApiReplyPayloads,
            }),
            sessionId: persistedRunningTimebox.sessionId,
            deadlineAt: persistedRunningTimebox.deadlineAt,
            learningStatusEvidence: await getLearningStatusEvidence(),
            judgment:
              "- 当前判断: 这次不会再插入新的即时学习，避免在恢复窗口里把同一 chat 的学习轨迹再跑脏一轮。",
          });
          return;
        }
        if (timeboxPreflight.status === "already_running") {
          await sendAndPersistFeishuLearningTimeboxAlreadyRunningReply({
            replyRuntime: core.channel.reply,
            dispatcher: effectiveDispatcher,
            markDispatchIdle,
            isGroup,
            chatHistories,
            historyKey,
            historyLimit,
            ...buildFeishuSurfaceLinePersistContext({
              cfg,
              agentId: route.agentId,
              effectiveStateSurface,
              replyContract: controlRoomOrchestration?.replyContract,
              chatId: ctx.chatId,
              sessionKey: effectiveSessionKey,
              messageId: ctx.messageId,
              userMessage: ctx.content,
              apiReplyPayloads: larkApiReplyPayloads,
            }),
            sessionId: timeboxPreflight.sessionId,
            deadlineAt: timeboxPreflight.deadlineAt,
            learningStatusEvidence: await getLearningStatusEvidence(),
            judgment:
              "- 当前判断: 这次不会再重复执行新的即时学习或后台 session，避免同一 chat 的学习会话互相覆盖。",
          });
          return;
        }
        const learningWorkspaceDir = resolveAgentWorkspaceDir(cfg as OpenClawConfig, route.agentId);
        const councilText = await runFeishuLearningCouncil({
          cfg,
          userMessage: ctx.content,
          routeAgentId: route.agentId,
          sessionKey: effectiveSessionKey,
          messageId: ctx.messageId,
          workspaceDir: learningWorkspaceDir,
        });
        const timeboxStart = await startFeishuLearningTimeboxSession({
          cfg,
          accountId: account.accountId,
          chatId: ctx.chatId,
          routeAgentId: route.agentId,
          sessionKey: effectiveSessionKey,
          messageId: ctx.messageId,
          userMessage: ctx.content,
          workspaceDir: learningWorkspaceDir,
          initialCouncilReply: councilText,
        });
        const councilReplyText = await buildFeishuLearningCouncilReplyText({
          councilText,
          timeboxStart,
          getLearningStatusEvidence,
        });

        const councilSendResult = await sendFeishuFinalTextReply({
          replyRuntime: core.channel.reply,
          dispatcher: effectiveDispatcher,
          markDispatchIdle,
          text: councilReplyText,
        });

        clearFeishuGroupHistoryAfterDispatch({
          isGroup,
          chatHistories,
          historyKey,
          historyLimit,
        });

        await persistCapturedFeishuSurfaceLine({
          ...buildFeishuSurfaceLinePersistContext({
            cfg,
            agentId: route.agentId,
            effectiveStateSurface,
            replyContract: controlRoomOrchestration?.replyContract,
            chatId: ctx.chatId,
            sessionKey: effectiveSessionKey,
            messageId: ctx.messageId,
            userMessage: ctx.content,
            apiReplyPayloads: larkApiReplyPayloads,
          }),
          finalReplyText: surfaceLineCapture.getLastFinalReplyText(),
          dispatchQueuedFinal: councilSendResult.queuedFinal,
          dispatchFinalCount: councilSendResult.counts.final,
        });

        log(`feishu[${account.accountId}]: learning council dispatch complete`);
        return;
      }

      log(`feishu[${account.accountId}]: dispatching to agent (session=${effectiveSessionKey})`);
      const { queuedFinal, counts } = await core.channel.reply.withReplyDispatcher({
        dispatcher: effectiveDispatcher,
        onSettled: () => {
          markDispatchIdle();
        },
        run: () =>
          core.channel.reply.dispatchReplyFromConfig({
            ctx: ctxPayload,
            cfg,
            dispatcher: effectiveDispatcher,
            replyOptions,
          }),
      });

      await persistCapturedFeishuSurfaceLine({
        ...buildFeishuSurfaceLinePersistContext({
          cfg,
          agentId: route.agentId,
          effectiveStateSurface,
          replyContract: controlRoomOrchestration?.replyContract,
          chatId: ctx.chatId,
          sessionKey: effectiveSessionKey,
          messageId: ctx.messageId,
          userMessage: ctx.content,
          apiReplyPayloads: larkApiReplyPayloads,
        }),
        finalReplyText: surfaceLineCapture.getLastFinalReplyText(),
        dispatchQueuedFinal: queuedFinal,
        dispatchFinalCount: counts.final,
      });

      clearFeishuGroupHistoryAfterDispatch({
        isGroup,
        chatHistories,
        historyKey,
        historyLimit,
      });

      log(
        `feishu[${account.accountId}]: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final})`,
      );
    }
  } catch (err) {
    error(`feishu[${account.accountId}]: failed to dispatch message: ${String(err)}`);
    await recordOperationalAnomaly({
      cfg,
      category: "write_edit_failure",
      severity: "high",
      source: "feishu.dispatch",
      problem: "failed to dispatch message",
      evidence: [
        `account=${account.accountId}`,
        `message_id=${ctx.messageId}`,
        `chat_id=${ctx.chatId}`,
        `chat_type=${ctx.chatType}`,
        `error=${String(err)}`,
      ],
      impact: "the user-facing Feishu reply path failed before a final answer was delivered",
    });
  }
}
