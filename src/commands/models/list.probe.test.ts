import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeProbeSummary, mapFailoverReasonToProbeStatus, probeTarget } from "./list.probe.js";

describe("mapFailoverReasonToProbeStatus", () => {
  it("maps auth_permanent to auth", () => {
    expect(mapFailoverReasonToProbeStatus("auth_permanent")).toBe("auth");
  });

  it("keeps existing failover reason mappings", () => {
    expect(mapFailoverReasonToProbeStatus("auth")).toBe("auth");
    expect(mapFailoverReasonToProbeStatus("rate_limit")).toBe("rate_limit");
    expect(mapFailoverReasonToProbeStatus("billing")).toBe("billing");
    expect(mapFailoverReasonToProbeStatus("timeout")).toBe("timeout");
    expect(mapFailoverReasonToProbeStatus("format")).toBe("format");
  });

  it("falls back to unknown for unrecognized values", () => {
    expect(mapFailoverReasonToProbeStatus(undefined)).toBe("unknown");
    expect(mapFailoverReasonToProbeStatus(null)).toBe("unknown");
    expect(mapFailoverReasonToProbeStatus("model_not_found")).toBe("unknown");
  });
});

describe("auth probe mode", () => {
  it("describes probe timing as raw-provider-preferred timing", () => {
    expect(
      describeProbeSummary({
        startedAt: 0,
        finishedAt: 123,
        durationMs: 123,
        totalTargets: 1,
        options: {
          timeoutMs: 45,
          concurrency: 1,
          maxTokens: 8,
          probeStrategy: "raw_provider_preferred",
          timeoutScope: "per_target_total",
        },
        results: [],
      }),
    ).toBe("Probed 1 auth target in 123ms (raw provider preferred)");
  });

  it("does not fall back to embedded-agent probing when raw probe config is unavailable", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-probe-test-"));
    const result = await probeTarget({
      cfg: { models: { providers: {} } },
      agentDir,
      timeoutMs: 1000,
      target: {
        provider: "unsupported-provider",
        model: { provider: "unsupported-provider", model: "model-a" },
        label: "env",
        source: "env",
        mode: "api_key",
      },
    });

    expect(result.status).toBe("unknown");
    expect(result.probeKind).toBe("raw_provider");
    expect(result.error).toContain("embedded-agent probe is intentionally not used");
  });
});
