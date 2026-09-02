import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatAllowFromLowercase,
  missingTargetError,
  resolveChannelAccountConfigBasePath,
  setAccountEnabledInConfigSection,
  type ChannelAccountSnapshot,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  listExternalAccountIds,
  resolveDefaultExternalAccountId,
  resolveExternalAccount,
} from "./accounts.js";
import { ExternalConfigSchema } from "./config-schema.js";
import { processExternalMessage, registerExternalWebhookTarget } from "./monitor.js";
import { normalizeExternalTarget } from "./protocol.js";
import { sendExternalMessage } from "./send.js";
import type { ExternalInboundMessage, ResolvedExternalAccount } from "./types.js";

const CHANNEL_ID = "external";
const DEFAULT_WEBHOOK_PATH = "/external/messages";

const meta = {
  id: CHANNEL_ID,
  label: "External",
  selectionLabel: "External (HTTP JSON)",
  detailLabel: "External HTTP channel",
  docsPath: "/channels/external",
  docsLabel: "external",
  blurb: "Vendor-neutral inbound webhook and outbound HTTP JSON messaging.",
  order: 35,
  quickstartAllowFrom: true,
};

function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal || signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function resolveGroupRequireMention(account: ResolvedExternalAccount, groupId?: string | null) {
  if (!groupId) {
    return false;
  }
  return account.groups[groupId]?.requireMention ?? account.groups["*"]?.requireMention ?? false;
}

function normalizeAllowEntry(entry: string): string {
  return entry.trim().toLowerCase();
}

function describeAccount(account: ResolvedExternalAccount): ChannelAccountSnapshot {
  return {
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured: account.configured,
    running: false,
    webhookPath: account.webhookPath,
    webhookUrl: account.outboundUrl || undefined,
    mode: "webhook-http",
    dmPolicy: account.dmPolicy,
    allowFrom: account.allowFrom.map(String),
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  };
}

