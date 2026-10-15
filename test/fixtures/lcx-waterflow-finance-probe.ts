/** Original source -> gateway -> composer -> audit, with offline provider/model adapters. */
import { buildPipelineResult } from "../../scripts/operator/lcx-commercial-answer-pipeline.js";
import {
  composeFinanceAnswer,
  type FinanceModelCaller,
} from "../../src/agents/finance-answer-composer.js";
import {
  buildFinanceDataGatewaySnapshot,
  type FinanceDataGatewayInput,
} from "../../src/agents/finance-data-gateway.js";
import { collectLiveFinanceGatewayInput } from "../../src/agents/finance-live-market-source.js";

export type FinanceProbeFault =
  | "missing_source"
  | "copied_source"
  | "conflicting_source"
  | "invented_number";
export async function probeOriginalFinanceAnswer(
  params: { price?: number; fault?: FinanceProbeFault } = {},
) {
  const price = params.price ?? 100;
  const at = "2026-07-01T20:00:00.000Z";
  const sourceBody = JSON.stringify({
    chart: {
      result: [
        {
          meta: {
            symbol: "QQQ",
            regularMarketPrice: price,
            regularMarketTime: Date.parse(at) / 1000,
            currency: "USD",
          },
        },
      ],
      error: null,
    },
  });
  let fetchCalls = 0;
  const collected = await collectLiveFinanceGatewayInput({
    instrument: "QQQ",
    assetClass: "etf",
    useCase: "offline_original_owner_handoff",
    now: () => new Date("2026-07-01T20:05:00.000Z"),
    requireOfficialReference: true,
    fetchImpl: async () => {
      fetchCalls++;
      return { ok: true, status: 200, text: async () => sourceBody };
    },
  });
  const primary = collected.observations[0];
  const observation = (role: "cross_check_market_data" | "official_or_issuer_reference") => ({
    ...primary,
    providerName: `offline-${role}`,
    providerRole: role,
    sourceFamily:
      role === "official_or_issuer_reference"
        ? ("official_filing" as const)
        : ("market_data_api" as const),
    fields: primary.fields.map((field) => ({
      ...field,
      value:
        role === "cross_check_market_data" && params.fault === "conflicting_source"
          ? price + 10
          : field.value,
      sourceUrlOrArtifact:
        role === "cross_check_market_data" && params.fault === "copied_source"
          ? field.sourceUrlOrArtifact
          : `fixture://${role}/QQQ`,
    })),
  });
  const input: FinanceDataGatewayInput = {
    ...collected,
    observations: [
      primary,
      ...(params.fault === "missing_source" ? [] : [observation("cross_check_market_data")]),
      observation("official_or_issuer_reference"),
    ],
  };
  const snapshot = buildFinanceDataGatewaySnapshot(input);
  const modelInputs: Parameters<FinanceModelCaller>[0][] = [];
  const usedPrice = params.fault === "invented_number" ? 999 : price;
  const ask = "分析一下半导体板块最近的风险";
  const composed = await composeFinanceAnswer({
    ask,
    model: "offline_fixture",
    snapshot,
    callModel: async (request) => {
      modelInputs.push(request);
      return {
        text:
          `半导体研究要点:市场数据来自网关快照,报价 ${usedPrice} USD,来源与时间戳见网关证据。` +
          "结构叙事:AI算力需求驱动。论点与反论点:需求强但估值高;若利率上行或库存周期反转则证伪。" +
          "催化剂:财报与指引。风险与失效路径:关注库存、资本开支、出口管制。" +
          "组合影响:仅作研究,不构成加减仓建议。下一步:补齐证据并核对数据快照再定量。" +
          `\n\`\`\`figures\n${JSON.stringify([{ kind: "observed", name: "last_price", value: usedPrice, unit: "USD" }])}\n\`\`\``,
      };
    },
  });
  // Existing opt-in; no production default, risk threshold or authority changes.
  const audited = buildPipelineResult(ask, composed.candidateAnswer, {
    snapshot,
    requireGrounding: true,
  });
  return { sourceBody, fetchCalls, input, snapshot, modelInputs, composed, audited };
}
