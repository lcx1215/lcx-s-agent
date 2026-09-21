import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ledger from "../../src/agents/finance-position-ledger.js";
vi.mock("../../src/agents/finance-credential-env.js", () => ({
  resolveFinanceCredentialEnv: () => ({
    ALPACA_API_KEY_ID: "PK_SYNTHETIC",
    ALPACA_API_SECRET_KEY: "SYNTHETIC_ONLY",
  }),
}));
import { runFinanceResearchTurn } from "../../scripts/operator/lcx-finance-research-turn.js";
import { syntheticSafetyContextForAsset } from "../../src/agents/finance-execution-safety.test-support.js";
import type { FinanceResearchExecutionControl } from "../../src/agents/finance-research-execution-bridge.js";

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
function fixture(assetClass: "us_equity" | "crypto" = "us_equity") {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "research-bridge-"));
  directories.push(stateDirectory);
  const instrument = assetClass === "crypto" ? "BTC/USD" : "SPY";
  const at = new Date().toISOString();
  const model = {
    conclusionId: "synthetic-entry",
    instrument,
    assetClass,
    direction: "buy",
    conviction: 0.8,
    thesis: "Synthetic evidence",
    horizonDays: 30,
    invalidationPrice: 95,
    evidence: [
      { sourceId: "raw" },
      { sourceId: "computed", calculationId: "calc-1" },
      { sourceId: "independent" },
    ],
  };
  const observations = [100, 101, 102];
  const mean = observations.reduce((sum, value) => sum + value, 0) / observations.length;
  const evidence = [
    {
      sourceId: "raw",
      description: "synthetic observations",
      detail: JSON.stringify(observations),
      sourceUrlOrArtifact: "fixture://observations",
      sourceTimestamp: at,
    },
    {
      sourceId: "computed",
      description: "actual injected calculation result",
      detail: `mean=${mean}`,
      sourceUrlOrArtifact: "fixture://calculation/calc-1",
      sourceTimestamp: at,
      computation: { calculationId: "calc-1", module: "fixture.mean", inputSourceIds: ["raw"] },
    },
  ];
  evidence.push({
    sourceId: "independent",
    description: "independent synthetic filing",
    detail: "revenue=200",
    sourceUrlOrArtifact: "fixture://independent-filing",
    sourceTimestamp: at,
  });
  let terminal = "";
  const transport = vi.fn(async (request: { body: string }) => {
    const order = JSON.parse(request.body) as { qty: string };
    terminal = JSON.stringify({
      id: "synthetic-terminal",
      status: "filled",
      filled_qty: order.qty,
      filled_avg_price: "100",
      filled_at: at,
    });
    return { status: 200, body: terminal };
  });
  const read = vi.fn(async () => ({ status: 200, body: terminal }));
  const control: FinanceResearchExecutionControl = {
    mode: "alpaca_paper",
    stateDirectory,
    riskContext: {
      drawdownFraction: 0,
      averagingDown: false,
      revengeSizing: false,
      hasSignificantAutocorrelation: true,
    },
    execution: {
      market: { referencePrice: 100, referencePriceAt: at },
      equity: 100_000,
      runAuthorizationId: "synthetic-controller-plan",
      instruments: [instrument],
      budget: {
        automation: "unattended",
        allowedInstruments: [instrument],
        maxOrderNotional: 50_000,
        maxInstrumentNotional: 50_000,
        maxOrdersPerRun: 1,
      },
      createSafetyContext: syntheticSafetyContextForAsset(
        assetClass === "crypto" ? "spot_crypto" : "spot_equity",
      ),
      transport,
      read,
    },
  };
  const gatherEvidence = vi.fn(async () => ({
    evidence,
    market: { referencePrice: 100, referencePriceAt: at },
  }));
  const invokeModel = vi.fn(async (prompt: string) => {
    expect(prompt).toContain("executionAuthority=none");
    expect(prompt).toContain("mean=101");
    return JSON.stringify(model);
  });
  return {
    instrument,
    model,
    evidence,
    transport,
    read,
    control,
    deps: {
      gatherEvidence,
      invokeModel,
      reflection: "",
      positionSummary: "synthetic known account",
      control,
    },
  };
}

