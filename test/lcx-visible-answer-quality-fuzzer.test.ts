import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function runQualityFuzzer(args: string[] = []) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/dev/lcx-visible-answer-quality-fuzzer.ts", ...args, "--json"],
    {
      cwd: repoRoot,
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("lcx-visible-answer-quality-fuzzer", () => {
  it("accepts concise useful answers and rejects vague or unsafe answers", async () => {
    const payload = await runQualityFuzzer();

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "dev_visible_answer_quality_fuzzer_only",
        liveTouched: false,
        providerConfigTouched: false,
        protectedMemoryTouched: false,
      }),
    );
    expect(payload.macroContract).toEqual(
      expect.objectContaining({
        positiveAcceptanceNotOnlyRejection: true,
        conciseDirectAnswerRequired: true,
        noVagueConservativeFallback: true,
      }),
    );
    expect(payload.summary).toEqual(
      expect.objectContaining({
        families: 8,
        positive: 8,
        negative: 14,
        total: 22,
        failed: 0,
        positiveFailures: 0,
        negativeFailures: 0,
      }),
    );
    expect(payload.positiveCases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          caseId: "status_with_checked_evidence_positive",
          actualDecision: "adopt_visible_answer",
          ok: true,
        }),
        expect.objectContaining({
          caseId: "market_data_boundary_still_useful_positive",
          actualDecision: "adopt_visible_answer",
          ok: true,
        }),
        expect.objectContaining({
          caseId: "user_given_arithmetic_with_boundary_positive",
          actualDecision: "adopt_visible_answer",
          ok: true,
        }),
      ]),
    );
    expect(payload.negativeCases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          caseId: "entry_exit_no_fluff_vague_architecture_nonanswer",
          actualDecision: "return_failed_reason",
          ok: true,
          failedReasons: expect.arrayContaining([
            "vague_conservative_nonanswer_without_useful_next_step",
          ]),
        }),
        expect.objectContaining({
          caseId: "model_council_evidence_arbitration_fake_council",
          actualDecision: "return_failed_reason",
          ok: true,
          failedReasons: expect.arrayContaining([
            "provider_council_claim_without_attributable_outputs",
          ]),
        }),
      ]),
    );
    expect(payload.failedCases).toEqual([]);
  });

  it("can sample one bad answer per family while keeping the positive acceptance gate", async () => {
    const payload = await runQualityFuzzer(["--max-per-family", "1"]);

    expect(payload).toEqual(
      expect.objectContaining({
        ok: true,
      }),
    );
    expect(payload.summary).toEqual(
      expect.objectContaining({
        families: 8,
        positive: 8,
        negative: 8,
        total: 16,
        failed: 0,
      }),
    );
  });
});
