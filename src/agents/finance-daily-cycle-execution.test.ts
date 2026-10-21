import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as accountEconomicsReader from "./finance-account-economic-feedback.js";
import { AlpacaExecutionQuoteError } from "./finance-alpaca-execution-quote.js";
import * as dailyHistoryReader from "./finance-daily-decision-history.js";
import { FINANCE_EXECUTION_RECEIPT_SCHEMA } from "./finance-execution-adapter.js";
import { FinanceExecutionSafetyUncertainError } from "./finance-execution-safety.js";
import { syntheticSafetyContext } from "./finance-execution-safety.test-support.js";
import { commitFinanceSchedulerDatabaseState } from "./finance-scheduler-ledger.js";
import type {
  FinanceTradeDecisionReviewRequest,
  FinanceTradeDecisionReviewResult,
} from "./finance-trade-decision-review.js";
import type {
  FinanceTradeReviewModelCallEvidence,
  FinanceTradeReviewToolEvidence,
} from "./finance-trade-review-evidence.js";
const mocks = vi.hoisted(() => ({
  collect: vi.fn(),
  order: vi.fn(),
  paper: vi.fn(),
  venue: vi.fn(),
  ledger: vi.fn(),
  projection: vi.fn(),
  appendReceipt: vi.fn(),
  appendMark: vi.fn(),
}));
vi.mock("./finance-free-market-collection-adapters.js", () => ({
  createChinaReachableUsEodHistoryCollectionAdapter: () => ({ collect: mocks.collect }),
}));
vi.mock("./finance-alpaca-run.js", () => ({
  fetchAlpacaVenueState: mocks.venue,
  runFinanceAlpacaOrder: mocks.order,
}));
vi.mock("./finance-paper-run.js", () => ({ runFinancePaperOrder: mocks.paper }));
vi.mock("./finance-bar-ledger.js", () => ({
  appendFinanceBars: async () => ({ repeatsSkipped: 0, appended: true }),
}));
vi.mock("./finance-position-ledger.js", () => ({
  readFinancePositionLedger: mocks.ledger,
  projectFinancePositions: mocks.projection,
  appendFinanceExecutionReceipt: mocks.appendReceipt,
  appendFinancePositionMark: mocks.appendMark,
}));
import {
  runFinanceDailyCycle,
  type FinanceDailyCycleExecutionQuote,
} from "./finance-daily-cycle.js";
const asOf = "2026-09-22T19:30:00.000Z";
const params = {
  createSafetyContext: syntheticSafetyContext,
  instruments: ["AAPL", "MSFT"],
  equity: 100000,
  asOf,
  caps: { maxOrderNotional: 1000, maxInstrumentNotional: 2000, maxOrdersPerRun: 2 },
  runAuthorizationId: "synthetic",
  place: true,
  venue: "alpaca" as const,
  directory: "/synthetic/not-written",
  tradeDecisionReviewer: async (
    request: FinanceTradeDecisionReviewRequest,
  ): Promise<FinanceTradeDecisionReviewResult> => ({
    status: "completed",
    attempted: true,
    provider: "fixture-provider",
    modelId: "fixture-model",
    latencyMs: 1,
    providerCallObserved: true,
    adapterAttested: true,
    decisions: request.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      decision: "approve",
      rationale: "Fixture approves the exact candidate for downstream safety checks.",
    })),
  }),
};
function quotes(change: Partial<FinanceDailyCycleExecutionQuote> = {}) {
  return new Map(
    params.instruments.map((symbol) => [
      symbol,
      {
        referencePrice: 250,
        referencePriceAt: asOf,
        sourceUrlOrArtifact: "fixture://execution-quote",
        maxAgeMs: 1000,
        ...change,
      },
    ]),
  );
}
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.ledger.mockResolvedValue({ ledger: { positions: [] }, receipts: [], marks: [] });
  mocks.projection.mockReturnValue({ positions: [] });
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(asOf));
  // Deliberately old history remains research input, never a current executable quote.
  mocks.collect.mockResolvedValue(
    Array.from({ length: 500 }, (_, i) => {
      const date = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
      const close = 100 + i * 0.1 + Math.sin(i);
      return {
        providerName: "fixture",
        sourceUrlOrArtifact: "fixture://bars",
        sourceTimestamp: `${date}T20:00:00Z`,
        observedAt: asOf,
        data: { date, open: close, high: close + 1, low: close - 1, close, volume: 1000 },
      };
    }),
  );
  mocks.venue.mockResolvedValue({
    ok: true,
    state: { openOrders: new Map(), positions: new Map() },
  });
  mocks.order.mockResolvedValue({ ok: false, stage: "place", refusals: ["synthetic refusal"] });
  mocks.paper.mockResolvedValue({ ok: false, stage: "place", refusals: ["synthetic refusal"] });
});
describe("daily cycle execution data boundary", () => {
  it.each(["completed", "failed"] as const)(
    "retains bounded model-call provenance and tool-result linkage in the %s daily receipt",
    async (status) => {
      let modelCallEvidence: FinanceTradeReviewModelCallEvidence[] = [];
      let toolEvidence: FinanceTradeReviewToolEvidence[] = [];
      const reviewer = vi.fn(async (request: FinanceTradeDecisionReviewRequest) => {
        const candidateId = request.candidates[0].candidateId;
        toolEvidence = [
          {
            action: "max_drawdown",
            candidateId,
            accountId: "fixture-account",
            asOf,
            status: "completed",
            sourceRef: "fixture://bounded-evidence",
            requestSha256: "a".repeat(64),
            resultSha256: "b".repeat(64),
            summary: "Recorded-history calculation only.",
            boundary: "recorded_daily_history_research_only_no_execution_or_fresh_quote",
          },
        ];
        modelCallEvidence = [
          {
            attempt: 1,
            callId: "fixture-request",
            payloadSha256: "c".repeat(64),
            outputSha256: "d".repeat(64),
            resultKind: "evidence_request",
            attestation: { status: "unattested" },
            evidenceRequests: [{ candidateId, action: "max_drawdown" }],
            hypothesis: "Check whether the recorded-history statistics support the candidate.",
          },
          {
            attempt: 2,
            callId: "fixture-followup",
            payloadSha256: "e".repeat(64),
            resultKind: status === "completed" ? "decision" : "failed",
            attestation: { status: "unattested" },
            toolEvidenceSha256: createHash("sha256")
              .update(JSON.stringify(toolEvidence))
              .digest("hex"),
          },
        ];
        const common = {
          status,
          attempted: true,
          provider: "fixture-provider",
          modelId: "fixture-model",
          latencyMs: 2,
          providerCallObserved: false,
          adapterAttested: false,
          modelCalls: 2,
          modelCallEvidence,
          toolEvidence,
        };
        return status === "completed"
          ? {
              ...common,
              status: "completed" as const,
              decisions: request.candidates.map((candidate) => ({
                candidateId: candidate.candidateId,
                decision: "veto" as const,
                rationale: "Fixture abstention after inspecting the supplied calculation.",
              })),
            }
          : { ...common, status: "failed" as const, failureCode: "process_error" as const };
      });
      const report = await runFinanceDailyCycle({
        ...params,
        executionQuotes: quotes(),
        tradeDecisionReviewer: reviewer,
      });
      // Serialization is the existing operator receipt boundary; no raw model context is retained.
      const receipt = JSON.parse(JSON.stringify(report)).tradeDecisionReview;
      expect(receipt.modelCallEvidence).toEqual(modelCallEvidence);
      expect(receipt.toolEvidence).toEqual(toolEvidence);
      expect(receipt.adapterAttested).toBe(false);
      expect(report.modelCalls).toBe(2);
      expect(reviewer).toHaveBeenCalledTimes(1);
      if (status === "completed") {
        expect(mocks.order).not.toHaveBeenCalled();
      } else {
        expect(receipt.failureCode).toBe("process_error");
        expect(mocks.order).toHaveBeenCalledTimes(2);
      }
    },
  );
  it("does not promote old EOD research bars into venue orders", async () => {
    const report = await runFinanceDailyCycle(params);
    expect(report.targets).toHaveLength(2);
    expect(report.refusals.join()).toContain("no execution quote");
    expect(report.ok).toBe(false);
    expect(mocks.order).not.toHaveBeenCalled();
  });
  it.each([
    { referencePriceAt: "2026-09-20T00:00:00Z" },
    { referencePriceAt: "2026-09-23T00:00:00Z" },
    { referencePriceAt: "invalid" },
    { sourceUrlOrArtifact: "" },
    { maxAgeMs: Number.POSITIVE_INFINITY },
    { referencePrice: 0 },
  ])("rejects unusable quote %j before any placement", async (change) => {
    const report = await runFinanceDailyCycle({ ...params, executionQuotes: quotes(change) });
    expect(report.ok).toBe(false);
    expect(mocks.order).not.toHaveBeenCalled();
  });
  it("records sanitized Alpaca quote HTTP status categories in refusals", async () => {
    const executionQuoteProvider = vi.fn(async () => {
      throw new AlpacaExecutionQuoteError("forbidden", 403);
    });

    const report = await runFinanceDailyCycle({ ...params, executionQuoteProvider });

    expect(report.refusals).toContain("AAPL: execution quote unavailable (forbidden_http_403)");
    expect(JSON.stringify(report)).not.toContain("synthetic-secret");
    expect(mocks.order).not.toHaveBeenCalled();
  });
  it("uses the independent current quote and reports placement refusal as failure", async () => {
    const report = await runFinanceDailyCycle({ ...params, executionQuotes: quotes() });
    expect(mocks.order).toHaveBeenCalledTimes(2);
    expect(mocks.order).toHaveBeenCalledWith(
      expect.objectContaining({ market: { referencePrice: 250, referencePriceAt: asOf } }),
    );
    expect(report.ok).toBe(false);
  });
  it("sends exact Alpaca Paper candidates for one bounded model review before execution", async () => {
    const reviewer = vi.fn(
      async (
        request: FinanceTradeDecisionReviewRequest,
      ): Promise<FinanceTradeDecisionReviewResult> => ({
        status: "completed",
        attempted: true,
        provider: "fixture-provider",
        modelId: "fixture-model",
        latencyMs: 7,
        providerCallObserved: true,
        adapterAttested: true,
        decisions: request.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          decision: "approve",
          rationale: "Approved only for the shared execution gates to continue.",
        })),
      }),
    );
    const report = await runFinanceDailyCycle({
      ...params,
      executionQuotes: quotes(),
      tradeDecisionReviewer: reviewer,
    });

    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(reviewer.mock.calls[0]?.[0]).toMatchObject({
      venue: "alpaca:paper",
      ruleIds: expect.any(Array),
      decisionContext: expect.objectContaining({
        schemaVersion: "lcx_finance_thesis_decision_context_v1",
        activeThesisCount: 0,
        theses: [],
        fundamentals: expect.objectContaining({
          instruments: expect.arrayContaining([
            expect.objectContaining({ instrument: "AAPL", status: "missing_or_outside_window" }),
          ]),
        }),
      }),
      candidates: expect.arrayContaining([
        expect.objectContaining({
          instrument: "AAPL",
          side: "buy",
          annualisedVol: expect.any(Number),
          researchClose: expect.any(Number),
          executionQuote: expect.objectContaining({
            referencePrice: 250,
            referencePriceAt: asOf,
            ageMs: 0,
          }),
        }),
      ]),
    });
    expect(report).toMatchObject({
      modelCalls: 1,
      tradeDecisionReview: {
        status: "completed",
        candidateCount: 2,
        provider: "fixture-provider",
        latencyMs: 7,
        decisionContext: expect.objectContaining({
          schemaVersion: "lcx_finance_thesis_decision_context_v1",
          activeThesisCount: 0,
          theses: [],
        }),
        candidateInputs: expect.arrayContaining([
          expect.objectContaining({
            instrument: "AAPL",
            executionQuote: expect.objectContaining({ referencePrice: 250 }),
          }),
        ]),
      },
    });
    expect(mocks.order).toHaveBeenCalledTimes(2);
  });
  it("refreshes expired Alpaca quotes after a slow advisory review", async () => {
    let executionAt = Date.parse(asOf);
    const executionQuoteProvider = vi.fn(async () => ({
      referencePrice: 250,
      referencePriceAt: new Date(executionAt).toISOString(),
      sourceUrlOrArtifact: "fixture://execution-quote",
      bidPrice: 249,
      askPrice: 250,
      maxAgeMs: 30_000,
    }));
    const tradeDecisionReviewer = vi.fn(async (request: FinanceTradeDecisionReviewRequest) => {
      executionAt += 40_000;
      return {
        status: "completed" as const,
        attempted: true,
        provider: "fixture-provider",
        modelId: "fixture-model",
        latencyMs: 40_000,
        providerCallObserved: true,
        adapterAttested: true,
        decisions: request.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          decision: "approve" as const,
          rationale: "Approved only for the shared execution gates to continue.",
        })),
      };
    });

    await runFinanceDailyCycle({
      ...params,
      executionQuoteProvider,
      executionNow: () => executionAt,
      tradeDecisionReviewer,
    });

    expect(executionQuoteProvider).toHaveBeenCalledTimes(4);
    expect(mocks.order).toHaveBeenCalledTimes(2);
    expect(mocks.order).toHaveBeenCalledWith(
      expect.objectContaining({
        market: {
          referencePrice: 250,
          referencePriceAt: new Date(Date.parse(asOf) + 40_000).toISOString(),
        },
      }),
    );
  });
  it.each([
    { askPrice: 260, referencePrice: 260 },
    { bidPrice: 248 },
    { sourceUrlOrArtifact: "fixture://different-source" },
    { feed: "changed-feed" },
    { maxAgeMs: 60_000 },
  ])("does not reuse daily approval after refreshed quote terms change: %j", async (changed) => {
    let executionAt = Date.parse(asOf);
    let reviewed = false;
    const executionQuoteProvider = vi.fn(async () => ({
      referencePrice: 250,
      referencePriceAt: new Date(executionAt).toISOString(),
      sourceUrlOrArtifact: "fixture://execution-quote",
      bidPrice: 249,
      askPrice: 250,
      maxAgeMs: 30_000,
      ...(reviewed ? changed : {}),
    }));
    const report = await runFinanceDailyCycle({
      ...params,
      executionQuoteProvider,
      executionNow: () => executionAt,
      tradeDecisionReviewer: async (request) => {
        const result = await params.tradeDecisionReviewer(request);
        reviewed = true;
        executionAt += 40_000;
        return result;
      },
    });
    expect(executionQuoteProvider).toHaveBeenCalledTimes(4);
    expect(mocks.order).not.toHaveBeenCalled();
    expect(report.refusals.join()).toContain("execution quote changed since model review");
  });
  it("retries a transient pre-review quote failure with a fresh quote when review is not needed", async () => {
    const executionQuoteProvider = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary quote read failure"))
      .mockRejectedValueOnce(new Error("temporary quote read failure"))
      .mockResolvedValue({
        referencePrice: 250,
        referencePriceAt: asOf,
        sourceUrlOrArtifact: "fixture://execution-quote",
        bidPrice: 249,
        askPrice: 250,
        maxAgeMs: 1000,
      });

    const report = await runFinanceDailyCycle({ ...params, executionQuoteProvider });

    expect(executionQuoteProvider).toHaveBeenCalledTimes(4);
    expect(report.tradeDecisionReview.status).toBe("not_needed");
    expect(mocks.order).toHaveBeenCalledTimes(2);
    expect(report.refusals.join()).not.toContain("candidate was not eligible for model review");
  });
  it.each([
    {
      errorMessage: "alpaca_safety_quote_expired",
      expectedRefusal: "AAPL: execution quote unavailable (alpaca_safety_quote_expired)",
    },
    {
      errorMessage: "synthetic provider secret",
      expectedRefusal: "AAPL: execution quote unavailable",
      hiddenText: "synthetic provider secret",
    },
  ])("preserves safe quote failure codes and redacts provider text", async (testCase) => {
    const executionQuoteProvider = vi.fn(async () => {
      throw new Error(testCase.errorMessage);
    });

    const report = await runFinanceDailyCycle({ ...params, executionQuoteProvider });

    expect(report.refusals).toContain(testCase.expectedRefusal);
    if ("hiddenText" in testCase) {
      expect(JSON.stringify(report)).not.toContain(testCase.hiddenText);
    }
    expect(mocks.order).not.toHaveBeenCalled();
  });
  it("treats a model veto as a successful abstention and does not dispatch", async () => {
    const report = await runFinanceDailyCycle({
      ...params,
      executionQuotes: quotes(),
      tradeDecisionReviewer: async (request) => ({
        status: "completed",
        attempted: true,
        provider: "fixture-provider",
        modelId: "fixture-model",
        latencyMs: 2,
        providerCallObserved: true,
        adapterAttested: true,
        decisions: request.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          decision: "veto" as const,
          rationale: "Fixture rejects the candidate.",
        })),
      }),
    });

    expect(
      report.ok,
      JSON.stringify({ dataIssues: report.dataIssues, refusals: report.refusals }),
    ).toBe(true);
    expect(report.refusals).toHaveLength(2);
    expect(report.refusals.join()).toContain("model vetoed");
    expect(report.placed).toHaveLength(0);
    expect(mocks.order).not.toHaveBeenCalled();
  });
  it.each(["unavailable", "output_truncated"] as const)(
    "routes deterministic daily candidates through the shared safety gate when review is %s",
    async (reviewMode) => {
      const report = await runFinanceDailyCycle({
        ...params,
        executionQuotes: quotes(),
        tradeDecisionReviewer:
          reviewMode === "unavailable"
            ? undefined
            : async () => ({
                status: "failed" as const,
                attempted: true,
                provider: "fixture-provider",
                modelId: "fixture-model",
                latencyMs: 2,
                providerCallObserved: true,
                adapterAttested: true,
                failureCode: "output_truncated" as const,
              }),
      });

      expect(report.ok).toBe(false);
      expect(report.modelCalls).toBe(reviewMode === "unavailable" ? 0 : 1);
      expect(report.tradeDecisionReview).toMatchObject({
        status: "failed",
        failureCode: reviewMode === "unavailable" ? "reviewer_unavailable" : "output_truncated",
      });
      expect(mocks.order).toHaveBeenCalledTimes(2);
      expect(mocks.order).toHaveBeenCalledWith(
        expect.objectContaining({
          createSafetyContext: syntheticSafetyContext,
          budget: expect.objectContaining({ maxOrderNotional: 1000, maxOrdersPerRun: 2 }),
        }),
      );
      expect(report.refusals.join()).toContain("synthetic refusal");
    },
  );

  it("does not default approve a completed but unbound daily review result", async () => {
    const report = await runFinanceDailyCycle({
      ...params,
      executionQuotes: quotes(),
      tradeDecisionReviewer: async () => ({
        status: "completed" as const,
        attempted: true,
        provider: "fixture-provider",
        modelId: "fixture-model",
        latencyMs: 2,
        providerCallObserved: true,
        adapterAttested: true,
        decisions: [],
      }),
    });

    expect(report.tradeDecisionReview).toMatchObject({
      status: "failed",
      failureCode: "output_invalid",
    });
    expect(report.refusals.join()).toContain("completed model review violated candidate binding");
    expect(mocks.order).not.toHaveBeenCalled();
  });
  it("stops the entire book when a submitted order is uncertain", async () => {
    const { AlpacaOrderUncertainError } = await import("./finance-alpaca-execution-adapter.js");
    mocks.order.mockRejectedValueOnce(
      new AlpacaOrderUncertainError(
        "fixture-client",
        "fixture-order",
        new Error("synthetic unknown"),
      ),
    );
    const report = await runFinanceDailyCycle({ ...params, executionQuotes: quotes() });
    expect(mocks.order).toHaveBeenCalledTimes(1);
    expect(report.ok).toBe(false);
    expect(report.dataIssues.join()).toContain("stopped remaining orders");
    expect(report.refusals).toContain(
      "MSFT: not attempted after AAPL execution outcome became uncertain; pending reconciliation",
    );
  });
  it("validates lazy quotes against current control clock, not historical strategy asOf", async () => {
    const now = Date.parse(asOf) + 600000;
    const executionQuoteProvider = vi.fn(async () => ({
      ...quotes().get("AAPL")!,
      referencePriceAt: new Date(now).toISOString(),
      bidPrice: 249,
      askPrice: 251,
    }));
    await runFinanceDailyCycle({ ...params, executionNow: () => now, executionQuoteProvider });
    expect(executionQuoteProvider).toHaveBeenCalledTimes(2);
    expect(mocks.order).toHaveBeenCalledWith(
      expect.objectContaining({
        market: { referencePrice: 251, referencePriceAt: new Date(now).toISOString() },
      }),
    );
  });
  it("rejects a quote that ages during collection", async () => {
    const executionQuoteProvider = vi.fn(async () => ({
      ...quotes().get("AAPL")!,
      bidPrice: 249,
      askPrice: 251,
    }));
    const report = await runFinanceDailyCycle({
      ...params,
      executionNow: () => Date.parse(asOf) + 5000,
      executionQuoteProvider,
    });
    expect(report.refusals.join()).toContain("stale");
    expect(mocks.order).not.toHaveBeenCalled();
  });
  it("bounds a provider that never settles without placing an order", async () => {
    vi.useFakeTimers();
    try {
      const executionQuoteProvider = vi.fn(
        () => new Promise<FinanceDailyCycleExecutionQuote>(() => {}),
      );
      const run = runFinanceDailyCycle({
        ...params,
        instruments: ["AAPL"],
        executionQuoteProvider,
      });
      await vi.runAllTimersAsync();
      const report = await run;
      expect(report.refusals.join()).toContain("execution quote timeout");
      expect(mocks.order).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("reports only allowlisted Alpaca safety codes from quote failures", async () => {
    const executionQuoteProvider = vi
      .fn()
      .mockRejectedValue(new Error("alpaca_safety_quote_expired"));
    const report = await runFinanceDailyCycle({
      ...params,
      instruments: ["AAPL"],
      executionQuoteProvider,
    });
    expect(report.refusals.join()).toContain(
      "execution quote unavailable (alpaca_safety_quote_expired)",
    );
  });
  it("does not echo unknown Alpaca-prefixed provider errors", async () => {
    const executionQuoteProvider = vi
      .fn()
      .mockRejectedValue(new Error("alpaca_safety_fake_secret_value"));
    const report = await runFinanceDailyCycle({
      ...params,
      instruments: ["AAPL"],
      executionQuoteProvider,
    });
    expect(report.refusals.join()).toContain("execution quote unavailable");
    expect(report.refusals.join()).not.toContain("fake_secret_value");
  });
  it("keeps local paper simulation usable without an execution feed", async () => {
    const report = await runFinanceDailyCycle({ ...params, venue: "paper" });
    expect(report.modelCalls).toBe(0);
    expect(mocks.paper).toHaveBeenCalledTimes(2);
    expect(mocks.order).not.toHaveBeenCalled();
  });

  it("refuses venue execution when the latest position mark is ahead of the latest EOD bar", async () => {
    const staleBarClose = 100 + 499 * 0.1 + Math.sin(499);
    mocks.ledger.mockResolvedValue({
      ledger: { positions: [] },
      receipts: [],
      marks: [
        {
          instrument: "AAPL",
          price: staleBarClose + 1,
          at: "2026-09-21T12:00:00.000Z",
        },
      ],
    });
    mocks.projection.mockReturnValue({
      positions: [
        {
          instrument: "AAPL",
          quantity: 1,
          averageCost: 100,
          realizedPnl: 0,
          markPrice: staleBarClose + 1,
          markAt: "2026-09-21T12:00:00.000Z",
          marketValue: staleBarClose + 1,
          unrealizedPnl: 1,
        },
      ],
    });
    mocks.venue.mockResolvedValue({
      ok: true,
      state: { openOrders: new Map(), positions: new Map([["AAPL", 1]]) },
    });

    const report = await runFinanceDailyCycle({ ...params, executionQuotes: quotes() });

    expect(report.refusals.join()).toContain("mark/bar consistency gate failed");
    expect(mocks.order).toHaveBeenCalledTimes(1);
    expect(mocks.order).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: expect.objectContaining({ instrument: "MSFT" }) }),
    );
  });
});

