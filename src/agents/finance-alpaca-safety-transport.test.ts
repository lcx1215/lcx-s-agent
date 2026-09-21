import { expect, it, vi, beforeEach } from "vitest";
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("undici", () => ({ fetch: fetchMock }));
import { createAlpacaSafetyReadTransport } from "./finance-alpaca-safety-transport.js";
beforeEach(() => fetchMock.mockReset());
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
