import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CANONICAL_CONFIG_FILENAME, CANONICAL_STATE_DIRNAME } from "../infra/canonical-identity.js";
import { expandHomePrefix, resolveRequiredHomeDir } from "../infra/home-dir.js";
import type { OpenClawConfig } from "./types.js";

/**
 * Nix mode detection: When OPENCLAW_NIX_MODE=1, the gateway is running under Nix.
 * In this mode:
 * - No auto-install flows should be attempted
 * - Missing dependencies should produce actionable Nix-specific error messages
 * - Config is managed externally (read-only from Nix perspective)
 */
export function resolveIsNixMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENCLAW_NIX_MODE === "1";
}

export const isNixMode = resolveIsNixMode();

// Support historical (and occasionally misspelled) legacy state dirs.
const LEGACY_STATE_DIRNAMES = [".clawdbot", ".moldbot", ".moltbot"] as const;
const COMPATIBILITY_STATE_DIRNAME = ".openclaw";
const CONFIG_FILENAME = "openclaw.json";
export const LCX_IDENTITY_MIGRATION_COMPLETION_FILENAME = "identity-migration.complete.json";
const LEGACY_CONFIG_FILENAMES = ["clawdbot.json", "moldbot.json", "moltbot.json"] as const;
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;
const WINDOWS_UNC_PATH = /^\\\\/;
const IDENTITY_MIGRATION_STATE_DIRNAMES = [
  CANONICAL_STATE_DIRNAME,
  COMPATIBILITY_STATE_DIRNAME,
  ...LEGACY_STATE_DIRNAMES,
] as const;
const IDENTITY_MIGRATION_CONFIG_FILENAMES = [
  CANONICAL_CONFIG_FILENAME,
  CONFIG_FILENAME,
  ...LEGACY_CONFIG_FILENAMES,
] as const;

function resolveDefaultHomeDir(): string {
  return resolveRequiredHomeDir(process.env, os.homedir);
}

/** Build a homedir thunk that respects OPENCLAW_HOME for the given env. */
function envHomedir(env: NodeJS.ProcessEnv): () => string {
  return () => resolveRequiredHomeDir(env, os.homedir);
}

function resolvePathHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string {
  const configuredHome = env.OPENCLAW_HOME?.trim() || env.HOME?.trim() || env.USERPROFILE?.trim();
  if (
    configuredHome &&
    (WINDOWS_ABSOLUTE_PATH.test(configuredHome) || WINDOWS_UNC_PATH.test(configuredHome))
  ) {
    return configuredHome;
  }
  return resolveRequiredHomeDir(env, homedir);
}

function resolveProfileStateOverride(
  input: string,
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): string {
  const trimmed = input.trim();
  const expanded = trimmed.startsWith("~")
    ? expandHomePrefix(trimmed, {
        home: resolvePathHomeDir(env, homedir),
        env,
        homedir,
      })
    : trimmed;
  if (WINDOWS_ABSOLUTE_PATH.test(expanded) || WINDOWS_UNC_PATH.test(expanded)) {
    return expanded;
  }
  return path.resolve(expanded);
}

function legacyStateDirs(homedir: () => string = resolveDefaultHomeDir): string[] {
  return LEGACY_STATE_DIRNAMES.map((dir) => path.join(homedir(), dir));
}

function newStateDir(homedir: () => string = resolveDefaultHomeDir): string {
  return path.join(homedir(), CANONICAL_STATE_DIRNAME);
}

export function resolveLegacyStateDir(homedir: () => string = resolveDefaultHomeDir): string {
  return legacyStateDirs(homedir)[0] ?? newStateDir(homedir);
}

export function resolveLegacyStateDirs(homedir: () => string = resolveDefaultHomeDir): string[] {
  return legacyStateDirs(homedir);
}

export function resolveNewStateDir(homedir: () => string = resolveDefaultHomeDir): string {
  return newStateDir(homedir);
}

/**
 * Resolve the canonical LCX state root for a named profile.
 *
 * Keep profile suffix derivation beside the state-root owner so callers do not
 * grow independent `.lcx[-profile]` implementations.
 */
export function resolveNewStateDirForProfile(
  profile: string | undefined,
  homedir: () => string = resolveDefaultHomeDir,
): string {
  const normalized = profile?.trim();
  const suffix = normalized && normalized.toLowerCase() !== "default" ? `-${normalized}` : "";
  return `${resolveNewStateDir(homedir)}${suffix}`;
}

/**
 * Resolve a profile state root without splitting an existing installation.
 * Canonical profile roots win when they already contain a config; otherwise
 * an existing compatibility profile root remains the active root until an
 * explicit migration moves that profile's complete writer set.
 */
