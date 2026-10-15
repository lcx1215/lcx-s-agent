import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchImpl } from "../src/agents/finance-live-market-source.js";
import { probeOriginalFinanceDayOperator } from "./fixtures/lcx-waterflow-finance-day-operator-probe.js";

const seam = vi.hoisted(() => ({ fetchImpl: undefined as FetchImpl | undefined }));
vi.mock("../src/agents/finance-free-market-collection-adapters.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/agents/finance-free-market-collection-adapters.js")
    >();
  return {
    ...actual,
    createChinaReachableUsEodHistoryCollectionAdapter: (
      params?: Parameters<typeof actual.createChinaReachableUsEodHistoryCollectionAdapter>[0],
    ) => {
      const fetchImpl = params?.fetchImpl ?? seam.fetchImpl;
      if (!fetchImpl) {
        throw new Error("private EOD HTTP seam missing");
      }
      return actual.createChinaReachableUsEodHistoryCollectionAdapter({ ...params, fetchImpl });
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
  seam.fetchImpl = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function probe(
  name: string,
  options: Omit<
    Parameters<typeof probeOriginalFinanceDayOperator>[0],
    "directory" | "installPrivateIo"
  > = {},
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "native-day-operator-"));
  roots.push(directory);
  const network = vi.fn(() => {
    throw new Error("external network forbidden");
  });
  vi.stubGlobal("fetch", network);
  const result = await probeOriginalFinanceDayOperator({
    directory,
    ...options,
    installPrivateIo: (input) => {
      seam.fetchImpl = input.fetchImpl;
      vi.stubEnv("OPENCLAW_WORKSPACE_DIR", input.workspace);
      vi.stubEnv("LCX_FINANCE_STATE_DIR", input.directory);
      vi.stubEnv("ALPACA_API_KEY_ID", "");
      vi.stubEnv("ALPACA_API_SECRET_KEY", "");
    },
  });
  const retained = process.env.LCX_FINANCE_DAY_OPERATOR_PROOF_DIR;
  if (retained) {
    await fs.mkdir(retained, { recursive: true });
    await fs.cp(directory, path.join(retained, name), { recursive: true });
    await fs.writeFile(
      path.join(retained, name, "network-count.json"),
      JSON.stringify({
        globalFetchCalls: network.mock.calls.length,
        brokerBoundary:
          "native account check refused missing private credentials before HTTP transport",
        actualChildSpawn: false,
      }) + "\n",
    );
  }
  expect(network).not.toHaveBeenCalled();
  return result;
}
describe("native scheduler -> complete original day operator", () => {
  it.each([0.4, 0.2])(
    "uses native budget %s through real universe/readiness/operator owners",
    async (allocation) => {
      const result = await probe(`budget-${allocation}`, { allocation });
      expect(result.dayReport?.ok, JSON.stringify(result.dayReport)).toBe(true);
      expect(result.nativeScheduler.accepted).toBe(true);
      expect(result.dayReport?.directory).toBe(result.nativeScheduler.nativeProducer.book);
      expect(result.dayReport?.portfolio).toMatchObject({
        accountId: result.nativeScheduler.planReadback!.accountId,
      });
      expect(result.dayReport?.targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ instrument: "SPY", weight: allocation }),
        ]),
      );
      expect(result.dayReport?.portfolioPlanReadback).toMatchObject({
        path: result.nativeScheduler.planPath,
        sha256: result.nativeScheduler.originalSummary!.portfolioPlanWrite!.sha256,
        parentRunId: result.nativeScheduler.record.runId,
        accountId: result.nativeScheduler.planReadback!.accountId,
        status: "verified",
      });
      expect(result.nativeScheduler.originalSummary!.portfolioPlanWrite!.sha256).toBe(
        createHash("sha256")
          .update(await fs.readFile(result.nativeScheduler.planPath))
          .digest("hex"),
      );
      expect(result.dayReport?.placed).toEqual([]);
      expect(result.dayReport?.modelCalls).toBe(0);
      expect(result.universeProof?.snapshot.selected).toEqual(["SPY"]);
      expect(result.universeProof?.snapshot.selectedMetrics[0].bars).toBeGreaterThanOrEqual(750);
      expect(result.beforeReadiness?.thresholdsDeclared).toBe(true);
      expect(result.beforeReadiness?.readiness.barCount).toBeGreaterThanOrEqual(750);
      expect(result.dayReport?.readiness).toBeDefined();
      expect(result.priceCalls.some((call) => call.phase === "operator")).toBe(true);
    },
  );
  it.each(["missing_universe", "stale_universe"] as const)(
    "returns the original %s source gate receipt",
    async (fault) => {
      const result = await probe(fault, { fault });
      expect(result.dayReport).toMatchObject({ ok: false, failureKind: "universe_selection_gate" });
      expect(result.priceCalls.some((call) => call.phase === "operator")).toBe(false);
      expect(result.nativeScheduler.accepted).toBe(false);
    },
  );
  it.each(["missing_prices", "missing_rule", "expired_plan"] as const)(
    "retains a concrete original %s failure without execution",
    async (fault) => {
      const result = await probe(fault, { fault });
      expect(result.dayReport?.ok, JSON.stringify(result.dayReport)).toBe(false);
      expect(result.dayReport?.error).toEqual(expect.any(String));
      expect(result.nativeScheduler.accepted).toBe(false);
      expect(result.dayReport?.placed).toBeUndefined();
    },
  );
  it.each(["replaced_plan", "foreign_plan_scope"] as const)(
    "refuses %s before account or provider actions using the original written plan pin",
    async (fault) => {
      const result = await probe(fault, { fault });
      expect(result.dayReport).toMatchObject({
        ok: false,
        failureKind: "portfolio_plan_binding_gate",
      });
      expect(String(result.dayReport?.error)).toContain(
        fault === "replaced_plan" ? "producer SHA256" : "producer scope",
      );
      expect(result.priceCalls.some((call) => call.phase === "operator")).toBe(false);
      expect(result.nativeScheduler.accepted).toBe(false);
      expect(result.dayReport?.placed).toBeUndefined();
    },
  );
  it("keeps a venue-conflicting unconfirmed broker blocked before account transport", async () => {
    const result = await probe("broker_unknown", { fault: "broker_unknown" });
    expect(result.dayReport).toMatchObject({
      ok: false,
      failureKind: "portfolio_plan_binding_gate",
    });
    expect(String(result.dayReport?.error)).toContain(
      "portfolio plan producer scope does not match caller",
    );
    expect(result.priceCalls.some((call) => call.phase === "operator")).toBe(false);
    expect(result.nativeScheduler.accepted).toBe(false);
  });
});
