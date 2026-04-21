import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  clearExpiredModelTimeoutCooldowns,
  clearModelTimeoutCooldown,
  ensureAuthProfileStore,
  isProviderModelInTimeoutCooldown,
  markModelTimeoutCooldown,
  resolveProviderModelCooldownKey,
} from "./auth-profiles.js";

type AuthProfileStore = ReturnType<typeof ensureAuthProfileStore>;

async function withAuthProfileStore(
  fn: (ctx: { agentDir: string; store: AuthProfileStore }) => Promise<void>,
): Promise<void> {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
  try {
    const authPath = path.join(agentDir, "auth-profiles.json");
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        version: 1,
        profiles: {
          "custom-api-deepseek-com:default": {
            type: "api_key",
            provider: "custom-api-deepseek-com",
            key: "sk-default",
          },
        },
      }),
    );

    const store = ensureAuthProfileStore(agentDir);
    await fn({ agentDir, store });
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

describe("provider/model timeout cooldowns", () => {
  it("records and persists a short-lived timeout cooldown", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      const startedAt = Date.now();
      await markModelTimeoutCooldown({
        store,
        provider: "custom-api-deepseek-com",
        model: "deepseek-chat",
        profileId: "custom-api-deepseek-com:default",
        agentDir,
      });

      const key = resolveProviderModelCooldownKey("custom-api-deepseek-com", "deepseek-chat");
      const cooldown = store.modelTimeoutCooldowns?.[key];
      expect(typeof cooldown?.cooldownUntil).toBe("number");
      expect((cooldown?.cooldownUntil ?? 0) - startedAt).toBeGreaterThan(4.5 * 60 * 1000);
      expect((cooldown?.cooldownUntil ?? 0) - startedAt).toBeLessThan(5.5 * 60 * 1000);
      expect(cooldown?.lastProfileId).toBe("custom-api-deepseek-com:default");

      const reloaded = ensureAuthProfileStore(agentDir);
      expect(
        isProviderModelInTimeoutCooldown(
          reloaded,
          "custom-api-deepseek-com",
          "deepseek-chat",
          startedAt + 60_000,
        ),
      ).toBe(true);
    });
  });

  it("clears a model timeout cooldown after a later success", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      await markModelTimeoutCooldown({
        store,
        provider: "custom-api-deepseek-com",
        model: "deepseek-chat",
        agentDir,
      });

      await clearModelTimeoutCooldown({
        store,
        provider: "custom-api-deepseek-com",
        model: "deepseek-chat",
        agentDir,
      });

      expect(
        isProviderModelInTimeoutCooldown(store, "custom-api-deepseek-com", "deepseek-chat"),
      ).toBe(false);
      const reloaded = ensureAuthProfileStore(agentDir);
      expect(
        isProviderModelInTimeoutCooldown(reloaded, "custom-api-deepseek-com", "deepseek-chat"),
      ).toBe(false);
    });
  });

  it("drops expired timeout cooldown entries during runtime cleanup", async () => {
    await withAuthProfileStore(async ({ store }) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000_000);
        store.modelTimeoutCooldowns = {
          [resolveProviderModelCooldownKey("custom-api-deepseek-com", "deepseek-chat")]: {
            cooldownUntil: 1_010_000,
            lastTimeoutAt: 1_000_000,
          },
        };
        vi.setSystemTime(1_020_000);
        expect(clearExpiredModelTimeoutCooldowns(store)).toBe(true);
        expect(store.modelTimeoutCooldowns).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
