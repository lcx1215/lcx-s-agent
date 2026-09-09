import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectFinanceSourceHealth } from "./finance-source-health.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const receipt = (adapterId: string, asOf = "2026-09-09T03:00:00Z") => ({
  schemaVersion: "lcx_finance_market_collection_v1",
  adaptersCalled: true,
  request: { asOf },
  status: "ready",
  sourceAttempts: [{ adapterId, status: "succeeded" }],
});
async function setup(files: Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-health-"));
  roots.push(root);
  const dir = path.join(root, "finance-caseflow", "receipts");
  await fs.mkdir(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name + ".json"), JSON.stringify(data));
  }
  return inspectFinanceSourceHealth({
    workspaceDir: path.join(root, "workspace"),
    env: { OPENCLAW_STATE_DIR: root },
    asOf: "2026-09-09T04:00:00Z",
  });
}

describe("finance source health evidence envelopes", () => {
  it("recognizes raw, autopilot and tool-wrapped receipts in the shared store", async () => {
    const health = await setup({
      raw: receipt("gdelt_public_news"),
      autopilot: { result: receipt("google_news_rss") },
      tool: { details: receipt("gdelt_public_news_titles") },
      nested: { details: { result: receipt("binance_public_crypto_ticker") } },
    });
    for (const id of [
      "gdelt_public_news",
      "google_news_rss",
      "gdelt_public_news_titles",
      "binance_public_crypto_ticker",
    ]) {
      expect(health.routes.find((route) => route.id === id)?.callState).toBe("recent_success");
    }
  });
  it("keeps newer failures visible and rejects dry or evaluation wrappers at every level", async () => {
    const health = await setup({
      old: receipt("gdelt_public_news_titles"),
      failure: {
        details: {
          ...receipt("gdelt_public_news_titles", "2026-09-09T03:30:00Z"),
          status: "blocked",
          sourceAttempts: [{ adapterId: "gdelt_public_news_titles", status: "failed" }],
        },
      },
      dry: { networkCalled: false, details: receipt("google_news_rss") },
      evaluation: { details: { evaluationMode: "fixture", result: receipt("gdelt_public_news") } },
      deepDry: {
        details: { result: { ...receipt("binance_public_crypto_ticker"), networkCalled: false } },
      },
    });
    expect(health.routes.find((r) => r.id === "gdelt_public_news_titles")?.callState).toBe(
      "recent_failure",
    );
    for (const id of ["google_news_rss", "gdelt_public_news", "binance_public_crypto_ticker"]) {
      expect(health.routes.find((r) => r.id === id)?.callState).toBe("unverified");
    }
  });
});
