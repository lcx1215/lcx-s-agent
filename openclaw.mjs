#!/usr/bin/env node

// Legacy compatibility entrypoint. The canonical LCX Agent CLI lives at
// lcx.mjs; keeping this thin wrapper preserves existing OpenClaw invocations
// while the remaining runtime/config/plugin surfaces migrate independently.
await import("./lcx.mjs");
