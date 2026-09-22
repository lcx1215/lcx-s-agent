import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { financeResearchScoredPath } from "./finance-state-dir.js";
import {
  readFinanceScoredFloorSamples,
  runFinanceTuningLifecycle,
} from "./finance-tuning-lifecycle.js";

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "finance-tuning-lifecycle-"));
});

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

function appendScores(conviction: number, outcomes: readonly (0 | 1)[]) {
  fs.appendFileSync(
    financeResearchScoredPath(directory),
    outcomes.map((outcome) => JSON.stringify({ conviction, outcome })).join("\n") + "\n",
  );
}

describe("automatic finance tuning lifecycle", () => {
  it("promotes the first re-derived floor for paper use and is idempotent", () => {
    appendScores(0.7, [1, 1, 1, 1, 1]);
    const first = runFinanceTuningLifecycle({
      directory,
      generatedAt: "2026-09-23T00:00:00.000Z",
    });
    expect(first.newlyRecorded).toBe(1);
    expect(first.promotions[0]).toMatchObject({
      appended: true,
      promotion: { previous: null, promoted: 0.7, authority: "paper_only" },
    });

    const replay = runFinanceTuningLifecycle({
      directory,
      generatedAt: "2026-09-23T00:01:00.000Z",
    });
    expect(replay.newlyRecorded).toBe(0);
    expect(replay.promotions).toEqual([]);
    expect(replay.proposal.proposals).toEqual([]);
  });

  it("ignores malformed outcomes rather than converting them into losses", () => {
    fs.writeFileSync(
      financeResearchScoredPath(directory),
      '{"conviction":0.8,"outcome":"wrong"}\n{"conviction":0.8,"outcome":1}\n',
    );
    expect(readFinanceScoredFloorSamples(directory)).toEqual([{ conviction: 0.8, outcome: 1 }]);
  });
});
