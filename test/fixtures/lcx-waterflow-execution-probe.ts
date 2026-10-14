/** Entire original execution owner with its offline paper seam and a private native book. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildFinanceLiveExecutionPayload,
  type Options,
} from "../../scripts/operator/lcx-finance-live-execution.js";
import type {
  WorkflowFieldRef,
  WorkflowHandoffEvidence,
} from "../../scripts/operator/lcx-flow-graph.js";
import type { FinanceExecutionObservation } from "../../src/agents/finance-execution-adapter.js";
import {
  createFinanceExecutionSafetyContext,
  FinanceExecutionSafetyFactsError,
  type FinanceExecutionSafetyContextFactory,
  type FinanceExecutionSafetyFacts,
} from "../../src/agents/finance-execution-safety.js";
import { readFinancePositionLedger } from "../../src/agents/finance-position-ledger.js";

export type ExecutionProbeFault = "broker_unknown" | "timeout" | "missing_authorization";
export async function probeOriginalExecution(params: {
  directory: string;
  quantity?: number;
  fault?: ExecutionProbeFault;
  disturbObserver?: boolean;
}) {
  await fs.mkdir(params.directory, { recursive: true });
  const accountId = `offline-${createHash("sha256").update(path.resolve(params.directory)).digest("hex").slice(0, 12)}`;
  const runId = `offline-${path.basename(params.directory)}`;
  const events = new Map<string, FinanceExecutionObservation>();
  const book = path.join(params.directory, "book");
  let factsReads = 0;
  let resolveLate: ((facts: FinanceExecutionSafetyFacts) => void) | undefined;
  let returnedFacts: FinanceExecutionSafetyFacts | undefined;
  let originalBinding: Parameters<FinanceExecutionSafetyContextFactory>[0] | undefined;
  const createSafetyContext: FinanceExecutionSafetyContextFactory = (binding) => {
    originalBinding = structuredClone(binding);
    const observedAt = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + (params.fault === "timeout" ? 150 : 60_000),
    ).toISOString();
    returnedFacts = {
      accountId,
      adapterId: binding.adapterId,
      venue: binding.venue,
      instrument: binding.intent.instrument,
      instrumentEvidence: {
        source: "fixture://funded-spot-equity",
        observedAt,
        assetType: "spot_equity",
        fullyPaid: true,
        marginEnabled: false,
        hedged: false,
      },
      snapshotId: "offline-account-snapshot",
      source: "fixture://offline-account",
      observedAt,
      expiresAt,
      positionQuantity: 0,
      openOrderIds: [],
      unresolvedOrderIds: [],
      account: {
        status: "ACTIVE",
        tradingBlocked: false,
        equity: 1_000_000,
        peakEquity: 1_000_000,
        availableCash: 1_000_000,
        currency: "USD",
        grossExposure: 0,
      },
      quote: {
        source: "fixture://offline-price",
        price: binding.intent.referencePrice,
        observedAt: binding.intent.referencePriceAt,
        expiresAt,
        currency: "USD",
      },
    };
    return createFinanceExecutionSafetyContext({
      ...binding,
      stateDir: path.join(params.directory, "claims"),
      accountId,
      policy: {
        planId: "offline-fixture-plan",
        revision: "1",
        riskModel: "fully_funded_unhedged_spot",
        authorizedSide: binding.intent.side,
        authorizedQuantity: binding.intent.quantity,
        expiresAt,
        maxPortfolioDrawdownFraction: 0.1,
        maxGrossExposure: 2_000_000,
        maxAccountAgeMs: 60_000,
        maxQuoteAgeMs: 60_000,
        maxInstrumentEvidenceAgeMs: 60_000,
      },
      readFacts: async () => {
        factsReads++;
        if (params.fault === "broker_unknown") {
          throw new FinanceExecutionSafetyFactsError("account_snapshot_unavailable");
        }
        if (params.fault === "timeout") {
          return new Promise<FinanceExecutionSafetyFacts>((resolve) => {
            resolveLate = resolve;
          });
        }
        return returnedFacts!;
      },
    });
  };
  const options: Options = {
    instrument: "AAPL",
    assetClass: "us_equity",
    riskPct: 0.5,
    drawdownPct: 0,
    hasStructure: true,
    stopPrice: 95,
    side: "buy",
    orderType: "market",
    quantity: params.quantity ?? 2,
    referencePrice: 100,
    asOf: new Date(Date.now() - 1000).toISOString(),
    runAuthorization: params.fault === "missing_authorization" ? "" : runId,
    rationale: "Declared offline fixture; no venue or real broker authority",
    allowInstruments: ["AAPL"],
    marks: [],
    budget: {
      automation: "attended",
      maxOrderNotional: 10_000,
      maxInstrumentNotional: 10_000,
      maxOrdersPerRun: 2,
      allowedInstruments: ["AAPL"],
    },
    writeLedger: true,
    ledgerDirectory: book,
    adapter: "paper",
    json: true,
  };
  const payload = await buildFinanceLiveExecutionPayload(options, {
    createSafetyContext,
    observe: (event) => {
      events.set(event.node, { ...events.get(event.node), ...event });
      if (params.disturbObserver) {
        const mutable = event.output as { quantity?: number } | undefined;
        if (mutable && typeof mutable === "object") {
          mutable.quantity = 999;
        }
        throw new Error("diagnostic sink failure");
      }
    },
  });
  const independentReadback = await readFinancePositionLedger(book);
  const beforeLate = JSON.stringify(independentReadback);
  const eventCountBeforeLate = events.size;
  if (resolveLate && returnedFacts) {
    resolveLate(returnedFacts);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  const afterLate = await readFinancePositionLedger(book);
  const lateResultIgnored =
    JSON.stringify(afterLate) === beforeLate && events.size === eventCountBeforeLate;
  if (params.fault === "timeout" && factsReads !== 1) {
    throw new Error("timeout did not exercise the original fact reader");
  }
  const files = new Map<string, string>();
  for (const [node, event] of events) {
    const file = path.join(params.directory, `${node}-original-stage.json`);
    const body = { scope: { runAuthorizationId: options.runAuthorization, accountId }, ...event };
    await fs.writeFile(file, JSON.stringify(body, null, 2) + "\n");
    files.set(node, file);
  }
  const readbackFile = path.join(params.directory, "original-operator-readback.json");
  await fs.writeFile(
    readbackFile,
    JSON.stringify(
      {
        options,
        originalBinding,
        payload,
        independentReadback,
        afterLate,
        factsReads,
        lateResultIgnored,
      },
      null,
      2,
    ) + "\n",
  );
  async function ref(file: string, pointer: string): Promise<WorkflowFieldRef> {
    return {
      path: file,
      pointer,
      sha256: createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex"),
    };
  }
  const predecessors: Record<string, string> = {
    explicit_run_authorization: "execution_intent",
    declared_execution_adapter: "explicit_run_authorization",
    order_placement: "declared_execution_adapter",
    execution_receipt: "order_placement",
    position_ledger: "execution_receipt",
  };
  const nodes: WorkflowHandoffEvidence["nodes"] = [];
  for (const [node, event] of events) {
    const file = files.get(node)!;
    nodes.push({
      nodeId: node as WorkflowHandoffEvidence["nodes"][number]["nodeId"],
      scope: await ref(file, "/scope"),
      ...(event.output !== undefined ? { output: await ref(file, "/output") } : {}),
      ...(event.input !== undefined && predecessors[node]
        ? {
            inputs: [
              {
                from: predecessors[node] as WorkflowHandoffEvidence["nodes"][number]["nodeId"],
                value: await ref(file, "/input"),
              },
            ],
          }
        : {}),
      ...(event.status === "refused"
        ? {
            block: {
              filter:
                node === "explicit_run_authorization"
                  ? "explicit_run_authorization_required"
                  : "risk_budget_required",
              status: await ref(file, "/status"),
              reason: await ref(file, "/reason"),
            },
          }
        : {}),
    });
  }
  return {
    boundary: "original_execution_owner_paper_fixture_only_no_credentials_or_venue",
    accountId,
    options,
    payload,
    originalBinding,
    independentReadback,
    afterLate,
    factsReads,
    lateResultIgnored,
    readbackFile,
    events: [...events.values()],
    handoffEvidence: {
      scenarioId: "finance_live_execution_waterflow",
      environment: "offline_fixture",
      nodes,
    } as WorkflowHandoffEvidence,
  };
}
