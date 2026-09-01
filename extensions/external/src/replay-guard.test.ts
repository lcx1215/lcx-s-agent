import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createExternalReplayGuard } from "./replay-guard.js";

describe("external replay guard", () => {
  it("persists account-scoped message IDs across guard instances", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-external-replay-"));
    try {
      const firstGuard = createExternalReplayGuard({ stateDir });
      expect(
        await firstGuard.shouldProcessMessage({ accountId: "primary", messageId: "message-1" }),
      ).toBe(true);
      expect(
        await firstGuard.shouldProcessMessage({ accountId: "primary", messageId: "message-1" }),
      ).toBe(false);

      const secondGuard = createExternalReplayGuard({ stateDir });
      expect(
        await secondGuard.shouldProcessMessage({ accountId: "primary", messageId: "message-1" }),
      ).toBe(false);
      expect(
        await secondGuard.shouldProcessMessage({ accountId: "secondary", messageId: "message-1" }),
      ).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
