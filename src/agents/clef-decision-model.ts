import { createHash } from "node:crypto";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { readResponseText } from "./tools/web-shared.js";

export const CLEF_POLICY = {
  maxStateBytes: 32_768,
  maxRequestBytes: 98_304,
  maxResponseBytes: 262_144,
  maxQuestions: 64,
  maxOptions: 32,
  maxCalls: 8,
  timeoutMs: 15_000,
} as const;

export type ClefQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };
export type ClefRequest = { state: unknown; questions: Record<string, ClefQuestion> };
export type ClefModel = "clef" | "clef-flash";
export type ClefAnswer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | {
      type: "score";
      score: number;
      confidence: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
    };

type ClefConfig =
  | { ready: false; reason: "disabled" | "invalid_configuration" | "credentials_missing" }
  | { ready: true; model: ClefModel; accountId: string; apiToken: string; proxyUrl?: string };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

/** Only host environment can choose a model, account, credential or egress route. */
export function resolveClefConfig(env: NodeJS.ProcessEnv = process.env): ClefConfig {
  if (env.LCX_CLEF_ENABLED !== "1") {
    return { ready: false, reason: "disabled" };
  }
  const model = env.LCX_CLEF_MODEL?.trim() || "clef-flash";
  const accountId = env.LCX_CLEF_ACCOUNT_ID?.trim();
  const apiToken = env.LCX_CLEF_API_TOKEN?.trim();
  if (!accountId || !apiToken) {
    return { ready: false, reason: "credentials_missing" };
  }
  if (
    !["clef", "clef-flash"].includes(model) ||
    !/^[a-f\d]{32}$/iu.test(accountId) ||
    /[\r\n]/u.test(apiToken)
  ) {
    return { ready: false, reason: "invalid_configuration" };
  }
  const proxyUrl = env.LCX_CLEF_PROXY_URL?.trim() || undefined;
  if (proxyUrl) {
    try {
      const proxy = new URL(proxyUrl);
      if (!["http:", "https:"].includes(proxy.protocol)) {
        return { ready: false, reason: "invalid_configuration" };
      }
    } catch {
      return { ready: false, reason: "invalid_configuration" };
    }
  }
  return { ready: true, model: model as ClefModel, accountId, apiToken, proxyUrl };
}

function assertJson(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > 20) {
    throw new Error("invalid_request");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    throw new Error("invalid_request");
  }
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error("invalid_request");
  }
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    // A JSON request contains data, not code whose value can change between validation and use.
    if (!Object.hasOwn(descriptor, "value")) {
      throw new Error("invalid_request");
    }
    assertJson(descriptor.value, depth + 1, seen);
  }
  seen.delete(value);
}

/** Reject rather than silently truncate state, invent options or accept authority fields. */
export function parseClefRequest(input: unknown): ClefRequest {
  let serialized: string;
  let value: unknown;
  try {
    assertJson(input);
    serialized = JSON.stringify(input);
    value = JSON.parse(serialized) as unknown;
    assertJson(value);
  } catch {
    throw new Error("invalid_request");
  }
  if (Buffer.byteLength(serialized) > CLEF_POLICY.maxRequestBytes) {
    throw new Error("request_budget_exceeded");
  }
  if (
    !object(value) ||
    Object.keys(value).some((key) => !["state", "questions"].includes(key)) ||
    !(typeof value.state === "string"
      ? text(value.state, CLEF_POLICY.maxStateBytes)
      : object(value.state) || Array.isArray(value.state)) ||
    !object(value.questions)
  ) {
    throw new Error("invalid_request");
  }
  if (Buffer.byteLength(JSON.stringify(value.state)) > CLEF_POLICY.maxStateBytes) {
    throw new Error("request_budget_exceeded");
  }
  const entries = Object.entries(value.questions);
  if (entries.length < 1 || entries.length > CLEF_POLICY.maxQuestions) {
    throw new Error("invalid_request");
  }
  for (const [id, question] of entries) {
    if (
      !/^[\w.-]{1,100}$/u.test(id) ||
      !object(question) ||
      !text(question.instructions, 1024) ||
      Object.keys(question).some((key) => !["type", "instructions", "criteria"].includes(key))
    ) {
      throw new Error("invalid_request");
    }
    if (question.type === "noul" && question.criteria === undefined) {
      continue;
    }
    const options =
      question.type === "choice" && object(question.criteria)
        ? Object.entries(question.criteria)
        : question.type === "score" && Array.isArray(question.criteria)
          ? question.criteria.map((label, index) => [String(index), label])
          : [];
    if (
      options.length < 2 ||
      options.length > CLEF_POLICY.maxOptions ||
      options.some(([key, label]) => !text(key, 100) || !text(label, 512))
    ) {
      throw new Error("invalid_request");
    }
  }
  return value as ClefRequest;
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function probabilities(value: unknown, keys: string[]): Record<string, number> {
  if (
    !object(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key) && probability(value[key]))
  ) {
    throw new Error("output_invalid");
  }
  const result = Object.fromEntries(keys.map((key) => [key, value[key] as number]));
  // SystemOne rounds each probability to four decimal places.
  if (Math.abs(Object.values(result).reduce((sum, p) => sum + p, 0) - 1) > keys.length * 0.0001) {
    throw new Error("output_invalid");
  }
  return result;
}

