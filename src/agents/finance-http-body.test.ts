import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FINANCE_HTTP_BODY_MAX_BYTES,
  readBoundedFinanceResponseText,
} from "./finance-http-body.js";

describe("bounded finance HTTP response body", () => {
  it("reads a response at the exact byte boundary", async () => {
    const response = new Response("€x", { headers: { "content-length": "4" } });
    await expect(readBoundedFinanceResponseText(response, { maxBytes: 4 })).resolves.toBe("€x");
  });

  it("rejects a declared oversized body before consuming the stream", async () => {
    const response = {
      headers: new Headers({ "content-length": "9" }),
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }),
    };
    await expect(readBoundedFinanceResponseText(response, { maxBytes: 8 })).rejects.toThrow(
      "response too large",
    );
  });

  it("rejects chunked overflow when content-length is absent", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(5));
          controller.enqueue(new Uint8Array(4));
          controller.close();
        },
      }),
    );
    await expect(readBoundedFinanceResponseText(response, { maxBytes: 8 })).rejects.toThrow(
      "response too large",
    );
  });

  it("keeps the shared default finite", () => {
    expect(DEFAULT_FINANCE_HTTP_BODY_MAX_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe("finance body cancellation after response headers", () => {
  it("cancels a stalled body and confirms releasing the read lock", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const controller = new AbortController();
    const read = readBoundedFinanceResponseText(response, { signal: controller.signal });
    controller.abort(new Error("cycle deadline"));
    await expect(read).rejects.toMatchObject({ cleanupStatus: "confirmed" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("does not claim cleanup when cancellation never settles", async () => {
    vi.useFakeTimers();
    try {
      const response = new Response(
        new ReadableStream<Uint8Array>({ cancel: () => new Promise(() => {}) }),
      );
      const controller = new AbortController();
      const read = readBoundedFinanceResponseText(response, { signal: controller.signal });
      const check = expect(read).rejects.toMatchObject({ cleanupStatus: "unconfirmed" });
      controller.abort(new Error("cycle deadline"));
      await vi.advanceTimersByTimeAsync(1500);
      await check;
    } finally {
      vi.useRealTimers();
    }
  });
});