export function resolveStateDirForProfile(
  profile: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  const effectiveHomedir = () => resolvePathHomeDir(env, homedir);
  const normalized = profile?.trim();
  const suffix = normalized && normalized.toLowerCase() !== "default" ? `-${normalized}` : "";
  const canonicalStateDir = resolveNewStateDirForProfile(normalized, effectiveHomedir);
  const compatibilityStateDirs = [COMPATIBILITY_STATE_DIRNAME, ...LEGACY_STATE_DIRNAMES].map(
    (dirname) => path.join(effectiveHomedir(), `${dirname}${suffix}`),
  );
  const explicitStateDir = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  const explicitConfigPath = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
  if (explicitStateDir) {
    return resolveProfileStateOverride(explicitStateDir, env, homedir);
  }
  if (explicitConfigPath && !explicitStateDir) {
    return canonicalStateDir;
  }
  const stateDirs = [canonicalStateDir, ...compatibilityStateDirs];
  const configPath = stateDirs
    .flatMap((stateDir) =>
      IDENTITY_MIGRATION_CONFIG_FILENAMES.map((filename) => path.join(stateDir, filename)),
    )
    .find((candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    });
  if (configPath) {
    return path.dirname(configPath);
  }
  return (
    [...compatibilityStateDirs, canonicalStateDir].find((candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    }) ?? canonicalStateDir
  );
}

/** Resolve the active config file for a named profile without hardcoding a legacy filename. */
export function resolveConfigPathForProfile(
  profile: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  const stateDir = resolveStateDirForProfile(profile, env, homedir);
  const existing = IDENTITY_MIGRATION_CONFIG_FILENAMES.map((filename) =>
    path.join(stateDir, filename),
  ).find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (existing) {
    return existing;
  }
  const canonicalStateDir = resolveNewStateDirForProfile(profile, () =>
    resolveRequiredHomeDir(env, homedir),
  );
  return path.join(
    stateDir,
    path.resolve(stateDir) === path.resolve(canonicalStateDir)
      ? CANONICAL_CONFIG_FILENAME
      : CONFIG_FILENAME,
  );
}

/**
 * Canonical LCX state target for identity migration and normal runtime use.
 */
export function resolveLcxStateDir(homedir: () => string = resolveDefaultHomeDir): string {
  return path.join(homedir(), CANONICAL_STATE_DIRNAME);
}

/** Canonical LCX config target under a supplied state directory. */
export function resolveLcxConfigPath(stateDir: string = resolveLcxStateDir()): string {
  return path.join(stateDir, CANONICAL_CONFIG_FILENAME);
}

export function resolveLcxIdentityMigrationCompletionPath(
  stateDir: string = resolveLcxStateDir(),
): string {
  return path.join(stateDir, LCX_IDENTITY_MIGRATION_COMPLETION_FILENAME);
}

/**
 * A completion marker is the durable proof that the canonical root may become
 * active while a compatibility root still exists on disk.
 */
export function isLcxIdentityMigrationComplete(
  params: { env?: NodeJS.ProcessEnv; homedir?: () => string } = {},
): boolean {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? envHomedir(env);
  const canonicalStateDir = resolveLcxStateDir(() => resolveRequiredHomeDir(env, homedir));
  try {
    const marker = JSON.parse(
      fs.readFileSync(resolveLcxIdentityMigrationCompletionPath(canonicalStateDir), "utf8"),
    ) as { schemaVersion?: unknown; canonicalStateDir?: unknown; completedAt?: unknown };
    return (
      marker.schemaVersion === 1 &&
      typeof marker.canonicalStateDir === "string" &&
      path.resolve(marker.canonicalStateDir) === path.resolve(canonicalStateDir) &&
      typeof marker.completedAt === "string" &&
      marker.completedAt.length > 0
    );
  } catch {
    return false;
  }
}

export type LcxIdentityMigrationPlan = Readonly<{
  mode: "canonical-default" | "explicit-state-override" | "explicit-config-override";
  canonicalStateDir: string;
  canonicalConfigPath: string;
  readStateDirs: readonly string[];
  readStateDir: string;
  readConfigCandidates: readonly string[];
  readConfigPath: string;
  writeStateDir: string;
  writeConfigPath: string;
  source: "none" | "canonical" | "legacy" | "explicit";
}>;

/**
 * Compute the reversible identity migration boundary without touching the
 * filesystem. The plan's write target is canonical LCX; the normal runtime
 * resolver may keep an existing legacy root active until all writers migrate.
 *
 * With no explicit override, LCX is the write target while existing legacy
 * state/config paths remain readable. Explicit OPENCLAW/CLAWDBOT overrides are
 * treated as operator authority and are therefore both read and write targets.
 */