describe("research operator calls the existing execution bridge", () => {
  it("runs supplied evidence and model output through the stock paper controller", async () => {
    const f = fixture();
    const result = await runFinanceResearchTurn(["--instrument", f.instrument], f.deps);
    expect(result).toMatchObject({
      status: "placed",
      receipt: {
        evidence: [
          { sourceId: "raw" },
          { sourceId: "computed", computation: { calculationId: "calc-1" } },
          { sourceId: "independent" },
        ],
      },
    });
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.read).toHaveBeenCalledOnce();
  });
  it("defaults to shadow and never treats model authority fields as a controller", async () => {
    const f = fixture();
    Object.assign(f.model, {
      mode: "alpaca_paper",
      runAuthorizationId: "invented",
      riskContext: f.control.riskContext,
    });
    const result = await runFinanceResearchTurn(
      ["--instrument", f.instrument, "--run-authorization", "invented"],
      {
        ...f.deps,
        control: { stateDirectory: f.control.stateDirectory, riskContext: f.control.riskContext },
      },
    );
    expect(result).toMatchObject({ status: "shadow" });
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("refuses execution with absent real risk context instead of assuming zero", async () => {
    const f = fixture();
    const result = await runFinanceResearchTurn(["--instrument", f.instrument], {
      ...f.deps,
      control: { ...f.control, riskContext: undefined },
    });
    expect(result).toMatchObject({ status: "refused", decision: { stage: "risk_context" } });
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("rejects a claimed calculation ID not present in collected evidence", async () => {
    const f = fixture();
    f.model.evidence[1].calculationId = "invented";
    const result = await runFinanceResearchTurn(["--instrument", f.instrument], f.deps);
    expect(result).toMatchObject({ status: "refused" });
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("routes crypto evidence to the same seam but refuses unsupported protective orders", async () => {
    const f = fixture("crypto");
    const result = await runFinanceResearchTurn(
      ["--instrument", f.instrument, "--asset-class", "crypto"],
      f.deps,
    );
    expect(result).toMatchObject({ status: "unknown" });
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
  it("blocks crypto before stock gathering when no crypto provider is installed", async () => {
    expect(
      await runFinanceResearchTurn(["--asset-class", "crypto", "--instrument", "BTC/USD"]),
    ).toMatchObject({ status: "blocked" });
  });
});

it("does not count bars and their calculation as independent corroboration", async () => {
  const f = fixture();
  f.model.evidence = f.model.evidence.filter((ref) => ref.sourceId !== "independent");
  const result = await runFinanceResearchTurn(["--instrument", f.instrument], f.deps);
  expect(result).toMatchObject({
    status: "refused",
    refusals: [expect.stringContaining("independent evidence roots")],
  });
  expect(f.transport).not.toHaveBeenCalled();
});
it("accepts an evidence-backed hold as research consumption without any trade", async () => {
  const f = fixture();
  f.model.direction = "hold";
  const result = await runFinanceResearchTurn(["--instrument", f.instrument], f.deps);
  expect(result).toMatchObject({ status: "shadow", disposition: "no_trade" });
  expect(f.transport).not.toHaveBeenCalled();
});

it("reads the same durable receipt history before the next model decision", async () => {
  const f = fixture();
  expect(await runFinanceResearchTurn(["--instrument", f.instrument], f.deps)).toMatchObject({
    status: "placed",
  });
  const book = await ledger.readFinancePositionLedger(f.control.stateDirectory!);
  expect(book.receiptRecordCount).toBe(1);
  const invokeModel = vi.fn(async (prompt: string) => {
    expect(prompt).toContain('"receiptCount":1');
    expect(prompt).toContain("account unassigned");
    return JSON.stringify(f.model);
  });
  await runFinanceResearchTurn(["--instrument", f.instrument], {
    ...f.deps,
    invokeModel,
    control: { ...f.control, mode: "shadow" },
  });
  expect(invokeModel).toHaveBeenCalledOnce();
  expect(f.transport).toHaveBeenCalledOnce();
});
it("blocks execution on unreadable stored history before model or transport", async () => {
  const f = fixture();
  vi.spyOn(ledger, "readFinancePositionLedger").mockRejectedValueOnce(
    new Error("synthetic corrupt database"),
  );
  expect(await runFinanceResearchTurn(["--instrument", f.instrument], f.deps)).toMatchObject({
    status: "blocked",
  });
  expect(f.deps.invokeModel).not.toHaveBeenCalled();
  expect(f.transport).not.toHaveBeenCalled();
});
it("keeps an executed receipt recoverable when ledger persistence fails, without re-dispatch", async () => {
  const f = fixture();
  vi.spyOn(ledger, "appendFinanceExecutionReceipt").mockRejectedValueOnce(
    new Error("synthetic disk failure"),
  );
  const result = await runFinanceResearchTurn(["--instrument", f.instrument], f.deps);
  expect(result).toMatchObject({
    status: "executed_persistence_pending",
    placement: { ok: true, receipt: { receiptId: expect.any(String) } },
    recovery: { action: "append existing receipt only; do not redispatch" },
  });
  expect(f.transport).toHaveBeenCalledOnce();
});
