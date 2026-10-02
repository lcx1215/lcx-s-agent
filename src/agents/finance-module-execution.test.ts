import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FinanceCommitteeEvidence } from "./finance-agent-committee.js";
import { appendFinanceBars } from "./finance-bar-ledger.js";
import {
  FINANCE_BRAIN_MODULES,
  planFinanceBrainOrchestration,
} from "./finance-brain-orchestration.js";
import type { FinanceMarketCollectionItem } from "./finance-market-collection-registry.js";
import {
  deriveFinanceModuleReplanFeedback,
  executeFinanceModuleComposition,
  financeModuleExecutionRegistryIds,
} from "./finance-module-execution.js";
import type { FinanceModuleExecutionNode } from "./finance-module-execution.js";
import {
  buildFinanceActiveStrategyResearchEvidence,
  buildFinanceNightReviewEvidence,
} from "./finance-night-review-context.js";
import type { FinanceResearchBatchEvidencePacket } from "./finance-research-batch-runner.js";
import {
  activateFinanceStrategyRule,
  declareFinanceStrategyRule,
} from "./finance-strategy-rule-ledger.js";
import { buildQualityHarnessModelPrompt } from "./local-text-model-adapter.js";

function emptyBatch(): FinanceResearchBatchEvidencePacket {
  return {
    schemaVersion: "lcx_finance_research_batch_v1",
    boundary: "finance_research_batch_research_only",
    decisionMode: "research_only",
    correlationId: "module-test",
    asOf: "2026-09-11T00:00:00.000Z",
    useCase: "finance_research_run",
    status: "blocked",
    jobs: [],
    committeeEvidence: [],
    budget: {} as FinanceResearchBatchEvidencePacket["budget"],
    notTouched: [],
  };
}

function eodRecord(
  date: string,
  close: number,
  source: { providerName?: string; feed?: string; adjusted?: boolean } = {},
): FinanceMarketCollectionItem {
  const sourceTimestamp =
    date === "not-a-date" ? "2026-09-02T00:00:00.000Z" : `${date}T00:00:00.000Z`;
  return {
    itemId: `eod-${source.providerName ?? "fixture"}-${date}-${close}`,
    collection: "eod_history",
    providerName: source.providerName ?? "fixture-eod",
    providerRole: "official_or_issuer_reference",
    sourceFamily: "official_macro_data",
    sourceTimestamp,
    observedAt: sourceTimestamp,
    delayStatus: "official_lagged",
    sourceUrlOrArtifact: "https://example.test/eod",
    data: {
      date,
      close,
      ...(source.feed ? { feed: source.feed } : {}),
      ...(source.adjusted !== undefined ? { adjusted: source.adjusted } : {}),
    },
  };
}

