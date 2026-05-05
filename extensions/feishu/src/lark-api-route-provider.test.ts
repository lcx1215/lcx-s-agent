import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayLarkApiRouteProvider } from "./lark-api-route-provider.js";
import { LARK_ROUTING_FAMILY_CONTRACTS, type LarkRoutingFamily } from "./lark-routing-corpus.js";

const { mockCallGateway } = vi.hoisted(() => ({
  mockCallGateway: vi.fn(),
}));

vi.mock("../../../src/gateway/call.js", () => ({
  callGateway: mockCallGateway,
  randomIdempotencyKey: () => "idem-test",
}));

const families = Object.keys(LARK_ROUTING_FAMILY_CONTRACTS) as LarkRoutingFamily[];

describe("createGatewayLarkApiRouteProvider", () => {
  beforeEach(() => {
    mockCallGateway.mockReset();
  });

  it("asks the gateway agent to classify the Lark utterance and parses JSON", async () => {
    mockCallGateway.mockResolvedValue({
      result: {
        payloads: [
          {
            text: JSON.stringify({
              family: "api_reply_distillation",
              confidence: 0.94,
              rationale: "request is about per-reply distillation",
              work_order: {
                objective: "turn each API reply into a reviewed language candidate",
                required_modules: ["api_reply_normalizer", "routing_eval"],
                evidence_required: ["candidate corpus entry"],
                safety_boundaries: ["language_routing_only"],
                output_contract: ["accepted/rejected/discarded result"],
              },
            }),
          },
        ],
      },
    });

    const provider = createGatewayLarkApiRouteProvider({
      routeAgentId: "main",
      sessionKey: "agent:main:feishu:dm:ou-user",
      messageId: "msg-1",
      timeoutSeconds: 8,
    });
    const candidate = await provider({
      utterance: "每次 API 回复都产出一个可蒸馏样本",
      families,
      contracts: LARK_ROUTING_FAMILY_CONTRACTS,
    });

    expect(candidate).toMatchObject({
      family: "api_reply_distillation",
      confidence: 0.94,
      workOrder: {
        objective: "turn each API reply into a reviewed language candidate",
        requiredModules: ["api_reply_normalizer", "routing_eval"],
        evidenceRequired: ["candidate corpus entry"],
        safetyBoundaries: ["language_routing_only"],
        outputContract: ["accepted/rejected/discarded result"],
      },
    });
    expect(mockCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          agentId: "main",
          sessionKey: "agent:main:feishu:dm:ou-user:lark-api-router:msg-1",
          lane: "lark-api-router",
          label: "Lark API Router",
        }),
      }),
    );
    const message = mockCallGateway.mock.calls[0][0].params.message;
    expect(message).toContain("primary planner/auditor");
    expect(message).toContain("work_order is the primary task plan sent to the local brain");
    expect(message).toContain("offline replay/eval instrumentation only");
    expect(message).toContain("cannot replace or rescue your JSON");
    expect(message).toContain("work_order keys:");
    expect(message).toContain("near_misses=");
    expect(message).toContain(
      "a user holding/losing on an ETF or stock and asking for research-only risk",
    );
    expect(message).toContain(
      "Only use market_capability_learning_intake when the user asks the agent to learn/internalize a capability from a concrete source",
    );
    expect(message).toContain("output_contract must not ask for buy/sell/add/reduce/hold/wait");
  });

  it("sanitizes unknown families from gateway output", async () => {
    mockCallGateway.mockResolvedValue({
      summary: '{"family":"not_a_real_family","confidence":0.99,"rationale":"bad"}',
    });
    const provider = createGatewayLarkApiRouteProvider({
      routeAgentId: "main",
      sessionKey: "agent:main",
      messageId: "msg-2",
    });

    await expect(
      provider({
        utterance: "hello",
        families,
        contracts: LARK_ROUTING_FAMILY_CONTRACTS,
      }),
    ).resolves.toMatchObject({
      family: "unknown",
      confidence: 0.99,
    });
  });

  it("parses compact planner string lists from real router JSON", async () => {
    mockCallGateway.mockResolvedValue({
      result: {
        payloads: [
          {
            text: JSON.stringify({
              family: "learning_external_source",
              confidence: 0.68,
              rationale: "broad external learning request with source limits",
              work_order: {
                objective: "learn options knowledge with explicit source coverage limits",
                required_modules: "source_grounding + finance_learning_memory + review_panel",
                evidence_required: "searched sources + retained rules + failedReason",
                safety_boundaries: "research_only; no_execution_authority",
                output_contract: "learningInternalizationStatus + failedReason",
              },
            }),
          },
        ],
      },
    });
    const provider = createGatewayLarkApiRouteProvider({
      routeAgentId: "main",
      sessionKey: "agent:main",
      messageId: "msg-3",
    });

    await expect(
      provider({
        utterance: "去学期权全知识",
        families,
        contracts: LARK_ROUTING_FAMILY_CONTRACTS,
      }),
    ).resolves.toMatchObject({
      family: "learning_external_source",
      confidence: 0.68,
      workOrder: {
        requiredModules: ["source_grounding", "finance_learning_memory", "review_panel"],
        evidenceRequired: ["searched sources", "retained rules", "failedReason"],
        safetyBoundaries: ["research_only", "no_execution_authority"],
        outputContract: ["learningInternalizationStatus", "failedReason"],
      },
    });
  });
});
