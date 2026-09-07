import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiCallError,
  governApiFetch,
  parseApiRetryAfter,
  runApiSourceCall,
  type ApiCallReceipt,
  type ApiFetch,
} from "./api-call-contract.js";
import { resolveFinanceFetch } from "./finance-live-market-source.js";

const response = (status = 200, retryAfter?: string) => ({
  ok: status === 200,
  status,
  headers: new Headers(retryAfter ? { "Retry-After": retryAfter } : {}),
  text: async () => "payload",
});
afterEach(() => vi.useRealTimers());

describe("API call governance", () => {
  it("records successful body completion and preserves old header-less fake fetch", async () => {
    const receipts: ApiCallReceipt[] = [];
    const fetch: ApiFetch = async () => ({ ok: true, status: 200, text: async () => "legacy" });
    const result = await governApiFetch(fetch, { onReceipt: (r) => receipts.push(r) })(
      "https://example.test",
    );
    expect(await result.text()).toBe("legacy");
    expect(receipts).toEqual([
      expect.objectContaining({
        schemaVersion: "lcx_api_call_v1",
        callId: expect.any(String),
        correlationId: expect.any(String),
        operation: "http_get",
        status: "succeeded",
        httpStatus: 200,
        attempt: 1,
        startedAt: expect.any(String),
        finishedAt: expect.any(String),
        latencyMs: expect.any(Number),
        authScopeLabel: "unspecified",
      }),
    ]);
  });

  it("aborts an in-flight body and records timeout, even with HTTP 200", async () => {
    vi.useFakeTimers();
    const receipts: ApiCallReceipt[] = [];
    let signal: AbortSignal | undefined;
    const fetch: ApiFetch = async (_url, init) => {
      signal = init?.signal;
      return { ...response(), text: () => new Promise(() => {}) };
    };
    const result = governApiFetch(fetch, { timeoutMs: 20, onReceipt: (r) => receipts.push(r) })(
      "https://example.test",
    );
    const rejection = expect(result).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(receipts).toEqual([
      expect.objectContaining({ status: "timed_out", httpStatus: 200, transportError: "timeout" }),
    ]);
  });

  it("does not start work when already cancelled and never stores the abort reason", async () => {
    const fetch = vi.fn<ApiFetch>();
    const receipts: ApiCallReceipt[] = [];
    const result = runApiSourceCall(
      {
        provider: "test",
        source: "test",
        operation: "collect",
        signal: AbortSignal.abort("secret"),
        onReceipt: (r) => receipts.push(r),
      },
      () => governApiFetch(fetch)("https://example.test"),
    );
    await expect(result).rejects.toMatchObject({ kind: "cancelled" });
    expect(fetch).not.toHaveBeenCalled();
    expect(receipts[0].status).toBe("cancelled");
    expect(JSON.stringify(receipts)).not.toContain("secret");
  });

  it("retries 429 after the server delay and records each attempt", async () => {
    vi.useFakeTimers();
    const receipts: ApiCallReceipt[] = [];
    const fetch = vi
      .fn<ApiFetch>()
      .mockResolvedValueOnce(response(429, "1"))
      .mockResolvedValue(response());
    const result = governApiFetch(fetch, {
      onReceipt: (r) => receipts.push(r),
      retry: { minDelayMs: 0 },
    })("https://example.test");
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(receipts).toEqual([
      expect.objectContaining({
        status: "failed",
        httpStatus: 429,
        retryAfterMs: 1000,
        rateLimited: true,
        attempt: 1,
      }),
      expect.objectContaining({ status: "succeeded", attempt: 2 }),
    ]);
    expect(receipts[0].callId).not.toBe(receipts[1].callId);
    expect(receipts[0].correlationId).toBe(receipts[1].correlationId);
  });

  it.each([400, 401, 403, 404, 422])("does not retry HTTP %s", async (status) => {
    const fetch = vi.fn<ApiFetch>().mockResolvedValue(response(status));
    await expect(governApiFetch(fetch)("https://example.test")).rejects.toMatchObject({
      httpStatus: status,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not shorten Retry-After to a configured retry cap", async () => {
    const fetch = vi.fn<ApiFetch>().mockResolvedValue(response(429, "120"));
    await expect(
      governApiFetch(fetch, { retry: { maxDelayMs: 10 } })("https://example.test"),
    ).rejects.toMatchObject({ retryAfterMs: 120000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels during backoff without a later HTTP attempt", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetch = vi.fn<ApiFetch>().mockResolvedValue(response(429, "1"));
    const result = governApiFetch(fetch, { signal: controller.signal })("https://example.test");
    const rejection = expect(result).rejects.toMatchObject({ kind: "cancelled" });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await rejection;
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("isolates concurrent source contexts for a fetch resolved before collect", async () => {
    const receipts: ApiCallReceipt[] = [];
    const signals: AbortSignal[] = [];
    const fetch = resolveFinanceFetch(async (_url, init) => {
      signals.push(init!.signal!);
      return response();
    });
    await Promise.all(
      ["alpha", "beta"].map((source) =>
        runApiSourceCall(
          {
            provider: source,
            source,
            operation: "collect",
            correlationId: source,
            onReceipt: (r) => receipts.push(r),
          },
          () => fetch("https://example.test"),
        ),
      ),
    );
    expect(signals[0]).not.toBe(signals[1]);
    for (const source of ["alpha", "beta"]) {
      expect(receipts.filter((r) => r.source === source).map((r) => r.operation)).toEqual([
        "http_get",
        "collect",
      ]);
      expect(
        receipts.filter((r) => r.source === source).every((r) => r.correlationId === source),
      ).toBe(true);
    }
  });

  it("does not leak URLs, headers or thrown transport secrets", async () => {
    const receipts: ApiCallReceipt[] = [];
    const secret = "private-test-token";
    const fetch: ApiFetch = async () => {
      throw new Error(`URL contains ${secret}`);
    };
    const result = governApiFetch(fetch, {
      authScopeLabel: "configured_read_only",
      onReceipt: (r) => receipts.push(r),
    })(`https://example.test?key=${secret}`, { headers: { Authorization: secret } });
    await expect(result).rejects.toEqual(new ApiCallError("network_error"));
    expect(JSON.stringify(receipts)).not.toContain(secret);
    expect(receipts[0]).toMatchObject({
      authScopeLabel: "configured_read_only",
      transportError: "network_error",
    });
  });

  it("emits a receipt for standalone cancellation before dispatch", async () => {
    const receipts: ApiCallReceipt[] = [];
    const fetch = vi.fn<ApiFetch>();
    await expect(
      governApiFetch(fetch, { signal: AbortSignal.abort(), onReceipt: (r) => receipts.push(r) })(
        "https://example.test",
      ),
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(fetch).not.toHaveBeenCalled();
    expect(receipts).toEqual([
      expect.objectContaining({ operation: "http_get_total", status: "cancelled" }),
    ]);
  });

  it("records even falsy source failures and isolates a throwing receipt observer", async () => {
    const receipts: ApiCallReceipt[] = [];
    await expect(
      runApiSourceCall(
        {
          provider: "test",
          source: "test",
          operation: "collect",
          onReceipt: (r) => receipts.push(r),
        },
        async () => {
          throw undefined;
        },
      ),
    ).rejects.toBeUndefined();
    expect(receipts[0]).toMatchObject({ status: "failed", transportError: "source_error" });
    await expect(
      governApiFetch(async () => response(), {
        onReceipt: () => {
          throw new Error("observer");
        },
      })("https://example.test"),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("parses Retry-After dates and ignores malformed values", () => {
    expect(
      parseApiRetryAfter("Wed, 09 Sep 2026 00:00:01 GMT", Date.parse("2026-09-09T00:00:00Z")),
    ).toBe(1000);
    expect(parseApiRetryAfter("not-a-date")).toBeUndefined();
    expect(parseApiRetryAfter(" ")).toBeUndefined();
  });
});