it("does not dispatch even with good quote when controller facts are unavailable", async () => {
  const report = await runFinanceDailyCycle({
    ...params,
    createSafetyContext: undefined,
    executionQuotes: quotes(),
  });
  expect(report.refusals.join()).toContain("execution_safety_context_required");
  expect(mocks.order).not.toHaveBeenCalled();
});

it("stops later orders when the final safety gate reports an unresolved execution", async () => {
  mocks.order.mockRejectedValueOnce(
    new FinanceExecutionSafetyUncertainError("synthetic-claim", new Error("lost response")),
  );
  const report = await runFinanceDailyCycle({ ...params, executionQuotes: quotes() });
  expect(mocks.order).toHaveBeenCalledTimes(1);
  expect(report.dataIssues.join()).toContain("stopped remaining orders");
});

it.each(["alpaca", "paper"] as const)(
  "does not execute %s when the ledger cannot be read",
  async (venue) => {
    mocks.ledger.mockRejectedValueOnce(new Error("database corrupt"));
    await expect(
      runFinanceDailyCycle({ ...params, venue, executionQuotes: quotes() }),
    ).rejects.toThrow("unknown holdings cannot be treated as flat");
    expect(mocks.order).not.toHaveBeenCalled();
    expect(mocks.paper).not.toHaveBeenCalled();
  },
);

