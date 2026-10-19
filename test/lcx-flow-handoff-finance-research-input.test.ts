import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runner from "../src/agents/finance-research-runner.js";
import * as recording from "../src/agents/finance-result-recording.js";
import * as config from "../src/config/config.js";
import {
  probeOriginalResearchInput,
  type ResearchInputFault,
} from "./fixtures/lcx-waterflow-finance-research-input-probe.js";

describe("fresh original preflight files -> original research reader -> native dry receipt", () => {
  let directory: string;
  let inputs: runner.FinanceResearchRunInput[];
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-research-input-"));
    inputs = [];
    vi.stubEnv("OPENCLAW_WORKSPACE_DIR", path.join(directory, "workspace"));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network forbidden"))),
    );
    vi.spyOn(config, "loadConfig").mockImplementation(() => {
      throw new Error("real config forbidden");
    });
    const actualRecording = recording.recordFinanceResearchResult;
    vi.spyOn(recording, "recordFinanceResearchResult").mockImplementation((input) =>
      actualRecording({
        ...input,
        host: {
          workspaceDir: input.workspaceDir,
          config: { agents: { defaults: { memorySearch: { enabled: false } } } },
        },
      }),
    );
    const actualRunner = runner.runFinanceResearchRun;
    vi.spyOn(runner, "runFinanceResearchRun").mockImplementation(async (options) => {
      inputs.push(structuredClone(options.input));
      return actualRunner(options);
    });
  });
  afterEach(async () => {
    expect(config.loadConfig).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function probe(fault?: ResearchInputFault) {
    const result = await probeOriginalResearchInput({ directory, fault });
    const proof = { ...result, actualRunnerInputs: inputs };
    const proofRoot = process.env.LCX_RESEARCH_INPUT_PROOF_DIR;
    if (proofRoot) {
      const caseDirectory = path.join(proofRoot, fault ?? "normal");
      await fs.mkdir(caseDirectory, { recursive: true });
      await fs.writeFile(
        path.join(caseDirectory, "native-reader-result.json"),
        JSON.stringify(proof, null, 2) + "\n",
      );
      await fs.writeFile(
        path.join(caseDirectory, "preflight-evidence-original.json"),
        result.originalEvidenceBytes,
      );
      await fs.writeFile(
        path.join(caseDirectory, "preflight-context-original.json"),
        result.originalContextBytes,
      );
      if (result.receiptReadbackBytes) {
        await fs.writeFile(
          path.join(caseDirectory, "native-planned-receipt.json"),
          result.receiptReadbackBytes,
        );
      }
    }
    return result;
  }
  it("actually reads this attempt's fresh broker evidence and rule into the original runner", async () => {
    const result = await probe();
    expect(inputs).toHaveLength(1);
    const fresh = JSON.parse(result.originalEvidenceBytes);
    expect(inputs[0].controllerEvidence).toEqual(expect.arrayContaining(fresh));
    expect(inputs[0].portfolioContext).toEqual(JSON.parse(result.originalContextBytes));
    const rule = inputs[0].controllerEvidence!.find(
      (item) => item.source === "finance-strategy-rule-ledger",
    );
    expect(rule?.text).toContain('"lookbackMonths":3');
    const body = JSON.parse(fresh[0].text);
    expect(body.accountScope.accountId).toBe(inputs[0].portfolioContext!.accountId);
    expect(body.accountScope.venue).toBe("paper");
    expect(body.currentAccountFactsStatus).toBe("unknown");
    expect(fresh[0].timestamp).toBe(result.asOf);
    expect(result.evidencePath).toContain(result.attemptRunId);
    expect(result.consumedEvidenceSha256).toBe(result.originalEvidenceSha256);
    expect(result.receiptReadback).toEqual(result.output!.receipt);
    expect(result.output!.receipt.status).toBe("planned");
    expect(result.output!.receipt.gates.every((gate) => !gate.passed)).toBe(true);
  });
  it.each([
    "cross_account",
    "cross_venue",
    "body_position_account",
    "body_profit_account",
    "source_whitespace_cross_account",
    "missing_account_scope",
    "invalid_broker_summary",
  ] as const)(
    "rejects %s at the pinned reader and the programmatic account boundary",
    async (fault) => {
      const result = await probe(fault);
      expect(inputs).toHaveLength(0);
      expect(result.failure).toBe("controller handoff controllerEvidence path or bytes mismatch");
      // The scheduled reader rejects changed bytes before normalization. Keep the
      // independent programmatic account guard covered without forging a new pin.
      await expect(
        runner.runFinanceResearchRun({
          input: {
            ask: "Validate supplied private account evidence.",
            asOf: result.asOf,
            controllerEvidence: JSON.parse(result.consumedEvidenceBytes!),
            portfolioContext: JSON.parse(result.originalContextBytes),
          },
          liveFetch: false,
          workspaceDir: result.workspace,
        }),
      ).rejects.toThrow(/broker account scope/);
      expect(inputs).toHaveLength(1);
      const broker = inputs[0].controllerEvidence!.find(
        (item) => item.source.trim() === "finance-broker-profit-summary",
      )!;
      expect(broker).toBeDefined();
      expect(result.originalEvidenceSha256).not.toBe(result.consumedEvidenceSha256);
      expect(result.output).toBeUndefined();
      expect(result.receiptReadback).toBeUndefined();
      expect(recording.recordFinanceResearchResult).not.toHaveBeenCalled();
      expect(result.processResult).toMatchObject({ ok: false, status: "failed", exitCode: 1 });
    },
  );
  it.each([
    "missing_evidence",
    "invalid_evidence_json",
    "missing_context",
    "invalid_context_json",
  ] as const)("preserves original %s read failure before the runner", async (fault) => {
    const result = await probe(fault);
    expect(inputs).toEqual([]);
    expect(result.failure).toMatch(
      fault.startsWith("missing") ? /ENOENT/ : /controller handoff .* path or bytes mismatch/,
    );
    expect(result.output).toBeUndefined();
    expect(result.receiptReadback).toBeUndefined();
    expect(result.processResult).toMatchObject({ ok: false, status: "failed", exitCode: 1 });
  });
  it("keeps legacy unscoped night aggregate research compatible without portfolioContext", async () => {
    const asOf = new Date().toISOString();
    const receipt = await runner.runFinanceResearchRun({
      input: {
        ask: "Review SPY research context.",
        asOf,
        controllerEvidence: [
          {
            id: "private-legacy-night-aggregate",
            source: "finance-broker-profit-summary",
            timestamp: asOf,
            text: '{"accounts":[],"currentAccountFactsStatus":"unknown"}',
          },
        ],
      },
      workspaceDir: directory,
      liveFetch: false,
    });
    expect(receipt.status).toBe("planned");
    expect(receipt.gates.every((gate) => !gate.passed)).toBe(true);
    const proofRoot = process.env.LCX_RESEARCH_INPUT_PROOF_DIR;
    if (proofRoot) {
      const caseDirectory = path.join(proofRoot, "legacy_unscoped");
      await fs.mkdir(caseDirectory, { recursive: true });
      await fs.writeFile(
        path.join(caseDirectory, "native-programmatic-result.json"),
        JSON.stringify({ actualRunnerInputs: inputs, receipt, persisted: false }, null, 2) + "\n",
      );
    }
  });
});
