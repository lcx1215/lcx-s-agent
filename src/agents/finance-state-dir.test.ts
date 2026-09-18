import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FINANCE_OUTCOME_LEDGER_FILENAME,
  FINANCE_POSITION_LEDGER_FILENAME,
  FINANCE_STATE_DIR_ENV,
  financeOutcomeLedgerPath,
  financePositionLedgerPath,
  resolveFinancePositionLedgerLocation,
  resolveFinanceStateDir,
} from "./finance-state-dir.js";

const temporary: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-state-dir-"));
  temporary.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((item) => fs.rm(item, { recursive: true, force: true })),
  );
});

describe("finance state directory resolution", () => {
  it("prefers an explicit directory over the environment and the workspace default", () => {
    const resolved = resolveFinanceStateDir({
      workspaceDir: "/workspace",
      directory: "/explicit/book",
      env: { [FINANCE_STATE_DIR_ENV]: "/env/book" },
    });
    expect(resolved).toEqual({ directory: "/explicit/book", source: "explicit" });
  });

  it("prefers the environment over the workspace default", () => {
    const resolved = resolveFinanceStateDir({
      workspaceDir: "/workspace",
      env: { [FINANCE_STATE_DIR_ENV]: "/env/book" },
    });
    expect(resolved).toEqual({ directory: "/env/book", source: "env" });
  });

  it("falls back to the workspace default and names that source", () => {
    const resolved = resolveFinanceStateDir({ workspaceDir: "/workspace", env: {} });
    // Named, not guessed: a caller reading the default directory is reading this repository's
    // own convention, which is exactly the case where it may not be the operator's real book.
    expect(resolved).toEqual({
      directory: path.join("/workspace", "state", "finance"),
      source: "workspace_default",
    });
  });

  it("treats blank explicit and env values as absent rather than as a path", () => {
    const resolved = resolveFinanceStateDir({
      workspaceDir: "/workspace",
      directory: "   ",
      env: { [FINANCE_STATE_DIR_ENV]: "  " },
    });
    expect(resolved.source).toBe("workspace_default");
  });

  it("places the ledger database inside the resolved directory", () => {
    const location = resolveFinancePositionLedgerLocation({
      workspaceDir: "/workspace",
      directory: "/book",
    });
    expect(location.directory).toBe("/book");
    expect(location.database).toBe(path.join("/book", FINANCE_POSITION_LEDGER_FILENAME));
    expect(location.source).toBe("explicit");
  });

  it("suffixes each ledger file with its schema generation", () => {
    expect(FINANCE_POSITION_LEDGER_FILENAME).toBe("position-ledger_1.sqlite");
    expect(FINANCE_OUTCOME_LEDGER_FILENAME).toBe("outcome-ledger_1.sqlite");
  });

  it("adopts a generation-1 book still stored under its pre-suffix name", async () => {
    const directory = await temporaryDirectory();
    await fs.writeFile(path.join(directory, "position-ledger.sqlite"), "");
    // Generation 1 shipped unsuffixed. Leaving that file behind would report an empty book,
    // which is indistinguishable from a flat account — the one failure mode this module exists
    // to prevent.
    expect(financePositionLedgerPath(directory)).toBe(
      path.join(directory, "position-ledger.sqlite"),
    );
  });

  it("prefers the suffixed name once that file exists", async () => {
    const directory = await temporaryDirectory();
    await fs.writeFile(path.join(directory, "position-ledger.sqlite"), "");
    await fs.writeFile(path.join(directory, FINANCE_POSITION_LEDGER_FILENAME), "");
    expect(financePositionLedgerPath(directory)).toBe(
      path.join(directory, FINANCE_POSITION_LEDGER_FILENAME),
    );
  });

  it("names the suffixed path for the outcome ledger too", async () => {
    const directory = await temporaryDirectory();
    expect(financeOutcomeLedgerPath(directory)).toBe(
      path.join(directory, FINANCE_OUTCOME_LEDGER_FILENAME),
    );
  });
});
