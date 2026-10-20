import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeOriginalFinanceModuleMain } from "./fixtures/lcx-waterflow-finance-module-main-probe.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});

async function probe(
  name: string,
  options: Omit<Parameters<typeof probeOriginalFinanceModuleMain>[0], "directory"> = {},
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-native-module-"));
  directories.push(directory);
  const network = vi.fn(() => {
    throw new Error("network forbidden in private native sample");
  });
  vi.stubGlobal("fetch", network);
  const result = await probeOriginalFinanceModuleMain({ directory, ...options });
  const retained = process.env.LCX_FINANCE_MODULE_MAIN_PROOF_DIR;
  if (retained) {
    await fs.mkdir(retained, { recursive: true });
    await fs.cp(directory, path.join(retained, name), { recursive: true });
    await fs.writeFile(
      path.join(retained, name, "network-count.json"),
      JSON.stringify({ fetchCalls: network.mock.calls.length, configuredProvidersAllowed: false }) +
        "\n",
    );
  }
  expect(network).not.toHaveBeenCalled();
  return result;
}

describe("original finance rule to module to reviewed plan handoff", () => {
  it("runs original private producers, inspect and quant before quality consumes their actual output", async () => {
    const result = await probe("normal");
    expect(result.executeInput).toEqual(
      JSON.parse(
        await fs.readFile(
          path.join(path.dirname(result.receiptPath), "frozen-original-input.json"),
          "utf8",
        ),
      ),
    );
    const receipt = result.receipt!;
    expect(receipt.status, JSON.stringify(receipt.missingEvidence)).toBe("candidate");
    expect(receipt.gates.every((gate) => gate.passed)).toBe(true);
    const nodes = receipt.moduleExecution!.nodes;
    const quant = nodes.find((node) => node.moduleId === "quant_math")!;
    expect(quant.status).toBe("succeeded");
    expect(quant.toolCalls[0].toolName).toBe("quant_math");
    expect(JSON.parse(quant.toolCalls[0].outputSummary!)).toMatchObject({
      action: "max_drawdown",
      observations: 3,
      maxDrawdown: -0.05,
    });
    for (const domain of ["causal_map", "portfolio_risk_gates"]) {
      const node = nodes.find((item) => item.moduleId === domain)!;
      expect(node.status).toBe("succeeded");
      expect(node.toolCalls.map((call) => call.toolName)).toEqual([
        `finance_framework_${domain}_producer`,
        "finance_framework_core_inspect",
      ]);
      expect(result.frameworkContract).toContain(domain);
      const evidence = receipt.batch!.committeeEvidence.find(
        (item) => item.id === node.outputEvidenceIds[0],
      )!;
      expect(
        result.qualityRequests.some((request) =>
          request.evidence.some((item) => item.id === evidence.id && item.text === evidence.text),
        ),
      ).toBe(true);
    }
    expect(receipt.moduleExecution!.requiredNodesSucceeded).toBe(true);
    expect(receipt.moduleExecution!.allNodesSucceeded).toBe(false);
    expect(receipt.missingEvidence).not.toContain(
      "module:finance_learning_memory:retrievable_finance_capability_card",
    );
    expect(
      nodes.find((node) => node.moduleId === "finance_learning_memory")?.missingEvidence,
    ).toContain("retrievable_finance_capability_card");
    const quantEvidence = receipt.batch!.committeeEvidence.find(
      (item) => item.id === quant.outputEvidenceIds[0],
    )!;
    expect(
      result.qualityRequests.some((request) =>
        request.evidence.some(
          (item) => item.id === quantEvidence.id && item.text === quantEvidence.text,
        ),
      ),
    ).toBe(true);
    expect(result.planReadback).toEqual(receipt.portfolioPlan);
    expect(result.planReadback!.allocations).toMatchObject([
      { strategyId: "private-trend", budgetFraction: 0.4 },
    ]);
    expect(result.planReadback!.provenance!.receiptId).toBe(`quality:${receipt.quality!.runId}`);
    expect(result.summary).toMatchObject({
      status: "candidate",
      plan: { asOf: result.executeInput!.asOf },
      portfolioPlanWritten: result.planPath,
    });
    expect(result.readback).toEqual(receipt);
    expect(result.checkpoint.status).toBe("completed");
  });

  it("retains a changed rule budget in actual next input and native compiled allocation", async () => {
    const result = await probe("changed_rule", { allocation: 0.2 });
    expect(result.receipt!.status).toBe("candidate");
    expect(result.planReadback!.allocations[0].budgetFraction).toBe(0.2);
    const rule = result.scope.evidence.find(
      (item) => item.id === "finance-controller:active-strategies",
    )!;
    expect(
      result.committeeRequests.some((request) =>
        request.evidence.some((item) => item.id === rule.id && item.text === rule.text),
      ),
    ).toBe(true);
  });

  it("keeps missing required producer input blocked without a written allocation", async () => {
    const result = await probe("missing_producer", { fault: "missing_producer" });
    expect(result.receipt!.status).toBe("needs_review");
    expect(result.receipt!.moduleExecution!.requiredNodesSucceeded).toBe(false);
    expect(result.receipt!.missingEvidence.join(" ")).toContain("module_producer_input");
    expect(result.qualityRequests).toEqual([]);
    expect(result.summary.portfolioPlanWritten).toBeUndefined();
    expect(result.planReadback).toBeUndefined();
    expect(result.frameworkContract).toBeNull();
  });

  it("accepts valid source latency within the total budget instead of the deliberate fault deadline", async () => {
    const result = await probe("healthy-source-latency", { sourceDelayMs: 40 });
    expect(
      result.receipt?.status,
      JSON.stringify({
        gates: result.receipt?.gates,
        missingEvidence: result.receipt?.missingEvidence,
        checkpoint: result.checkpoint,
      }),
    ).toBe("candidate");
    expect(result.receipt?.gates.every((gate) => gate.passed)).toBe(true);
    expect(result.sourceCalls.every((call) => !call.aborted)).toBe(true);
    expect(result.planReadback).toBeDefined();
  });

  it.each(["missing_source", "source_timeout"] as const)(
    "rejects %s before downstream model/module adoption",
    async (fault) => {
      const result = await probe(fault, { fault });
      expect(result.receipt!.status).toBe("blocked");
      expect(result.committeeRequests).toEqual([]);
      expect(result.qualityRequests).toEqual([]);
      expect(result.planReadback).toBeUndefined();
      expect(result.frameworkContract).toBeNull();
      if (fault === "source_timeout") {
        expect(result.sourceCalls.length).toBeGreaterThan(0);
        expect(result.sourceCalls.every((call) => call.aborted)).toBe(true);
      }
    },
  );

  it("keeps actual successful modules distinct from a rejected quality decision", async () => {
    const result = await probe("quality_failure", { fault: "quality_failure" });
    expect(result.receipt!.status).toBe("needs_review");
    expect(result.receipt!.moduleExecution!.requiredNodesSucceeded).toBe(true);
    expect(result.receipt!.gates.find((gate) => gate.id === "quality")!.passed).toBe(false);
    expect(result.planReadback).toBeUndefined();
  });

  it("writes the original deadline failure and no actionable plan", async () => {
    const result = await probe("run_timeout", { fault: "run_timeout" });
    expect(result.receipt).toBeUndefined();
    expect(result.checkpoint).toMatchObject({
      status: "aborted",
      reason: "research_run_deadline_exceeded",
    });
    expect(result.summary).toMatchObject({ status: "failed", gates: [] });
    expect(result.planReadback).toBeUndefined();
    expect(result.frameworkContract).toBeNull();
  });
});
