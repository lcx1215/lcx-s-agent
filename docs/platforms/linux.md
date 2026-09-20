---
summary: "Linux support and Gateway install"
read_when:
  - Running the Gateway on Linux
  - Planning platform coverage or contributions
title: "Linux"
---

# Linux

The Gateway is fully supported on Linux. **Node is the recommended runtime**.
Bun is not recommended for the Gateway (WhatsApp/Telegram bugs).

There is no native companion app; you reach the Gateway from a browser or an
existing chat channel.

## Beginner quick path (VPS)

1. Install Node 22+
2. `npm i -g openclaw@latest`
3. `lcx onboard --install-daemon`
4. From your laptop: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. Open `http://127.0.0.1:18789/` and paste your token

Step-by-step VPS guide: [exe.dev](/install/exe-dev)

## Install

- [Getting Started](/start/getting-started)
- [Install & updates](/install/updating)
- Optional flows: [Bun (experimental)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [Gateway runbook](/gateway)
- [Configuration](/gateway/configuration)

## Gateway service install (CLI)

Use one of these:

```
lcx onboard --install-daemon
```

Or:

```
lcx gateway install
```

Or:

```
lcx configure
```

Select **Gateway service** when prompted.

Repair/migrate:

```
lcx doctor
```

## System control (systemd user unit)

LCX Agent installs a systemd **user** service by default. Use a **system**
service for shared or always-on servers. The full unit example and guidance
live in the [Gateway runbook](/gateway).

Minimal setup:

Create `~/.config/systemd/user/lcx-gateway[-<profile>].service`:

```
[Unit]
Description=LCX Agent Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Enable it:

```
systemctl --user enable --now lcx-gateway[-<profile>].service
```
