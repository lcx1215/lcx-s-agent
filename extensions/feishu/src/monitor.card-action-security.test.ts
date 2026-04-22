import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyFeishuCardActionWebhook } from "./monitor.transport.js";

function buildCardActionPayload(token?: string) {
  return {
    schema: "2.0",
    header: {
      event_id: "cb-test",
      event_type: "card.action.trigger",
      create_time: "1776820312000",
      app_id: "cli_test",
      tenant_key: "tenant_test",
      ...(token ? { token } : {}),
    },
    event: {
      operator: { open_id: "ou_fake_card_actor", user_id: "u_fake_card_actor" },
      token: "tok-card-action",
      action: { value: { text: "/help" }, tag: "button" },
      context: { open_id: "ou_fake_card_actor", user_id: "u_fake_card_actor", chat_id: "oc_fake" },
    },
  };
}

describe("verifyFeishuCardActionWebhook", () => {
  it("rejects unsigned schema card callbacks without a matching token", () => {
    expect(
      verifyFeishuCardActionWebhook({
        data: buildCardActionPayload(),
        headers: {},
        verificationToken: "verify_token",
      }),
    ).toBe(false);
  });

  it("accepts schema card callbacks with the configured token in the payload header", () => {
    expect(
      verifyFeishuCardActionWebhook({
        data: buildCardActionPayload("verify_token"),
        headers: {},
        verificationToken: "verify_token",
      }),
    ).toBe(true);
  });

  it("accepts schema card callbacks with a matching signed request", () => {
    const payload = buildCardActionPayload();
    const timestamp = "1776820312";
    const nonce = "nonce-1";
    const signature = createHash("sha1")
      .update(`${timestamp}${nonce}verify_token${JSON.stringify(payload)}`)
      .digest("hex");

    expect(
      verifyFeishuCardActionWebhook({
        data: payload,
        headers: {
          "x-lark-request-timestamp": timestamp,
          "x-lark-request-nonce": nonce,
          "x-lark-signature": signature,
        },
        verificationToken: "verify_token",
      }),
    ).toBe(true);
  });
});
