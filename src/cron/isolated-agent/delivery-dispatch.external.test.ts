import { expect, it, vi } from "vitest";
import { runSubagentAnnounceFlow } from "../../agents/subagent-announce.js";
import { normalizeExternalTarget } from "../../channels/plugins/normalize/external.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { makeJob } from "../isolated-agent.test-harness.js";
import { dispatchCronDelivery, matchesMessagingToolDeliveryTarget } from "./delivery-dispatch.js";
import { resolveDeliveryTarget } from "./delivery-target.js";

vi.mock("../../agents/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(async () => true),
}));
vi.mock("../../agents/subagent-registry.js", () => ({ countActiveDescendantRuns: () => 0 }));
vi.mock("../../config/sessions.js", async () => ({
  ...(await vi.importActual<typeof import("../../config/sessions.js")>("../../config/sessions.js")),
  loadSessionStore: () => ({}),
}));

it("keeps External cron group context and escaped raw identity through resolution and the actual announce dispatcher", async () => {
  const plugin = {
    ...createChannelTestPluginBase({
      id: "external",
      config: { resolveDefaultTo: () => "group:configured" },
    }),
    outbound: {
      deliveryMode: "direct" as const,
      resolveTarget: ({ to }: { to?: string }) => {
        const target = to && normalizeExternalTarget(to);
        return target
          ? { ok: true as const, to: target }
          : { ok: false as const, error: new Error("missing") };
      },
    },
  };
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "external", plugin, source: "test" }]),
    "external-cron-identity",
  );
  try {
    for (const [requested, raw] of [
      ["group:room-1", "room-1"],
      ["external:group:group:123", "group:123"],
      [undefined, "configured"],
    ] as const) {
      vi.mocked(runSubagentAnnounceFlow).mockClear();
      const route = requested ?? "group:configured";
      const delivery = await resolveDeliveryTarget({}, "main", {
        channel: "external",
        to: requested,
      });
      expect(delivery).toMatchObject({ ok: true, to: raw, routeTarget: route });
      await dispatchCronDelivery({
        cfg: {},
        cfgWithAgentDefaults: {},
        agentId: "main",
        agentSessionKey: "agent:main:cron:test",
        deps: {
          sendMessageSlack: vi.fn(),
          sendMessageWhatsApp: vi.fn(),
          sendMessageTelegram: vi.fn(),
          sendMessageDiscord: vi.fn(),
          sendMessageSignal: vi.fn(),
          sendMessageIMessage: vi.fn(),
        },
        job: makeJob({ kind: "agentTurn", message: "report" }),
        runSessionId: "test",
        runStartedAt: 0,
        runEndedAt: 1,
        timeoutMs: 1000,
        resolvedDelivery: delivery,
        deliveryRequested: true,
        skipHeartbeatDelivery: false,
        skipMessagingToolDelivery: false,
        deliveryBestEffort: false,
        deliveryPayloadHasStructuredContent: false,
        deliveryPayloads: [{ text: "finished report" }],
        synthesizedText: "finished report",
        isAborted: () => false,
        abortReason: () => "",
        withRunSession: (result) => ({
          ...result,
          sessionId: "test",
          sessionKey: "agent:main:cron:test",
        }),
      });
      expect(runSubagentAnnounceFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          requesterSessionKey: `agent:main:external:group:${raw}`,
          requesterOrigin: expect.objectContaining({ channel: "external", to: route }),
        }),
      );
      expect(
        normalizeExternalTarget(
          vi.mocked(runSubagentAnnounceFlow).mock.calls[0][0].requesterOrigin!.to!,
        ),
      ).toBe(raw);
      expect(
        matchesMessagingToolDeliveryTarget(
          { provider: "external", to: route },
          { channel: "external", to: raw },
        ),
      ).toBe(true);
    }
  } finally {
    setActivePluginRegistry(createTestRegistry([]), "external-cron-reset");
  }
});
