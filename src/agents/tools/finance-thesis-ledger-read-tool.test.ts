import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { financeThesisLedgerPath } from "../finance-state-dir.js";
import {
  openFinanceThesis,
  transitionFinanceThesis,
  type FinanceThesisOpenInput,
} from "../finance-thesis-ledger.js";
import type { AnyAgentTool } from "./common.js";
import { createFinanceThesisLedgerReadTool } from "./finance-thesis-ledger-read-tool.js";

/** Safely in the past, so the "no future observations" guard is never what a test measures. */
const PAST = "2026-09-10T00:00:00Z";
const LATER = "2026-09-10T06:00:00Z";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function storeDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-thesis-read-"));
  directories.push(directory);
  return directory;
}

function openInput(overrides: Partial<FinanceThesisOpenInput> = {}): FinanceThesisOpenInput {
  return {
    thesisId: "margin-reset",
    instrument: "AAA",
    claim: "Margins recover as pricing resets.",
    evidence: [{ id: "e1", source: "filing", reference: "10-Q 2026 Q2" }],
    invalidationConditions: ["Gross margin below 30% for two quarters."],
    observedAt: PAST,
    ...overrides,
  };
}

type ReadPayload = {
  ok: boolean;
  status?: string;
  reason?: string;
  action?: string;
  boundary?: string;
  ledgerDirectory?: string;
  resolvedFrom?: string;
  databasePath?: string;
  recordCount?: number;
  thesisCount?: number;
  headRef?: string | null;
  emptyReason?: string | null;
  knownThesisIds?: readonly string[];
  stateCounts?: { active: number; invalidated: number; realised: number };
  theses?: readonly {
    thesisId: string;
    state: string;
    closedAt: string | null;
    invalidationConditions?: readonly string[];
    transitionCount?: number;
    transitions?: readonly unknown[];
  }[];
};

async function read(tool: AnyAgentTool, args: Record<string, unknown> = {}): Promise<ReadPayload> {
  const result = await tool.execute("read-theses", args);
  return result.details as ReadPayload;
}

