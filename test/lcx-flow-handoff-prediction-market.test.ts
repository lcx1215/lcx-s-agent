import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPredictionMarketResearchIntake } from "../scripts/operator/lcx-external-agent-upgrade-radar.js";
import {
  auditWorkflowHandoffs,
  type WorkflowHandoffEvidence,
} from "../scripts/operator/lcx-flow-graph.js";
import { parseYahooChart } from "../src/agents/finance-live-market-source.js";
import { createFinanceReplyEvidenceTracker } from "../src/agents/finance-reply-evidence.js";
import { readFileWithinRoot } from "../src/infra/fs-safe.js";
import {
  preparePredictionResolutionProbe,
  probePredictionMarket,
  savePredictionResolutionProof,
} from "./fixtures/lcx-waterflow-prediction-market-probe.js";

const guards = vi.hoisted(() => ({ network: 0, spawn: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const blocked = () => {
    guards.spawn++;
    throw new Error("prediction_probe_process_spawn_forbidden");
  };
  return {
    ...original,
    exec: blocked,
    execFile: blocked,
    spawn: blocked,
    fork: blocked,
    execSync: blocked,
    execFileSync: blocked,
    spawnSync: blocked,
  };
});

describe("explicit original Radar prediction body to resolution consumer", () => {
  it("actually re-reads the source and blocks missing resolution clauses without requiring a model, fee or backtest", async () => {
    const sample = await preparePredictionResolutionProbe(await workspace(), {
      missingCriteria: true,
    });
    const result = await sample.run();
    expect(result.status).toBe("blocked");
    expect(result.stages.map((stage) => stage.nodeId)).toEqual([
      "prediction_market_source",
      "source_registry",
      "actual_reading_scope",
      "resolution_criteria_review",
    ]);
    expect(sample.fileCalls).toEqual([sample.source.path, sample.source.path]);
    expect(sample.modelInputs).toEqual([]);
    expect(result.stages[1].input).toEqual(result.stages[0].output);
    expect(result.stages[2].input).toEqual(result.stages[1].output);
    expect(result.stages[3].input).toEqual(result.stages[2].output);
    expect(result.stages[3].input?.text).toBe(sample.text);
    expect(result.gaps).toContain("prediction_resolution_missing:/resolutionCriteria");
    expect(result.gaps.join(" ")).not.toMatch(/model_unavailable|fee|sample_out|backtest/u);
    expect(result.sourceSummaryAllowed).toBe(true);
    expect(result.directionalConclusionAllowed).toBe(false);
    expect(result.downstreamStarted).toBe(false);
    await savePredictionResolutionProof("missing-criteria", sample, result);
  });
  it("keeps complete fields as readable yet unresolved; default builds no model adapter", async () => {
    const sample = await preparePredictionResolutionProbe(await workspace());
    const result = await sample.run();
    expect(result.status).toBe("needs_review");
    expect(result.gaps).toContain("prediction_resolution_semantics_not_verified");
    expect(result.stages[3].output).toMatchObject({
      semantics: "not_verified",
      qualityGap: "prediction_resolution_review_not_requested",
    });
    expect(result.directionalConclusionAllowed).toBe(false);
    expect(sample.modelInputs).toHaveLength(0);
    await savePredictionResolutionProof("complete-unreviewed", sample, result);
  });
  it("delivers original conflicting clauses and full source fingerprint to actual Quality, whose finding blocks direction", async () => {
    const sample = await preparePredictionResolutionProbe(await workspace(), {
      conflictingCriteria: true,
    });
    const result = await sample.run({
      qualityOptions: { modelInvoker: sample.modelInvoker, taskTimeoutMs: 250 },
    });
    expect(sample.modelInputs.length).toBeGreaterThan(0);
    const request = sample.modelInputs[0];
    // The existing Quality request normalizer trims boundary whitespace; the source SHA binds original bytes.
    expect(request.evidence[0].text).toBe(sample.text.trim());
    expect(request.task).toContain(sample.source.sha256);
    expect(request.sharedContext.scope).toEqual(sample.scope);
    expect(result.status).toBe("blocked");
    expect(JSON.stringify(result.stages[3].output?.findings)).toContain(
      "opposite_resolution_for_same_observation",
    );
    expect(result.directionalConclusionAllowed).toBe(false);
    expect(sample.fileCalls).toHaveLength(3);
    await savePredictionResolutionProof("quality-conflict", sample, result);
  });
  it.each(["missing_source", "hash_conflict", "scope_conflict", "source_changed"] as const)(
    "rejects actual %s before domain adoption",
    async (fault) => {
      const sample = await preparePredictionResolutionProbe(
        await workspace(),
        fault === "scope_conflict"
          ? { sourceScope: { accountId: "other-account", runId: "other-run" } }
          : {},
      );
      if (fault === "missing_source") {
        await fs.unlink(path.join(sample.workspaceDir, sample.source.path));
      }
      if (fault === "hash_conflict") {
        await fs.appendFile(path.join(sample.workspaceDir, sample.source.path), " ");
      }
      let reads = 0;
      const result = await sample.run({
        readFile: async (input) => {
          if (fault === "source_changed" && ++reads === 2) {
            await fs.appendFile(path.join(sample.workspaceDir, sample.source.path), " ");
          }
          return sample.readFile(input);
        },
      });
      expect(result.status).toBe("failed");
      expect(result.sourceSummaryAllowed).toBe(false);
      expect(result.directionalConclusionAllowed).toBe(false);
      expect(result.stages.some((stage) => stage.nodeId === "resolution_criteria_review")).toBe(
        false,
      );
      expect(sample.modelInputs).toEqual([]);
      if (fault === "scope_conflict") {
        expect(result.gaps).toContain("prediction_source_host_scope_conflict");
      }
      await savePredictionResolutionProof(fault, sample, result);
    },
  );
  it("seals deadline after an entered real safe read and ignores its late body without creating registry/resolution", async () => {
    const sample = await preparePredictionResolutionProbe(await workspace());
    let release: (() => void) | undefined;
    let entered = false;
    const result = await sample.run({
      timeoutMs: 1000,
      readFile: async (input) => {
        const actual = await sample.readFile(input);
        entered = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return actual;
      },
    });
    expect(entered).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.stages[0].status).toBe("timed_out");
    expect(result.stages).toHaveLength(1);
    expect(result.cleanup).toContain("cleanup_unconfirmed");
    const sealed = JSON.stringify(result);
    release?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(JSON.stringify(result)).toBe(sealed);
    expect(sample.fileCalls).toHaveLength(1);
    await savePredictionResolutionProof("late-source", sample, result);
  });
  it("seals cancellation after actual Quality entry, and its late output never restores domain approval", async () => {
    const sample = await preparePredictionResolutionProbe(await workspace());
    sample.holdModel();
    const controller = new AbortController();
    const pending = sample.run({
      signal: controller.signal,
      timeoutMs: 1000,
      qualityOptions: { modelInvoker: sample.modelInvoker, taskTimeoutMs: 500 },
    });
    await vi.waitFor(() => expect(sample.modelInputs.length).toBeGreaterThan(0), { timeout: 500 });
    controller.abort();
    const result = await pending;
    expect(result.gaps).toContain("prediction_intake_cancelled");
    expect(sample.abortObserved()).toBe(true);
    expect(result.cleanup).toContain("model_cleanup_unconfirmed");
    const sealed = JSON.stringify(result);
    sample.releaseModel();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(JSON.stringify(result)).toBe(sealed);
    expect(result.directionalConclusionAllowed).toBe(false);
    await savePredictionResolutionProof("late-quality", sample, result);
  });
  it("rejects cross-root source and previously cancelled attempts without model or later stages", async () => {
    const sample = await preparePredictionResolutionProbe(await workspace());
    const controller = new AbortController();
    controller.abort();
    const cancelled = await sample.run({ signal: controller.signal });
    expect(cancelled.gaps).toContain("prediction_intake_cancelled");
    expect(sample.fileCalls).toEqual([]);
    const result = await readPredictionMarketResearchIntake({
      workspaceDir: sample.workspaceDir,
      scope: sample.scope,
      source: { ...sample.source, path: "../outside.json" },
      readFile: readFileWithinRoot,
    });
    expect(result.status).toBe("failed");
    expect(result.stages).toHaveLength(1);
  });
  it("keeps an oversized actual source readable but reports the Quality input gap without clipping or model calls", async () => {
    const sample = await preparePredictionResolutionProbe(await workspace());
    const text = JSON.stringify({ ...sample.packet, extraResolutionNotes: "x".repeat(16_000) });
    await fs.writeFile(path.join(sample.workspaceDir, sample.source.path), text);
    sample.source.sha256 = createHash("sha256").update(text).digest("hex");
    const result = await sample.run({ qualityOptions: { modelInvoker: sample.modelInvoker } });
    expect(result.status).toBe("needs_review");
    expect(result.gaps).toContain("prediction_resolution_quality_input_budget_exceeded");
    expect(result.stages[3].input?.text).toBe(text);
    expect(sample.modelInputs).toEqual([]);
    expect(result.directionalConclusionAllowed).toBe(false);
    await savePredictionResolutionProof("quality-budget-gap", sample, result);
  });
});
const directories: string[] = [];
beforeEach(() => {
  guards.network = 0;
  guards.spawn = 0;
  vi.stubGlobal("fetch", async () => {
    guards.network++;
    throw new Error("prediction_probe_network_forbidden");
  });
});
afterEach(async () => {
  expect(guards).toEqual({ network: 0, spawn: 0 });
  vi.unstubAllGlobals();
  await Promise.all(
    directories.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prediction-market-native-"));
  directories.push(root);
  return root;
}
const before = process.env.LCX_PREDICTION_BEFORE === "1";
const proofBase = process.env.LCX_PREDICTION_PROOF_DIR;
describe("prediction-shaped original tool source availability and real receipt consumption", () => {
  it("reproduces unsupported Yahoo dispatch before repair and blocks it before HTTP after repair", async () => {
    const sample = await probePredictionMarket(
      await workspace(),
      proofBase ? path.join(proofBase, before ? "before" : "after") : undefined,
    );
    expect(sample.yahooEligible).toBe(before);
    expect(sample.httpRequests.length > 0).toBe(before);
    if (before) {
      expect(
        sample.httpRequests.every((url) =>
          url.toLowerCase().includes("finance.yahoo.com/v8/finance/chart/offline-polymarket"),
        ),
      ).toBe(true);
      expect(JSON.stringify(sample.receipt.batch)).toContain('"error":"source_error"');
      expect(() =>
        parseYahooChart(
          sample.sourceBody,
          sample.input.targets[0].instrument,
          sample.httpRequests[0],
        ),
      ).toThrow("yahoo reported an error");
    }
    expect(sample.runnerInput).toEqual(sample.input);
    expect(sample.receipt.status).toBe("blocked");
    expect(sample.receipt.answerDecision).toBe("return_failed_reason");
    expect(sample.receipt.quarterlyOutput.adopted).toBe(false);
    expect(
      sample.receipt.gates
        .filter((gate) => gate.id === "source" || gate.id === "quality")
        .every((gate) => !gate.passed),
    ).toBe(true);
    expect(sample.modelCalls).toBe(0);
    expect(sample.receiptContentHashMatches).toBe(true);
    expect(sample.consumer.status).toBe("blocked");
    expect(sample.consumer.reasons.some((reason) => reason.startsWith("source_gate_failed:"))).toBe(
      true,
    );
    expect(
      sample.observedEvents.some(
        (event) => event.stream === "tool" && event.data.phase === "result",
      ),
    ).toBe(true);
    expect(sample.route.task_family).toBe("prediction_market_research_strategy_distillation");
    expect(sample.route.missing_data).toContain("resolution_ambiguity_review");
    expect(sample.route.risk_boundaries).toContain("no_order_placement");
    const proof = proofBase ?? (await workspace());
    await fs.mkdir(proof, { recursive: true });
    const native = path.join(
      proof,
      before ? "before/actual-native.json" : "after/actual-native.json",
    );
    if (!proofBase) {
      await fs.mkdir(path.dirname(native), { recursive: true });
      await fs.writeFile(native, JSON.stringify(sample.result));
    }
    const sha256 = createHash("sha256")
      .update(await fs.readFile(native))
      .digest("hex");
    // No gateway snapshot or prediction resolution consumer was produced. These real field refs
    // explain the earliest gap; they cannot relabel a failed generic source as a prediction worker.
    const evidence: WorkflowHandoffEvidence = {
      scenarioId: "prediction_market_research_only_waterflow",
      environment: "offline_fixture",
      nodes: [],
    };
    const audit = (await auditWorkflowHandoffs([evidence])).find(
      (row) => row.scenarioId === evidence.scenarioId,
    );
    expect(audit?.status).toBe("handoff_gap");
    expect(audit?.gaps.some((gap) => gap.node === "resolution_criteria_review")).toBe(true);
    if (proofBase) {
      await fs.writeFile(
        path.join(
          proofBase,
          before ? "before/original-fieldrefs-audit.json" : "after/original-fieldrefs-audit.json",
        ),
        JSON.stringify(
          {
            evidence,
            audit,
            diagnosticOnlyRefs: [
              "/input/targets/0",
              "/receipt/plan/sourceInspections",
              "/receipt/batch/jobs/0",
              "/receipt/gates",
              "/consumer/reasons",
              "/route/missing_data",
            ].map((pointer) => ({ path: native, sha256, pointer })),
            guards: { ...guards, model: sample.modelCalls },
            unsupportedCaller: "Yahoo non-crypto eligibility is not prediction-market support",
            gatewaySnapshotProduced: false,
            missingImplementationOwners: [
              "prediction source caller",
              "resolution criteria reviewer",
              "market microstructure reviewer",
              "paper strategy/sample-out reviewer",
              "review/control-room feedback",
            ],
          },
          null,
          2,
        ) + "\n",
      );
    }
  });
  it("retains original hash conflicts and cross-run/session failures without creating synthetic successful intermediates", async () => {
    const root = await workspace();
    const sample = await probePredictionMarket(root);
    const readback = (sessionKey: string, runId: string) => {
      const tracker = createFinanceReplyEvidenceTracker({ workspaceDir: root, sessionKey });
      tracker.start(runId);
      for (const event of sample.observedEvents) {
        tracker.observe(event);
      }
      return tracker;
    };
    const scopeFaults = [];
    for (const [session, run] of [
      [sample.sessionKey, "different-run"],
      ["different-session", sample.runId],
    ]) {
      const decision = await readback(session, run).check(sample.candidate, sample.input.ask);
      expect(decision.reasons).toContain("finance_tool_result_not_observed_in_current_scope");
      scopeFaults.push({ session, run, decision });
    }
    const wrongReference = sample.candidate.replace(sample.details.receiptSha256, "0".repeat(64));
    const referenceHashFault = await readback(sample.sessionKey, sample.runId).check(
      wrongReference,
      sample.input.ask,
    );
    expect(referenceHashFault.reasons).toContain("finance_receipt_reference_hash_conflict");
    await fs.appendFile(sample.details.receiptPath, " ");
    const contentHashFault = await readback(sample.sessionKey, sample.runId).check(
      sample.candidate,
      sample.input.ask,
    );
    expect(contentHashFault.reasons).toContain("finance_receipt_source_hash_conflict");
    expect(sample.modelCalls).toBe(0);
    if (proofBase) {
      await fs.writeFile(
        path.join(
          proofBase,
          before ? "before/actual-consumer-faults.json" : "after/actual-consumer-faults.json",
        ),
        JSON.stringify(
          {
            scopeFaults,
            referenceHashFault,
            contentHashFault,
            guards: { ...guards, model: sample.modelCalls },
            originalReceiptSHA256: sample.details.receiptSha256,
            mutatedContentSHA256: createHash("sha256")
              .update(await fs.readFile(sample.details.receiptPath))
              .digest("hex"),
            boundary: "Separate actual tool invocation; not joined into the primary workflow audit",
          },
          null,
          2,
        ) + "\n",
      );
    }
  });
});

describe("original prediction cost consumer", () => {
  it.each([
    "usable",
    "capacity",
    "fees_missing",
    "cost_erased",
    "stale",
    "crossed",
    "overflow",
  ] as const)(
    "consumes actual quote fields and carries %s into the original review and summary",
    async (fault) => {
      const sample = await preparePredictionResolutionProbe(await workspace());
      const quote: Record<string, unknown> = {
        unit: "USD_per_contract_payoff_1",
        observedAt: new Date().toISOString(),
        maxAgeMs: 60_000,
        bid: 0.4,
        ask: 0.45,
        availableQuantity: 100,
        requestedQuantity: 10,
        feePerContract: 0.02,
        slippagePerContract: 0.01,
      };
      if (fault === "capacity") {
        quote.availableQuantity = 2;
      }
      if (fault === "fees_missing") {
        delete quote.feePerContract;
      }
      if (fault === "cost_erased") {
        quote.feePerContract = 0.6;
      }
      if (fault === "stale") {
        quote.observedAt = new Date(Date.now() - 120_000).toISOString();
      }
      if (fault === "crossed") {
        quote.bid = 0.8;
      }
      if (fault === "overflow") {
        quote.feePerContract = 1e308;
        quote.slippagePerContract = 1e308;
      }
      const text = JSON.stringify({ ...sample.packet, marketMicrostructure: quote });
      await fs.writeFile(path.join(sample.workspaceDir, sample.source.path), text);
      sample.source.sha256 = createHash("sha256").update(text).digest("hex");
      const receipt = await sample.run({
        qualityOptions: { modelInvoker: sample.modelInvoker, taskTimeoutMs: 250 },
      });
      const review = receipt.marketCostReview!;
      expect(review.status).toBe(fault === "usable" ? "needs_review" : "blocked");
      if (fault === "usable") {
        expect(review.measurements?.cashPerContract).toBeCloseTo(0.48);
        expect(review.measurements?.declaredOrderCash).toBeCloseTo(4.8);
        expect(review.measurements?.breakEvenWinProbability).toBeCloseTo(0.48);
      } else {
        expect(review.gaps.length).toBeGreaterThan(0);
        expect(receipt.status).toBe("blocked");
      }
      expect(sample.modelInputs[0].sharedContext.marketCostReview).toEqual(review);
      expect(
        receipt.stages.find((stage) => stage.nodeId === "market_microstructure_review")?.input,
      ).toMatchObject({ field: "/marketMicrostructure", source: sample.source });
      expect(receipt.stages.at(-1)).toMatchObject({
        nodeId: "control_room_summary",
        output: {
          marketCostReview: review,
          source: sample.source,
          directionalConclusionAllowed: false,
        },
      });
      expect(receipt.sourceSummaryAllowed).toBe(true);
      expect(receipt.runtimeAuthority).toBe("not_granted");
      expect(receipt.directionalConclusionAllowed).toBe(false);
    },
  );
});