it("stops placement when the sizing read fails after successful repricing", async () => {
  mocks.ledger
    .mockResolvedValueOnce({ ledger: { positions: [] }, receipts: [], marks: [] })
    .mockRejectedValueOnce(new Error("database disconnected"));
  await expect(runFinanceDailyCycle({ ...params, executionQuotes: quotes() })).rejects.toThrow(
    "unknown holdings cannot be treated as flat",
  );
  expect(mocks.order).not.toHaveBeenCalled();
});

it("uses the controller account book without reading or repricing unrelated receipt holdings", async () => {
  mocks.ledger.mockRejectedValue(new Error("legacy book must not be consumed"));
  const report = await runFinanceDailyCycle({
    ...params,
    accountId: "bound-account",
    executionQuotes: quotes(),
    accountBookProvider: async () => ({
      accountId: "bound-account",
      venue: "alpaca:paper",
      equity: 100000,
      observedAt: asOf,
      expiresAt: new Date(Date.parse(asOf) + 60000).toISOString(),
      positions: [{ instrument: "AAPL", quantity: 200, marketValue: 50000 }],
    }),
  });
  expect(report.drift.find((row) => row.instrument === "AAPL")?.action).toBe("none");
  expect(mocks.ledger).not.toHaveBeenCalled();
  expect(mocks.venue).not.toHaveBeenCalled();
  expect(mocks.order).toHaveBeenCalledTimes(1);
});

