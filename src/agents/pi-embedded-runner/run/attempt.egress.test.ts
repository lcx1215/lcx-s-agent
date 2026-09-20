import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  guardCalls: [] as unknown[],
}));

vi.mock("../../model-egress.js", () => ({
  ensureModelEgressDispatcher: (config: unknown) => {
    hoisted.guardCalls.push(config);
  },
}));

const { wrapStreamFnEgressAssertion } = await import("./attempt.js");

describe("wrapStreamFnEgressAssertion", () => {
  it("asserts the egress route before the request is issued, not after", async () => {
    hoisted.guardCalls.length = 0;
    const order: string[] = [];
    const config = { models: { proxy: "http://egress.example:3128" } } as never;
    const base = vi.fn(() => {
      order.push("request");
      return Promise.resolve("done");
    });

    const wrapped = wrapStreamFnEgressAssertion(base as never, config);
    await wrapped({ id: "m" } as never, { messages: [] } as never, {} as never);

    // The guard has to have run by the time the request function is entered — otherwise a lazily
    // loaded provider could still land an ambient dispatcher and route the request with it.
    expect(order).toEqual(["request"]);
    expect(hoisted.guardCalls).toEqual([config]);
  });

  it("re-asserts on every request, because pi-ai reinstalls its ambient dispatcher", async () => {
    hoisted.guardCalls.length = 0;
    const base = vi.fn(() => Promise.resolve("ok"));
    const wrapped = wrapStreamFnEgressAssertion(base as never, undefined);

    await wrapped({ id: "m" } as never, { messages: [] } as never, {} as never);
    await wrapped({ id: "m" } as never, { messages: [] } as never, {} as never);
    await wrapped({ id: "m" } as never, { messages: [] } as never, {} as never);

    // Measured on Node 22: a second ambient install lands one macrotask after the first, so a
    // single assertion at run start is not sufficient.
    expect(hoisted.guardCalls).toHaveLength(3);
  });

  it("forwards model, context and options unchanged", async () => {
    hoisted.guardCalls.length = 0;
    const base = vi.fn(() => Promise.resolve("ok"));
    const model = { id: "m" } as never;
    const context = { messages: [{ role: "user" }] } as never;
    const options = { apiKey: "k", signal: undefined } as never;

    const wrapped = wrapStreamFnEgressAssertion(base as never, undefined);
    await wrapped(model, context, options);

    expect(base).toHaveBeenCalledWith(model, context, options);
  });

  it("returns the inner result untouched", async () => {
    hoisted.guardCalls.length = 0;
    const streamed = { kind: "stream" };
    const wrapped = wrapStreamFnEgressAssertion(
      (() => Promise.resolve(streamed)) as never,
      undefined,
    );

    await expect(
      wrapped({ id: "m" } as never, { messages: [] } as never, {} as never),
    ).resolves.toBe(streamed);
  });
});
