import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import {
  CLEF_POLICY,
  evaluateClef,
  parseClefRequest,
  parseClefResponse,
  resolveClefConfig,
} from "./clef-decision-model.js";

vi.mock("../infra/net/fetch-guard.js", () => ({ fetchWithSsrFGuard: vi.fn() }));

const env = {
  LCX_CLEF_ENABLED: "1",
  LCX_CLEF_ACCOUNT_ID: "a".repeat(32),
  LCX_CLEF_API_TOKEN: "test-only-token",
};
const request = parseClefRequest({
  state: { gap: "Fill fees missing" },
  questions: {
    missing: { type: "noul", instructions: "Is more fee evidence required?" },
    route: {
      type: "choice",
      instructions: "Which tool retrieves fees?",
      criteria: { ledger: "Ledger read", calculate: "Calculate" },
    },
    severity: {
      type: "score",
      instructions: "Rate missing evidence",
      criteria: ["minor", "major", "critical"],
    },
  },
});
const output = () => ({
  model: "clef-flash",
  answers: {
    missing: { type: "noul", noul: 0.9 },
    route: {
      type: "choice",
      choice: "ledger",
      confidence: 0.8,
      probabilities: { ledger: 0.8, calculate: 0.2 },
    },
    severity: {
      type: "score",
      score: 1.1,
      confidence: 0.5,
      legend: { "0": "minor", "1": "major", "2": "critical" },
      probabilities: { "0": 0.2, "1": 0.5, "2": 0.3 },
    },
  },
  usage: { input_tokens: 123, output_tokens: 0 },
});
function config() {
  const value = resolveClefConfig(env);
  if (!value.ready) {
    throw new Error("invalid test config");
  }
  return value;
}
function respond(body: unknown, status = 200) {
  const release = vi.fn(async () => {});
  vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
    response: new Response(JSON.stringify(body), { status }),
    finalUrl: "https://api.cloudflare.com",
    release,
  });
  return release;
}

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("Clef bounded contract", () => {
  it("is opt-in and keeps missing and invalid configuration distinct", () => {
    expect(resolveClefConfig({})).toEqual({ ready: false, reason: "disabled" });
    expect(resolveClefConfig({ LCX_CLEF_ENABLED: "1" })).toEqual({
      ready: false,
      reason: "credentials_missing",
    });
    for (const override of [
      { LCX_CLEF_ACCOUNT_ID: "../other-account" },
      { LCX_CLEF_MODEL: "chat-model" },
      { LCX_CLEF_API_TOKEN: "token\nheader" },
      { LCX_CLEF_PROXY_URL: "file:///tmp/socket" },
    ]) {
      expect(resolveClefConfig({ ...env, ...override })).toEqual({
        ready: false,
        reason: "invalid_configuration",
      });
    }
    expect(config().model).toBe("clef-flash");
  });

  it("rejects authority fields, unknown question modes and oversized state", () => {
    for (const invalid of [
      { ...request, endpoint: "https://other.invalid" },
      {
        ...request,
        questions: { route: { type: "choice", instructions: "route", criteria: { only: "one" } } },
      },
      { ...request, questions: { route: { type: "chat", instructions: "route" } } },
      { ...request, questions: { route: { type: "noul", instructions: "route", execute: true } } },
      { ...request, state: { value: Number.NaN } },
    ]) {
      expect(() => parseClefRequest(invalid)).toThrow("invalid_request");
    }
    expect(() => parseClefRequest({ ...request, state: "界".repeat(12_000) })).toThrow(
      "request_budget_exceeded",
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => parseClefRequest({ ...request, state: cyclic })).toThrow("invalid_request");
    expect(() =>
      parseClefRequest({
        ...request,
        questions: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [String(index), request.questions.missing]),
        ),
      }),
    ).toThrow("invalid_request");
  });

  it("accepts all three SystemOne answer modes and preserves low confidence", () => {
    const result = parseClefResponse(output(), request, "clef-flash");
    expect(result.answers.route).toMatchObject({ choice: "ledger", confidence: 0.8 });
    expect(result.answers.severity).toMatchObject({ score: 1.1 });
    const ambiguous = output();
    ambiguous.answers.route = {
      type: "choice",
      choice: "ledger",
      confidence: 0.0765,
      probabilities: { ledger: 0.5, calculate: 0.5 },
    };
    expect(parseClefResponse(ambiguous, request, "clef-flash").answers.route).toMatchObject({
      confidence: 0.0765,
    });
  });

  it("rejects malformed probabilities, hallucinated options and misleading confidence/scores", () => {
    const corruptions: Array<(value: ReturnType<typeof output>) => void> = [
      (value) => {
        value.model = "different-model";
      },
      (value) => {
        value.answers.route.choice = "execute_trade";
      },
      (value) => {
        value.answers.route.probabilities.calculate = -0.2;
      },
      (value) => {
        value.answers.route.probabilities.calculate = 0.9;
      },
      (value) => {
        value.answers.route.choice = "calculate";
      },
      (value) => {
        value.answers.route.confidence = 1.1;
      },
      (value) => {
        value.answers.missing.noul = Number.NaN;
      },
      (value) => {
        value.answers.severity.score = 2;
      },
      (value) => {
        value.answers.severity.legend["0"] = "approve";
      },
      (value) => {
        value.usage.output_tokens = 10;
      },
    ];
    for (const corrupt of corruptions) {
      const value = output();
      corrupt(value);
      expect(() => parseClefResponse(value, request, "clef-flash")).toThrow("output_invalid");
    }
    expect(() => parseClefResponse({ ...output(), answers: {} }, request, "clef-flash")).toThrow(
      "output_invalid",
    );
  });
});

