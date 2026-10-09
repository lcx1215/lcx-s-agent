import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  buildFinanceFrameworkCoreContractPath,
  buildFinanceLearningCapabilityCandidatesPath,
  renderFinanceFrameworkCoreContractArtifact,
  renderFinanceLearningCapabilityCandidateArtifact,
} from "../hooks/bundled/lobster-brain-registry.js";
import { ArtifactStore } from "../memory/artifact-store.js";
import { appendFinanceBars } from "./finance-bar-ledger.js";
import { readFinanceBrokerInstrumentFeedback } from "./finance-broker-profit-feedback.js";
import {
  FinanceIntradayDecisionReviewReceiptSchema,
  appendFinanceIntradayDecision,
  appendFinanceIntradayOutcome,
  readFinanceIntradayOutcome,
} from "./finance-intraday-control-ledger.js";
import { buildFinanceNightReviewEvidence } from "./finance-night-review-context.js";
import { appendFinanceBrokerHistory } from "./finance-position-ledger.js";
import { financePositionLedgerPath } from "./finance-state-dir.js";
import {
  createFinanceTradeDecisionReviewer,
  FINANCE_INTRADAY_TRADE_DECISION_REVIEW_SCHEMA,
  type FinanceIntradayTradeDecisionReviewRequest,
} from "./finance-trade-decision-review.js";
import {
  createFinanceTradeReviewEvidenceExecutor,
  createFinanceTradeReviewFinancialCapabilities,
  describeFinanceTradeReviewFinancialCapabilities,
  FinanceTradeReviewEvidenceRequestSchema,
  type FinanceTradeReviewFinancialCapability,
} from "./finance-trade-review-evidence.js";
import { ModelAdapterError, type LogicalAgentModelAdapter } from "./logical-agent-model-router.js";
import * as barLedgerTools from "./tools/finance-bar-ledger-tool.js";
const dirs: string[] = [];
async function artifactScope() {
  const scope = await fixture();
  const dbPath = path.join(scope.directory, "artifact.sqlite");
  const config = {
    agents: { defaults: { workspace: scope.directory, memorySearch: { store: { path: dbPath } } } },
  };
  const relativePath = "state/recorded-result.json";
  await fs.mkdir(path.join(scope.directory, "state"), { recursive: true });
  await fs.writeFile(
    path.join(scope.directory, relativePath),
    JSON.stringify({ evidence: { rate: 31.01, causeVerified: false } }),
  );
  const store = ArtifactStore.open({ dbPath, workspaceDir: scope.directory });
  try {
    await store.register({
      id: "retained-event",
      owner: "workflow_delivery",
      runId: "retained",
      observedAt: "2026-09-01T00:00:00Z",
      relativePath,
      mimeType: "application/json",
      summary: "merger evidence, cancellation cause remains unknown",
    });
  } finally {
    store.close();
  }
  return { ...scope, artifactRecallOptions: { config, workspaceDir: scope.directory }, dbPath };
}

it("searches existing owner results and reads exact source fields inside one original review", async () => {
  const scope = await artifactScope();
  const before = await fs.readFile(scope.dbPath);
  const executor = createFinanceTradeReviewEvidenceExecutor(scope);
  const signal = new AbortController().signal;
  const [search] = await executor(
    [
      {
        candidateId: "signal",
        action: "artifact_search",
        owner: "workflow_delivery",
        query: "merger",
      },
    ],
    packet,
    signal,
  );
  expect(search.status).toBe("completed");
  expect(JSON.parse(search.summary).result.artifacts[0].id).toBe("retained-event");
  const [read] = await executor(
    [
      {
        candidateId: "signal",
        action: "artifact_read",
        artifactId: "retained-event",
        field: "/evidence",
      },
    ],
    packet,
    signal,
  );
  expect(read.status).toBe("completed");
  expect(JSON.parse(read.summary).result.selectedValue).toEqual({
    rate: 31.01,
    causeVerified: false,
  });
  expect(read.sourceRef).toBe("retained-event");
  expect(read.boundary).toBe(
    "recorded_financial_knowledge_research_only_not_market_or_account_facts",
  );
  expect(await fs.readFile(scope.dbPath)).toEqual(before);
  const [unselected] = await executor(
    [
      {
        candidateId: "signal",
        action: "artifact_read",
        artifactId: "retained-event",
        field: "/evidence",
      },
    ],
    { ...packet },
    signal,
  );
  expect(unselected.status).toBe("unavailable");
  expect(unselected.summary).toContain("artifact_not_selected_in_this_review");
});

it("preserves useful incomplete text and clearly exposes missing selected fields", async () => {
  const scope = await artifactScope();
  await fs.writeFile(path.join(scope.directory, "state/partial.json"), '{"price":31.01,"reason":');
  const store = ArtifactStore.open({ dbPath: scope.dbPath, workspaceDir: scope.directory });
  try {
    await store.register({
      id: "partial-event",
      owner: "workflow_delivery",
      runId: "partial",
      observedAt: "2026-09-01T00:00:00Z",
      relativePath: "state/partial.json",
      mimeType: "application/json",
      summary: "partial merger source",
    });
  } finally {
    store.close();
  }
  const executor = createFinanceTradeReviewEvidenceExecutor(scope),
    signal = new AbortController().signal;
  await executor(
    [
      {
        candidateId: "signal",
        action: "artifact_search",
        owner: "workflow_delivery",
        query: "partial",
      },
    ],
    packet,
    signal,
  );
  const [missing] = await executor(
    [
      {
        candidateId: "signal",
        action: "artifact_read",
        artifactId: "partial-event",
        field: "/price",
      },
    ],
    packet,
    signal,
  );
  expect(missing.status).toBe("unavailable");
  expect(missing.summary).toContain("artifact_field_json_unavailable");
  expect(missing.summary).toContain("31.01");
  const [page] = await executor(
    [
      {
        candidateId: "signal",
        action: "artifact_read",
        artifactId: "partial-event",
        textOffset: 0,
      },
    ],
    packet,
    signal,
  );
  expect(page.status).toBe("completed");
  expect(JSON.parse(page.summary).result.textPage).toBe('{"price":31.01,"reason":');
});

it("rejects foreign owners and arbitrary paths instead of expanding recall authority", () => {
  expect(
    FinanceTradeReviewEvidenceRequestSchema.safeParse({
      candidateId: "signal",
      action: "artifact_search",
      owner: "private_config",
      query: "x",
    }).success,
  ).toBe(false);
  expect(
    FinanceTradeReviewEvidenceRequestSchema.safeParse({
      candidateId: "signal",
      action: "artifact_read",
      artifactId: "x",
      field: "/value",
      path: "/tmp/private",
    }).success,
  ).toBe(false);
  expect(
    FinanceTradeReviewEvidenceRequestSchema.safeParse({
      candidateId: "signal",
      action: "artifact_read",
      artifactId: "x",
      field: "/value",
      textOffset: 0,
    }).success,
  ).toBe(false);
});

it("feeds a searched original field into call three without increasing the original review budget", async () => {
  const scope = await artifactScope();
  const payloads: unknown[] = [];
  const model = scripted(
    [
      {
        schemaVersion: packet.schemaVersion,
        evidenceRequests: [
          {
            candidateId: "signal",
            action: "artifact_search",
            owner: "workflow_delivery",
            query: "merger",
          },
        ],
        hypothesis: "Retrieve recorded event evidence for this doubt.",
      },
      {
        schemaVersion: packet.schemaVersion,
        evidenceRequests: [
          {
            candidateId: "signal",
            action: "artifact_read",
            artifactId: "retained-event",
            field: "/evidence",
          },
        ],
        hypothesis: "Read the retained source while keeping causality unknown.",
      },
      {
        schemaVersion: packet.schemaVersion,
        decisions: [
          {
            candidateId: "signal",
            decision: "veto",
            rationale:
              "The retained evidence leaves cancellation cause unknown; it is not current account or execution evidence.",
          },
        ],
      },
    ],
    payloads,
  );
  const reviewer = createFinanceTradeDecisionReviewer(
    {},
    { adapterFactory: model.factory, evidenceScope: scope },
  );
  const result = await reviewer(packet, AbortSignal.timeout(5000));
  expect(result).toMatchObject({
    status: "completed",
    modelCalls: 3,
    decisions: [{ decision: "veto" }],
  });
  expect((payloads[0] as Record<string, unknown>).evidenceArtifactRecallAvailable).toBe(true);
  expect(JSON.stringify(payloads[2])).toContain("causeVerified");
  expect(result.toolEvidence?.map((item) => item.action)).toEqual([
    "artifact_search",
    "artifact_read",
  ]);
  expect(result.modelCallEvidence?.map((item) => item.resultKind)).toEqual([
    "evidence_request",
    "evidence_request",
    "decision",
  ]);
  const { decisions: _decisions, ...metadata } = result;
  await appendFinanceIntradayDecision(scope.directory, {
    signalId: "signal",
    instrument: "AAA",
    sessionDate: "2026-09-30",
    action: "buy",
    reason: "opening_range_breakout",
    referencePrice: 100,
    referencePriceAt: asOf,
    datasetHeadRef: "a".repeat(64),
    strategyRule: "opening_range_breakout_long_next_bar_v1",
  });
  const receipt = FinanceIntradayDecisionReviewReceiptSchema.parse({
    ...metadata,
    request: packet,
    decision: result.decisions![0],
  });
  await appendFinanceIntradayOutcome(scope.directory, {
    signalId: "signal",
    status: "refused",
    reasons: ["scripted model veto"],
    tradeDecisionReview: receipt,
  });
  const stored = (await readFinanceIntradayOutcome(scope.directory, "signal"))?.tradeDecisionReview;
  expect(stored?.toolEvidence).toEqual(result.toolEvidence);
  expect(stored?.modelCallEvidence).toEqual(result.modelCallEvidence);
});

it("retains an exact-field gap and useful prefix within unchanged UTF8 evidence budgets", async () => {
  const scope = await artifactScope();
  await fs.writeFile(
    path.join(scope.directory, "state/long.json"),
    JSON.stringify({ value: "量化疑点".repeat(150) }),
  );
  const store = ArtifactStore.open({ dbPath: scope.dbPath, workspaceDir: scope.directory });
  try {
    await store.register({
      id: "long-event",
      owner: "workflow_delivery",
      runId: "long",
      observedAt: "2026-09-01T00:00:00Z",
      relativePath: "state/long.json",
      mimeType: "application/json",
      summary: "long merger source",
    });
  } finally {
    store.close();
  }
  const executor = createFinanceTradeReviewEvidenceExecutor(scope),
    signal = new AbortController().signal;
  await executor(
    [
      {
        candidateId: "signal",
        action: "artifact_search",
        owner: "workflow_delivery",
        query: "long",
      },
    ],
    packet,
    signal,
  );
  const [read] = await executor(
    [{ candidateId: "signal", action: "artifact_read", artifactId: "long-event", field: "/value" }],
    packet,
    signal,
  );
  expect(read.status).toBe("unavailable");
  expect(read.summary).toContain("selected_field_exceeds_review_budget_use_narrower_field");
  expect(read.summary).toContain("量化疑点");
  expect(read.summary).not.toContain("�");
  expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(2048);
});

