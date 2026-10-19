#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const origin = "https://127.0.0.1:18789";

function runConfig(args) {
  const result = spawnSync(process.execPath, ["dist/index.js", "config", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error
      ? `: ${result.error.message}`
      : ` (exit ${result.status ?? "unknown"})`;
    throw new Error(`config ${args[0]} failed${detail}`);
  }
  return result.stdout.trim();
}

function getConfig(path) {
  return JSON.parse(runConfig(["get", path, "--json"]));
}

function setConfig(path, value) {
  runConfig(["set", path, JSON.stringify(value), "--strict-json"]);
}

runConfig(["validate", "--json"]);

let tlsEnabled;
try {
  tlsEnabled = getConfig("gateway.tls.enabled");
} catch {
  // A valid config may omit this optional setting.
  tlsEnabled = undefined;
}
if (tlsEnabled !== true) {
  setConfig("gateway.tls.enabled", true);
}

let allowedOrigins;
try {
  allowedOrigins = getConfig("gateway.controlUi.allowedOrigins");
} catch {
  // A valid config may omit this optional list; treat that as an empty list.
  allowedOrigins = [];
}
if (allowedOrigins === null || allowedOrigins === undefined) {
  allowedOrigins = [];
}
if (!Array.isArray(allowedOrigins) || allowedOrigins.some((value) => typeof value !== "string")) {
  throw new Error("gateway.controlUi.allowedOrigins must be an array of strings");
}
if (!allowedOrigins.includes(origin)) {
  setConfig("gateway.controlUi.allowedOrigins", [...allowedOrigins, origin]);
}

const persistedOrigins = getConfig("gateway.controlUi.allowedOrigins");
if (
  getConfig("gateway.tls.enabled") !== true ||
  !Array.isArray(persistedOrigins) ||
  !persistedOrigins.includes(origin)
) {
  throw new Error("Gateway TLS configuration migration did not persist");
}