it("refuses a controller account book belonging to a different account", async () => {
  await expect(
    runFinanceDailyCycle({
      ...params,
      accountId: "bound-account",
      accountBookProvider: async () => ({
        accountId: "other-account",
        venue: "alpaca:paper",
        equity: 100000,
        observedAt: asOf,
        expiresAt: new Date(Date.parse(asOf) + 60000).toISOString(),
        positions: [],
      }),
    }),
  ).rejects.toThrow("account-bound position snapshot invalid");
  expect(mocks.order).not.toHaveBeenCalled();
});

it("keeps quarantined targets out of dispatch and sizes other targets after the uncertainty reserve", async () => {
  const reconciliation = {
    status: "restricted" as const,
    historyStatus: "unresolved" as const,
    quarantinedInstruments: ["AAPL"],
    uncertaintyReserve: 10,
    reasons: ["synthetic gap"],
  };
  const report = await runFinanceDailyCycle({
    ...params,
    accountId: "bound-account",
    executionQuotes: quotes(),
    accountBookProvider: async () => ({
      accountId: "bound-account",
      venue: "alpaca:paper",
      equity: 100000,
      observedAt: asOf,
      expiresAt: new Date(Date.parse(asOf) + 60000).toISOString(),
      positions: [],
      reconciliation,
    }),
  });
  expect(report.positionBook).toMatchObject({ sizingEquity: 99990, reconciliation });
  expect(report.refusals.join()).toContain("historical quantity difference quarantined");
  expect(mocks.order).toHaveBeenCalledTimes(1);
  expect(mocks.order).toHaveBeenCalledWith(
    expect.objectContaining({ conclusion: expect.objectContaining({ instrument: "MSFT" }) }),
  );
});

