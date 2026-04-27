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
});
