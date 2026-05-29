# LCX Agent Farm Web Dashboard

This is a read-only browser dashboard for the LCX farm view.

It exists so Codex in-app browser, remote mobile review, screenshots, and visual
annotation can inspect the same owner state without turning the native macOS app
into the only surface.

Run it from the repo root:

```bash
node --import tsx scripts/dev/lcx-farm-web-server.ts --port 4788
```

Then open:

```text
http://127.0.0.1:4788
```

Boundary:

- Owner JSON remains the source of truth.
- This dashboard does not start training, write live config, touch provider
  config, or claim live/model-weight proof.
- It is safe to use with Codex in-app browser for visual debugging.