it("delivers account attribution through the daily judgment and its durable report", async () => {
  const economics = {
    accountId: "paper-account",
    venue: "alpaca:paper" as const,
    asOf,
    status: "observed" as const,
    inheritedGrossPnl: 61.25,
    newDecisionGrossPnl: 0,
    historicalCashFees: 4.05,
    pendingFees: "unknown" as const,
    modelBill: null,
  };
  const read = vi
    .spyOn(accountEconomicsReader, "readFinanceAccountEconomicFeedback")
    .mockResolvedValue(economics);
  const reviewer = vi.fn(params.tradeDecisionReviewer);
  const report = await runFinanceDailyCycle({
    ...params,
    accountId: "paper-account",
    executionQuotes: quotes(),
    tradeDecisionReviewer: reviewer,
  });
  expect(read).toHaveBeenCalledWith(params.directory, "paper-account", asOf);
  expect(reviewer).toHaveBeenCalledOnce();
  expect(reviewer.mock.calls[0][0].accountEconomics).toEqual(economics);
  expect(report.tradeDecisionReview.accountEconomics).toEqual(economics);
});

it.each([
  { instrument: "MSFT", quantity: 240, marketValue: 60000, firstSide: "sell", refusal: "none" },
  { instrument: "AAPL", quantity: 40, marketValue: 10000, firstSide: "buy", refusal: "none" },
  { instrument: "AAPL", quantity: 40, marketValue: 10000, firstSide: "buy", refusal: "veto" },
  { instrument: "AAPL", quantity: 40, marketValue: 10000, firstSide: "buy", refusal: "gate" },
  {
    instrument: "AAPL",
    quantity: 40,
    marketValue: 10000,
    firstSide: "buy",
    refusal: "none",
    filledQuantity: 2,
  },
])(
  "prioritizes allocation convergence over symbol order ($firstSide/$refusal)",
  async (holding) => {
    const filledQuantity = holding.filledQuantity ?? 4;
    const historyRead = vi.spyOn(dailyHistoryReader, "readFinanceDailyDecisionHistory");
    mocks.order.mockImplementation(async (request) => {
      if (holding.refusal === "gate" && request.conclusion.instrument === "MSFT") {
        return { ok: false, stage: "gate", refusals: ["fixture definite gate rejection"] };
      }
      if (request.ordersPlacedThisRun >= request.budget.maxOrdersPerRun) {
        return { ok: false, stage: "gate", refusals: ["fixture order limit"] };
      }
      return {
        ok: true,
        receipt: {
          schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
          receiptId: "priority-fill",
          intentId: "priority-intent",
          runAuthorizationId: "synthetic",
          adapterId: "fixture",
          adapterKind: "venue",
          venue: "alpaca:paper",
          instrument: request.conclusion.instrument,
          side: request.conclusion.direction,
          orderType: "market",
          quantity: 4,
          referencePrice: 250,
          referencePriceAt: asOf,
          notional: 1000,
          fill: { filledQuantity, fillPrice: 250, filledAt: asOf, venueRef: "fixture-fill" },
          executionAuthority: "declared_execution_adapter_required",
          recordedAt: asOf,
        },
      };
    });
    const report = await runFinanceDailyCycle({
      ...params,
      // Keep both buys feasible under the same exposure rule as the durable gate;
      // this scenario isolates priority and the single available order slot.
      caps: { ...params.caps, maxInstrumentNotional: 60_000, maxOrdersPerRun: 1 },
      tradeDecisionReviewer: async (request) => {
        const reviewed = await params.tradeDecisionReviewer(request);
        return {
          ...reviewed,
          decisions: reviewed.decisions?.map((decision) => ({
            ...decision,
            decision:
              holding.refusal === "veto" &&
              request.candidates.find((candidate) => candidate.candidateId === decision.candidateId)
                ?.instrument === "MSFT"
                ? ("veto" as const)
                : ("approve" as const),
          })),
        };
      },
      accountId: "bound-account",
      executionQuotes: quotes(),
      accountBookProvider: async () => ({
        accountId: "bound-account",
        venue: "alpaca:paper",
        equity: 100000,
        observedAt: asOf,
        expiresAt: new Date(Date.parse(asOf) + 60000).toISOString(),
        positions: [holding],
      }),
    });
    expect(report.drift).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ instrument: "AAPL", action: "buy" }),
        expect.objectContaining({ instrument: "MSFT", action: holding.firstSide }),
      ]),
    );
    expect(historyRead.mock.calls[0][0].instruments?.[0]).toBe("MSFT");
    if (holding.refusal !== "none") {
      expect(report.placed).toEqual([{ instrument: "AAPL", quantity: 4, notional: 1000 }]);
      const accepted = mocks.order.mock.calls.find(
        ([request]) => request.conclusion.instrument === "AAPL",
      );
      expect(accepted?.[0].ordersPlacedThisRun).toBe(0);
      expect(mocks.order).toHaveBeenCalledTimes(holding.refusal === "veto" ? 1 : 2);
      expect(report.refusals.join(" ")).toContain(
        holding.refusal === "veto" ? "model vetoed" : "definite gate rejection",
      );
      return;
    }
    expect(mocks.order.mock.calls[0][0].conclusion).toMatchObject({
      instrument: "MSFT",
      direction: holding.firstSide,
    });
    expect(report.placed).toEqual([
      { instrument: "MSFT", quantity: filledQuantity, notional: filledQuantity * 250 },
    ]);
    expect(mocks.order.mock.calls[1][0].ordersPlacedThisRun).toBe(1);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "limited-order-history-"));
    try {
      commitFinanceSchedulerDatabaseState(directory, "{}", [
        {
          runId: `limited-${holding.firstSide}`,
          mode: "day",
          firedAt: report.asOf,
          completedAt: new Date(Date.parse(report.asOf) + 1000).toISOString(),
          outputTruncated: false,
          execution: { placementEnabled: true, venue: "alpaca" },
          stdout: JSON.stringify({
            ...report,
            mode: "day",
            ruleIds: ["fixture-daily-trend"],
            positionBook: { source: "controller_account", accountId: "bound-account" },
          }),
        },
      ]);
      const history = dailyHistoryReader.readFinanceDailyDecisionHistory({
        directory,
        accountId: "bound-account",
        asOf: new Date(Date.parse(report.asOf) + 2000).toISOString(),
        instruments: ["MSFT", "AAPL"],
      });
      expect(history.entries.find((entry) => entry.instrument === "AAPL")).toMatchObject({
        decision: "approve",
        reportedPlacement: null,
        refusals: ["AAPL: fixture order limit"],
      });
      expect(history.entries.find((entry) => entry.instrument === "MSFT")).toMatchObject({
        decision: "approve",
        proposedNotional: 1000,
        reportedPlacement: { quantity: filledQuantity, notional: filledQuantity * 250 },
        refusals: [],
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.each(["receipt_write", "mark_write", "no_fill"] as const)(
  "stops the remaining portfolio after accepted execution cannot be projected (%s)",
  async (mode) => {
    if (mode === "receipt_write") {
      mocks.appendReceipt.mockRejectedValueOnce(new Error("fixture disk failure"));
    }
    if (mode === "mark_write") {
      mocks.appendMark.mockRejectedValueOnce(new Error("fixture mark failure"));
    }
    mocks.order.mockImplementation(async (request) => ({
      ok: true,
      receipt: {
        schemaVersion: FINANCE_EXECUTION_RECEIPT_SCHEMA,
        receiptId: "accepted-fill",
        intentId: "accepted-intent",
        runAuthorizationId: "synthetic",
        adapterId: "fixture",
        adapterKind: "venue",
        venue: "alpaca:paper",
        instrument: request.conclusion.instrument,
        side: request.conclusion.direction,
        orderType: "market",
        quantity: 4,
        referencePrice: 250,
        referencePriceAt: asOf,
        notional: 1000,
        fill: {
          filledQuantity: mode === "no_fill" ? 0 : 4,
          fillPrice: 250,
          filledAt: asOf,
          venueRef: "fixture-accepted-order",
        },
        executionAuthority: "declared_execution_adapter_required",
        recordedAt: asOf,
      },
    }));
    const report = await runFinanceDailyCycle({ ...params, executionQuotes: quotes() });
    expect(report.ok).toBe(false);
    expect(mocks.order).toHaveBeenCalledOnce();
    expect(report.dataIssues.join(" ")).toContain(
      "stopped remaining orders pending reconciliation",
    );
    expect(report.placed).toHaveLength(mode === "mark_write" ? 1 : 0);
    expect(report.dataIssues.join(" ")).toContain("receiptId=accepted-fill");
    expect(report.dataIssues.join(" ")).toContain("venueRef=fixture-accepted-order");
    expect(report.refusals).toContain(
      "MSFT: not attempted after AAPL accepted execution projection incomplete; pending reconciliation",
    );
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stopped-cycle-history-"));
    try {
      commitFinanceSchedulerDatabaseState(directory, "{}", [
        {
          runId: `stopped-${mode}`,
          mode: "day",
          firedAt: report.asOf,
          completedAt: new Date(Date.parse(report.asOf) + 1000).toISOString(),
          outputTruncated: false,
          execution: { placementEnabled: true, venue: "alpaca" },
          stdout: JSON.stringify({
            ...report,
            mode: "day",
            ruleIds: ["fixture-daily-trend"],
            positionBook: { source: "controller_account", accountId: "fixture-history" },
          }),
        },
      ]);
      const history = dailyHistoryReader.readFinanceDailyDecisionHistory({
        directory,
        accountId: "fixture-history",
        asOf: new Date(Date.parse(report.asOf) + 2000).toISOString(),
        instruments: ["MSFT"],
      });
      expect(history.entries[0]).toMatchObject({
        decision: "approve",
        reportedPlacement: null,
        refusals: [
          "MSFT: not attempted after AAPL accepted execution projection incomplete; pending reconciliation",
        ],
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.each(["approve", "veto", "skipped", "partial"] as const)(
  "consumes verified prior daily %s in the next candidate judgment",
  async (priorDecision) => {
    const recordedDecision = priorDecision === "veto" ? "veto" : "approve";
    const partial = priorDecision === "partial";
    const previousRefusal =
      priorDecision === "skipped"
        ? "AAPL: not attempted after MSFT execution outcome became uncertain; pending reconciliation"
        : "AAPL: no prior execution";
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "daily-consumer-"));
    const priorAt = "2026-09-21T19:30:00.000Z";
    try {
      commitFinanceSchedulerDatabaseState(directory, "{}", [
        {
          runId: "previous-decision",
          mode: "day",
          firedAt: priorAt,
          completedAt: "2026-09-21T19:31:00.000Z",
          outputTruncated: false,
          execution: { placementEnabled: true, venue: "alpaca" },
          stdout: JSON.stringify({
            mode: "day",
            asOf: priorAt,
            ruleIds: ["daily-trend"],
            positionBook: { source: "controller_account", accountId: "bound-account" },
            tradeDecisionReview: {
              status: "completed",
              candidateInputs: [
                {
                  candidateId: "previous-aapl",
                  instrument: "AAPL",
                  side: "buy",
                  targetWeight: 0.4,
                  currentWeight: 0,
                  notional: 1000,
                },
              ],
              decisions: [
                {
                  candidateId: "previous-aapl",
                  decision: recordedDecision,
                  rationale: "Fixture historical mechanism evidence.",
                },
              ],
            },
            placed: partial ? [{ instrument: "AAPL", quantity: 2, notional: 500 }] : [],
            refusals: partial ? [] : [previousRefusal],
          }),
        },
      ]);
      // Unrelated/no-review rounds must not erase the last applicable decision.
      commitFinanceSchedulerDatabaseState(
        directory,
        "{}",
        Array.from({ length: 24 }, (_, i) => ({
          runId: `non-decision-${i}`,
          mode: "day",
          firedAt: priorAt,
          completedAt: "2026-09-21T19:32:00.000Z",
          stdout: "{}",
        })),
      );
      const reviewer = vi.fn(
        async (
          request: FinanceTradeDecisionReviewRequest,
        ): Promise<FinanceTradeDecisionReviewResult> => {
          const result = await params.tradeDecisionReviewer(request);
          if (!("decisionHistory" in request)) {
            throw new Error("history was not delivered");
          }
          expect(request.decisionHistory?.entries[0]).toMatchObject({
            runId: "previous-decision",
            decision: recordedDecision,
            reportedPlacement: partial ? { quantity: 2, notional: 500 } : null,
            refusals: partial ? [] : [previousRefusal],
          });
          // Scripted consumer proves the source-to-decision wiring, not natural model adoption.
          return {
            ...result,
            decisions: request.candidates.map((candidate) => ({
              candidateId: candidate.candidateId,
              decision:
                candidate.instrument === "AAPL" &&
                request.decisionHistory?.entries[0]?.decision === "veto"
                  ? "veto"
                  : "approve",
              rationale:
                "Fixture re-evaluates the supplied previous hypothesis against unchanged current evidence.",
            })),
          };
        },
      );
      const report = await runFinanceDailyCycle({
        ...params,
        directory,
        caps: { ...params.caps, maxInstrumentNotional: 1000 },
        executionQuotes: quotes(),
        accountId: "bound-account",
        accountBookProvider: async () => ({
          accountId: "bound-account",
          venue: "alpaca:paper",
          equity: 100000,
          observedAt: asOf,
          expiresAt: new Date(Date.parse(asOf) + 60000).toISOString(),
          positions: partial ? [{ instrument: "AAPL", quantity: 2, marketValue: 500 }] : [],
        }),
        tradeDecisionReviewer: reviewer,
      });
      expect(reviewer).toHaveBeenCalledOnce();
      expect(report.tradeDecisionReview.decisionHistory?.entries[0].decision).toBe(
        recordedDecision,
      );
      expect(
        mocks.order.mock.calls.some(([request]) => request.conclusion.instrument === "AAPL"),
      ).toBe(recordedDecision === "approve");
      if (recordedDecision === "approve") {
        const order = mocks.order.mock.calls.find(
          ([request]) => request.conclusion.instrument === "AAPL",
        );
        expect(order?.[0].targetWeightAuthorization.maxOrderNotional).toBe(partial ? 500 : 1000);
      }
      expect(
        mocks.order.mock.calls.some(([request]) => request.conclusion.instrument === "MSFT"),
      ).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.each([
  { cash: 1500, stale: false, expensive: false },
  { cash: 0, stale: false, expensive: false },
  { cash: 1500, stale: true, expensive: false },
  { cash: 1500, stale: false, expensive: true },
  { cash: 1500, stale: false, expensive: false, sharePrice: 1000 },
  { cash: 1500, stale: false, expensive: false, sharePrice: 600 },
  { cash: 1500, stale: false, expensive: false, sharePrice: 600.1234 },
  { cash: 1500, stale: false, expensive: true, sharePrice: 1000.01 },
])(
  "budgets reviewed daily buys across the observed account funds ($cash, stale=$stale, expensive=$expensive, price=$sharePrice)",
  async ({ cash, stale, expensive, sharePrice }) => {
    const executionQuotes = quotes();
    if (stale) {
      executionQuotes.set("AAPL", {
        ...executionQuotes.get("AAPL")!,
        referencePriceAt: "2026-09-21T19:30:00.000Z",
      });
    }
    if (expensive || sharePrice !== undefined) {
      executionQuotes.set("AAPL", {
        ...executionQuotes.get("AAPL")!,
        referencePrice: sharePrice ?? 2000,
      });
    }
    const report = await runFinanceDailyCycle({
      ...params,
      accountId: "funded-account",
      executionQuotes,
      accountBookProvider: async () => ({
        accountId: "funded-account",
        venue: "alpaca:paper",
        observedAt: asOf,
        expiresAt: new Date(Date.parse(asOf) + 60_000).toISOString(),
        equity: 100000,
        positions: [],
        reconciliation: {
          status: "ready",
          historyStatus: "reconciled",
          quarantinedInstruments: [],
          uncertaintyReserve: 0,
          reasons: [],
        },
        executionCapacity: {
          source: "controller_account_safety_facts",
          accountId: "funded-account",
          venue: "alpaca:paper",
          observedAt: asOf,
          expiresAt: new Date(Date.parse(asOf) + 60_000).toISOString(),
          policyPlanId: "fixture",
          policyRevision: "1",
          grossExposure: 0,
          maxGrossExposure: 100000,
          uncertaintyReserve: 0,
          availableCash: cash,
        },
      }),
    });
    if (expensive) {
      expect(report.drift.find((item) => item.instrument === "AAPL")).toMatchObject({
        action: "none",
        notional: 0,
      });
      expect(report.refusals.join()).toContain("cannot fund one whole share; target remains unmet");
    }
    if (stale || expensive) {
      expect(
        report.tradeDecisionReview.candidateInputs?.map((c) => [c.instrument, c.notional]),
      ).toEqual([["MSFT", 1000]]);
      expect(mocks.order).toHaveBeenCalledOnce();
      expect(mocks.order.mock.calls[0][0].targetWeightAuthorization.maxOrderNotional).toBe(1000);
    } else if (sharePrice === 600 || sharePrice === 600.1234) {
      const firstBudget = sharePrice === 600 ? 600 : 600.13;
      expect(
        report.tradeDecisionReview.candidateInputs?.map((c) => [c.instrument, c.notional]),
      ).toEqual([
        ["AAPL", firstBudget],
        ["MSFT", 750],
      ]);
      expect(
        mocks.order.mock.calls.map(
          ([request]) => request.targetWeightAuthorization.maxOrderNotional,
        ),
      ).toEqual([firstBudget, 750]);
      expect(Math.floor(firstBudget / sharePrice)).toBe(1);
    } else if (cash > 0) {
      expect(
        report.tradeDecisionReview.candidateInputs?.map((c) => [c.instrument, c.notional]),
      ).toEqual([
        ["AAPL", 1000],
        ["MSFT", 500],
      ]);
      expect(
        mocks.order.mock.calls.map(
          ([request]) => request.targetWeightAuthorization.maxOrderNotional,
        ),
      ).toEqual([1000, 500]);
      expect(report.drift.map((item) => item.notional)).toEqual([1000, 500]);
    } else {
      expect(report.tradeDecisionReview.status).toBe("not_needed");
      expect(mocks.order).not.toHaveBeenCalled();
      expect(report.drift.every((item) => item.action === "none" && item.target > 0)).toBe(true);
      expect(report.refusals.join()).toContain("observed account funding; target remains unmet");
    }
  },
);
