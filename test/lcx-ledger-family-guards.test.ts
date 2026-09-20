import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards for two defect families that were found and fixed in this repository, written so that a
 * *new* ledger or database is caught automatically rather than being added to a list nobody
 * remembers to update.
 *
 * 1. A SQLite database opened without `busy_timeout` fails the instant another process holds the
 *    write lock ("database is locked") instead of waiting for it. The memory index shipped without
 *    it while every finance book had it.
 * 2. A ledger that stores a chain (`previousRef`) but never verifies it accepts tampered or
 *    corrupted rows silently, which reads as an empty book rather than as a broken one.
 *
 * Both checks discover their own subjects, so they keep working as the repository grows.
 */

const SRC = path.join(process.cwd(), "src");
const SCAN_DIRS = ["agents", "memory", "infra"];

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        found.push(full);
      }
    }
  };
  for (const dir of SCAN_DIRS) {
    walk(path.join(SRC, dir));
  }
  return found;
}

const relative = (file: string) => path.relative(process.cwd(), file).split(path.sep).join("/");

describe("every opened database waits for the write lock", () => {
  it("sets busy_timeout wherever a DatabaseSync is opened", () => {
    const offenders = sourceFiles()
      .filter((file) => fs.readFileSync(file, "utf8").includes("new DatabaseSync("))
      .filter((file) => !fs.readFileSync(file, "utf8").includes("busy_timeout"))
      .map(relative);
    expect(offenders).toEqual([]);
  });
});

describe("every ledger verifies its chain", () => {
  it("checks previousRef wherever a ledger stores one", () => {
    // Storing a back-link and never comparing it is the gap: the chain is recorded but not
    // enforced, so a tampered or reordered row reads as a valid one.
    const offenders = sourceFiles()
      .filter((file) => /previousRef/u.test(fs.readFileSync(file, "utf8")))
      .filter((file) => !/previousRef !==/u.test(fs.readFileSync(file, "utf8")))
      .map(relative);
    expect(offenders).toEqual([]);
  });

  it("checks previousRef or record integrity wherever a finance record table is created", () => {
    const offenders = sourceFiles()
      .filter((file) => /CREATE TABLE\s+finance_\w*records/u.test(fs.readFileSync(file, "utf8")))
      .filter((file) => {
        const src = fs.readFileSync(file, "utf8");
        return !/previousRef !==/u.test(src) && !/integrity mismatch/u.test(src);
      })
      .map(relative);
    expect(offenders).toEqual([]);
  });
});
