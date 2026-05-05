import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempWorkspace } from "../../../src/test-helpers/workspace.js";
import {
  looksLikeAmbiguousRepeatOnlyRequest,
  renderLarkContextPacketNotice,
  writeLarkContextPacket,
} from "./lark-context-packet.js";

describe("lark context packets", () => {
  let workspaceDir: string | undefined;

  afterEach(async () => {
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = undefined;
    }
  });

  it("treats reset and old-context blocking synonyms as ambiguous repeat-only requests", () => {
    const positiveCases = [
      "重新来一遍",
      "从头开始",
      "清除上下文",
      "别接上个任务",
      "换个题",
      "fresh start",
      "reset context",
      "new task",
    ];

    for (const phrase of positiveCases) {
      expect(looksLikeAmbiguousRepeatOnlyRequest(phrase), phrase).toBe(true);
    }

    expect(looksLikeAmbiguousRepeatOnlyRequest("重新分析 QQQ 和 TLT 的风险切换")).toBe(false);
    expect(looksLikeAmbiguousRepeatOnlyRequest("继续学习 ETF 风控")).toBe(false);
  });

  it("forbids previous-task inheritance for ambiguous repeat-only unknown handoffs", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-lark-context-packet-");

    const result = await writeLarkContextPacket({
      workspaceDir,
      generatedAt: "2026-05-04T12:00:00.000Z",
      agentId: "main",
      chatId: "oc-control",
      messageId: "om_repeat",
      sessionKey: "agent:main:feishu:control_room",
      userMessage: "重新来一遍",
      targetSurface: "control_room",
      effectiveSurface: "control_room",
      handoff: {
        family: "unknown",
        source: "unknown",
        confidence: 0.2,
        apiCandidate: {
          family: "unknown",
          confidence: 0.2,
          rationale: "No safe prior task context.",
        },
        notice: "handoff",
      },
      handoffReceiptPath: "memory/lark-language-handoff-receipts/2026-05-04/om_repeat.json",
    });

    expect(result.relativePath).toBe("memory/lark-context-packets/2026-05-04/om_repeat.json");
    expect(result.artifact.contextInheritance).toMatchObject({
      mode: "forbid_previous_task",
      reason: "ambiguous_repeat_without_current_subject",
      blockedContext: expect.arrayContaining([
        "prior topic continuation",
        "previous learning subject",
        "previous options/derivatives session state",
        "backend tool execution",
      ]),
    });
    expect(result.artifact.memoryPolicy).toMatchObject({
      languageCorpusUntouched: true,
      protectedMemoryUntouched: true,
      durableLearningWriteRequiresBackendReceipt: true,
      noExecutionApproval: true,
    });

    const notice = renderLarkContextPacketNotice(result.artifact);
    expect(notice).toContain("inheritanceMode=forbid_previous_task");
    expect(notice).toContain("ambiguous_repeat_without_current_subject");
    expect(notice).toContain("ask for a concrete subject instead of continuing an old task");

    const written = await fs.readFile(path.join(workspaceDir, result.relativePath), "utf8");
    expect(written).toContain('"boundary": "lark_context_packet"');
    expect(written).toContain('"previous options/derivatives session state"');
  });

  it("keeps validated finance handoffs surface-scoped and linked to brain dispatch", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-lark-context-packet-finance-");

    const result = await writeLarkContextPacket({
      workspaceDir,
      generatedAt: "2026-05-04T12:30:00.000Z",
      agentId: "main",
      chatId: "oc-control",
      messageId: "om_finance",
      sessionKey: "agent:main:feishu:learning_command",
      userMessage: "学习一套 ETF 因子择时方法，最后给 application_ready 或 failedReason",
      targetSurface: "learning_command",
      effectiveSurface: "learning_command",
      handoff: {
        family: "market_capability_learning_intake",
        source: "api",
        confidence: 0.93,
        targetSurface: "learning_command",
        backendToolContract: {
          toolName: "finance_learning_pipeline_orchestrator",
          learningIntent: "学习一套 ETF 因子择时方法，最后给 application_ready 或 failedReason",
          sourceRequirement: "safe_local_or_manual_source_required",
          expectedProof: ["retrievalReceiptPath", "retrievalReviewPath"],
        },
        workOrder: {
          schemaVersion: 1,
          family: "market_capability_learning_intake",
          targetSurface: "learning_command",
          objective: "internalize a reusable ETF timing capability",
          source: "api_planner_audited",
          plannerFamily: "market_capability_learning_intake",
          requiredModules: ["finance_learning_memory", "causal_map"],
          backendTool: "finance_learning_pipeline_orchestrator",
          evidenceRequired: ["safe local source", "retrieval review"],
          safetyBoundaries: ["research_only"],
          outputContract: ["application_ready or failedReason"],
          validation: {
            apiFamilyAccepted: true,
            familyContractMatched: true,
            deterministicSurface: "learning_command",
            notes: ["api workOrder accepted"],
          },
        },
        notice: "handoff",
      },
      financeBrainOrchestration: {
        primaryModules: ["etf_regime", "causal_map"],
        supportingModules: ["finance_learning_memory"],
        requiredTools: ["finance_learning_capability_apply", "review_tier"],
        reviewTools: ["review_tier"],
        handoffOrder: ["language_intake", "finance_learning_memory", "control_room_summary"],
        boundaries: ["research_only", "no_execution_authority"],
      },
      handoffReceiptPath: "memory/lark-language-handoff-receipts/2026-05-04/om_finance.json",
    });

    expect(result.artifact.contextInheritance).toMatchObject({
      mode: "surface_scoped",
      reason: "validated_family_uses_surface_scoped_session_only",
      blockedContext: expect.arrayContaining(["cross-surface stale topic bleed"]),
    });
    expect(result.artifact.brainDispatch).toMatchObject({
      targetBackendTool: "finance_learning_pipeline_orchestrator",
      requiredModules: ["finance_learning_memory", "causal_map"],
      requiredEvidence: ["safe local source", "retrieval review"],
      outputContract: ["application_ready or failedReason"],
      financeBrainOrchestration: {
        primaryModules: ["etf_regime", "causal_map"],
      },
    });
  });

  it("persists unknown continuation packets without injecting a model-facing notice", async () => {
    workspaceDir = await makeTempWorkspace("openclaw-lark-context-packet-unknown-");

    const result = await writeLarkContextPacket({
      workspaceDir,
      generatedAt: "2026-05-04T13:00:00.000Z",
      agentId: "main",
      chatId: "oc-control",
      messageId: "om_hello",
      sessionKey: "agent:main:feishu:control_room",
      userMessage: "hello",
      targetSurface: "control_room",
      effectiveSurface: "control_room",
      handoff: {
        family: "unknown",
        source: "unknown",
        confidence: 0,
        notice: "handoff",
      },
    });

    expect(result.artifact.contextInheritance).toMatchObject({
      mode: "explicit_continuation_required",
      reason: "unknown_family_requires_fresh_subject_or_clarification",
    });
    expect(renderLarkContextPacketNotice(result.artifact)).toBeUndefined();
  });
});
