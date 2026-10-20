import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createAlphaVantageMarketAdapter } from "../../src/agents/finance-additional-source-adapters.js";
import {
  createFinanceRealtimeSourceRegistry,
  inspectFinanceRealtimeSourceRegistry,
  runFinanceRealtimeRefresh,
} from "../../src/agents/finance-realtime-source-registry.js";

type SourceFault = "missing_source" | "late_body";

export async function probeConfiguredPredictionSourceExclusion() {
  const calls: string[] = [];
  const adapter = createAlphaVantageMarketAdapter({
    apiKey: "private-fixture-not-real",
    fetchImpl: async (url) => {
      calls.push(String(url));
      throw new Error("unsupported_prediction_source_must_not_dispatch");
    },
  });
  const request = {
    instrument: "offline-prediction-eighteenth",
    assetClass: "prediction_market",
    useCase: "finance_research_run",
    asOf: "2026-07-01T12:00:00.000Z",
  };
  const inspection = inspectFinanceRealtimeSourceRegistry(request, [adapter]);
  const receipt = await runFinanceRealtimeRefresh({
    request,
    adapters: [adapter],
    maxSources: 1,
    timeoutMs: 250,
    retry: { attempts: 1 },
  });
  return {
    inspection,
    receipt,
    calls,
    predictionEligible: adapter.supports(request),
    existingClassEligibility: ["equity", "etf"].map((assetClass) => ({
      assetClass,
      supported: adapter.supports({ ...request, assetClass }),
    })),
  };
}

/** Original default source registry, adapters, API deadline and gateway; only HTTP I/O is local. */
export async function probePredictionSourceHandoff(params: {
  workspaceDir: string;
  assetClass: string;
  fault?: SourceFault;
}) {
  const request = {
    instrument:
      params.assetClass.trim().toLowerCase() === "equity"
        ? "AAPL"
        : params.assetClass.trim().toLowerCase() === "etf"
          ? "SPY"
          : "offline-prediction-eighteenth",
    assetClass: params.assetClass,
    useCase: "finance_research_run",
    asOf: "2026-07-01T12:00:00.000Z",
  };
  const sourceDir = path.join(params.workspaceDir, "private-source");
  await fs.mkdir(sourceDir, { recursive: true });
  const sourceBodies = {
    nasdaq: JSON.stringify({
      fixture: "synthetic original-parser source, not observed market evidence",
      data: {
        primaryData: {
          lastSalePrice: "$100.00",
          lastTradeTimestamp: request.asOf,
          isRealTime: true,
        },
      },
    }),
    stooq: "Date,Open,High,Low,Close,Volume\n2026-07-01,100,101,99,100,1000\n",
  };
  for (const [name, body] of Object.entries(sourceBodies)) {
    if (params.fault !== "missing_source") {
      await fs.writeFile(path.join(sourceDir, `${name}.txt`), body);
    }
  }
  const calls: { url: string; bodyRead: boolean; bodyFinished: boolean }[] = [];
  const deniedPrivateResponseUrls: string[] = [];
  const adapters = createFinanceRealtimeSourceRegistry({
    fetchImpl: async (url) => {
      const address = String(url);
      const kind = address.startsWith("https://api.nasdaq.com/")
        ? "nasdaq"
        : address.startsWith("https://stooq.com/")
          ? "stooq"
          : undefined;
      if (!kind) {
        deniedPrivateResponseUrls.push(address);
        throw new Error(`private_response_not_allowlisted:${address}`);
      }
      const call = { url: address, bodyRead: false, bodyFinished: false };
      calls.push(call);
      return {
        ok: true,
        status: 200,
        text: async () => {
          call.bodyRead = true;
          if (params.fault === "late_body") {
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
          }
          const body = await fs.readFile(path.join(sourceDir, `${kind}.txt`), "utf8");
          call.bodyFinished = true;
          return body;
        },
      };
    },
  });
  const inspection = inspectFinanceRealtimeSourceRegistry(request, adapters);
  const receipt = await runFinanceRealtimeRefresh({
    request,
    adapters,
    maxSources: 4,
    timeoutMs: params.fault === "late_body" ? 25 : 250,
    retry: { attempts: 1 },
  });
  const terminalBytes = JSON.stringify(receipt);
  const bodyFinishedAtTerminal = calls.map((call) => call.bodyFinished);
  if (params.fault === "late_body") {
    await new Promise<void>((resolve) => setTimeout(resolve, 140));
  }
  const result = {
    request,
    inspection,
    receipt,
    calls,
    deniedPrivateResponseUrls,
    bodyFinishedAtTerminal,
    terminalUnchangedAfterLateBody: terminalBytes === JSON.stringify(receipt),
    sourceBodies: Object.fromEntries(
      Object.entries(sourceBodies).map(([name, body]) => [
        name,
        {
          path: path.join(sourceDir, `${name}.txt`),
          sha256: createHash("sha256").update(body).digest("hex"),
          exists: params.fault !== "missing_source",
        },
      ]),
    ),
    originalConsumer: "runFinanceRealtimeRefresh consumes actual adapter results and API receipts",
    evidenceOrigin: "offline_fixture",
    wholePredictionWorkflowObserved: false,
    resolutionMicrostructureSampleOutConsumer: "required_not_implemented",
    cleanup:
      params.fault === "late_body"
        ? "local delayed response completed; original source cancellation acknowledgement unobserved"
        : "no timeout cancellation claim",
  };
  await fs.writeFile(
    path.join(params.workspaceDir, "actual-source-handoff.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  return result;
}
