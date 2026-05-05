import fs from "node:fs/promises";
import path from "node:path";
import type { FinanceBrainOrchestrationPlan } from "../../../src/agents/finance-brain-orchestration.js";
import type { LarkAgentInstructionHandoff } from "./lark-routing-corpus.js";
import type { FeishuChatSurfaceName } from "./surfaces.js";

export const LARK_CONTEXT_PACKET_DIR = path.join("memory", "lark-context-packets");

export type LarkContextInheritanceMode =
  | "surface_scoped"
  | "explicit_continuation_required"
  | "forbid_previous_task";

export type LarkContextPacketArtifact = {
  schemaVersion: 1;
  boundary: "lark_context_packet";
  source: "feishu_lark_context_link";
  generatedAt: string;
  agentId: string;
  chatId: string;
  messageId: string;
  sessionKey: string;
  userMessage: string;
  surfaces: {
    targetSurface?: FeishuChatSurfaceName | "protocol_truth_surface";
    effectiveSurface?: FeishuChatSurfaceName;
  };
  languageHandoff: {
    family: LarkAgentInstructionHandoff["family"];
    source: LarkAgentInstructionHandoff["source"];
    confidence: number;
    workOrderObjective?: string;
    backendTool?: string;
  };
  contextInheritance: {
    mode: LarkContextInheritanceMode;
    reason: string;
    allowedContext: readonly string[];
    blockedContext: readonly string[];
  };
  brainDispatch: {
    targetBackendTool?: string;
    requiredModules: readonly string[];
    requiredEvidence: readonly string[];
    outputContract: readonly string[];
    financeBrainOrchestration?: FinanceBrainOrchestrationPlan;
  };
  memoryPolicy: {
    languageCorpusUntouched: true;
    protectedMemoryUntouched: true;
    durableLearningWriteRequiresBackendReceipt: true;
    noExecutionApproval: true;
  };
  proof: {
    handoffReceiptPath?: string;
  };
};

