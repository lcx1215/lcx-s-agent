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
  sourceAttempts: [{ adapterId, status: "succeeded", apiCalls: [{ dispatchedAt: asOf }] }],
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
  it("declares Alpaca even when its secret component is absent", async () => {
    const health = await setup({});
    expect(health.routes.find((route) => route.id === "alpaca_us_equity_latest_quote")).toEqual(
      expect.objectContaining({ callState: "not_configured_or_disabled" }),
    );
  });
  it("keeps newer failures visible and rejects dry or evaluation wrappers at every level", async () => {
    const health = await setup({
      old: receipt("gdelt_public_news_titles"),
      failure: {
        details: {
          ...receipt("gdelt_public_news_titles", "2026-09-09T03:30:00Z"),
          status: "blocked",
          sourceAttempts: [
            {
              adapterId: "gdelt_public_news_titles",
              status: "failed",
              apiCalls: [{ dispatchedAt: "2026-09-09T03:30:00Z" }],
            },
          ],
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
  it("ignores future evidence instead of hiding the latest valid failure", async () => {
    const health = await setup({
      future: receipt("gdelt_public_news", "2026-09-10T03:00:00Z"),
      failure: {
        ...receipt("gdelt_public_news"),
        status: "blocked",
        sourceAttempts: [
          {
            adapterId: "gdelt_public_news",
            status: "failed",
            apiCalls: [{ dispatchedAt: "2026-09-09T03:00:00Z" }],
          },
        ],
      },
    });
    expect(health.routes.find((r) => r.id === "gdelt_public_news")?.callState).toBe(
      "recent_failure",
    );
  });
  it.each([true, false])(
    "keeps same-time failures visible regardless of file order (%s)",
    async (failureFirst) => {
      const success = receipt("gdelt_public_news");
      const failure = {
        ...success,
        status: "blocked",
        sourceAttempts: [
          {
            adapterId: "gdelt_public_news",
            status: "failed",
            apiCalls: [{ dispatchedAt: "2026-09-09T03:00:00Z" }],
          },
        ],
      };
      const health = await setup({
        a: failureFirst ? failure : success,
        z: failureFirst ? success : failure,
      });
      expect(health.routes.find((r) => r.id === "gdelt_public_news")?.callState).toBe(
        "recent_failure",
      );
    },
  );
  it("skips malformed attempts without losing valid sibling failures", async () => {
    const health = await setup({
      mixed: {
        ...receipt("gdelt_public_news"),
        sourceAttempts: [
          null,
          {
            adapterId: "gdelt_public_news",
            status: "failed",
            apiCalls: [{ dispatchedAt: "2026-09-09T03:00:00Z" }],
          },
        ],
      },
    });
    expect(health.routes.find((r) => r.id === "gdelt_public_news")?.callState).toBe(
      "recent_failure",
    );
  });
});

it("does not turn cache reads or locally rejected dispatch into recovered provider health", async () => {
  const health = await setup({
    old: {
      ...receipt("gdelt_public_news", "2026-09-09T02:00:00Z"),
      sourceAttempts: [
        {
          adapterId: "gdelt_public_news",
          status: "failed",
          apiCalls: [{ dispatchedAt: "2026-09-09T02:00:00Z" }],
        },
      ],
    },
    cached: {
      ...receipt("gdelt_public_news"),
      sourceAttempts: [
        {
          adapterId: "gdelt_public_news",
          status: "succeeded",
          apiCalls: [
            {
              operation: "http_get",
              status: "succeeded",
              dataAccess: { kind: "cache", fetchedAt: "2026-09-09T02:00:00Z" },
            },
          ],
        },
      ],
    },
  });
  expect(health.routes.find((route) => route.id === "gdelt_public_news")?.callState).toBe(
    "recent_failure",
  );
  expect(health.responseReuse.scope).toBe("process_local");
});

it("uses verified dispatch time for freshness and rejects success without dispatch proof", async () => {
  const health = await setup({
    recent: {
      ...receipt("gdelt_public_news", "2026-01-01T00:00:00Z"),
      sourceAttempts: [
        {
          adapterId: "gdelt_public_news",
          status: "succeeded",
          apiCalls: [{ dispatchedAt: "2026-09-09T03:30:00Z" }],
        },
      ],
    },
    noProof: {
      ...receipt("google_news_rss", "2026-09-09T03:00:00Z"),
      sourceAttempts: [{ adapterId: "google_news_rss", status: "succeeded" }],
    },
  });
  expect(health.routes.find((route) => route.id === "gdelt_public_news")?.callState).toBe(
    "recent_success",
  );
  expect(health.routes.find((route) => route.id === "google_news_rss")?.callState).toBe(
    "unverified",
  );
  expect(health.routes.find((route) => route.id === "gdelt_public_news")?.lastObservation).toEqual(
    expect.objectContaining({ dispatchedAt: "2026-09-09T03:30:00.000Z" }),
  );
});

it("projects DOC, title-file and public FRED quotas onto their own routes", async () => {
  const health = await setup({});
  expect(
    health.routes
      .find((route) => route.id === "gdelt_public_news")
      ?.quotaGroups.map((quota) => quota.id),
  ).toEqual(["gdelt_doc"]);
  expect(
    health.routes
      .find((route) => route.id === "gdelt_public_news_titles")
      ?.quotaGroups.map((quota) => quota.id),
  ).toEqual(["gdelt_titles"]);
  expect(
    health.routes
      .find((route) => route.id === "fred_public_index_history")
      ?.quotaGroups.map((quota) => quota.id),
  ).toEqual(["fred_public"]);
});

it("reads source attempts in canonical batch/run envelopes without promoting replay-only reads", async () => {
  const health = await setup({
    run: {
      schemaVersion: "lcx_finance_research_run_v1",
      batch: {
        schemaVersion: "lcx_finance_research_batch_v1",
        jobs: [{ receipt: receipt("gdelt_public_news") }],
      },
    },
    dry: {
      networkCalled: false,
      result: {
        schemaVersion: "lcx_finance_research_batch_v1",
        jobs: [{ receipt: receipt("google_news_rss") }],
      },
    },
  });
  expect(health.routes.find((route) => route.id === "gdelt_public_news")?.callState).toBe(
    "recent_success",
  );
  expect(health.routes.find((route) => route.id === "google_news_rss")?.callState).toBe(
    "unverified",
  );
});
