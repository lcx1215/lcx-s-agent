import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiCallError,
  createApiCircuitBreaker,
  createApiRateLimiter,
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
  it("does not claim HTTP dispatch or spend the caller budget when quota preparation rejects", async () => {
    const receipts: ApiCallReceipt[] = [];
    const fetch = Object.assign(
      vi.fn<ApiFetch>(async () => response()),
      {
        prepare: async () => {
          throw new ApiCallError("budget_exhausted", undefined, 120_000);
        },
      },
    );
    const beforeHttpDispatch = vi.fn();
    await expect(
      governApiFetch(fetch, { beforeHttpDispatch, onReceipt: (receipt) => receipts.push(receipt) })(
        "https://example.test",
      ),
    ).rejects.toMatchObject({ kind: "budget_exhausted" });
    expect(beforeHttpDispatch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(receipts[0].dispatchedAt).toBeUndefined();
    expect(receipts[0].retryAfterMs).toBe(120_000);
  });
  it("records dispatch only after scheduling and caller budget checks", async () => {
    let prepared = false;
    const receipts: ApiCallReceipt[] = [];
    const dispatch: ApiFetch = async () => response();
    const fetch = Object.assign(dispatch, {
      prepare: async () => {
        prepared = true;
        return dispatch;
      },
    });
    await governApiFetch(fetch, {
      beforeHttpDispatch: () => expect(prepared).toBe(true),
      onReceipt: (receipt) => receipts.push(receipt),
    })("https://example.test");
    expect(Number.isFinite(Date.parse(receipts[0].dispatchedAt ?? ""))).toBe(true);
  });
  it("retains numeric quota headers on rejected requests without leaking arbitrary headers", async () => {
    const receipts: ApiCallReceipt[] = [];
    const fetch: ApiFetch = async () => ({
      ...response(429),
      headers: new Headers({
        "X-RateLimit-Limit": "8",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "1788926000",
        "api-credits-left": "secret-token",
        Authorization: "private-key",
        "X-Unrelated": "42",
      }),
    });
    await expect(
      governApiFetch(fetch, { retry: { attempts: 1 }, onReceipt: (r) => receipts.push(r) })(
        "https://example.test",
      ),
    ).rejects.toMatchObject({ httpStatus: 429 });
    expect(receipts[0].rateLimitHeaders).toEqual({
      "x-ratelimit-limit": 8,
      "x-ratelimit-remaining": 0,
      "x-ratelimit-reset": 1788926000,
    });
    expect(JSON.stringify(receipts)).not.toMatch(/private-key|secret-token|x-unrelated/u);
  });

  it("reserves before every HTTP dispatch including fallback calls", async () => {
    const fetch = vi.fn<ApiFetch>(async () => response());
    let remaining = 1;
    const guarded = governApiFetch(fetch, {
      beforeHttpDispatch: () => {
        if (remaining-- <= 0) {
          throw new ApiCallError("budget_exhausted");
        }
      },
    });
    await guarded("https://example.test/primary");
    await expect(guarded("https://example.test/fallback")).rejects.toMatchObject({
      kind: "budget_exhausted",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
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

  it("classifies forbidden sources without retrying or pretending they are rate limits", async () => {
    const receipts: ApiCallReceipt[] = [];
    const fetch = vi.fn<ApiFetch>().mockResolvedValue(response(403));
    await expect(
      governApiFetch(fetch, { onReceipt: (receipt) => receipts.push(receipt) })(
        "https://example.test",
      ),
    ).rejects.toMatchObject({ kind: "forbidden", httpStatus: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(receipts[0]).toMatchObject({
      status: "failed",
      httpStatus: 403,
      transportError: "forbidden",
      rateLimited: false,
    });
  });

  it("paces repeated calls through a reusable source limiter", async () => {
    vi.useFakeTimers();
    const receipts: ApiCallReceipt[] = [];
    const limiter = createApiRateLimiter({ minIntervalMs: 100, maxConcurrent: 1 });
    const fetch = vi.fn<ApiFetch>().mockResolvedValue(response());
    const governed = governApiFetch(fetch, {
      rateLimiter: limiter,
      onReceipt: (receipt) => receipts.push(receipt),
    });
    await governed("https://example.test");
    const second = governed("https://example.test");
    await vi.advanceTimersByTimeAsync(99);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(receipts[1]).toEqual(expect.objectContaining({ throttleWaitMs: 100 }));
  });

  it("preserves rate_limited when a source limiter queue is full", async () => {
    const limiter = createApiRateLimiter({
      minIntervalMs: 0,
      maxConcurrent: 1,
      maxQueue: 1,
    });
    const heldPermit = await limiter.acquire();
    const receipts: ApiCallReceipt[] = [];
    const fetch = vi.fn<ApiFetch>().mockResolvedValue(response());
    const governed = governApiFetch(fetch, {
      rateLimiter: limiter,
      onReceipt: (receipt) => receipts.push(receipt),
    });
    const queued = governed("https://example.test");
    const rejected = governed("https://example.test");
    await expect(rejected).rejects.toMatchObject({ kind: "rate_limited" });
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ transportError: "rate_limited", status: "failed" }),
      ]),
    );
    heldPermit.release();
    await queued;
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

  it("records idempotency labels and opens an injected circuit after repeated failures", async () => {
    const receipts: ApiCallReceipt[] = [];
    const breaker = createApiCircuitBreaker({ failureThreshold: 2, resetAfterMs: 60_000 });
    const fetch = vi.fn<ApiFetch>().mockResolvedValue(response(503));
    const governed = governApiFetch(fetch, {
      circuitBreaker: breaker,
      idempotencyKey: "research-read-1",
      onReceipt: (receipt) => receipts.push(receipt),
      retry: { attempts: 1 },
    });

    await expect(governed("https://example.test")).rejects.toMatchObject({ httpStatus: 503 });
    await expect(governed("https://example.test")).rejects.toMatchObject({ httpStatus: 503 });
    await expect(governed("https://example.test")).rejects.toMatchObject({
      kind: "circuit_open",
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          idempotencyKey: "research-read-1",
          circuitState: "closed",
        }),
        expect.objectContaining({
          transportError: "circuit_open",
          circuitState: "open",
          idempotencyKey: "research-read-1",
        }),
      ]),
    );
  });

  it.each(["client_error", "cancelled", "local_budget"] as const)(
    "releases a half-open source probe after %s without pretending recovery",
    async (outcome) => {
      vi.useFakeTimers();
      const breaker = createApiCircuitBreaker({ failureThreshold: 1, resetAfterMs: 1000 });
      const fetch = vi
        .fn<ApiFetch>()
        .mockResolvedValueOnce(response(503))
        .mockResolvedValueOnce(response(outcome === "client_error" ? 404 : 200))
        .mockResolvedValue(response());
      const governed = governApiFetch(fetch, { circuitBreaker: breaker, retry: { attempts: 1 } });
      await expect(governed("https://example.test/fault")).rejects.toMatchObject({
        httpStatus: 503,
      });
      await vi.advanceTimersByTimeAsync(1001);
      const controller = new AbortController();
      if (outcome === "cancelled") {
        controller.abort();
      }
      const probe = governApiFetch(fetch, {
        circuitBreaker: breaker,
        retry: { attempts: 1 },
        signal: controller.signal,
        beforeHttpDispatch: () => {
          if (outcome === "local_budget") {
            throw new ApiCallError("budget_exhausted");
          }
        },
      });
      await expect(probe("https://example.test/probe")).rejects.toMatchObject(
        outcome === "client_error"
          ? { httpStatus: 404 }
          : { kind: outcome === "cancelled" ? "cancelled" : "budget_exhausted" },
      );
      // A locally interrupted or request-specific probe supplies no recovery proof.
      expect(breaker.beforeRequest()).toBe("half_open");
      breaker.recordFailure();
      expect(breaker.beforeRequest()).toBe("open");
      await vi.advanceTimersByTimeAsync(1001);
      await expect(governed("https://example.test/recovered")).resolves.toMatchObject({
        status: 200,
      });
      expect(breaker.beforeRequest()).toBe("closed");
      expect(fetch).toHaveBeenCalledTimes(outcome === "client_error" ? 3 : 2);
    },
  );

  it("does not open a source circuit for permanent client HTTP errors", async () => {
    const breaker = createApiCircuitBreaker({ failureThreshold: 1, resetAfterMs: 60_000 });
    const fetch = vi
      .fn<ApiFetch>()
      .mockResolvedValueOnce(response(404))
      .mockResolvedValue(response());
    const governed = governApiFetch(fetch, {
      circuitBreaker: breaker,
      retry: { attempts: 1 },
    });

    await expect(governed("https://example.test/missing")).rejects.toMatchObject({
      kind: "http_error",
      httpStatus: 404,
    });
    await expect(governed("https://example.test/valid")).resolves.toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("safe network diagnosis", () => {
  it.each(["UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "CERT_HAS_EXPIRED"])(
    "keeps %s without leaking transport messages",
    async (code) => {
      const receipts: ApiCallReceipt[] = [];
      const fetch = vi.fn<ApiFetch>().mockRejectedValue(
        new Error("secret transport URL", {
          cause: Object.assign(new Error("secret host"), { code }),
        }),
      );
      await expect(
        governApiFetch(fetch, { retry: { attempts: 1 }, onReceipt: (r) => receipts.push(r) })(
          "https://example.test",
        ),
      ).rejects.toMatchObject({ kind: "network_error", networkCode: code });
      expect(receipts[0].networkCode).toBe(code);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(receipts)).not.toContain("secret");
    },
  );
  it("drops arbitrary error-code strings", async () => {
    const receipts: ApiCallReceipt[] = [];
    const fetch: ApiFetch = async () => {
      throw { code: "secret-api-key" };
    };
    await expect(
      governApiFetch(fetch, { retry: { attempts: 1 }, onReceipt: (r) => receipts.push(r) })(
        "https://example.test",
      ),
    ).rejects.toMatchObject({ kind: "network_error" });
    expect(receipts[0].networkCode).toBeUndefined();
    expect(JSON.stringify(receipts)).not.toContain("secret");
  });
});

it("retries a transient GET reset once within the same budget and records both attempts", async () => {
  const receipts: ApiCallReceipt[] = [];
  const dispatch = vi.fn();
  const fetch = vi
    .fn<ApiFetch>()
    .mockRejectedValueOnce(Object.assign(new Error("private"), { code: "ECONNRESET" }))
    .mockResolvedValueOnce(response());
  await governApiFetch(fetch, {
    retry: { minDelayMs: 1 },
    beforeHttpDispatch: dispatch,
    onReceipt: (r) => receipts.push(r),
  })("https://example.test");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(receipts).toEqual([
    expect.objectContaining({ status: "failed", networkCode: "ECONNRESET", attempt: 1 }),
    expect.objectContaining({ status: "succeeded", attempt: 2 }),
  ]);
});

it("does not retry certificate failures", async () => {
  const fetch = vi
    .fn<ApiFetch>()
    .mockRejectedValue(Object.assign(new Error("private"), { code: "CERT_HAS_EXPIRED" }));
  await expect(governApiFetch(fetch)("https://example.test")).rejects.toMatchObject({
    networkCode: "CERT_HAS_EXPIRED",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("preserves the caller's one-attempt limit when a source sets its own retry delay", async () => {
  const fetch = vi.fn<ApiFetch>().mockResolvedValue(response(429));
  await expect(
    runApiSourceCall(
      { provider: "public", source: "public", operation: "collect", retry: { attempts: 1 } },
      async () => governApiFetch(fetch, { retry: { minDelayMs: 5000 } })("https://example.test"),
    ),
  ).rejects.toMatchObject({ httpStatus: 429 });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(["rate_queue", "preparation", "body", "body_http_503", "body_http_403"] as const)(
  "rejects expired %s work after wall-clock suspension before timer callbacks resume",
  async (stage) => {
    vi.useFakeTimers();
    const receipts: ApiCallReceipt[] = [];
    const start = Date.now();
    const jump = () => vi.setSystemTime(start + 60_000);
    const dispatch = vi.fn<ApiFetch>(async () => ({
      ...response(stage === "body_http_503" ? 503 : stage === "body_http_403" ? 403 : 200),
      text: async () => {
        if (stage.startsWith("body")) {
          jump();
        }
        return "late evidence";
      },
    }));
    const fetch = Object.assign(dispatch, {
      prepare: async () => {
        if (stage === "preparation") {
          jump();
        }
        return dispatch;
      },
    });
    const rateLimiter =
      stage === "rate_queue"
        ? {
            acquire: async () => {
              jump();
              return { waitMs: 60_000, release: () => {} };
            },
          }
        : undefined;
    await expect(
      governApiFetch(fetch, {
        timeoutMs: 1000,
        rateLimiter,
        retry: { attempts: 1 },
        onReceipt: (receipt) => receipts.push(receipt),
      })("https://fixture.test/source"),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(dispatch).toHaveBeenCalledTimes(stage.startsWith("body") ? 1 : 0);
    expect(receipts.some((receipt) => receipt.status === "timed_out")).toBe(true);
  },
);

it.each(["cancelled", "timeout"] as const)(
  "does not invoke prepared HTTP when final budget admission becomes %s",
  async (kind) => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const receipts: ApiCallReceipt[] = [];
    const dispatch = Object.assign(
      vi.fn<ApiFetch>(async () => response()),
      {
        cancelPreparation: vi.fn(async () => {}),
      },
    );
    const fetch = Object.assign(
      vi.fn<ApiFetch>(async () => response()),
      {
        prepare: async () => dispatch,
      },
    );
    await expect(
      governApiFetch(fetch, {
        signal: parent.signal,
        timeoutMs: 1000,
        beforeHttpDispatch: () => {
          if (kind === "cancelled") {
            parent.abort();
          } else {
            vi.setSystemTime(Date.now() + 60_000);
          }
        },
        onReceipt: (receipt) => receipts.push(receipt),
      })("https://fixture.test/source"),
    ).rejects.toMatchObject({ kind });
    expect(dispatch).not.toHaveBeenCalled();
    expect(dispatch.cancelPreparation).toHaveBeenCalledOnce();
    expect(receipts.every((receipt) => receipt.dispatchedAt === undefined)).toBe(true);
  },
);

it("classifies a source rejection after suspended wall time as timeout", async () => {
  vi.useFakeTimers();
  const receipts: ApiCallReceipt[] = [];
  await expect(
    runApiSourceCall(
      {
        provider: "fixture",
        source: "fixture",
        operation: "collect",
        timeoutMs: 1000,
        onReceipt: (receipt) => receipts.push(receipt),
      },
      async () => {
        vi.setSystemTime(Date.now() + 60_000);
        throw new Error("late source failure");
      },
    ),
  ).rejects.toMatchObject({ kind: "timeout" });
  expect(receipts).toMatchObject([{ status: "timed_out", transportError: "timeout" }]);
});

it("does not close a circuit after attempt finalization outlives the total deadline", async () => {
  vi.useFakeTimers();
  const circuit = createApiCircuitBreaker();
  const success = vi.spyOn(circuit, "recordSuccess");
  await expect(
    governApiFetch(async () => response(), {
      timeoutMs: 1000,
      circuitBreaker: circuit,
      onReceipt: (receipt) => {
        if (receipt.operation === "http_get" && receipt.status === "succeeded") {
          vi.setSystemTime(Date.now() + 60_000);
        }
      },
    })("https://fixture.test/source"),
  ).rejects.toMatchObject({ kind: "timeout" });
  expect(success).not.toHaveBeenCalled();
});

it("rejects a direct source return after its receipt observer outlives the deadline", async () => {
  vi.useFakeTimers();
  const receipts: ApiCallReceipt[] = [];
  await expect(
    runApiSourceCall(
      {
        provider: "fixture",
        source: "fixture",
        operation: "collect",
        timeoutMs: 1000,
        onReceipt: (receipt) => {
          receipts.push(receipt);
          vi.setSystemTime(Date.now() + 60_000);
        },
      },
      async () => "source result",
    ),
  ).rejects.toMatchObject({ kind: "timeout" });
  // Receipt notification happens after source completion; it is not emitted twice.
  expect(receipts).toMatchObject([{ status: "succeeded" }]);
});

it("classifies a failed source whose receipt notification crosses the deadline as timeout", async () => {
  vi.useFakeTimers();
  const receipts: ApiCallReceipt[] = [];
  await expect(
    runApiSourceCall(
      {
        provider: "fixture",
        source: "fixture",
        operation: "collect",
        timeoutMs: 1000,
        onReceipt: (receipt) => {
          receipts.push(receipt);
          vi.setSystemTime(Date.now() + 60_000);
        },
      },
      async () => {
        throw new Error("source unavailable");
      },
    ),
  ).rejects.toMatchObject({ kind: "timeout" });
  expect(receipts).toMatchObject([{ status: "failed" }]);
});

it.each([
  ["timeout", "http"],
  ["timeout", "network"],
  ["cancelled", "http"],
  ["cancelled", "network"],
] as const)(
  "reopens a failed half-open probe when retry backoff ends with %s after %s",
  async (mode, failure) => {
    vi.useFakeTimers();
    const breaker = createApiCircuitBreaker({ failureThreshold: 1, resetAfterMs: 100 });
    breaker.recordFailure();
    await vi.advanceTimersByTimeAsync(101);
    const caller = new AbortController();
    const fetch = vi.fn<ApiFetch>(async () => {
      if (failure === "network") {
        throw Object.assign(new Error("fixture connection reset"), { code: "ECONNRESET" });
      }
      return response(503);
    });
    const pending = governApiFetch(fetch, {
      circuitBreaker: breaker,
      signal: caller.signal,
      timeoutMs: mode === "timeout" ? 200 : 5000,
      retry: { attempts: 2, minDelayMs: 1000, maxDelayMs: 1000 },
    })("https://fixture.test/probe").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    if (mode === "cancelled") {
      caller.abort();
    } else {
      await vi.advanceTimersByTimeAsync(201);
    }
    expect(await pending).toMatchObject({ kind: mode });
    expect(breaker.beforeRequest()).toBe("open");
  },
);
