import type { OpenClawConfig } from "../config/config.js";
import { resolvePluginTools } from "../plugins/tools.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import { createAiderTool } from "./tools/aider-tool.js";
import { createBrowserTool } from "./tools/browser-tool.js";
import { createCanvasTool } from "./tools/canvas-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createFinanceArticleExtractCapabilityInputTool } from "./tools/finance-article-extract-capability-input-tool.js";
import { createFinanceArticleSourceCollectionPreflightTool } from "./tools/finance-article-source-collection-preflight-tool.js";
import { createFinanceArticleSourceRegistryInspectTool } from "./tools/finance-article-source-registry-inspect-tool.js";
import { createFinanceArticleSourceRegistryRecordTool } from "./tools/finance-article-source-registry-record-tool.js";
import { createFinanceDoctrineTeacherFeedbackCandidateInputReconciliationStatusTool } from "./tools/finance-doctrine-teacher-feedback-candidate-input-reconciliation-status-tool.js";
import { createFinanceDoctrineTeacherFeedbackCandidateInputReconciliationTool } from "./tools/finance-doctrine-teacher-feedback-candidate-input-reconciliation-tool.js";
import { createFinanceDoctrineTeacherFeedbackCandidateInputReviewTool } from "./tools/finance-doctrine-teacher-feedback-candidate-input-review-tool.js";
import { createFinanceDoctrineTeacherFeedbackCandidateInputTool } from "./tools/finance-doctrine-teacher-feedback-candidate-input-tool.js";
import { createFinanceDoctrineTeacherFeedbackElevationHandoffStatusTool } from "./tools/finance-doctrine-teacher-feedback-elevation-handoff-status-tool.js";
import { createFinanceDoctrineTeacherFeedbackElevationHandoffTool } from "./tools/finance-doctrine-teacher-feedback-elevation-handoff-tool.js";
import { createFinanceDoctrineTeacherFeedbackReviewTool } from "./tools/finance-doctrine-teacher-feedback-review-tool.js";
import { createFinanceDoctrineTeacherFeedbackTool } from "./tools/finance-doctrine-teacher-feedback-tool.js";
import { createFinanceExternalSourceAdapterTool } from "./tools/finance-external-source-adapter-tool.js";
import { createFinanceFrameworkCoreInspectTool } from "./tools/finance-framework-core-inspect-tool.js";
import { createFinanceFrameworkCoreRecordTool } from "./tools/finance-framework-core-record-tool.js";
import { createFinanceFrameworkDomainProducerTools } from "./tools/finance-framework-domain-producer-tools.js";
import { createFinanceLearningCapabilityApplyTool } from "./tools/finance-learning-capability-apply-tool.js";
import { createFinanceLearningCapabilityAttachTool } from "./tools/finance-learning-capability-attach-tool.js";
import { createFinanceLearningCapabilityInspectTool } from "./tools/finance-learning-capability-inspect-tool.js";
import { createFinanceLearningPipelineOrchestratorTool } from "./tools/finance-learning-pipeline-orchestrator-tool.js";
import { createFinanceLearningRetrievalReviewTool } from "./tools/finance-learning-retrieval-review-tool.js";
import { createFinancePromotionBulkReviewTool } from "./tools/finance-promotion-bulk-review-tool.js";
import { createFinancePromotionCandidatesTool } from "./tools/finance-promotion-candidates-tool.js";
import { createFinancePromotionDecisionTool } from "./tools/finance-promotion-decision-tool.js";
import { createFinancePromotionDoctrineEditHandoffTool } from "./tools/finance-promotion-doctrine-edit-handoff-tool.js";
import { createFinancePromotionProposalDraftTool } from "./tools/finance-promotion-proposal-draft-tool.js";
import { createFinancePromotionProposalStatusTool } from "./tools/finance-promotion-proposal-status-tool.js";
import { createFinancePromotionReviewTool } from "./tools/finance-promotion-review-tool.js";
import { createFinanceResearchSourceWorkbenchTool } from "./tools/finance-research-source-workbench-tool.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createGitHubProjectCapabilityIntakeTool } from "./tools/github-project-capability-intake-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createLobsterWorkfaceAppTool } from "./tools/lobster-workface-app-tool.js";
import { createLocalMemoryRecordTool } from "./tools/local-memory-record-tool.js";
import { createMcpContextTool } from "./tools/mcp-context-tool.js";
import { createMessageTool } from "./tools/message-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createPdfTool } from "./tools/pdf-tool.js";
import { createQuantMathTool } from "./tools/quant-math-tool.js";
import { createReviewPanelTool } from "./tools/review-panel-tool.js";
import { createReviewTierTool } from "./tools/review-tier-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";
import { createTtsTool } from "./tools/tts-tool.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

