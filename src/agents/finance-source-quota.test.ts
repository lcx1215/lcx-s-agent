import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiCallError,
  governApiFetch,
  type ApiCallReceipt,
  type ApiFetch,
} from "./api-call-contract.js";
import {
  classifyFinanceQuotaBody,
  type FinanceQuotaPolicy,
} from "./finance-source-quota-policy.js";
import { createFinanceQuotaGuard } from "./finance-source-quota.js";
import { financeQuotaProbesDir, financeQuotaStateDir } from "./finance-state-dir.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const day = 86_400_000;
const policy: FinanceQuotaPolicy = {
  id: "test",
  provider: "test",
  hosts: ["example.test"],
  minIntervalMs: 0,
  windows: [{ limit: 2, durationMs: day }],
  basis: "conservative_unknown",
};
const response = (status = 200, body = "{}", headers: Record<string, string> = {}) => ({
  status,
  ok: status === 200,
  headers: new Headers(headers),
  text: async () => body,
});
async function setup(overrides: Partial<FinanceQuotaPolicy> = {}, initialTime = Date.now()) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-quota-"));
  roots.push(stateDir);
  let time = initialTime;
  const options = { stateDir, policies: [{ ...policy, ...overrides }], now: () => time };
  return {
    stateDir,
    guard: () => createFinanceQuotaGuard(options),
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("shared finance provider quotas", () => {
  it("honors Bybit's ten-minute IP-block cooldown without mislabeling it as success", async () => {
    const fixture = await setup({ id: "bybit", provider: "bybit", windows: [] });
    const native = vi.fn<ApiFetch>(async () => response(403));
    const result = await fixture.guard().wrap(native)("https://example.test/ticker");
    expect(result.status).toBe(403);
    fixture.advance(60_000);
    await expect(fixture.guard().wrap(native)("https://example.test/ticker")).rejects.toMatchObject(
      { kind: "budget_exhausted", retryAfterMs: 540_000 },
    );
    expect(native).toHaveBeenCalledTimes(1);
  });
  it("refunds provider reservations when the task HTTP budget rejects dispatch", async () => {
    const fixture = await setup({
      minIntervalMs: 30_000,
      windows: [{ limit: 1, durationMs: day }],
    });
    const native = vi.fn<ApiFetch>(async () => response());
    const guarded = governApiFetch(fixture.guard().wrap(native), {
      beforeHttpDispatch: () => {
        throw new ApiCallError("budget_exhausted");
      },
    });
    await expect(guarded("https://example.test/quote")).rejects.toMatchObject({
      kind: "budget_exhausted",
    });
    await expect(guarded("https://example.test/quote")).rejects.toMatchObject({
      kind: "budget_exhausted",
    });
    expect(native).not.toHaveBeenCalled();
    await fixture.guard().wrap(native)("https://example.test/quote");
    expect(native).toHaveBeenCalledTimes(1);
  });
  it("refunds a prepared request cancelled before native dispatch", async () => {
    const fixture = await setup({
      minIntervalMs: 30_000,
      windows: [{ limit: 1, durationMs: day }],
    });
    const native = vi.fn<ApiFetch>(async () => response());
    const controller = new AbortController();
    const prepared = await fixture
      .guard()
      .wrap(native)
      .prepare("https://example.test/quote", { signal: controller.signal });
    controller.abort();
    await expect(prepared("https://example.test/quote")).rejects.toBeDefined();
    await fixture.guard().wrap(native)("https://example.test/quote");
    expect(native).toHaveBeenCalledTimes(1);
  });
  it("shares one ceiling across separate Node processes", async () => {
    const fixture = await setup();
    const moduleUrl = pathToFileURL(path.resolve("src/agents/finance-source-quota.ts")).href;
    const code = `
      import { createFinanceQuotaGuard } from ${JSON.stringify(moduleUrl)};
      let dispatched = 0;
      const fetch = createFinanceQuotaGuard({ stateDir: ${JSON.stringify(fixture.stateDir)}, policies: [${JSON.stringify(policy)}] }).wrap(async () => {
        dispatched++; return { ok: true, status: 200, text: async () => '{}' };
      });
      for (let i = 0; i < 2; i++) { try { await fetch('https://example.test/quote'); } catch {} }
      console.log(dispatched);
    `;
    const runs = await Promise.all(
      [1, 2].map(() =>
        promisify(execFile)(process.execPath, [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          code,
        ]),
      ),
    );
    expect(runs.reduce((sum, result) => sum + Number(result.stdout.trim()), 0)).toBe(2);
  });
  it("resets a UTC daily window at midnight without waiting another 24 hours", async () => {
    const fixture = await setup(
      { windows: [{ limit: 1, durationMs: day, alignment: "utc_day" }] },
      Date.parse("2026-09-09T23:59:59Z"),
    );
    const native = vi.fn<ApiFetch>(async () => response());
    await fixture.guard().wrap(native)("https://example.test/quote");
    await expect(fixture.guard().wrap(native)("https://example.test/quote")).rejects.toMatchObject({
      kind: "budget_exhausted",
    });
    fixture.advance(1_001);
    await fixture.guard().wrap(native)("https://example.test/quote");
    expect(native).toHaveBeenCalledTimes(2);
  });
  it("replenishes a token bucket instead of interpreting its full-refill header as a blackout", async () => {
    const fixture = await setup(
      { windows: [], tokenBucket: { capacity: 1, refillPerSecond: 1 } },
      1_000_000,
    );
    const native = vi.fn<ApiFetch>(async () =>
      response(200, "{}", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1060" }),
    );
    await fixture.guard().wrap(native)("https://example.test/quote");
    fixture.advance(1_001);
    await fixture.guard().wrap(native)("https://example.test/quote");
    expect(native).toHaveBeenCalledTimes(2);
  });
  it("uses a lower server balance even when local usage is small", async () => {
    const fixture = await setup({ windows: [{ limit: 100, durationMs: day }] }, 1_000_000);
    const native = vi.fn<ApiFetch>(async () =>
      response(200, "{}", { "x-ratelimit-remaining": "1", "x-ratelimit-reset": "1060" }),
    );
    await fixture.guard().wrap(native)("https://example.test/quote");
    await fixture.guard().wrap(native)("https://example.test/history");
    await expect(fixture.guard().wrap(native)("https://example.test/news")).rejects.toMatchObject({
      kind: "budget_exhausted",
    });
    expect(native).toHaveBeenCalledTimes(2);
  });
  it("shares a daily ceiling across routes and guard instances, then expires it", async () => {
    const fixture = await setup();
    const native = vi.fn<ApiFetch>(async () => response());
    await fixture.guard().wrap(native)("https://example.test/quote");
    await fixture.guard().wrap(native)("https://example.test/history");
    await expect(fixture.guard().wrap(native)("https://example.test/news")).rejects.toMatchObject({
      kind: "budget_exhausted",
    });
    expect(native).toHaveBeenCalledTimes(2);
    fixture.advance(day + 1);
    await fixture.guard().wrap(native)("https://example.test/quote");
    expect(native).toHaveBeenCalledTimes(3);
  });
  it("reserves atomically before concurrent dispatches", async () => {
    const fixture = await setup();
    const native = vi.fn<ApiFetch>(async () => response());
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => fixture.guard().wrap(native)("https://example.test/quote")),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(native).toHaveBeenCalledTimes(2);
  });
  it("cancels a paced request without dispatching it", async () => {
    const fixture = await setup({ minIntervalMs: 30_000, windows: [] });
    const native = vi.fn<ApiFetch>(async () => response());
    await fixture.guard().wrap(native)("https://example.test/quote");
    const controller = new AbortController();
    const pending = fixture.guard().wrap(native)("https://example.test/history", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(native).toHaveBeenCalledTimes(1);
  });
  it("persists Retry-After and stops future processes from retrying 429", async () => {
    const fixture = await setup({ windows: [] });
    const native = vi.fn<ApiFetch>(async () => response(429, "{}", { "retry-after": "120" }));
    await fixture.guard().wrap(native)("https://example.test/quote");
    fixture.advance(60_000);
    await expect(fixture.guard().wrap(native)("https://example.test/quote")).rejects.toMatchObject({
      kind: "budget_exhausted",
      retryAfterMs: 60_000,
    });
    expect(native).toHaveBeenCalledTimes(1);
  });
  it("classifies HTTP 200 quota errors and never retries them as successful data", async () => {
    const fixture = await setup({ windows: [] });
    const native = vi.fn<ApiFetch>(async () =>
      response(200, JSON.stringify({ Information: "Our API rate limit is 25 requests per day." })),
    );
    const receipts: ApiCallReceipt[] = [];
    const fetch = governApiFetch(fixture.guard().wrap(native), {
      retry: { attempts: 2 },
      onReceipt: (receipt) => receipts.push(receipt),
    });
    await expect(fetch("https://example.test/quote")).rejects.toMatchObject({
      kind: "rate_limited",
      httpStatus: 200,
    });
    expect(receipts[0]).toMatchObject({ rateLimited: true, httpStatus: 200, status: "failed" });
    await expect(fetch("https://example.test/quote")).rejects.toMatchObject({
      kind: "budget_exhausted",
    });
    expect(native).toHaveBeenCalledTimes(1);
  });
  it("does not reset an unreadable ledger and silently grant a fresh quota", async () => {
    const fixture = await setup();
    const directory = financeQuotaStateDir(fixture.stateDir);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "test.json"), "broken");
    const native = vi.fn<ApiFetch>(async () => response());
    await expect(fixture.guard().wrap(native)("https://example.test/quote")).rejects.toMatchObject({
      kind: "budget_exhausted",
    });
    expect(native).not.toHaveBeenCalled();
  });
  it("respects server remaining zero even before the local counter fills", async () => {
    const fixture = await setup({}, 1_000_000);
    const native = vi.fn<ApiFetch>(async () =>
      response(200, "{}", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1060" }),
    );
    await fixture.guard().wrap(native)("https://example.test/quote");
    await expect(fixture.guard().wrap(native)("https://example.test/quote")).rejects.toMatchObject({
      kind: "budget_exhausted",
      retryAfterMs: 60_001,
    });
    expect(native).toHaveBeenCalledTimes(1);
  });
  it("imports recent live probe usage instead of resetting consumed quota", async () => {
    const fixture = await setup({}, 1_000_000);
    const directory = financeQuotaProbesDir(fixture.stateDir);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "run-test.json"),
      JSON.stringify({
        schemaVersion: "lcx_finance_quota_probe_v1",
        provider: "test",
        observations: [
          {
            calls: [1, 2].map((id) => ({
              operation: "http_get",
              callId: String(id),
              startedAt: new Date(999_000).toISOString(),
            })),
          },
        ],
      }),
    );
    const native = vi.fn<ApiFetch>(async () => response());
    await expect(fixture.guard().wrap(native)("https://example.test/quote")).rejects.toMatchObject({
      kind: "budget_exhausted",
    });
    expect(native).not.toHaveBeenCalled();
  });
  it("imports a newly completed probe into an already existing ledger exactly once", async () => {
    const fixture = await setup({}, 1_000_000);
    const native = vi.fn<ApiFetch>(async () => response());
    await fixture.guard().wrap(native)("https://example.test/quote");
    const directory = financeQuotaProbesDir(fixture.stateDir);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "later-test.json"),
      JSON.stringify({
        schemaVersion: "lcx_finance_quota_probe_v1",
        provider: "test",
        observations: [
          {
            calls: [
              {
                operation: "http_get",
                callId: "late-probe",
                startedAt: new Date(1_000_000).toISOString(),
              },
            ],
          },
        ],
      }),
    );
    await expect(fixture.guard().wrap(native)("https://example.test/quote")).rejects.toMatchObject({
      kind: "budget_exhausted",
    });
    const snapshot = await fixture.guard().inspect();
    expect(snapshot[0].windows[0].locallyCountedUsage).toBe(2);
    expect(native).toHaveBeenCalledTimes(1);
  });
  it("charges Twelve Data per requested symbol and rejects unknown weighted endpoints", async () => {
    const fixture = await setup({ id: "twelve_data", provider: "twelve_data" });
    const native = vi.fn<ApiFetch>(async () => response());
    await fixture.guard().wrap(native)("https://example.test/quote?symbol=AAPL,MSFT");
    await expect(
      fixture.guard().wrap(native)("https://example.test/quote?symbol=NVDA"),
    ).rejects.toMatchObject({ kind: "budget_exhausted" });
    await expect(
      fixture.guard().wrap(native)("https://example.test/income_statement?symbol=AAPL"),
    ).rejects.toMatchObject({ kind: "budget_exhausted" });
    expect(native).toHaveBeenCalledTimes(1);
  });
  it("distinguishes error envelopes from articles discussing rate limits", () => {
    expect(
      classifyFinanceQuotaBody(
        JSON.stringify({ articles: [{ title: "API rate limit exceeded" }] }),
      ),
    ).toBeUndefined();
    expect(
      classifyFinanceQuotaBody(
        JSON.stringify({
          message: ["Request could not be serviced, as the daily threshold has been reached."],
        }),
      ),
    ).toBe("daily");
    expect(
      classifyFinanceQuotaBody(JSON.stringify({ code: "50011", msg: "Requests too frequent" })),
    ).toBe("rate");
    expect(classifyFinanceQuotaBody("not JSON")).toBeUndefined();
  });
});

