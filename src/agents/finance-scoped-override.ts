/**
 * A temporary, bounded adjustment to a declared knob - with a revert that has to
 * prove itself.
 *
 * The rules are written into code, and that is a real limitation: the system
 * cannot adapt to a situation without someone editing it. This is the narrowest
 * possible relief - a whitelisted numeric knob, moved within declared bounds,
 * for a declared duration.
 *
 * What it deliberately is not:
 *
 * - it is not a way to disable a gate. Gates are the `throw` and `includes`
 *   checks that refuse an action outright; caps are numbers that bound an
 *   action. Caps are adjustable, gates are not, and conflating them is how a
 *   safety system gets turned off while still looking present.
 * - it is not arbitrary configuration. The caller names a knob from a fixed
 *   list and supplies a number inside that knob's bounds. There is no path from
 *   here to editing logic.
 *
 * The revert is the whole design. Expiry is checked on every read, and when an
 * override has expired it is deleted and the deletion is verified: a revert that
 * is assumed rather than checked is how a system ends up permanently loosened
 * while reporting that everything is back to normal. If the deletion cannot be
 * confirmed, that is reported as a failure the caller must act on - not as
 * success.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

/**
 * Only knobs with a reader belong here.
 *
 * `topN` was declared alongside this one and had no consumer: the cycle
 * rebalances, it does not rank a top-N, so an override on it changed nothing
 * while reporting success. That is the defect this module exists to avoid, at
 * one remove - so the knob is gone rather than left as decoration. A knob is
 * added back when something reads it.
 */
export type OverrideKnob = "maxOrdersPerRun";

export const OVERRIDE_BOUNDS: Record<OverrideKnob, { min: number; max: number }> = {
  maxOrdersPerRun: { min: 1, max: 10 },
};

export const OVERRIDE_KNOBS = Object.keys(OVERRIDE_BOUNDS) as OverrideKnob[];

export const DEFAULT_OVERRIDE_TTL_MS = 10 * 60 * 1000;
export const MAX_OVERRIDE_TTL_MS = 60 * 60 * 1000;

const OVERRIDE_REL = "state/finance/override-scope.json";

export type OverrideEntry = Readonly<{
  knob: OverrideKnob;
  value: number;
  previous: number | null;
  reason: string;
  setAt: string;
  expiresAt: string;
  runId: string;
}>;

export type OverrideRevert = Readonly<{
  knob: OverrideKnob;
  reverted: boolean;
  verified: boolean;
  detail: string;
}>;

function isKnob(value: unknown): value is OverrideKnob {
  return typeof value === "string" && (OVERRIDE_KNOBS as string[]).includes(value);
}

async function overrideFile(workspaceDir?: string): Promise<string> {
  const root = resolveWorkspaceRoot(workspaceDir);
  return path.isAbsolute(OVERRIDE_REL) ? OVERRIDE_REL : path.join(root, OVERRIDE_REL);
}

async function readAll(workspaceDir?: string): Promise<OverrideEntry[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(await overrideFile(workspaceDir), "utf8")) as {
      overrides?: unknown;
    };
    return Array.isArray(parsed.overrides)
      ? parsed.overrides.flatMap((row) =>
          isKnob((row as { knob?: unknown })?.knob) ? [row as OverrideEntry] : [],
        )
      : [];
  } catch {
    return [];
  }
}

async function writeAll(entries: readonly OverrideEntry[], workspaceDir?: string): Promise<void> {
  const file = await overrideFile(workspaceDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ overrides: entries }, null, 2));
}

/**
 * Remove an override and then confirm it is really gone.
 *
 * Returns `verified:false` when the file still holds the knob after deletion.
 * That is not a soft warning: a caller that continues after an unverified revert
 * is running with a loosened bound it believes has been restored.
 */
