import { expect, it } from "vitest";
import { shouldSuppressMessagingToolReplies } from "../../../auto-reply/reply/reply-payloads.js";
import { enforceCrossContextPolicy } from "../../../infra/outbound/outbound-policy.js";
import { normalizeTargetForComparison } from "../../../infra/outbound/target-normalization.js";
import { formatExternalTarget, parseExternalTarget } from "./external.js";

it("uses the same External identity for policy and duplicate suppression without decoding raw IDs twice", () => {
  const cfg = { tools: { message: { crossContext: { allowWithinProvider: false } } } };
  expect(() =>
    enforceCrossContextPolicy({
      channel: "external",
      action: "send",
      cfg,
      args: { to: "external:foo" },
      toolContext: { currentChannelProvider: "external", currentChannelId: "foo" },
    }),
  ).not.toThrow();
  expect(
    shouldSuppressMessagingToolReplies({
      messageProvider: "external",
      originatingTo: "foo",
      messagingToolSentTargets: [{ tool: "message", provider: "external", to: "external:foo" }],
    }),
  ).toBe(true);
  const origin = formatExternalTarget("group:123", "direct");
  expect(parseExternalTarget(origin)).toEqual({ id: "group:123", kind: "direct" });
  expect(normalizeTargetForComparison("external", origin)).toBe("group:123");
  expect(normalizeTargetForComparison("external", "group:123")).toBe("123");
  expect(() =>
    enforceCrossContextPolicy({
      channel: "external",
      action: "send",
      cfg,
      args: { to: "group:123" },
      toolContext: { currentChannelProvider: "external", currentChannelId: origin },
    }),
  ).toThrow("Cross-context messaging denied");
  expect(
    shouldSuppressMessagingToolReplies({
      messageProvider: "external",
      originatingTo: origin,
      messagingToolSentTargets: [{ tool: "message", provider: "external", to: "group:123" }],
    }),
  ).toBe(false);
});
