import { describe, expect, it } from "vitest";
import type { PaperReport } from "../../paper-loop/report.ts";
import { buildAnalysisEnvelope } from "../../scripts/operator/paper-loop-analysis-cycle.ts";

const report = {
  schemaVersion: 1,
  generatedAt: "2026-09-16T00:00:00.000Z",
  mode: "quick",
  analyses: [
    {
      kind: "carry",
      ok: true,
      analysis: { kind: "carry", venue: "deribit", instrument: "BTC-PERP", verdictCode: "EDGE" },
    },
    { kind: "trend", ok: false, target: "ETHUSDT", error: "boom" },
  ],
  summary: {
    measured: 1,
    failed: 1,
    edgeCount: 1,
    noEdgeCount: 0,
    liquidatedIsolated: 0,
    spotLegLiquidated: 0,
    edges: [],
    conclusion: "synthetic",
  },
} as unknown as PaperReport;

describe("buildAnalysisEnvelope", () => {
  it("reports the lane duration it was given", () => {
    // The duration used to be accepted and dropped, leaving the envelope with a
    // hardcoded zero; the governance lane reports its own, so this lane must too.
    expect(buildAnalysisEnvelope(report, 1234).durationMs).toBe(1234);
  });

  it("keeps the rendered summary text for the measured and failed branches", () => {
    const envelope = buildAnalysisEnvelope(report, 0);
    expect(envelope.checks.map((check) => check.summary)).toEqual(["EDGE", "FAILED: boom"]);
  });

  it("names the carry check by venue and instrument", () => {
    const envelope = buildAnalysisEnvelope(report, 0);
    expect(envelope.checks[0].name).toBe("carry:deribit/BTC-PERP");
    expect(envelope.checks[1].name).toBe("trend:ETHUSDT");
  });

  it("marks the lane failed when no analysis was measured", () => {
    const allFailed = { ...report, analyses: [report.analyses[1]] } as unknown as PaperReport;
    const envelope = buildAnalysisEnvelope(allFailed, 5);

    expect(envelope.ok).toBe(false);
    expect(envelope.status).toBe("failed");
    expect(envelope.checkCount).toBe(1);
  });

  it("declares its boundary honestly", () => {
    // This lane fetches public market data and never touches an account, a
    // provider config, or protected memory. Reporting otherwise would be a lie.
    const envelope = buildAnalysisEnvelope(report, 0);

    expect(envelope.remoteFetchOccurred).toBe(true);
    expect(envelope.liveTouched).toBe(false);
    expect(envelope.providerConfigTouched).toBe(false);
    expect(envelope.protectedMemoryTouched).toBe(false);
    expect(envelope.executionAuthorityGranted).toBe(false);
  });
});
