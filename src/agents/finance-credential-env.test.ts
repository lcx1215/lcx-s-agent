import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveFinanceCredentialEnv } from "./finance-credential-env.js";
import { inspectFinanceSourceHealth } from "./finance-source-health.js";

it("loads only finance credentials, respects explicit overrides, and never mutates process env", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-env-"));
  await fs.mkdir(path.join(dir, "finance-caseflow"));
  await fs.writeFile(
    path.join(dir, "finance-caseflow", "credentials.env"),
    "FMP_API_KEY=stored\nFINNHUB_API_KEY=stored-finn\nOPENAI_API_KEY=unrelated\nLCX_FINANCE_HTTP_PROXY=http://localhost:8080\n",
    { mode: 0o600 },
  );
  const env = { OPENCLAW_STATE_DIR: dir, FINNHUB_API_KEY: "", FRED_API_KEY: "explicit" };
  const result = resolveFinanceCredentialEnv(env);
  expect(result.LCX_FINANCE_HTTP_PROXY).toBe("http://localhost:8080");
  expect(result.FMP_API_KEY).toBe("stored");
  expect(result.FINNHUB_API_KEY).toBe("");
  expect(result.FRED_API_KEY).toBe("explicit");
  expect(result.OPENAI_API_KEY).toBeUndefined();
  expect(env).not.toHaveProperty("FMP_API_KEY");
});

it("distinguishes successful calls, expired evidence, missing configuration and replay", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-health-"));
  const receipts = path.join(dir, "finance-caseflow", "receipts", "run");
  await fs.mkdir(receipts, { recursive: true });
  for (const [id, asOf] of [
    ["binance_public_crypto_ticker", "2026-09-08T10:00:00Z"],
    ["kraken_public_crypto_ticker", "2026-09-01T10:00:00Z"],
  ]) {
    await fs.writeFile(
      path.join(receipts, id + ".json"),
      JSON.stringify({
        schemaVersion: "lcx_finance_market_collection_v1",
        adaptersCalled: true,
        request: { asOf },
        status: "needs_review",
        // A source attempt only counts as evidence once it carries the dispatch time it was
        // actually made at; without one the health inspector cannot tell a fresh call from an
        // unverified route, and reports `unverified` rather than inventing a success.
        sourceAttempts: [
          { adapterId: id, status: "succeeded", apiCalls: [{ dispatchedAt: asOf }] },
        ],
      }),
    );
  }
  const health = await inspectFinanceSourceHealth({
    workspaceDir: dir,
    env: { OPENCLAW_STATE_DIR: dir },
    asOf: "2026-09-08T12:00:00Z",
  });
  expect(
    health.routes
      .filter((r) => r.id.startsWith("fmp_"))
      .every((r) => r.callState === "not_configured_or_disabled"),
  ).toBe(true);
  expect(JSON.stringify(health)).not.toContain("catalog-only");
  expect(health.noNetworkCalled).toBe(true);
  // Use actual registry IDs below; unsupported IDs cannot fabricate source health.
  expect(health.routes.find((r) => r.id === "binance_public_crypto_ticker")?.callState).toBe(
    "recent_success",
  );
  expect(health.routes.find((r) => r.id === "kraken_public_crypto_ticker")?.callState).toBe(
    "verification_expired",
  );
});

it("includes receipts written by the direct collection tool", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-direct-health-"));
  const receiptDir = path.join(dir, "memory", "finance-data-gateway", "collections");
  await fs.mkdir(receiptDir, { recursive: true });
  await fs.writeFile(
    path.join(receiptDir, "live.json"),
    JSON.stringify({
      schemaVersion: "lcx_finance_market_collection_v1",
      adaptersCalled: true,
      request: { asOf: "2026-09-08T10:00:00Z" },
      status: "ready",
      sourceAttempts: [
        {
          adapterId: "binance_public_crypto_ticker",
          status: "succeeded",
          apiCalls: [{ dispatchedAt: "2026-09-08T10:00:00Z" }],
        },
      ],
    }),
  );
  const health = await inspectFinanceSourceHealth({
    workspaceDir: dir,
    env: { OPENCLAW_STATE_DIR: dir },
    asOf: "2026-09-08T12:00:00Z",
  });
  expect(health.routes.find((r) => r.id === "binance_public_crypto_ticker")?.callState).toBe(
    "recent_success",
  );
});
