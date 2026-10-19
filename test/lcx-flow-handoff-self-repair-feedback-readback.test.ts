import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  probeOriginalSelfRepairFeedbackReadback,
  type FeedbackReadbackCase,
} from "./fixtures/lcx-waterflow-self-repair-feedback-readback-probe.js";

const roots: string[] = [];
afterEach(async () => {
  for (const directory of roots.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("original self-repair latest readback -> governance compact -> owner map", () => {
  it.each([
    "read",
    "blocked",
    "blocked_restored",
    "legacy",
    "source_changed",
    "source_missing",
    "request_missing",
    "expired",
    "crowded",
  ] as const)(
    "preserves the actual %s diagnostic or concrete gap without mutating history",
    async (scenario: FeedbackReadbackCase) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-self-repair-readback-"));
      roots.push(directory);
      const result = await probeOriginalSelfRepairFeedbackReadback({ directory, scenario });
      const retained = process.env.LCX_SELF_REPAIR_FEEDBACK_READBACK_PROOF_DIR;
      if (retained) {
        await fs.mkdir(retained, { recursive: true });
        await fs.cp(directory, path.join(retained, scenario), { recursive: true });
      }
      expect(result.afterRootBytes).toBe(result.beforeRootBytes);
      expect(result.selectedItem).toBeDefined();
      if (process.env.LCX_SELF_REPAIR_FEEDBACK_READBACK_BEFORE === "1") {
        const latest = result.readback.latestWrittenReceipt as Record<string, unknown>;
        expect(latest.diagnosticFeedback).toBeUndefined();
        expect(result.owner.compact.diagnosticFeedback).toBeUndefined();
        expect(result.selectedItem?.reason).not.toContain("owner_map_feedback_map_hash_conflict");
        expect(result.selectedItem?.reason).not.toContain("source_sha256_mismatch");
        return;
      }
      if (scenario === "legacy") {
        const latest = result.readback.latestWrittenReceipt as Record<string, unknown>;
        expect(latest.diagnosticFeedback).toBeUndefined();
        expect(latest.diagnosticFeedbackReadback).toBeUndefined();
        expect(result.selectedItem?.status).toBe("codex_can_act_when_safe");
        expect(result.digestProjection.selfRepairFeedback).toBeUndefined();
        const boundedDigest = result.bounded.perception.controlRoom.governanceDigest as Record<
          string,
          unknown
        >;
        expect(boundedDigest.selfRepairFeedback).toBeUndefined();
        return;
      }
      const latest = result.readback.latestWrittenReceipt as Record<string, unknown>;
      expect(latest.diagnosticFeedback).toBeDefined();
      const fresh = latest.diagnosticFeedbackReadback as {
        status: string;
        blockers: string[];
        sourceRunId?: string;
      };
      expect(fresh).toBeDefined();
      if (scenario === "read" || scenario === "crowded") {
        expect(fresh.status).toBe("read");
        expect(fresh.sourceRunId).toBe(result.produced.host.sourceRunId);
        expect(result.selectedItem?.reason).toContain("source_sha256_mismatch");
      } else {
        expect(fresh.status).toBe("blocked");
        expect(fresh.blockers.length).toBeGreaterThan(0);
        expect(result.selectedItem?.status).toBe("blocked_now");
        expect(result.selectedItem?.reason).toContain(fresh.blockers[0]);
        if (scenario === "blocked_restored") {
          expect(result.produced.initialFeedback?.status).toBe("read");
          expect(result.produced.persisted.status).toBe("blocked");
          expect(fresh.blockers).toContain("owner_map_feedback_map_hash_conflict");
        }
      }
      expect(result.owner.compact.latestWrittenReceipt).toMatchObject({
        diagnosticFeedback: latest.diagnosticFeedback,
        diagnosticFeedbackReadback: fresh,
      });
      const centralOwner = result.centralInput.byOwner.selfRepairHands;
      if (!centralOwner) {
        throw new Error("original central input omitted the actual selfRepairHands owner");
      }
      expect(centralOwner.compact.latestWrittenReceipt).toMatchObject({
        diagnosticFeedbackReadback: fresh,
      });
      const digest = result.bounded.perception.controlRoom.governanceDigest as Record<
        string,
        unknown
      >;
      const feedback = digest.selfRepairFeedback as {
        status: string;
        blockers: string[];
        diagnostic?: string;
        sourceRunId?: string;
        mapSha256?: string;
        governanceSha256?: string;
        identityFieldsOmitted?: string[];
      };
      expect(feedback).toMatchObject({
        status: fresh.status,
        proofLevel: "reference_readback_only",
        semanticTruth: "not_proven",
        actionAuthority: false,
        candidateOnly: true,
        reuseAllowed: false,
      });
      if (scenario === "read" || scenario === "crowded") {
        expect(feedback.diagnostic).toContain("source_sha256_mismatch");
      } else {
        expect(feedback.blockers).toContain(fresh.blockers[0]);
      }
      if (feedback.sourceRunId !== undefined) {
        expect(feedback.sourceRunId).toBe(fresh.sourceRunId);
      }
      if (feedback.mapSha256 !== undefined) {
        expect(feedback.mapSha256).toBe(result.produced.request.map.sha256);
      }
      if (feedback.governanceSha256 !== undefined) {
        expect(feedback.governanceSha256).toBe(result.produced.request.governance.sha256);
      }
      if (scenario === "crowded") {
        for (const field of ["sourceRunId", "mapSha256", "governanceSha256"] as const) {
          if (feedback[field] === undefined) {
            expect(feedback.identityFieldsOmitted).toContain(field);
          }
        }
      }
      expect(
        Buffer.byteLength(JSON.stringify(result.digestProjection), "utf8"),
      ).toBeLessThanOrEqual(2048);
      expect(result.bounded.report.injectedBytes).toBeLessThanOrEqual(12 * 1024);
    },
  );
});
