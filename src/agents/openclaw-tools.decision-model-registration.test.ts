import "./test-helpers/fast-core-tools.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";
import { resolveToolProfilePolicy, TOOL_GROUPS } from "./tool-policy.js";

afterEach(() => vi.unstubAllEnvs());

describe("decision model assembly", () => {
  it("is registered, discoverable on the coding profile and safely inspectable while disabled", async () => {
    vi.stubEnv("LCX_CLEF_ENABLED", "0");
    const tool = createOpenClawTools().find((entry) => entry.name === "decision_model_evaluate");
    expect(tool).toBeDefined();
    expect(resolveToolProfilePolicy("coding")?.allow).toContain(tool?.name);
    expect(TOOL_GROUPS["group:memory"]).toContain(tool?.name);
    const result = await tool!.execute("inspect", { action: "inspect" });
    expect(result.details).toMatchObject({ reason: "disabled", providerCallObserved: false });
  });

  it("passes sandbox context through the real assembly", async () => {
    vi.stubEnv("LCX_CLEF_ENABLED", "1");
    vi.stubEnv("LCX_CLEF_ACCOUNT_ID", "a".repeat(32));
    vi.stubEnv("LCX_CLEF_API_TOKEN", "sandbox-test-token");
    const tool = createOpenClawTools({ sandboxed: true }).find(
      (entry) => entry.name === "decision_model_evaluate",
    );
    const result = await tool!.execute("eval", {
      action: "evaluate",
      state: "Test",
      questions: { yes: { type: "noul", instructions: "Test?" } },
    });
    expect(result.details).toMatchObject({
      reason: "sandbox_blocked",
      providerCallObserved: false,
    });
  });
});
