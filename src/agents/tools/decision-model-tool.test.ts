import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { createDecisionModelTool } from "./decision-model-tool.js";

vi.mock("../../infra/net/fetch-guard.js", () => ({ fetchWithSsrFGuard: vi.fn() }));
const env = {
  LCX_CLEF_ENABLED: "1",
  LCX_CLEF_ACCOUNT_ID: "a".repeat(32),
  LCX_CLEF_API_TOKEN: "tool-test-token",
};
const args = {
  action: "evaluate",
  state: "Recorded fee evidence is missing.",
  questions: { gap: { type: "noul", instructions: "Is fee evidence missing?" } },
};
afterEach(() => vi.resetAllMocks());

describe("decision_model_evaluate", () => {
  it("reports disabled or missing credentials without making a request", async () => {
    const tool = createDecisionModelTool({ env: {} });
    expect((await tool.execute("inspect", { action: "inspect" })).details).toMatchObject({
      status: "unavailable",
      reason: "disabled",
      providerCallObserved: false,
    });
    expect((await tool.execute("eval", args)).details).toMatchObject({
      status: "fallback_to_agent",
      reason: "disabled",
    });
    const missing = createDecisionModelTool({ env: { LCX_CLEF_ENABLED: "1" } });
    expect((await missing.execute("eval", args)).details).toMatchObject({
      reason: "credentials_missing",
    });
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("blocks sandbox inference even with a valid host credential", async () => {
    const tool = createDecisionModelTool({ env, sandboxed: true });
    expect((await tool.execute("eval", args)).details).toMatchObject({ reason: "sandbox_blocked" });
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("distinguishes host configuration from a verified inference", async () => {
    const result = await createDecisionModelTool({ env }).execute("inspect", { action: "inspect" });
    expect(result.details).toMatchObject({
      status: "configured_not_verified",
      model: "clef-flash",
      providerCallObserved: false,
    });
    expect(JSON.stringify(result)).not.toContain("tool-test-token");
    expect(JSON.stringify(result)).not.toContain(env.LCX_CLEF_ACCOUNT_ID);
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("rejects caller-controlled model/credentials and bad input before the network", async () => {
    const tool = createDecisionModelTool({ env });
    await expect(tool.execute("eval", { ...args, model: "clef" })).rejects.toThrow("accepts only");
    await expect(tool.execute("eval", { ...args, questions: {} })).rejects.toThrow(
      "invalid_request",
    );
    await expect(tool.execute("inspect", { action: "inspect", state: "ignored" })).rejects.toThrow(
      "inspect does not accept",
    );
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("returns probability evidence to the agent and bounds repeated calls", async () => {
    vi.mocked(fetchWithSsrFGuard).mockImplementation(async () => ({
      response: new Response(
        JSON.stringify({
          success: true,
          result: { model: "clef-flash", answers: { gap: { type: "noul", noul: 0.9 } } },
        }),
      ),
      finalUrl: "https://api.cloudflare.com",
      release: async () => {},
    }));
    const tool = createDecisionModelTool({ env });
    for (let index = 0; index < 8; index++) {
      const result = await tool.execute(String(index), args);
      expect(result.details).toMatchObject({
        status: "completed_requires_review",
        answers: { gap: { noul: 0.9 } },
        boundary: ["advisory_only", "no_execution_authority", "existing_gates_required"],
      });
    }
    expect((await tool.execute("over-budget", args)).details).toMatchObject({
      reason: "call_budget_exhausted",
    });
    expect(fetchWithSsrFGuard).toHaveBeenCalledTimes(8);
  });

  it("keeps invalid-input errors bounded and preserves the call budget", async () => {
    const tool = createDecisionModelTool({ env });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const throwingState = {
      get secret() {
        throw new Error("private-input-secret tool-test-token");
      },
    };
    for (const state of [cyclic, throwingState]) {
      await expect(tool.execute("invalid", { ...args, state })).rejects.toThrow(
        /^invalid_request$/,
      );
    }
    await expect(
      tool.execute("over-budget", { ...args, state: "界".repeat(12_000) }),
    ).rejects.toThrow(/^request_budget_exceeded$/);
    expect((await tool.execute("inspect", { action: "inspect" })).details).toMatchObject({
      callsRemaining: 8,
      providerCallObserved: false,
    });
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});
