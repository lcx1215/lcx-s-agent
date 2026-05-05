import { hardenLocalBrainPlanForAsk } from "./local-brain-contracts.js";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  throw new Error("Usage: node --import tsx scripts/dev/local-brain-open-eval-provider.ts TEXT");
}

const sourceSummary =
  process.env.LCX_OPEN_EVAL_SOURCE_SUMMARY?.trim() ||
  "open_source_eval_provider_no_live_side_effects";

const plan = hardenLocalBrainPlanForAsk(
  {},
  {
    ask: prompt,
    sourceSummary,
  },
);

process.stdout.write(`${JSON.stringify(plan)}\n`);
