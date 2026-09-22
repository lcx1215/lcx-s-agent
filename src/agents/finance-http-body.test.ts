import { describe, expect, it } from "vitest";
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
