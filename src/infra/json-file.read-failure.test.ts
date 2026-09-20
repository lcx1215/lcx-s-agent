import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logWarn } from "../logger.js";
import { loadJsonFile } from "./json-file.js";

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

describe("loadJsonFile distinguishes 'no file' from 'cannot read the file'", () => {
  let dir: string | null = null;

  const warned = () => vi.mocked(logWarn).mock.calls.map((call) => String(call[0]));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-read-"));
    vi.mocked(logWarn).mockClear();
  });

  afterEach(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    dir = null;
  });

  it("does not warn when the file simply does not exist", () => {
    expect(loadJsonFile(path.join(dir ?? "", "missing.json"))).toBeUndefined();
    expect(warned()).toEqual([]);
  });

  it("warns when the file exists but is truncated", () => {
    const target = path.join(dir ?? "", "state.json");
    fs.writeFileSync(target, '{"version":1,"runs":{', "utf-8");

    expect(loadJsonFile(target)).toBeUndefined();
    expect(warned().some((message) => message.includes("cannot parse"))).toBe(true);
  });

  it("warns when the file cannot be read at all", () => {
    const target = path.join(dir ?? "", "state.json");
    fs.mkdirSync(target, { recursive: true });

    expect(loadJsonFile(target)).toBeUndefined();
    expect(warned().some((message) => message.includes("cannot read"))).toBe(true);
  });

  it("returns the parsed value and stays quiet for a readable file", () => {
    const target = path.join(dir ?? "", "state.json");
    fs.writeFileSync(target, `${JSON.stringify({ version: 1 })}\n`, "utf-8");

    expect(loadJsonFile(target)).toEqual({ version: 1 });
    expect(warned()).toEqual([]);
  });
});