it("keeps unavailable registration, future sources and changed originals explicit", async () => {
  const scope = await artifactScope(),
    signal = new AbortController().signal;
  const ask = {
    candidateId: "signal",
    action: "artifact_search" as const,
    owner: "workflow_delivery",
    query: "merger",
  };
  const [unregistered] = await createFinanceTradeReviewEvidenceExecutor(await fixture())(
    [ask],
    packet,
    signal,
  );
  expect(unregistered.summary).toContain("artifact_recall_not_registered");
  expect(unregistered.status).toBe("unavailable");
  const executor = createFinanceTradeReviewEvidenceExecutor(scope);
  const [past] = await executor([ask], { ...packet, asOf: "2026-08-31T00:00:00Z" }, signal);
  expect(JSON.parse(past.summary).result.artifacts).toEqual([]);
  await executor([ask], packet, signal);
  await fs.writeFile(
    path.join(scope.directory, "state/recorded-result.json"),
    '{"evidence":{"rate":999}}',
  );
  const [changed] = await executor(
    [
      {
        candidateId: "signal",
        action: "artifact_read",
        artifactId: "retained-event",
        field: "/evidence",
      },
    ],
    packet,
    signal,
  );
  expect(changed.status).toBe("unavailable");
  expect(changed.summary).toContain("artifact_original_hash_mismatch");
  expect(changed.summary).not.toContain("999");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function observeBarReads(beforeRead?: (args: unknown) => void | Promise<void>) {
  const factory = barLedgerTools.createFinanceBarLedgerTool;
  const read = vi.fn();
  vi.spyOn(barLedgerTools, "createFinanceBarLedgerTool").mockImplementation(() => {
    const tool = factory();
    const execute = tool.execute;
    return {
      ...tool,
      execute: async (...args) => {
        read(args[1]);
        await beforeRead?.(args[1]);
        return execute(...args);
      },
    };
  });
  return read;
}

it("reuses one validated historical observation across tools, but reads again for a new packet", async () => {
  const scope = await fixture();
  const read = observeBarReads();
  const executor = createFinanceTradeReviewEvidenceExecutor(scope);
  const signal = new AbortController().signal;
  const [first] = await executor(
    [{ candidateId: "signal", action: "daily_closes" }],
    packet,
    signal,
  );
  const [second] = await executor(
    [{ candidateId: "signal", action: "max_drawdown" }],
    packet,
    signal,
  );
  expect(first.status).toBe("completed");
  expect(second.status).toBe("completed");
  expect(second.sourceRef).toBe(first.sourceRef);
  expect(read).toHaveBeenCalledTimes(1);
  await executor([{ candidateId: "signal", action: "z_score" }], { ...packet }, signal);
  expect(read).toHaveBeenCalledTimes(2);
});

it.each(["account", "cutoff", "directory"] as const)(
  "discards the observation when its trusted %s changes",
  async (field) => {
    const scope = await fixture();
    const original = { ...scope };
    const currentPacket = { ...packet };
    const read = observeBarReads();
    const executor = createFinanceTradeReviewEvidenceExecutor(scope);
    const signal = new AbortController().signal;
    await executor([{ candidateId: "signal", action: "daily_closes" }], currentPacket, signal);
    if (field === "account") {
      scope.accountId = "different-paper-account";
    }
    if (field === "cutoff") {
      currentPacket.asOf = "2026-09-30T15:00:00.000Z";
    }
    if (field === "directory") {
      scope.directory = (await fixture()).directory;
    }
    const [result] = await executor(
      [{ candidateId: "signal", action: "max_drawdown" }],
      currentPacket,
      signal,
    );
    expect(result).toMatchObject({
      status: "completed",
      accountId: scope.accountId,
      asOf: currentPacket.asOf,
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0][0]).toMatchObject({
      directory: original.directory,
      asOf: packet.asOf,
    });
    expect(read.mock.calls[1][0]).toMatchObject({
      directory: scope.directory,
      asOf: currentPacket.asOf,
    });
  },
);

it("revalidates history on reviewer re-entry even when the caller reuses the packet", async () => {
  const scope = await fixture();
  const read = observeBarReads();
  const ask = (action: string) => ({
    schemaVersion: packet.schemaVersion,
    hypothesis: "Check the specific historical doubt.",
    evidenceRequests: [{ candidateId: "signal", action }],
  });
  const model = scripted([ask("daily_closes"), decision, ask("max_drawdown"), decision]);
  const reviewer = createFinanceTradeDecisionReviewer(
    {},
    { adapterFactory: model.factory, evidenceScope: scope },
  );
  for (let round = 0; round < 2; round++) {
    expect(
      await reviewer(packet, new AbortController().signal, { maxModelCalls: 2 }),
    ).toMatchObject({ status: "completed", modelCalls: 2 });
  }
  expect(read).toHaveBeenCalledTimes(2);
});

it("does not reuse rejected history or ignore cancellation after a successful observation", async () => {
  const scope = await fixture();
  const read = observeBarReads();
  const executor = createFinanceTradeReviewEvidenceExecutor(scope);
  const signal = new AbortController().signal;
  await executor([{ candidateId: "signal", action: "daily_closes" }], packet, signal);
  const controller = new AbortController();
  controller.abort();
  await expect(
    executor([{ candidateId: "signal", action: "max_drawdown" }], packet, controller.signal),
  ).rejects.toThrow();
  expect(read).toHaveBeenCalledTimes(1);
  await appendFinanceBars(scope.directory, {
    instrument: "AAA",
    derivation: "ohlcv",
    observedAt: "2026-09-29T23:30:00.000Z",
    provenance: { origin: "contradictory-fixture" },
    bars: [{ date: "2026-09-29", open: 1, high: 2, low: 0.5, close: 1 }],
  });
  const freshPacket = { ...packet };
  for (const action of ["daily_closes", "max_drawdown"] as const) {
    const [result] = await executor([{ candidateId: "signal", action }], freshPacket, signal);
    expect(result.status).toBe("unavailable");
    expect(result.summary).toContain("ambiguous recorded daily history");
  }
  expect(read).toHaveBeenCalledTimes(3);
});

it("keeps concurrent packets from sharing historical observations across cutoffs", async () => {
  const scope = await fixture();
  const early = { ...packet, asOf: "2026-09-29T23:01:00.000Z" };
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const read = observeBarReads((args) =>
    (args as { asOf: string }).asOf === early.asOf ? gate : undefined,
  );
  const executor = createFinanceTradeReviewEvidenceExecutor(scope);
  const signal = new AbortController().signal;
  const pending = executor([{ candidateId: "signal", action: "daily_closes" }], early, signal);
  const [first] = await executor(
    [{ candidateId: "signal", action: "daily_closes" }],
    packet,
    signal,
  );
  resume();
  const [earlier] = await pending;
  expect(JSON.parse(earlier.summary).result.count).toBe(28);
  expect(JSON.parse(first.summary).result.count).toBe(29);
  const [second] = await executor(
    [{ candidateId: "signal", action: "max_drawdown" }],
    packet,
    signal,
  );
  expect(second.sourceRef).toBe(first.sourceRef);
  expect(read).toHaveBeenCalledTimes(2);
});
const asOf = "2026-09-30T14:00:00.000Z";
const packet: FinanceIntradayTradeDecisionReviewRequest = {
  schemaVersion: FINANCE_INTRADAY_TRADE_DECISION_REVIEW_SCHEMA,
  venue: "alpaca:paper",
  asOf,
  signalAnchor: "signal",
  ruleIds: ["rule"],
  equity: 100000,
  caps: { maxOrderNotional: 1000, maxInstrumentNotional: 5000, maxOrdersPerRun: 8 },
  positionBookObservedAt: asOf,
  reconciliation: { status: "reconciled" },
  positions: [],
  candidates: [
    {
      candidateId: "signal",
      instrument: "AAA",
      side: "buy",
      strategyRule: "opening_range_breakout_long_next_bar_v1",
      signalReason: "opening_range_breakout",
      signalReferencePrice: 100,
      signalReferencePriceAt: asOf,
      datasetHeadRef: "a".repeat(64),
      intradayOwnedQuantity: 0,
      brokerPositionQuantity: 0,
      executionQuote: {
        referencePrice: 100,
        referencePriceAt: asOf,
        sourceUrlOrArtifact: "fixture",
        ageMs: 0,
        maxAgeMs: 30000,
      },
    },
  ],
};
const decision = {
  schemaVersion: packet.schemaVersion,
  decisions: [
    {
      candidateId: "signal",
      decision: "veto",
      rationale:
        "Recorded daily relationship is not fresh intraday or profitable arbitrage evidence",
    },
  ],
};
async function fixture(pairVariation = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "review-evidence-"));
  dirs.push(directory);
  for (const instrument of ["AAA", "BBB"]) {
    const bars = Array.from({ length: 29 }, (_, i) => {
      const close =
        (instrument === "AAA" ? 100 : 50) +
        i +
        (pairVariation && instrument === "BBB" ? Math.sin(i * i * 29.123) : Math.sin(i));
      return {
        date: `2026-09-${String(i + 1).padStart(2, "0")}`,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
      };
    });
    await appendFinanceBars(directory, {
      instrument,
      derivation: "ohlcv",
      observedAt: "2026-09-29T23:00:00.000Z",
      provenance: { origin: "offline-fixture" },
      bars,
    });
  }
  return { directory, accountId: "paper-a", instruments: ["AAA", "BBB"] };
}
function scripted(outputs: unknown[], payloads: unknown[] = []) {
  let calls = 0;
  const model: LogicalAgentModelAdapter = {
    id: "fixture",
    provider: "offline-scripted",
    modelId: "fixture",
    mode: "adapter",
    capabilities: ["quality_harness"],
    requiredTools: [],
    requiredSideEffects: [],
    invoke: vi.fn(async (call) => {
      payloads.push(call.payload);
      const output = outputs[calls++];
      if (output instanceof Error) {
        throw output;
      }
      return output;
    }),
  };
  return { model, factory: () => model };
}
const requests = [
  { candidateId: "signal", action: "max_drawdown" as const },
  {
    candidateId: "signal",
    action: "pair_spread_diagnostics" as const,
    instrumentB: "BBB",
    construction: "fixed_spread" as const,
    hedgeRatio: 2,
    relationshipRationale: "Caller hypothesis about a recorded relationship",
  },
];
it.each(["Caller hypothesis about a recorded relationship", "关系".repeat(120)])(
  "keeps real pair diagnostics on call2 and in the original DB/night projection with bounded rationale %s",
  async (relationshipRationale) => {
    const scope = await fixture();
    const payloads: unknown[] = [];
    const fixtureModel = scripted(
      [
        {
          schemaVersion: packet.schemaVersion,
          evidenceRequests: [requests[0], { ...requests[1], relationshipRationale }],
          hypothesis: "Test daily risk and relationship before exact candidate decision",
        },
        decision,
      ],
      payloads,
    );
    const reviewer = createFinanceTradeDecisionReviewer(
      {},
      { adapterFactory: fixtureModel.factory, evidenceScope: scope },
    );
    const result = await reviewer(packet, new AbortController().signal);
    expect(result).toMatchObject({
      status: "completed",
      modelCalls: 2,
      toolEvidence: [
        { action: "max_drawdown", status: "completed" },
        { action: "pair_spread_diagnostics", status: "completed" },
      ],
    });
    expect(JSON.stringify(payloads[1])).toContain(
      "recorded_daily_history_research_only_no_execution_or_fresh_quote",
    );
    expect(JSON.stringify(payloads[1])).toContain("calculationId");
    expect(JSON.parse(result.toolEvidence![1].summary).result.historyWindow).toEqual({
      firstDate: "2026-09-01",
      lastDate: "2026-09-29",
      count: 29,
    });
    const pairSummary = JSON.parse(result.toolEvidence![1].summary);
    expect(pairSummary.result).toMatchObject({
      instrumentA: "AAA",
      instrumentB: "BBB",
      construction: {
        kind: "fixed_spread",
        formula: "priceA - hedgeRatio * priceB",
        hedgeRatio: 2,
      },
      latestObservationZScore: expect.any(Number),
      latestSpread: expect.any(Number),
      zScoreBaseline: { observations: 20, excludesLatestObservation: true },
      stationarityTest: { status: "not_assessed", reason: expect.any(String) },
      researchMode: "research_only",
      signalProduced: false,
      executionAuthority: "none",
      statisticalBoundary: expect.stringContaining("not_cointegration"),
    });
    expect(pairSummary.omittedKeys).toContain("relationshipRationale");
    expect(Buffer.byteLength(JSON.stringify(pairSummary.result), "utf8")).toBeLessThanOrEqual(1200);
    expect(Buffer.byteLength(result.toolEvidence![1].summary, "utf8")).toBeLessThanOrEqual(1600);
    expect(
      JSON.parse((payloads[1] as { toolEvidence: { summary: string }[] }).toolEvidence[1].summary),
    ).toEqual(pairSummary);
    expect(JSON.stringify(payloads[1])).not.toContain('"observations":[');
    await appendFinanceIntradayDecision(scope.directory, {
      signalId: "signal",
      instrument: "AAA",
      sessionDate: "2026-09-30",
      action: "buy",
      reason: "opening_range_breakout",
      referencePrice: 100,
      referencePriceAt: asOf,
      datasetHeadRef: "a".repeat(64),
      strategyRule: "opening_range_breakout_long_next_bar_v1",
    });
    const { decisions: _decisions, ...resultMetadata } = result;
    const receipt = FinanceIntradayDecisionReviewReceiptSchema.parse({
      ...resultMetadata,
      request: packet,
      decision: result.decisions?.[0],
    });
    await appendFinanceIntradayOutcome(scope.directory, {
      signalId: "signal",
      status: "refused",
      reasons: ["model veto"],
      tradeDecisionReview: receipt,
    });
    expect(
      (await readFinanceIntradayOutcome(scope.directory, "signal"))?.tradeDecisionReview
        ?.toolEvidence,
    ).toEqual(result.toolEvidence);
    const night = await buildFinanceNightReviewEvidence({
      directory: scope.directory,
      asOf: new Date().toISOString(),
      etDate: "2026-09-30",
      settlement: {
        scoredFiled: { appended: 0, skipped: 0 },
        reflection: {},
        pending: [],
        declined: [],
        issues: [],
      },
    });
    const nightText = night.find((item) => item.source === "finance-intraday-control-ledger")!.text;
    const projected = JSON.parse(nightText).decisions[0].outcome.tradeDecisionReview;
    const { accountId: _accountId, ...projectedPair } = result.toolEvidence![1];
    expect(projected.toolEvidence[1]).toEqual(projectedPair);
    expect(projected.modelCallEvidence).toEqual(result.modelCallEvidence);
    expect(projected.omittedToolEvidenceCount).toBe(0);
    expect(projected.omittedModelCallEvidenceCount).toBe(0);
    expect(nightText).not.toContain(scope.accountId);
    expect(nightText).not.toContain('"equity"');
    expect(nightText).not.toContain('"request":');
  },
);
it("preserves assessed ADF statistics and calibration boundaries before a long pair rationale", async () => {
  const scope = await fixture(true);
  const result = await createFinanceTradeReviewEvidenceExecutor(scope)(
    [{ ...requests[1], relationshipRationale: "关系".repeat(120) }],
    packet,
    new AbortController().signal,
  );
  expect(result[0].status).toBe("completed");
  const summary = JSON.parse(result[0].summary);
  expect(summary.result.stationarityTest).toMatchObject({
    status: "assessed",
    result: {
      observations: 29,
      effectiveObservations: expect.any(Number),
      regression: "drift",
      lagsUsed: expect.any(Number),
      statistic: expect.any(Number),
      criticalValues: [
        { level: "1%", value: expect.any(Number) },
        { level: "5%", value: expect.any(Number) },
        { level: "10%", value: expect.any(Number) },
      ],
      verdict: expect.any(String),
    },
  });
  expect(summary.result.statisticalBoundary).toContain("asymptotic_ADF_not_cointegration");
  expect(summary.result).toMatchObject({
    instrumentA: "AAA",
    instrumentB: "BBB",
    construction: { kind: "fixed_spread", formula: "priceA - hedgeRatio * priceB", hedgeRatio: 2 },
    signalProduced: false,
    executionAuthority: "none",
  });
  expect(Buffer.byteLength(JSON.stringify(summary.result), "utf8")).toBeLessThanOrEqual(1200);
  expect(Buffer.byteLength(result[0].summary, "utf8")).toBeLessThanOrEqual(1600);
});
it.each(["directory", "accountId", "series", "asOf", "unknownTool"])(
  "rejects model-controlled %s and mixed output before evidence execution",
  async (key) => {
    const scope = await fixture();
    const fixtureModel = scripted([
      {
        schemaVersion: packet.schemaVersion,
        evidenceRequests: [{ ...requests[0], [key]: "malicious" }],
        hypothesis: "test",
      },
    ]);
    expect(
      await createFinanceTradeDecisionReviewer(
        {},
        { adapterFactory: fixtureModel.factory, evidenceScope: scope },
      )(packet, new AbortController().signal),
    ).toMatchObject({ status: "failed", modelCalls: 1 });
    expect(
      FinanceTradeReviewEvidenceRequestSchema.safeParse({ ...requests[0], [key]: "bad" }).success,
    ).toBe(false);
  },
);
it("rejects duplicate, overflow and outside pair scope before reading; abort propagates", async () => {
  const scope = await fixture();
  const execute = createFinanceTradeReviewEvidenceExecutor(scope);
  for (const list of [
    [requests[0], requests[0]],
    [requests[0], requests[1], requests[0]],
    [{ ...requests[1], instrumentB: "OTHER" }],
  ]) {
    await expect(execute(list, packet, new AbortController().signal)).rejects.toThrow();
  }
  const controller = new AbortController();
  controller.abort();
  await expect(execute([requests[0]], packet, controller.signal)).rejects.toThrow();
});
it("does not spend the optional evidence call retrying provider truncation", async () => {
  const scope = await fixture();
  const fixtureModel = scripted([
    new ModelAdapterError("output_truncated"),
    { schemaVersion: packet.schemaVersion, evidenceRequests: [requests[0]], hypothesis: "late" },
  ]);
  const result = await createFinanceTradeDecisionReviewer(
    {},
    { adapterFactory: fixtureModel.factory, evidenceScope: scope },
  )(packet, new AbortController().signal);
  expect(result).toMatchObject({
    status: "failed",
    failureCode: "output_truncated",
    modelCalls: 1,
  });
  expect(result.toolEvidence).toBeUndefined();
});
it("returns missing data as unknown to the final model, never fabricates economics or a third call", async () => {
  const scope = await fixture();
  const future = { ...packet, asOf: "2026-09-01T00:00:00.000Z" };
  const payloads: unknown[] = [];
  const fixtureModel = scripted(
    [
      {
        schemaVersion: packet.schemaVersion,
        evidenceRequests: [requests[0]],
        hypothesis: "missing data",
      },
      { schemaVersion: packet.schemaVersion, evidenceRequests: [requests[0]], hypothesis: "again" },
    ],
    payloads,
  );
  const result = await createFinanceTradeDecisionReviewer(
    {},
    { adapterFactory: fixtureModel.factory, evidenceScope: scope },
  )(future, new AbortController().signal);
  expect(result).toMatchObject({
    status: "failed",
    modelCalls: 2,
    toolEvidence: [{ status: "unavailable" }],
  });
  expect(JSON.stringify(payloads[1])).toContain("insufficient completed daily history");
});
it("legacy direct decisions stay one-call and forged packet tool fields are stripped", async () => {
  const fixtureModel = scripted([decision]);
  const result = await createFinanceTradeDecisionReviewer(
    {},
    { adapterFactory: fixtureModel.factory },
  )(
    {
      ...packet,
      evidenceToolsAvailable: true,
      evidenceScope: { directory: "bad" },
    } as FinanceIntradayTradeDecisionReviewRequest,
    new AbortController().signal,
  );
  expect(result).toMatchObject({ status: "completed", modelCalls: 1 });
  expect(fixtureModel.model.invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.not.objectContaining({ evidenceToolsAvailable: true }),
    }),
    expect.anything(),
  );
});

