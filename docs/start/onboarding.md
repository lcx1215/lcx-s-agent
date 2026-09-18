---
summary: "First-run onboarding flow for OpenClaw"
read_when:
  - Running the first-run onboarding flow
  - Implementing auth or identity setup
title: "Onboarding"
sidebarTitle: "Onboarding"
---

# Onboarding

This doc describes the **current** first‑run onboarding flow. The goal is a
smooth “day 0” experience: pick where the Gateway runs, connect auth, run the
wizard, and let the agent bootstrap itself.
For a general overview of onboarding paths, see [Onboarding Overview](/start/onboarding-overview).

There is no native companion app; onboarding runs through the CLI and the
onboarding chat session.

## 1) Start the wizard

```bash
openclaw onboard --install-daemon
```

Other entry points:

```bash
openclaw gateway install   # install the Gateway service directly
openclaw configure         # interactive: select "Gateway service"
openclaw doctor            # repair or migrate an existing service
```

## 2) Security trust model

- By default, OpenClaw is a personal agent: one trusted operator boundary.
- Shared/multi-user setups require lock-down (split trust boundaries, keep tool access minimal, and follow [Security](/gateway/security)).
- Local onboarding now defaults new configs to `tools.profile: "messaging"` so broad runtime/filesystem tools are opt-in.
- If hooks/webhooks or other untrusted content feeds are enabled, use a strong modern model tier and keep strict tool policy/sandboxing.

## 3) Local vs Remote

Where does the **Gateway** run?

- **This machine (Local only):** onboarding can configure auth and write credentials
  locally.
- **Remote (over SSH/Tailnet):** onboarding does **not** configure local auth;
  credentials must exist on the gateway host.
- **Configure later:** skip setup and leave the Gateway unconfigured.

<Tip>
**Gateway auth tip:**

- The wizard now generates a **token** even for loopback, so local WS clients must authenticate.
- If you disable auth, any local process can connect; use that only on fully trusted machines.
- Use a **token** for multi‑machine access or non‑loopback binds.

</Tip>

## 4) Onboarding chat (dedicated session)

After setup, the agent opens a dedicated onboarding chat session so it can
introduce itself and guide next steps. This keeps first‑run guidance separate
from your normal conversation. See [Bootstrapping](/start/bootstrapping) for
what happens on the gateway host during the first agent run.
