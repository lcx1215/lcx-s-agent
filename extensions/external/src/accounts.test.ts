import { describe, expect, it } from "vitest";
import { resolveExternalAccount } from "./accounts.js";
import { ExternalConfigSchema } from "./config-schema.js";

describe("external account configuration", () => {
  it("requires explicit inbound no-auth when no inbound token is supplied", () => {
    expect(() =>
      ExternalConfigSchema.parse({
        outboundUrl: "https://receiver.example/messages",
      }),
    ).toThrow(/inboundAuth/);
  });

  it("resolves a fully configured no-auth local contract", () => {
    const cfg = {
      channels: {
        external: {
          inboundAuth: "none",
          outboundAuth: "none",
          outboundUrl: "https://receiver.example/messages",
          allowFrom: ["user-1"],
        },
      },
    } as never;
    const account = resolveExternalAccount({ cfg });
    expect(account).toMatchObject({
      accountId: "default",
      webhookPath: "/external/messages",
      inboundAuth: "none",
      outboundAuth: "none",
      configured: true,
      allowFrom: ["user-1"],
    });
  });
});
