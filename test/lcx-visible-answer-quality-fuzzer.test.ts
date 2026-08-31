import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

async function runQualityFuzzer(args: string[] = []) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/operator/lcx-visible-answer-quality-fuzzer.ts", ...args, "--json"],
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
        boundary: "local_visible_answer_quality_fuzzer_only",
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
        macroCoverageComplete: true,
      }),
    );
    expect(payload.macroCoverage).toEqual(
      expect.objectContaining({
        requiredMacroContracts: [
          "visible_answer_value",
          "single_entry_single_exit",
          "candidate_authority_and_council_evidence",
          "source_learning_and_memory_truth",
          "finance_data_and_trade_boundary",
          "owner_status_and_async_receipts",
        ],
        coveredMacroContracts: expect.arrayContaining([
          "visible_answer_value",
          "single_entry_single_exit",
          "candidate_authority_and_council_evidence",
          "source_learning_and_memory_truth",
          "finance_data_and_trade_boundary",
          "owner_status_and_async_receipts",
        ]),
        missingMacroContracts: [],
      }),
    );
    expect(payload.summary).toEqual(
      expect.objectContaining({
        families: 10,
        positive: 10,
        negative: 18,
        total: 28,
        failed: 0,
        positiveFailures: 0,
        negativeFailures: 0,
      }),
    );
    expect(payload.positiveCases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          caseId: "status_with_checked_evidence_positive",
          macroContractId: "owner_status_and_async_receipts",
          actualDecision: "adopt_visible_answer",
          ok: true,
        }),
        expect.objectContaining({
          caseId: "all_domain_answer_value_not_professional_filler_positive",
          macroContractId: "visible_answer_value",
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
        expect.objectContaining({
          caseId: "single_stock_loss_recovery_risk_triage_positive",
          macroContractId: "finance_data_and_trade_boundary",
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
        expect.objectContaining({
          caseId: "single_stock_loss_recovery_risk_triage_safe_but_empty_thesis_list",
          actualDecision: "return_failed_reason",
          ok: true,
          failedReasons: expect.arrayContaining([
            "single_stock_loss_reply_missing_concrete_risk_triage",
          ]),
        }),
        expect.objectContaining({
          caseId: "all_domain_answer_value_not_professional_filler_generic_consulting_words",
          actualDecision: "return_failed_reason",
          ok: true,
          failedReasons: expect.arrayContaining([
            "generic_professional_filler_without_answer_value",
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
        families: 10,
        positive: 10,
        negative: 10,
        total: 20,
        failed: 0,
      }),
    );
  });
});
