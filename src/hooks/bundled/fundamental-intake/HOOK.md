---
name: fundamental-intake
description: "Turn natural-language fundamental research requests into a controlled intake spec and manifest scaffold"
homepage: https://docs.openclaw.ai/automation/hooks#fundamental-intake
metadata:
  {
    "openclaw":
      {
        "emoji": "🏢",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Fundamental Intake Hook

Converts natural-language fundamental research requests into a controlled intake specification and a manifest scaffold.

## What It Does

When you run `/new` or `/reset` after a fundamental-research planning session, this hook:

1. reads the current transcript
2. detects whether the session is about issuer or company research intake
3. infers a controlled intake spec
4. writes a reviewable manifest scaffold without pretending documents already exist

## Output

Writes these artifacts:

- `memory/YYYY-MM-DD-fundamental-intake-<slug>.md`
- `bank/fundamental/intakes/YYYY-MM-DD-fundamental-intake-<slug>.json`
- `bank/fundamental/manifests/YYYY-MM-DD-fundamental-manifest-<slug>.json`

## Guardrails

- No autonomous search
- No document fetching
- No fake evidence
- No fake local files
- No risk handoff until a human approves and real documents exist locally

## Example Requests

- `go read important giants' financial reports and research reports in China, the US, and Europe`
- `build a watchlist research scaffold for large-cap semis in the US and AI infrastructure names globally`
