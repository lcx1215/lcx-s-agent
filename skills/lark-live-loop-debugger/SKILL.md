---
name: lark-live-loop-debugger
description: "Debug LCX Feishu/Lark ingress, routing and visible reply using the current communication profile and channel owner; no fixed workspace, gateway or retired CLI assumption."
metadata: { "openclaw": { "emoji": "🧩" } }
---

# Lark Live Loop Debugger

Feishu and Lark identify the same communication adapter. Read the [runtime contract](../_shared/lcx-runtime-contract.md).

1. Resolve the configured adapter, ingress/outbound processes, entry, workspace/state root and receipt/log paths from current configuration and the nearest runbook. Do not presume a daemon, sidecar or home-directory location.
2. Inspect fresh local receipts and the current adapter diagnostics. The existing status owner is `scripts/operator/lcx-external-channel-status.ts --json`; inspect its options and downstream behavior first, since a legacy binding owner may conditionally probe a channel. Run it only within the relevant profile and probe scope.
3. A channel probe is a separate scoped external action. Use the current owner's documented probe only when authorized; do not infer a `serve` channel from `gateway` status.
4. Trace fresh inbound identity → routing/work receipt → sender result → visible observation. Local replay and old reply logs do not prove that the user saw a reply.
5. Label core-ready, external-channel-bound and user-visible-observed independently, with the first failing seam and its owner.

Do not use a retired capabilities subcommand, hardcoded old logs, synthetic timestamps or a stale sender as current evidence. Patches, sender restarts and external messages require their current task scope; diagnosis alone does not grant them.
