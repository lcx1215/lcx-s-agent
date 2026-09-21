import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";
import type { LogLevel } from "./levels.js";

// tslog ranks levels by severity (trace=1 .. fatal=6) and drops anything below
// `minLevel`, so a configured level is a floor on severity. The mapping used to
// be inverted: "trace" suppressed info/debug while "error" let them through,
// with "info" as the only correct fixed point. These cases pin the direction.
/**
 * Every level except `silent`: silent is a valid thing to *configure* (it drops everything) but
 * there is no `logger.silent(...)` to call, so no line can be written at it. Indexing the logger
 * with the full `LogLevel` union fails for exactly this reason.
 */
type EmittedLevel = Exclude<LogLevel, "silent">;

const FILE_LEVELS: EmittedLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

function writeOnce(configured: LogLevel, messageLevel: EmittedLevel): boolean {
  const logPath = path.join(os.tmpdir(), `openclaw-log-level-${crypto.randomUUID()}.log`);
  resetLogger();
  setLoggerOverride({ level: configured, file: logPath });
  try {
    getLogger()[messageLevel]({ probe: true }, "level-threshold probe");
    return fs.existsSync(logPath);
  } finally {
    resetLogger();
    setLoggerOverride(null);
    try {
      fs.rmSync(logPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

const SEVERITY: Record<LogLevel, number> = {
  trace: 1,
  debug: 2,
  info: 3,
  warn: 4,
  error: 5,
  fatal: 6,
  silent: Number.POSITIVE_INFINITY,
};

describe("configured log level is a severity floor for file writes", () => {
  afterEach(() => {
    resetLogger();
    setLoggerOverride(null);
  });

  for (const configured of FILE_LEVELS) {
    for (const messageLevel of FILE_LEVELS) {
      const shouldWrite = SEVERITY[messageLevel] >= SEVERITY[configured];
      it(`${configured} config: ${messageLevel} line is ${shouldWrite ? "written" : "dropped"}`, () => {
        expect(writeOnce(configured, messageLevel)).toBe(shouldWrite);
      });
    }
  }

  it("silent writes nothing at all", () => {
    expect(writeOnce("silent", "fatal")).toBe(false);
  });
});
