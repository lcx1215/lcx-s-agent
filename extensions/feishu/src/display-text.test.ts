import { describe, expect, it } from "vitest";
import { normalizeFeishuDisplayText } from "./display-text.js";

describe("normalizeFeishuDisplayText daily brief quality gate", () => {
  it("blocks numeric market claims when the feed is degraded", () => {
    const result = normalizeFeishuDisplayText(`
## Daily Brief
Market data degraded today.
SPY 520.14 and VIX 27.4 both moved sharply.
`);

    expect(result).toContain("Data freshness status: provisional.");
    expect(result).toContain(
      "Exact prices, percentage moves, and VIX/DXY levels are withheld because market data is degraded, stale, or lacks an explicit timestamp.",
    );
    expect(result).not.toContain("520.14");
    expect(result).not.toContain("27.4");
  });

  it("treats empty yfinance output as data unavailable", () => {
    const result = normalizeFeishuDisplayText(`
## Daily Brief
yfinance returned empty for the current snapshot.
QQQ 441.20 and DXY 104.4 looked mixed.
`);

    expect(result).toContain("Data freshness status: data unavailable.");
    expect(result).not.toContain("441.20");
    expect(result).not.toContain("104.4");
  });

  it("blocks weak-search earnings dates without official backing", () => {
    const result = normalizeFeishuDisplayText(`
## Daily Brief
Web search low-fidelity today.
The company reports earnings on 2026-05-02 after the close.
`);

    expect(result).toContain("Source reliability status: low-fidelity / provisional.");
    expect(result).toContain(
      "Earnings-date or catalyst timing claims are withheld until an official IR / exchange / filing source is cited.",
    );
    expect(result).not.toContain("2026-05-02");
  });

  it("allows official-source earnings dates", () => {
    const result = normalizeFeishuDisplayText(`
## Daily Brief
Official IR earnings release verified.
The company reports earnings on 2026-05-02 after the close.
`);

    expect(result).toContain("2026-05-02");
    expect(result).not.toContain(
      "withheld until an official IR / exchange / filing source is cited",
    );
  });

  it("marks stale branch output as provisional", () => {
    const result = normalizeFeishuDisplayText(`
## Daily Brief
technical_daily_branch stale and knowledge_maintenance_branch stale.
Learning radar remains useful but not freshly verified.
`);

    expect(result).toContain("Research freshness status: stale.");
    expect(result).toContain(
      "Branch freshness is not clean enough to label downstream research output as fresh.",
    );
  });

  it("sanitizes debug narration and chat residue", () => {
    const result = normalizeFeishuDisplayText(`
## Daily Brief
Now I have enough signal to answer.
我的儿子们
机器人
w
Operational health remains provisional.
`);

    expect(result).not.toContain("Now I have enough signal");
    expect(result).not.toContain("我的儿子们");
    expect(result).not.toContain("机器人");
    expect(result).not.toContain("\nw\n");
    expect(result).toContain("Operational health remains provisional.");
  });

  it("allows fresh timestamped market claims", () => {
    const result = normalizeFeishuDisplayText(`
## Daily Brief
Market data timestamp: 2026-04-17 09:30 ET.
SPY 520.14, QQQ 441.20, and VIX 17.3 are the current snapshot.
`);

    expect(result).toContain("520.14");
    expect(result).toContain("17.3");
    expect(result).not.toContain("Exact prices, percentage moves, and VIX/DXY levels are withheld");
  });

  it("rewrites green-light setup into bounded research language", () => {
    const result = normalizeFeishuDisplayText(`
## Daily Brief
Market data degraded today.
VIX compression and small-cap leadership is a green-light setup.
`);

    expect(result).not.toContain("green-light setup");
    expect(result).toContain("research-positive condition requiring verification");
    expect(result).toContain(
      "Directional finance language remains provisional, research-only, and not an execution signal.",
    );
  });

  it("rewrites buy sell entry and exit signal language", () => {
    const result = normalizeFeishuDisplayText(`
## Daily Brief
Market data degraded today.
SPY shows a buy signal while QQQ flashes an exit signal.
`);

    expect(result).not.toContain("buy signal");
    expect(result).not.toContain("exit signal");
    expect(result).toContain("watchlist condition requiring verification");
    expect(result).toContain(
      "Directional finance language remains provisional, research-only, and not an execution signal.",
    );
  });

  it("blocks leverage-up go-long and short-this wording", () => {
    const result = normalizeFeishuDisplayText(`
## Daily Brief
Market data degraded today.
Go long IWM, leverage up, and short this if breadth fades.
`);

    expect(result).not.toContain("Go long");
    expect(result).not.toContain("leverage up");
    expect(result).not.toContain("short this");
    expect(result).toContain("treat as a watchlist condition");
    expect(result).toContain("do not escalate exposure without further review");
    expect(result).toContain(
      "Directional finance language remains provisional, research-only, and not an execution signal.",
    );
  });

  it("rewrites sensible move and follow-through entry into research language", () => {
    const result = normalizeFeishuDisplayText(`
## Daily Brief
Market data degraded today.
VIX compression and small-cap leadership persists. Sensible move: monitor IWM relative strength for a potential follow-through entry.
`);

    expect(result).not.toContain("Sensible move:");
    expect(result).not.toContain("follow-through entry");
    expect(result).toContain("bounded follow-up:");
    expect(result).toContain("follow-through watchlist condition");
    expect(result).toContain(
      "Directional finance language remains provisional, research-only, and not an execution signal.",
    );
  });

  it("rewrites defensive ETF positioning into watchlist language", () => {
    const result = normalizeFeishuDisplayText(`
## Daily Brief
Market data degraded today.
No clear long signals; defensive ETF positioning is appropriate.
`);

    expect(result).not.toContain("No clear long signals");
    expect(result).not.toContain("defensive ETF positioning is appropriate");
    expect(result).toContain("no clear research-positive conditions yet");
    expect(result).toContain(
      "watchlist posture for verification; allocation implications require human review",
    );
    expect(result).toContain(
      "Directional finance language remains provisional, research-only, and not an execution signal.",
    );
  });

  it("rewrites tactical portfolio stress test into review language", () => {
    const result = normalizeFeishuDisplayText(`
## Daily Brief
Market data degraded today.
Run tactical portfolio stress test before the close.
`);

    expect(result).not.toContain("Run tactical portfolio stress test");
    expect(result).toContain("review this portfolio risk scenario");
    expect(result).toContain(
      "Directional finance language remains provisional, research-only, and not an execution signal.",
    );
  });

  it("rewrites exposure and rotation wording", () => {
    const result = normalizeFeishuDisplayText(`
## Daily Brief
Market data degraded today.
Reduced equity exposure is prudent. Increase exposure only if breadth improves. Rotate into defensive ETFs and rotate out of cyclical sector risk.
`);

    expect(result).not.toContain("Reduced equity exposure");
    expect(result).not.toContain("Increase exposure");
    expect(result).not.toContain("Rotate into");
    expect(result).not.toContain("rotate out of");
    expect(result).toContain("a reduced-equity watchlist posture for verification");
    expect(result).toContain("review whether higher exposure is warranted");
    expect(result).toContain("place on the watchlist for further review instead of rotating into");
    expect(result).toContain(
      "place on the watchlist for further review instead of rotating out of",
    );
    expect(result).toContain(
      "Directional finance language remains provisional, research-only, and not an execution signal.",
    );
  });

  it("rewrites hedge and trim-risk imperatives", () => {
    const result = normalizeFeishuDisplayText(`
## Daily Brief
Market data degraded today.
Add hedges now and trim risk now if the tape weakens.
`);

    expect(result).not.toContain("Add hedges now");
    expect(result).not.toContain("trim risk now");
    expect(result).toContain("hedge implications require human review");
    expect(result).toContain("risk reduction implications require human review");
    expect(result).toContain(
      "Directional finance language remains provisional, research-only, and not an execution signal.",
    );
  });

  it("leaves neutral research language unchanged", () => {
    const result = normalizeFeishuDisplayText(`
## Daily Brief
Market data timestamp: 2026-04-17 09:30 ET.
Small-cap leadership remains a research-positive condition for further review.
`);

    expect(result).toContain("research-positive condition for further review");
    expect(result).not.toContain("Directional finance language remains provisional");
  });

  it("does not rewrite non-finance messages without trading language", () => {
    const result = normalizeFeishuDisplayText(`
## Team Update
Green light setup complete for the office migration checklist.
Documentation remains on track.
`);

    expect(result).toContain("Green light setup complete for the office migration checklist.");
  });

  it("does not introduce trading or execution claims", () => {
    const result = normalizeFeishuDisplayText(`
## Daily Brief
Market data degraded today.
SPY 520.14 is the current snapshot.
This looks like an actionable setup and we should position now.
`);

    expect(result).not.toContain("execution approval");
    expect(result).not.toContain("auto-promote");
    expect(result).not.toContain("doctrine mutation");
    expect(result).not.toContain("buy now");
    expect(result).not.toContain("actionable setup");
    expect(result).not.toContain("position now");
    expect(result).toContain("candidate for further review");
  });

  it("blocks real delivered provisional market numbers and earnings rows while rewriting verdict tone", () => {
    const result = normalizeFeishuDisplayText(`
**🦐 Lobster Control Room — Daily Brief | Sat Apr 18, 2026 | 17:48 ET**

**📊 MARKET / RISK PICTURE**
Risk-on tone today. Broad-based rally across equities with small-caps leading (IWM +2.16%). VIX at 17.48.
- SPY 710.14 (+1.21%) — holding above prior range lows, no breakdown
- EEM 63.64 (+1.91%) — emerging markets participating
- 10Y Yield 4.246% — still elevated; rate sensitivity remains live

Verdict: Broad risk-on. Low VIX + strong breadth = benign for equities near-term.

**📅 EARNINGS WATCH — HIGH PRIORITY WEEK**
Big week ahead. All five megacap earnings clustered Apr 29–30, TSLA Apr 22:
| Ticker | Date | Avg EPS | Revenue Avg | Consensus Read |
|--------|------|---------|-------------|----------------|
| TSLA | Apr 22 | $0.36 | $22.3B | Low bar, watch delivery numbers |
| MSFT | Apr 29 | $4.07 | $81.4B | Cloud strong, AI capex in focus |

Priority reading: Focus on MSFT and GOOGL for AI revenue conversion signals.
`);

    expect(result).toContain("Data freshness status: provisional.");
    expect(result).toContain("Source reliability status: provisional.");
    expect(result).toContain(
      "Exact prices, percentage moves, and VIX/DXY levels are withheld because market data is degraded, stale, or lacks an explicit timestamp.",
    );
    expect(result).toContain(
      "Earnings-date or catalyst timing claims are withheld until an official IR / exchange / filing source is cited.",
    );
    expect(result).not.toContain("710.14");
    expect(result).not.toContain("63.64");
    expect(result).not.toContain("4.246%");
    expect(result).not.toContain("Apr 29");
    expect(result).not.toContain("Apr 22");
    expect(result).not.toContain("Broad risk-on");
    expect(result).not.toContain("benign for equities near-term");
    expect(result).toContain("research-only broad risk-on condition");
    expect(result).toContain(
      "a research-positive condition requiring verification, not an execution signal",
    );
    expect(result).toContain(
      "Directional finance language remains provisional, research-only, and not an execution signal.",
    );
  });
});
