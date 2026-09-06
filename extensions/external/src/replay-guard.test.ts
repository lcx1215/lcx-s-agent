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

  it("uses the active LCX migration state root when no state dir is supplied", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lcx-external-replay-active-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const guard = createExternalReplayGuard();
      await expect(
        guard.shouldProcessMessage({ accountId: "primary", messageId: "active-root-message" }),
      ).resolves.toBe(true);
      expect(fs.existsSync(path.join(stateDir, "external", "replay-dedupe", "primary.json"))).toBe(
        true,
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
