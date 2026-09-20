import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decorateOpenClawProfile, ensureProfileCleanExit } from "./chrome.profile-decoration.js";

// Chrome's `Preferences` / `Local State` are the only copy of a profile's settings. The defect
// this pins: a file that could not be read or parsed used to come back as `null`, `?? {}` turned
// that into an empty document, and the next write replaced the user's settings with two keys.

let root: string;

function preferencesPath(): string {
  return path.join(root, "Default", "Preferences");
}

function localStatePath(): string {
  return path.join(root, "Local State");
}

function markerPath(): string {
  return path.join(root, ".openclaw-profile-decorated");
}

function writePreferences(contents: string): void {
  fs.mkdirSync(path.dirname(preferencesPath()), { recursive: true });
  fs.writeFileSync(preferencesPath(), contents, "utf-8");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lcx-chrome-prefs-"));
});

afterEach(() => {
  // Restore permissions first: a 0o000 file cannot be removed, and a 0o500 dir cannot either.
  for (const target of [preferencesPath(), localStatePath()]) {
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // not there, or nothing to restore
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("chrome profile decoration: a Preferences file that cannot be read is not an empty one", () => {
  it("leaves a corrupted Preferences file untouched on clean-exit", () => {
    const original = '{"profile":{"name":"real"},"browser":{"theme":';
    writePreferences(original);

    ensureProfileCleanExit(root);

    expect(fs.readFileSync(preferencesPath(), "utf-8")).toBe(original);
  });

  it("leaves an unreadable Preferences file untouched on clean-exit", () => {
    writePreferences('{"profile":{"name":"real"}}');
    fs.chmodSync(preferencesPath(), 0o000);

    ensureProfileCleanExit(root);

    fs.chmodSync(preferencesPath(), 0o600);
    expect(fs.readFileSync(preferencesPath(), "utf-8")).toBe('{"profile":{"name":"real"}}');
  });

  it("decorates nothing when Local State is corrupted, and leaves no marker behind", () => {
    writePreferences('{"profile":{"name":"real"}}');
    fs.writeFileSync(localStatePath(), "{not json", "utf-8");

    decorateOpenClawProfile(root);

    expect(fs.readFileSync(localStatePath(), "utf-8")).toBe("{not json");
    expect(fs.readFileSync(preferencesPath(), "utf-8")).toBe('{"profile":{"name":"real"}}');
    expect(fs.existsSync(markerPath())).toBe(false);
  });

  it("still writes for a fresh profile that has no Preferences file yet", () => {
    ensureProfileCleanExit(root);

    const written = JSON.parse(fs.readFileSync(preferencesPath(), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(written.exit_type).toBe("Normal");
    expect(written.exited_cleanly).toBe(true);
  });

  it("keeps the settings it managed to read when it does write", () => {
    writePreferences('{"profile":{"name":"real"},"homepage":"https://example.com"}');

    ensureProfileCleanExit(root);

    const written = JSON.parse(fs.readFileSync(preferencesPath(), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(written.exit_type).toBe("Normal");
    expect(written.homepage).toBe("https://example.com");
  });
});