export function looksLikeAmbiguousRepeatOnlyRequest(text: string): boolean {
  const compact = text
    .trim()
    .toLowerCase()
    .replace(/[\s，。,.!！?？、:：；;'"“”‘’`~\-_/\\]+/gu, "");
  return /^(重新来一遍|重来一遍|再来一遍|重新来|重来|再来一次|再跑一遍|重跑一遍|从头来|从头开始|从零开始|重新开始|别接上个任务|别接着上个任务|不要接上个任务|换个题|换一个题|换个任务|清掉上文|清空上文|清除上下文|again|doitagain|rerun|startover|startfresh|freshstart|newtask|resetcontext)$/iu.test(
    compact,
  );
}

function sanitizePacketSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 96);
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function resolveInheritance(params: {
  userMessage: string;
  handoff: LarkAgentInstructionHandoff;
}): LarkContextPacketArtifact["contextInheritance"] {
  if (
    params.handoff.family === "unknown" &&
    looksLikeAmbiguousRepeatOnlyRequest(params.userMessage)
  ) {
    return {
      mode: "forbid_previous_task",
      reason: "ambiguous_repeat_without_current_subject",
      allowedContext: ["current raw user message", "language handoff receipt"],
      blockedContext: [
        "prior topic continuation",
        "previous learning subject",
        "previous options/derivatives session state",
        "durable learning write",
        "backend tool execution",
      ],
    };
  }

  if (params.handoff.family === "unknown") {
    return {
      mode: "explicit_continuation_required",
      reason: "unknown_family_requires_fresh_subject_or_clarification",
      allowedContext: ["current raw user message", "language handoff receipt"],
      blockedContext: [
        "implicit prior task continuation",
        "durable learning write",
        "backend tool execution without validated workOrder",
      ],
    };
  }

  return {
    mode: "surface_scoped",
    reason: "validated_family_uses_surface_scoped_session_only",
    allowedContext: [
      "current raw user message",
      "validated API workOrder",
      "surface-scoped session memory",
      "audited retained artifacts relevant to the target surface",
    ],
    blockedContext: [
      "cross-surface stale topic bleed",
      "unverified chat-memory claims",
      "protected memory writes without explicit backend receipt",
    ],
  };
}

export function buildLarkContextPacketArtifact(params: {
  generatedAt: string;
  agentId: string;
  chatId: string;
  messageId: string;
  sessionKey: string;
  userMessage: string;
  targetSurface?: FeishuChatSurfaceName | "protocol_truth_surface";
  effectiveSurface?: FeishuChatSurfaceName;
  handoff: LarkAgentInstructionHandoff;
  financeBrainOrchestration?: FinanceBrainOrchestrationPlan;
  handoffReceiptPath?: string;
}): LarkContextPacketArtifact {
  return {
    schemaVersion: 1,
    boundary: "lark_context_packet",
    source: "feishu_lark_context_link",
    generatedAt: params.generatedAt,
    agentId: params.agentId,
    chatId: params.chatId,
    messageId: params.messageId,
    sessionKey: params.sessionKey,
    userMessage: params.userMessage,
    surfaces: {
      targetSurface: params.targetSurface,
      effectiveSurface: params.effectiveSurface,
    },
    languageHandoff: {
      family: params.handoff.family,
      source: params.handoff.source,
      confidence: params.handoff.confidence,
      workOrderObjective: params.handoff.workOrder?.objective,
      backendTool:
        params.handoff.backendToolContract?.toolName ?? params.handoff.workOrder?.backendTool,
    },
    contextInheritance: resolveInheritance({
      userMessage: params.userMessage,
      handoff: params.handoff,
    }),
    brainDispatch: {
      targetBackendTool:
        params.handoff.backendToolContract?.toolName ?? params.handoff.workOrder?.backendTool,
      requiredModules: params.handoff.workOrder?.requiredModules ?? [],
      requiredEvidence: params.handoff.workOrder?.evidenceRequired ?? [],
      outputContract: params.handoff.workOrder?.outputContract ?? [],
      financeBrainOrchestration: params.financeBrainOrchestration,
    },
    memoryPolicy: {
      languageCorpusUntouched: true,
      protectedMemoryUntouched: true,
      durableLearningWriteRequiresBackendReceipt: true,
      noExecutionApproval: true,
    },
    proof: {
      handoffReceiptPath: params.handoffReceiptPath,
    },
  };
}

export function renderLarkContextPacketNotice(
  packet: LarkContextPacketArtifact | undefined,
): string | undefined {
  if (!packet) {
    return undefined;
  }
  if (packet.contextInheritance.mode === "explicit_continuation_required") {
    return undefined;
  }
  return [
    "[Lark context packet]",
    `inheritanceMode=${packet.contextInheritance.mode}`,
    `inheritanceReason=${packet.contextInheritance.reason}`,
    `effectiveSurface=${packet.surfaces.effectiveSurface ?? "none"}`,
    `backendTool=${packet.brainDispatch.targetBackendTool ?? "none"}`,
    `blockedContext=${packet.contextInheritance.blockedContext.join(",") || "none"}`,
    "Execution rule: use only allowedContext; if inheritanceMode is forbid_previous_task or explicit_continuation_required, ask for a concrete subject instead of continuing an old task.",
  ].join("\n");
}

export async function writeLarkContextPacket(params: {
  workspaceDir: string;
  generatedAt?: string;
  agentId: string;
  chatId: string;
  messageId: string;
  sessionKey: string;
  userMessage: string;
  targetSurface?: FeishuChatSurfaceName | "protocol_truth_surface";
  effectiveSurface?: FeishuChatSurfaceName;
  handoff: LarkAgentInstructionHandoff;
  financeBrainOrchestration?: FinanceBrainOrchestrationPlan;
  handoffReceiptPath?: string;
}): Promise<{ relativePath: string; artifact: LarkContextPacketArtifact }> {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const dateKey = generatedAt.slice(0, 10);
  const fileName = `${sanitizePacketSegment(params.messageId) || "message"}.json`;
  const relativePath = normalizeRelativePath(path.join(LARK_CONTEXT_PACKET_DIR, dateKey, fileName));
  const artifact = buildLarkContextPacketArtifact({
    ...params,
    generatedAt,
  });
  const absolutePath = path.join(params.workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return { relativePath, artifact };
}
