# Bundled Hooks

This directory contains hooks that ship with OpenClaw. These hooks are automatically discovered and can be enabled/disabled via CLI or configuration.

## Available Hooks

### OpenClaw Core Hooks

### 💾 session-memory

Automatically saves session context to memory when you issue `/new` or `/reset`.

**Events**: `command:new`, `command:reset`
**What it does**: Creates a dated memory file with LLM-generated slug based on conversation content.
**Output**: `<workspace>/memory/YYYY-MM-DD-slug.md` (defaults to `~/.openclaw/workspace`)

**Enable**:

```bash
openclaw hooks enable session-memory
```

### Lobster Overlay Hooks

These hooks are local Lobster overlays on top of the upstream bundled-hook surface. They extend the built-in memory/research pipeline but are not currently part of upstream OpenClaw.

### 🧠 learning-review

Automatically saves a structured learning review note when a study-heavy session resets.

**Events**: `command:new`, `command:reset`
**What it does**: Detects study/math-style sessions and writes a compact review note with mistake pattern, principle, micro-drill, and transfer hint.
**Output**: `<workspace>/memory/YYYY-MM-DD-review-<slug>.md`

**Enable**:

```bash
openclaw hooks enable learning-review
```

### 🧪 frontier-research

Automatically saves a structured frontier research card when a paper or method-heavy session resets.

**Events**: `command:new`, `command:reset`
**What it does**: Detects paper or method-style sessions and writes a compact research card with method family, claimed contribution, data setup, evaluation protocol, key results, leakage risk, overfitting risk, adoptable ideas, and a verdict.
**Output**: `<workspace>/memory/YYYY-MM-DD-frontier-research-<slug>.md`

**Enable**:

```bash
openclaw hooks enable frontier-research
```

### 🏢 fundamental-intake

Automatically saves a controlled fundamental research intake note and manifest scaffold when an issuer/company research planning session resets.

**Events**: `command:new`, `command:reset`
**What it does**: Detects fundamental research planning requests, infers a structured intake spec, writes a memory note, and generates manifest-first scaffold JSON files under `bank/fundamental/`, including a document naming pattern and `.meta.json` sidecar convention for later readiness checks.
**Output**: `<workspace>/memory/YYYY-MM-DD-fundamental-intake-<slug>.md`, `<workspace>/bank/fundamental/intakes/*.json`, `<workspace>/bank/fundamental/manifests/*.json`

**Enable**:

```bash
openclaw hooks enable fundamental-intake
```

### 🧱 fundamental-manifest-bridge

Automatically upgrades local fundamental manifests from scaffold-only objects into explicit readiness state.

**Events**: `command:new`, `command:reset`
**What it does**: Scans `bank/fundamental/manifests/*.json`, inspects only the local document workspace referenced by each manifest, prefers `.meta.json` sidecars over filename heuristics when classifying documents, updates readiness fields in place, and writes a readiness sidecar plus memory note.
**Output**: updated `<workspace>/bank/fundamental/manifests/*.json`, `<workspace>/bank/fundamental/readiness/*.json`, `<workspace>/memory/YYYY-MM-DD-fundamental-readiness-<manifest-id>.md`

**Enable**:

```bash
openclaw hooks enable fundamental-manifest-bridge
```

### 📦 fundamental-snapshot-bridge

Automatically emits minimal fundamental snapshot-input artifacts from local manifest and readiness state.

**Events**: `command:new`, `command:reset`
**What it does**: Reads `bank/fundamental/manifests/*.json` plus `bank/fundamental/readiness/*.json`, determines which named targets satisfy minimum snapshot-entry conditions, and writes a snapshot-input sidecar plus a memory note with ready vs blocked targets.
**Output**: `<workspace>/bank/fundamental/snapshot-inputs/*.json`, `<workspace>/memory/YYYY-MM-DD-fundamental-snapshot-bridge-<manifest-id>.md`

**Enable**:

```bash
openclaw hooks enable fundamental-snapshot-bridge
```

### 🪪 fundamental-snapshot

Automatically materializes a minimal `fundamental_snapshot` from manifest, readiness, and snapshot-input artifacts.

**Events**: `command:new`, `command:reset`
**What it does**: Reads local manifest/readiness/snapshot-input artifacts, summarizes target-level document and source coverage, marks evidence readiness level plus scoring gate state, and writes a minimal `fundamental_snapshot` JSON plus memory note.
**Output**: `<workspace>/bank/fundamental/snapshots/*.json`, `<workspace>/memory/YYYY-MM-DD-fundamental-snapshot-<manifest-id>.md`