export function parseClefResponse(raw: unknown, request: ClefRequest, model: ClefModel) {
  if (!object(raw) || raw.model !== model || !object(raw.answers)) {
    throw new Error("output_invalid");
  }
  const answersRaw = raw.answers;
  if (Object.keys(answersRaw).length !== Object.keys(request.questions).length) {
    throw new Error("output_invalid");
  }
  const answers = Object.fromEntries(
    Object.entries(request.questions).map(([id, question]): [string, ClefAnswer] => {
      const answer = answersRaw[id];
      if (!Object.hasOwn(answersRaw, id) || !object(answer) || answer.type !== question.type) {
        throw new Error("output_invalid");
      }
      if (question.type === "noul") {
        if (!probability(answer.noul)) {
          throw new Error("output_invalid");
        }
        return [id, { type: "noul", noul: answer.noul }];
      }
      const keys = Object.keys(question.criteria);
      const distribution = probabilities(answer.probabilities, keys);
      const highest = Math.max(...Object.values(distribution));
      // Hosted Workers AI confidence is a separate score, not the top option's probability.
      if (!probability(answer.confidence)) {
        throw new Error("output_invalid");
      }
      if (question.type === "choice") {
        if (
          typeof answer.choice !== "string" ||
          !Object.hasOwn(distribution, answer.choice) ||
          Math.abs(distribution[answer.choice] - highest) > 0.0001
        ) {
          throw new Error("output_invalid");
        }
        return [
          id,
          {
            type: "choice",
            choice: answer.choice,
            confidence: answer.confidence,
            probabilities: distribution,
          },
        ];
      }
      const score = keys.reduce((sum, key) => sum + Number(key) * distribution[key], 0);
      if (
        typeof answer.score !== "number" ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > keys.length - 1 ||
        Math.abs(answer.score - score) > keys.length * keys.length * 0.0001 ||
        !object(answer.legend) ||
        Object.keys(answer.legend).length !== keys.length ||
        !keys.every(
          (key) => object(answer.legend) && answer.legend[key] === question.criteria[Number(key)],
        )
      ) {
        throw new Error("output_invalid");
      }
      return [
        id,
        {
          type: "score",
          score: answer.score,
          confidence: answer.confidence,
          legend: Object.fromEntries(
            question.criteria.map((label, index) => [String(index), label]),
          ),
          probabilities: distribution,
        },
      ];
    }),
  );
  let usage: { input_tokens: number; output_tokens: 0 } | undefined;
  if (raw.usage !== undefined) {
    if (
      !object(raw.usage) ||
      typeof raw.usage.input_tokens !== "number" ||
      !Number.isSafeInteger(raw.usage.input_tokens) ||
      raw.usage.input_tokens < 0 ||
      raw.usage.output_tokens !== 0
    ) {
      throw new Error("output_invalid");
    }
    usage = { input_tokens: raw.usage.input_tokens, output_tokens: 0 };
  }
  return { answers, ...(usage ? { usage } : {}) };
}

export async function evaluateClef(
  input: unknown,
  config: Extract<ClefConfig, { ready: true }>,
  signal?: AbortSignal,
) {
  let request: ClefRequest;
  try {
    request = parseClefRequest(input);
  } catch (error) {
    // Validate direct callers before serializing, hashing or preparing a provider request.
    return {
      status: "fallback_to_agent" as const,
      reason:
        error instanceof Error && error.message === "request_budget_exceeded"
          ? "request_budget_exceeded"
          : "invalid_request",
      evidence: { providerCallObserved: false },
    };
  }
  const started = performance.now();
  const body = JSON.stringify({ model: config.model, ...request });
  const evidence = {
    provider: "cloudflare-workers-ai",
    model: config.model,
    requestSha256: createHash("sha256").update(body).digest("hex"),
    questionIds: Object.keys(request.questions),
  };
  let providerCallObserved = false;
  let httpStatus: number | undefined;
  const deadline = AbortSignal.timeout(CLEF_POLICY.timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    combinedSignal.throwIfAborted();
    const { response, release } = await fetchWithSsrFGuard({
      url: `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/run/@cf/cloudflare/${config.model}`,
      maxRedirects: 0,
      signal: combinedSignal,
      ...(config.proxyUrl ? { proxyUrl: config.proxyUrl } : {}),
      auditContext: "clef-decision-model",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiToken}` },
        body,
      },
    });
    try {
      providerCallObserved = true;
      httpStatus = response.status;
      if (!response.ok) {
        throw new Error(
          response.status === 401 || response.status === 403
            ? "auth_required"
            : "provider_http_error",
        );
      }
      const payload = await readResponseText(response, { maxBytes: CLEF_POLICY.maxResponseBytes });
      combinedSignal.throwIfAborted();
      if (payload.truncated) {
        throw new Error("response_budget_exceeded");
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(payload.text);
      } catch {
        throw new Error("output_invalid");
      }
      if (!object(envelope) || envelope.success !== true) {
        throw new Error("provider_business_error");
      }
      const parsed = parseClefResponse(envelope.result, request, config.model);
      return {
        status: "completed_requires_review" as const,
        ...parsed,
        evidence: {
          ...evidence,
          providerCallObserved,
          httpStatus,
          durationMs: Math.round(performance.now() - started),
        },
      };
    } finally {
      await release();
    }
  } catch (error) {
    // Provider errors may echo credentials or input. Retain only known codes.
    const known = [
      "output_invalid",
      "auth_required",
      "provider_http_error",
      "provider_business_error",
      "response_budget_exceeded",
    ];
    const reason = signal?.aborted
      ? "caller_cancelled"
      : deadline.aborted
        ? "timeout"
        : error instanceof Error && known.includes(error.message)
          ? error.message
          : "transport_error";
    return {
      status: signal?.aborted ? ("cancelled" as const) : ("fallback_to_agent" as const),
      reason,
      evidence: {
        ...evidence,
        providerCallObserved,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        durationMs: Math.round(performance.now() - started),
      },
    };
  }
}
