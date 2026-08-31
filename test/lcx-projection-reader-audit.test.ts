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
    expect(source).toContain('adapterId: "neutral-answer-boundary"');
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
        allKnownEntrypointsAudited: boolean;
        readerContractReadyForAllAdapters: boolean;
      };
      entries: Array<{ id: string; status: string; readerIds: string[] }>;
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
      total: 6,
      bound: 3,
      missingReaderContract: 3,
      missingEntrypoints: 0,
      coverageStatus: "partial",
      messageAdapterTotal: 3,
      messageAdapterBound: 0,
      messageAdapterCoverage: 0,
      messageAdapterCoverageStatus: "missing",
      allKnownEntrypointsAudited: true,
      readerContractReadyForAllAdapters: false,
    });
    expect(payload.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "governance_autopilot",
          status: "bound",
          readerIds: ["governance-autopilot"],
        }),
        expect.objectContaining({
          id: "farm_web_dashboard",
          status: "bound",
          readerIds: ["farm-web-server"],
        }),
        expect.objectContaining({
          id: "neutral_answer_boundary",
          status: "bound",
          readerIds: ["neutral-answer-boundary"],
        }),
      ]),
    );
    expect(payload.nextAction).toContain("neutral answer boundary");
  });
});