function createLazyTool(params: {
  name: string;
  label: string;
  description: string;
  parameters?: Record<string, unknown>;
  load: () => Promise<AnyAgentTool>;
}): AnyAgentTool {
  return {
    name: params.name,
    label: params.label,
    description: params.description,
    parameters: params.parameters ?? {},
    execute: async (toolCallId, args) => {
      const tool = await params.load();
      return tool.execute(toolCallId, args);
    },
  } as AnyAgentTool;
}

function createLazyFeishuLiveProbeTool(options?: {
  workspaceDir?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return createLazyTool({
    name: "feishu_live_probe",
    label: "Feishu Live Probe",
    description:
      "Send a bounded Feishu/Lark live acceptance probe and write a receipt under memory/feishu-live-probes.",
    parameters: {
      type: "object",
      properties: {
        surface: {
          type: "string",
          enum: [
            "control_room",
            "technical_daily",
            "fundamental_research",
            "knowledge_maintenance",
            "ops_audit",
            "learning_command",
            "watchtower",
          ],
        },
        chatId: { type: "string" },
        message: { type: "string" },
        waitMs: { type: "number" },
        limit: { type: "number" },
        mustContainAny: { type: "array", items: { type: "string" } },
        mustNotContain: { type: "array", items: { type: "string" } },
        writeReceipt: { type: "boolean" },
        accountId: { type: "string" },
      },
      required: ["message"],
      additionalProperties: false,
    },
    load: async () => {
      const modulePath = "./tools/feishu-live-probe-tool.js";
      const mod = (await import(modulePath)) as {
        createFeishuLiveProbeTool: (options?: {
          workspaceDir?: string;
          config?: OpenClawConfig;
        }) => AnyAgentTool;
      };
      return mod.createFeishuLiveProbeTool(options);
    },
  });
}

function createLazyLarkLanguageCorpusReviewTool(options?: { workspaceDir?: string }): AnyAgentTool {
  return createLazyTool({
    name: "lark_language_corpus_review",
    label: "Lark Language Corpus Review",
    description:
      "Review pending Lark language-routing candidate artifacts without mutating the formal routing corpus.",
    parameters: {
      type: "object",
      properties: {
        dateKey: { type: "string" },
        rootDir: { type: "string" },
        minAcceptedPerFamily: { type: "number" },
        maxFiles: { type: "number" },
        writeReview: { type: "boolean" },
      },
      additionalProperties: false,
    },
    load: async () => {
      const modulePath = "./tools/lark-language-corpus-review-tool.js";
      const mod = (await import(modulePath)) as {
        createLarkLanguageCorpusReviewTool: (options?: { workspaceDir?: string }) => AnyAgentTool;
      };
      return mod.createLarkLanguageCorpusReviewTool(options);
    },
  });
}

export function createOpenClawTools(options?: {
  sandboxBrowserBridgeUrl?: string;
  allowHostBrowserControl?: boolean;
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  /** Delivery target (e.g. telegram:group:123:topic:456) for topic/thread routing. */
  agentTo?: string;
  /** Thread/topic identifier for routing replies to the originating thread. */
  agentThreadId?: string | number;
  /** Group id for channel-level tool policy inheritance. */
  agentGroupId?: string | null;
  /** Group channel label for channel-level tool policy inheritance. */
  agentGroupChannel?: string | null;
  /** Group space label for channel-level tool policy inheritance. */
  agentGroupSpace?: string | null;
  agentDir?: string;
  sandboxRoot?: string;
  sandboxFsBridge?: SandboxFsBridge;
  fsPolicy?: ToolFsPolicy;
  workspaceDir?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  pluginToolAllowlist?: string[];
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Current inbound message id for action fallbacks (e.g. Telegram react). */
  currentMessageId?: string | number;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
  /** If true, the model has native vision capability */
  modelHasVision?: boolean;
  /** Explicit agent ID override for cron/hook sessions. */
  requesterAgentIdOverride?: string;
  /** Require explicit message targets (no implicit last-route sends). */
  requireExplicitMessageTarget?: boolean;
  /** If true, omit the message tool from the tool list. */
  disableMessageTool?: boolean;
  /** Trusted sender id from inbound context (not tool args). */
  requesterSenderId?: string | null;
  /** Whether the requesting sender is an owner. */
  senderIsOwner?: boolean;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
}): AnyAgentTool[] {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  const imageTool = options?.agentDir?.trim()
    ? createImageTool({
        config: options?.config,
        agentDir: options.agentDir,
        workspaceDir,
        sandbox:
          options?.sandboxRoot && options?.sandboxFsBridge
            ? { root: options.sandboxRoot, bridge: options.sandboxFsBridge }
            : undefined,
        fsPolicy: options?.fsPolicy,
        modelHasVision: options?.modelHasVision,
      })
    : null;
  const pdfTool = options?.agentDir?.trim()
    ? createPdfTool({
        config: options?.config,
        agentDir: options.agentDir,
        workspaceDir,
        sandbox:
          options?.sandboxRoot && options?.sandboxFsBridge
            ? { root: options.sandboxRoot, bridge: options.sandboxFsBridge }
            : undefined,
        fsPolicy: options?.fsPolicy,
      })
    : null;
  const webSearchTool = createWebSearchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
  });
  const webFetchTool = createWebFetchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
  });
  const messageTool = options?.disableMessageTool
    ? null
    : createMessageTool({
        agentAccountId: options?.agentAccountId,
        agentSessionKey: options?.agentSessionKey,
        config: options?.config,
        currentChannelId: options?.currentChannelId,
        currentChannelProvider: options?.agentChannel,
        currentThreadTs: options?.currentThreadTs,
        currentMessageId: options?.currentMessageId,
        replyToMode: options?.replyToMode,
        hasRepliedRef: options?.hasRepliedRef,
        sandboxRoot: options?.sandboxRoot,
        requireExplicitTarget: options?.requireExplicitMessageTarget,
        requesterSenderId: options?.requesterSenderId ?? undefined,
      });
  const tools: AnyAgentTool[] = [
    createBrowserTool({
      sandboxBridgeUrl: options?.sandboxBrowserBridgeUrl,
      allowHostControl: options?.allowHostBrowserControl,
    }),
    createCanvasTool({ config: options?.config }),
    createNodesTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      currentChannelId: options?.currentChannelId,
      currentThreadTs: options?.currentThreadTs,
      config: options?.config,
    }),
    createCronTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    ...(messageTool ? [messageTool] : []),
    createTtsTool({
      agentChannel: options?.agentChannel,
      config: options?.config,
    }),
    createGatewayTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    createQuantMathTool(),
    createReviewTierTool(),
    createReviewPanelTool({
      workspaceDir,
    }),
    createLocalMemoryRecordTool({
      workspaceDir,
    }),
    createFinanceFrameworkCoreRecordTool({
      workspaceDir,
    }),
    createFinanceFrameworkCoreInspectTool({
      workspaceDir,
    }),
    createFinanceArticleSourceRegistryRecordTool({
      workspaceDir,
    }),
    createFinanceArticleSourceCollectionPreflightTool({
      workspaceDir,
    }),
    createFinanceArticleSourceRegistryInspectTool({
      workspaceDir,
    }),
    createFinanceExternalSourceAdapterTool({
      workspaceDir,
    }),
    createFinanceLearningPipelineOrchestratorTool({
      workspaceDir,
    }),
    createFinanceLearningRetrievalReviewTool({
      workspaceDir,
    }),
    createFinanceResearchSourceWorkbenchTool({
      workspaceDir,
    }),
    createFinanceArticleExtractCapabilityInputTool({
      workspaceDir,
    }),
    createFinanceLearningCapabilityAttachTool({
      workspaceDir,
    }),
    createFinanceLearningCapabilityInspectTool({
      workspaceDir,
    }),
    createFinanceLearningCapabilityApplyTool({
      workspaceDir,
    }),
    createGitHubProjectCapabilityIntakeTool({
      workspaceDir,
    }),
    ...createFinanceFrameworkDomainProducerTools({
      workspaceDir,
    }),
    createFinancePromotionCandidatesTool({
      workspaceDir,
    }),
    createFinanceDoctrineTeacherFeedbackTool({
      workspaceDir,
      config: options?.config,
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    createFinanceDoctrineTeacherFeedbackReviewTool({
      workspaceDir,
    }),
    createFinanceDoctrineTeacherFeedbackElevationHandoffTool({
      workspaceDir,
    }),
    createFinanceDoctrineTeacherFeedbackElevationHandoffStatusTool({
      workspaceDir,
    }),
    createFinanceDoctrineTeacherFeedbackCandidateInputTool({
      workspaceDir,
    }),
    createFinanceDoctrineTeacherFeedbackCandidateInputReviewTool({
      workspaceDir,
    }),
    createFinanceDoctrineTeacherFeedbackCandidateInputReconciliationTool({
      workspaceDir,
    }),
    createFinanceDoctrineTeacherFeedbackCandidateInputReconciliationStatusTool({
      workspaceDir,
    }),
    createFinancePromotionBulkReviewTool({
      workspaceDir,
    }),
    createFinancePromotionDecisionTool({
      workspaceDir,
    }),
    createFinancePromotionProposalDraftTool({
      workspaceDir,
    }),
    createFinancePromotionProposalStatusTool({
      workspaceDir,
    }),
    createFinancePromotionDoctrineEditHandoffTool({
      workspaceDir,
    }),
    createFinancePromotionReviewTool({
      workspaceDir,
    }),
    createLazyFeishuLiveProbeTool({
      workspaceDir,
      config: options?.config,
    }),
    createLazyLarkLanguageCorpusReviewTool({
      workspaceDir,
    }),
    createLobsterWorkfaceAppTool({
      workspaceDir,
    }),
    createMcpContextTool({
      config: options?.config,
      workspaceDir,
    }),
    createAiderTool({
      workspaceDir,
    }),
    createAgentsListTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    createSessionsListTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
    }),
    createSessionsSendTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      sandboxed: options?.sandboxed,
    }),
    createSessionsSpawnTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      agentTo: options?.agentTo,
      agentThreadId: options?.agentThreadId,
      agentGroupId: options?.agentGroupId,
      agentGroupChannel: options?.agentGroupChannel,
      agentGroupSpace: options?.agentGroupSpace,
      sandboxed: options?.sandboxed,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    createSubagentsTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    createSessionStatusTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    ...(webSearchTool ? [webSearchTool] : []),
    ...(webFetchTool ? [webFetchTool] : []),
    ...(imageTool ? [imageTool] : []),
    ...(pdfTool ? [pdfTool] : []),
  ];

  const pluginTools = resolvePluginTools({
    context: {
      config: options?.config,
      workspaceDir,
      agentDir: options?.agentDir,
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
      sessionKey: options?.agentSessionKey,
      sessionId: options?.sessionId,
      messageChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      requesterSenderId: options?.requesterSenderId ?? undefined,
      senderIsOwner: options?.senderIsOwner ?? undefined,
      sandboxed: options?.sandboxed,
    },
    existingToolNames: new Set(tools.map((tool) => tool.name)),
    toolAllowlist: options?.pluginToolAllowlist,
  });

  return [...tools, ...pluginTools];
}
