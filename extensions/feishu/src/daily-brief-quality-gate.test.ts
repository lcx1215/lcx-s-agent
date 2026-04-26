import { describe, expect, it } from "vitest";
import { applyFeishuDailyBriefQualityGate } from "./daily-brief-quality-gate.js";

describe("applyFeishuDailyBriefQualityGate", () => {
  it("blocks numeric market claims when the feed is degraded", () => {
    const result = applyFeishuDailyBriefQualityGate({
      text: `
## Control Summary
Today the market feed is degraded.
SPY 520.14 and VIX 27.4 both moved sharply.
`,
    });

    expect(result.dataFreshnessStatus).toBe("provisional");
    expect(result.text).toContain(
      "Exact prices, percentage moves, and VIX/DXY levels are withheld",
    );
    expect(result.text).not.toContain("520.14");
    expect(result.text).not.toContain("27.4");
  });

  it("treats empty yfinance output as data unavailable and blocks market claims", () => {
    const result = applyFeishuDailyBriefQualityGate({
      text: `
## Control Summary
yfinance returned empty for the current snapshot.
QQQ 441.20 and DXY 104.4 looked mixed.
`,
    });

    expect(result.dataFreshnessStatus).toBe("data_unavailable");
    expect(result.text).toContain("data unavailable");
    expect(result.text).not.toContain("441.20");
    expect(result.text).not.toContain("104.4");
  });

  it("blocks low-fidelity search earnings-date claims without official backing", () => {
    const result = applyFeishuDailyBriefQualityGate({
      text: `
## Control Summary
Web search low-fidelity today.
The company reports earnings on 2026-05-02 after the close.
`,
    });

    expect(result.sourceReliabilityStatus).toBe("low_fidelity");
    expect(result.text).toContain("Earnings-date or catalyst timing claims are withheld");
    expect(result.text).not.toContain("2026-05-02");
  });

  it("keeps previous memory critical alerts active without repair proof", () => {
    const result = applyFeishuDailyBriefQualityGate({
      text: `
## Control Summary
Today we focused on system health.
`,
      priorSurfaceLineContent: `
## Recent Turns
### 2026-04-16T12:00:00.000Z · msg-old
- Reply summary: memory 0 files/0 chunks; system critical.
`,
    });

    expect(result.unresolvedCriticalAlerts).toContain(
      "previous memory critical alert still active; no repair proof for zero-file/zero-chunk state.",
    );
    expect(result.text).toContain("Unresolved Critical Alerts");
  });

  it("marks learning radar stale when branch freshness is stale", () => {
    const result = applyFeishuDailyBriefQualityGate({
      text: `
## Control Summary
technical_daily_branch stale and knowledge_maintenance_branch stale.
`,
      validationWeeklySummary:
        "Validation radar: strongest bounded repair planning: factual 4.0/5, reasoning 4.0/5.",
    });

    expect(result.researchFreshnessStatus).toBe("stale");
    expect(result.text).toContain(
      "Branch freshness is not clean enough to label downstream research output as fresh.",
    );
  });

  it("sanitizes debug narration and chat residue", () => {
    const result = applyFeishuDailyBriefQualityGate({
      text: `
## Control Summary
Now I have enough signal to answer.
我的儿子们
机器人
w
System health remains provisional.
`,
    });

    expect(result.text).not.toContain("Now I have enough signal");
    expect(result.text).not.toContain("我的儿子们");
    expect(result.text).not.toContain("机器人");
    expect(result.text).not.toContain("\nw\n");
    expect(result.text).toContain("System health remains provisional.");
  });

  it("allows fresh timestamped numeric market claims", () => {
    const result = applyFeishuDailyBriefQualityGate({
      text: `
## Control Summary
Market data timestamp: 2026-04-17 09:30 ET.
SPY 520.14, QQQ 441.20, and VIX 17.3 are the current snapshot.
`,
    });

    expect(result.dataFreshnessStatus).toBe("verified");
    expect(result.text).toContain("520.14");
    expect(result.text).toContain("17.3");
  });

  it("allows official-source earnings-date claims", () => {
    const result = applyFeishuDailyBriefQualityGate({
      text: `
## Control Summary
Official IR earnings release verified.
The company reports earnings on 2026-05-02 after the close.
`,
    });

    expect(result.sourceReliabilityStatus).toBe("verified");
    expect(result.text).toContain("2026-05-02");
  });

  it("does not introduce trading, execution, or doctrine mutation language", () => {
    const result = applyFeishuDailyBriefQualityGate({
      text: `
## Control Summary
Market data timestamp: 2026-04-17 09:30 ET.
SPY 520.14 is the current snapshot.
`,
    });

    expect(result.text).not.toContain("execution approval");
    expect(result.text).not.toContain("auto-promote");
    expect(result.text).not.toContain("doctrine mutation");
    expect(result.text).not.toContain("buy now");
  });
});
