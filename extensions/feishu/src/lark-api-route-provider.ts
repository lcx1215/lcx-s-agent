import { randomIdempotencyKey, callGateway } from "../../../src/gateway/call.js";
import type {
  LarkApiRouteCandidate,
  LarkApiPlannerWorkOrder,
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

function parseStringArray(value: unknown): readonly string[] | undefined {
  if (typeof value === "string") {
    const items = value
      .split(/[,\n+；;]+/u)
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => item.slice(0, 120));
    return items.length > 0 ? items.slice(0, 12) : undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .map((item) => item.slice(0, 120));
  return items.length > 0 ? items.slice(0, 12) : undefined;
}

function parsePlannerWorkOrder(value: unknown): LarkApiPlannerWorkOrder | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const workOrder: LarkApiPlannerWorkOrder = {
    objective: typeof raw.objective === "string" ? raw.objective.trim().slice(0, 240) : undefined,
    requiredModules: parseStringArray(raw.required_modules ?? raw.requiredModules),
    backendTool:
      typeof raw.backend_tool === "string"
        ? raw.backend_tool.trim().slice(0, 96)
        : typeof raw.backendTool === "string"
          ? raw.backendTool.trim().slice(0, 96)
          : undefined,
    evidenceRequired: parseStringArray(raw.evidence_required ?? raw.evidenceRequired),
    safetyBoundaries: parseStringArray(raw.safety_boundaries ?? raw.safetyBoundaries),
    outputContract: parseStringArray(raw.output_contract ?? raw.outputContract),
  };
  return Object.values(workOrder).some(Boolean) ? workOrder : undefined;
}

function parseLarkApiRouteCandidate(params: {
  text: string;
  families: readonly LarkRoutingFamily[];
}): LarkApiRouteCandidate {
  const parsed = parseJsonObject(params.text) as {
    family?: unknown;
    confidence?: unknown;
    rationale?: unknown;
    work_order?: unknown;
    workOrder?: unknown;
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
    workOrder: parsePlannerWorkOrder(parsed.work_order ?? parsed.workOrder),
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
          .slice(0, 3)
          .join(" | ")}; near_misses=${contract.nearMisses.slice(0, 2).join(" | ")}`;
      })
      .join("\n");
    const timeoutSeconds = params.timeoutSeconds ?? 20;
    const response = await callGateway<GatewayAgentResponse>({
      method: "agent",
      params: {
        message: [
          "Act as the primary planner/auditor for this Lark user utterance: classify it into exactly one allowed semantic family and draft a bounded work_order for the local agent brain.",
          "Return only compact JSON with keys: family, confidence, rationale, work_order.",
          "work_order keys: objective, required_modules, backend_tool, evidence_required, safety_boundaries, output_contract.",
          "The work_order is the primary task plan sent to the local brain. It is not execution. Keep it short and use only module/tool names implied by the family contracts or user text.",
          "The local semantic family library is offline replay/eval instrumentation only. It does not decompose live Lark requests, does not audit your route, and cannot replace or rescue your JSON.",
          `Allowed families: ${familyList}.`,
          "Use family=unknown and confidence<=0.5 when unsure.",
          "Hard priority: a user holding/losing on an ETF or stock and asking for research-only risk, checklist, local math limits, or failedReason is position_risk_adjustment, not market_capability_learning_intake.",
          "Hard priority: a user asking company fundamental risk on valuation, margins, capex return, concentration, demand durability, or missing filings is fundamental_research, not market_capability_learning_intake.",
          "Only use market_capability_learning_intake when the user asks the agent to learn/internalize a capability from a concrete source, pipeline, article, paper, or local file.",
          "For research-only position risk, output_contract must not ask for buy/sell/add/reduce/hold/wait trade triggers. Use risk observation points, invalidation conditions, missing-data gates, and research checklist instead.",
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
