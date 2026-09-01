import { describe, expect, it } from "vitest";
import {
  buildGroundingContext,
  composeFinanceAnswer,
  type FinanceModelCaller,
} from "./finance-answer-composer.js";
import { buildFinanceDataGatewaySnapshot } from "./finance-data-gateway.js";
import { collectLiveFinanceGatewayInput, type FetchImpl } from "./finance-live-market-source.js";

const SAMPLE_JSON = JSON.stringify({
  chart: {
    result: [
      {
        meta: {
          currency: "USD",
          symbol: "QQQ",
          regularMarketPrice: 725.17,
          regularMarketTime: 1782936000,
          exchangeTimezoneName: "America/New_York",
        },
      },
    ],
    error: null,
  },
});

function fakeFetch(body: string): FetchImpl {
  return async () => ({ ok: true, status: 200, text: async () => body });
}

// Records what the model was given so we can assert the grounding was injected.
function recordingModel(reply: string): {
  caller: FinanceModelCaller;
  seen: { model: string; systemContext: string; userMessage: string }[];
} {
  const seen: { model: string; systemContext: string; userMessage: string }[] = [];
  const caller: FinanceModelCaller = async (request) => {
    seen.push(request);
    return { text: reply };
  };
  return { caller, seen };
}

async function buildBlockedSnapshot() {
  const input = await collectLiveFinanceGatewayInput({
    instrument: "QQQ",
    assetClass: "etf",
    useCase: "compose_test",
    requireOfficialReference: false,
    now: () => new Date("2026-07-01T20:05:00.000Z"),
    fetchImpl: fakeFetch(SAMPLE_JSON),
  });
  return buildFinanceDataGatewaySnapshot(input);
}

describe("buildGroundingContext", () => {
  it("warns against inventing numbers when there is no snapshot", () => {
    const context = buildGroundingContext(undefined);
    expect(context).toContain("Do not invent");
  });

  it("renders fields with source + timestamp and flags blocked quality", async () => {
    const snapshot = await buildBlockedSnapshot();
    const context = buildGroundingContext(snapshot);
    expect(context).toContain("QQQ");
    expect(context).toContain("725.17");
    expect(context).toContain("2026-07-01T20:00:00.000Z");
    expect(context).toContain("blocked");
    expect(context).toContain("Missing evidence");
  });
});

describe("composeFinanceAnswer", () => {
  it("calls the real model interface with grounding injected and returns a candidate", async () => {
    const snapshot = await buildBlockedSnapshot();
    const model = recordingModel(
      "QQQ research packet: last price 725.17 (delayed, 2026-07-01), data blocked pending cross-check. Thesis... Invalidation...",
    );
    const result = await composeFinanceAnswer({
      ask: "QQQ 最近风险怎么看?",
      snapshot,
      model: "moonshot/kimi-k2.5",
      executionId: "gateway-execution-1",
      callModel: model.caller,
    });
    expect(result.dataPosture).toBe("data_blocked");
    expect(result.modelUsed).toBe("moonshot/kimi-k2.5");
    expect(result.executionId).toBe("gateway-execution-1");
    expect(result.candidateAnswer).toContain("725.17");
    // The model must have been handed the research-only preamble + grounding.
    expect(model.seen).toHaveLength(1);
    expect(model.seen[0].systemContext).toContain("research-only");
    expect(model.seen[0].systemContext).toContain("725.17");
    expect(model.seen[0].userMessage).toBe("QQQ 最近风险怎么看?");
  });

  it("reports no_snapshot posture when no gateway data is supplied", async () => {
    const model = recordingModel("General framework answer with explicit missing-data note.");
    const result = await composeFinanceAnswer({
      ask: "how should I think about semiconductor cycle risk?",
      model: "minimax/text",
      callModel: model.caller,
    });
    expect(result.dataPosture).toBe("no_snapshot");
    expect(model.seen[0].systemContext).toContain("Do not invent");
  });

  it("fails closed when the model returns an empty answer", async () => {
    const model = recordingModel("   ");
    await expect(
      composeFinanceAnswer({
        ask: "QQQ risk?",
        model: "moonshot/kimi-k2.5",
        callModel: model.caller,
      }),
    ).rejects.toThrowError(/empty candidate/u);
  });

  it("rejects an empty ask", async () => {
    const model = recordingModel("x");
    await expect(
      composeFinanceAnswer({ ask: "   ", model: "moonshot/kimi-k2.5", callModel: model.caller }),
    ).rejects.toThrowError(/ask required/u);
  });
});
