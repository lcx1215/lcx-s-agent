# Codex Remote Devbox, Browser, And Locked Computer Use Runbook

This runbook connects LCX Agent Farm to the newer Codex surfaces without
creating new LCX runtime authority.

## Web Frontend Role

The web frontend is useful because Codex in-app browser, remote mobile review,
and screenshot annotation can all inspect a normal URL. It is not a replacement
for the native macOS app and it is not an owner command.

Use it for:

- visual inspection from Codex in-app browser
- remote phone review while the Mac or devbox keeps working
- screenshots and annotations for farm UI issues
- lightweight read-only status for non-Mac devices

Run:

```bash
node --import tsx scripts/dev/lcx-farm-web-server.ts --port 4788
```

Open:

```text
http://127.0.0.1:4788
```

## Remote Devbox Setup

Codex remote devbox support uses SSH. The Codex App discovers concrete hosts
from `~/.ssh/config`, then starts the remote Codex app server through SSH.

Add a concrete host alias:

```sshconfig
Host lcx-devbox
  HostName devbox.example.com
  User liuchengxu
  IdentityFile ~/.ssh/id_ed25519
```

Verify from this Mac:

```bash
ssh lcx-devbox
```

On the remote host:

```bash
codex --version
```

Then in Codex App:

```text
Settings -> Connections -> add/enable SSH host -> choose remote project folder
```

Recommended first remote split:

- keep LiveLark, protected memory, provider config, and local app UI on the Mac
- move heavy read-only eval, CI, broad static checks, and long web dashboard
  preview work to the devbox
- do not move MLX adapter promotion unless the remote host has the same model,
  adapter, and filesystem proof path

## Locked / Remote Computer Use

This cannot be enabled by repo code. It requires Codex App settings and macOS
permissions.

Manual enablement checklist:

1. Install/enable the Codex Computer Use plugin.
2. Grant macOS Screen Recording permission.
3. Grant macOS Accessibility permission.
4. In Codex settings, allow only the apps needed for the task.
5. Use Always allow only for trusted apps and narrow flows.
6. Keep sensitive account, security, payment, credential, and provider config
   flows manual unless you are present.

LCX boundary:

- locked computer use may inspect or operate the farm app/browser only after
  explicit permission
- it must not operate Terminal, Codex itself, provider config, live sender, or
  protected memory as an unattended shortcut
- live-user-seen and model-weight absorption still require existing owner proof
