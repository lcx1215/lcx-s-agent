---
title: "LCX Agent Operating Protocol"
summary: "What is actually the default working mode in the LCX Agent fork, and which parts are execution substrate versus operating layer."
read_when:
  - You want to understand the real default workflow of this repo
  - You want to know which LCX Agent advantages are already active
  - You want to distinguish the OpenClaw execution core from the optional Lobster runtime plugin
---

# LCX Agent Operating Protocol

This repo is not just "OpenClaw plus some ideas." It currently operates as:

- an **OpenClaw / Hermes-style execution substrate**
- with an **LCX Agent operating layer** for research discipline, learning carryover, protected summaries, and daily workface outputs

That distinction matters. The execution substrate and the operating layer are
not the same thing.

## Default Working Mode

The default path is:

1. The user speaks natural language in **one main control room**
2. The main OpenClaw agent handles the request through the normal agent runtime
3. Only explicit lifecycle commands such as `/new` and `/reset` switch reset lanes
4. Bundled LCX Agent hooks update protected summaries, learning carryover, and workface artifacts
5. The user-facing workface panel reflects the current bounded research state

This means the repo is optimized for one stable control room with internal
orchestration, not for many separate surfaces that the user has to remember.

## Execution Substrate: OpenClaw / Hermes-Style Agent

The active execution core is still the embedded OpenClaw agent runtime:

- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/system-prompt.ts`
- `src/agents/openclaw-tools.ts`

This layer provides the real runtime advantages:

- tool-driven execution instead of chat-only behavior
- strong session continuity
- multi-channel routing into one agent brain
- explicit tool policy boundaries
- subagent and session fan-out when needed

This is the part that actually "does the work."

## Lane Discipline: Natural Language Stays In The Main Lane

The most important control-room safeguard is in:

- `extensions/feishu/src/feishu-command-handler.ts`

Normal natural language stays untouched. Only explicit slash commands enter
reset handling. This prevents ordinary turns like "继续" from silently jumping
across workflow lanes.

That is a real product advantage, not a prompt wish:

- control-room continuity is preserved in code
- lane switching requires an explicit operator action
- ambiguous chat text does not get treated as lifecycle control

## LCX Agent Operating Layer: What Is Already Real

The LCX Agent layer is already active in the bundled hooks and workface tooling:

- `src/hooks/bundled/operating-loop/handler.ts`
- `src/hooks/bundled/learning-review-bootstrap/handler.ts`
- `src/agents/tools/lobster-workface-app-tool.ts`
- `apps/macos/Sources/OpenClaw/LobsterWorkfacePanel.swift`

This layer contributes the real LCX Agent advantages:

- protected high-level summaries
- learning carryover into future work
- daily workface / dashboard artifacts
- honest empty states instead of fake success
- a research operating system shape instead of pure chat transcripts

## Protected Summary Contract

The protected top-level state is centered on:

- `memory/current-research-line.md`
- `memory/unified-risk-view.md`

`src/hooks/bundled/operating-loop/handler.ts` treats these as protected summary
artifacts and guards against stale or conflicting overwrites.

This is a real advantage because it prevents the active research line from
being silently replaced by noisy or stale context.

## Learning Carryover Contract

`src/hooks/bundled/learning-review-bootstrap/handler.ts` does not merely load
old notes. It derives active cues from recent learning artifacts, including:

- learning upgrade
- durable skills
- trigger map
- rehearsal queue
- transfer bridges
- relevance gate
- latest lobster workface carryover

This means LCX Agent learning is not just archival. It is used to shape later
agent behavior and later control-room answers.

## Workface Contract

The user-facing workface is real, not theoretical:

- `src/agents/tools/lobster-workface-app-tool.ts`
- `apps/macos/Sources/OpenClaw/LobsterWorkfacePanel.swift`

The workface layer follows a hardening rule:

- if the daily workface artifact exists, render it
- if it does not exist, fall back honestly
- if even fallback state is missing or malformed, show an honest empty state

The system does not invent a fake dashboard to look impressive.

## What The Optional Lobster Plugin Does Not Mean Here

Lobster also exists as a separate optional workflow plugin:

- `extensions/lobster/src/lobster-tool.ts`
- `extensions/lobster/README.md`

That plugin is **optional**, not the default execution backbone. It provides:

- typed JSON-first workflow envelopes
- local subprocess execution
- approvals and resume flow

It is valuable, but it is not the same as the default LCX Agent operating layer.

So the correct distinction is:

- **Lobster runtime plugin**: optional
- **LCX Agent operating protocol**: already active in the default repo workflow

## Honest Boundaries

Some limits remain important:

- The main execution substrate is still OpenClaw, not the optional Lobster plugin runtime.
- Direct-message session isolation is not fully per-conversation by default; `src/routing/session-key.ts` defaults DM scope to `main` unless configured otherwise.
- The repo contains many local scripts and experiments, but the default working mode should be inferred from the bundled hooks, protected summaries, agent runtime, and workface surfaces first.

## Short Version

The most accurate summary is:

- **OpenClaw / Hermes-style agent** provides the execution substrate
- **LCX Agent** provides the operating protocol, learning spine, and workface discipline

That is the current default working mode of this fork.
