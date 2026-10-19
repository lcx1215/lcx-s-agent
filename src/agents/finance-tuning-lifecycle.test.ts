import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { financeResearchScoredPath, financeTuningProposalsPath } from "./finance-state-dir.js";
import {
  readFinanceScoredFloorSamples,
  readFinanceScoredFloorSamplesWithSource,
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
  it("records directional calibration proposals but blocks paper execution promotion", () => {
    appendScores(0.7, [1, 1, 1, 1, 1]);
    const first = runFinanceTuningLifecycle({
      directory,
      generatedAt: "2026-09-23T00:00:00.000Z",
    });
    expect(first.newlyRecorded).toBe(1);
    expect(first.promotions).toEqual([]);
    expect(first.paperExecutionPromotion).toMatchObject({
      status: "blocked",
      reason: "directional_forecast_outcomes_are_not_net_trade_pnl",
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

it("binds parsed scores to the same raw Buffer without hiding ignored rows or inventing absent hashes", () => {
  const filename = financeResearchScoredPath(directory);
  const absent = readFinanceScoredFloorSamplesWithSource(directory);
  expect(absent.samples).toEqual([]);
  expect(absent.sourceRead).toMatchObject({
    status: "absent",
    path: filename,
    includedSampleCount: 0,
    ignoredRowCount: 0,
  });
  expect(absent.sourceRead).not.toHaveProperty("sha256");
  // Invalid UTF-8 keeps its original byte identity; the existing UTF-8/JSON parser ignores it.
  const bytes = Buffer.concat([
    Buffer.from('{"conviction":"0.8","outcome":1}\nnot-json\n'),
    Buffer.from([0xff, 0x0a]),
  ]);
  fs.writeFileSync(filename, bytes);
  const read = readFinanceScoredFloorSamplesWithSource(directory);
  expect(read.samples).toEqual(readFinanceScoredFloorSamples(directory));
  expect(read.samples).toEqual([{ conviction: 0.8, outcome: 1 }]);
  expect(read.sourceRead).toMatchObject({
    status: "read",
    path: filename,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    includedSampleCount: 1,
    ignoredRowCount: 2,
    usedFields: ["conviction", "outcome"],
    boundary: "raw_ledger_bytes_and_parsed_fields_not_source_truth",
  });
  expect(read.sourceRead.sha256).not.toBe(
    createHash("sha256").update(bytes.toString("utf8")).digest("hex"),
  );
  expect(runFinanceTuningLifecycle({ directory }).sourceRead).toEqual(read.sourceRead);
  fs.appendFileSync(filename, '{"conviction":0.7,"outcome":0}\n');
  const changed = readFinanceScoredFloorSamplesWithSource(directory);
  expect(changed.sourceRead.sha256).not.toBe(read.sourceRead.sha256);
  expect(changed.sourceRead.includedSampleCount).toBe(2);
});

describe("expected finance tuning source", () => {
  function sourcePin() {
    const filename = financeResearchScoredPath(directory);
    const bytes = fs.readFileSync(filename);
    return {
      path: filename,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
  }

  it("accepts the exact scored source pin and keeps directional promotion blocked", () => {
    appendScores(0.7, [1, 1, 1, 1, 1]);
    const expectedSource = sourcePin();
    const result = runFinanceTuningLifecycle({ directory, expectedSource });
    expect(result.sourceRead).toMatchObject({ status: "read", ...expectedSource });
    expect(result.newlyRecorded).toBe(1);
    expect(fs.existsSync(financeTuningProposalsPath(directory))).toBe(true);
    expect(result.promotions).toEqual([]);
    expect(result.paperExecutionPromotion.status).toBe("blocked");
  });

  it.each(["foreign-book", "changed-bytes", "wrong-bytes", "absent"] as const)(
    "rejects %s before writing any proposal",
    (fault) => {
      appendScores(0.7, [1, 1, 1, 1, 1]);
      const expectedSource = sourcePin();
      let selectedDirectory = directory;
      if (fault === "foreign-book") {
        selectedDirectory = path.join(directory, "other-book");
        fs.mkdirSync(selectedDirectory);
        fs.copyFileSync(expectedSource.path, financeResearchScoredPath(selectedDirectory));
        expect(fs.readFileSync(financeResearchScoredPath(selectedDirectory))).toEqual(
          fs.readFileSync(expectedSource.path),
        );
      } else if (fault === "changed-bytes") {
        fs.appendFileSync(expectedSource.path, " ");
      } else if (fault === "wrong-bytes") {
        expectedSource.bytes += 1;
      } else {
        fs.unlinkSync(expectedSource.path);
      }
      expect(() =>
        runFinanceTuningLifecycle({ directory: selectedDirectory, expectedSource }),
      ).toThrow("input_source_mismatch");
      expect(fs.existsSync(financeTuningProposalsPath(directory))).toBe(false);
      expect(fs.existsSync(financeTuningProposalsPath(selectedDirectory))).toBe(false);
    },
  );
});
