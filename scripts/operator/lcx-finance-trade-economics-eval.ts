import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { caseflowFingerprint } from "../../src/agents/finance-caseflow.js";
import { evaluateFinanceTradeEconomics } from "../../src/agents/finance-trade-economics.js";

const { values } = parseArgs({
  options: {
    replay: { type: "string" },
    policy: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.replay || !values.policy || !values.output) {
  throw new Error("--replay FILE --policy FILE --output FILE required; research only");
}
const input = JSON.parse(await fs.readFile(values.replay, "utf8"));
const policy = JSON.parse(await fs.readFile(values.policy, "utf8"));
const frozenAt = z.string().datetime({ offset: true }).parse(policy.frozenAt);
if (Date.parse(frozenAt) > Date.now()) {
  throw new Error("policy frozenAt cannot be in the future");
}
const receipt = z
  .object({
    schemaVersion: z.literal("lcx_finance_intraday_paper_v1"),
    executionAuthority: z.literal("none"),
    datasetRef: z.string(),
    receiptRef: z.string(),
    strategyRule: z.string(),
    trades: z.array(
      z.object({
        instrument: z.string(),
        entryAt: z.string().datetime(),
        exitAt: z.string().datetime(),
        grossReturn: z.number().finite(),
        costFraction: z.number().nonnegative(),
      }),
    ),
  })
  .parse(input.receipt);
const observations = receipt.trades.map((trade) => ({
  id: `${trade.instrument}:${trade.entryAt}`,
  entryAt: trade.entryAt,
  exitAt: trade.exitAt,
  grossReturn: trade.grossReturn,
  costFraction: trade.costFraction,
}));
const output = {
  observedAt: new Date().toISOString(),
  executionAuthority: "none",
  sourceReplay: path.resolve(values.replay),
  sourceReplayRef: caseflowFingerprint(input),
  datasetRef: receipt.datasetRef,
  strategyRule: receipt.strategyRule,
  policyRef: caseflowFingerprint(policy),
  policyFrozenAt: frozenAt,
  protocol:
    "Caller-declared frozen policy; dataset previously inspected, so no untouched holdout claim.",
  scenarios: [0, 0.0005, 0.001].map((additionalCostFraction) =>
    evaluateFinanceTradeEconomics({
      observations,
      policy: policy.estimator,
      assumedRoundTripCostFraction: policy.assumedRoundTripCostFraction,
      additionalCostFraction,
    }),
  ),
};
await fs.mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
await fs.writeFile(values.output, JSON.stringify(output, null, 2) + "\n", { flag: "wx" });
process.stdout.write(
  JSON.stringify(
    {
      ...output,
      scenarios: output.scenarios.map(({ decisions: _decisions, ...summary }) => summary),
    },
    null,
    2,
  ) + "\n",
);
