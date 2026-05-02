import fs from "node:fs/promises";
import path from "node:path";
import {
  planFinanceBrainOrchestration,
  type FinanceBrainOrchestrationPlan,
} from "../../../src/agents/finance-brain-orchestration.js";
import type { LarkAgentInstructionHandoff } from "./lark-routing-corpus.js";
import type { FeishuChatSurfaceName } from "./surfaces.js";

export const LARK_LANGUAGE_HANDOFF_RECEIPT_DIR = path.join(
  "memory",
  "lark-language-handoff-receipts",
);

export type LarkLanguageHandoffReceiptArtifact = {
  schemaVersion: 1;
  boundary: "language_handoff_only";
  source: "feishu_lark_instruction_handoff";
  generatedAt: string;
  agentId: string;
  targetSurface?: FeishuChatSurfaceName;
  effectiveSurface?: FeishuChatSurfaceName;
  chatId: string;
  sessionKey: string;
  messageId: string;
  userMessage: string;
  noFinanceLearningArtifact: true;
  noExecutionApproval: true;
  noLiveProbeProof: true;
  financeBrainOrchestration?: FinanceBrainOrchestrationPlan;
  handoff: {
    family: LarkAgentInstructionHandoff["family"];
    source: LarkAgentInstructionHandoff["source"];
    confidence: number;
    targetSurface?: LarkAgentInstructionHandoff["targetSurface"];
    deterministicSurface?: LarkAgentInstructionHandoff["deterministicSurface"];
    backendToolContract?: LarkAgentInstructionHandoff["backendToolContract"];
    apiCandidate?: LarkAgentInstructionHandoff["apiCandidate"];
    expectedProof: readonly string[];
    missingBeforeExecution: readonly string[];
  };
};

export function renderLarkFinanceBrainOrchestrationNotice(
  plan: FinanceBrainOrchestrationPlan | undefined,
): string | undefined {
  if (!plan || (plan.primaryModules.length === 0 && plan.supportingModules.length === 0)) {
    return undefined;
  }
  return [
    "[Finance brain orchestration contract]",
    `primaryModules=${plan.primaryModules.join(",") || "none"}`,
    `supportingModules=${plan.supportingModules.join(",") || "none"}`,
    `requiredTools=${plan.requiredTools.join(",") || "none"}`,
    `reviewTools=${plan.reviewTools.join(",") || "none"}`,
    `boundaries=${plan.boundaries.join(",") || "none"}`,
    "Use this as an execution expectation for finance/math market tasks: prefer local deterministic tools for calculations, do not replace quant_math with model guesses, keep research_only/no_execution_authority, and if fresh inputs are unavailable state the missing inputs instead of giving pseudo-precise results.",
  ].join("\n");
}

function sanitizeReceiptSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 96);
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function resolveExpectedProof(handoff: LarkAgentInstructionHandoff): readonly string[] {
  return handoff.backendToolContract?.expectedProof ?? [];
}

function resolveMissingBeforeExecution(handoff: LarkAgentInstructionHandoff): readonly string[] {
  if (!handoff.backendToolContract) {
    return [];
  }
  switch (handoff.backendToolContract.sourceRequirement) {
    case "safe_local_or_manual_source_required":
      return ["safe local/manual source artifact or pasted source text"];
    case "repo_url_or_readme_summary_required":
      return ["repo URL, README/docs summary, or selected feature summary"];
  }
}

function hasFinanceBrainOrchestrationSignal(params: {
  userMessage: string;
  handoff: LarkAgentInstructionHandoff;
}): boolean {
  const plan = planFinanceBrainOrchestration({
    text: params.userMessage,
    hasHoldingsOrPortfolioContext:
      params.handoff.family === "position_risk_adjustment" ||
      params.handoff.family === "bracket_exit_plan",
    hasLocalMathInputs: /数学|计算|math|calculate|beta|volatility|covariance|回撤|夏普/iu.test(
      params.userMessage,
    ),
    highStakesConclusion:
      params.handoff.family === "position_risk_adjustment" ||
      params.handoff.family === "trading_execution_boundary" ||
      params.handoff.family === "trading_execution_order",
  });
  return plan.primaryModules.length > 0 || plan.supportingModules.length > 0;
}

