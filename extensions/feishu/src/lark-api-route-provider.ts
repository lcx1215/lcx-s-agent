import { randomIdempotencyKey, callGateway } from "../../../src/gateway/call.js";
import type {
  LarkApiRouteCandidate,
  LarkApiRouteProvider,
  LarkRoutingFamily,
} from "./lark-routing-corpus.js";

type GatewayAgentPayload = {
  text?: string;
};

type GatewayAgentResponse = {
  summary?: string;
  result?: {
    payloads?: GatewayAgentPayload[];
  };
};

function pickGatewayText(response: GatewayAgentResponse): string {
  const texts =
    response.result?.payloads
      ?.map((payload) => payload.text?.trim())
      .filter((value): value is string => Boolean(value)) ?? [];
  if (texts.length > 0) {
    return texts.join("\n\n").trim();
  }
  return response.summary?.trim() ?? "";
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("no JSON object found");
    }
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  }
}

function parseLarkApiRouteCandidate(params: {
  text: string;
  families: readonly LarkRoutingFamily[];
}): LarkApiRouteCandidate {
  const parsed = parseJsonObject(params.text) as {
    family?: unknown;
    confidence?: unknown;
    rationale?: unknown;
  };
  const family =
    typeof parsed.family === "string" &&
    params.families.includes(parsed.family as LarkRoutingFamily)
      ? (parsed.family as LarkRoutingFamily)
      : "unknown";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;
  return {
    family,
    confidence,
    rationale: typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 240) : undefined,
  };
}

export function createGatewayLarkApiRouteProvider(params: {
  routeAgentId: string;
  sessionKey: string;
  messageId: string;
  timeoutSeconds?: number;
}): LarkApiRouteProvider {
  return async ({ utterance, families, contracts }) => {
    const familyList = families.join(", ");
    const contractLines = families
      .map((family) => {
        const contract = contracts[family];
        return `- ${family}: target=${contract.target}; examples=${contract.canonicalUtterances
          .slice(0, 2)
          .join(" | ")}`;
      })
      .join("\n");
    const timeoutSeconds = params.timeoutSeconds ?? 20;
    const response = await callGateway<GatewayAgentResponse>({
      method: "agent",
      params: {
        message: [
          "Classify this Lark user utterance into exactly one allowed semantic family.",
          "Return only compact JSON with keys: family, confidence, rationale.",
          `Allowed families: ${familyList}.`,
          "Use family=unknown and confidence<=0.5 when unsure.",
          "Do not answer the user task. Do not execute commands. Do not add markdown.",
          "",
          "Family contracts:",
          contractLines,
          "",
          `Utterance: ${utterance}`,
        ].join("\n"),
        agentId: params.routeAgentId,
        sessionKey: `${params.sessionKey}:lark-api-router:${params.messageId}`,
        timeout: timeoutSeconds,
        thinking: "off",
        lane: "lark-api-router",
        extraSystemPrompt:
          "You are a route classifier for Lark. You only classify intent. Output JSON only. Never execute the user request.",
        idempotencyKey: randomIdempotencyKey(),
        label: "Lark API Router",
      },
      expectFinal: true,
      timeoutMs: (timeoutSeconds + 15) * 1000,
    });
    return parseLarkApiRouteCandidate({ text: pickGatewayText(response), families });
  };
}
