## 2026-03-27 Technical Daily Structured Asset Frame

- Scope: live `technical_daily` report structure only
- Status:
  - `dev-fixed: yes`
  - `live-fixed: no`

### Failure mode

`technical_daily` had become honest and safe, but it still read like cautious market commentary rather than a structured branch artifact.

The main weaknesses were:

- no unified freshness / fidelity block
- no explicit top market tensions
- no fixed technical frame per ETF
- no invalidation conditions
- too much narrative, not enough auditable structure

### Bounded patch

- kept the same stable direct runner and source-loading path
- did not change retrieval / provider / recursion hardening
- changed the report body to add:
  - `Data Freshness / Fidelity`
  - `Top Market Tensions`
  - `Structured ETF Read`
    - `Trend`
    - `Momentum`
    - `Volatility`
    - `Key watch`
    - `Confidence`
    - `Invalidation`
- kept existing momentum notes, execution-risk notes, and risk flags
- updated `feishu_branch_smoke.py` to lock the new report contract

### Proof

- `python3 scripts/test_technical_daily_asset_extraction.py`
- `python3 -m py_compile scripts/run_technical_daily_direct.py scripts/test_technical_daily_asset_extraction.py`
- `python3 scripts/run_technical_daily_direct.py`
- `python3 scripts/feishu_branch_smoke.py`

### Result

`technical_daily` now reads more like a branch report and less like a soft market-commentary paragraph dump.

It is still:

- prior-snapshot derived
- low-confidence
- stable-direct mode

but now it is also:

- more structured
- more comparable day to day
- easier to audit and review

### Out of scope

- no fresh retrieval improvement
- no richer live pipeline reattachment
- no branch promotion to `live-fixed`
