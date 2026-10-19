import fs from "node:fs/promises";
import {
  replayGammaScalping,
  type GammaScalpingReplayInput,
} from "../../src/agents/finance-gamma-scalping-replay.ts";

const [flag, filename, ...extra] = process.argv.slice(2);
if (flag !== "--input" || !filename || extra.length > 0) {
  throw new Error(
    "Usage: node --import tsx scripts/operator/finance-gamma-scalping-replay.ts --input FILE.json (synthetic research only)",
  );
}
const input = JSON.parse(await fs.readFile(filename, "utf8")) as GammaScalpingReplayInput;
const hedged = replayGammaScalping(input);
const unhedged = replayGammaScalping({ ...input, hedgeEnabled: false });
console.log(JSON.stringify({ boundary: "synthetic_research_only", hedged, unhedged }, null, 2));
