---
name: lark-post-migration-probe
description: Use after live-sidecar migration or daemon restart to prove whether a new real Lark/Feishu message reached the new runtime and produced fresh handoff, routing, work, and visible reply evidence.
---

# Lark Post-Migration Probe

Use this after the current communication adapter has been restarted. The
adapter, workspace, and log locations are runtime-profile inputs; this Skill
does not assume a particular Agent host, home directory, deployment name, or
transport implementation.

This Skill answers one question: did a fresh real Lark/Feishu message produce
fresh ingress artifacts after the supplied boundary time? It does not by itself
prove that a user saw the final reply.

## Workflow

1. Record the restart or migration boundary as an ISO-8601 timestamp.
2. Resolve the current runtime profile and export `LCX_WORKSPACE` and
   `LCX_GATEWAY_LOG` (or pass `--workspace` and `--gateway-log`).
3. Run `scripts/lark-post-migration-probe.sh --since <ISO timestamp>`.
4. Treat `post-migration-ingress-observed` as proven only when the probe finds
   fresh handoff, routing, and work artifacts using their internal timestamps.
5. Use the repository's external-channel owner to inspect a fresh outbound
   reply. Only that owner may report `user-visible-observed` after real inbound
   and outbound evidence; this probe never upgrades a synthetic replay or an
   old receipt.

The result vocabulary is deliberately bounded:

- `no-post-migration-ingress`: the runtime may be up, but no complete fresh
  ingress artifact chain was found.
- `post-migration-ingress-observed`: fresh handoff, routing, and work evidence
  was found.
- `blocked`: the runtime profile or required parser is unavailable.
- `user-visible-observed`: not emitted by this Skill; obtain it from the
  external-channel owner after fresh visible-reply evidence.

## Guardrails

- Feishu and Lark are the same surface.
- Do not backdate old receipts into fresh proof.
- Do not call synthetic replay user-visible proof.
- Do not print complete work receipts or gateway log lines; they may contain
  user content or secrets. The script prints paths and selected metadata only.

## Script

Resolve `SKILL_ROOT` from this loaded Skill's actual directory. Pass the verified workspace, gateway log and the real restart boundary to `bash "$SKILL_ROOT/scripts/lark-post-migration-probe.sh" --since "$RESTART_BOUNDARY"`. This helper supports the Lark handoff/routing/work schema it ships with; another entry/schema must use its own current owner rather than reinterpret missing files as failure of the entire system.
