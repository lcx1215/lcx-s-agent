import { planLcxEngineRequest } from "../../src/engine/lcx-engine.js";
import { LCX_ENGINE_CONTRACT_VERSION, type LcxEnginePlan } from "../../src/engine/types.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";

/** Version-pinned host identity for the beta adapter under validation. */
export const LCX_ENGINE_BETA_ADAPTER_ID = "openclaw-beta-2026.9.1-beta.1";

function renderPreflightContext(plan: LcxEnginePlan): string {
  const context =
    plan.systemContext ??
    [
      "[LCX Engine preflight - deterministic]",
      `Contract: ${plan.contractVersion}`,
      `Route: ${plan.route}`,
      `Risk tier: ${plan.riskTier}`,
      `Required capabilities: ${plan.requiredCapabilities.join(", ") || "none"}`,
      `Boundaries: ${plan.boundaries.join(", ")}`,
      "This is routing context only. Do not claim a tool ran, data is fresh, learning happened, or an external user saw the answer without independent evidence.",
    ].join("\n");

  return [
    context,
    `Host adapter: ${LCX_ENGINE_BETA_ADAPTER_ID}`,
    "Execution host: OpenClaw beta; the host result is not LCX learning proof.",
  ].join("\n");
}

/** Deterministic adapter seam used by isolated beta-host tests. */
export function buildLcxBetaPreflight(prompt: string): {
  plan: LcxEnginePlan;
  context: string;
} {
  const plan = planLcxEngineRequest({
    prompt,
    trigger: "openclaw-beta-before-prompt-build",
    adapterId: LCX_ENGINE_BETA_ADAPTER_ID,
  });
  return { plan, context: renderPreflightContext(plan) };
}

const lcxEnginePlugin = {
  id: "lcx-engine",
  name: "LCX Engine",
  description: "Runs LCX deterministic control-plane preflight before an OpenClaw beta turn.",
  register(api: OpenClawPluginApi) {
    api.on("before_prompt_build", async (event) => {
      if (!event.prompt?.trim()) {
        return;
      }

      const { plan, context } = buildLcxBetaPreflight(event.prompt);
      api.logger.info?.(
        `lcx-engine: host=${LCX_ENGINE_BETA_ADAPTER_ID} contract=${LCX_ENGINE_CONTRACT_VERSION} route=${plan.route} risk=${plan.riskTier}`,
      );
      return { prependContext: context };
    });
  },
};

export default lcxEnginePlugin;