it("reports the same local eligibility time that a rolling daily window enforces", async () => {
  const time = Date.parse("2026-09-09T00:00:00Z");
  const fixture = await setup({ windows: [{ limit: 1, durationMs: day }] }, time);
  await fixture.guard().wrap(async () => response())("https://example.test/quote");
  const [quota] = await fixture.guard().inspect();
  expect(quota).toMatchObject({
    state: "quota_exhausted",
    nextAllowedAt: new Date(time + day + 1).toISOString(),
  });
  fixture.advance(day + 1);
  expect((await fixture.guard().inspect())[0].state).toBe("within_local_budget");
});

/**
 * A degenerate policy should fail at construction, not hang at call time.
 *
 * Measured: `tokenBucket.refillPerSecond: 0` made the wait `Infinity` (a bucket that never refills
 * can never admit a call it has already spent), and a non-finite `minIntervalMs` / window value
 * turned the pacing arithmetic into `NaN`. Validating once at construction turns both into a
 * readable configuration error.
 */
describe("a degenerate policy fails at construction", () => {
  it("refuses a token bucket that can never refill", async () => {
    const fixture = await setup({ tokenBucket: { capacity: 1, refillPerSecond: 0 } });
    expect(() => fixture.guard()).toThrow(/refillPerSecond must be a positive number/);
  });

  it("refuses non-finite pacing and limit values", async () => {
    for (const overrides of [
      { minIntervalMs: Number.NaN },
      { windows: [{ limit: Number.NaN, durationMs: day }] },
      { windows: [{ limit: 2, durationMs: 0 }] },
      { windows: [{ limit: 2, durationMs: -day }] },
    ]) {
      const fixture = await setup(overrides);
      expect(() => fixture.guard()).toThrow(/is unusable/);
    }
  });

  it("still allows a policy with no windows, governed by the cooldown alone", async () => {
    // The Bybit cooldown case. An earlier version of the guard required a window or a bucket and
    // broke this, so it is pinned here rather than left to anyone reading the type.
    const fixture = await setup({ windows: [] });
    expect(() => fixture.guard()).not.toThrow();
  });
});
