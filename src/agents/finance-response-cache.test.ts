import { describe, expect, it, vi } from "vitest";
import {
  ApiCallError,
  createApiCircuitBreaker,
  governApiFetch,
  type ApiCallReceipt,
  type ApiFetch,
} from "./api-call-contract.js";
import { createFinanceResponseCache } from "./finance-response-cache.js";

const url = "https://api.massive.com/quote?symbol=AAPL&apiKey=test-secret";
const response = (body = '{"price":100}', status = 200) => ({
  ok: status === 200,
  status,
  text: async () => body,
});

describe("finance response reuse before HTTP quota", () => {
  it("coalesces concurrent adapter reads into one dispatch and retains independent receipts", async () => {
    const cache = createFinanceResponseCache();
    const raw = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return response();
    });
    const reserve = vi.fn();
    const receipts: ApiCallReceipt[] = [];
    const read = () =>
      governApiFetch(cache.wrap(raw), {
        beforeHttpDispatch: reserve,
        onReceipt: (r) => receipts.push(r),
      })(url);
    await Promise.all(Array.from({ length: 8 }, read));
    expect(raw).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(receipts.filter((r) => r.dispatchedAt)).toHaveLength(1);
    expect(receipts.filter((r) => r.dataAccess?.kind === "cache")).toHaveLength(7);
    expect(new Set(receipts.map((r) => r.callId)).size).toBe(8);
    expect(JSON.stringify(receipts)).not.toContain("test-secret");
    expect(cache.inspect().inFlight).toBe(0);
  });

  it("reuses data without reserving provider quota or healing an open network circuit", async () => {
    const cache = createFinanceResponseCache();
    const raw: ApiFetch = vi.fn(async () => response());
    raw.prepare = vi.fn(async () => raw);
    const breaker = createApiCircuitBreaker({ failureThreshold: 1 });
    const read = governApiFetch(cache.wrap(raw), { circuitBreaker: breaker });
    await read(url);
    breaker.recordFailure();
    expect((await read(url)).dataAccess?.kind).toBe("cache");
    expect(raw.prepare).toHaveBeenCalledTimes(1);
    expect(breaker.beforeRequest()).toBe("open");
  });

  it("expires reads, honors strict freshness and isolates query, account and decoder", async () => {
    let now = Date.now();
    const cache = createFinanceResponseCache({ now: () => now });
    const raw = vi.fn(async () => response());
    const read = governApiFetch(cache.wrap(raw));
    await read(url);
    now += 100;
    expect((await read(url)).dataAccess?.ageMs).toBe(100);
    await governApiFetch(cache.wrap(raw), { cacheMaxAgeMs: 50 })(url);
    await read(url + "&range=1y");
    await read(url, { headers: { Authorization: "different-account" } });
    await governApiFetch(cache.wrap(raw, "gzip"))(url);
    now += 5_001;
    await read(url);
    expect(raw).toHaveBeenCalledTimes(6);
    await governApiFetch(cache.wrap(raw), { cacheMaxAgeMs: 0 })(url);
    expect(raw).toHaveBeenCalledTimes(7);
  });

  it("cancels a waiting duplicate without cancelling the owner or consuming HTTP budget", async () => {
    const cache = createFinanceResponseCache();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const raw = vi.fn(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return response();
    });
    const first = governApiFetch(cache.wrap(raw))(url);
    await started;
    const controller = new AbortController();
    const reserve = vi.fn();
    const second = governApiFetch(cache.wrap(raw), {
      signal: controller.signal,
      beforeHttpDispatch: reserve,
    })(url);
    controller.abort();
    await expect(second).rejects.toMatchObject({ kind: "cancelled" });
    release();
    await first;
    expect(reserve).not.toHaveBeenCalled();
    expect(raw).toHaveBeenCalledTimes(1);
    expect(cache.inspect().inFlight).toBe(0);
  });

  it("releases duplicate waiters and provider reservations when task budget rejects dispatch", async () => {
    const cache = createFinanceResponseCache();
    const refund = vi.fn(async () => {});
    const raw: ApiFetch = vi.fn(async () => response());
    raw.prepare = async () => Object.assign(async () => response(), { cancelPreparation: refund });
    await expect(
      governApiFetch(cache.wrap(raw), {
        beforeHttpDispatch: () => {
          throw new ApiCallError("budget_exhausted");
        },
      })(url),
    ).rejects.toMatchObject({ kind: "budget_exhausted" });
    expect(refund).toHaveBeenCalledTimes(1);
    expect(cache.inspect().inFlight).toBe(0);
    await expect(governApiFetch(cache.wrap(raw))(url)).resolves.toMatchObject({ status: 200 });
  });

  it.each([
    '{"Information":"daily quota"}',
    '{"error":"bad request"}',
    '{"status":"error"}',
    "<!doctype html>captcha",
    "{invalid",
  ])("never reuses errors or access pages: %s", async (body) => {
    const cache = createFinanceResponseCache();
    const raw = vi.fn(async () => response(body));
    const read = governApiFetch(cache.wrap(raw));
    await read(url);
    await read(url);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it("does not return expired data when refresh fails and bounds retained memory", async () => {
    let now = Date.now();
    const cache = createFinanceResponseCache({ maxEntries: 1, maxBytes: 100, now: () => now });
    const raw = vi.fn(async () => response());
    const read = governApiFetch(cache.wrap(raw), { retry: { attempts: 1 } });
    await read(url);
    await read(url + "&symbol2=B");
    expect(cache.inspect().entries).toBe(1);
    now += 5_001;
    raw.mockResolvedValueOnce(response("unavailable", 503));
    await expect(read(url + "&symbol2=B")).rejects.toMatchObject({ httpStatus: 503 });
    expect(cache.inspect().entries).toBe(0);
  });
});

it("obeys server max-age and never waits for quota when an uncached circuit is already open", async () => {
  let time = Date.now();
  const cache = createFinanceResponseCache({ now: () => time });
  const raw: ApiFetch = vi.fn(async () => ({
    ...response(),
    headers: new Headers({ "cache-control": "max-age=1" }),
  }));
  raw.prepare = vi.fn(async () => raw);
  const breaker = createApiCircuitBreaker({ failureThreshold: 1 });
  const read = governApiFetch(cache.wrap(raw), { circuitBreaker: breaker });
  await read(url);
  time += 1_001;
  breaker.recordFailure();
  await expect(read(url)).rejects.toMatchObject({ kind: "circuit_open" });
  expect(raw.prepare).toHaveBeenCalledTimes(1);
  expect(cache.inspect().inFlight).toBe(0);
});
