import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { ArtifactStore } from "../memory/artifact-store.js";
import { FinanceIntradayDecisionInput } from "./finance-intraday-control-ledger.js";
import {
  createFinanceTradeDecisionReviewer,
  FINANCE_INTRADAY_TRADE_DECISION_REVIEW_SCHEMA,
  type FinanceIntradayTradeDecisionReviewRequest,
} from "./finance-trade-decision-review.js";
import { createFinanceTradeResultRecallCapability } from "./finance-trade-result-recall.js";
import {
  createFinanceTradeReviewEvidenceExecutor,
  createFinanceTradeReviewFinancialCapabilities,
  FinanceTradeReviewEvidenceRequestSchema,
} from "./finance-trade-review-evidence.js";
import type { LogicalAgentModelAdapter } from "./logical-agent-model-router.js";

let root: string;
let cfg: OpenClawConfig;
const asOf = "2026-09-30T14:00:00.000Z";
const oldTime = "2026-09-29T14:00:00.000Z";
const candidate = {
  candidateId: "current-signal",
  instrument: "AAA",
  side: "buy" as const,
  strategyRule: "opening_range_breakout_long_next_bar_v1",
  signalReason: "opening_range_breakout" as const,
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
};
const packet: FinanceIntradayTradeDecisionReviewRequest = {
  schemaVersion: FINANCE_INTRADAY_TRADE_DECISION_REVIEW_SCHEMA,
  venue: "alpaca:paper",
  asOf,
  signalAnchor: candidate.candidateId,
  ruleIds: ["rule"],
  equity: 100000,
  caps: { maxOrderNotional: 1000, maxInstrumentNotional: 5000, maxOrdersPerRun: 8 },
  positionBookObservedAt: asOf,
  reconciliation: { status: "reconciled" },
  positions: [],
  candidates: [candidate],
};
const request = {
  candidateId: candidate.candidateId,
  action: "financial_capability" as const,
  toolName: "finance_trade_result_recall",
  moduleId: "finance_learning_memory" as const,
  question: "Which previous rejection should I check on this candidate?",
};
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "finance-result-recall-"));
  cfg = {
    agents: {
      defaults: {
        workspace: root,
        memorySearch: { store: { path: path.join(root, "memory.sqlite") } },
      },
    },
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
async function seed(
  options: {
    id?: string;
    accountId?: string;
    venue?: string;
    instrument?: string;
    signalId?: string;
    owner?: string;
    observedAt?: string;
    decisionRecordedAt?: string;
    sourceTime?: string;
    reasons?: string[];
    summary?: string;
    padding?: string;
    review?: Record<string, unknown>;
    status?: "placed" | "refused" | "uncertain";
  } = {},
) {
  const id = options.id ?? "prior-result";
  const signalId = options.signalId ?? "prior-signal";
  const input = FinanceIntradayDecisionInput.parse({
    signalId,
    instrument: options.instrument ?? "AAA",
    sessionDate: "2026-09-29",
    action: "buy",
    reason: "opening_range_breakout",
    referencePrice: 100,
    referencePriceAt: options.sourceTime ?? oldTime,
    datasetHeadRef: "a".repeat(64),
    strategyRule: "opening_range_breakout_long_next_bar_v1",
  });
  const details = {
    accountId: options.accountId ?? "paper-a",
    venue: options.venue ?? "alpaca:paper",
    ...(options.padding ? { unusedResearch: options.padding } : {}),
    decision: { input, recordedAt: options.decisionRecordedAt ?? oldTime, ref: "b".repeat(64) },
    outcome: {
      signalId,
      status: options.status ?? "refused",
      reasons: options.reasons ?? ["spread_cost_exceeds_edge"],
      ...(options.review ? { tradeDecisionReview: options.review } : {}),
    },
  };
  const relativePath = `state/artifacts/${id}.json`;
  await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await fs.writeFile(
    path.join(root, relativePath),
    JSON.stringify({
      schemaVersion: "lcx_agent_artifact_v1",
      owner: options.owner ?? "finance_intraday_execution",
      runId: signalId,
      value: { content: [{ type: "text", text: "AAA historical execution result" }], details },
    }),
  );
  const store = ArtifactStore.open({
    dbPath: path.join(root, "memory.sqlite"),
    workspaceDir: root,
  });
  try {
    return (
      await store.register({
        id,
        owner: options.owner ?? "finance_intraday_execution",
        runId: signalId,
        observedAt: options.observedAt ?? oldTime,
        relativePath,
        mimeType: "application/json",
        summary: options.summary ?? "AAA historical execution result",
      })
    ).artifact;
  } finally {
    store.close();
  }
}
function run() {
  return createFinanceTradeResultRecallCapability({ config: cfg, workspaceDir: root }).execute(
    {
      moduleId: request.moduleId,
      candidate,
      question: request.question,
      accountId: "paper-a",
      venue: "alpaca:paper",
      asOf,
    },
    new AbortController().signal,
  );
}
it("reads the verified prior result with exact source identity and no database mutation", async () => {
  const source = await seed();
  const search = vi.spyOn(ArtifactStore.prototype, "search");
  const before = await fs.readFile(path.join(root, "memory.sqlite"));
  expect(await run()).toMatchObject({
    ok: true,
    sourceArtifactId: source.id,
    sourceSha256: source.sha256,
    sourceObservedAt: oldTime,
    recordedResult: { outcome: "refused", reasons: ["spread_cost_exceeds_edge"] },
  });
  expect(await fs.readFile(path.join(root, "memory.sqlite"))).toEqual(before);
  expect(search.mock.calls.map(([args]) => args.query)).toEqual(["AAA buy", "AAA"]);
});
it("finds the original operation before newer portfolio mentions consume the four-original budget", async () => {
  const source = await seed({ summary: "AAA buy: refused" });
  for (let index = 0; index < 4; index++) {
    await seed({
      id: `portfolio-mention-${index}`,
      instrument: "BBB",
      summary: "BBB buy: refused; AAA appears in portfolio context",
      observedAt: asOf,
    });
  }
  const read = vi.spyOn(ArtifactStore.prototype, "read");
  const search = vi.spyOn(ArtifactStore.prototype, "search");
  expect(await run()).toMatchObject({ ok: true, sourceArtifactId: source.id });
  expect(read).toHaveBeenCalledTimes(1);
  expect(search.mock.calls.map(([args]) => args.query)).toEqual(["AAA buy"]);
});
it("ranks native operation time rather than capture time after historical index repair", async () => {
  await seed({ id: "backfilled-old", observedAt: asOf, summary: "AAA buy: refused" });
  const recent = await seed({
    id: "recent-operation",
    observedAt: "2026-09-30T13:01:00.000Z",
    decisionRecordedAt: "2026-09-30T13:00:00.000Z",
    summary: "AAA buy: refused",
    reasons: ["recent decision-specific condition"],
  });
  const read = vi.spyOn(ArtifactStore.prototype, "read");
  expect(await run()).toMatchObject({
    ok: true,
    sourceArtifactId: recent.id,
    sourceObservedAt: "2026-09-30T13:01:00.000Z",
    recordedResult: {
      decisionRecordedAt: "2026-09-30T13:00:00.000Z",
      reasons: ["recent decision-specific condition"],
    },
  });
  expect(read).toHaveBeenCalledTimes(2);
});
it("retains the original account boundary and four reads when precise matches belong to another account", async () => {
  await seed({ summary: "AAA buy: refused" });
  for (let index = 0; index < 4; index++) {
    await seed({
      id: `foreign-${index}`,
      accountId: "other-account",
      summary: "AAA buy: refused",
      observedAt: asOf,
      reasons: ["foreign-private-reason"],
    });
  }
  const read = vi.spyOn(ArtifactStore.prototype, "read");
  const search = vi.spyOn(ArtifactStore.prototype, "search");
  const result = await run();
  expect(result).toMatchObject({
    ok: false,
    gap: "finance_recall_no_scoped_result_in_bounded_page",
  });
  expect(JSON.stringify(result)).not.toContain("foreign-private-reason");
  expect(read).toHaveBeenCalledTimes(4);
  expect(search).toHaveBeenCalledTimes(1);
});
it.each([
  { accountId: "other-account" },
  { venue: "alpaca:live" },
  { instrument: "BBB" },
  { signalId: candidate.candidateId },
  { owner: "central_harness" },
  { observedAt: "2026-10-01T00:00:00.000Z" },
])("does not expose out-of-scope or self evidence: %j", async (options) => {
  await seed(options);
  expect(await run()).toMatchObject({
    ok: false,
    status: "unavailable",
    gap: "finance_recall_no_prior_scoped_result",
  });
});
it("checks original event time even if index metadata predates the cutoff", async () => {
  await seed({ sourceTime: "2026-10-01T00:00:00.000Z" });
  expect(await run()).toMatchObject({
    ok: false,
    gap: "finance_recall_source_after_cutoff_or_invalid_time",
  });
});
it("keeps exact native signal identity, flags omitted text and preserves the required reason in the byte budget", async () => {
  const signalId = `intraday-${"c".repeat(64)}`;
  await seed({ signalId, reasons: ["风险".repeat(100), "second reason", "third reason"] });
  const capabilities = createFinanceTradeReviewFinancialCapabilities({
    config: cfg,
    workspaceDir: root,
  });
  const evidence = (
    await createFinanceTradeReviewEvidenceExecutor({
      directory: root,
      accountId: "paper-a",
      instruments: ["AAA"],
      financialCapabilities: capabilities,
    })([request], packet, new AbortController().signal)
  )[0];
  expect(evidence.status).toBe("completed");
  expect(JSON.parse(evidence.summary).result.recordedResult).toMatchObject({
    signalId,
    omittedReasonCount: 1,
    truncatedFields: ["reasons.0"],
  });
  expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(2048);
});
it("can pass over a verified foreign result without disclosing it", async () => {
  await seed();
  await seed({
    id: "newer-foreign",
    accountId: "other",
    observedAt: asOf,
    reasons: ["foreign-private-reason"],
  });
  const result = await run();
  expect(result).toMatchObject({ ok: true, sourceArtifactId: "prior-result" });
  expect(JSON.stringify(result)).not.toContain("foreign-private-reason");
});
it("reads exact useful fields when an unrelated payload exceeds the full-details budget", async () => {
  const source = await seed({ padding: "unneeded research".repeat(5000) });
  const read = vi.spyOn(ArtifactStore.prototype, "read");
  expect(await run()).toMatchObject({
    ok: true,
    sourceArtifactId: source.id,
    sourceSha256: source.sha256,
    recordedResult: { reasons: ["spread_cost_exceeds_edge"] },
  });
  expect(read.mock.calls.length).toBeLessThanOrEqual(11);
});

it.each([false, true])(
  "keeps placed execution distinct from failed model review (narrow=%s)",
  async (narrow) => {
    const padding = narrow ? "large unrelated data".repeat(4000) : undefined;
    await seed({
      padding,
      status: "placed",
      reasons: [],
      review: {
        status: "failed",
        failureCode: "provider_payment_required",
        request: { asOf: oldTime },
      },
    });
    const result = await run();
    expect(result).toMatchObject({
      ok: true,
      recordedResult: {
        outcome: "placed",
        reviewStatus: "failed",
        reviewFailureCode: "provider_payment_required",
      },
    });
    expect(result).not.toHaveProperty("recordedResult.reviewDecision");
  },
);

it.each([
  { accountId: "other-account" },
  { venue: "alpaca:live" },
  { instrument: "BBB" },
  { signalId: candidate.candidateId },
  { sourceTime: "2026-10-01T00:00:00.000Z" },
  { review: { request: { asOf: "2026-10-01T00:00:00.000Z" } } },
])(
  "preserves original scope and event-time checks during narrow selection: %j",
  async (options) => {
    await seed({
      ...options,
      padding: "large unrelated data".repeat(4000),
      reasons: ["private foreign or future reason"],
    });
    const result = await run();
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("private foreign or future reason");
  },
);

it("does not combine field selections after the original source changes", async () => {
  await seed({ padding: "large unrelated data".repeat(4000) });
  const originalRead = Reflect.get(ArtifactStore.prototype, "read");
  const reader = vi.spyOn(ArtifactStore.prototype, "read");
  let reads = 0;
  reader.mockImplementation(async function (this: ArtifactStore, ...args) {
    const result = await originalRead.apply(this, args);
    if (++reads === 2) {
      return { ...result, artifact: { ...result.artifact, sha256: "c".repeat(64) } };
    }
    return result;
  });
  expect(await run()).toMatchObject({
    ok: false,
    gap: "finance_recall_source_changed_during_selection",
  });
  expect(reads).toBe(2);
});

it("honors cancellation in the narrow-read fallback without issuing more reads", async () => {
  await seed({ padding: "large unrelated data".repeat(4000) });
  const controller = new AbortController();
  const originalRead = Reflect.get(ArtifactStore.prototype, "read");
  const reader = vi.spyOn(ArtifactStore.prototype, "read");
  let reads = 0;
  reader.mockImplementation(async function (this: ArtifactStore, ...args) {
    const result = await originalRead.apply(this, args);
    if (++reads === 2) {
      controller.abort();
    }
    return result;
  });
  await expect(
    createFinanceTradeResultRecallCapability({ config: cfg, workspaceDir: root }).execute(
      {
        moduleId: request.moduleId,
        candidate,
        accountId: "paper-a",
        venue: "alpaca:paper",
        asOf,
        question: request.question,
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(reads).toBe(2);
});

it("passes useful oversized reason fragments through the original tool budget without calling them complete", async () => {
  const source = await seed({
    signalId: `intraday-${"c".repeat(64)}`,
    reasons: ["风险".repeat(20000)],
  });
  const [evidence] = await createFinanceTradeReviewEvidenceExecutor({
    directory: root,
    accountId: "paper-a",
    instruments: ["AAA"],
    financialCapabilities: createFinanceTradeReviewFinancialCapabilities({
      config: cfg,
      workspaceDir: root,
    }),
  })([request], packet, new AbortController().signal);
  expect(evidence.status).toBe("completed");
  expect(JSON.parse(evidence.summary).result).toMatchObject({
    sourceSha256: source.sha256,
    recordedResult: {
      omittedReasonCount: null,
      reasonSelectionGap: "artifact_field_budget_exceeded",
      reasonFragmentFormat: "json_prefix_not_complete_reasons",
    },
  });
  expect(JSON.stringify(evidence)).toContain("风险");
  expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(2048);
});

it("names corrupted and missing originals while retaining a verified oversized reason fragment", async () => {
  await seed();
  await fs.writeFile(
    path.join(root, "state/artifacts/prior-result.json"),
    "secret changed original",
  );
  expect(await run()).toMatchObject({ ok: false, gap: "artifact_original_hash_mismatch" });
  await seed({ id: "oversized", reasons: ["risk".repeat(20000)], observedAt: asOf });
  expect(await run()).toMatchObject({
    ok: true,
    recordedResult: {
      reasons: [],
      omittedReasonCount: null,
      reasonSelectionGap: "artifact_field_budget_exceeded",
      reasonFragmentFormat: "json_prefix_not_complete_reasons",
    },
  });
  await fs.rm(path.join(root, "state/artifacts/oversized.json"));
  expect(await run()).toMatchObject({ ok: false, gap: "artifact_original_hash_mismatch" });
});
it("discloses a bounded search gap when a newer foreign page hides older scoped records", async () => {
  await seed();
  for (let i = 0; i < 4; i++) {
    await seed({
      id: `foreign-${i}`,
      accountId: "other",
      observedAt: `2026-09-30T13:0${i}:00.000Z`,
    });
  }
  expect(await run()).toMatchObject({
    ok: false,
    gap: "finance_recall_no_scoped_result_in_bounded_page",
  });
});
it("degrades without config, memory or host identity and rejects cancelled reads", async () => {
  const invoke = (config?: OpenClawConfig, withScope = true) =>
    createFinanceTradeResultRecallCapability({ config, workspaceDir: root }).execute(
      {
        moduleId: request.moduleId,
        candidate,
        question: request.question,
        ...(withScope ? { accountId: "paper-a", venue: "alpaca:paper" as const, asOf } : {}),
      },
      new AbortController().signal,
    );
  expect(await invoke()).toMatchObject({ gap: "artifact_memory_config_missing" });
  expect(await invoke(cfg)).toMatchObject({ gap: "artifact_database_missing" });
  expect(
    await invoke({ agents: { defaults: { memorySearch: { enabled: false } } } }),
  ).toMatchObject({ gap: "artifact_memory_disabled" });
  expect(await invoke(cfg, false)).toMatchObject({ gap: "finance_recall_host_scope_missing" });
  const abort = new AbortController();
  abort.abort();
  await expect(
    createFinanceTradeResultRecallCapability({ config: cfg, workspaceDir: root }).execute(
      { moduleId: request.moduleId, candidate, question: request.question },
      abort.signal,
    ),
  ).rejects.toThrow();
});
it.each(["accountId", "asOf", "owner", "id", "field", "path"])(
  "keeps host selectors out of the model request: %s",
  (key) => {
    expect(
      FinanceTradeReviewEvidenceRequestSchema.safeParse({ ...request, [key]: "forged" }).success,
    ).toBe(false);
  },
);
it("puts the actual recalled reason and source SHA into call2, which changes the scripted judgment", async () => {
  const source = await seed();
  const payloads: unknown[] = [];
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
      if (payloads.length === 1) {
        return {
          schemaVersion: packet.schemaVersion,
          evidenceRequests: [request],
          hypothesis: "Check the prior spread rejection before judgment",
        };
      }
      const consumed = JSON.stringify(call.payload).includes("spread_cost_exceeds_edge");
      return {
        schemaVersion: packet.schemaVersion,
        decisions: [
          {
            candidateId: candidate.candidateId,
            decision: consumed ? "veto" : "approve",
            rationale: consumed
              ? "Prior spread_cost_exceeds_edge requires current verification"
              : "No recalled constraint",
          },
        ],
      };
    }),
  };
  const financialCapabilities = createFinanceTradeReviewFinancialCapabilities({
    config: cfg,
    workspaceDir: root,
  });
  const result = await createFinanceTradeDecisionReviewer(
    {},
    {
      adapterFactory: () => model,
      evidenceScope: {
        directory: root,
        accountId: "paper-a",
        instruments: ["AAA"],
        financialCapabilities,
      },
    },
  )(packet, new AbortController().signal);
  expect(result).toMatchObject({
    status: "completed",
    modelCalls: 2,
    toolEvidence: [{ status: "completed" }],
    decisions: [{ decision: "veto" }],
  });
  expect(JSON.stringify(payloads[1])).toContain(source.sha256);
  expect(JSON.stringify(payloads[1])).toContain("spread_cost_exceeds_edge");
  expect(Buffer.byteLength(JSON.stringify(result.toolEvidence![0]))).toBeLessThanOrEqual(2048);
  const direct = await createFinanceTradeReviewEvidenceExecutor({
    directory: root,
    accountId: "paper-a",
    instruments: ["AAA"],
    financialCapabilities: [
      {
        toolName: "unavailable",
        moduleIds: ["finance_learning_memory"],
        description: "readonly",
        execute: async () => ({ available: false, gap: "not_ready" }),
      },
    ],
  })([{ ...request, toolName: "unavailable" }], packet, new AbortController().signal);
  expect(direct[0].status).toBe("unavailable");
});
