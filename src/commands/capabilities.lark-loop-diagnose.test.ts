import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { larkLoopDiagnoseCommand, readReceiptStats } from "./capabilities/lark-loop-diagnose.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const runtime = createTestRuntime();

describe("larkLoopDiagnoseCommand", () => {
  beforeEach(() => {
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("reports the local loop as ready and live receipts as the remaining blocker", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lark-diagnose-test-"));
    await larkLoopDiagnoseCommand({ workspaceDir: workspace, json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
      ok: boolean;
      gatewayAgentModelParamSchema: { ok: boolean; error: string | null };
      localLoop: {
        ok: boolean;
        backendTool: string;
        analysisStatus: string;
        orchestration: { primaryModules: string[]; requiredTools: string[]; boundaries: string[] };
      };
      liveHandoffReceipts: {
        count: number;
        workspaceDir: string;
        financeOrchestrationCount: number;
        latestFinanceOrchestration: unknown;
        latestReceiptFinanceReplay: unknown;
        workspaces: Array<{
          count: number;
          workspaceDir: string;
          financeOrchestrationCount: number;
        }>;
      };
      nextBlocker: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.gatewayAgentModelParamSchema).toEqual({ ok: true, error: null });
    expect(payload.localLoop.ok).toBe(true);
    expect(payload.localLoop.backendTool).toBe("finance_learning_pipeline_orchestrator");
    expect(payload.localLoop.analysisStatus).toBe("research_review_ready");
    expect(payload.localLoop.orchestration.primaryModules).toEqual(
      expect.arrayContaining(["etf_regime", "portfolio_risk_gates", "quant_math", "causal_map"]),
    );
    expect(payload.localLoop.orchestration.requiredTools).toEqual(
      expect.arrayContaining(["finance_framework_core_inspect", "quant_math", "review_panel"]),
    );
    expect(payload.localLoop.orchestration.boundaries).toContain("no_execution_authority");
    expect(payload.liveHandoffReceipts.count).toBe(0);
    expect(payload.liveHandoffReceipts.financeOrchestrationCount).toBe(0);
    expect(payload.liveHandoffReceipts.latestFinanceOrchestration).toBeNull();
    expect(payload.liveHandoffReceipts.latestReceiptFinanceReplay).toBeNull();
    expect(payload.liveHandoffReceipts.workspaceDir).toBe(workspace);
    expect(payload.liveHandoffReceipts.workspaces).toEqual([
      expect.objectContaining({ count: 0, financeOrchestrationCount: 0, workspaceDir: workspace }),
    ]);
    expect(payload.nextBlocker).toBe("no_live_lark_user_inbound_handoff_receipt_yet");
  });

  it("aggregates receipts across inspected agent workspaces", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lark-diagnose-receipts-"));
    const receiptDir = path.join(
      workspace,
      "memory",
      "lark-language-handoff-receipts",
      "2026-05-02",
    );
    await fs.promises.mkdir(receiptDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(receiptDir, "om_live.json"),
      JSON.stringify({
        generatedAt: "2026-05-02T12:00:00.000Z",
        boundary: "language_handoff_only",
        userMessage: "学习 ETF 因子择时、持仓风险控制、回撤数学和因果证伪。",
        handoff: {
          family: "market_capability_learning_intake",
          source: "api",
        },
        financeBrainOrchestration: {
          primaryModules: ["etf_regime", "portfolio_risk_gates", "quant_math", "causal_map"],
          supportingModules: ["finance_learning_memory"],
          requiredTools: [
            "finance_learning_capability_apply",
            "finance_framework_core_inspect",
            "quant_math",
            "review_tier",
            "review_panel",
          ],
          reviewTools: ["review_tier", "review_panel"],
          boundaries: ["research_only", "no_execution_authority", "no_model_math_guessing"],
        },
      }),
      "utf8",
    );

    const stats = await readReceiptStats({ workspaceDir: workspace });

    expect(stats).toMatchObject({
      workspaceDir: workspace,
      count: 1,
      latestPath: "memory/lark-language-handoff-receipts/2026-05-02/om_live.json",
      latestGeneratedAt: "2026-05-02T12:00:00.000Z",
      financeOrchestrationCount: 1,
      latestFinanceOrchestration: {
        receiptPath: "memory/lark-language-handoff-receipts/2026-05-02/om_live.json",
        generatedAt: "2026-05-02T12:00:00.000Z",
        family: "market_capability_learning_intake",
        source: "api",
        primaryModules: ["etf_regime", "portfolio_risk_gates", "quant_math", "causal_map"],
        supportingModules: ["finance_learning_memory"],
        requiredTools: [
          "finance_learning_capability_apply",
          "finance_framework_core_inspect",
          "quant_math",
          "review_tier",
          "review_panel",
        ],
        reviewTools: ["review_tier", "review_panel"],
        boundaries: ["research_only", "no_execution_authority", "no_model_math_guessing"],
      },
      latestReceiptFinanceReplay: {
        receiptPath: "memory/lark-language-handoff-receipts/2026-05-02/om_live.json",
        generatedAt: "2026-05-02T12:00:00.000Z",
        family: "market_capability_learning_intake",
        source: "api",
        primaryModules: expect.arrayContaining([
          "etf_regime",
          "portfolio_risk_gates",
          "quant_math",
          "causal_map",
        ]),
        supportingModules: ["finance_learning_memory"],
        requiredTools: expect.arrayContaining([
          "finance_framework_core_inspect",
          "quant_math",
          "review_tier",
          "review_panel",
        ]),
        reviewTools: ["review_tier", "review_panel"],
        boundaries: expect.arrayContaining(["research_only", "no_execution_authority"]),
      },
      workspaces: [
        expect.objectContaining({
          count: 1,
          financeOrchestrationCount: 1,
          workspaceDir: workspace,
        }),
      ],
    });
  });

  it("derives current language replay from handoff receipts when candidate artifacts are missing", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lark-diagnose-derived-"));
    const receiptDir = path.join(
      workspace,
      "memory",
      "lark-language-handoff-receipts",
      "2026-05-06",
    );
    await fs.promises.mkdir(receiptDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(receiptDir, "om_commodity_learning.json"),
      JSON.stringify({
        generatedAt: "2026-05-06T00:29:36.322Z",
        boundary: "language_handoff_only",
        userMessage: "今天学习大宗商品的知识",
        handoff: {
          family: "learning_external_source",
          source: "api",
          apiCandidate: {
            family: "learning_external_source",
            confidence: 0.62,
            rationale: "User wants to learn about commodities today.",
          },
        },
      }),
      "utf8",
    );

    await larkLoopDiagnoseCommand({ workspaceDir: workspace, json: true }, runtime);

    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
      languageCandidates: {
        candidateArtifactCount: number;
        candidateCount: number;
        currentReplay: {
          source: string;
          candidateCount: number;
          acceptedCaseCount: number;
          rejectedCount: number;
          discardedCount: number;
          rejectedReasonCounts: Record<string, number>;
        };
        autodataLoop: {
          status: string;
        };
      };
    };
    expect(payload.languageCandidates.candidateArtifactCount).toBe(0);
    expect(payload.languageCandidates.candidateCount).toBe(0);
    expect(payload.languageCandidates.currentReplay).toMatchObject({
      source: "handoff_receipt_derived",
      candidateCount: 2,
      acceptedCaseCount: 0,
      rejectedCount: 0,
      discardedCount: 2,
      rejectedReasonCounts: {},
    });
    expect(payload.languageCandidates.autodataLoop.status).toBe("needs_candidate_capture");
  });

  it("reports language candidate capture and review artifacts separately from brain receipts", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lark-diagnose-language-"));
    const candidateDir = path.join(
      workspace,
      "memory",
      "lark-language-routing-candidates",
      "2026-05-03",
    );
    const reviewDir = path.join(workspace, "memory", "lark-language-routing-reviews");
    await fs.promises.mkdir(candidateDir, { recursive: true });
    await fs.promises.mkdir(reviewDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(candidateDir, "om_language.json"),
      JSON.stringify({
        generatedAt: "2026-05-03T11:00:00.000Z",
        boundary: "language_routing_only",
        candidates: [{ id: "candidate-1" }, { id: "candidate-2" }, { id: "candidate-3" }],
        evaluation: {
          boundary: "language_routing_only",
          evaluations: [
            {
              reason: "accepted_language_case",
              candidate: {
                id: "candidate-1",
                source: "lark_user_utterance",
                utterance: "去 Google 上学习 ETF 风控资料，但标清覆盖范围",
                semantic: { family: "external_source_coverage_honesty" },
              },
            },
            {
              reason: "semantic_family_unknown",
              candidate: {
                id: "candidate-2",
                source: "lark_user_utterance",
                utterance: "你像真实研究员一样拆一下这个新行业机会",
                semantic: { family: "unknown" },
              },
            },
            {
              reason: "deterministic_route_failed",
              candidate: {
                id: "candidate-3",
                source: "lark_user_utterance",
                utterance: "给我做一个纳指回调后的技术择时计划",
                semantic: { family: "technical_timing" },
              },
            },
          ],
          counts: {
            total: 3,
            accepted: 1,
            rejected: 2,
            discarded: 0,
          },
          acceptedCases: [
            {
              id: "case-1",
              utterance: "去 Google 上学习 ETF 风控资料，但标清覆盖范围",
              family: "external_source_coverage_honesty",
            },
          ],
        },
      }),
      "utf8",
    );
    await fs.promises.writeFile(
      path.join(reviewDir, "2026-05-03.json"),
      JSON.stringify({
        generatedAt: "2026-05-03T11:05:00.000Z",
        boundary: "language_routing_only",
        promotedCases: [{ id: "promoted-1" }],
      }),
      "utf8",
    );

    await larkLoopDiagnoseCommand({ workspaceDir: workspace, json: true }, runtime);

    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
      languageCandidates: {
        workspaceDir: string;
        candidateArtifactCount: number;
        candidateCount: number;
        acceptedCaseCount: number;
        rejectedCount: number;
        discardedCount: number;
        reasonCounts: Record<string, number>;
        semanticFamilyCounts: Record<string, number>;
        rejectedReasonCounts: Record<string, number>;
        rejectedSemanticFamilyCounts: Record<string, number>;
        currentReplay: {
          candidateCount: number;
          acceptedCaseCount: number;
          rejectedCount: number;
          discardedCount: number;
          rejectedReasonCounts: Record<string, number>;
          rejectedSemanticFamilyCounts: Record<string, number>;
          rejectedExamples: Array<{
            reason: string;
            semanticFamily: string;
            source: string | null;
            utterance: string;
            candidateId: string | null;
            artifactPath: string | null;
          }>;
        };
        latestCandidatePath: string;
        latestCandidateGeneratedAt: string;
        reviewArtifactCount: number;
        promotedCaseCount: number;
        latestReviewPath: string;
        latestReviewGeneratedAt: string;
        autodataLoop: {
          pattern: string;
          status: string;
          currentReplayAcceptanceRate: number;
          currentReplayRejectedRate: number;
          topRejectedReason: string | null;
          topRejectedSemanticFamily: string | null;
          nextBatchFocus: string[];
          guardrails: string[];
        };
      };
    };
    expect(payload.languageCandidates).toMatchObject({
      workspaceDir: workspace,
      candidateArtifactCount: 1,
      candidateCount: 3,
      acceptedCaseCount: 1,
      rejectedCount: 2,
      discardedCount: 0,
      reasonCounts: {
        accepted_language_case: 1,
        semantic_family_unknown: 1,
        deterministic_route_failed: 1,
      },
      semanticFamilyCounts: {
        external_source_coverage_honesty: 1,
        unknown: 1,
        technical_timing: 1,
      },
      rejectedReasonCounts: {
        semantic_family_unknown: 1,
        deterministic_route_failed: 1,
      },
      rejectedSemanticFamilyCounts: {
        unknown: 1,
        technical_timing: 1,
      },
      currentReplay: {
        candidateCount: 3,
        acceptedCaseCount: 0,
        rejectedCount: 3,
        discardedCount: 0,
        rejectedReasonCounts: {
          missing_distillable_text: 3,
        },
        rejectedSemanticFamilyCounts: {
          unknown: 3,
        },
      },
      latestCandidatePath: "memory/lark-language-routing-candidates/2026-05-03/om_language.json",
      latestCandidateGeneratedAt: "2026-05-03T11:00:00.000Z",
      reviewArtifactCount: 1,
      promotedCaseCount: 1,
      latestReviewPath: "memory/lark-language-routing-reviews/2026-05-03.json",
      latestReviewGeneratedAt: "2026-05-03T11:05:00.000Z",
      autodataLoop: {
        pattern: "autodata_inspired_language_data_loop",
        status: "needs_candidate_capture",
        currentReplayAcceptanceRate: 0,
        currentReplayRejectedRate: 1,
        topRejectedReason: "missing_distillable_text",
        topRejectedSemanticFamily: "unknown",
        nextBatchFocus: [
          "capture_more_real_lark_dialogue_candidates",
          "inspect_candidate_distillation_shape",
        ],
        guardrails: [
          "language_routing_only",
          "no_finance_learning_artifact_promotion",
          "no_live_sender_change",
          "accepted_cases_still_require_review_before_formal_corpus",
        ],
      },
      rejectedExamples: [
        {
          reason: "semantic_family_unknown",
          semanticFamily: "unknown",
          source: "lark_user_utterance",
          utterance: "你像真实研究员一样拆一下这个新行业机会",
          candidateId: "candidate-2",
          artifactPath: "memory/lark-language-routing-candidates/2026-05-03/om_language.json",
        },
        {
          reason: "deterministic_route_failed",
          semanticFamily: "technical_timing",
          source: "lark_user_utterance",
          utterance: "给我做一个纳指回调后的技术择时计划",
          candidateId: "candidate-3",
          artifactPath: "memory/lark-language-routing-candidates/2026-05-03/om_language.json",
        },
      ],
    });
  });

  it("replays finance orchestration for the latest receipt when old live receipt lacks it", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lark-diagnose-replay-"));
    const receiptDir = path.join(
      workspace,
      "memory",
      "lark-language-handoff-receipts",
      "2026-05-02",
    );
    await fs.promises.mkdir(receiptDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(receiptDir, "om_nasdaq_math.json"),
      JSON.stringify({
        generatedAt: "2026-05-02T21:24:32.499Z",
        boundary: "language_handoff_only",
        userMessage: "用你的数学知识分析下最近一个月的纳斯达克指数",
        handoff: {
          family: "technical_timing",
          source: "api",
        },
      }),
      "utf8",
    );

    const stats = await readReceiptStats({ workspaceDir: workspace });

    expect(stats.financeOrchestrationCount).toBe(0);
    expect(stats.latestFinanceOrchestration).toBeNull();
    expect(stats.latestReceiptFinanceReplay).toMatchObject({
      receiptPath: "memory/lark-language-handoff-receipts/2026-05-02/om_nasdaq_math.json",
      generatedAt: "2026-05-02T21:24:32.499Z",
      family: "technical_timing",
      source: "api",
      primaryModules: expect.arrayContaining(["etf_regime", "quant_math", "causal_map"]),
      supportingModules: ["finance_learning_memory"],
      requiredTools: expect.arrayContaining([
        "finance_framework_core_inspect",
        "finance_framework_etf_regime_producer",
        "quant_math",
        "review_tier",
        "review_panel",
      ]),
      boundaries: expect.arrayContaining(["research_only", "no_model_math_guessing"]),
    });
  });
});