describe("finance_thesis_ledger_read", () => {
  it("reports an absent book as a named failure, not as a book with no theses", async () => {
    const directory = await storeDirectory();
    const payload = await read(createFinanceThesisLedgerReadTool({}), { directory });

    expect(payload.ok).toBe(false);
    expect(payload.status).toBe("absent");
    expect(payload.reason).toBe("finance_thesis_ledger_absent");
    // The whole point: an absent book must not be read as "no thesis is held".
    expect(payload.action).toContain("not evidence that no thesis is held");
    expect(payload.resolvedFrom).toBe("explicit");
  });

  it("separates 'nobody ever wrote here' from 'none existed yet at that instant'", async () => {
    const directory = await storeDirectory();
    await openFinanceThesis(directory, openInput());

    // asOf before the first record: the book is not unwritten, the view is simply early.
    const early = await read(createFinanceThesisLedgerReadTool({}), {
      directory,
      asOf: "2026-09-01T00:00:00Z",
    });
    expect(early.status).toBe("empty");
    expect(early.emptyReason).toContain("none existed yet at that instant");

    // The same book read without asOf is not empty, which is the difference the wording carries.
    const current = await read(createFinanceThesisLedgerReadTool({}), { directory });
    expect(current.status).toBe("ready");
    expect(current.emptyReason).toBeNull();
  });

  it("reads an open thesis with its invalidation conditions", async () => {
    const directory = await storeDirectory();
    await openFinanceThesis(directory, openInput());

    const payload = await read(createFinanceThesisLedgerReadTool({}), { directory });
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe("ready");
    expect(payload.thesisCount).toBe(1);
    const thesis = payload.theses?.[0];
    expect(thesis?.state).toBe("active");
    expect(thesis?.closedAt).toBeNull();
    expect(thesis?.invalidationConditions).toEqual(["Gross margin below 30% for two quarters."]);
    expect(payload.stateCounts).toEqual({ active: 1, invalidated: 0, realised: 0 });
  });

  it("reports invalidated and realised apart", async () => {
    const directory = await storeDirectory();
    await openFinanceThesis(directory, openInput());
    await openFinanceThesis(directory, openInput({ thesisId: "other" }));
    await transitionFinanceThesis(directory, {
      thesisId: "margin-reset",
      to: "invalidated",
      reason: "Margin printed 27%.",
      observedAt: LATER,
    });
    await transitionFinanceThesis(directory, {
      thesisId: "other",
      to: "realised",
      reason: "Margin printed 41%.",
      observedAt: LATER,
    });

    const payload = await read(createFinanceThesisLedgerReadTool({}), { directory });
    expect(payload.stateCounts).toEqual({ active: 0, invalidated: 1, realised: 1 });
    // A reader who collapses these into "closed" cannot tell a wrong call from a right one.
    expect(payload.theses?.find((item) => item.thesisId === "margin-reset")?.state).toBe(
      "invalidated",
    );
    expect(payload.theses?.find((item) => item.thesisId === "other")?.state).toBe("realised");
  });

  it("refuses an unknown thesisId with the known ids rather than reporting empty", async () => {
    const directory = await storeDirectory();
    await openFinanceThesis(directory, openInput());

    const payload = await read(createFinanceThesisLedgerReadTool({}), {
      directory,
      thesisId: "no-such-thesis",
    });
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe("finance_thesis_ledger_thesis_id_unknown");
    expect(payload.knownThesisIds).toEqual(["margin-reset"]);
  });

  it("gives a historical view: a thesis closed later reads as still active", async () => {
    const directory = await storeDirectory();
    await openFinanceThesis(directory, openInput());
    await transitionFinanceThesis(directory, {
      thesisId: "margin-reset",
      to: "invalidated",
      reason: "Margin printed 27%.",
      observedAt: LATER,
    });

    const before = await read(createFinanceThesisLedgerReadTool({}), {
      directory,
      asOf: PAST,
    });
    expect(before.theses?.[0]?.state).toBe("active");
    expect(before.recordCount).toBe(1);

    const after = await read(createFinanceThesisLedgerReadTool({}), {
      directory,
      asOf: LATER,
    });
    expect(after.theses?.[0]?.state).toBe("invalidated");
  });

  it("rejects an unparseable asOf", async () => {
    const directory = await storeDirectory();
    await openFinanceThesis(directory, openInput());
    const payload = await read(createFinanceThesisLedgerReadTool({}), {
      directory,
      asOf: "not-a-date",
    });
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe("finance_thesis_ledger_as_of_invalid");
  });

  it("includes the transition chain only when asked", async () => {
    const directory = await storeDirectory();
    await openFinanceThesis(directory, openInput());
    await transitionFinanceThesis(directory, {
      thesisId: "margin-reset",
      to: "realised",
      reason: "Target reached.",
      observedAt: LATER,
    });

    const brief = await read(createFinanceThesisLedgerReadTool({}), { directory });
    expect(brief.theses?.[0]?.transitionCount).toBe(1);
    expect(brief.theses?.[0]?.transitions).toBeUndefined();

    const full = await read(createFinanceThesisLedgerReadTool({}), {
      directory,
      includeTransitions: true,
    });
    expect(full.theses?.[0]?.transitions).toHaveLength(1);
  });

  it("reading does not write: size and head are unchanged", async () => {
    const directory = await storeDirectory();
    await openFinanceThesis(directory, openInput());
    const database = financeThesisLedgerPath(directory);
    const before = await fs.stat(database);
    const beforeRead = await read(createFinanceThesisLedgerReadTool({}), { directory });

    await read(createFinanceThesisLedgerReadTool({}), { directory, includeTransitions: true });
    await read(createFinanceThesisLedgerReadTool({}), { directory, asOf: PAST });

    const after = await fs.stat(database);
    const afterRead = await read(createFinanceThesisLedgerReadTool({}), { directory });
    expect(after.size).toBe(before.size);
    expect(afterRead.headRef).toBe(beforeRead.headRef);
    expect(afterRead.recordCount).toBe(beforeRead.recordCount);
  });
});