export function resolveLcxIdentityMigrationPlan(
  params: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
    existsSync?: (candidate: string) => boolean;
  } = {},
): LcxIdentityMigrationPlan {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? envHomedir(env);
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  const existsSync = params.existsSync ?? fs.existsSync;
  const explicitState = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  const explicitConfig = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
  const canonicalStateDir = resolveLcxStateDir(effectiveHomedir);
  const canonicalConfigPath = resolveLcxConfigPath(canonicalStateDir);
  const writeStateDir = explicitState
    ? resolveUserPath(explicitState, env, effectiveHomedir)
    : canonicalStateDir;
  const writeConfigPath = explicitConfig
    ? resolveUserPath(explicitConfig, env, effectiveHomedir)
    : resolveLcxConfigPath(writeStateDir);
  const mode = explicitConfig
    ? "explicit-config-override"
    : explicitState
      ? "explicit-state-override"
      : "canonical-default";

  const readStateDirs = explicitState
    ? [writeStateDir]
    : IDENTITY_MIGRATION_STATE_DIRNAMES.map((dirname) => path.join(effectiveHomedir(), dirname));
  const compatibilityStateDirs = explicitState ? [] : readStateDirs.slice(1);
  const compatibilityStateDir = compatibilityStateDirs.find((candidate) => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  });
  const canonicalActivationComplete =
    mode !== "canonical-default" ||
    !compatibilityStateDir ||
    isLcxIdentityMigrationComplete({ env, homedir: effectiveHomedir });
  const readConfigCandidates = explicitConfig
    ? [writeConfigPath]
    : readStateDirs.flatMap((stateDir) =>
        IDENTITY_MIGRATION_CONFIG_FILENAMES.map((filename) => path.join(stateDir, filename)),
      );
  const configSelectionCandidates = canonicalActivationComplete
    ? readConfigCandidates
    : compatibilityStateDirs.flatMap((stateDir) =>
        IDENTITY_MIGRATION_CONFIG_FILENAMES.map((filename) => path.join(stateDir, filename)),
      );
  const existingConfigPath = configSelectionCandidates.find((candidate) => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  });
  // Keep the selected state and config source together for default and
  // explicit-state resolution. A config-only override selects the config
  // file, not a compatibility state root, so state remains canonical even if
  // an unrelated legacy directory exists.
  const readStateDir =
    explicitConfig && !explicitState
      ? canonicalStateDir
      : !canonicalActivationComplete && compatibilityStateDir
        ? compatibilityStateDir
        : existingConfigPath
          ? path.dirname(existingConfigPath)
          : (readStateDirs.find((candidate) => {
              try {
                return existsSync(candidate);
              } catch {
                return false;
              }
            }) ?? writeStateDir);
  const readConfigPath =
    existingConfigPath ??
    (!canonicalActivationComplete && compatibilityStateDir
      ? path.join(compatibilityStateDir, CONFIG_FILENAME)
      : writeConfigPath);
  const source =
    explicitConfig || explicitState
      ? "explicit"
      : existingConfigPath === canonicalConfigPath
        ? "canonical"
        : existingConfigPath
          ? "legacy"
          : "none";

  return Object.freeze({
    mode,
    canonicalStateDir,
    canonicalConfigPath,
    readStateDirs: Object.freeze(readStateDirs),
    readStateDir,
    readConfigCandidates: Object.freeze(readConfigCandidates),
    readConfigPath,
    writeStateDir,
    writeConfigPath,
    source,
  });
}

/**
 * State directory for mutable data (sessions, logs, caches).
 * Can be overridden via OPENCLAW_STATE_DIR.
 * Default: ~/.lcx for new installs. If an existing compatibility config or
 * state root is detected, keep that root active until an explicit migration
 * switches the complete writer set. This prevents config/state split-brain.
 */
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  const override = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env, effectiveHomedir);
  }
  return resolveLcxIdentityMigrationPlan({ env, homedir }).readStateDir;
}

function resolveUserPath(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = expandHomePrefix(trimmed, {
      home: resolveRequiredHomeDir(env, homedir),
      env,
      homedir,
    });
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

export const STATE_DIR = resolveStateDir();

/**
 * Config file path (JSON5).
 * Can be overridden via OPENCLAW_CONFIG_PATH.
 * Default: ~/.lcx/lcx.json (or $OPENCLAW_STATE_DIR/openclaw.json)
 */
export function resolveCanonicalConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, envHomedir(env)),
  homedir: () => string = envHomedir(env),
): string {
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  const override = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env, effectiveHomedir);
  }
  const existing = IDENTITY_MIGRATION_CONFIG_FILENAMES.map((filename) =>
    path.join(stateDir, filename),
  ).find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  if (existing) {
    return existing;
  }
  const canonicalStateDir = resolveLcxStateDir(effectiveHomedir);
  if (path.resolve(stateDir) === path.resolve(canonicalStateDir)) {
    return path.join(stateDir, CANONICAL_CONFIG_FILENAME);
  }
  return path.join(stateDir, CONFIG_FILENAME);
}