describe("Clef Workers AI transport", () => {
  it.each(["late_throw", "late_oversize"])(
    "rejects a %s accessor without reading it or contacting the provider",
    async (mode) => {
      let reads = 0;
      const state = {
        get gap() {
          reads++;
          if (reads >= 4) {
            if (mode === "late_throw") {
              throw new Error("private-input-secret test-only-token");
            }
            return "界".repeat(CLEF_POLICY.maxStateBytes);
          }
          return "Fill fees missing";
        },
      };
      const result = await evaluateClef({ ...request, state }, config());
      expect(result).toEqual({
        status: "fallback_to_agent",
        reason: "invalid_request",
        evidence: { providerCallObserved: false },
      });
      expect(reads).toBe(0);
      expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
    },
  );

  it("sanitizes serialization exceptions before dispatch", async () => {
    const input = new Proxy(request, {
      get(target, property, receiver) {
        if (property === "toJSON") {
          throw new Error("private-input-secret test-only-token");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    expect(await evaluateClef(input, config())).toEqual({
      status: "fallback_to_agent",
      reason: "invalid_request",
      evidence: { providerCallObserved: false },
    });
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("validates responses against the same independent JSON snapshot used for dispatch", async () => {
    const input = {
      state: { gap: "Fill fees missing" },
      questions: {
        route: {
          type: "choice",
          instructions: "Which evidence route helps?",
          criteria: { ledger: "Ledger evidence", claims: "Claim evidence" },
        },
      },
    };
    const snapshot = parseClefRequest(input);
    expect(snapshot).toEqual(input);
    expect(snapshot).not.toBe(input);
    expect(snapshot.questions).not.toBe(input.questions);
    expect(snapshot.state).not.toBe(input.state);
    vi.mocked(fetchWithSsrFGuard).mockImplementation(async ({ init }) => {
      input.state.gap = "界".repeat(CLEF_POLICY.maxStateBytes);
      input.questions.route.criteria.ledger = "mutated after dispatch";
      input.questions.route.instructions = "mutated instructions";
      Reflect.deleteProperty(input.questions.route.criteria, "claims");
      if (typeof init?.body !== "string") {
        throw new Error("expected JSON request body");
      }
      expect(JSON.parse(init.body)).toEqual({ model: "clef-flash", ...snapshot });
      return {
        response: new Response(
          JSON.stringify({
            success: true,
            result: {
              model: "clef-flash",
              answers: {
                route: {
                  type: "choice",
                  choice: "ledger",
                  confidence: 0.8,
                  probabilities: { ledger: 0.8, claims: 0.2 },
                },
              },
            },
          }),
        ),
        finalUrl: "https://api.cloudflare.com",
        release: async () => {},
      };
    });
    const result = await evaluateClef(input, config());
    expect(result).toMatchObject({
      status: "completed_requires_review",
      answers: { route: { choice: "ledger" } },
      evidence: { providerCallObserved: true },
    });
    expect(fetchWithSsrFGuard).toHaveBeenCalledOnce();
  });

  it("validates direct callers before creating request evidence or calling the network", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const throwingState = {
      get secret() {
        throw new Error("private-input-secret test-only-token");
      },
    };
    const invalidInputs = [
      {
        input: { ...request, endpoint: "https://private-input-secret.invalid" },
        reason: "invalid_request",
      },
      { input: { ...request, state: cyclic }, reason: "invalid_request" },
      { input: { ...request, state: throwingState }, reason: "invalid_request" },
      { input: { ...request, state: "界".repeat(12_000) }, reason: "request_budget_exceeded" },
      {
        input: {
          ...request,
          questions: Object.fromEntries(
            Array.from({ length: 65 }, (_, index) => [String(index), request.questions.missing]),
          ),
        },
        reason: "invalid_request",
      },
      {
        input: {
          state: "safe state",
          questions: Object.fromEntries(
            Array.from({ length: 8 }, (_, index) => [
              String(index),
              {
                type: "score",
                instructions: "Use this declared rubric",
                criteria: Array.from({ length: 32 }, () => "x".repeat(512)),
              },
            ]),
          ),
        },
        reason: "request_budget_exceeded",
      },
    ];
    for (const { input, reason } of invalidInputs) {
      const result = await evaluateClef(input, config());
      expect(result).toEqual({
        status: "fallback_to_agent",
        reason,
        evidence: { providerCallObserved: false },
      });
      expect(JSON.stringify(result)).not.toContain("private-input-secret");
      expect(JSON.stringify(result)).not.toContain("test-only-token");
    }
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("uses the dedicated endpoint and credential, refuses redirects, and records validated call evidence", async () => {
    const release = respond({ success: true, result: output() });
    const result = await evaluateClef(request, config());
    expect(result).toMatchObject({
      status: "completed_requires_review",
      evidence: { providerCallObserved: true, httpStatus: 200 },
    });
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `https://api.cloudflare.com/client/v4/accounts/${env.LCX_CLEF_ACCOUNT_ID}/ai/run/@cf/cloudflare/clef-flash`,
        maxRedirects: 0,
        init: expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer test-only-token" }),
        }),
      }),
    );
    const call = vi.mocked(fetchWithSsrFGuard).mock.calls[0][0];
    if (typeof call.init?.body !== "string") {
      throw new Error("expected JSON request body");
    }
    expect(JSON.parse(call.init.body)).toEqual({ model: "clef-flash", ...request });
    expect(JSON.stringify(result)).not.toContain("test-only-token");
    expect(JSON.stringify(result)).not.toContain(env.LCX_CLEF_ACCOUNT_ID);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 429, 500])(
    "reports HTTP %s without accepting decisions or echoing provider errors",
    async (status) => {
      const release = respond({ error: "test-only-token raw state" }, status);
      const result = await evaluateClef(request, config());
      expect(result).toMatchObject({
        status: "fallback_to_agent",
        reason: status === 401 || status === 403 ? "auth_required" : "provider_http_error",
      });
      expect(result).not.toHaveProperty("answers");
      expect(JSON.stringify(result)).not.toContain("test-only-token");
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("rejects a business failure even with HTTP 200, and invalid output after successful transport", async () => {
    respond({ success: false, errors: [{ message: "test-only-token" }] });
    expect(await evaluateClef(request, config())).toMatchObject({
      reason: "provider_business_error",
      evidence: { providerCallObserved: true },
    });
    respond({ success: true, result: { ...output(), answers: {} } });
    expect(await evaluateClef(request, config())).toMatchObject({
      reason: "output_invalid",
      evidence: { providerCallObserved: true },
    });
  });

  it("bounds response size", async () => {
    respond({ success: true, padding: "x".repeat(CLEF_POLICY.maxResponseBytes + 1) });
    expect(await evaluateClef(request, config())).toMatchObject({
      reason: "response_budget_exceeded",
    });
  });

  it("does not leak thrown transport errors", async () => {
    vi.mocked(fetchWithSsrFGuard).mockRejectedValue(new Error("secret test-only-token"));
    const result = await evaluateClef(request, config());
    expect(result).toMatchObject({
      reason: "transport_error",
      evidence: { providerCallObserved: false },
    });
    expect(JSON.stringify(result)).not.toContain("test-only-token");
  });

  it("cancels before any request when the caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await evaluateClef(request, config(), controller.signal)).toMatchObject({
      status: "cancelled",
      reason: "caller_cancelled",
    });
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("propagates cancellation to an in-flight request", async () => {
    vi.mocked(fetchWithSsrFGuard).mockImplementation(
      async ({ signal }) =>
        new Promise((_, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
    );
    const controller = new AbortController();
    const pending = evaluateClef(request, config(), controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ status: "cancelled", reason: "caller_cancelled" });
  });

  it("records deadline expiry separately from caller cancellation", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    vi.mocked(fetchWithSsrFGuard).mockImplementation(
      async ({ signal }) =>
        new Promise((_, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
    );
    try {
      const pending = evaluateClef(request, config());
      deadline.abort(new Error("deadline reached"));
      expect(await pending).toMatchObject({ status: "fallback_to_agent", reason: "timeout" });
      expect(timeout).toHaveBeenCalledWith(CLEF_POLICY.timeoutMs);
    } finally {
      timeout.mockRestore();
    }
  });
});
