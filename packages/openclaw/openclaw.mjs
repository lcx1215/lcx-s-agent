#!/usr/bin/env node

// Keep the legacy executable name while routing to the canonical LCX CLI.
await import("lcx-agent/cli-entry");
