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

  it("accepts credentials supplied only by a named account", () => {
    expect(() =>
      ExternalConfigSchema.parse({
        accounts: {
          primary: {
            inboundToken: "account-inbound-token",
            outboundUrl: "https://receiver.example/messages",
          },
        },
      }),
    ).not.toThrow();
  });
});

it("validates named accounts after root inheritance without child defaults masking it", () => {
  const external = ExternalConfigSchema.parse({
    inboundAuth: "none",
    outboundAuth: "bearer",
    outboundToken: "shared-token",
    textChunkLimit: 12,
    accounts: { primary: { outboundUrl: "https://receiver.example/messages" } },
  });
  expect(external.accounts?.primary?.inboundAuth).toBeUndefined();
  expect(
    resolveExternalAccount({ cfg: { channels: { external } } as never, accountId: "primary" }),
  ).toMatchObject({
    inboundAuth: "none",
    outboundAuth: "bearer",
    outboundToken: "shared-token",
    textChunkLimit: 12,
    configured: true,
  });
  expect(() =>
    ExternalConfigSchema.parse({
      inboundToken: "shared-inbound",
      accounts: { primary: { outboundUrl: "https://receiver.example/messages" } },
    }),
  ).not.toThrow();
  expect(() =>
    ExternalConfigSchema.parse({
      inboundAuth: "none",
      accounts: { primary: { inboundAuth: "token" } },
    }),
  ).toThrow(/inboundToken/);
});

it("rejects non-HTTP and malformed outbound URLs", () => {
  for (const outboundUrl of [
    "ftp://receiver.example/messages",
    "file:///tmp/receiver",
    "not a URL",
  ]) {
    expect(ExternalConfigSchema.safeParse({ inboundAuth: "none", outboundUrl }).success).toBe(
      false,
    );
  }
});

it("does not resolve unused token refs when effective auth is none", () => {
  const ref = { source: "env", provider: "default", id: "UNUSED_EXTERNAL_TOKEN" };
  expect(
    resolveExternalAccount({
      cfg: {
        channels: {
          external: {
            inboundAuth: "none",
            outboundAuth: "none",
            inboundToken: ref,
            outboundToken: ref,
            outboundUrl: "https://receiver.example",
          },
        },
      } as never,
    }),
  ).toMatchObject({ inboundToken: "", outboundToken: "", configured: true });
});
