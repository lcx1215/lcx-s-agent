import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfiguredFinanceModelAdapter } from "../configured-finance-model-adapter.js";
import { createCentralBrain } from "./model-brain.js";
vi.mock("../configured-finance-model-adapter.js", () => ({
  createConfiguredFinanceModelAdapter: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
describe("central configured model capacity", () => {
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
