import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfiguredFinanceModelAdapter } from "../configured-finance-model-adapter.js";
import type { LogicalAgentModelAdapter } from "../logical-agent-model-router.js";
import { runCentralHarnessCycle } from "./harness-loop.js";
import {
  buildCentralBrainPrompt,
  buildCentralToolCatalog,
  CENTRAL_TOOL_CATALOG_BUDGET_BYTES,
  createCentralBrain,
} from "./model-brain.js";
import { createCentralToolRegistry } from "./tool-registry.js";
vi.mock("../configured-finance-model-adapter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../configured-finance-model-adapter.js")>()),
  createConfiguredFinanceModelAdapter: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
describe("central tool discovery context", () => {
  it("describes the existing explicit-account native snapshot without relabeling receipt history", () => {
    const prompt = buildCentralBrainPrompt({
      observedAt: "2026-10-09T00:00:00.000Z",
      ownerTotals: {},
      controlRoom: {},
      backlog: [],
      boundaries: ["no_execution_authority"],
    });
    expect(prompt).toContain(
      "explicit brokerAccountId also returns a stored native brokerSnapshot",
    );
    expect(prompt).toContain("not a live refresh");
    expect(prompt).toContain("cannot be combined with asOf");
    expect(prompt).toContain("not the current broker holdings");
    expect(prompt).not.toContain("brokerAccountId scopes only the broker economic diagnostic");
  });
  it("carries every registered argument and authority boundary through one shared table header", () => {
    const tools = [...createCentralToolRegistry().values()];
    const catalog = buildCentralToolCatalog(tools);
    const table = JSON.parse(catalog.split("\n")[1]) as {
      columns: string[];
      rows: unknown[][];
    };
    expect(table.columns).toEqual([
      "ownerId",
      "description",
      "inputKeys",
      "boundary",
      "allowedSideEffects",
    ]);
    const restored = table.rows.map((row) => {
      expect(row).toHaveLength(table.columns.length);
      return Object.fromEntries(table.columns.map((column, index) => [column, row[index]]));
    });
    expect(restored).toEqual(
      tools.map((tool) => ({
        ownerId: tool.ownerId,
        description: tool.description,
        inputKeys: tool.inputKeys ?? [],
        boundary: tool.boundary,
        allowedSideEffects: tool.allowedSideEffects,
      })),
    );
    expect(restored.some((tool) => tool.ownerId === "selfRepairHands")).toBe(false);
    expect(catalog).toContain("every proposal is independently gated");
  });

  it("does not invent tools for an empty registry", () => {
    const table = JSON.parse(buildCentralToolCatalog([]).split("\n")[1]) as {
      rows: unknown[][];
    };
    expect(table.rows).toEqual([]);
  });

  it("rejects oversized descriptions instead of silently dropping a tool or its restrictions", () => {
    const tool = [...createCentralToolRegistry().values()][0];
    expect(() =>
      buildCentralToolCatalog([
        { ...tool, description: "财".repeat(CENTRAL_TOOL_CATALOG_BUDGET_BYTES) },
      ]),
    ).toThrow("central tool discovery catalog exceeds its context budget");
  });
});
describe("central configured model capacity", () => {
  it("forwards the host cycle deadline to the existing configured adapter", async () => {
    const invoke = vi.fn<LogicalAgentModelAdapter["invoke"]>(async () => ({}));
    vi.mocked(createConfiguredFinanceModelAdapter).mockReturnValue({
      id: "fixture",
      provider: "fixture",
      modelId: "fixture",
      mode: "adapter",
      capabilities: [],
      requiredTools: [],
      requiredSideEffects: [],
      invoke,
    });
    const deadlineAtMs = Date.now() + 100;
    await runCentralHarnessCycle({
      perception: {
        observedAt: new Date().toISOString(),
        ownerTotals: {},
        controlRoom: {},
        backlog: [],
        boundaries: [],
      },
      registry: new Map(),
      brain: createCentralBrain({}),
      deadlineMs: deadlineAtMs,
    });
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({ deadlineAtMs });
  });

  it("passes through default capacity and explicit output limits without a hidden 4096 cap", () => {
    vi.mocked(createConfiguredFinanceModelAdapter).mockReturnValue({
      id: "fixture",
      provider: "fixture",
      modelId: "fixture",
      mode: "adapter",
      capabilities: [],
      requiredTools: [],
      requiredSideEffects: [],
      invoke: async () => ({}),
    });
    createCentralBrain({});
    createCentralBrain({}, { maxTokens: 384_000 });
    expect(
      vi.mocked(createConfiguredFinanceModelAdapter).mock.calls[0]?.[1]?.maxTokens,
    ).toBeUndefined();
    expect(vi.mocked(createConfiguredFinanceModelAdapter).mock.calls[1]?.[1]?.maxTokens).toBe(
      384_000,
    );
    expect(vi.mocked(createConfiguredFinanceModelAdapter).mock.calls[0]?.[1]).toMatchObject({
      maxCalls: 12,
      timeoutMs: 120_000,
    });
  });
});