it("rejects same-day/future bars, divergent duplicate dates and mixed request/decision outputs", async () => {
  const scope = await fixture();
  await appendFinanceBars(scope.directory, {
    instrument: "AAA",
    derivation: "ohlcv",
    observedAt: "2026-09-30T13:00:00.000Z",
    provenance: { origin: "conflict" },
    bars: [
      { date: "2026-09-20", open: 300, high: 301, low: 299, close: 300 },
      { date: "2026-09-30", open: 400, high: 401, low: 399, close: 400 },
    ],
  });
  const result = await createFinanceTradeReviewEvidenceExecutor(scope)(
    [requests[0]],
    packet,
    new AbortController().signal,
  );
  expect(result).toMatchObject([{ status: "unavailable" }]);
  expect(result[0].summary).toContain("ambiguous recorded daily history");
  const fixtureModel = scripted([
    { ...decision, evidenceRequests: [requests[0]], hypothesis: "mixed" },
  ]);
  expect(
    await createFinanceTradeDecisionReviewer(
      {},
      { adapterFactory: fixtureModel.factory, evidenceScope: scope },
    )(packet, new AbortController().signal),
  ).toMatchObject({ status: "failed", modelCalls: 1 });
});
it("carries failed history identity and conflicting dates into the second model call", async () => {
  const scope = await fixture();
  const conflict = await appendFinanceBars(scope.directory, {
    instrument: "AAA",
    derivation: "ohlcv",
    observedAt: "2026-09-30T13:00:00.000Z",
    provenance: { origin: "different-feed" },
    bars: [{ date: "2026-09-20", open: 300, high: 301, low: 299, close: 300 }],
  });
  const payloads: unknown[] = [];
  const model = scripted(
    [
      {
        schemaVersion: packet.schemaVersion,
        evidenceRequests: [requests[0]],
        hypothesis: "Check recorded risk evidence",
      },
      decision,
    ],
    payloads,
  );
  const result = await createFinanceTradeDecisionReviewer(
    {},
    { adapterFactory: model.factory, evidenceScope: scope },
  )(packet, new AbortController().signal);
  expect(result).toMatchObject({ status: "completed", modelCalls: 2 });
  const evidence = result.toolEvidence![0];
  expect(evidence.status).toBe("unavailable");
  expect(JSON.parse(evidence.summary).result).toMatchObject({
    reason: "ambiguous recorded daily history",
    historyRead: {
      instrument: "AAA",
      headRef: conflict.headRef,
      returnedBarCount: 30,
      completedBarCount: 30,
      duplicateDates: ["2026-09-20"],
      duplicateDatesOmitted: 0,
      divergentDateCount: 1,
    },
  });
  expect(JSON.stringify(payloads[1])).toContain(conflict.headRef);
  expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(2048);

  await appendFinanceBars(scope.directory, {
    instrument: "AAA",
    derivation: "ohlcv",
    observedAt: "2026-09-30T13:01:00.000Z",
    provenance: { origin: "another-observation" },
    bars: [{ date: "2026-09-20", open: 301, high: 302, low: 300, close: 301 }],
  });
  const [changed] = await createFinanceTradeReviewEvidenceExecutor(scope)(
    [requests[0]],
    packet,
    new AbortController().signal,
  );
  expect(changed.status).toBe("unavailable");
  expect(changed.sourceRef).not.toBe(evidence.sourceRef);
});

it("identifies the failed second instrument without attributing its gap to the successful first leg", async () => {
  const scope = await fixture();
  const conflict = await appendFinanceBars(scope.directory, {
    instrument: "BBB",
    derivation: "ohlcv",
    observedAt: "2026-09-30T13:00:00.000Z",
    provenance: { origin: "different-feed" },
    bars: [{ date: "2026-09-20", open: 300, high: 301, low: 299, close: 300 }],
  });
  const [evidence] = await createFinanceTradeReviewEvidenceExecutor(scope)(
    [requests[1]],
    packet,
    new AbortController().signal,
  );
  expect(evidence.status).toBe("unavailable");
  expect(JSON.parse(evidence.summary).result.historyRead).toMatchObject({
    instrument: "BBB",
    headRef: conflict.headRef,
    duplicateDates: ["2026-09-20"],
  });
});

