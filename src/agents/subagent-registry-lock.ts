import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const OWNER_FILE = /^(\d+)-([a-f0-9-]+)\.json$/;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
type Candidate = { owner: string; choosing: boolean; ticket: number };

function pidPresent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission/unknown errors never authorize an overlapping writer.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Synchronous Lamport bakery mutex for the original JSON registry. Each writer
 * owns a unique marker, publishes its ticket atomically, then waits for choosing
 * writers and smaller (ticket, owner) pairs. New arrivals choose larger tickets.
 *
 * A crash cannot strand a shared lock: dead owners are ignored, and no contender
 * removes/replaces a living owner's marker. This avoids stale-lock unlink races
 * and does not add a SQLite/runtime dependency to the synchronous registry API.
 */
export function acquireSubagentRegistryWriteLock(pathname: string): () => void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
  const canonical = path.join(fs.realpathSync(path.dirname(pathname)), path.basename(pathname));
  const directory = `${canonical}.write-lock`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const owner = `${process.pid}-${randomUUID()}.json`;
  const marker = path.join(directory, owner);
  const temporary = `${marker}.tmp`;
  const deadline = performance.now() + 5_000;
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    fs.rmSync(temporary, { force: true });
    fs.rmSync(marker, { force: true });
  };
  const candidates = (): Candidate[] => {
    const result: Candidate[] = [];
    for (const name of fs.readdirSync(directory)) {
      if (name.endsWith(".tmp")) {
        continue;
      }
      const match = OWNER_FILE.exec(name);
      if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0) {
        throw new Error("subagent registry write lock has an unknown owner marker");
      }
      const candidatePath = path.join(directory, name);
      if (!pidPresent(Number(match[1]))) {
        // Only this unique dead-owner marker can be removed, never a shared path.
        fs.rmSync(candidatePath, { force: true });
        continue;
      }
      let raw: string;
      try {
        if (!fs.lstatSync(candidatePath).isFile()) {
          throw new Error("subagent registry write lock owner is not a regular file");
        }
        raw = fs.readFileSync(candidatePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        // Another process may still be creating its initial choosing marker.
        result.push({ owner: name, choosing: true, ticket: 0 });
        continue;
      }
      if (
        typeof value !== "object" ||
        value === null ||
        !("choosing" in value) ||
        typeof value.choosing !== "boolean" ||
        !("ticket" in value) ||
        typeof value.ticket !== "number" ||
        !Number.isSafeInteger(value.ticket) ||
        value.ticket < 0 ||
        (!value.choosing && value.ticket === 0)
      ) {
        throw new Error("subagent registry write lock has an invalid owner ticket");
      }
      result.push({ owner: name, choosing: value.choosing, ticket: value.ticket });
    }
    return result;
  };
  try {
    fs.writeFileSync(marker, JSON.stringify({ choosing: true, ticket: 0 }), {
      flag: "wx",
      mode: 0o600,
    });
    const ticket = Math.max(0, ...candidates().map((entry) => entry.ticket)) + 1;
    if (!Number.isSafeInteger(ticket)) {
      throw new Error("subagent registry write lock ticket overflow");
    }
    fs.writeFileSync(temporary, JSON.stringify({ choosing: false, ticket }), {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, marker);
    while (
      candidates().some(
        (entry) =>
          entry.owner !== owner &&
          (entry.choosing ||
            entry.ticket < ticket ||
            (entry.ticket === ticket && entry.owner < owner)),
      )
    ) {
      if (performance.now() >= deadline) {
        throw new Error("subagent registry write lock timeout");
      }
      Atomics.wait(waitBuffer, 0, 0, 10);
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}
