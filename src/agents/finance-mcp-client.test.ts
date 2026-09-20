import { describe, expect, it } from "vitest";
import { decodeMcpJsonRpc, detectVendorBusinessError } from "./finance-mcp-client.js";

describe("mcp streamable http payload decoding", () => {
  it("decodes a plain JSON-RPC body", () => {
    const message = decodeMcpJsonRpc(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }),
      "application/json",
    );
    expect(message.result?.protocolVersion).toBe("2025-06-18");
  });

  it("decodes the first event of a streamable http SSE body", () => {
    const body = [
      "event: message",
      'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"get_stock_fundamentals"}]}}',
      "",
      'data: {"jsonrpc":"2.0","id":3,"result":{}}',
    ].join("\n");
    const message = decodeMcpJsonRpc(body, "text/event-stream");
    expect((message.result?.tools as Array<{ name: string }>)?.[0]?.name).toBe(
      "get_stock_fundamentals",
    );
  });

  it("rejects an SSE body with no decodable event", () => {
    expect(() => decodeMcpJsonRpc("event: ping\ndata: not-json\n", "text/event-stream")).toThrow(
      /no decodable event/,
    );
  });

  it("rejects a body that is not JSON-RPC at all", () => {
    expect(() => decodeMcpJsonRpc("<html>login</html>", "text/html")).toThrow(/not valid JSON-RPC/);
  });

  it("flags a vendor business error that arrived behind isError false", () => {
    const flagged = detectVendorBusinessError([
      { type: "text", text: '{"code":2003,"message":"Missing X-api-key","data":null}' },
    ]);
    expect(flagged?.code).toBe(2003);
    expect(flagged?.message).toBe("Missing X-api-key");
  });

  it("does not flag an ordinary success payload", () => {
    expect(
      detectVendorBusinessError([{ type: "text", text: '{"code":200,"data":{"close":1680.5}}' }]),
    ).toBeUndefined();
  });

  it("does not flag non-JSON or non-envelope payloads", () => {
    expect(detectVendorBusinessError([{ type: "text", text: "plain text" }])).toBeUndefined();
    expect(detectVendorBusinessError([{ type: "text", text: "[1,2,3]" }])).toBeUndefined();
    expect(detectVendorBusinessError([])).toBeUndefined();
  });

  it("surfaces a JSON-RPC error envelope instead of treating it as success", () => {
    const message = decodeMcpJsonRpc(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "unauthorized" } }),
      "application/json",
    );
    expect(message.error?.message).toBe("unauthorized");
  });
});