**Enable**:

```bash
openclaw hooks enable fundamental-snapshot
```

### 🚧 fundamental-scoring-gate

Automatically materializes a minimal downstream scoring-gate input from local `fundamental_snapshot` artifacts.

**Events**: `command:new`, `command:reset`
**What it does**: Reads `bank/fundamental/snapshots/*.json`, converts target-level snapshot states into explicit blocked/partial/allowed scoring decisions, preserves fallback exposure and missing critical inputs, and writes a structured scoring-gate JSON plus a memory note.
**Output**: `<workspace>/bank/fundamental/scoring-gates/*.json`, `<workspace>/memory/YYYY-MM-DD-fundamental-scoring-gate-<manifest-id>.md`

**Enable**:

```bash
openclaw hooks enable fundamental-scoring-gate
```

### 🛂 fundamental-risk-handoff

Automatically materializes a minimal downstream risk-handoff artifact from local `fundamental-scoring-gate` artifacts.

**Events**: `command:new`, `command:reset`
**What it does**: Reads `bank/fundamental/scoring-gates/*.json`, converts target-level scoring decisions into explicit handoff decisions for later controlled risk-review consumers, preserves fallback exposure and missing critical inputs, and writes a structured risk-handoff JSON plus a memory note.
**Output**: `<workspace>/bank/fundamental/risk-handoffs/*.json`, `<workspace>/memory/YYYY-MM-DD-fundamental-risk-handoff-<manifest-id>.md`

**Enable**:

```bash
openclaw hooks enable fundamental-risk-handoff
```

### 🧭 fundamental-review-queue

Automatically materializes a research-only downstream decision queue from local `fundamental-risk-handoff` artifacts.

**Events**: `command:new`, `command:reset`
**What it does**: Reads `bank/fundamental/risk-handoffs/*.json`, converts target-level handoff decisions into watchlist candidates, blocked targets, follow-up tasks, missing-document requests, and review priority ranking, then writes a structured review-queue JSON plus a memory note.
**Output**: `<workspace>/bank/fundamental/review-queues/*.json`, `<workspace>/memory/YYYY-MM-DD-fundamental-review-queue-<manifest-id>.md`

**Enable**:

```bash
openclaw hooks enable fundamental-review-queue
```

### 🧩 learning-review-bootstrap

Injects recent learning review notes into bootstrap context for future study sessions.

**Events**: `agent:bootstrap`
**What it does**: Prioritizes the latest `learning-upgrade` prompt, then the latest weekly summary, then recent raw review notes in `memory/`, and injects them as a compact study-memory block.
**Output**: No files written; context is modified in-memory only.

**Enable**:

```bash
openclaw hooks enable learning-review-bootstrap
```

### 🗂️ frontier-research-bootstrap

Injects recent frontier research cards and weekly methods reviews into bootstrap context for later method sessions.

**Events**: `agent:bootstrap`
**What it does**: Prioritizes the latest `frontier-upgrade` prompt, then the latest weekly methods review, then the latest replication backlog, then recent raw frontier research cards in `memory/`, and injects them as a compact research-memory block.
**Output**: No files written; context is modified in-memory only.

**Enable**:

```bash
openclaw hooks enable frontier-research-bootstrap
```

### 🗓️ learning-review-weekly

Builds a weekly study summary from recent learning-review notes.

**Events**: `command:new`, `command:reset`
**What it does**: Aggregates recent review notes into a weekly summary and a shorter learning-upgrade prompt with recurring mistakes, reinforced principles, and next drills.
**Output**: `<workspace>/memory/YYYY-Www-learning-weekly-review.md`, `<workspace>/memory/YYYY-Www-learning-upgrade.md`

**Enable**:

```bash
openclaw hooks enable learning-review-weekly
```

### 📚 frontier-research-weekly

Builds a weekly methods review from recent frontier research cards.

**Events**: `command:new`, `command:reset`
**What it does**: Aggregates recent frontier research cards into a weekly methods review with verdict counts, method families, cross-paper patterns, and replication candidates, and also writes a short `frontier-upgrade` prompt plus a frontier replication backlog note.
**Output**: `<workspace>/memory/YYYY-Www-frontier-methods-weekly-review.md`, `<workspace>/memory/YYYY-Www-frontier-upgrade.md`, `<workspace>/memory/YYYY-Www-frontier-replication-backlog.md`