describe("finance module execution", () => {
  it("keeps the executor registry aligned with every registered finance module", () => {
    expect(financeModuleExecutionRegistryIds()).toEqual(FINANCE_BRAIN_MODULES.map(({ id }) => id));
  });

  it("allows only bounded soft replanning after every hard lane succeeds", () => {
    const withBudget = planFinanceBrainOrchestration({
      text: "技术择时验证",
      highStakesConclusion: true,
      moduleSelection: {
        moduleIds: ["technical_timing"],
        rationale: "exercise the soft-lane feedback contract",
        composition: {
          nodes: [{ id: "timing", moduleId: "technical_timing", dependsOn: [] }],
          maxReplans: 1,
        },
      },
    });
    const nodesFor = (composition: typeof withBudget.composition): FinanceModuleExecutionNode[] =>
      [...composition.control.hardNodeIds, ...composition.control.softNodeIds].map((nodeId) => ({
        nodeId,
        moduleId: "technical_timing",
        requiredToolNames: [],
        dependsOn: [],
        status: composition.control.softNodeIds.includes(nodeId) ? "failed" : "succeeded",
        inputEvidenceIds: [],
        outputEvidenceIds: [],
        toolCalls: [],
        missingEvidence: [],
      }));
    const nodes = nodesFor(withBudget.composition);
    expect(deriveFinanceModuleReplanFeedback(withBudget.composition, nodes, true)).toMatchObject({
      status: "replan_soft",
      nextAction: "revise_soft_modules",
      remainingSoftReplans: 1,
    });

    const exhausted = planFinanceBrainOrchestration({
      text: "技术择时验证",
      highStakesConclusion: true,
      moduleSelection: {
        moduleIds: ["technical_timing"],
        rationale: "exercise the exhausted soft-lane contract",
        composition: {
          nodes: [{ id: "timing", moduleId: "technical_timing", dependsOn: [] }],
          maxReplans: 0,
        },
      },
    });
    expect(
      deriveFinanceModuleReplanFeedback(
        exhausted.composition,
        nodesFor(exhausted.composition),
        true,
      ),
    ).toMatchObject({
      status: "soft_replan_budget_exhausted",
      nextAction: "stop",
      remainingSoftReplans: 0,
    });
  });

  it("records every composed node even when no evidence is available", async () => {
    const moduleIds = FINANCE_BRAIN_MODULES.map(({ id }) => id);
    const plan = planFinanceBrainOrchestration({
      text: "全量金融模块研究",
      highStakesConclusion: true,
      moduleSelection: { moduleIds, rationale: "bounded all-module coverage test" },
    });
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-module-execution-"));
    try {
      const result = await executeFinanceModuleComposition({
        ask: "全量金融模块研究",
        asOf: "2026-09-11T00:00:00.000Z",
        plan,
        batch: emptyBatch(),
        workspaceDir,
      });
      expect(result.receipt.compositionNodeIds).toHaveLength(moduleIds.length);
      expect(result.receipt.nodes.map((node) => node.moduleId).toSorted()).toEqual(
        moduleIds.toSorted(),
      );
      expect(result.receipt.nodes).toHaveLength(moduleIds.length);
      for (const node of result.receipt.nodes) {
        const definition = FINANCE_BRAIN_MODULES.find((module) => module.id === node.moduleId);
        expect(node.requiredToolNames).toEqual(definition?.requiredTools);
      }
      expect(result.receipt.moduleToolsDispatched).toBe(false);
      expect(result.receipt.replanFeedback.status).toBe("blocked_hard");
      expect(result.receipt.replanFeedback.nextAction).toBe("stop");
      expect(result.evidence).toHaveLength(0);
      expect(
        result.receipt.nodes.every(
          (node) => node.status === "blocked_missing_evidence" || node.status === "failed",
        ),
      ).toBe(true);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("dispatches quant_math from ready historical levels and preserves the evidence link", async () => {
    const plan = planFinanceBrainOrchestration({
      text: "执行模块取消测试",
      highStakesConclusion: true,
      moduleSelection: {
        moduleIds: ["quant_math", "finance_learning_memory", "causal_map"],
        rationale: "bounded quant execution test",
        composition: {
          nodes: [
            { id: "learning", moduleId: "finance_learning_memory", dependsOn: [] },
            { id: "math", moduleId: "quant_math", dependsOn: [] },
            { id: "causal", moduleId: "causal_map", dependsOn: [] },
          ],
          maxReplans: 0,
        },
      },
    });
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-module-quant-"));
    try {
      const batch = {
        ...emptyBatch(),
        status: "completed",
        committeeEvidence: [
          {
            id: "finance-model:SPY",
            source: "finance-research-batch-runner",
            timestamp: "2026-09-11T00:00:00.000Z",
            text: "SPY daily closes summarized from the ready batch receipt.",
          },
          {
            id: "finance-model:QQQ",
            source: "finance-research-batch-runner",
            timestamp: "2026-09-11T00:00:00.000Z",
            text: "QQQ daily closes summarized from the ready batch receipt.",
          },
        ],
        jobs: [
          {
            jobId: "finance-batch:spy-eod",
            status: "ready",
            request: { collection: "eod_history", instrument: "SPY", assetClass: "us_equity" },
            receipt: {
              records: [
                eodRecord("2026-09-03", 97),
                eodRecord("2026-09-02", 95),
                eodRecord("2026-09-01", 100),
              ],
            },
          },
          {
            jobId: "finance-batch:qqq-eod",
            status: "ready",
            request: { collection: "eod_history", instrument: "QQQ", assetClass: "us_equity" },
            receipt: {
              records: [
                eodRecord("2026-09-03", 297),
                eodRecord("2026-09-02", 295),
                eodRecord("2026-09-01", 300),
              ],
            },
          },
        ],
      } as unknown as FinanceResearchBatchEvidencePacket;
      const result = await executeFinanceModuleComposition({
        ask: "SPY historical drawdown",
        asOf: "2026-09-11T00:00:00.000Z",
        plan,
        batch,
        workspaceDir,
      });
      const quant = result.receipt.nodes.find((node) => node.moduleId === "quant_math");
      expect(quant?.status).toBe("succeeded");
      expect(quant?.inputEvidenceIds).toContain("finance-model:SPY");
      expect(quant?.inputEvidenceIds).not.toContain("finance-batch:spy-eod");
      expect(quant?.toolCalls[0]?.toolName).toBe("quant_math");
      expect(quant?.outputEvidenceIds).toEqual(["finance-module:math"]);
      expect(quant?.inputEvidenceIds).toEqual(["finance-model:SPY"]);
      expect(result.evidence[0]?.text).toContain('"maxDrawdown":-0.05');
      expect(result.evidence[0]?.text).toContain('"instrument":"SPY"');
      expect(result.evidence[0]?.text).toContain('"fromDate":"2026-09-01"');
      expect(result.evidence[0]?.text).toContain('"toDate":"2026-09-03"');
      expect(result.evidence[0]?.text).toContain("stored_close_history_not_adjusted_total_return");
      expect(result.evidence.map((entry) => entry.id)).toContain("finance-module:math");
      expect(result.receipt.replanFeedback.status).toBe("blocked_hard");
      expect(result.receipt.replanFeedback.hardFailures).toEqual(
        expect.arrayContaining(["causal"]),
      );

      const quantOnlyPlan = planFinanceBrainOrchestration({
        text: "执行模块取消测试",
        highStakesConclusion: true,
        moduleSelection: { moduleIds: ["quant_math"], rationale: "citeable history regression" },
      });
      const rawReceiptOnly = await executeFinanceModuleComposition({
        ask: "SPY historical drawdown",
        asOf: "2026-09-11T00:00:00.000Z",
        plan: quantOnlyPlan,
        batch: { ...batch, jobs: [batch.jobs[0]], committeeEvidence: [] },
        workspaceDir,
      });
      const blockedQuant = rawReceiptOnly.receipt.nodes.find(
        (node) => node.moduleId === "quant_math",
      );
      expect(blockedQuant?.status).toBe("blocked_missing_evidence");
      expect(blockedQuant?.missingEvidence).toContain(
        "citeable_source_history_evidence_packet:SPY",
      );
      expect(blockedQuant?.inputEvidenceIds).not.toContain("finance-batch:spy-eod");

      const instruments = ["SPY", "QQQ", "IWM", "DIA", "VTI", "VOO", "XLK", "XLF"];
      const portfolioBatch = {
        ...emptyBatch(),
        status: "completed",
        committeeEvidence: instruments.map((instrument) => ({
          id: `finance-model:${instrument}`,
          source: "finance-research-batch-runner",
          timestamp: "2026-09-11T00:00:00.000Z",
          text: `${instrument} daily closes summarized from the ready batch receipt.`,
        })),
        jobs: instruments.map((instrument, index) => {
          const base = 100 + (index + 1) * 100;
          return {
            jobId: `finance-batch:${instrument.toLowerCase()}-eod`,
            status: "ready",
            request: { collection: "eod_history", instrument, assetClass: "us_equity" },
            receipt: {
              records: [
                eodRecord("2026-09-03", base * 0.97),
                eodRecord("2026-09-02", base * 0.95),
                eodRecord("2026-09-01", base),
              ],
            },
          };
        }),
      } as unknown as FinanceResearchBatchEvidencePacket;
      const portfolio = await executeFinanceModuleComposition({
        ask: "drawdown across ETF histories",
        asOf: "2026-09-11T00:00:00.000Z",
        plan: quantOnlyPlan,
        batch: portfolioBatch,
        workspaceDir,
      });
      const portfolioQuant = portfolio.receipt.nodes.find((node) => node.moduleId === "quant_math");
      expect(portfolioQuant?.status).toBe("succeeded");
      expect(portfolioQuant?.toolCalls).toHaveLength(instruments.length);
      expect(portfolioQuant?.inputEvidenceIds).toEqual(
        instruments.map((id) => `finance-model:${id}`),
      );
      const portfolioEvidence = portfolio.evidence.find(
        (item) => item.id === "finance-module:quant_math",
      );
      const portfolioOutput = JSON.parse(portfolioEvidence?.text ?? "{}") as {
        toolOutput?: {
          instrumentResults?: Array<{
            maxDrawdown?: number;
            historySource?: { instrument?: string; fromDate?: string; toDate?: string };
          }>;
        };
      };
      expect(portfolioOutput.toolOutput?.instrumentResults).toHaveLength(instruments.length);
      expect(
        portfolioOutput.toolOutput?.instrumentResults?.map(
          (item) => item.historySource?.instrument,
        ),
      ).toEqual(instruments);
      expect(
        portfolioOutput.toolOutput?.instrumentResults?.every((item) => item.maxDrawdown === -0.05),
      ).toBe(true);
      expect(
        portfolioOutput.toolOutput?.instrumentResults?.every(
          (item) =>
            item.historySource?.fromDate === "2026-09-01" &&
            item.historySource.toDate === "2026-09-03",
        ),
      ).toBe(true);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps separate provider windows separate for the same instrument", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-provider-quant-"));
    try {
      const plan = planFinanceBrainOrchestration({
        text: "SPY drawdown",
        moduleSelection: {
          moduleIds: ["quant_math"],
          rationale: "source identity regression",
          composition: {
            nodes: [{ id: "math", moduleId: "quant_math", dependsOn: [] }],
            maxReplans: 0,
          },
        },
      });
      const batch = {
        ...emptyBatch(),
        committeeEvidence: [
          {
            id: "finance-model:SPY",
            source: "finance-research-batch-runner",
            timestamp: "2026-09-11T00:00:00.000Z",
            text: "SPY close history summarized from source receipts.",
          },
        ],
        jobs: [
          {
            jobId: "finance-batch:spy-alpha",
            status: "ready",
            request: { collection: "eod_history", instrument: "SPY", assetClass: "us_equity" },
            receipt: {
              records: [
                eodRecord("2026-09-01", 100, { providerName: "feed-alpha" }),
                eodRecord("2026-09-02", 95, { providerName: "feed-alpha" }),
              ],
            },
          },
          {
            jobId: "finance-batch:spy-beta",
            status: "ready",
            request: { collection: "eod_history", instrument: "SPY", assetClass: "us_equity" },
            receipt: {
              records: [
                eodRecord("2026-09-05", 200, { providerName: "feed-beta" }),
                eodRecord("2026-09-06", 190, { providerName: "feed-beta" }),
              ],
            },
          },
        ],
      } as unknown as FinanceResearchBatchEvidencePacket;
      const result = await executeFinanceModuleComposition({
        ask: "SPY drawdown",
        asOf: "2026-09-11T00:00:00.000Z",
        plan,
        batch,
        workspaceDir,
      });
      const quant = result.receipt.nodes.find((node) => node.moduleId === "quant_math");
      expect(quant?.status).toBe("succeeded");
      expect(quant?.toolCalls).toHaveLength(2);
      const evidence = result.evidence.find((item) => item.id === "finance-module:math");
      const parsed = JSON.parse(evidence?.text ?? "{}") as {
        toolOutput?: {
          instrumentResults?: Array<{
            historySource?: {
              instrument?: string;
              identity?: string[];
              fromDate?: string;
              toDate?: string;
            };
          }>;
        };
      };
      expect(
        parsed.toolOutput?.instrumentResults?.map((item) => ({
          identity: item.historySource?.identity?.[0],
          from: item.historySource?.fromDate,
          to: item.historySource?.toDate,
        })),
      ).toEqual([
        { identity: "feed-alpha", from: "2026-09-01", to: "2026-09-02" },
        { identity: "feed-beta", from: "2026-09-05", to: "2026-09-06" },
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("accepts same-day EOD history under the existing live-now cutoff", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-live-now-quant-"));
    try {
      const asOf = new Date().toISOString();
      const toDate = asOf.slice(0, 10);
      const prior = new Date(`${toDate}T00:00:00.000Z`);
      prior.setUTCDate(prior.getUTCDate() - 1);
      const fromDate = prior.toISOString().slice(0, 10);
      const plan = planFinanceBrainOrchestration({
        text: "SPY same-day drawdown",
        moduleSelection: {
          moduleIds: ["quant_math"],
          rationale: "live-now daily close eligibility",
        },
      });
      const batch = {
        ...emptyBatch(),
        asOf,
        asOfMode: "live_now",
        committeeEvidence: [
          {
            id: "finance-model:SPY",
            source: "finance-research-batch-runner",
            timestamp: asOf,
            text: "SPY live-now daily close history.",
          },
        ],
        jobs: [
          {
            jobId: "finance-batch:spy-live-now",
            status: "ready",
            request: { collection: "eod_history", instrument: "SPY", assetClass: "us_equity" },
            receipt: {
              records: [eodRecord(fromDate, 100), eodRecord(toDate, 98)],
            },
          },
        ],
      } as unknown as FinanceResearchBatchEvidencePacket;
      const result = await executeFinanceModuleComposition({
        ask: "SPY same-day drawdown",
        asOf,
        plan,
        batch,
        workspaceDir,
      });
      const quant = result.receipt.nodes.find((node) => node.moduleId === "quant_math");
      expect(quant?.status).toBe("succeeded");
      const evidence = result.evidence.find((item) => item.id === "finance-module:quant_math");
      expect(evidence?.text).toContain(toDate);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it.each(["conflict", "invalid"])(
    "blocks %s EOD rows instead of silently choosing a point",
    async (variant) => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-module-quant-conflict-"));
      try {
        const plan = planFinanceBrainOrchestration({
          text: "historical drawdown",
          moduleSelection: { moduleIds: ["quant_math"], rationale: "conflicting close regression" },
        });
        const batch = {
          ...emptyBatch(),
          committeeEvidence: [
            {
              id: "finance-model:SPY",
              source: "finance-research-batch-runner",
              timestamp: "2026-09-11T00:00:00.000Z",
              text: "SPY daily closes.",
            },
          ],
          jobs: [
            {
              jobId: "finance-batch:spy-eod",
              status: "ready",
              request: { collection: "eod_history", instrument: "SPY", assetClass: "us_equity" },
              receipt: {
                records:
                  variant === "conflict"
                    ? [
                        eodRecord("2026-09-03", 97),
                        eodRecord("2026-09-02", 95),
                        eodRecord("2026-09-02", 96),
                        eodRecord("2026-09-01", 100),
                      ]
                    : [
                        eodRecord("2026-09-03", 97),
                        eodRecord("not-a-date", 95),
                        eodRecord("2026-09-01", 100),
                      ],
              },
            },
          ],
        } as unknown as FinanceResearchBatchEvidencePacket;
        const result = await executeFinanceModuleComposition({
          ask: "historical drawdown",
          asOf: "2026-09-11T00:00:00.000Z",
          plan,
          batch,
          workspaceDir,
        });
        const quant = result.receipt.nodes.find((node) => node.moduleId === "quant_math");
        expect(quant?.status).toBe("blocked_missing_evidence");
        expect(quant?.toolCalls).toHaveLength(0);
        expect(
          quant?.missingEvidence.some((issue) =>
            issue.startsWith(
              variant === "conflict"
                ? "conflict_free_eod_close_history:SPY:"
                : "valid_dated_positive_eod_closes:SPY:",
            ),
          ),
        ).toBe(true);
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    },
  );

  it("dispatches the declared domain producer before inspecting its durable output", async () => {
    const moduleId = "company_fundamentals_value" as const;
    const plan = planFinanceBrainOrchestration({
      text: "公司基本面与估值",
      highStakesConclusion: true,
      moduleSelection: {
        moduleIds: [moduleId],
        rationale: "prove declared producer dispatch",
        composition: {
          nodes: [{ id: "fundamentals", moduleId, dependsOn: [] }],
          maxReplans: 0,
        },
      },
    });
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-module-producer-"));
    try {
      const result = await executeFinanceModuleComposition({
        ask: "公司基本面与估值",
        asOf: "2026-09-11T00:00:00.000Z",
        plan,
        batch: emptyBatch(),
        workspaceDir,
        domainProducerInputs: {
          [moduleId]: {
            domain: moduleId,
            sourceArtifacts: ["fixture://fundamentals"],
            evidenceCategories: ["fundamentals_evidence", "valuation_evidence"],
            evidenceSummary:
              "company_fundamentals_value domain evidence contains audited revenue, margin, cash-flow and valuation-multiple observations.",
            baseCase: "cash flow remains positive while valuation stays near its historical band",
            bullCase: "margin expansion raises normalized earnings",
            bearCase: "revenue and free cash flow contract",
            keyCausalChain: "revenue growth -> margin transmission -> normalized free cash flow",
            upstreamDrivers: ["reported revenue and operating margin"],
            downstreamAssetImpacts: ["normalized equity value range"],
            confidenceOrConviction: "medium",
            whatChangesMyMind: "two reporting periods contradict the cash-flow premise",
            noActionReason: "research evidence alone grants no order authority",
            riskGateNotes: "valuation and balance-sheet evidence require independent review",
            allowedActionAuthority: "research_only",
          },
        },
      });
      const node = result.receipt.nodes.find((item) => item.nodeId === "fundamentals");
      expect(node?.status).toBe("succeeded");
      expect(node?.inputEvidenceIds).toContain("fixture://fundamentals");
      expect(node?.toolCalls.map((call) => call.toolName)).toEqual([
        "finance_framework_company_fundamentals_value_producer",
        "finance_framework_core_inspect",
      ]);
      const moduleEvidence = result.evidence.find(
        (entry) => entry.id === "finance-module:fundamentals",
      );
      expect(moduleEvidence).toBeDefined();
      if (!moduleEvidence) {
        throw new Error("missing actual module evidence");
      }
      for (const count of [1, 16]) {
        const prompt = buildQualityHarnessModelPrompt({
          schemaVersion: 1,
          runId: "module-handoff",
          attempt: 1,
          stage: "evidence",
          agentId: "evidence_integrity",
          task: "Review fundamental module findings",
          evidence: [
            moduleEvidence,
            ...Array.from({ length: count - 1 }, (_, index) => ({
              id: `other-${index}`,
              text: "Other evidence",
            })),
          ],
          sharedContext: {},
          repairFeedback: [],
          instructions: "Review the supplied analysis and its limits",
          dependencyOutputs: {},
        });
        expect(prompt).toContain("module_analysis_not_independent_source_verification");
        expect(prompt).toContain("audited revenue, margin, cash-flow");
        expect(prompt).toContain("valuation and balance-sheet evidence require independent review");
        expect(prompt).toContain("two reporting periods contradict the cash-flow premise");
        expect(prompt).toContain("revenue growth -> margin transmission");
      }
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not claim a domain node succeeded when its declared producer input is absent", async () => {
    const plan = planFinanceBrainOrchestration({
      text: "公司基本面与估值",
      highStakesConclusion: true,
      moduleSelection: {
        moduleIds: ["company_fundamentals_value"],
        rationale: "fail closed without producer output",
        composition: {
          nodes: [{ id: "fundamentals", moduleId: "company_fundamentals_value", dependsOn: [] }],
          maxReplans: 0,
        },
      },
    });
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-module-producer-gap-"));
    try {
      const result = await executeFinanceModuleComposition({
        ask: "公司基本面与估值",
        asOf: "2026-09-11T00:00:00.000Z",
        plan,
        batch: emptyBatch(),
        workspaceDir,
      });
      const node = result.receipt.nodes.find(
        (item) => item.moduleId === "company_fundamentals_value",
      );
      expect(node?.status).toBe("blocked_missing_evidence");
      expect(node?.toolCalls).toEqual([]);
      expect(node?.missingEvidence).toContain(
        "domain_producer_input:finance_framework_company_fundamentals_value_producer",
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("preserves cancellation in every node receipt", async () => {
    const plan = planFinanceBrainOrchestration({
      text: "执行模块取消测试",
      highStakesConclusion: true,
      moduleSelection: {
        moduleIds: ["quant_math", "finance_learning_memory", "causal_map"],
        rationale: "bounded cancellation test",
        composition: {
          nodes: [
            { id: "learning", moduleId: "finance_learning_memory", dependsOn: [] },
            { id: "math", moduleId: "quant_math", dependsOn: [] },
            { id: "causal", moduleId: "causal_map", dependsOn: [] },
          ],
        },
      },
    });
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-module-cancel-"));
    const controller = new AbortController();
    controller.abort(new Error("test cancellation"));
    try {
      const result = await executeFinanceModuleComposition({
        ask: "执行模块取消测试",
        asOf: "2026-09-11T00:00:00.000Z",
        plan,
        batch: emptyBatch(),
        workspaceDir,
        signal: controller.signal,
      });
      expect(result.receipt.moduleToolsDispatched).toBe(false);
      expect(result.receipt.replanFeedback).toMatchObject({
        status: "blocked_hard",
        nextAction: "stop",
        remainingSoftReplans: 0,
      });
      expect(result.receipt.nodes.every((node) => node.status === "cancelled")).toBe(true);
      expect(result.receipt.nodes.every((node) => node.toolCalls.length === 0)).toBe(true);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

it.each(["valid", "conflict", "duplicate", "future", "count", "invalid_price"])(
  "uses controller history only when its projection is valid: %s",
  async (variant) => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-controller-quant-"));
    try {
      const plan = planFinanceBrainOrchestration({
        text: "bounded drawdown",
        moduleSelection: {
          moduleIds: ["quant_math"],
          rationale: "controller history",
          composition: {
            nodes: [{ id: "math", moduleId: "quant_math", dependsOn: [] }],
            maxReplans: 0,
          },
        },
      });
      const value = {
        instrument: "SPY",
        fromDate: "2026-09-01",
        toDate: "2026-09-10",
        suppliedBarCount: variant === "count" ? 4 : 3,
        divergentDates: variant === "conflict" ? ["SPY@2026-09-09"] : [],
        closes: [
          ["2026-09-08", 100],
          [variant === "duplicate" ? "2026-09-08" : "2026-09-09", 95],
          [
            variant === "future" ? "2026-09-12" : "2026-09-10",
            variant === "invalid_price" ? -1 : 97,
          ],
        ],
      };
      const result = await executeFinanceModuleComposition({
        ask: "historical drawdown",
        asOf: "2026-09-11T00:00:00Z",
        plan,
        batch: emptyBatch(),
        workspaceDir,
        controllerEvidence: [
          {
            id: "finance-controller:eod:SPY",
            source: "finance-bar-ledger",
            timestamp: "2026-09-11T00:00:00Z",
            text: JSON.stringify(value),
          },
        ],
      });
      const quant = result.receipt.nodes.find((node) => node.moduleId === "quant_math");
      expect(quant?.status).toBe(variant === "valid" ? "succeeded" : "blocked_missing_evidence");
      if (variant === "valid") {
        expect(quant?.inputEvidenceIds).toContain("finance-controller:eod:SPY");
        expect(result.evidence[0]?.text).toContain(
          "stored_close_history_not_adjusted_total_return",
        );
      } else {
        expect(quant?.toolCalls).toHaveLength(0);
      }
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  },
);

it("hydrates public controller summaries only from the matching explicit bar ledger", async () => {
  const financeStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-controller-hydrate-state-"));
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lcx-controller-hydrate-workspace-"),
  );
  const missingStateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lcx-controller-hydrate-missing-"),
  );
  const conflictStateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "lcx-controller-hydrate-conflict-"),
  );
  const asOf = "2026-09-11T00:00:00.000Z";
  const declare = async (directory: string) => {
    await declareFinanceStrategyRule(directory, {
      kind: "declared",
      ruleId: "trend",
      form: "cross_asset_trend",
      formVersion: "1",
      instruments: ["SPY"],
      emits: "target_weights",
      schedule: { kind: "monthly", at: "last_trading_day", timezone: "America/New_York" },
      body: { frozenRule: { lookbackMonths: 12 } },
      observedAt: "2026-09-01T00:00:00.000Z",
    });
    await activateFinanceStrategyRule(directory, {
      kind: "activated",
      ruleId: "trend",
      reason: "bounded fixture",
      observedAt: "2026-09-02T00:00:00.000Z",
    });
  };
  const addBars = async (directory: string, conflict = false) => {
    await appendFinanceBars(directory, {
      instrument: "SPY",
      derivation: "ohlcv",
      provenance: { origin: "bounded-controller-fallback-fixture" },
      observedAt: "2026-09-10T12:00:00.000Z",
      bars: [
        { date: "2026-09-08", open: 100, high: 100, low: 100, close: 100 },
        { date: "2026-09-09", open: 95, high: 95, low: 95, close: 95 },
        { date: "2026-09-10", open: 97, high: 97, low: 97, close: 97 },
      ],
    });
    if (conflict) {
      await appendFinanceBars(directory, {
        instrument: "SPY",
        derivation: "ohlcv",
        provenance: { origin: "conflicting-controller-fixture" },
        observedAt: "2026-09-10T13:00:00.000Z",
        bars: [{ date: "2026-09-09", open: 95, high: 96, low: 95, close: 96 }],
      });
    }
  };
  const plan = planFinanceBrainOrchestration({
    text: "SPY historical drawdown",
    moduleSelection: {
      moduleIds: ["quant_math"],
      rationale: "exercise controller ledger fallback",
      composition: {
        nodes: [{ id: "math", moduleId: "quant_math", dependsOn: [] }],
        maxReplans: 0,
      },
    },
  });
  const execute = (controllerEvidence: FinanceCommitteeEvidence[], stateDir: string) =>
    executeFinanceModuleComposition({
      ask: "SPY historical drawdown",
      asOf,
      plan,
      batch: emptyBatch(),
      workspaceDir,
      financeStateDir: stateDir,
      controllerEvidence,
    });
  try {
    await declare(financeStateDir);
    await addBars(financeStateDir);
    const controllerEvidence = await buildFinanceNightReviewEvidence({
      directory: financeStateDir,
      asOf,
      etDate: "2026-09-10",
      includeResearchScope: true,
      settlement: {
        scoredFiled: { appended: 0, skipped: 0 },
        reflection: null,
        pending: [],
        declined: [],
        issues: [],
      },
    });
    const publicHistory = controllerEvidence.find(
      (item) => item.id === "finance-controller:eod:SPY",
    )!;
    const publicPayload = JSON.parse(publicHistory.text);
    expect(publicPayload).toHaveProperty("monthlyCloseObservations");
    expect(publicPayload).not.toHaveProperty("closes");
    expect(publicPayload).not.toHaveProperty("dailyRows");

    const hydrated = await execute([...controllerEvidence], financeStateDir);
    const quant = hydrated.receipt.nodes.find((node) => node.moduleId === "quant_math");
    expect(quant?.status).toBe("succeeded");
    expect(quant?.inputEvidenceIds).toEqual(["finance-controller:eod:SPY"]);
    expect(hydrated.evidence[0]?.text).toContain("finance-controller:eod:SPY");

    const tampered = controllerEvidence.map((item) =>
      item.id === publicHistory.id
        ? { ...item, text: JSON.stringify({ ...publicPayload, headRef: "f".repeat(64) }) }
        : item,
    );
    expect((await execute(tampered, financeStateDir)).receipt.nodes[0]?.status).toBe(
      "blocked_missing_evidence",
    );
    expect((await execute([...controllerEvidence], missingStateDir)).receipt.nodes[0]?.status).toBe(
      "blocked_missing_evidence",
    );

    await declare(conflictStateDir);
    await addBars(conflictStateDir, true);
    const conflictingEvidence = await buildFinanceNightReviewEvidence({
      directory: conflictStateDir,
      asOf,
      etDate: "2026-09-10",
      includeResearchScope: true,
      settlement: {
        scoredFiled: { appended: 0, skipped: 0 },
        reflection: null,
        pending: [],
        declined: [],
        issues: [],
      },
    });
    expect(
      (await execute([...conflictingEvidence], conflictStateDir)).receipt.nodes[0]?.status,
    ).toBe("blocked_missing_evidence");

    const ignoredStateDir = path.join(missingStateDir, "unused");
    const batchRun = await executeFinanceModuleComposition({
      ask: "SPY historical drawdown",
      asOf,
      plan,
      workspaceDir,
      financeStateDir: ignoredStateDir,
      controllerEvidence: [],
      batch: {
        ...emptyBatch(),
        committeeEvidence: [
          {
            id: "finance-model:SPY",
            source: "finance-research-batch-runner",
            timestamp: asOf,
            text: "batch EOD fixture",
          },
        ],
        jobs: [
          {
            jobId: "finance-batch:spy-eod",
            status: "ready",
            request: { collection: "eod_history", instrument: "SPY", assetClass: "us_equity" },
            receipt: { records: [eodRecord("2026-09-08", 100), eodRecord("2026-09-09", 95)] },
          },
        ],
      } as unknown as FinanceResearchBatchEvidencePacket,
    });
    expect(batchRun.receipt.nodes[0]?.status).toBe("succeeded");
    await expect(fs.stat(path.join(ignoredStateDir, "bar-ledger_1.sqlite"))).rejects.toThrow();

    await declareFinanceStrategyRule(financeStateDir, {
      kind: "declared",
      ruleId: "longer-lookback",
      form: "cross_asset_trend",
      formVersion: "1",
      instruments: ["SPY"],
      emits: "target_weights",
      schedule: { kind: "monthly", at: "last_trading_day", timezone: "America/New_York" },
      body: { frozenRule: { lookbackMonths: 24 } },
      observedAt: "2026-09-03T00:00:00.000Z",
    });
    await activateFinanceStrategyRule(financeStateDir, {
      kind: "activated",
      ruleId: "longer-lookback",
      reason: "independent active strategy with a different window",
      observedAt: "2026-09-04T00:00:00.000Z",
    });
    const daySubset = await buildFinanceActiveStrategyResearchEvidence({
      directory: financeStateDir,
      asOf,
      strategyIds: ["trend"],
    });
    expect((await execute([...daySubset], financeStateDir)).receipt.nodes[0]?.status).toBe(
      "succeeded",
    );
  } finally {
    await fs.rm(financeStateDir, { recursive: true, force: true });
    await fs.rm(workspaceDir, { recursive: true, force: true });
    await fs.rm(missingStateDir, { recursive: true, force: true });
    await fs.rm(conflictStateDir, { recursive: true, force: true });
  }
});

it("keeps every controller fallback instrument distinct", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-controller-portfolio-quant-"));
  try {
    const plan = planFinanceBrainOrchestration({
      text: "historical drawdown",
      moduleSelection: {
        moduleIds: ["quant_math"],
        rationale: "controller portfolio history",
        composition: {
          nodes: [{ id: "math", moduleId: "quant_math", dependsOn: [] }],
          maxReplans: 0,
        },
      },
    });
    const controllerEvidence = ["SPY", "QQQ"].map((instrument, index) => ({
      id: `finance-controller:eod:${instrument}`,
      source: "finance-bar-ledger",
      timestamp: "2026-09-11T00:00:00Z",
      text: JSON.stringify({
        instrument,
        fromDate: "2026-09-01",
        toDate: "2026-09-03",
        suppliedBarCount: 3,
        divergentDates: [],
        closes: [
          ["2026-09-01", 100 + index * 100],
          ["2026-09-02", 95 + index * 100],
          ["2026-09-03", 97 + index * 100],
        ],
      }),
    }));
    const result = await executeFinanceModuleComposition({
      ask: "historical drawdown",
      asOf: "2026-09-11T00:00:00Z",
      plan,
      batch: emptyBatch(),
      workspaceDir,
      controllerEvidence,
    });
    const quant = result.receipt.nodes.find((node) => node.moduleId === "quant_math");
    expect(quant?.status).toBe("succeeded");
    expect(quant?.toolCalls).toHaveLength(2);
    expect(quant?.inputEvidenceIds).toEqual([
      "finance-controller:eod:SPY",
      "finance-controller:eod:QQQ",
    ]);
    const output = result.evidence.find((item) => item.id === "finance-module:math");
    const parsed = JSON.parse(output?.text ?? "{}") as {
      toolOutput?: { instrumentResults?: Array<{ historySource?: { instrument?: string } }> };
    };
    expect(
      parsed.toolOutput?.instrumentResults?.map((item) => item.historySource?.instrument),
    ).toEqual(["SPY", "QQQ"]);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
