import { describe, expect, it } from "vitest";
import { createReplyToModeFilterForChannel } from "./reply-threading.js";

describe("createReplyToModeFilterForChannel", () => {
  it("keeps explicit reply tag payloads for external when mode is off", () => {
    const filter = createReplyToModeFilterForChannel("off", "external");
    const input = { text: "ok", replyToId: "msg-123", replyToTag: true };
    const output = filter(input);

    expect(output.replyToId).toBe("msg-123");
  });

  it("keeps explicit reply tag payloads for external when mode is off", () => {
    const filter = createReplyToModeFilterForChannel("off", "external");
    const input = { text: "ok", replyToId: "msg-123", replyToTag: true };
    const output = filter(input);

    expect(output.replyToId).toBe("msg-123");
  });

  it("strips explicit reply payloads for unknown channels when mode is off", () => {
    const filter = createReplyToModeFilterForChannel("off", "random-unknown-channel");
    const input = { text: "ok", replyToId: "msg-123", replyToTag: true };
    const output = filter(input);

    expect(output.replyToId).toBeUndefined();
  });
});
