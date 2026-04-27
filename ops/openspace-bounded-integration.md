# OpenSpace Bounded Integration

## Purpose

This repo treats OpenSpace as an **optional skill-engine layer**, not as the primary brain or control plane.

## Guardrails

- keep OpenSpace optional and off by default
- keep CLI and built-in local tools primary
- use MCP only as the adapter seam
- default to local-only skill evolution
- do not enable cloud skill sharing unless the operator explicitly asks
- isolate writes to a dedicated OpenSpace skills/workspace area
- do not let OpenSpace write:
  - `memory/current-research-line.md`
  - `memory/unified-risk-view.md`
  - doctrine files such as `AGENTS.md`
  - core risk or control summaries

## Suggested MCP Shape

```json
{
  "mcpServers": {
    "openspace": {
      "command": "openspace-mcp",
      "env": {
        "OPENSPACE_HOST_SKILL_DIRS": "./skills/openspace",
        "OPENSPACE_WORKSPACE": "./.openspace"
      }
    }
  }
}
```

## Recommended Usage

- use OpenSpace for reusable workflow skills
- use it for coding/ops/browser/task patterns
- do not let it directly author durable investment conclusions
- do not let it directly rewrite protected memory

## Verification Surface

- `src/agents/tools/mcp-context-tool.ts`
- `src/agents/tools/mcp-context-tool.test.ts`
- `src/agents/system-prompt.ts`
- `src/agents/system-prompt.test.ts`
