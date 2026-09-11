import * as discordSdk from "lcx-agent/plugin-sdk/discord";
import * as imessageSdk from "lcx-agent/plugin-sdk/imessage";
import * as lineSdk from "lcx-agent/plugin-sdk/line";
import * as signalSdk from "lcx-agent/plugin-sdk/signal";
import * as slackSdk from "lcx-agent/plugin-sdk/slack";
import * as whatsappSdk from "lcx-agent/plugin-sdk/whatsapp";
import { describe, expect, it } from "vitest";

describe("plugin-sdk subpath exports", () => {
  it("exports Discord helpers", () => {
    expect(typeof discordSdk.resolveDiscordAccount).toBe("function");
    expect(typeof discordSdk.discordOnboardingAdapter).toBe("object");
  });

  it("exports Slack helpers", () => {
    expect(typeof slackSdk.resolveSlackAccount).toBe("function");
    expect(typeof slackSdk.handleSlackMessageAction).toBe("function");
  });

  it("exports Signal helpers", () => {
    expect(typeof signalSdk.resolveSignalAccount).toBe("function");
    expect(typeof signalSdk.signalOnboardingAdapter).toBe("object");
  });

  it("exports iMessage helpers", () => {
    expect(typeof imessageSdk.resolveIMessageAccount).toBe("function");
    expect(typeof imessageSdk.imessageOnboardingAdapter).toBe("object");
  });

  it("exports WhatsApp helpers", () => {
    expect(typeof whatsappSdk.resolveWhatsAppAccount).toBe("function");
    expect(typeof whatsappSdk.whatsappOnboardingAdapter).toBe("object");
  });

  it("exports LINE helpers", () => {
    expect(typeof lineSdk.processLineMessage).toBe("function");
    expect(typeof lineSdk.createInfoCard).toBe("function");
  });
});