function resolveFinanceBrainOrchestration(params: {
  userMessage: string;
  handoff: LarkAgentInstructionHandoff;
}): FinanceBrainOrchestrationPlan | undefined {
  if (!hasFinanceBrainOrchestrationSignal(params)) {
    return undefined;
  }
  return planFinanceBrainOrchestration({
    text: params.userMessage,
    hasHoldingsOrPortfolioContext:
      params.handoff.family === "position_risk_adjustment" ||
      params.handoff.family === "bracket_exit_plan",
    hasLocalMathInputs: /数学|计算|math|calculate|beta|volatility|covariance|回撤|夏普/iu.test(
      params.userMessage,
    ),
    highStakesConclusion:
      params.handoff.family === "position_risk_adjustment" ||
      params.handoff.family === "trading_execution_boundary" ||
      params.handoff.family === "trading_execution_order",
  });
}

export function buildLarkLanguageHandoffReceiptArtifact(params: {
  generatedAt: string;
  agentId: string;
  targetSurface?: FeishuChatSurfaceName;
  effectiveSurface?: FeishuChatSurfaceName;
  chatId: string;
  sessionKey: string;
  messageId: string;
  userMessage: string;
  handoff: LarkAgentInstructionHandoff;
}): LarkLanguageHandoffReceiptArtifact {
  const financeBrainOrchestration = resolveFinanceBrainOrchestration({
    userMessage: params.userMessage,
    handoff: params.handoff,
  });
  return {
    schemaVersion: 1,
    boundary: "language_handoff_only",
    source: "feishu_lark_instruction_handoff",
    generatedAt: params.generatedAt,
    agentId: params.agentId,
    targetSurface: params.targetSurface,
    effectiveSurface: params.effectiveSurface,
    chatId: params.chatId,
    sessionKey: params.sessionKey,
    messageId: params.messageId,
    userMessage: params.userMessage,
    noFinanceLearningArtifact: true,
    noExecutionApproval: true,
    noLiveProbeProof: true,
    ...(financeBrainOrchestration ? { financeBrainOrchestration } : {}),
    handoff: {
      family: params.handoff.family,
      source: params.handoff.source,
      confidence: params.handoff.confidence,
      targetSurface: params.handoff.targetSurface,
      deterministicSurface: params.handoff.deterministicSurface,
      backendToolContract: params.handoff.backendToolContract,
      apiCandidate: params.handoff.apiCandidate,
      expectedProof: resolveExpectedProof(params.handoff),
      missingBeforeExecution: resolveMissingBeforeExecution(params.handoff),
    },
  };
}

export async function writeLarkLanguageHandoffReceipt(params: {
  workspaceDir: string;
  generatedAt?: string;
  agentId: string;
  targetSurface?: FeishuChatSurfaceName;
  effectiveSurface?: FeishuChatSurfaceName;
  chatId: string;
  sessionKey: string;
  messageId: string;
  userMessage: string;
  handoff: LarkAgentInstructionHandoff;
}): Promise<{ relativePath: string; artifact: LarkLanguageHandoffReceiptArtifact }> {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const dateKey = generatedAt.slice(0, 10);
  const fileName = `${sanitizeReceiptSegment(params.messageId) || "message"}.json`;
  const relativePath = normalizeRelativePath(
    path.join(LARK_LANGUAGE_HANDOFF_RECEIPT_DIR, dateKey, fileName),
  );
  const artifact = buildLarkLanguageHandoffReceiptArtifact({
    generatedAt,
    agentId: params.agentId,
    targetSurface: params.targetSurface,
    effectiveSurface: params.effectiveSurface,
    chatId: params.chatId,
    sessionKey: params.sessionKey,
    messageId: params.messageId,
    userMessage: params.userMessage,
    handoff: params.handoff,
  });
  const absolutePath = path.join(params.workspaceDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return { relativePath, artifact };
}
