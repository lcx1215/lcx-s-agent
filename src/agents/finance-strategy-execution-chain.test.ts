import { describe, expect, it, vi } from "vitest";
vi.mock("./finance-credential-env.js", () => ({
  resolveFinanceCredentialEnv: () => ({
    ALPACA_API_KEY_ID: "PK_SYNTHETIC",
    ALPACA_API_SECRET_KEY: "SYNTHETIC_ONLY",
  }),
}));
import { runFinanceAlpacaOrder } from "./finance-alpaca-run.js";
import { evaluateConclusionToMandate } from "./finance-conclusion-to-mandate.js";
import { syntheticSafetyContextForAsset } from "./finance-execution-safety.test-support.js";
import { buildFinanceConclusionPrompt } from "./finance-research-conclusion-prompt.js";

// This composes existing seams using preset JSON. It proves neither a production bridge,
// actual model reasoning nor a real Alpaca account/venue execution.
async function presetConclusion(assetClass: "us_equity" | "crypto", instrument: string) {
  const prompt = buildFinanceConclusionPrompt({
    instrument,
    assetClass,
    horizonDays: 30,
    question: "Evaluate trend evidence and return a conditional candidate",
    availableSources: [
      { sourceId: "fixture-a", description: "synthetic trend" },
      { sourceId: "fixture-b", description: "synthetic cross-check" },
    ],
  });
  const model = vi.fn(async (input: string) => {
    expect(input).toContain("executionAuthority=none");
    expect(input).toContain("Foreground method contracts");
    return JSON.stringify({
      conclusionId: `synthetic-${assetClass}`,
      instrument,
      direction: "buy",
      conviction: 0.8,
      thesis: "Synthetic conditional candidate",
      assetClass,
      horizonDays: 30,
      invalidationPrice: 95,
      evidence: [{ sourceId: "fixture-a" }, { sourceId: "fixture-b" }],
    });
  });
  const referencePriceAt = new Date().toISOString();
  const judged = evaluateConclusionToMandate({
    raw: JSON.parse(await model(prompt)),
    referencePrice: 100,
    referencePriceAt,
    equity: 100_000,
    runAuthorizationId: "synthetic-controller-plan",
    riskContext: {
      drawdownFraction: 0,
      averagingDown: false,
      revengeSizing: false,
      hasSignificantAutocorrelation: true,
    },
  });
  expect(model).toHaveBeenCalledOnce();
  expect(judged).toMatchObject({ ok: true, passed: true });
  if (!judged.ok || !judged.passed) {
    throw new Error("synthetic conclusion refused");
  }
  return { judged, referencePriceAt };
}

describe("preset research conclusion through the existing execution chain", () => {
  it("passes a stock candidate through intake, mandate, final gate and fake Alpaca transport", async () => {
    const { judged, referencePriceAt } = await presetConclusion("us_equity", "SPY");
    let terminalBody = "";
    let accountId = "";
    const transport = vi.fn(async (request: { body: string }) => {
      const body = JSON.parse(request.body) as { qty: string; stop_loss: { stop_price: string } };
      expect(body.stop_loss.stop_price).toBe("95");
      terminalBody = JSON.stringify({
        id: "synthetic-filled",
        status: "filled",
        filled_qty: body.qty,
        filled_avg_price: "100",
        filled_at: referencePriceAt,
      });
      return { status: 200, body: terminalBody };
    });
    const read = vi.fn(async (url: string) =>
      url.endsWith("/v2/account")
        ? { status: 200, body: JSON.stringify({ id: accountId }) }
        : { status: 200, body: terminalBody },
    );
    const result = await runFinanceAlpacaOrder({
      conclusion: judged.conclusion,
      strategyClass: judged.strategyClass === "unknown" ? undefined : judged.strategyClass,
      market: { referencePrice: 100, referencePriceAt },
      equity: 100_000,
      runAuthorizationId: "synthetic-controller-plan",
      instruments: ["SPY"],
      budget: {
        automation: "unattended",
        allowedInstruments: ["SPY"],
        maxOrderNotional: 50_000,
        maxInstrumentNotional: 50_000,
        maxOrdersPerRun: 1,
      },
      createSafetyContext: syntheticSafetyContextForAsset("spot_equity", (id) => {
        accountId = id;
      }),
      transport,
      read,
    });
    expect(result).toMatchObject({ ok: true });
    expect(transport).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("blocks a crypto candidate whose protective stop the Alpaca adapter cannot support", async () => {
    const { judged, referencePriceAt } = await presetConclusion("crypto", "BTC/USD");
    let accountId = "";
    const transport = vi.fn(async () => {
      throw new Error("must not submit");
    });
    const read = vi.fn(async (url: string) => ({
      status: 200,
      body: url.endsWith("/v2/account") ? JSON.stringify({ id: accountId }) : "{}",
    }));
    await expect(
      runFinanceAlpacaOrder({
        conclusion: judged.conclusion,
        market: { referencePrice: 100, referencePriceAt },
        equity: 100_000,
        runAuthorizationId: "synthetic-controller-plan",
        instruments: ["BTC/USD"],
        budget: {
          automation: "unattended",
          allowedInstruments: ["BTC/USD"],
          maxOrderNotional: 50_000,
          maxInstrumentNotional: 50_000,
          maxOrdersPerRun: 1,
        },
        createSafetyContext: syntheticSafetyContextForAsset("spot_crypto", (id) => {
          accountId = id;
        }),
        transport,
        read,
      }),
    ).rejects.toMatchObject({
      code: "finance_execution_safety_unknown",
      cause: expect.objectContaining({
        message: expect.stringContaining("requires an explicit stop-limit protection limitPrice"),
      }),
    });
    expect(transport).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