it("bounds failed history date samples and explicitly counts omitted dates", async () => {
  const scope = await fixture();
  await appendFinanceBars(scope.directory, {
    instrument: "AAA",
    derivation: "ohlcv",
    observedAt: "2026-09-30T13:00:00.000Z",
    provenance: { origin: "different-feed" },
    bars: Array.from({ length: 29 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, "0")}`,
      open: 300,
      high: 301,
      low: 299,
      close: 300,
    })),
  });
  const [evidence] = await createFinanceTradeReviewEvidenceExecutor(scope)(
    [requests[0]],
    packet,
    new AbortController().signal,
  );
  expect(evidence.status).toBe("unavailable");
  expect(JSON.parse(evidence.summary).result.historyRead).toMatchObject({
    duplicateDates: ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"],
    duplicateDatesOmitted: 25,
    divergentDateCount: 29,
  });
  expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(2048);
});

it("never includes today's unfinished close or a future-observed batch in the computed series", async () => {
  const scope = await fixture();
  for (const [observedAt, date, close] of [
    ["2026-09-30T13:00:00.000Z", "2026-09-30", 10000],
    ["2026-10-01T00:00:00.000Z", "2026-09-28", 10000],
  ] as const) {
    await appendFinanceBars(scope.directory, {
      instrument: "AAA",
      derivation: "ohlcv",
      observedAt,
      provenance: { origin: "future" },
      bars: [{ date, open: close, high: close + 1, low: close - 1, close }],
    });
  }
  const result = await createFinanceTradeReviewEvidenceExecutor(scope)(
    [{ candidateId: "signal", action: "daily_closes" }],
    packet,
    new AbortController().signal,
  );
  expect(result[0].status).toBe("completed");
  expect(result[0].summary).toContain('"count":29');
  expect(result[0].summary).toContain('"lastDate":"2026-09-29"');
  expect(result[0].summary).not.toContain("10000");
});

it("refuses first-call evidence overflow or duplicates without a second invocation", async () => {
  const scope = await fixture();
  for (const evidenceRequests of [
    [requests[0], requests[0]],
    [requests[0], requests[1], requests[0]],
  ]) {
    const fixtureModel = scripted([
      { schemaVersion: packet.schemaVersion, evidenceRequests, hypothesis: "bounded" },
    ]);
    const result = await createFinanceTradeDecisionReviewer(
      {},
      { adapterFactory: fixtureModel.factory, evidenceScope: scope },
    )(packet, new AbortController().signal);
    expect(result).toMatchObject({ status: "failed", modelCalls: 1 });
    expect(result.toolEvidence).toBeUndefined();
  }
});
it("aborted evidence work cannot be consumed as successful or issue a second model call", async () => {
  const scope = await fixture();
  const controller = new AbortController();
  const fixtureModel = scripted([
    { schemaVersion: packet.schemaVersion, evidenceRequests: [requests[0]], hypothesis: "cancel" },
  ]);
  const model: LogicalAgentModelAdapter = {
    ...fixtureModel.model,
    invoke: async (call, signal) => {
      const output = await fixtureModel.model.invoke(call, signal);
      controller.abort();
      return output;
    },
  };
  const result = await createFinanceTradeDecisionReviewer(
    {},
    { adapterFactory: () => model, evidenceScope: scope },
  )(packet, controller.signal);
  expect(result).toMatchObject({ status: "failed", modelCalls: 1 });
  expect(result.toolEvidence).toBeUndefined();
});

it("returns actual point-derived observations as unknown and lets the final model consume the limitation", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "review-points-"));
  dirs.push(directory);
  for (const instrument of ["AAA", "BBB"]) {
    await appendFinanceBars(directory, {
      instrument,
      derivation: "point_derived",
      observedAt: "2026-09-29T23:00:00.000Z",
      provenance: { origin: "offline-point-fixture" },
      points: Array.from({ length: 29 }, (_, i) => ({
        date: `2026-09-${String(i + 1).padStart(2, "0")}`,
        at: `2026-09-${String(i + 1).padStart(2, "0")}T12:00:00.000Z`,
        price: 100 + i,
      })),
    });
  }
  const payloads: unknown[] = [];
  const fixtureModel = scripted(
    [
      {
        schemaVersion: packet.schemaVersion,
        evidenceRequests: [requests[1]],
        hypothesis: "Test the relationship only if completed daily prices exist",
      },
      decision,
    ],
    payloads,
  );
  const result = await createFinanceTradeDecisionReviewer(
    {},
    {
      adapterFactory: fixtureModel.factory,
      evidenceScope: { directory, accountId: "paper-a", instruments: ["AAA", "BBB"] },
    },
  )(packet, new AbortController().signal);
  expect(result).toMatchObject({
    status: "completed",
    modelCalls: 2,
    toolEvidence: [{ status: "unavailable" }],
  });
  expect(JSON.stringify(payloads[1])).toContain(
    "point observations are not completed daily closes",
  );
  expect(JSON.stringify(payloads[1])).not.toContain("calculationId");
});

it.each([21, 120])(
  "delivers actual %s-close price-return numbers and historical dates to call2 and durable receipt",
  async (count) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "math-consumption-"));
    dirs.push(directory);
    const levels = Array.from({ length: count }, (_, i) => 100 + i * 0.3 + Math.sin(i));
    const bars = levels.map((close, i) => ({
      date: new Date(Date.UTC(2026, 4, 1 + i)).toISOString().slice(0, 10),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
    }));
    await appendFinanceBars(directory, {
      instrument: "AAA",
      derivation: "ohlcv",
      observedAt: "2026-09-01T00:00:00Z",
      provenance: { origin: "offline-真实日线" },
      bars,
    });
    const payloads: unknown[] = [];
    const model = scripted(
      [
        {
          schemaVersion: packet.schemaVersion,
          evidenceRequests: [
            { candidateId: packet.candidates[0].candidateId, action: "returns_from_levels" },
          ],
          hypothesis: "核实收益路径是否改变当前候选判断",
        },
        decision,
      ],
      payloads,
    );
    const result = await createFinanceTradeDecisionReviewer(
      {},
      {
        adapterFactory: model.factory,
        evidenceScope: { directory, accountId: "paper-a", instruments: ["AAA"] },
      },
    )(packet, new AbortController().signal);
    expect(result).toMatchObject({ status: "completed", modelCalls: 2 });
    const evidence = result.toolEvidence![0];
    const summary = JSON.parse(evidence.summary);
    const returns = levels.slice(1).map((level, i) => level / levels[i] - 1);
    expect(summary.result.historyWindow).toEqual({
      firstDate: bars[0].date,
      lastDate: bars.at(-1)!.date,
      count,
    });
    expect(summary.result.returnSummary.cumulativePriceReturn).toBeCloseTo(
      levels.at(-1)! / levels[0] - 1,
      12,
    );
    expect(summary.result.returnSummary.mean).toBeCloseTo(
      returns.reduce((a, b) => a + b, 0) / returns.length,
      12,
    );
    expect(evidence.resultSha256).toBe(
      createHash("sha256")
        .update(
          JSON.stringify({
            action: "returns_from_levels",
            returnMode: "simple",
            observations: count,
            returns,
          }),
        )
        .digest("hex"),
    );
    expect(summary.result.returnSummary.latest).toBe(returns.at(-1));
    expect(summary.result.returnSummary.min).toBe(Math.min(...returns));
    expect(summary.result.returnSummary.max).toBe(Math.max(...returns));
    if (count === 120) {
      expect(summary.omittedKeys).toContain("returns");
      expect(summary.omittedReturnCount).toBe(119);
    } else {
      expect(summary.result.returns).toEqual(returns);
    }
    expect(JSON.stringify(payloads[1])).toContain(evidence.summary.replace(/"/g, '\\"'));
    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(2048);
    await appendFinanceIntradayDecision(directory, {
      signalId: "math-signal",
      instrument: "AAA",
      sessionDate: "2026-09-30",
      action: "buy",
      reason: "opening_range_breakout",
      referencePrice: 100,
      referencePriceAt: asOf,
      datasetHeadRef: "a".repeat(64),
      strategyRule: "opening_range_breakout_long_next_bar_v1",
    });
    const { decisions: _decisions, ...metadata } = result;
    const receipt = FinanceIntradayDecisionReviewReceiptSchema.parse({
      ...metadata,
      request: packet,
      decision: result.decisions?.[0],
    });
    await appendFinanceIntradayOutcome(directory, {
      signalId: "math-signal",
      status: "refused",
      reasons: ["offline veto"],
      tradeDecisionReview: receipt,
    });
    expect(
      (await readFinanceIntradayOutcome(directory, "math-signal"))?.tradeDecisionReview
        ?.toolEvidence,
    ).toEqual(result.toolEvidence);
  },
);

it("distinguishes old and recent historical windows even when all numerical z-score inputs are identical", async () => {
  const recent = await fixture();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "old-math-window-"));
  dirs.push(directory);
  const bars = Array.from({ length: 29 }, (_, i) => {
    const close = 100 + i + Math.sin(i);
    return {
      date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
    };
  });
  await appendFinanceBars(directory, {
    instrument: "AAA",
    derivation: "ohlcv",
    observedAt: "2026-08-30T00:00:00Z",
    provenance: { origin: "offline" },
    bars,
  });
  const request = [{ candidateId: packet.candidates[0].candidateId, action: "z_score" as const }];
  const [oldResult, newResult] = await Promise.all([
    createFinanceTradeReviewEvidenceExecutor({ ...recent, directory })(
      request,
      packet,
      new AbortController().signal,
    ),
    createFinanceTradeReviewEvidenceExecutor(recent)(request, packet, new AbortController().signal),
  ]);
  const oldSummary = JSON.parse(oldResult[0].summary).result;
  const newSummary = JSON.parse(newResult[0].summary).result;
  expect(oldSummary.zScore).toBe(newSummary.zScore);
  expect(oldSummary.historyWindow.lastDate).toBe("2026-08-29");
  expect(newSummary.historyWindow.lastDate).toBe("2026-09-29");
  expect(oldResult[0].asOf).toBe(newResult[0].asOf);
});

it("rejects nonfinite derived returns before hashing or successful JSON serialization", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nonfinite-math-"));
  dirs.push(directory);
  await appendFinanceBars(directory, {
    instrument: "AAA",
    derivation: "ohlcv",
    observedAt: "2026-09-29T23:00:00Z",
    provenance: { origin: "offline" },
    bars: Array.from({ length: 21 }, (_, i) => {
      const close = i % 2 ? Number("1e300") : Number("1e-300");
      return {
        date: `2026-09-${String(i + 1).padStart(2, "0")}`,
        open: close,
        high: close,
        low: close,
        close,
      };
    }),
  });
  const result = await createFinanceTradeReviewEvidenceExecutor({
    directory,
    accountId: "paper-a",
    instruments: ["AAA"],
  })(
    [{ candidateId: packet.candidates[0].candidateId, action: "returns_from_levels" }],
    packet,
    new AbortController().signal,
  );
  expect(result[0].status).toBe("unavailable");
  expect(JSON.parse(result[0].summary).result).toHaveProperty("reason");
  expect(result[0].summary).not.toContain('"returns"');
});

it("uses actual price endpoints rather than rounded minus-one return products for cumulative price change", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "endpoint-math-"));
  dirs.push(directory);
  await appendFinanceBars(directory, {
    instrument: "AAA",
    derivation: "ohlcv",
    observedAt: "2026-09-29T23:00:00Z",
    provenance: { origin: "offline" },
    bars: Array.from({ length: 21 }, (_, i) => {
      const close = i % 2 ? Number("1e-150") : Number("1e150");
      return {
        date: `2026-09-${String(i + 1).padStart(2, "0")}`,
        open: close,
        high: close,
        low: close,
        close,
      };
    }),
  });
  const result = await createFinanceTradeReviewEvidenceExecutor({
    directory,
    accountId: "paper-a",
    instruments: ["AAA"],
  })(
    [{ candidateId: packet.candidates[0].candidateId, action: "returns_from_levels" }],
    packet,
    new AbortController().signal,
  );
  expect(result[0].status).toBe("completed");
  expect(JSON.parse(result[0].summary).result.returnSummary.cumulativePriceReturn).toBe(0);
});

const financialRequest = {
  candidateId: "signal",
  action: "financial_capability" as const,
  toolName: "finance_framework_core_inspect",
  moduleId: "credit_liquidity" as const,
  question: "Which funding risk would invalidate this candidate?",
};
async function seedKnowledge(directory: string, updatedAt = "2026-09-01T00:00:00.000Z") {
  const contractPath = path.join(directory, buildFinanceFrameworkCoreContractPath());
  await fs.mkdir(path.dirname(contractPath), { recursive: true });
  await fs.writeFile(
    contractPath,
    renderFinanceFrameworkCoreContractArtifact({
      updatedAt,
      entries: [
        {
          domain: "credit_liquidity",
          sourceArtifacts: ["memory/articles/funding.md"],
          evidenceCategories: ["credit_evidence", "liquidity_evidence"],
          evidenceSummary: "Recorded funding and credit evidence, requiring current verification.",
          baseCase: "Credit pressure can weaken liquidity.",
          bullCase: "Funding stress recedes.",
          bearCase: "Funding pressure worsens.",
          keyCausalChain: "Funding pressure -> liquidity loss -> weaker prices.",
          upstreamDrivers: ["funding"],
          downstreamAssetImpacts: ["AAA liquidity"],
          confidenceOrConviction: "low",
          whatChangesMyMind: "Reject this hypothesis if fresh funding evidence contradicts it.",
          noActionReason: "Recorded knowledge alone cannot approve a trade.",
          riskGateNotes: "Preserve the exact stop and verify costs.",
          allowedActionAuthority: "research_only",
        },
      ],
    }),
  );
  const learningPath = path.join(directory, buildFinanceLearningCapabilityCandidatesPath());
  await fs.writeFile(
    learningPath,
    renderFinanceLearningCapabilityCandidateArtifact({
      updatedAt,
      frameworkContractPath: buildFinanceFrameworkCoreContractPath(),
      candidates: Array.from({ length: 3 }, (_, index) => ({
        candidateId: `funding-${index}`,
        sourceArticlePath: "memory/articles/funding.md",
        title: "Credit liquidity framework",
        sourceType: "public_web_article" as const,
        collectionMethod: "public_article_capture" as const,
        extractionSummary: "Use credit liquidity and funding data to test a bounded hypothesis.",
        rawNotes: "Stored method, requiring current evidence.",
        capabilityName: `Credit funding risk ${index}`,
        capabilityType: "research_framework" as const,
        relatedFinanceDomains: ["credit_liquidity" as const],
        capabilityTags: ["causal_mapping" as const],
        evidenceCategories: ["credit_evidence" as const, "liquidity_evidence" as const],
        evidenceSummary: "Credit spreads and funding pressure provide the required evidence.",
        methodSummary: "Evaluate funding pressure and credit liquidity.",
        requiredDataSources: ["funding pressure", "credit spreads"],
        causalOrMechanisticClaim: "Funding pressure may reduce liquidity.",
        evidenceLevel: "hypothesis" as const,
        implementationRequirements: "Check fresh funding data before applying.",
        riskAndFailureModes: "Reject unsupported timing and preserve stops.",
        overfittingOrSpuriousRisk: "A small sample cannot prove persistent edge.",
        complianceOrCollectionNotes: "Public source only.",
        suggestedAttachmentPoint: "finance_framework_domain:credit_liquidity",
        allowedActionAuthority: "research_only" as const,
      })),
    }),
  );
  return { contractPath, learningPath };
}

it("selects real registered math and stored financial knowledge, consumes both on call2 and preserves raw hash and original receipt", async () => {
  const scope = await fixture();
  const { contractPath } = await seedKnowledge(scope.directory);
  const before = await fs.readFile(contractPath);
  const financialCapabilities = createFinanceTradeReviewFinancialCapabilities({
    workspaceDir: scope.directory,
  });
  const catalog = describeFinanceTradeReviewFinancialCapabilities({
    ...scope,
    financialCapabilities,
  });
  expect(catalog.map((item) => item.toolName)).toEqual([
    "finance_framework_core_inspect",
    "finance_learning_capability_apply",
    "finance_trade_result_recall",
  ]);
  expect(catalog[0].moduleIds).toContain("credit_liquidity");
  expect(catalog[0].moduleIds).not.toContain("quant_math");
  const payloads: unknown[] = [];
  const fixtureModel = scripted(
    [
      {
        schemaVersion: packet.schemaVersion,
        evidenceRequests: [requests[0], financialRequest],
        hypothesis: "Check mathematical risk and stored funding falsifier",
      },
      decision,
    ],
    payloads,
  );
  const result = await createFinanceTradeDecisionReviewer(
    {},
    { adapterFactory: fixtureModel.factory, evidenceScope: { ...scope, financialCapabilities } },
  )(packet, new AbortController().signal);
  expect(result).toMatchObject({
    status: "completed",
    modelCalls: 2,
    toolEvidence: [
      { action: "max_drawdown", status: "completed" },
      {
        action: "financial_capability",
        status: "completed",
        accountId: "paper-a",
        asOf,
        boundary: "recorded_financial_knowledge_research_only_not_market_or_account_facts",
      },
    ],
  });
  const evidence = result.toolEvidence![1];
  expect(JSON.stringify(payloads[1])).toContain(
    "Reject this hypothesis if fresh funding evidence contradicts it.",
  );
  expect(JSON.stringify(payloads[1])).toContain(
    "stored_knowledge_not_current_market_account_or_point_in_time_facts",
  );
  const raw = await financialCapabilities[0].execute(
    {
      moduleId: financialRequest.moduleId,
      candidate: packet.candidates[0],
      question: financialRequest.question,
    },
    new AbortController().signal,
  );
  expect(evidence.resultSha256).toBe(
    createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
  );
  expect(evidence.requestSha256).toBe(
    createHash("sha256")
      .update(JSON.stringify(FinanceTradeReviewEvidenceRequestSchema.parse(financialRequest)))
      .digest("hex"),
  );
  expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(2048);
  expect(await fs.readFile(contractPath)).toEqual(before);
  const { decisions: _decisions, ...metadata } = result;
  await appendFinanceIntradayDecision(scope.directory, {
    signalId: "signal",
    instrument: "AAA",
    sessionDate: "2026-09-30",
    action: "buy",
    reason: "opening_range_breakout",
    referencePrice: 100,
    referencePriceAt: asOf,
    datasetHeadRef: "a".repeat(64),
    strategyRule: "opening_range_breakout_long_next_bar_v1",
  });
  const receipt = FinanceIntradayDecisionReviewReceiptSchema.parse({
    ...metadata,
    request: packet,
    decision: result.decisions![0],
  });
  await appendFinanceIntradayOutcome(scope.directory, {
    signalId: "signal",
    status: "refused",
    reasons: ["model veto"],
    tradeDecisionReview: receipt,
  });
  expect(
    (await readFinanceIntradayOutcome(scope.directory, "signal"))?.tradeDecisionReview
      ?.toolEvidence,
  ).toEqual(result.toolEvidence);
});

it("queries native retained guidance without any bar book or usage writes and caps actual retrieved cards", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "review-knowledge-"));
  dirs.push(directory);
  const { learningPath } = await seedKnowledge(directory);
  const before = await fs.readFile(learningPath);
  const scope = {
    directory,
    accountId: "paper-a",
    instruments: ["AAA"],
    financialCapabilities: createFinanceTradeReviewFinancialCapabilities({
      workspaceDir: directory,
    }),
  };
  const request = {
    ...financialRequest,
    toolName: "finance_learning_capability_apply",
    question: "credit liquidity funding risk",
  };
  const [result] = await createFinanceTradeReviewEvidenceExecutor(scope)(
    [request],
    packet,
    new AbortController().signal,
  );
  expect(result.status, result.summary).toBe("completed");
  const summary = JSON.parse(result.summary);
  expect(summary.result.candidateCount).toBe(2);
  expect(result.summary).toContain("Credit funding risk");
  expect(summary.omittedKeys).toContain("answerSkeleton");
  expect(summary.result.sourceTime).toBe(
    "recorded_metadata_at_or_before_cutoff_not_market_freshness",
  );
  expect(await fs.readFile(learningPath)).toEqual(before);
  await expect(
    fs.access(path.join(directory, "memory", "finance-learning-apply-usage-receipts")),
  ).rejects.toThrow();
  await expect(
    fs.access(path.join(directory, "memory", "finance-learning-apply-usage-reviews")),
  ).rejects.toThrow();
  await expect(fs.access(path.join(directory, "finance-bars.sqlite"))).rejects.toThrow();
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2048);
});

it.each([
  "directory",
  "accountId",
  "asOf",
  "series",
  "instrumentB",
  "hedgeRatio",
  "construction",
  "lookbackWindow",
])("rejects injected or mixed financial %s before any host execution", async (key) => {
  const execute = vi.fn(async () => ({ ok: true }));
  const scope = {
    directory: "unused",
    accountId: "paper-a",
    instruments: ["AAA"],
    financialCapabilities: [
      {
        toolName: financialRequest.toolName,
        moduleIds: [financialRequest.moduleId],
        description: "Offline host read",
        execute,
      },
    ],
  };
  await expect(
    createFinanceTradeReviewEvidenceExecutor(scope)(
      [financialRequest, { ...financialRequest, [key]: "bad" }],
      packet,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});

it("prevalidates all tools, modules, candidates, registration identities and UTF8 questions before dispatch", async () => {
  const execute = vi.fn(async () => ({ ok: true }));
  const capability: FinanceTradeReviewFinancialCapability = {
    toolName: financialRequest.toolName,
    moduleIds: [financialRequest.moduleId],
    description: "Offline host read",
    execute,
  };
  const scope = {
    directory: "unused",
    accountId: "paper-a",
    instruments: ["AAA"],
    financialCapabilities: [capability],
  };
  for (const invalid of [
    { ...financialRequest, toolName: "unregistered" },
    { ...financialRequest, moduleId: "quant_math" as const },
    { ...financialRequest, candidateId: "other" },
    { ...financialRequest, question: "中".repeat(81) },
    financialRequest,
  ]) {
    await expect(
      createFinanceTradeReviewEvidenceExecutor(scope)(
        [financialRequest, invalid],
        packet,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  }
  expect(execute).not.toHaveBeenCalled();
  expect(
    FinanceTradeReviewEvidenceRequestSchema.safeParse({
      ...financialRequest,
      question: "中".repeat(80),
    }).success,
  ).toBe(true);
  expect(() =>
    describeFinanceTradeReviewFinancialCapabilities({
      ...scope,
      financialCapabilities: [capability, capability],
    }),
  ).toThrow();
  expect(() =>
    describeFinanceTradeReviewFinancialCapabilities({
      ...scope,
      financialCapabilities: [
        { ...capability, moduleIds: [financialRequest.moduleId, financialRequest.moduleId] },
      ],
    }),
  ).toThrow();
  await expect(
    createFinanceTradeReviewEvidenceExecutor({ ...scope, instruments: ["BBB"] })(
      [financialRequest],
      packet,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});

it("returns absent or future stored knowledge as actual unknown for call2 and propagates cancellation after await", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "review-unknown-"));
  dirs.push(directory);
  const financialCapabilities = createFinanceTradeReviewFinancialCapabilities({
    workspaceDir: directory,
  });
  const scope = { directory, accountId: "paper-a", instruments: ["AAA"], financialCapabilities };
  for (const future of [false, true]) {
    if (future) {
      await seedKnowledge(directory, "2026-10-01T00:00:00.000Z");
    }
    const payloads: unknown[] = [];
    const fixtureModel = scripted(
      [
        {
          schemaVersion: packet.schemaVersion,
          evidenceRequests: [financialRequest],
          hypothesis: "Check recorded funding frame",
        },
        decision,
      ],
      payloads,
    );
    const result = await createFinanceTradeDecisionReviewer(
      {},
      { adapterFactory: fixtureModel.factory, evidenceScope: scope },
    )(packet, new AbortController().signal);
    expect(result).toMatchObject({
      status: "completed",
      modelCalls: 2,
      toolEvidence: [{ status: "unavailable" }],
    });
    expect(JSON.stringify(payloads[1])).toContain(
      future ? "after review cutoff" : "finance_framework_core_contract_missing",
    );
    if (future) {
      expect(JSON.stringify(payloads[1])).not.toContain("Funding pressure worsens.");
    }
  }
  const controller = new AbortController();
  const custom: FinanceTradeReviewFinancialCapability = {
    toolName: "host_local_read",
    moduleIds: ["credit_liquidity"],
    description: "Host read only",
    execute: async () => {
      await Promise.resolve();
      controller.abort();
      return { ok: true };
    },
  };
  await expect(
    createFinanceTradeReviewEvidenceExecutor({ ...scope, financialCapabilities: [custom] })(
      [{ ...financialRequest, toolName: custom.toolName }],
      packet,
      controller.signal,
    ),
  ).rejects.toThrow();
});

it("does not expose an arbitrary capability handler exception or label nonfinite results successful", async () => {
  for (const output of [new Error("synthetic provider secret"), { risk: Infinity }]) {
    const capability: FinanceTradeReviewFinancialCapability = {
      toolName: "host_local_read",
      moduleIds: ["credit_liquidity"],
      description: "Host read only",
      execute: async () => {
        if (output instanceof Error) {
          throw output;
        }
        return output;
      },
    };
    const [result] = await createFinanceTradeReviewEvidenceExecutor({
      directory: "unused",
      accountId: "paper-a",
      instruments: ["AAA"],
      financialCapabilities: [capability],
    })(
      [{ ...financialRequest, toolName: capability.toolName }],
      packet,
      new AbortController().signal,
    );
    expect(result.status).toBe("unavailable");
    expect(result.summary).not.toContain("synthetic provider secret");
    expect(result.summary).toContain(
      output instanceof Error
        ? "financial_capability_unavailable"
        : "nonfinite mathematical result",
    );
  }
});

it("preserves scoped custom read values with unknown source time and whole-field UTF8 omissions", async () => {
  const raw = { ok: true, value: 42, untrustedText: "中".repeat(1000) };
  const execute = vi.fn(
    async ({
      candidate,
      question,
    }: Parameters<FinanceTradeReviewFinancialCapability["execute"]>[0]) => {
      expect(candidate.instrument).toBe("AAA");
      expect(question).toBe("What is recorded?");
      return raw;
    },
  );
  const capability: FinanceTradeReviewFinancialCapability = {
    toolName: "host_local_read",
    moduleIds: ["credit_liquidity"],
    description: "Actual host read",
    execute,
  };
  const scope = {
    directory: "unused",
    accountId: "paper-a",
    instruments: ["AAA"],
    financialCapabilities: [capability],
  };
  expect(describeFinanceTradeReviewFinancialCapabilities(scope)).toEqual([
    {
      toolName: capability.toolName,
      moduleIds: ["credit_liquidity"],
      description: "Actual host read",
      boundary: "recorded_financial_knowledge_research_only_not_market_or_account_facts",
    },
  ]);
  const [result] = await createFinanceTradeReviewEvidenceExecutor(scope)(
    [{ ...financialRequest, toolName: capability.toolName, question: "What is recorded?" }],
    packet,
    new AbortController().signal,
  );
  const summary = JSON.parse(result.summary);
  expect(summary.result.value).toBe(42);
  expect(summary.result.sourceTime).toBe("source_time_unverified");
  expect(summary.omittedKeys).toContain("untrustedText");
  expect(summary.result).not.toHaveProperty("untrustedText");
  expect(result.resultSha256).toBe(createHash("sha256").update(JSON.stringify(raw)).digest("hex"));
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2048);
  const controller = new AbortController();
  controller.abort();
  await expect(
    createFinanceTradeReviewEvidenceExecutor(scope)(
      [{ ...financialRequest, toolName: capability.toolName }],
      packet,
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(execute).toHaveBeenCalledTimes(1);
});

it.each([
  ["text", "未覆盖剩余条件。".repeat(200)],
  ["array", ["未覆盖剩余条件。".repeat(200), "tail constraint"]],
])(
  "retains a scoped partial %s knowledge field without implying complete constraints",
  async (_kind, value) => {
    const raw = {
      ok: true,
      updatedAt: "2026-09-29T00:00:00.000Z",
      entry: { riskGateNotes: value, requiredInputs: ["current spread"], baseCase: "bounded case" },
    };
    const capability: FinanceTradeReviewFinancialCapability = {
      toolName: "host_local_read",
      moduleIds: ["credit_liquidity"],
      description: "Actual host read",
      execute: async () => raw,
    };
    const [result] = await createFinanceTradeReviewEvidenceExecutor({
      directory: "unused",
      accountId: "paper-a",
      instruments: ["AAA"],
      financialCapabilities: [capability],
    })(
      [{ ...financialRequest, toolName: capability.toolName }],
      packet,
      new AbortController().signal,
    );
    const summary = JSON.parse(result.summary);
    const fragment = summary.result.knowledge["entry.riskGateNotes"];
    expect(fragment).toMatchObject({
      fragmentFormat: "json_prefix_not_complete_value",
      originalJsonBytes: Buffer.byteLength(JSON.stringify(value)),
    });
    expect(JSON.stringify(value).startsWith(fragment.jsonPrefix)).toBe(true);
    expect(fragment.jsonPrefix).toContain("未覆盖");
    expect(fragment.jsonPrefix).not.toContain("\uFFFD");
    expect(Buffer.byteLength(fragment.jsonPrefix)).toBeLessThanOrEqual(160);
    expect(summary.result.knowledge["entry.requiredInputs"]).toEqual(["current spread"]);
    expect(summary.result.knowledge["entry.baseCase"]).toBe("bounded case");
    expect(summary.result.omittedKnowledgeFieldCount).toBe(1);
    expect(result.resultSha256).toBe(
      createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
    );
    expect(result).toMatchObject({ status: "completed", accountId: "paper-a", asOf });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2048);
  },
);

it("passes partial knowledge from the original file reader into the existing next decision call", async () => {
  const scope = await fixture();
  const { contractPath } = await seedKnowledge(scope.directory);
  const original = await fs.readFile(contractPath, "utf8");
  const longNotes =
    "Preserve the exact stop. " + "Other constraints require precise lookup. ".repeat(100);
  await fs.writeFile(
    contractPath,
    original.replace("Preserve the exact stop and verify costs.", longNotes),
  );
  const before = await fs.readFile(contractPath);
  const capabilities = createFinanceTradeReviewFinancialCapabilities({
    workspaceDir: scope.directory,
  });
  const payloads: unknown[] = [];
  const prompts: string[] = [];
  const model = scripted(
    [
      {
        schemaVersion: packet.schemaVersion,
        evidenceRequests: [financialRequest],
        hypothesis: "Read recorded stop constraints",
      },
      decision,
    ],
    payloads,
  );
  const result = await createFinanceTradeDecisionReviewer(
    {},
    {
      adapterFactory: (_config, options) => ({
        ...model.model,
        invoke: async (call, signal) => {
          prompts.push(options!.buildPrompt!(call.payload));
          return model.model.invoke(call, signal);
        },
      }),
      evidenceScope: { ...scope, financialCapabilities: capabilities },
    },
  )(packet, new AbortController().signal);
  expect(result).toMatchObject({
    status: "completed",
    modelCalls: 2,
    toolEvidence: [{ status: "completed" }],
  });
  const evidence = result.toolEvidence![0];
  const summary = JSON.parse(evidence.summary);
  expect(summary.result.knowledge["entry.riskGateNotes"]).toMatchObject({
    fragmentFormat: "json_prefix_not_complete_value",
  });
  expect(summary.result.knowledge["entry.riskGateNotes"].jsonPrefix).toContain(
    "Preserve the exact stop.",
  );
  expect(JSON.stringify(payloads[1])).toContain("json_prefix_not_complete_value");
  expect(prompts[0]).not.toContain("Its unseen tail remains unknown");
  expect(prompts[1]).toContain("Its unseen tail remains unknown");
  expect(prompts[1]).toContain("incompleteness alone is not a veto");
  expect(JSON.stringify(payloads[1])).toContain(evidence.resultSha256);
  expect(await fs.readFile(contractPath)).toEqual(before);
  expect(result.modelCallEvidence![1].toolEvidenceSha256).toBe(
    createHash("sha256").update(JSON.stringify(result.toolEvidence)).digest("hex"),
  );
  expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(2048);
});

it("degrades an oversized financial projection to named unknown while keeping full raw SHA and scope within 2048 bytes", async () => {
  const raw = Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => [`field_${i}`, "中".repeat(300)]),
  );
  const capability: FinanceTradeReviewFinancialCapability = {
    toolName: "host_local_read",
    moduleIds: ["credit_liquidity"],
    description: "Actual host read",
    execute: async () => raw,
  };
  const [result] = await createFinanceTradeReviewEvidenceExecutor({
    directory: "unused",
    accountId: "a".repeat(240),
    instruments: ["AAA"],
    financialCapabilities: [capability],
  })(
    [{ ...financialRequest, toolName: capability.toolName }],
    packet,
    new AbortController().signal,
  );
  expect(result).toMatchObject({ status: "unavailable", accountId: "a".repeat(240), asOf });
  expect(JSON.parse(result.summary).result.reason).toBe(
    "financial_capability_result_omitted_by_budget",
  );
  expect(JSON.parse(result.summary).omittedKeys).toEqual(["result"]);
  expect(result.resultSha256).toBe(createHash("sha256").update(JSON.stringify(raw)).digest("hex"));
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2048);
});

it.each(["unknown", "failed", "absent"])(
  "preserves a registered reader's %s result as unavailable rather than fabricated completion",
  async (status) => {
    const capability: FinanceTradeReviewFinancialCapability = {
      toolName: "host_local_read",
      moduleIds: ["credit_liquidity"],
      description: "Host read only",
      execute: async () => ({ status, reason: "Recorded knowledge missing" }),
    };
    const [result] = await createFinanceTradeReviewEvidenceExecutor({
      directory: "unused",
      accountId: "paper-a",
      instruments: ["AAA"],
      financialCapabilities: [capability],
    })(
      [{ ...financialRequest, toolName: capability.toolName }],
      packet,
      new AbortController().signal,
    );
    expect(result.status).toBe("unavailable");
    expect(JSON.parse(result.summary).result.status).toBe(status);
  },
);

const brokerRequest = { candidateId: "signal", action: "broker_fill_feedback" as const };
async function brokerFixture(
  options: {
    scope?: Awaited<ReturnType<typeof fixture>>;
    unknownFee?: boolean;
    unknownFeeQty?: string;
    instrument?: string;
    additionalFees?: Record<string, unknown>[];
    observedAt?: string;
    accountId?: string;
  } = {},
) {
  const directory =
    options.scope?.directory ?? (await fs.mkdtemp(path.join(os.tmpdir(), "review-broker-")));
  if (!options.scope) {
    dirs.push(directory);
  }
  const scope = options.scope ?? {
    directory,
    accountId: options.accountId ?? "paper-a",
    instruments: [options.instrument ?? "AAA"],
  };
  const append = (query: string, payload: Record<string, unknown>[], accountId = scope.accountId) =>
    appendFinanceBrokerHistory(directory, {
      kind: "broker_history",
      accountId,
      venue: "alpaca:paper",
      query,
      cursor: "",
      payload,
    });
  await append("activities:offline-fixture", [
    ...(["buy", "sell"] as const).map((side, i) => ({
      id: side,
      activity_type: "FILL",
      type: "fill",
      symbol: options.instrument ?? "AAA",
      side,
      qty: side === "buy" ? "2" : "1",
      price: side === "buy" ? "100" : "110",
      order_id: side,
      transaction_time: `2026-09-30T13:0${i}:00.000Z`,
    })),
    ...(["buy", "sell"] as const).map((order, i) => ({
      id: `${order}-fee`,
      activity_type: "FEE",
      status: "executed",
      currency: "USD",
      net_amount: order === "buy" ? "-2" : "-0.5",
      order_id: order,
      transaction_time: `2026-09-30T13:0${i}:00.000Z`,
    })),
    ...(options.unknownFee
      ? [
          {
            id: "unallocated-fee",
            activity_type: "CFEE",
            status: "executed",
            currency: "USD",
            net_amount: "-0.1",
            ...(options.unknownFeeQty === undefined ? {} : { qty: options.unknownFeeQty }),
            transaction_time: "2026-09-30T13:02:00.000Z",
          },
        ]
      : []),
    ...(options.additionalFees ?? []),
  ]);
  await append(
    "activities:other-account",
    [
      {
        id: "foreign-buy",
        activity_type: "FILL",
        type: "fill",
        symbol: options.instrument ?? "AAA",
        side: "buy",
        qty: "100",
        price: "900",
        transaction_time: "2026-09-30T13:00:00.000Z",
      },
    ],
    "paper-other",
  );
  await append("reconciliation:offline-sealed", [
    {
      observedAt: options.observedAt ?? asOf,
      status: "reconciled",
      feesInterpreted: true,
      issues: [],
      differences: [],
      cashDifference: 0,
    },
  ]);
  return scope;
}

it("consumes real sealed FIFO and math together on call2 and persists additive broker evidence", async () => {
  const scope = await brokerFixture({ scope: await fixture() });
  const databaseBefore = await fs.readFile(financePositionLedgerPath(scope.directory));
  const raw = await readFinanceBrokerInstrumentFeedback({ ...scope, instrument: "AAA", asOf });
  const payloads: unknown[] = [];
  const fixtureModel = scripted(
    [
      {
        schemaVersion: packet.schemaVersion,
        evidenceRequests: [brokerRequest, requests[0]],
        hypothesis: "Inspect recorded costs and historical risk",
      },
      decision,
    ],
    payloads,
  );
  const result = await createFinanceTradeDecisionReviewer(
    {},
    {
      adapterFactory: fixtureModel.factory,
      evidenceScope: scope,
    },
  )(packet, new AbortController().signal);
  expect(result).toMatchObject({
    status: "completed",
    modelCalls: 2,
    toolEvidence: [
      {
        action: "broker_fill_feedback",
        status: "completed",
        accountId: scope.accountId,
        asOf,
        boundary: "recorded_broker_fill_feedback_not_strategy_edge_or_expected_return",
      },
      { action: "max_drawdown", status: "completed" },
    ],
  });
  const evidence = result.toolEvidence![0];
  const summary = JSON.parse(evidence.summary);
  expect(summary.result.economics).toMatchObject({
    basis: "broker_fill_fifo_usd_not_strategy_attribution",
    buyFills: 1,
    sellFills: 1,
    matchedLotCount: 1,
    openLotCount: 1,
    grossMatchedPnl: 10,
    netMatchedPnl: 8.5,
    allocatedClosedCashFees: 1.5,
    unallocatedFeeActivityCount: 0,
    feeActivityCount: 2,
  });
  expect(summary.result).toMatchObject({
    freshness: "fresh",
    observedAt: asOf,
    sealedSequence: 3,
    observationBoundary: "snapshot_observedAt_and_sequence_only_no_per_record_capture_time",
  });
  expect(summary.result.snapshotRef).toMatch(/^[a-f\d]{64}$/u);
  expect(evidence.resultSha256).toBe(
    createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
  );
  expect(evidence.requestSha256).toBe(
    createHash("sha256").update(JSON.stringify(brokerRequest)).digest("hex"),
  );
  expect(JSON.stringify(payloads[1])).toContain('\\"netMatchedPnl\\":8.5');
  expect(
    result.toolEvidence!.every((item) => Buffer.byteLength(JSON.stringify(item)) <= 2048),
  ).toBe(true);
  expect(await fs.readFile(financePositionLedgerPath(scope.directory))).toEqual(databaseBefore);
  await appendFinanceIntradayDecision(scope.directory, {
    signalId: "signal",
    instrument: "AAA",
    sessionDate: "2026-09-30",
    action: "buy",
    reason: "opening_range_breakout",
    referencePrice: 100,
    referencePriceAt: asOf,
    datasetHeadRef: "a".repeat(64),
    strategyRule: "opening_range_breakout_long_next_bar_v1",
  });
  const { decisions: _decisions, ...metadata } = result;
  await appendFinanceIntradayOutcome(scope.directory, {
    signalId: "signal",
    status: "refused",
    reasons: ["offline-scripted veto"],
    tradeDecisionReview: FinanceIntradayDecisionReviewReceiptSchema.parse({
      ...metadata,
      request: packet,
      decision: result.decisions![0],
    }),
  });
  expect(
    (await readFinanceIntradayOutcome(scope.directory, "signal"))?.tradeDecisionReview
      ?.toolEvidence,
  ).toEqual(result.toolEvidence);
});

it("keeps unknown fees and absent closed samples explicit without reading a bar ledger or granting authority", async () => {
  const scope = await brokerFixture({ unknownFee: true });
  const execute = createFinanceTradeReviewEvidenceExecutor({
    ...scope,
    instruments: ["AAA", "BBB"],
  });
  const [evidence] = await execute([brokerRequest], packet, new AbortController().signal);
  expect(evidence.status).toBe("completed");
  expect(JSON.parse(evidence.summary).result.economics).toMatchObject({
    grossMatchedPnl: 10,
    netMatchedPnl: null,
    unallocatedFeeActivityCount: 1,
    issues: ["fees_not_allocated_to_closed_lots"],
    status: "net_profit_unverified",
  });
  const otherPacket: FinanceIntradayTradeDecisionReviewRequest = {
    ...packet,
    candidates: [{ ...packet.candidates[0], instrument: "BBB" }],
  };
  const [other] = await execute([brokerRequest], otherPacket, new AbortController().signal);
  expect(JSON.parse(other.summary).result.economics).toMatchObject({
    instrument: "BBB",
    matchedLotCount: 0,
    netMatchedPnl: null,
    status: "no_closed_matches",
  });
  expect(other.sourceRef).not.toBe(evidence.sourceRef);
  expect(evidence).not.toHaveProperty("executionAuthority");
});

it.each([
  ["stale", "2026-09-30T13:54:59.999Z", "snapshot_stale"],
  ["future", "2026-09-30T14:00:00.001Z", "missing_snapshot_at_cutoff"],
])(
  "passes %s native snapshot limitations to call2 without fabricating net economics",
  async (_kind, observedAt, reason) => {
    const scope = await brokerFixture({ observedAt });
    const payloads: unknown[] = [];
    const fixtureModel = scripted(
      [
        {
          schemaVersion: packet.schemaVersion,
          evidenceRequests: [brokerRequest],
          hypothesis: "Use only recorded accounting within cutoff",
        },
        decision,
      ],
      payloads,
    );
    const result = await createFinanceTradeDecisionReviewer(
      {},
      { adapterFactory: fixtureModel.factory, evidenceScope: scope },
    )(packet, new AbortController().signal);
    expect(result).toMatchObject({
      status: "completed",
      modelCalls: 2,
      toolEvidence: [{ status: "unavailable" }],
    });
    expect(JSON.parse(result.toolEvidence![0].summary).result.reason).toBe(reason);
    expect(JSON.stringify(payloads[1])).toContain(reason);
    expect(JSON.parse(result.toolEvidence![0].summary).result).not.toHaveProperty("economics");
  },
);

it.each([
  "directory",
  "accountId",
  "asOf",
  "instrument",
  "toolName",
  "moduleId",
  "lookbackWindow",
  "question",
])("rejects broker %s overrides rather than accepting financial or math fields", (key) => {
  expect(
    FinanceTradeReviewEvidenceRequestSchema.safeParse({ ...brokerRequest, [key]: "injected" })
      .success,
  ).toBe(false);
});

it("keeps full broker raw hash and explicit unknown when a UTF8 account scope exhausts the envelope budget", async () => {
  const scope = await brokerFixture({ accountId: "户".repeat(240) });
  const raw = await readFinanceBrokerInstrumentFeedback({ ...scope, instrument: "AAA", asOf });
  expect(raw.status).toBe("present");
  const [evidence] = await createFinanceTradeReviewEvidenceExecutor(scope)(
    [brokerRequest],
    packet,
    new AbortController().signal,
  );
  expect(evidence.status).toBe("unavailable");
  expect(JSON.parse(evidence.summary)).toMatchObject({
    result: { reason: "broker_fill_feedback_result_omitted_by_budget" },
    omittedKeys: ["result"],
  });
  expect(evidence.resultSha256).toBe(
    createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
  );
  expect(evidence.accountId).toBe(scope.accountId);
  expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(2048);
});

it("validates the whole mixed batch before a reader starts, retains the shared request bound and propagates abort", async () => {
  const scope = await brokerFixture();
  const execute = vi.fn(async () => ({ value: "not reached" }));
  const executor = createFinanceTradeReviewEvidenceExecutor({
    ...scope,
    financialCapabilities: [
      {
        toolName: "host_read",
        moduleIds: ["credit_liquidity"],
        description: "Offline registered read",
        execute,
      },
    ],
  });
  await expect(
    executor(
      [
        { ...financialRequest, toolName: "host_read", moduleId: "credit_liquidity" },
        { ...brokerRequest, candidateId: "outside" },
      ],
      packet,
      new AbortController().signal,
    ),
  ).rejects.toThrow("outside host candidate/instrument scope");
  expect(execute).not.toHaveBeenCalled();
  await expect(
    executor([brokerRequest, brokerRequest], packet, new AbortController().signal),
  ).rejects.toThrow("duplicate");
  await expect(
    executor([brokerRequest, requests[0], requests[1]], packet, new AbortController().signal),
  ).rejects.toThrow("count");
  const controller = new AbortController();
  const pending = executor([brokerRequest], packet, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
  const [wrongAccount] = await createFinanceTradeReviewEvidenceExecutor({
    ...scope,
    accountId: "unknown-paper",
  })([brokerRequest], packet, new AbortController().signal);
  expect(wrongAccount.status).toBe("unavailable");
  expect(JSON.parse(wrongAccount.summary).result.reason).toBe("missing_snapshot_at_cutoff");
});

it.each([
  { qty: undefined, unpriced: 0, bounds: { lower: 8.4, upper: 8.5 } },
  { qty: "-0.01", unpriced: 1, bounds: null },
])(
  "preserves bounded fee allocation and its unknowns inside the original byte budget: %j",
  async ({ qty, unpriced, bounds }) => {
    const scope = await brokerFixture({ unknownFee: true, unknownFeeQty: qty });
    const raw = await readFinanceBrokerInstrumentFeedback({ ...scope, instrument: "AAA", asOf });
    const databaseBefore = await fs.readFile(financePositionLedgerPath(scope.directory));
    const [evidence] = await createFinanceTradeReviewEvidenceExecutor(scope)(
      [brokerRequest],
      packet,
      new AbortController().signal,
    );
    expect(evidence.status).toBe("completed");
    const summary = JSON.parse(evidence.summary);
    expect(summary.result.economics).toMatchObject({
      grossMatchedPnl: 10,
      netMatchedPnl: null,
      unallocatedCashFeeAmount: unpriced ? 0 : 0.1,
      unpricedFeeActivityCount: unpriced,
      recordedCashFeePnlBounds: bounds,
      cashFeeAllocationBoundary:
        "recorded_cash_fees_only_not_exact_net_nonadditive_across_instruments",
      costScope: "broker_reported_activities_only_excludes_tax_fx_and_external_costs",
      status: "net_profit_unverified",
    });
    expect(summary.result.snapshotRef).toMatch(/^[a-f\d]{64}$/u);
    expect(summary.result.observationBoundary).toBe(
      "snapshot_observedAt_and_sequence_only_no_per_record_capture_time",
    );
    expect(evidence.resultSha256).toBe(
      createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
    );
    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(2048);
    expect(await fs.readFile(financePositionLedgerPath(scope.directory))).toEqual(databaseBefore);
  },
);

it("consumes asset fee source valuation and persists its boundary without inventing closed costs", async () => {
  const scope = await brokerFixture({
    instrument: "BTC/USD",
    unknownFee: true,
    additionalFees: ["80537.6", "80519.3"].map((price, i) => ({
      id: `asset-fee-${i}`,
      activity_type: "CFEE",
      symbol: "BTCUSD",
      qty: "-0.0000005",
      price,
      currency: "USD",
      net_amount: "0",
      status: "executed",
      created_at: `2026-09-30T13:0${i}:01.000Z`,
    })),
  });
  const request: FinanceIntradayTradeDecisionReviewRequest = {
    ...structuredClone(packet),
    candidates: [{ ...packet.candidates[0], instrument: "BTC/USD" }],
  };
  const originalPacket = structuredClone(request);
  const before = await fs.readFile(financePositionLedgerPath(scope.directory));
  const feedback = await readFinanceBrokerInstrumentFeedback({
    directory: scope.directory,
    accountId: scope.accountId,
    instrument: "BTC/USD",
    asOf,
  });
  expect(feedback.status).toBe("present");
  const payloads: unknown[] = [];
  const models: LogicalAgentModelAdapter[] = [
    scripted([
      {
        schemaVersion: request.schemaVersion,
        evidenceRequests: [brokerRequest],
        hypothesis: "What source valuation exists for the recorded asset fee debit?",
      },
    ]).model,
    {
      ...scripted([]).model,
      invoke: async (call) => {
        payloads.push(call.payload);
        const payload = call.payload as {
          candidates: unknown;
          toolEvidence: { summary: string; status: string }[];
        };
        expect(payload.candidates).toEqual(request.candidates);
        expect(payload.toolEvidence[0].status).toBe("completed");
        const result = JSON.parse(payload.toolEvidence[0].summary).result;
        const valuation = result.economics.reportedAssetFeeValuation;
        expect(valuation.usdValue).toBeCloseTo(0.08052845, 12);
        expect(valuation.activityCount).toBe(2);
        expect(valuation.basis).toBe("broker_qty_x_price_not_cash_or_closed_lot_cost");
        expect(result.economics.netMatchedPnl).toBeNull();
        expect(result.economics.recordedCashFeePnlBounds).toBeNull();
        expect(result.economics.unpricedFeeActivityCount).toBe(2);
        expect(result.economics.unallocatedCashFeeAmount).toBeCloseTo(0.1, 12);
        return {
          schemaVersion: request.schemaVersion,
          decisions: [
            {
              candidateId: "signal",
              decision: "approve",
              rationale: `Broker-reported asset fee valuation=${valuation.usdValue} USD from ${valuation.activityCount} activities; exact closed costs remain unknown. It is not a cash charge or predictive edge.`,
            },
          ],
        };
      },
    },
  ];
  let finalPrompt = "";
  const reviewer = createFinanceTradeDecisionReviewer(
    {},
    {
      evidenceScope: scope,
      adapterFactory: (_cfg, options) => {
        const model = models.shift()!;
        return {
          ...model,
          invoke: (call, signal) => {
            finalPrompt = options!.buildPrompt!(call.payload);
            return model.invoke(call, signal);
          },
        };
      },
    },
  );
  const result = await reviewer(request, AbortSignal.timeout(5000));
  expect(result, JSON.stringify(result)).toMatchObject({
    status: "completed",
    modelCalls: 2,
    providerCallObserved: false,
    adapterAttested: false,
  });
  expect(payloads).toHaveLength(1);
  expect(request).toEqual(originalPacket);
  expect(finalPrompt).toContain("reportedAssetFeeValuation");
  expect(finalPrompt).toContain("never subtract it again");
  const evidence = result.toolEvidence![0];
  expect(Buffer.byteLength(JSON.stringify(evidence), "utf8")).toBeLessThanOrEqual(2048);
  expect(evidence.resultSha256).toBe(
    createHash("sha256").update(JSON.stringify(feedback)).digest("hex"),
  );
  expect(await fs.readFile(financePositionLedgerPath(scope.directory))).toEqual(before);
  await appendFinanceIntradayDecision(scope.directory, {
    signalId: "signal",
    instrument: "BTC/USD",
    sessionDate: "2026-09-30",
    action: "buy",
    reason: "opening_range_breakout",
    referencePrice: 100,
    referencePriceAt: asOf,
    datasetHeadRef: "a".repeat(64),
    strategyRule: "opening_range_breakout_long_next_bar_v1",
  });
  const receipt = FinanceIntradayDecisionReviewReceiptSchema.parse({
    request,
    status: result.status,
    attempted: result.attempted,
    modelCalls: result.modelCalls,
    provider: result.provider,
    modelId: result.modelId,
    latencyMs: result.latencyMs,
    providerCallObserved: false,
    adapterAttested: false,
    toolEvidence: result.toolEvidence,
    decision: result.decisions![0],
  });
  const outcome = {
    signalId: "signal",
    status: "refused" as const,
    reasons: ["deterministic test only, no order"],
    tradeDecisionReview: receipt,
  };
  await appendFinanceIntradayOutcome(scope.directory, outcome);
  expect(await readFinanceIntradayOutcome(scope.directory, "signal")).toEqual(outcome);
});

it("continues a specific doubt after the first real tool result and retains both rounds in DB and feedback", async () => {
  const scope = await fixture();
  const payloads: unknown[] = [];
  const fixtureModel = scripted(
    [
      {
        schemaVersion: packet.schemaVersion,
        evidenceRequests: [{ candidateId: "signal", action: "daily_closes" }],
        hypothesis: "Check the retained price path first.",
      },
      {
        schemaVersion: packet.schemaVersion,
        evidenceRequests: [{ candidateId: "signal", action: "max_drawdown" }],
        hypothesis: "Quantify the historical downside of that path.",
      },
      decision,
    ],
    payloads,
  );
  const reviewer = createFinanceTradeDecisionReviewer(
    {},
    {
      adapterFactory: fixtureModel.factory,
      evidenceScope: scope,
    },
  );
  const result = await reviewer(packet, new AbortController().signal);
  expect(result).toMatchObject({ status: "completed", modelCalls: 3 });
  expect(result.toolEvidence?.map(({ action }) => action)).toEqual([
    "daily_closes",
    "max_drawdown",
  ]);
  const second = payloads[1] as {
    toolEvidence: unknown[];
    evidenceToolsAvailable: boolean;
    evidenceHistory: unknown[];
  };
  const third = payloads[2] as {
    toolEvidence: unknown[];
    evidenceToolsAvailable?: boolean;
    evidenceHistory: unknown[];
  };
  expect(second.evidenceToolsAvailable).toBe(true);
  expect(second.evidenceHistory).toHaveLength(1);
  expect(second.toolEvidence).toEqual(result.toolEvidence?.slice(0, 1));
  expect(third.evidenceToolsAvailable).toBeUndefined();
  expect(third.toolEvidence).toEqual(result.toolEvidence);
  expect(third.evidenceHistory).toHaveLength(2);
  expect(result.modelCallEvidence?.map(({ resultKind }) => resultKind)).toEqual([
    "evidence_request",
    "evidence_request",
    "decision",
  ]);
  await appendFinanceIntradayDecision(scope.directory, {
    signalId: "signal",
    instrument: "AAA",
    sessionDate: "2026-09-30",
    action: "buy",
    reason: "opening_range_breakout",
    referencePrice: 100,
    referencePriceAt: asOf,
    datasetHeadRef: "a".repeat(64),
    strategyRule: "opening_range_breakout_long_next_bar_v1",
  });
  const { decisions: _decisions, ...metadata } = result;
  const receipt = FinanceIntradayDecisionReviewReceiptSchema.parse({
    ...metadata,
    request: packet,
    decision: result.decisions?.[0],
  });
  await appendFinanceIntradayOutcome(scope.directory, {
    signalId: "signal",
    status: "refused",
    reasons: ["model veto"],
    tradeDecisionReview: receipt,
  });
  expect(
    (await readFinanceIntradayOutcome(scope.directory, "signal"))?.tradeDecisionReview
      ?.modelCallEvidence,
  ).toEqual(result.modelCallEvidence);
  const night = await buildFinanceNightReviewEvidence({
    directory: scope.directory,
    asOf: new Date().toISOString(),
    etDate: "2026-09-30",
    settlement: {
      scoredFiled: { appended: 0, skipped: 0 },
      reflection: {},
      pending: [],
      declined: [],
      issues: [],
    },
  });
  const projected = JSON.parse(
    night.find((item) => item.source === "finance-intraday-control-ledger")!.text,
  ).decisions[0].outcome.tradeDecisionReview;
  expect(projected.modelCallEvidence).toEqual(result.modelCallEvidence?.slice(-2));
  expect(projected.omittedModelCallEvidenceCount).toBe(1);
  expect(projected.modelCallEvidence.at(-1).resultKind).toBe("decision");
});

it("does not rerun a retained tool when a follow-up repeats it alongside a new request", async () => {
  const scope = await fixture();
  const execute = vi.fn(async () => ({
    available: true,
    status: "completed",
    result: { finding: "retained method" },
  }));
  const request = {
    candidateId: "signal",
    action: "financial_capability",
    toolName: "fixture_method",
    moduleId: "credit_liquidity" as const,
    question: "Check the candidate method.",
  };
  const model = scripted([
    {
      schemaVersion: packet.schemaVersion,
      evidenceRequests: [request],
      hypothesis: "Read the retained method.",
    },
    {
      schemaVersion: packet.schemaVersion,
      evidenceRequests: [request, { candidateId: "signal", action: "max_drawdown" }],
      hypothesis: "Add the missing historical risk calculation.",
    },
    decision,
  ]);
  const reviewer = createFinanceTradeDecisionReviewer(
    {},
    {
      adapterFactory: model.factory,
      evidenceScope: {
        ...scope,
        financialCapabilities: [
          {
            toolName: "fixture_method",
            moduleIds: ["credit_liquidity"],
            description: "retained test method",
            execute,
          },
        ],
      },
    },
  );
  const result = await reviewer(packet, new AbortController().signal);
  expect(result).toMatchObject({ status: "completed", modelCalls: 3 });
  expect(result.toolEvidence).toHaveLength(2);
  expect(execute).toHaveBeenCalledTimes(1);
});

it.each(["repeat_only", "no_decision_slot", "tool_budget", "provider_failed"] as const)(
  "stops the original adaptive loop without losing earlier evidence (%s)",
  async (mode) => {
    const scope = await fixture();
    const ask = (actions: string[]) => ({
      schemaVersion: packet.schemaVersion,
      hypothesis: "Resolve this specific remaining historical risk doubt.",
      evidenceRequests: actions.map((action) => ({ candidateId: "signal", action })),
    });
    const outputs =
      mode === "tool_budget"
        ? [
            ask(["daily_closes", "max_drawdown"]),
            ask(["z_score"]),
            ask(["returns_from_levels", "broker_fill_feedback"]),
            decision,
          ]
        : [
            ask(["daily_closes"]),
            mode === "provider_failed"
              ? new ModelAdapterError("provider_payment_required")
              : ask([mode === "repeat_only" ? "daily_closes" : "max_drawdown"]),
            decision,
          ];
    const fixtureModel = scripted(outputs);
    const reviewer = createFinanceTradeDecisionReviewer(
      {},
      {
        adapterFactory: fixtureModel.factory,
        evidenceScope: scope,
      },
    );
    const result = await reviewer(packet, new AbortController().signal, {
      maxModelCalls: mode === "no_decision_slot" ? 2 : 4,
    });
    expect(result).toMatchObject({
      status: "failed",
      modelCalls: mode === "tool_budget" ? 3 : 2,
      failureCode:
        mode === "provider_failed"
          ? "provider_payment_required"
          : mode === "repeat_only"
            ? "output_invalid"
            : "call_budget_exhausted",
    });
    expect(result.toolEvidence).toHaveLength(mode === "tool_budget" ? 3 : 1);
    expect(result.toolEvidence?.[0]).toMatchObject({ action: "daily_closes", status: "completed" });
    expect(fixtureModel.model.invoke).toHaveBeenCalledTimes(mode === "tool_budget" ? 3 : 2);
  },
);
