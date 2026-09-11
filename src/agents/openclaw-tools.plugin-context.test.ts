import { describe, expect, it, vi } from "vitest";

const { resolvePluginToolsMock, financeResearchOptionsMock } = vi.hoisted(() => ({
  resolvePluginToolsMock: vi.fn((params?: unknown) => {
    void params;
    return [];
  }),
  financeResearchOptionsMock: vi.fn(() => ({
    name: "finance_research_run",
  })),
}));

vi.mock("../plugins/tools.js", () => ({
  resolvePluginTools: resolvePluginToolsMock,
}));

vi.mock("./tools/finance-research-run-tool.js", () => ({
  createFinanceResearchRunTool: financeResearchOptionsMock,
}));

import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools plugin context", () => {
  it("forwards trusted requester sender identity to plugin tool context", () => {
    createOpenClawTools({
      config: {} as never,
      requesterSenderId: "trusted-sender",
      senderIsOwner: true,
    });

    expect(resolvePluginToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          requesterSenderId: "trusted-sender",
          senderIsOwner: true,
        }),
      }),
    );
  });

  it("forwards ephemeral sessionId to plugin tool context", () => {
    createOpenClawTools({
      config: {} as never,
      agentSessionKey: "agent:main:telegram:direct:12345",
      sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });

    expect(resolvePluginToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          sessionKey: "agent:main:telegram:direct:12345",
          sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        }),
      }),
    );
  });

  it("forwards configured model-fleet slots to the core research tool", () => {
    financeResearchOptionsMock.mockClear();
    createOpenClawTools({
      config: {
        plugins: {
          entries: {
            "lcx-model-fleet": {
              enabled: true,
              config: {
                slotModels: {
                  fast: "provider/fast",
                  reasoning: "provider/reasoning",
                  review: "provider/review",
                },
              },
            },
          },
        },
      } as never,
    });

    expect(financeResearchOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        slotModels: {
          fast: "provider/fast",
          reasoning: "provider/reasoning",
          review: "provider/review",
        },
      }),
    );
  });
});
