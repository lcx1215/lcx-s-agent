import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DISTILLATION_SAMPLE_SOURCE,
  distillationSampleHash,
  probeDistillationSample,
} from "./fixtures/lcx-waterflow-distillation-sample-probe.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function run(fault?: Parameters<typeof probeDistillationSample>[0]["fault"]) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("Network/provider calls forbidden in offline distillation sample");
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-distillation-sample-"));
  roots.push(root);
  const result = await probeDistillationSample({ workspaceDir: root, fault });
  const proofDir = process.env.LCX_DISTILLATION_SAMPLE_PROOF_DIR;
  if (proofDir) {
    await fs.mkdir(proofDir, { recursive: true });
    await fs.writeFile(
      path.join(proofDir, `${fault ?? "positive"}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
  return result;
}

describe("original local source intake tool-loop sample", () => {
  it("delivers actual read body to the next input, then writes a candidate consumed by original plan/review", async () => {
    const result = await run();
    expect(result.reading?.source).toBe(DISTILLATION_SAMPLE_SOURCE);
    expect(result.nextInputs[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "toolResult",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: DISTILLATION_SAMPLE_SOURCE }],
        }),
      ]),
    );
    expect(result.candidate).toMatchObject({
      sourceSha256: distillationSampleHash(DISTILLATION_SAMPLE_SOURCE),
      decision: "local_candidate_only",
    });
    expect(result.plan).toMatchObject({
      evidenceVerification: { sourceRegistryVerified: true, evaluationVerified: true },
      receiptWritten: true,
    });
    expect(result.review).toMatchObject({
      rows: [
        {
          status: "application_ready",
          evaluationIntegrityVerified: true,
          applicationContentAcceptance: { status: "not_observed" },
          proofCompleteness: { safety_boundary: true },
          exactMissingProof: ["application_content_acceptance_not_observed"],
          weak: true,
        },
      ],
    });
    expect(result.candidateQuoteMatchesSource).toBe(true);
    expect(result.unresolved).toContain("license_legal_review");
    expect(result.unresolved).toContain("distillation_semantic_acceptance");
  });

  it("retains the original missing-source read error without generating a candidate", async () => {
    const result = await run("missing_source");
    expect(result.sourceReadFailed).toBe(true);
    expect(result.candidate).toBeUndefined();
    expect(result.plan).toBeNull();
    expect(result.review).toBeNull();
    expect(result.finalMessages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: expect.stringContaining("source body unavailable") }],
    });
  });

  it("blocks changed source bytes in the existing source-bound evaluation consumer", async () => {
    const result = await run("hash_conflict");
    expect(result.plan).toMatchObject({
      evidenceVerification: { evaluationVerified: false },
      missingEvidence: expect.arrayContaining(["unverified_source_bound_application_eval"]),
    });
    expect(result.review).toMatchObject({
      rows: [{ evaluationVerified: false, weak: true }],
    });
    expect(result.finalMessages.at(-1)).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: expect.stringContaining("unverified_source_bound_application_eval") },
      ],
    });
  });

  it("holds invented candidate content and sends the actual original review gap to the final response", async () => {
    const result = await run("candidate_content_conflict");
    expect(result.candidateQuoteMatchesSource).toBe(false);
    // This is a precise missing semantic consumer, not a passed distillation workflow.
    expect(result.review).toMatchObject({
      rows: [
        {
          evaluationVerified: true,
          evaluationIntegrityVerified: true,
          applicationContentAcceptance: { status: "not_observed" },
          exactMissingProof: ["application_content_acceptance_not_observed"],
          weak: true,
        },
      ],
    });
    expect(result.finalMessages.at(-1)).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "text",
          text: expect.stringContaining("application_content_acceptance_not_observed"),
        },
      ],
    });
    expect(result.unresolved).toContain("distillation_semantic_acceptance");
  });
});
