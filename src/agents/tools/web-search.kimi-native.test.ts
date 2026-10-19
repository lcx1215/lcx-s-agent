import { beforeEach, expect, it, vi } from "vitest";
const { endpoint } = vi.hoisted(() => ({ endpoint: vi.fn() }));
vi.mock("./web-guarded-fetch.js", () => ({ withTrustedWebToolsEndpoint: endpoint }));
import { __testing } from "./web-search.js";
const params = {
  query: "public docs",
  apiKey: "FAKE",
  baseUrl: "https://example.invalid/v1",
  model: "configured-model",
  timeoutSeconds: 5,
  proxyUrl: undefined,
};
beforeEach(() => {
  endpoint.mockReset();
});
it("round-trips the native singular search_result unchanged rather than fabricating empty search_results", async () => {
  const native = JSON.stringify({
    search_result: [{ url: "https://example.com/docs", title: "Docs" }],
    usage: { search_count: 1 },
  });
  const requests: Array<{
    messages: Array<{ role: string; content?: string; tool_call_id?: string }>;
  }> = [];
  endpoint.mockImplementation(async (options, run) => {
    requests.push(JSON.parse(options.init.body));
    const payload =
      requests.length === 1
        ? {
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  tool_calls: [
                    {
                      id: "native-id",
                      type: "builtin_function",
                      function: { name: "$web_search", arguments: native },
                    },
                  ],
                },
              },
            ],
          }
        : {
            choices: [
              { finish_reason: "stop", message: { content: "Actual supplied documentation" } },
            ],
          };
    return run({ response: new Response(JSON.stringify(payload)), finalUrl: options.url });
  });
  const result = await __testing.runKimiSearch(params);
  expect(endpoint).toHaveBeenCalledTimes(2);
  expect(requests[1].messages.at(-1)).toEqual({
    role: "tool",
    tool_call_id: "native-id",
    content: native,
  });
  expect(result.content).toBe("Actual supplied documentation");
  // URLs in an opaque format are not automatically promoted into verified citations.
  expect(result.citations).toEqual([]);
});
it("does not execute or acknowledge an unadvertised tool", async () => {
  endpoint.mockImplementation(async (options, run) =>
    run({
      response: new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                tool_calls: [{ id: "bad", function: { name: "shell", arguments: "payload" } }],
              },
            },
          ],
        }),
      ),
      finalUrl: options.url,
    }),
  );
  await expect(__testing.runKimiSearch(params)).rejects.toThrow("unsupported native tool");
  expect(endpoint).toHaveBeenCalledTimes(1);
});
it("does not turn an HTTP error into search success", async () => {
  endpoint.mockImplementation(async (options, run) =>
    run({ response: new Response("not available", { status: 404 }), finalUrl: options.url }),
  );
  await expect(__testing.runKimiSearch(params)).rejects.toThrow();
  expect(endpoint).toHaveBeenCalledTimes(1);
});
