import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  probeOriginalFinanceLiveCaller,
  type LiveCallerFault,
} from "./fixtures/lcx-waterflow-finance-live-caller-probe.js";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function probe(
  name: string,
  options: { allocation?: number; fault?: LiveCallerFault; includeNight?: boolean } = {},
) {
  const persistent = name.startsWith("broker_unknown")
    ? process.env.LCX_FINANCE_FULL_BOOK_PROOF_DIR
    : undefined;
  if (persistent) {
    await fs.mkdir(persistent, { recursive: true });
  }
  const directory = await fs.mkdtemp(path.join(persistent ?? os.tmpdir(), "lcx-live-caller-"));
  if (!persistent) {
    roots.push(directory);
  }
  const result = await probeOriginalFinanceLiveCaller({ directory, ...options });
  const retained = process.env.LCX_FINANCE_LIVE_CALLER_PROOF_DIR;
  if (retained) {
    await fs.mkdir(retained, { recursive: true });
    await fs.cp(directory, path.join(retained, name), { recursive: true });
  }
  expect(result.forbiddenNetwork).toBe(0);
  return result;
}
describe("same-attempt original live research CLI -> scheduler -> original day consumer", () => {
  it.each([0.4, 0.2])(
    "uses this rule budget %s in new research and the later day result",
    async (allocation) => {
      const result = await probe(`budget-${allocation}`, { allocation });
      expect(
        result.cliOutput?.receipt.status,
        JSON.stringify({
          gates: result.cliOutput?.receipt.gates,
          gaps: result.cliOutput?.receipt.missingEvidence,
        }),
      ).toBe("candidate");
      expect(result.actualRunnerInputs).toHaveLength(1);
      const fresh = JSON.parse(result.preflightBytes!.evidence);
      expect(result.actualRunnerInputs[0].controllerEvidence).toEqual(
        expect.arrayContaining(fresh),
      );
      expect(
        result.modelRequests.some((request) =>
          request.evidence.some((item) => item.id === fresh[0].id && item.text === fresh[0].text),
        ),
      ).toBe(true);
      expect(result.cliOutput?.receipt.portfolioPlan?.allocations[0].budgetFraction).toBe(
        allocation,
      );
      expect(result.result.nativeScheduler.accepted).toBe(true);
      const promptText = result.modelHttpCalls.find((call) => call.stage === "draft")!.promptText!;
      const actualPromptEvidence = [
        ...promptText
          .split("\n")
          .find((line) => line.startsWith("evidence="))!
          .slice(9)
          .matchAll(/\[([^\]]+)\] ([\s\S]*?)(?= \| \[|$)/gu),
      ].map((match) => ({ id: match[1], text: match[2].replace(/ \([^()]*\)$/u, "") }));
      const promptBroker = actualPromptEvidence.find(
        (item: { id: string }) => item.id === fresh[0].id,
      );
      if (!promptBroker) {
        throw new Error("actual model HTTP prompt is missing this preflight broker evidence");
      }
      expect(JSON.parse(promptBroker.text).accountScope.accountId).toBe(
        result.actualRunnerInputs[0].portfolioContext!.accountId,
      );
      const promptRule = actualPromptEvidence.find(
        (item: { id: string }) => item.id === "finance-controller:active-strategies",
      );
      if (!promptRule) {
        throw new Error("actual model HTTP prompt is missing the active rule body");
      }
      expect(
        JSON.parse(promptRule.text).activeRules[0].body.frozenRule.researchBudgetFraction,
      ).toBe(allocation);
      expect(result.cliOutput!.receipt.plan.asOf).toBe(
        result.result.nativeScheduler.record.firedAt,
      );
      expect(result.cliOutput!.receipt.portfolioPlan!.accountId).toBe(
        result.actualRunnerInputs[0].portfolioContext!.accountId,
      );
      expect(result.result.dayReport?.targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ instrument: "SPY", weight: allocation }),
        ]),
      );
      expect(result.result.dayReport?.placed).toEqual([]);
    },
  );
  it.each([
    "missing_evidence",
    "cross_account",
    "missing_source",
    "quality_failure",
    "run_timeout",
  ] as const)("retains original %s failure without day dispatch", async (fault) => {
    const result = await probe(fault, { fault });
    expect(result.result.nativeScheduler.accepted).toBe(false);
    expect(result.result.nativeScheduler.children.map((child) => child.kind)).toEqual(["research"]);
    expect(result.cliOutput?.portfolioPlanWritten).toBeUndefined();
    expect(result.result.dayReport).toBeUndefined();
    expect(result.result.nativeScheduler.children[0].closeCode).not.toBe(0);
    if (fault === "run_timeout") {
      expect(result.lateResult).toEqual({
        attempted: true,
        cancelled: true,
        enqueueRejected: true,
      });
      expect(result.result.nativeScheduler.nativeProducer.checkpoint).toMatchObject({
        status: "aborted",
        reason: "research_run_deadline_exceeded",
        failureClass: "deadline",
      });
      expect(result.adapterStates.some((entry) => entry.state?.cleanupStatus === "confirmed")).toBe(
        true,
      );
    }
  });
  it("rejects a venue-conflicting unconfirmed broker before account transport after this new research receipt", async () => {
    const result = await probe("broker_unknown", { fault: "broker_unknown" });
    expect(result.cliOutput?.receipt.status).toBe("candidate");
    const realtime = result.cliOutput?.receipt.batch?.jobs.find((job) => job.kind === "realtime");
    expect(
      result.actualRunnerInputs[0].targets?.find((target) => target.instrument === "SPY")?.realtime,
    ).not.toBe(false);
    expect(realtime?.status).toBe("ready");
    if (!realtime?.receipt || !("snapshot" in realtime.receipt) || !realtime.receipt.snapshot) {
      throw new Error("native same-book gateway snapshot missing");
    }
    expect(realtime.receipt.snapshot.instrument).toBe("SPY");
    expect(result.cliOutput?.receipt.portfolioPlan?.allocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ strategyId: "private-trend", budgetFraction: 0.4 }),
        expect.objectContaining({ strategyId: "private-intraday", budgetFraction: 0 }),
      ]),
    );
    const qualityInputs = result.modelRequests.filter(
      (request) => typeof request.sharedContext.strategyMethodKit === "object",
    );
    expect(
      qualityInputs.some((request) =>
        request.evidence.some(
          (entry) =>
            entry.id === "finance-model:SPY" &&
            entry.text.includes("fixture://primary_market_data/SPY"),
        ),
      ),
    ).toBe(true);
    expect(result.result.nativeScheduler.accepted).toBe(false);
    expect(result.result.dayReport).toMatchObject({
      ok: false,
      failureKind: "portfolio_plan_binding_gate",
    });
    expect(String(result.result.dayReport?.error)).toContain(
      "portfolio plan producer scope does not match caller",
    );
    expect(result.result.priceCalls.some((call) => call.phase === "operator")).toBe(false);
  });
  it("retains original sampler refusal and night decline without inventing calibration in the same book", async () => {
    const result = await probe("broker_unknown-night", {
      fault: "broker_unknown",
      includeNight: true,
    });
    const evidence = result.sameBookNight;
    if (!evidence) {
      throw new Error("same-book original night evidence missing");
    }
    if (evidence.centralFeedback.status !== "present") {
      throw new Error("original Central finance feedback unavailable");
    }
    expect(result.cliOutput?.receipt.status).toBe("candidate");
    expect(result.result.dayReport).toMatchObject({
      ok: false,
      failureKind: "portfolio_plan_binding_gate",
    });
    expect(evidence.sampler.recorded).toHaveLength(1);
    expect(evidence.night.directory).toBe(result.result.nativeScheduler.nativeBook);
    expect(evidence.night.sampleSourceSha256).toBe(evidence.sample.sha256);
    expect(evidence.sampler.recorded[0]).toMatchObject({ direction: "none", conviction: 0 });
    expect(evidence.sampler.recorded[0].refusals).toContain(
      "refuse: 1 distinct source(s) support buy, 2 required",
    );
    expect(evidence.night.actualNightOutput).toMatchObject({
      scored: [],
      scoredFiled: { appended: 0 },
      declined: [
        { instrument: "SPY", reason: 'direction="none" is not a bet; excluded from hit rate' },
      ],
    });
    expect(evidence.night.tuningCalls).toEqual([]);
    expect(evidence.night.scoredSourceSnapshot).toBeUndefined();
    expect(evidence.centralFeedback.tuning.sourceRead.status).toBe("absent");
    expect(evidence.centralFeedback.tuning.sourceRead.sha256).toBeUndefined();
    expect(evidence.centralFeedback.tuning.proposalCount).toBe(0);
    expect(evidence.centralFeedback.tuning.promotionCount).toBe(0);
  });
});
