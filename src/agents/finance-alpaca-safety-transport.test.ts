import { expect, it, vi, beforeEach } from "vitest";
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("undici", () => ({ fetch: fetchMock }));
import { createAlpacaSafetyReadTransport } from "./finance-alpaca-safety-transport.js";
beforeEach(() => {
  fetchMock.mockReset();
});
it("fixes GET and rejects redirects", async () => {
  fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
  const read = createAlpacaSafetyReadTransport();
  expect(await read("https://paper-api.alpaca.markets/v2/account", { headers: {} })).toEqual({
    status: 200,
    body: "{}",
  });
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "error" });
});
it.each([
  "https://api.alpaca.markets/v2/account",
  "https://paper-api.alpaca.markets.evil/v2/account",
  "http://paper-api.alpaca.markets/v2/account",
  "https://user@paper-api.alpaca.markets/v2/account",
])("denies host %s", async (url) => {
  await expect(createAlpacaSafetyReadTransport()(url, { headers: {} })).rejects.toThrow(
    "host denied",
  );
  expect(fetchMock).not.toHaveBeenCalled();
});
it("bounds response size", async () => {
  fetchMock.mockResolvedValue(new Response("x".repeat(2 * 1024 * 1024 + 1)));
  await expect(
    createAlpacaSafetyReadTransport()("https://data.alpaca.markets/v2/stocks/SPY/quotes/latest", {
      headers: {},
    }),
  ).rejects.toThrow("too large");
});

it.each(["UND_ERR_CONNECT_TIMEOUT", "ECONNRESET"])(
  "retains safe transport cause %s without retry or leaking request data",
  async (code) => {
    const cause = Object.assign(new Error("private URL and secret must not appear"), { code });
    const original = new TypeError("fetch failed", { cause });
    fetchMock.mockRejectedValue(original);
    const read = createAlpacaSafetyReadTransport();
    const error = await read("https://paper-api.alpaca.markets/v2/account", {
      headers: { "private-token": "must-not-appear" },
    }).catch((failure: unknown) => failure);
    expect(error instanceof Error).toBe(true);
    expect((error as Error).message).toBe(`Alpaca safety GET transport failed: ${code}`);
    expect((error as Error).cause === original).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(1);
  },
);

it.each(["confirmed", "unconfirmed"] as const)(
  "aborts an HTTP 200 stalled account body with cleanup %s",
  async (cleanupStatus) => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() =>
        cleanupStatus === "confirmed" ? Promise.resolve() : new Promise<void>(() => {}),
      );
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { status: 200 });
      fetchMock.mockResolvedValue(response);
      const controller = new AbortController();
      const pending = createAlpacaSafetyReadTransport()(
        "https://paper-api.alpaca.markets/v2/account",
        { headers: {}, signal: controller.signal },
      );
      const check = expect(pending).rejects.toMatchObject({ cleanupStatus });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort(new Error("PRIVATE_ABORT_REASON"));
      await vi.advanceTimersByTimeAsync(1500);
      await check;
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body?.locked).toBe(false);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
    } finally {
      vi.useRealTimers();
    }
  },
);
