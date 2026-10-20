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
  it("keeps processing concurrent, successful and unknown claims blocked across instances", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "external-replay-lifecycle-"));
    try {
      const first = createExternalReplayGuard({ stateDir });
      const peer = createExternalReplayGuard({ stateDir });
      const key = { accountId: "primary", messageId: "inflight" };
      const claims = await Promise.all([first.claimMessage(key), first.claimMessage(key)]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(await peer.claimMessage(key)).toBeUndefined();
      await claims.find(Boolean)!.settle("completed");
      expect(await createExternalReplayGuard({ stateDir }).claimMessage(key)).toBeUndefined();
      const unknownKey = { ...key, messageId: "unknown" };
      const unknown = await first.claimMessage(unknownKey);
      await unknown!.settle("delivery_unknown");
      expect(
        await createExternalReplayGuard({ stateDir }).claimMessage(unknownKey),
      ).toBeUndefined();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("releases only an owned safe failure and never reuses its settlement handle", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "external-replay-release-"));
    try {
      const first = createExternalReplayGuard({ stateDir });
      const peer = createExternalReplayGuard({ stateDir });
      const key = { accountId: "primary", messageId: "retry" };
      const original = await first.claimMessage(key);
      expect(await peer.claimMessage(key)).toBeUndefined();
      await original!.settle("retryable_before_dispatch");
      const next = await peer.claimMessage(key);
      expect(next).toBeDefined();
      await original!.settle("retryable_before_dispatch");
      expect(await createExternalReplayGuard({ stateDir }).claimMessage(key)).toBeUndefined();
      await next!.settle("completed");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
