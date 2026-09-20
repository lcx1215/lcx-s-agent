import fs from "node:fs";
import path from "node:path";
import { logWarn } from "../logger.js";
import { describeReadFailure } from "./unreadable-source.js";

export function loadJsonFile(pathname: string): unknown {
  if (!fs.existsSync(pathname)) {
    return undefined;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(pathname, "utf8");
  } catch (err) {
    // "No file" is a normal first run. "There is a file and it could not be read" is not, and
    // every caller currently sees both as `undefined` — so say it here, once, for all of them.
    const failure = describeReadFailure(err);
    if (failure.status !== "absent") {
      logWarn(
        `[json-file] cannot read ${pathname} (${failure.status}/${failure.code}); callers will treat it as missing`,
      );
    }
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    logWarn(`[json-file] cannot parse ${pathname}; callers will treat it as missing`);
    return undefined;
  }
}

/**
 * Like {@link loadJsonFile} but keeps "no file" distinct from "there is a file
 * and it could not be read / parsed". Callers that write the file back must use
 * this: treating an unreadable file as an empty document and then persisting
 * that emptiness destroys the original.
 */
export type JsonFileLoadResult =
  | { status: "ok"; value: unknown }
  | { status: "absent"; code: string }
  | { status: "unreadable"; code: string }
  | { status: "corrupt"; code: string };

export function loadJsonFileDetailed(pathname: string): JsonFileLoadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(pathname, "utf8");
  } catch (err) {
    const failure = describeReadFailure(err);
    return { status: failure.status, code: failure.code };
  }
  try {
    return { status: "ok", value: JSON.parse(raw) as unknown };
  } catch {
    return { status: "corrupt", code: "JSON_PARSE_FAILED" };
  }
}

export function saveJsonFile(pathname: string, data: unknown) {
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Write to a sibling temp file and rename it into place. `writeFileSync` truncates first, so a
  // crash or ENOSPC part way through used to leave a half-written file behind — which the next
  // read then reports as "corrupt" for state files that are the only copy of their contents
  // (subagent runs, auth profiles). Renaming is atomic: readers see either the old file or the
  // new one, never a partial one.
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const tmpPathname = `${pathname}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPathname, payload, "utf8");
    fs.chmodSync(tmpPathname, 0o600);
    fs.renameSync(tmpPathname, pathname);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPathname);
    } catch {
      // the temp file never made it; nothing to clean up
    }
    throw err;
  }
}
