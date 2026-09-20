---
summary: "CLI reference for `lcx config` (get/set/unset/file/validate)"
read_when:
  - You want to read or edit config non-interactively
title: "config"
---

# `lcx config`

Config helpers: get/set/unset/validate values by path and print the active
config file. Run without a subcommand to open
the configure wizard (same as `lcx configure`).

## Examples

```bash
lcx config file
lcx config get browser.executablePath
lcx config set browser.executablePath "/usr/bin/google-chrome"
lcx config set agents.defaults.heartbeat.every "2h"
lcx config set agents.list[0].tools.exec.node "node-id-or-name"
lcx config unset tools.web.search.apiKey
lcx config validate
lcx config validate --json
```

## Paths

Paths use dot or bracket notation:

```bash
lcx config get agents.defaults.workspace
lcx config get agents.list[0].id
```

Use the agent list index to target a specific agent:

```bash
lcx config get agents.list
lcx config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

Values are parsed as JSON5 when possible; otherwise they are treated as strings.
Use `--strict-json` to require JSON5 parsing. `--json` remains supported as a legacy alias.

```bash
lcx config set agents.defaults.heartbeat.every "0m"
lcx config set gateway.port 19001 --strict-json
lcx config set channels.whatsapp.groups '["*"]' --strict-json
```

## Subcommands

- `config file`: Print the active config file path (resolved from `OPENCLAW_CONFIG_PATH` or default location).

Restart the gateway after edits.

## Validate

Validate the current config against the active schema without starting the
gateway.

```bash
lcx config validate
lcx config validate --json
```