**Enable**:

```bash
openclaw hooks enable frontier-research-weekly
```

### OpenClaw Core Hooks (continued)

### 📎 bootstrap-extra-files

Injects extra bootstrap files (for example monorepo `AGENTS.md`/`TOOLS.md`) during prompt assembly.

**Events**: `agent:bootstrap`
**What it does**: Expands configured workspace glob/path patterns and appends matching bootstrap files to injected context.
**Output**: No files written; context is modified in-memory only.

**Enable**:

```bash
openclaw hooks enable bootstrap-extra-files
```

### 📝 command-logger

Logs all command events to a centralized audit file.

**Events**: `command` (all commands)
**What it does**: Appends JSONL entries to command log file.
**Output**: `~/.openclaw/logs/commands.log`

**Enable**:

```bash
openclaw hooks enable command-logger
```

### 🚀 boot-md

Runs `BOOT.md` whenever the gateway starts (after channels start).

**Events**: `gateway:startup`
**What it does**: Executes BOOT.md instructions via the agent runner.
**Output**: Whatever the instructions request (for example, outbound messages).

**Enable**:

```bash
openclaw hooks enable boot-md
```

## Hook Structure

Each hook is a directory containing:

- **HOOK.md**: Metadata and documentation in YAML frontmatter + Markdown
- **handler.ts**: The hook handler function (default export)

Example structure:

```
session-memory/
├── HOOK.md          # Metadata + docs
└── handler.ts       # Handler implementation
```

## HOOK.md Format

```yaml
---
name: my-hook
description: "Short description"
homepage: https://docs.openclaw.ai/automation/hooks#my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---
# Hook Title

Documentation goes here...
```

### Metadata Fields

- **emoji**: Display emoji for CLI
- **events**: Array of events to listen for (e.g., `["command:new", "session:start"]`)
- **requires**: Optional requirements
  - **bins**: Required binaries on PATH
  - **anyBins**: At least one of these binaries must be present
  - **env**: Required environment variables
  - **config**: Required config paths (e.g., `["workspace.dir"]`)
  - **os**: Required platforms (e.g., `["darwin", "linux"]`)
- **install**: Installation methods (for bundled hooks: `[{"id":"bundled","kind":"bundled"}]`)

## Creating Custom Hooks

To create your own hooks, place them in:

- **Workspace hooks**: `<workspace>/hooks/` (highest precedence)
- **Managed hooks**: `~/.openclaw/hooks/` (shared across workspaces)

Custom hooks follow the same structure as bundled hooks.

## Managing Hooks

List all hooks:

```bash
openclaw hooks list
```

Show hook details:

```bash
openclaw hooks info session-memory
```

Check hook status:

```bash
openclaw hooks check
```

Enable/disable:

```bash
openclaw hooks enable session-memory
openclaw hooks disable command-logger
```

## Configuration

Hooks can be configured in `~/.openclaw/openclaw.json`:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": {
          "enabled": true
        },
        "command-logger": {
          "enabled": false
        }
      }
    }
  }
}
```

## Event Types

Currently supported events:

- **command**: All command events
- **command:new**: `/new` command specifically
- **command:reset**: `/reset` command
- **command:stop**: `/stop` command
- **agent:bootstrap**: Before workspace bootstrap files are injected
- **gateway:startup**: Gateway startup (after channels start)

More event types coming soon (session lifecycle, agent errors, etc.).

## Handler API

Hook handlers receive an `InternalHookEvent` object:

```typescript
interface InternalHookEvent {
  type: "command" | "session" | "agent" | "gateway";
  action: string; // e.g., 'new', 'reset', 'stop'
  sessionKey: string;
  context: Record<string, unknown>;
  timestamp: Date;
  messages: string[]; // Push messages here to send to user
}
```

Example handler:

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const myHandler: HookHandler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // Your logic here
  console.log("New command triggered!");

  // Optionally send message to user
  event.messages.push("✨ Hook executed!");
};

export default myHandler;
```

## Testing

Test your hooks by:

1. Place hook in workspace hooks directory
2. Restart gateway: `pkill -9 -f 'openclaw.*gateway' && pnpm openclaw gateway`
3. Enable the hook: `openclaw hooks enable my-hook`
4. Trigger the event (e.g., send `/new` command)
5. Check gateway logs for hook execution

## Documentation

Full documentation: https://docs.openclaw.ai/automation/hooks
