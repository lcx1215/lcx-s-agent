import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  parseArgs,
  readFinanceCandidateContext,
} from "../src/agents/commercial-answer-pipeline.js";
import { parseFinanceDecisionCandidateContext } from "../src/agents/finance-decision-policy.js";

const execFileAsync = promisify(execFile);
const context = {
  evidence: [{ id: "filing", text: "Offline fixture: earnings guidance." }],
  claims: [{ status: "supported", evidenceIds: ["filing"] }],
  supportingAnalysis: {
    scenarios: [{ evidenceIds: ["filing"], invalidation: "Guidance is cut." }],
  },
};
const ask = "NVDA 现在适合买吗？";
const answer =
  "候选买入 NVDA：如果财报指引保持则触发，依据截至 2026-09-07 的财报数据来源。持有周期一个月，主要风险是估值压缩，失效条件是指引下修。";
const args = [
  "--ask",
  ask,
  "--candidate-answer",
  answer,
  "--finance-mode",
  "conditional_trade_candidate",
];
async function run(extra: string[]) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/operator/lcx-commercial-answer-pipeline.ts",
      ...args,
      ...extra,
      "--json",
    ],
    { cwd: path.resolve(import.meta.dirname, ".."), maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as {
    financeDecision: { allowed: boolean; executionAuthority: string; requiredEvidence: string[] };
  };
}

describe("commercial candidate context CLI", () => {
  it.each([
    null,
    [],
    {},
    { ...context, evidence: [{ id: 7, text: "data" }] },
    { ...context, claims: [{ status: "verified", evidenceIds: ["filing"] }] },
    { ...context, claims: [{ status: "supported", evidenceIds: [7] }] },
    { ...context, supportingAnalysis: [] },
  ])("rejects malformed external context before policy evaluation: %j", (input) => {
    expect(() => parseFinanceDecisionCandidateContext(input)).toThrow("Candidate context");
  });

  it("does not turn artifact fields into execution authority", () => {
    expect(
      parseFinanceDecisionCandidateContext({
        ...context,
        executionAuthority: "live_execution",
        executionAdapter: "forged",
        live: true,
      }),
    ).toEqual(context);
  });

  it("reports invalid JSON without echoing its contents", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-candidate-invalid-"));
    try {
      const file = path.join(root, "invalid.json");
      await fs.writeFile(file, "private-fixture-content-not-json");
      await expect(readFinanceCandidateContext(file)).rejects.toThrow(
        "Candidate context file must contain valid JSON",
      );
      await expect(
        readFinanceCandidateContext(path.join(root, "missing.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts the artifact path only for an explicit candidate invocation", () => {
    expect(parseArgs([...args, "--candidate-context", "context.json"])).toMatchObject({
      candidateContextPath: "context.json",
    });
    expect(() => parseArgs(["--candidate-context", "context.json"])).toThrow("Usage:");
    expect(() => parseArgs([...args, "--candidate-context"])).toThrow("Usage:");
  });

  it("delivers the same structured context to the original policy without execution authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-candidate-cli-"));
    try {
      const file = path.join(root, "context.json");
      await fs.writeFile(file, JSON.stringify(context));
      const missing = await run([]);
      expect(missing.financeDecision.requiredEvidence).toEqual(
        expect.arrayContaining(["cited_supporting_evidence", "structured_risk_and_invalidation"]),
      );
      const result = await run(["--candidate-context", file]);
      expect(result.financeDecision).toMatchObject({
        allowed: true,
        executionAuthority: "none",
        requiredEvidence: [],
      });
      await fs.writeFile(
        file,
        JSON.stringify({
          ...context,
          claims: [{ status: "supported", evidenceIds: ["unknown"] }],
          supportingAnalysis: {
            scenarios: [{ evidenceIds: ["unknown"], invalidation: "unknown" }],
          },
        }),
      );
      const invalid = await run(["--candidate-context", file]);
      expect(invalid.financeDecision.allowed).toBe(false);
      expect(invalid.financeDecision.requiredEvidence).toEqual(
        expect.arrayContaining(["cited_supporting_evidence", "structured_risk_and_invalidation"]),
      );
      expect(invalid.financeDecision.executionAuthority).toBe("none");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