/**
 * Resolve the active config path.
 *
 * The canonical default is authoritative. Explicit state/config overrides
 * retain compatibility filename discovery inside the selected root.
 */
export function resolveConfigPathCandidate(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  const configOverride = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
  if (configOverride) {
    return resolveUserPath(configOverride, env, homedir);
  }
  return resolveCanonicalConfigPath(env, resolveStateDir(env, homedir), homedir);
}

/**
 * Active config path (prefers existing config files).
 */
export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, envHomedir(env)),
  homedir: () => string = envHomedir(env),
): string {
  const override = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env, homedir);
  }
  return resolveCanonicalConfigPath(env, stateDir, homedir);
}

export const CONFIG_PATH = resolveConfigPathCandidate();

/**
 * Resolve default config path candidates across default locations.
 * Order: explicit config path → state-dir-derived paths → new default.
 */
export function resolveDefaultConfigCandidates(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string[] {
  const effectiveHomedir = () => resolveRequiredHomeDir(env, homedir);
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim() || env.CLAWDBOT_CONFIG_PATH?.trim();
  if (explicit) {
    return [resolveUserPath(explicit, env, effectiveHomedir)];
  }

  const candidates: string[] = [];
  const openclawStateDir = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (openclawStateDir) {
    const resolved = resolveUserPath(openclawStateDir, env, effectiveHomedir);
    candidates.push(path.join(resolved, CANONICAL_CONFIG_FILENAME));
    candidates.push(path.join(resolved, CONFIG_FILENAME));
    candidates.push(...LEGACY_CONFIG_FILENAMES.map((name) => path.join(resolved, name)));
  }

  const canonicalDir = newStateDir(effectiveHomedir);
  candidates.push(path.join(canonicalDir, CANONICAL_CONFIG_FILENAME));
  candidates.push(path.join(canonicalDir, CONFIG_FILENAME));
  candidates.push(...LEGACY_CONFIG_FILENAMES.map((name) => path.join(canonicalDir, name)));

  const compatibilityDirs = [
    path.join(effectiveHomedir(), COMPATIBILITY_STATE_DIRNAME),
    ...legacyStateDirs(effectiveHomedir),
  ];
  for (const dir of compatibilityDirs) {
    candidates.push(path.join(dir, CANONICAL_CONFIG_FILENAME));
    candidates.push(path.join(dir, CONFIG_FILENAME));
    candidates.push(...LEGACY_CONFIG_FILENAMES.map((name) => path.join(dir, name)));
  }
  return candidates;
}

export const DEFAULT_GATEWAY_PORT = 18789;

/**
 * Gateway lock directory (ephemeral).
 * Default: os.tmpdir()/openclaw-<uid> (uid suffix when available).
 */
export function resolveGatewayLockDir(tmpdir: () => string = os.tmpdir): string {
  const base = tmpdir();
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const suffix = uid != null ? `openclaw-${uid}` : "openclaw";
  return path.join(base, suffix);
}

const OAUTH_FILENAME = "oauth.json";

/**
 * OAuth credentials storage directory.
 *
 * Precedence:
 * - `OPENCLAW_OAUTH_DIR` (explicit override)
 * - `$*_STATE_DIR/credentials` (canonical server/default)
 */
export function resolveOAuthDir(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, envHomedir(env)),
): string {
  const override = env.OPENCLAW_OAUTH_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env, envHomedir(env));
  }
  return path.join(stateDir, "credentials");
}

export function resolveOAuthPath(
  env: NodeJS.ProcessEnv = process.env,
  stateDir: string = resolveStateDir(env, envHomedir(env)),
): string {
  return path.join(resolveOAuthDir(env, stateDir), OAUTH_FILENAME);
}

export function resolveGatewayPort(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const envRaw = env.OPENCLAW_GATEWAY_PORT?.trim() || env.CLAWDBOT_GATEWAY_PORT?.trim();
  if (envRaw) {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const configPort = cfg?.gateway?.port;
  if (typeof configPort === "number" && Number.isFinite(configPort)) {
    if (configPort > 0) {
      return configPort;
    }
  }
  return DEFAULT_GATEWAY_PORT;
}
