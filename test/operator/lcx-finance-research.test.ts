import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { QUALITY_ROUTER_MAX_INPUT_BYTES } from "../../scripts/operator/lcx-finance-research-run.ts";
import { runFinanceResearchCli } from "../../scripts/operator/lcx-finance-research.ts";
import { buildFinanceCaseRun, saveFinanceCaseRun } from "../../src/agents/finance-caseflow.ts";
import { runFinanceResearchRun } from "../../src/agents/finance-research-runner.ts";

const input = ["--ask", "过去六个月加密货币和美股市场情绪", "--as-of", "2026-09-08T00:00:00Z"];

describe("finance research operator", () => {
  it("leaves room for the bounded quality packet before adapter prompt compaction", () => {
    expect(QUALITY_ROUTER_MAX_INPUT_BYTES).toBeGreaterThan(256_000);
  });

  it("rejects reasoning overrides outside an explicit workflow", async () => {
    await expect(
      runFinanceResearchCli([...input, "--workflow-reasoning", "bounded_workflow"]),
    ).rejects.toThrow("requires --workflow-models");
    await expect(
      runFinanceResearchCli([...input, "--workflow-models", "--workflow-reasoning", "invalid"]),
    ).rejects.toThrow("provider_default or bounded_workflow");
  });

  it("rejects ambiguous configured-model authority before collection", async () => {
    for (const override of [["--model", "fixture"], ["--sources-only"]]) {
      await expect(
        runFinanceResearchCli([...input, "--workflow-models", ...override]),
      ).rejects.toThrow("cannot combine local overrides or sources-only");
      await expect(
        runFinanceResearchCli([...input, "--configured-model", ...override]),
      ).rejects.toThrow("cannot combine local overrides or sources-only");
    }
  });
  it("plans source recovery without model or network work", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "finance-recovery-cli-"));
    try {
      const file = path.join(directory, "original.json");
      await fs.writeFile(
        file,
        JSON.stringify({
          schemaVersion: "lcx_finance_research_batch_v1",
          boundary: "finance_research_batch_research_only",
          correlationId: "fixture",
          asOf: "2026-09-08T00:00:00Z",
          jobs: [],
        }),
      );
      const result = await runFinanceResearchCli([
        "--recover-from",
        file,
        "--as-of",
        "2026-09-08T00:01:00Z",
      ]);
      expect(result).toMatchObject({
        status: "planned",
        adopted: false,
        originalEvidenceRewritten: false,
      });
      expect("batch" in result).toBe(false);
      await expect(
        runFinanceResearchCli([
          "--recover-from",
          file,
          "--as-of",
          "2026-09-08T00:01:00Z",
          "--configured-model",
        ]),
      ).rejects.toThrow("cannot combine");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it("returns a fixed-date plan without model or source execution", async () => {
    const receipt = await runFinanceResearchCli(input);
    if (!("plan" in receipt)) {
      throw new Error("expected research receipt");
    }
    expect(receipt.status).toBe("planned");
    expect(receipt.batch).toBeUndefined();
    expect(receipt.committee).toBeUndefined();
    expect(receipt.plan.asOf).toBe("2026-09-08T00:00:00Z");
  });
  it("rejects unconfigured live execution before collection", async () => {
    await expect(runFinanceResearchCli([...input, "--live"])).rejects.toThrow("--workflow-models");
  });
  it("rejects retired local research authority even with explicit local artifacts", async () => {
    await expect(
      runFinanceResearchCli([
        ...input,
        "--live",
        "--model",
        "local/test",
        "--adapter",
        "/missing-adapter",
      ]),
    ).rejects.toThrow("local research/review roles retired");
  });
  it("rejects an invalid API budget", async () => {
    await expect(runFinanceResearchCli([...input, "--max-api-calls", "0"])).rejects.toThrow(
      "positive integer",
    );
  });
  it("persists and reads a case through the existing operator", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "caseflow-cli-"));
    try {
      const result = await runFinanceResearchCli([
        ...input,
        "--case-dir",
        directory,
        "--case-id",
        "market-case",
      ]);
      expect("savedCaseRun" in result).toBe(true);
      if (!("savedCaseRun" in result) || !result.savedCaseRun) {
        throw new Error("missing saved run");
      }
      const frozen = await runFinanceResearchCli([
        "--case-dir",
        directory,
        "--read-run",
        result.savedCaseRun.ref,
      ]);
      expect("case" in frozen && frozen.case.id).toBe("market-case");
      const diff = await runFinanceResearchCli([
        "--case-dir",
        directory,
        "--read-run",
        result.savedCaseRun.ref,
        "--compare-run",
        result.savedCaseRun.ref,
      ]);
      expect("definitionChanged" in diff && diff.definitionChanged).toBe(false);
      await expect(
        runFinanceResearchCli([
          "--case-dir",
          directory,
          "--read-run",
          result.savedCaseRun.ref,
          "--live",
        ]),
      ).rejects.toThrow("cannot execute");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  it("rejects checkpoint mutation in planning mode", async () => {
    await expect(runFinanceResearchCli([...input, "--checkpoint-run", "resume-1"])).rejects.toThrow(
      "requires live case research",
    );
  });
  it("rejects an invalid inference budget before execution", async () => {
    await expect(runFinanceResearchCli([...input, "--max-model-calls", "0"])).rejects.toThrow(
      "positive integer",
    );
  });
  it.each(["0", "Infinity", "NaN", "1.5", "9007199254740992"])(
    "rejects an invalid model output limit %s before execution",
    async (value) => {
      await expect(runFinanceResearchCli([...input, "--max-model-tokens", value])).rejects.toThrow(
        "positive safe integer",
      );
    },
  );
  it("keeps a finite model output allowance in planning mode without dispatching research", async () => {
    // A finite dry-plan allowance does not resolve or call a configured model.
    const result = await runFinanceResearchCli([...input, "--max-model-tokens", "16385"]);
    expect("status" in result && result.status).toBe("planned");
  });
  it("records and lists an outcome without invoking research", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "outcome-cli-"));
    try {
      const receipt = await runFinanceResearchRun({
        input: { ask: "Fixture claim", asOf: "2025-01-01T00:00:00Z" },
      });
      const run = buildFinanceCaseRun({
        caseId: "fixture",
        execution: {},
        budget: { maxApiCalls: 1 },
        receipt: {
          ...receipt,
          quarterlyOutput: {
            ...receipt.quarterlyOutput,
            candidateClaims: [
              {
                id: "c1",
                text: "Original fixture hypothesis",
                status: "uncertain",
                evidenceIds: [],
              },
            ],
          },
        },
      });
      const saved = await saveFinanceCaseRun(directory, run);
      const inputFile = path.join(directory, "observation.json");
      await fs.writeFile(
        inputFile,
        JSON.stringify({
          recordId: "review-1",
          checkpointMonths: 3,
          observedAt: "2025-04-01T00:00:00Z",
          evidence: [
            {
              id: "e1",
              source: "fixture://source",
              sourceTimestamp: "2025-04-01T00:00:00Z",
              field: "close",
              value: 10,
            },
          ],
          assessments: [
            {
              claimId: "c1",
              finding: "inconclusive",
              evidenceIds: ["e1"],
              deviation: "Not numerically specified",
              invalidationConditions: ["Needs more evidence"],
            },
          ],
        }),
      );
      const args = ["--case-dir", directory, "--packet-ref", saved.ref];
      const recorded = await runFinanceResearchCli([...args, "--outcome-file", inputFile]);
      expect("status" in recorded && recorded.status).toBe("recorded_for_review");
      expect(await runFinanceResearchCli([...args, "--list-outcomes"])).toEqual([recorded]);
      await expect(runFinanceResearchCli([...args, "--list-outcomes", "--live"])).rejects.toThrow(
        "cannot run simultaneously",
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

it("exposes complete source planning and prevents collection flags on read operations", async () => {
  const result = await runFinanceResearchCli([...input, "--all-sources"]);
  if (!("plan" in result) || !result.plan.sourceInventory) {
    throw new Error("expected all-source inventory");
  }
  const inventory = result.plan.sourceInventory;
  // Discovery must not invent a date/quarter or a compatible derivatives asset.
  const requiresExplicitScope = inventory.registeredAdapterIds.filter((id) =>
    [
      "fmp_eod_bulk",
      "fmp_earning_call_transcript",
      "fmp_institutional_ownership_symbol_positions_summary",
      "deribit_public_option_summary",
      "deribit_public_future_summary",
    ].includes(id),
  );
  expect(inventory.unplannedAdapterIds).toEqual(requiresExplicitScope);
  expect(result.plan.expectedJobCount).toBe(
    inventory.registeredAdapterIds.length - requiresExplicitScope.length,
  );
  expect(result.batch).toBeUndefined();
  await expect(runFinanceResearchCli([...input, "--sources-only"])).rejects.toThrow(
    "requires --live",
  );
  await expect(runFinanceResearchCli(["--list-cases", "--all-sources"])).rejects.toThrow(
    "research mode",
  );
});
