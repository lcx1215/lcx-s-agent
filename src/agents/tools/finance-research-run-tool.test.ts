import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runFinanceResearchRun } from "../finance-research-runner.js";
import { createFinanceResearchRunTool } from "./finance-research-run-tool.js";

const roots: string[] = [];
const input = { ask: "比较股票与国债的风险，列出缺失证据", asOf: "2026-09-11T00:00:00.000Z" };
const fixtureConfig = {
  agents: { defaults: { model: { primary: "provider/current" } } },
  models: {
    providers: {
      provider: {
        baseUrl: "https://provider.invalid",
        api: "openai-completions" as const,
        models: [
          {
            id: "current",
            name: "current",
            reasoning: false,
            input: ["text" as const],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
};
async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-research-tool-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("platform-independent finance workflow tool", () => {
  it("uses the canonical workflow in planning mode and saves a local receipt", async () => {
    const executeResearch = vi.fn<typeof runFinanceResearchRun>(async () =>
      runFinanceResearchRun({ input }),
    );
    const tool = createFinanceResearchRunTool({ workspaceDir: await workspace(), executeResearch });
    const result = await tool.execute("platform-a:message-1", input);
    expect(executeResearch.mock.calls[0]?.[0].liveFetch).toBe(false);
    const details = result.details as {
      status: string;
      receiptPath: string;
      externalChannelApplied: boolean;
    };
    expect(details.status).toBe("planned");
    expect(details.externalChannelApplied).toBe(false);
    expect(JSON.parse(await fs.readFile(details.receiptPath, "utf8")).status).toBe("planned");
  });

  it("forwards explicit live budgets and the host configuration without choosing a platform model", async () => {
    const executeResearch = vi.fn<typeof runFinanceResearchRun>(async () =>
      runFinanceResearchRun({ input }),
    );
    const tool = createFinanceResearchRunTool({
      workspaceDir: await workspace(),
      config: fixtureConfig,
      executeResearch,
    });
    await tool.execute("platform-b:message-2", {
      ...input,
      live: true,
      maxModelCalls: 7,
      maxApiCalls: 9,
    });
    const [request] = executeResearch.mock.calls[0];
    expect(request.liveFetch).toBe(true);
    expect(request.allowProviderCalls).toBe(true);
    expect(request.batchOptions?.maxApiCalls).toBe(9);
    expect(request.modelRouting?.adapters.some((adapter) => adapter.modelId === "current")).toBe(
      true,
    );
    expect(request.modelRouting).toBe(request.qualityModelRouting);
  });

  it("requires live evidence before dispatching module tools", async () => {
    const executeResearch = vi.fn<typeof runFinanceResearchRun>(async () =>
      runFinanceResearchRun({ input }),
    );
    const tool = createFinanceResearchRunTool({
      workspaceDir: await workspace(),
      executeResearch,
    });
    await expect(
      tool.execute("modules-without-live", { ...input, executeModules: true }),
    ).rejects.toThrow("executeModules requires live=true");
    expect(executeResearch).not.toHaveBeenCalled();
  });

  it("accepts validated explicit targets for caller-specific instruments", async () => {
    const executeResearch = vi.fn<typeof runFinanceResearchRun>(async () =>
      runFinanceResearchRun({ input }),
    );
    const tool = createFinanceResearchRunTool({
      workspaceDir: await workspace(),
      executeResearch,
    });
    const targets = [
      {
        id: "us-equity-aapl",
        instrument: "AAPL",
        assetClass: "us_equity",
        realtime: { requireOfficialReference: false },
        collections: [{ collection: "eod_history", freshnessMaxMinutes: 60 * 24 }],
      },
    ] as const;
    await tool.execute("explicit-target", { ...input, targets });
    expect(executeResearch.mock.calls[0]?.[0].input.targets).toEqual(targets);
  });

  it("forwards an explicit decision mode and rejects one outside the declared vocabulary", async () => {
    const executeResearch = vi.fn<typeof runFinanceResearchRun>(async () =>
      runFinanceResearchRun({ input }),
    );
    const tool = createFinanceResearchRunTool({
      workspaceDir: await workspace(),
      executeResearch,
    });
    await tool.execute("mode-candidate", { ...input, decisionMode: "strategy_candidate" });
    expect(executeResearch.mock.calls[0]?.[0].input.decisionMode).toBe("strategy_candidate");
    // Omitted stays omitted: the runner keeps `research_only` as its own default.
    await tool.execute("mode-default", input);
    expect(executeResearch.mock.calls[1]?.[0].input.decisionMode).toBeUndefined();
    // A genuinely unknown mode is rejected before dispatch.
    await expect(
      tool.execute("mode-invalid", { ...input, decisionMode: "unrestricted_execution" }),
    ).rejects.toThrow("decisionMode must be one of");
    expect(executeResearch).toHaveBeenCalledTimes(2);
  });

  it("accepts the declared live mode without granting execution authority", async () => {
    const executeResearch = vi.fn<typeof runFinanceResearchRun>(runFinanceResearchRun);
    const tool = createFinanceResearchRunTool({ workspaceDir: await workspace(), executeResearch });
    const result = await tool.execute("mode-live", { ...input, decisionMode: "live_execution" });
    expect(executeResearch).toHaveBeenCalledTimes(1);
    expect(executeResearch.mock.calls[0]?.[0]).toMatchObject({
      input: { decisionMode: "live_execution" },
      liveFetch: false,
      allowProviderCalls: false,
    });
    const details = result.details as { receiptPath: string; externalChannelApplied: boolean };
    const receipt = JSON.parse(await fs.readFile(details.receiptPath, "utf8"));
    expect(receipt.status).toBe("planned");
    expect(receipt.plan.decisionMode).toBe("live_execution");
    expect(receipt.plan.boundaries).toContain("no_execution_authority");
    expect(receipt.notTouched).toContain("trading_execution");
    expect(details.externalChannelApplied).toBe(false);
  });

  it("stops before execution when the platform cancels and rejects invalid budgets", async () => {
    const executeResearch = vi.fn<typeof runFinanceResearchRun>(async () =>
      runFinanceResearchRun({ input }),
    );
    const tool = createFinanceResearchRunTool({ workspaceDir: await workspace(), executeResearch });
    const controller = new AbortController();
    controller.abort(new Error("platform cancelled"));
    await expect(tool.execute("cancelled", input, controller.signal)).rejects.toThrow(
      "platform cancelled",
    );
    await expect(tool.execute("bad", { ...input, maxModelCalls: 0 })).rejects.toThrow(
      "maxModelCalls",
    );
    expect(executeResearch).not.toHaveBeenCalled();
  });

  it("propagates its total deadline to a running workflow", async () => {
    vi.useFakeTimers();
    const executeResearch = vi.fn<typeof runFinanceResearchRun>(
      async (context) =>
        new Promise((_resolve, reject) => {
          context?.signal?.addEventListener("abort", () => reject(context.signal?.reason), {
            once: true,
          });
        }),
    );
    const root = await workspace();
    const tool = createFinanceResearchRunTool({ workspaceDir: root, executeResearch });
    const execution = tool.execute("timeout", { ...input, timeoutMs: 1_000 });
    const rejection = expect(execution).rejects.toThrow("deadline exceeded");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    const files = await fs.readdir(path.join(root, "state", "finance-research-runs"));
    expect(files).toHaveLength(1);
    expect(
      JSON.parse(
        await fs.readFile(path.join(root, "state", "finance-research-runs", files[0]), "utf8"),
      ),
    ).toMatchObject({ status: "cancelled", reason: "total_deadline_exceeded" });
  });
});

it("returns a usable catalog and accepted plan so a caller can revise its composition", async () => {
  const root = await workspace();
  const executeResearch = vi.fn<typeof runFinanceResearchRun>(runFinanceResearchRun);
  const tool = createFinanceResearchRunTool({ workspaceDir: root, executeResearch });
  const initial = await tool.execute("module-discovery", input);
  const first = initial.details as {
    moduleCatalog: { id: string }[];
    orchestration: { selectionTrace: { selectionSource: string } };
    composition: { replanStatus: string; nextAction: string };
    moduleToolsDispatched: boolean;
  };
  expect(first.moduleCatalog.map((module) => module.id)).toContain("technical_timing");
  expect(first.orchestration.selectionTrace.selectionSource).toBe("rules");
  expect(first.composition).toMatchObject({
    replanStatus: "not_requested",
    nextAction: "none",
  });
  const selection = {
    moduleIds: ["technical_timing", "credit_liquidity"],
    rationale: "Examine a different mechanism after reviewing the initial plan.",
  };
  const revised = await tool.execute("module-revision", { ...input, moduleSelection: selection });
  const details = revised.details as {
    receiptPath: string;
    moduleToolsDispatched: boolean;
    orchestration: { primaryModules: string[]; selectionTrace: { selectionSource: string } };
  };
  expect(details.orchestration.primaryModules.slice(0, 2)).toEqual(selection.moduleIds);
  expect(details.orchestration.selectionTrace.selectionSource).toBe("caller_proposal");
  expect(details.moduleToolsDispatched).toBe(false);
  const saved = JSON.parse(await fs.readFile(details.receiptPath, "utf8"));
  expect(saved.plan.orchestration).toEqual(details.orchestration);
  expect(executeResearch.mock.calls[1][0]).toMatchObject({
    input: { moduleSelection: selection },
    liveFetch: false,
    allowProviderCalls: false,
  });
});

it("rejects an unknown module or gate override before workflow dispatch", async () => {
  const executeResearch = vi.fn<typeof runFinanceResearchRun>();
  const tool = createFinanceResearchRunTool({ workspaceDir: await workspace(), executeResearch });
  for (const moduleSelection of [
    { moduleIds: ["unregistered"], rationale: "invented tool" },
    { moduleIds: ["technical_timing"], rationale: "skip", noExecutionAuthority: false },
  ]) {
    await expect(tool.execute("invalid-proposal", { ...input, moduleSelection })).rejects.toThrow(
      "moduleSelection",
    );
  }
  expect(executeResearch).not.toHaveBeenCalled();
});

it("returns real source-failure feedback and targets for another decision without bypassing the gate", async () => {
  const executeResearch: typeof runFinanceResearchRun = async (request) =>
    runFinanceResearchRun({
      ...request,
      batchOptions: { ...request.batchOptions, realtimeAdapters: [], collectionAdapters: [] },
    });
  const tool = createFinanceResearchRunTool({
    workspaceDir: await workspace(),
    config: fixtureConfig,
    executeResearch,
  });
  const targets = [{ id: "spy", instrument: "SPY", assetClass: "us_equity" }];
  const result = await tool.execute("source-feedback", {
    ...input,
    live: true,
    targets,
    moduleSelection: {
      moduleIds: ["credit_liquidity"],
      rationale: "Check a different mechanism but preserve source requirements.",
    },
  });
  const details = result.details as {
    status: string;
    answerDecision: string;
    plannedTargets: unknown;
    gates: { id: string; passed: boolean }[];
    sourceRecovery: { entries: unknown[]; executionAuthority: string };
    moduleToolsDispatched: boolean;
  };
  expect(details.status).toBe("blocked");
  expect(details.answerDecision).toBe("return_failed_reason");
  expect(details.plannedTargets).toEqual(targets);
  expect(details.gates.find((gate) => gate.id === "source")?.passed).toBe(false);
  expect(details.sourceRecovery.entries.length).toBeGreaterThan(0);
  expect(details.sourceRecovery.executionAuthority).toBe("none");
  expect(details.moduleToolsDispatched).toBe(false);
});
