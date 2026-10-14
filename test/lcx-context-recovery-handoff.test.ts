import { describe, expect, it } from "vitest";
import { recoveryHandoffSourceChecks } from "../scripts/operator/lcx-context-recovery-exam.js";

function sources() {
  const clean = {
    ok: true,
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
  };
  return {
    changeImpact: {
      ok: true,
      payload: {
        ...clean,
        boundary: "local_change_impact_plan_only",
        changedFiles: [],
        affectedLanes: [],
        unmatchedFiles: [],
        recommendedFastCommands: [],
        deferredCommands: [],
        safetyNotes: [],
      },
    },
    moduleAbsorption: {
      ok: true,
      payload: {
        ...clean,
        boundary: "local_module_learning_absorption_gate_only",
        blockers: ["no eval adoption"],
        nextActions: [],
        nextProofQueue: [],
        counts: {},
        gateDecision: "hold_at_application_ready",
        absorptionReady: false,
      },
    },
    learningSedimentation: {
      ok: true,
      payload: {
        ...clean,
        boundary: "local_learning_sedimentation_audit_only",
        gaps: [],
        chains: { moduleLearningPipeline: {} },
        sufficientForCurrentUse: false,
        assessment: "no_eval_absorption",
      },
    },
    externalChannelStatus: {
      ok: true,
      payload: {
        ...clean,
        boundary: "local_external_channel_status_only",
        externalChannelStatus: { externalChannelBound: false, userVisibleObserved: false },
      },
    },
  };
}

describe("original recovery handoff source gates", () => {
  it("can recover an explicit hold and an unbound external channel without claiming either ready", () => {
    const source = sources();
    expect(recoveryHandoffSourceChecks(source).every((check) => check.ok)).toBe(true);
    expect(source.moduleAbsorption.payload.absorptionReady).toBe(false);
    expect(source.externalChannelStatus.payload.externalChannelStatus.externalChannelBound).toBe(
      false,
    );
  });
  it.each([
    "changeImpact",
    "moduleAbsorption",
    "learningSedimentation",
    "externalChannelStatus",
  ] as const)(
    "names the original %s owner and unavailable source rather than claiming clean state",
    (name) => {
      const source = sources();
      const unavailable = { ...source, [name]: { ok: false, error: "injected read failure" } };
      const check = recoveryHandoffSourceChecks(unavailable).find(
        (entry) => entry.id === `handoff_${name}_source_recovered`,
      );
      expect(check?.ok).toBe(false);
      expect(check?.summary).toContain("injected read failure");
      expect(check?.evidence).toMatchObject({
        sourceAvailable: false,
        owner: expect.stringContaining("scripts/operator/"),
      });
    },
  );
  it("rejects missing fields even when the source declares success", () => {
    const source = sources();
    const payload: Record<string, unknown> = { ...source.changeImpact.payload };
    delete payload.changedFiles;
    const check = recoveryHandoffSourceChecks({
      ...source,
      changeImpact: { ok: true, payload },
    })[0];
    expect(check.ok).toBe(false);
    expect(check.evidence).toMatchObject({ missingFields: ["changedFiles"] });
  });
  it.each(["liveTouched", "providerConfigTouched", "protectedMemoryTouched"] as const)(
    "refuses an owner that violated %s while retaining the original evidence",
    (flag) => {
      const source = sources();
      source.changeImpact.payload[flag] = true;
      expect(recoveryHandoffSourceChecks(source)[0]).toMatchObject({
        ok: false,
        evidence: { boundaryClean: false },
      });
    },
  );
  it("keeps an unsuccessful owner receipt visible as a blocker", () => {
    const source = sources();
    const blocked = {
      ...source,
      changeImpact: {
        ok: true,
        payload: {
          ...source.changeImpact.payload,
          ok: false,
          unmatchedFiles: ["unknown.ts"],
        },
      },
    };
    const check = recoveryHandoffSourceChecks(blocked)[0];
    expect(check.ok).toBe(false);
    expect(check.evidence).toMatchObject({ sourceAvailable: true, sourceOk: false });
    expect(blocked.changeImpact.payload.unmatchedFiles).toEqual(["unknown.ts"]);
  });
  it("does not recover missing nested learning evidence from a top-level success flag", () => {
    const source = sources();
    const incomplete = {
      ...source,
      learningSedimentation: {
        ok: true,
        payload: { ...source.learningSedimentation.payload, chains: {} },
      },
    };
    const check = recoveryHandoffSourceChecks(incomplete)[2];
    expect(check.ok).toBe(false);
    expect(check.evidence.missingFields).toContain("chains.moduleLearningPipeline");
  });

  it("rejects a receipt from a different owner boundary", () => {
    const source = sources();
    source.changeImpact.payload.boundary = "local_wrong_owner_only";
    expect(recoveryHandoffSourceChecks(source)[0]).toMatchObject({ ok: false });
  });
});
