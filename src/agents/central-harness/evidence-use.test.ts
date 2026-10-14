import { describe, expect, it } from "vitest";
import { verifyCentralEvidenceUse, centralEvidenceUseEdges } from "./evidence-use.js";
import { runCentralHarnessCycle } from "./harness-loop.js";
import { validateCentralActionPlan } from "./model-brain.js";
import type { CentralEvidenceUse, CentralPerception } from "./types.js";
const id = `artifact-${"a".repeat(64)}`;
const hash = "b".repeat(64);
const use: CentralEvidenceUse = {
  artifactId: id,
  sourceSha256: hash,
  field: "/value/rules/0/body/frozenRule/exit",
  effect: "retain",
  reason:
    "The declared exit is a session-close exit; retain the scoped rule rather than infer an always-on stop.",
};
function perception(): CentralPerception {
  return {
    observedAt: "2026-10-10T08:00:00Z",
    controlRoom: {},
    ownerTotals: {},
    boundaries: ["research_only"],
    backlog: [
      {
        atMs: 1,
        outcomes: [
          {
            ownerId: "artifact_memory_recall",
            status: "ran_ok",
            args: { id, field: use.field },
            outcome: {
              artifactId: id,
              action: "read",
              field: use.field,
              sourceSha256: hash,
              sourceObservedAt: "2026-10-10T07:00:00Z",
              available: true,
              selectedValue: "Exit at session close",
              selectionScope: { accountId: "A", ruleId: "rule-1" },
            },
          },
        ],
      },
    ],
  };
}
describe("source-bound central evidence use", () => {
  it("accepts old plans and validates bounded optional references", () => {
    expect(validateCentralActionPlan({ actions: [], note: "legacy" })).not.toHaveProperty(
      "evidenceUse",
    );
    expect(validateCentralActionPlan({ actions: [], evidenceUse: [use] }).evidenceUse).toEqual([
      use,
    ]);
    expect(() =>
      validateCentralActionPlan({ actions: [], evidenceUse: [{ ...use, field: "/bad~escape" }] }),
    ).toThrow();
  });
  it("retains source-linked reasons and existing ontology business scope without granting execution", async () => {
    const p = perception();
    const receipt = await runCentralHarnessCycle({
      perception: p,
      registry: new Map(),
      brain: {
        propose: async () => ({
          kind: "proposed",
          provider: "fixture",
          modelId: "offline",
          plan: { actions: [], note: "keep rule", evidenceUse: [use] },
        }),
      },
    });
    expect(receipt.evidenceUse?.[0]).toMatchObject({
      verification: "reference_verified",
      effect: "retain",
      scope: { accountId: "A", ruleId: "rule-1" },
    });
    expect(receipt.evidenceUse?.[0].sourceValueSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.ontologyEdges).toHaveLength(4);
    expect(receipt.steps).toEqual([]);
    expect(receipt.liveTouched).toBe(false);
  });
  it.each(["hash", "account", "missing", "future"])(
    "rejects %s evidence without manufacturing adoption",
    (failure) => {
      let p = perception();
      const u = { ...use };
      if (failure === "hash") {
        u.sourceSha256 = "c".repeat(64);
      }
      if (failure === "account") {
        u.scope = { accountId: "B" };
      }
      if (failure === "missing") {
        p = { ...p, backlog: [] };
      }
      if (failure === "future") {
        p = { ...p, observedAt: "2026-10-09T00:00:00Z" };
      }
      const result = verifyCentralEvidenceUse([u], p);
      expect(result[0].verification).toBe("invalid_reference");
      expect(centralEvidenceUseEdges("run", result)).toEqual([]);
    },
  );
  it("rejects a source hash conflicting with the host's registered artifact", () => {
    const p = perception();
    const step = (p.backlog[0].outcomes as Record<string, unknown>[])[0];
    step.resultArtifact = { id, sha256: "c".repeat(64), status: "registered" };
    expect(verifyCentralEvidenceUse([use], p)[0]).toMatchObject({
      verification: "invalid_reference",
      gap: "source_hash_conflict",
    });
  });
  it("treats legacy backlog entries without outcomes as missing evidence", () => {
    const p = { ...perception(), backlog: [{ note: "old receipt" }] };
    expect(verifyCentralEvidenceUse([use], p)[0]).toMatchObject({
      verification: "invalid_reference",
      gap: "matching_read_not_delivered",
    });
  });
  it("keeps a blocked judgment attributable when source or broker evidence is unavailable", async () => {
    const p = perception();
    const step = (p.backlog[0].outcomes as Record<string, unknown>[])[0];
    step.outcome = {
      ...(step.outcome as Record<string, unknown>),
      selectedValue: {
        sourcePassed: false,
        qualityPassed: false,
        missing: ["debt_to_penny"],
        brokerStatus: "unknown",
      },
    };
    const blockedUse = {
      ...use,
      effect: "unresolved" as const,
      reason:
        "debt_to_penny is missing and quality failed; broker unknown continues to block execution.",
    };
    const receipt = await runCentralHarnessCycle({
      perception: p,
      registry: new Map(),
      brain: {
        propose: async () => ({
          kind: "proposed",
          provider: "fixture",
          modelId: "offline",
          plan: {
            actions: [{ ownerId: "finance_live_execution" }],
            note: blockedUse.reason,
            evidenceUse: [blockedUse],
          },
        }),
      },
    });
    expect(receipt.evidenceUse?.[0]).toMatchObject({
      effect: "unresolved",
      verification: "unresolved",
      reason: blockedUse.reason,
    });
    expect(receipt.steps[0].status).toBe("blocked_by_gate");
    expect(receipt.liveTouched).toBe(false);
  });
  it("does not claim adoption when content was dropped", () => {
    const p = perception();
    const step = (p.backlog[0].outcomes as Record<string, unknown>[])[0];
    step.outcomeDroppedKeys = ["selectedValue"];
    expect(verifyCentralEvidenceUse([use], p)[0]).toMatchObject({
      verification: "unresolved",
      gap: "selected_content_not_delivered",
    });
  });
});
