import { describe, expect, it } from "vitest";
import { formatGatewayChannelsStatusLines } from "./status.js";

describe("formatGatewayChannelsStatusLines", () => {
  it("shows degraded instead of works when the probe reports outbound trouble", () => {
    const lines = formatGatewayChannelsStatusLines({
      channelAccounts: {
        telegram: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: true,
            probe: {
              ok: false,
              health: "degraded",
              reason: "dns",
              error: "getaddrinfo ENOTFOUND open.larksuite.com",
            },
          },
        ],
      },
    });

    const joined = lines.join("\n");
    expect(joined).toContain("degraded:dns");
    expect(joined).not.toContain("works");
  });
});
