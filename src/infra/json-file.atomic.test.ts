import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveJsonFile } from "./json-file.js";

const pathOf = (target: unknown): string => {
  if (typeof target === "string") {
    return target;
  }
  if (target instanceof URL) {
    return target.pathname;
  }
  return "";
};

describe("saveJsonFile writes atomically", () => {
  let dir: string | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-atomic-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    dir = null;
  });

  it("writes the payload and leaves no temp file behind", () => {
    const target = path.join(dir ?? "", "state.json");

    saveJsonFile(target, { version: 1, runs: {} });

    expect(fs.readFileSync(target, "utf-8")).toBe(
      `${JSON.stringify({ version: 1, runs: {} }, null, 2)}\n`,
    );
    expect(fs.readdirSync(dir ?? "")).toEqual(["state.json"]);
  });

  it("keeps the previous contents when the write fails part way through", () => {
    const target = path.join(dir ?? "", "state.json");
    const original = `${JSON.stringify({ version: 1, runs: { "run-1": true } }, null, 2)}\n`;
    fs.writeFileSync(target, original, "utf-8");

    // Reproduce what `writeFileSync` really does: the file is truncated before the bytes land,
    // so a failure mid-write destroys whatever was there.
    vi.spyOn(fs, "writeFileSync").mockImplementation((targetArg: unknown) => {
      try {
        fs.truncateSync(pathOf(targetArg), 0);
      } catch {
        // the temp file may not exist yet
      }
      throw new Error("ENOSPC");
    });

    expect(() => saveJsonFile(target, { version: 2 })).toThrow(/ENOSPC/);
    expect(fs.readFileSync(target, "utf-8")).toBe(original);
  });

  it("does not leave a temp file behind when the write fails", () => {
    const target = path.join(dir ?? "", "state.json");
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("EACCES");
    });

    expect(() => saveJsonFile(target, { version: 2 })).toThrow(/EACCES/);
    expect(fs.readdirSync(dir ?? "")).toEqual([]);
  });
});
