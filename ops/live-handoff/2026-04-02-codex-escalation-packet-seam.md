# 2026-04-02 Codex Escalation Packet Seam

## Exact failure mode

- Lobster could already record repeated failures into watchtower anomalies and repair tickets.
- But there was no bounded, shared way to escalate the specific "I keep failing to edit or repair files" class of issue into a Codex-facing packet.
- That meant repeated write/edit failures and repeated artifact-integrity failures could stay inside Lobster's own control loop with no explicit operator-configured escape hatch.

## Why dangerous

- This traps Lobster in the same repair loop when the right move is to escalate to an external coding agent.
- Without a shared packet contract, any future "wake Codex" path would likely become ad hoc and drift across producers.
- The dangerous version would be silent self-modification; this patch avoids that by keeping the bridge explicit, narrow, and off by default.

## Smallest safe patch

- Added a shared `codex escalation packet` contract to `src/hooks/bundled/lobster-brain-registry.ts`.
- Added `src/infra/codex-escalation.ts`:
  - bounded category gate
  - packet writer
  - optional operator-configured external wake command
- Wired two real short-circuit classes into that seam:
  - repeated `write_edit_failure` from `correction-loop`
  - repeated `artifact_integrity` from `recordOperationalAnomaly`

## Files changed

- `src/hooks/bundled/lobster-brain-registry.ts`
- `src/infra/codex-escalation.ts`
- `src/infra/codex-escalation.test.ts`
- `src/infra/operational-anomalies.ts`
- `src/infra/operational-anomalies.test.ts`
- `src/hooks/bundled/correction-loop/handler.ts`
- `src/hooks/bundled/correction-loop/handler.test.ts`
- `memory/current_state.md`
- `ops/codex_handoff.md`

## Behavior change

- Repeated write/edit failures and repeated artifact-integrity failures now emit a shared packet under:
  - `bank/watchtower/codex-escalations/`
- Packet-only is the default.
- External wake happens only when the operator explicitly sets:
  - `OPENCLAW_CODEX_ESCALATION_COMMAND`
- The wake command receives packet metadata through env vars, including:
  - `OPENCLAW_CODEX_ESCALATION_PACKET_PATH`
  - `OPENCLAW_CODEX_ESCALATION_ISSUE_KEY`
  - `OPENCLAW_CODEX_ESCALATION_CATEGORY`
  - `OPENCLAW_CODEX_ESCALATION_SOURCE`

## Proof tests

- `corepack pnpm exec vitest run src/infra/codex-escalation.test.ts src/infra/operational-anomalies.test.ts src/hooks/bundled/correction-loop/handler.test.ts`
- `corepack pnpm exec oxlint src/infra/codex-escalation.ts src/infra/codex-escalation.test.ts src/infra/operational-anomalies.ts src/infra/operational-anomalies.test.ts src/hooks/bundled/correction-loop/handler.ts src/hooks/bundled/correction-loop/handler.test.ts src/hooks/bundled/lobster-brain-registry.ts`
- `git diff --check`

## Status

- `dev-fixed: yes`
- `live-fixed: no`

## Fixed Feishu acceptance phrase for later real verification

- `反馈：你还是无法保存文件，修改后没有真正落盘。`
