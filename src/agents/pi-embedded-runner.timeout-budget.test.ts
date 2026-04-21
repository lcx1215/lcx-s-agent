import { describe, expect, it, vi } from "vitest";
import { _timeoutBudgetInternals } from "./pi-embedded-runner/run.js";

describe("embedded runner timeout budget", () => {
  it("splits timeout budget across remaining available profiles", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const authStore = {
        profiles: {
          "openai:p1": { provider: "openai" },
          "openai:p2": { provider: "openai" },
          "openai:p3": { provider: "openai" },
        },
        usageStats: {
          "openai:p2": { cooldownUntil: 20_000 },
        },
      };

      const first = _timeoutBudgetInternals.resolveRemainingProfileBudget({
        totalTimeoutMs: 6_000,
        startedAtMs: 10_000,
        profileIndex: 0,
        profileCandidates: ["openai:p1", "openai:p2", "openai:p3"],
        authStore: authStore as never,
      });
      expect(first.remainingProfiles).toBe(2);
      expect(first.attemptTimeoutMs).toBe(3_000);

      vi.setSystemTime(13_000);

      const second = _timeoutBudgetInternals.resolveRemainingProfileBudget({
        totalTimeoutMs: 6_000,
        startedAtMs: 10_000,
        profileIndex: 2,
        profileCandidates: ["openai:p1", "openai:p2", "openai:p3"],
        authStore: authStore as never,
      });
      expect(second.remainingProfiles).toBe(1);
      expect(second.remainingBudgetMs).toBe(3_000);
      expect(second.attemptTimeoutMs).toBe(3_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
