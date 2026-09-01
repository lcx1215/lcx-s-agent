import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

describe("LCX projection reader audit", () => {
  it("keeps projection input at the neutral answer boundary", async () => {
    const source = await readFile(
      path.join(repoRoot, "src/auto-reply/reply/dispatch-from-config.ts"),
      "utf8",
    );
    expect(source).toContain("globalEvidenceProjectionInput");
    expect(source).toContain("onGlobalEvidenceProjectionRead");
    expect(source).toContain("readCanonicalGlobalEvidenceProjectionCandidate");
    expect(source).toContain("resolveGlobalEvidenceProjectionAdapterId");
    expect(source).toContain('fallback: "neutral-answer-boundary"');
    expect(source).toContain("blocked read is reported to the caller");
    expect(source).not.toContain("extraSystemPrompt");
  });

  it("audits known entrypoints without turning partial coverage into readiness", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/operator/lcx-projection-reader-audit.ts", "--json"],
      { cwd: repoRoot, env: process.env },
    );
    const payload = JSON.parse(stdout) as {
      ok: boolean;
      boundary: string;
      contract: string;
      summary: {
        total: number;
        bound: number;
        missingReaderContract: number;
        missingEntrypoints: number;
        coverageStatus: string;
        messageAdapterTotal: number;
        messageAdapterBound: number;
        messageAdapterCoverage: number;
        messageAdapterCoverageStatus: string;
        messageAdapterDirectBound: number;
        messageAdapterDirectCoverage: number;
        messageAdapterDirectCoverageStatus: string;
        messageAdapterBindingMode: string;
        directReaderBound: number;
        directReaderCoverage: number;
        directReaderCoverageStatus: string;
        allKnownEntrypointsAudited: boolean;
        readerContractReadyForAllAdapters: boolean;
        answerBoundaryReady: boolean;
        discoveredMessageAdapterTotal: number;
      };
      entries: Array<{
        id: string;
        status: string;
        readerIds: string[];
        readerIdStrategy: string;
        passesAdapterProjectionInput: boolean;
        delegatedToAnswerBoundary: boolean;
      }>;
      nextAction: string;
      liveTouched: boolean;
      providerConfigTouched: boolean;
      protectedMemoryTouched: boolean;
    };

    expect(payload).toMatchObject({
      ok: true,
      boundary: "local_projection_reader_audit_only",
      contract: "readGlobalEvidenceProjectionForAdapter",
      liveTouched: false,
      providerConfigTouched: false,
      protectedMemoryTouched: false,
    });
    expect(payload.summary).toMatchObject({
      missingReaderContract: 0,
      missingEntrypoints: 0,
      coverageStatus: "complete",
      messageAdapterCoverage: 1,
      messageAdapterCoverageStatus: "complete",
      messageAdapterDirectCoverageStatus: "partial",
      messageAdapterBindingMode: "mixed",
      allKnownEntrypointsAudited: true,
      readerContractReadyForAllAdapters: true,
      answerBoundaryReady: true,
    });
    expect(payload.summary.total).toBeGreaterThanOrEqual(4);
    expect(payload.summary.bound).toBe(payload.summary.total);
    expect(payload.summary.messageAdapterTotal).toBeGreaterThan(0);
    expect(payload.summary.messageAdapterBound).toBe(payload.summary.messageAdapterTotal);
    expect(payload.summary.messageAdapterDirectBound).toBeGreaterThan(0);
    expect(payload.summary.messageAdapterDirectBound).toBeLessThan(
      payload.summary.messageAdapterTotal,
    );
    expect(payload.summary.messageAdapterDirectCoverage).toBeGreaterThan(0);
    expect(payload.summary.messageAdapterDirectCoverage).toBeLessThan(1);
    expect(payload.summary.directReaderBound).toBeGreaterThan(0);
    expect(payload.summary.directReaderBound).toBeLessThan(payload.summary.total);
    expect(payload.summary.directReaderCoverage).toBeGreaterThan(0);
    expect(payload.summary.directReaderCoverage).toBeLessThan(1);
    expect(payload.summary.messageAdapterTotal).toBeGreaterThanOrEqual(
      payload.summary.discoveredMessageAdapterTotal,
    );
    expect(payload.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "governance_autopilot",
          status: "bound",
          bindingMode: "direct",
          readerIds: ["governance-autopilot"],
        }),
        expect.objectContaining({
          id: "farm_web_dashboard",
          status: "bound",
          bindingMode: "direct",
          readerIds: ["farm-web-server"],
        }),
        expect.objectContaining({
          id: "neutral_answer_boundary",
          status: "bound",
          bindingMode: "direct",
          readerIdStrategy: "literal",
        }),
        expect.objectContaining({
          id: "message_adapter:extensions:feishu:src:bot",
          status: "bound",
          delegatedToAnswerBoundary: true,
          bindingMode: "direct",
          passesAdapterProjectionInput: true,
          readerIdStrategy: "literal",
          readerIds: ["feishu-bot-ingress"],
        }),
        expect.objectContaining({
          id: "message_adapter:src:telegram:bot-message-dispatch",
          status: "bound",
          delegatedToAnswerBoundary: true,
          bindingMode: "delegated_to_neutral_answer_boundary",
          passesAdapterProjectionInput: false,
          readerIdStrategy: "message_context_surface_or_provider",
        }),
        expect.objectContaining({
          id: "message_adapter:extensions:googlechat:src:monitor",
          status: "bound",
          delegatedToAnswerBoundary: true,
          bindingMode: "delegated_to_neutral_answer_boundary",
          passesAdapterProjectionInput: false,
          readerIdStrategy: "message_context_surface_or_provider",
        }),
      ]),
    );
    expect(payload.nextAction).toContain("neutral answer boundary");
  });
});