export async function clearScopedOverride(
  knob: OverrideKnob,
  workspaceDir?: string,
): Promise<OverrideRevert> {
  const all = await readAll(workspaceDir);
  const remaining = all.filter((entry) => entry.knob !== knob);
  if (remaining.length === all.length) {
    return { knob, reverted: true, verified: true, detail: "no override was set" };
  }
  await writeAll(remaining, workspaceDir);
  const after = await readAll(workspaceDir);
  const stillThere = after.some((entry) => entry.knob === knob);
  return stillThere
    ? {
        knob,
        reverted: false,
        verified: false,
        detail: "override still present after deletion; treat the bound as still loosened",
      }
    : { knob, reverted: true, verified: true, detail: "removed and confirmed absent" };
}

export async function setScopedOverride(params: {
  knob: OverrideKnob;
  value: number;
  reason: string;
  runId?: string;
  ttlMs?: number;
  previous?: number | null;
  workspaceDir?: string;
}): Promise<{ ok: true; entry: OverrideEntry } | { ok: false; refusals: readonly string[] }> {
  const refusals: string[] = [];
  if (!isKnob(params.knob)) {
    refusals.push(
      "knob " + String(params.knob) + " is not overridable; allowed: " + OVERRIDE_KNOBS.join(", "),
    );
  }
  if (!Number.isFinite(params.value) || !Number.isInteger(params.value)) {
    refusals.push("value must be a whole number");
  }
  if (params.reason.trim().length < 8) {
    refusals.push("reason is required, and must say why this run needs a different bound");
  }
  const bounds = isKnob(params.knob) ? OVERRIDE_BOUNDS[params.knob] : null;
  if (bounds && Number.isFinite(params.value)) {
    if (params.value < bounds.min || params.value > bounds.max) {
      refusals.push(
        "value " +
          params.value +
          " outside bounds for " +
          params.knob +
          " (" +
          bounds.min +
          ".." +
          bounds.max +
          ")",
      );
    }
  }
  const ttl = params.ttlMs ?? DEFAULT_OVERRIDE_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_OVERRIDE_TTL_MS) {
    refusals.push("ttlMs must be between 1 and " + MAX_OVERRIDE_TTL_MS);
  }
  if (refusals.length > 0) {
    return { ok: false, refusals };
  }

  const setAt = Date.now();
  const entry: OverrideEntry = {
    knob: params.knob,
    value: params.value,
    previous: params.previous ?? null,
    reason: params.reason.trim(),
    setAt: new Date(setAt).toISOString(),
    expiresAt: new Date(setAt + ttl).toISOString(),
    runId: params.runId ?? "unscoped",
  };

  const all = await readAll(params.workspaceDir);
  await writeAll([...all.filter((e) => e.knob !== params.knob), entry], params.workspaceDir);
  return { ok: true, entry };
}

/**
 * The effective value, with expiry enforced and reversion verified.
 *
 * An expired override is deleted here, at read time, and the deletion is checked.
 * If it survives deletion the caller is told - it must not be handed a restored
 * default while the loose value is still in force.
 */
export async function resolveScopedOverride(params: {
  knob: OverrideKnob;
  fallback: number;
  workspaceDir?: string;
}): Promise<{
  value: number;
  overridden: boolean;
  expired: boolean;
  revertVerified: boolean | null;
  detail: string;
}> {
  const all = await readAll(params.workspaceDir);
  const entry = all.find((e) => e.knob === params.knob);
  if (!entry) {
    return {
      value: params.fallback,
      overridden: false,
      expired: false,
      revertVerified: null,
      detail: "using the default",
    };
  }
  if (Date.parse(entry.expiresAt) > Date.now()) {
    return {
      value: entry.value,
      overridden: true,
      expired: false,
      revertVerified: null,
      detail: "override in force until " + entry.expiresAt + " (" + entry.reason + ")",
    };
  }
  const revert = await clearScopedOverride(params.knob, params.workspaceDir);
  return {
    value: params.fallback,
    overridden: false,
    expired: true,
    revertVerified: revert.verified,
    detail: revert.verified
      ? "override expired and was confirmed removed; back to the default"
      : "override expired but could NOT be confirmed removed; the default is in force for this call only",
  };
}

export async function listScopedOverrides(
  workspaceDir?: string,
): Promise<readonly OverrideEntry[]> {
  return readAll(workspaceDir);
}
