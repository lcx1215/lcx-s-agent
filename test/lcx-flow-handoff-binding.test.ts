import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  probeOriginalBinding,
  type BindingProbeFault,
  type BindingVerificationFault,
} from "./fixtures/lcx-waterflow-binding-probe.js";

describe("original nonapply binding consumes a native private training plan", () => {
  it.each([undefined, "missing", "timeout", "malformed"] as const)(
    "retains original readiness or source failure for %s",
    async (fault: BindingProbeFault | undefined) => {
      const retained = process.env.LCX_BINDING_PROOF_DIR;
      const root = await fs.mkdtemp(
        path.join(retained ?? os.tmpdir(), `lcx-binding-${fault ?? "readiness"}-`),
      );
      try {
        const proof = await probeOriginalBinding(root, fault);
        await fs.writeFile(
          path.join(root, "native-proof.json"),
          JSON.stringify(proof, null, 2) + "\n",
        );
        expect(proof.invocations).toHaveLength(3);
        expect(proof.invocations[0].args).toEqual([
          "--import",
          "tsx",
          "scripts/operator/local-brain-training-plan.ts",
          "--json",
        ]);
        expect(proof.binding.apply).toBe(false);
        expect(proof.binding.liveTouched).toBe(false);
        expect(proof.status.externalChannelBound).toBe(false);
        expect(proof.status.userVisibleObserved).toBe(false);
        expect(proof.writer.body).toEqual(proof.binding);
        expect(proof.statusInput.binding).toEqual(proof.binding.externalChannelBinding);
        const decision = proof.binding.decision as { status: string; missingProof: string[] };
        if (!fault) {
          expect(proof.trainingPlan?.boundary).toBe("local_brain_training_plan_only");
          expect(proof.reads.some((read) => read.path === proof.localInput.guardLog)).toBe(true);
          expect(proof.reads.some((read) => read.path === proof.localInput.quotaLog)).toBe(true);
          expect(proof.invocations[0].stdoutSha256).toBe(proof.trainingPlanSha256);
          expect(proof.binding.trainingPlanExternalChannelBinding).toEqual(
            proof.trainingPlan?.externalChannelBinding,
          );
          expect(decision.status).toBe("deferred_training_plan_not_ready");
          expect(decision.missingProof).toContain("selected_clean_adapter");
        } else {
          expect(decision.status).toBe("blocked_missing_training_plan");
          expect(decision.missingProof).toEqual(["training_plan_external_message_channel_binding"]);
          expect(proof.binding.ok).toBe(false);
        }
        expect(proof.missingFrontend).toHaveLength(2);
        if (retained) {
          const bytes = await fs.readFile(path.join(root, "native-proof.json"));
          await fs.writeFile(
            path.join(root, "proof-sha256.txt"),
            createHash("sha256").update(bytes).digest("hex") + "\n",
          );
        }
      } finally {
        if (!retained) {
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    },
    30_000,
  );
});

describe("original binding local verification intake", () => {
  it.each([
    undefined,
    "missing_receipt",
    "source_conflict",
    "test_failure",
    "missing_host_pin",
  ] as const)(
    "consumes executed private code-test evidence or blocks %s",
    async (fault: BindingVerificationFault | undefined) => {
      const retained = process.env.LCX_BINDING_LOCAL_VERIFICATION_PROOF_DIR;
      if (retained) {
        await fs.mkdir(retained, { recursive: true });
      }
      const root = await fs.mkdtemp(
        path.join(retained ?? os.tmpdir(), `binding-local-${fault ?? "verified"}-`),
      );
      try {
        const proof = await probeOriginalBinding(root, undefined, { fault });
        const verification = proof.binding.localVerification as {
          status: string;
          gaps: string[];
          runId?: string;
          testResult?: { sha256: string };
          exitCode?: number;
        };
        expect(proof.binding.apply).toBe(false);
        expect(proof.binding.liveTouched).toBe(false);
        expect(proof.status.externalChannelBound).toBe(false);
        expect(proof.status.userVisibleObserved).toBe(false);
        expect(proof.writer.body).toEqual(proof.binding);
        expect(proof.binding.decision).toMatchObject({
          status: "deferred_training_plan_not_ready",
        });
        expect(
          proof.invocations
            .filter((call) => call.command === "git")
            .every((call) => call.args.join(" ") === "rev-parse HEAD"),
        ).toBe(true);
        if (!fault) {
          expect(verification.status).toBe("verified");
          expect(verification.exitCode).toBe(0);
          expect(verification.runId).toBe(proof.localVerificationProduced?.receipt.runId);
          expect(verification.testResult?.sha256).toBe(
            createHash("sha256").update(proof.localVerificationTestResultBytes!).digest("hex"),
          );
          expect(proof.localVerificationTestResultBytes).toContain(
            "binding reader source assertion executed",
          );
          expect(proof.missingFrontend).toEqual([]);
          expect(proof.binding.decision).toMatchObject({
            missingProof: expect.arrayContaining(["selected_clean_adapter"]),
          });
        } else {
          expect(verification.status).toBe("blocked");
          const gap = {
            missing_receipt: "local_verification_receipt_unavailable",
            source_conflict: "local_verification_changed_file_hash_conflict",
            test_failure: "local_verification_executed_test_not_passed",
            missing_host_pin: "local_verification_independent_test_pin_unavailable",
          }[fault];
          expect(verification.gaps[0]).toContain(gap);
          expect(proof.binding.decision).toMatchObject({
            missingProof: expect.arrayContaining(verification.gaps),
          });
        }
        if (retained) {
          await fs.writeFile(
            path.join(root, "native-proof.json"),
            JSON.stringify(proof, null, 2) + "\n",
          );
        }
      } finally {
        if (!retained) {
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    },
    30000,
  );
});
