#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path.home() / "Projects/openclaw"

def write_safe_fallback(report_path, sources_path):
    report = """# Technical Daily Report - generated

## 1. Market Regime Snapshot
- Fallback report generated in no-Tavily safe mode.
- Command layer remains available; live retrieval is intentionally bypassed.

## 2. ETF Watchlist Observations
- SPY / QQQ / IWM / TLT / GLD watchlist remains configured.
- Retrieval-dependent enrichment can be restored after credits/provider recovery.

## 3. Momentum / Trend / Volatility Notes
- No validated live technical snapshot in this safe-mode run.

## 4. Execution Risk Notes
- No-Tavily safe mode is active.
- Priority is machine stability and non-recursive execution.

## 5. Risk Flags
- External retrieval provider unavailable or intentionally disabled.
- Live market narrative may be stale until provider is restored.

## 6. Branch Summary
- technical_daily_branch completed in safe local fallback mode.
"""
    sources = {
        "mode": "safe_no_tavily",
        "reason": "Tavily exhausted or disabled",
    }
    report_path.write_text(report, encoding="utf-8")
    sources_path.write_text(json.dumps(sources, ensure_ascii=False, indent=2), encoding="utf-8")

def main() -> int:
    target = ROOT / "scripts" / "run_technical_daily_direct.py"
    p = subprocess.run([sys.executable, str(target)], cwd=str(ROOT))
    return p.returncode

if __name__ == "__main__":
    raise SystemExit(main())
