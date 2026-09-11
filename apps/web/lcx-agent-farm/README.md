# LCX Agent Farm Web Dashboard

This is the canonical read-only browser control-room view for LCX Agent.

It exists so Codex in-app browser, remote mobile review, screenshots, and visual
annotation can inspect the same owner state without turning the native macOS app
into the only surface.

Run it from the repo root:

```bash
node --import tsx scripts/operator/lcx-farm-web-server.ts --port 4788
```

Then open:

```text
http://127.0.0.1:4788
```

Data authority:

- The dashboard reads one `lcx-control-room-latest.json` snapshot emitted by
  `lcx-governance-autopilot`.
- The owner brief, owner control map, evolution digest, and failure trace are
  projections inside that snapshot. Their standalone JSON/Markdown files are
  compatibility exports, not parallel current facts.

Boundary:

- This dashboard does not start training, write external-channel or provider
  config, or claim user-visible or model-weight proof.
- Codex Desktop hourly automation and its green/fix markers are external
  triggers only; they are not LCX Agent receipts, dashboard truth, CI, or
  delivery proof.
- It is safe to use with Codex in-app browser for visual debugging.
