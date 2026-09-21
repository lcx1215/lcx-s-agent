#!/usr/bin/env -S node --import tsx

import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type PackFile = { path: string };
type PackResult = { files?: PackFile[] };

const requiredPathGroups = [
  ["dist/index.js", "dist/index.mjs"],
  "dist/index.d.ts",
  ["dist/entry.js", "dist/entry.mjs"],
  "dist/plugin-sdk/index.js",
  "dist/plugin-sdk/index.d.ts",
  "dist/plugin-sdk/core.js",
  "dist/plugin-sdk/core.d.ts",
  "dist/plugin-sdk/telegram.js",
  "dist/plugin-sdk/telegram.d.ts",
  "dist/plugin-sdk/discord.js",
  "dist/plugin-sdk/discord.d.ts",
  "dist/plugin-sdk/slack.js",
  "dist/plugin-sdk/slack.d.ts",
  "dist/plugin-sdk/signal.js",
  "dist/plugin-sdk/signal.d.ts",
  "dist/plugin-sdk/imessage.js",
  "dist/plugin-sdk/imessage.d.ts",
  "dist/plugin-sdk/whatsapp.js",
  "dist/plugin-sdk/whatsapp.d.ts",
  "dist/plugin-sdk/line.js",
  "dist/plugin-sdk/line.d.ts",
  // Keep this list in step with the `./plugin-sdk/*` entries in package.json `exports`.
  // These two were declared as public subpaths but not guarded here — a build that stops
  // emitting them would ship a package whose own exports map points at nothing, the same
  // failure class as #27569. `account-id` and `keyed-async-queue` were both missing.
  "dist/plugin-sdk/account-id.js",
  "dist/plugin-sdk/account-id.d.ts",
  "dist/plugin-sdk/keyed-async-queue.js",
  "dist/plugin-sdk/keyed-async-queue.d.ts",
  "dist/build-info.json",
];

type PackageJson = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
};

function normalizePluginSyncVersion(version: string): string {
  const normalized = version.trim().replace(/^v/, "");
  const base = /^([0-9]+\.[0-9]+\.[0-9]+)/.exec(normalized)?.[1];
  if (base) {
    return base;
  }
  return normalized.replace(/[-+].*$/, "");
}

function runPackDry(): PackResult[] {
  const raw = execSync("npm pack --dry-run --json --ignore-scripts", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 100,
  });
  return JSON.parse(raw) as PackResult[];
}

function checkPluginVersions() {
  const rootPackagePath = resolve("package.json");
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as PackageJson;
  const targetVersion = rootPackage.version;
  const targetBaseVersion = targetVersion ? normalizePluginSyncVersion(targetVersion) : null;

  if (!targetVersion || !targetBaseVersion) {
    console.error("release-check: root package.json missing version.");
    process.exit(1);
  }

  const extensionsDir = resolve("extensions");
  const entries = readdirSync(extensionsDir, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );

  const mismatches: string[] = [];

  for (const entry of entries) {
    const packagePath = join(extensionsDir, entry.name, "package.json");
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
    } catch {
      continue;
    }

    if (!pkg.name || !pkg.version) {
      continue;
    }

    if (normalizePluginSyncVersion(pkg.version) !== targetBaseVersion) {
      mismatches.push(`${pkg.name} (${pkg.version})`);
    }
  }

  const compatibilityPackagePath = resolve("packages", "openclaw", "package.json");
  try {
    const compatibilityPackage = JSON.parse(
      readFileSync(compatibilityPackagePath, "utf8"),
    ) as PackageJson;
    if (compatibilityPackage.name === "openclaw") {
      if (normalizePluginSyncVersion(compatibilityPackage.version ?? "") !== targetBaseVersion) {
        mismatches.push(
          `${compatibilityPackage.name} (${compatibilityPackage.version ?? "missing"})`,
        );
      }
      if (compatibilityPackage.dependencies?.["lcx-agent"] !== targetVersion) {
        mismatches.push(
          `${compatibilityPackage.name} lcx-agent dependency (${compatibilityPackage.dependencies?.["lcx-agent"] ?? "missing"})`,
        );
      }
    }
  } catch {
    // Compatibility package is optional in older source trees.
  }

  if (mismatches.length > 0) {
    console.error(
      `release-check: plugin versions must match release base ${targetBaseVersion} (root ${targetVersion}):`,
    );
    for (const item of mismatches) {
      console.error(`  - ${item}`);
    }
    console.error("release-check: run `pnpm plugins:sync` to align plugin versions.");
    process.exit(1);
  }
}

// Critical functions that channel extension plugins import from lcx-agent/plugin-sdk.
// If any are missing from the compiled output, plugins crash at runtime (#27569).
const requiredPluginSdkExports = [
  "isDangerousNameMatchingEnabled",
  "createAccountListHelpers",
  "buildAgentMediaPayload",
  "createReplyPrefixOptions",
  "createTypingCallbacks",
  "logInboundDrop",
  "logTypingFailure",
  "buildPendingHistoryContextFromMap",
  "clearHistoryEntriesIfEnabled",
  "recordPendingHistoryEntryIfEnabled",
  "resolveControlCommandGate",
  "resolveDmGroupAccessWithLists",
  "resolveAllowlistProviderRuntimeGroupPolicy",
  "resolveDefaultGroupPolicy",
  "resolveChannelMediaMaxBytes",
  "warnMissingProviderGroupPolicyFallbackOnce",
  "emptyPluginConfigSchema",
  "normalizePluginHttpPath",
  "registerPluginHttpRoute",
  "DEFAULT_ACCOUNT_ID",
  "DEFAULT_GROUP_HISTORY_LIMIT",
];

function checkPluginSdkExports() {
  const distPath = resolve("dist", "plugin-sdk", "index.js");
  let content: string;
  try {
    content = readFileSync(distPath, "utf8");
  } catch {
    console.error("release-check: dist/plugin-sdk/index.js not found (build missing?).");
    process.exit(1);
    return;
  }

  const exportMatch = content.match(/export\s*\{([^}]+)\}\s*;?\s*$/);
  if (!exportMatch) {
    console.error("release-check: could not find export statement in dist/plugin-sdk/index.js.");
    process.exit(1);
    return;
  }

  const exportedNames = new Set(
    exportMatch[1].split(",").map((s) => {
      const parts = s.trim().split(/\s+as\s+/);
      return (parts[parts.length - 1] || "").trim();
    }),
  );

  const missingExports = requiredPluginSdkExports.filter((name) => !exportedNames.has(name));
  if (missingExports.length > 0) {
    console.error("release-check: missing critical plugin-sdk exports (#27569):");
    for (const name of missingExports) {
      console.error(`  - ${name}`);
    }
    process.exit(1);
  }
}

function main() {
  checkPluginVersions();
  checkPluginSdkExports();

  const results = runPackDry();
  const files = results.flatMap((entry) => entry.files ?? []);
  const paths = new Set(files.map((file) => file.path));

  const missing = requiredPathGroups
    .flatMap((group) => {
      if (Array.isArray(group)) {
        return group.some((path) => paths.has(path)) ? [] : [group.join(" or ")];
      }
      return paths.has(group) ? [] : [group];
    })
    .toSorted();

  if (missing.length > 0) {
    console.error("release-check: missing files in npm pack:");
    for (const path of missing) {
      console.error(`  - ${path}`);
    }
    process.exit(1);
  }

  console.log("release-check: npm pack contents look OK.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
