import {
  LARK_ROUTING_CORPUS,
  scoreLarkRoutingCorpus,
  summarizeLarkRoutingCorpusScore,
} from "../../extensions/feishu/src/lark-routing-corpus.ts";
import type { FeishuConfig } from "../../extensions/feishu/src/types.ts";

const cfg = {
  surfaces: {
    control_room: { chatId: "oc-control" },
    technical_daily: { chatId: "oc-tech" },
    fundamental_research: { chatId: "oc-fund" },
    knowledge_maintenance: { chatId: "oc-knowledge" },
    ops_audit: { chatId: "oc-ops" },
    learning_command: { chatId: "oc-learning" },
    watchtower: { chatId: "oc-watch" },
  },
} as FeishuConfig;

function formatPercent(value: number | undefined): string {
  if (value === undefined) {
    return "n/a";
  }
  return `${Math.round(value * 100)}%`;
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

const score = scoreLarkRoutingCorpus({ cfg, corpus: LARK_ROUTING_CORPUS });
const summary = summarizeLarkRoutingCorpusScore({ score });

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(
    [
      `Lark routing family score`,
      `total=${summary.total}`,
      `deterministic=${formatPercent(summary.deterministicPassRate)}`,
      `semantic=${formatPercent(summary.semanticPassRate)}`,
      `stable=${summary.stableFamilies}`,
      `needs_samples=${summary.needsSampleFamilies}`,
      `weak=${summary.weakFamilies}`,
      `min_cases=${summary.minCasesPerFamily}`,
    ].join(" | "),
  );
  console.log(`${pad("family", 42)} ${pad("cases", 5)} ${pad("det", 5)} ${pad("sem", 5)} status`);
  for (const family of summary.families) {
    console.log(
      `${pad(family.family, 42)} ${pad(String(family.total), 5)} ${pad(
        formatPercent(family.deterministicPassRate),
        5,
      )} ${pad(formatPercent(family.semanticPassRate), 5)} ${family.status}${
        family.needs.length > 0 ? ` - ${family.needs.join("; ")}` : ""
      }`,
    );
  }
}