export const externalChannelPlugin: ChannelPlugin<ResolvedExternalAccount> = {
  id: CHANNEL_ID,
  meta,
  capabilities: {
    chatTypes: ["direct", "group", "channel"],
    media: true,
    threads: true,
    reply: true,
    reactions: false,
    edit: false,
    unsend: false,
    effects: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  configSchema: buildChannelConfigSchema(ExternalConfigSchema),
  config: {
    listAccountIds: (cfg) => listExternalAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveExternalAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultExternalAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: CHANNEL_ID,
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: CHANNEL_ID,
        accountId,
        clearBaseFields: ["webhookPath", "inboundToken", "outboundUrl", "outboundToken", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount,
    resolveAllowFrom: ({ cfg, accountId }) => resolveExternalAccount({ cfg, accountId }).allowFrom,
    formatAllowFrom: ({ allowFrom }) =>
      formatAllowFromLowercase({
        allowFrom,
      }),
    resolveDefaultTo: ({ cfg, accountId }) => resolveExternalAccount({ cfg, accountId }).defaultTo,
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const basePath = resolveChannelAccountConfigBasePath({
        cfg,
        channelKey: CHANNEL_ID,
        accountId: resolvedAccountId,
      });
      return {
        policy: account.dmPolicy,
        allowFrom: account.allowFrom,
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: 'configure channels.external.allowFrom or set dmPolicy="open"',
        normalizeEntry: normalizeAllowEntry,
      };
    },
    collectWarnings: ({ account }) => {
      const warnings: string[] = [];
      if (account.inboundAuth === "token" && !account.inboundToken) {
        warnings.push(
          "- External channel: inbound token authentication is enabled but no token is configured.",
        );
      }
      if (!account.outboundUrl) {
        warnings.push("- External channel: outboundUrl is not configured; replies cannot be sent.");
      }
      if (account.outboundAuth !== "none" && !account.outboundToken) {
        warnings.push(
          "- External channel: outbound authentication is enabled but no token is configured.",
        );
      }
      if (account.dmPolicy === "allowlist" && account.allowFrom.length === 0) {
        warnings.push(
          '- External channel: dmPolicy="allowlist" with no allowFrom blocks direct messages.',
        );
      }
      if (account.groupPolicy === "allowlist" && Object.keys(account.groups).length === 0) {
        warnings.push(
          '- External channel: groupPolicy="allowlist" with no groups blocks group messages.',
        );
      }
      return warnings;
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) =>
      resolveGroupRequireMention(resolveExternalAccount({ cfg, accountId }), groupId),
  },
  messaging: {
    normalizeTarget: normalizeExternalTarget,
    targetResolver: {
      looksLikeId: (raw, normalized) => Boolean(normalized ?? raw.trim()),
      hint: "<conversationId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveExternalAccount({ cfg, accountId });
      const filter = query?.trim().toLowerCase() ?? "";
      return account.allowFrom
        .map(String)
        .filter((id) => id !== "*" && (!filter || id.toLowerCase().includes(filter)))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveExternalAccount({ cfg, accountId });
      const filter = query?.trim().toLowerCase() ?? "";
      return Object.keys(account.groups)
        .filter((id) => id !== "*" && (!filter || id.toLowerCase().includes(filter)))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id }) as const);
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4_000,
    resolveTarget: ({ to }) => {
      const normalized = to ? normalizeExternalTarget(to) : undefined;
      return normalized
        ? { ok: true, to: normalized }
        : { ok: false, error: missingTargetError(CHANNEL_ID, "<conversationId>") };
    },
    sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) =>
      await sendExternalMessage({
        account: resolveExternalAccount({ cfg, accountId }),
        target: to,
        text,
        replyToId,
        threadId,
      }),
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId, threadId }) =>
      await sendExternalMessage({
        account: resolveExternalAccount({ cfg, accountId }),
        target: to,
        text,
        mediaUrls: mediaUrl ? [mediaUrl] : undefined,
        replyToId,
        threadId,
      }),
    sendPayload: async ({ cfg, to, payload, accountId, replyToId, threadId }) =>
      await sendExternalMessage({
        account: resolveExternalAccount({ cfg, accountId }),
        target: to,
        text: payload.text ?? "",
        mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : undefined),
        replyToId: payload.replyToId ?? replyToId,
        threadId,
      }),
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      mode: "webhook-http",
      webhookPath: snapshot.webhookPath ?? DEFAULT_WEBHOOK_PATH,
      outboundUrl: snapshot.webhookUrl ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      ...describeAccount(account),
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.enabled) {
        ctx.log?.info(`[${account.accountId}] external account disabled`);
        await waitForAbort(ctx.abortSignal);
        return;
      }
      if (!account.configured) {
        ctx.log?.warn(
          `[${account.accountId}] external channel is not configured; set inbound/outbound HTTP settings`,
        );
        await waitForAbort(ctx.abortSignal);
        return;
      }
      if (!ctx.channelRuntime) {
        ctx.log?.warn(`[${account.accountId}] external channel runtime is unavailable`);
        await waitForAbort(ctx.abortSignal);
        return;
      }

      const unregister = registerExternalWebhookTarget({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        channelRuntime: ctx.channelRuntime,
        path: account.webhookPath,
        log: ctx.log,
        statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
      });
      ctx.setStatus({
        accountId: account.accountId,
        enabled: true,
        configured: true,
        running: true,
        webhookPath: account.webhookPath,
        lastStartAt: Date.now(),
      });
      ctx.log?.info(`[${account.accountId}] external webhook listening on ${account.webhookPath}`);
      await waitForAbort(ctx.abortSignal);
      unregister();
      ctx.setStatus({
        accountId: account.accountId,
        running: false,
        lastStopAt: Date.now(),
      });
    },
  },
  agentPrompt: {
    messageToolHints: () => [
      "The external channel uses conversation IDs as targets and supports plain text, reply IDs, thread IDs, and media URLs.",
    ],
  },
};

export { processExternalMessage };
