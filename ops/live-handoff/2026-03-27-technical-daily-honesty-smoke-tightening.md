# Technical Daily Honesty Smoke Tightening

- date: 2026-03-27
- status: live-hardened
- dev-fixed: yes
- live-fixed: no

## Exact Failure Mode

`technical_daily` mainline honesty had improved, but the branch smoke still did not assert the new contract.

That meant future regressions could silently remove:

- `Low-fidelity read:` on one or more ETF snapshot lines
- the prior-snapshot provenance note

while smoke still passed.

## Why Dangerous

- the honesty contract could regress without any automated signal
- the branch would look stable while becoming overconfident again

## Smallest Safe Patch

Live-only bounded patch in:

- `scripts/feishu_branch_smoke.py`

Changes:

- add required substrings for `technical_daily`
- assert all five ETF snapshot lines keep the `Low-fidelity read:` prefix
- assert the prior-snapshot provenance note remains present

## Proof Tests

- `bash lobster_command_v2.sh 技术日报`
- `python3 scripts/feishu_branch_smoke.py`

## What Is Now Prevented

- honesty regressions passing smoke unnoticed
- future changes restoring direct/fresh-sounding ETF snapshot language without detection

## What Remains Out Of Scope

- this does not improve source freshness or content richness
- it only makes the current honesty contract enforceable
