import { describe, expect, it } from "vitest";
import {
  buildGlobalEvidenceProjection,
  GLOBAL_EVIDENCE_PROJECTION_MODE,
  GLOBAL_EVIDENCE_PROJECTION_VERSION,
  validateGlobalEvidenceProjection,
} from "./global-evidence-projection.js";

function hasLegacyArchitectureTerm(value: unknown): boolean {
  if (typeof value === "string") {
    return /(?<![A-Za-z0-9])(?:lark|feishu|dev|live|channels?)(?=[A-Z_-]|\b)/iu.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasLegacyArchitectureTerm(item));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).some(
      ([key, item]) =>
        !["adapterId", "receiptId"].includes(key) &&
        (/(?<![A-Za-z0-9])(?:lark|feishu|dev|live|channels?)(?=[A-Z_-]|\b)/iu.test(key) ||
          hasLegacyArchitectureTerm(item)),
    );
  }
  return false;
}

const baseInvariant = {
  id: "fresh_receipts_are_required",
  category: "workflow",
  objective: "Current owner receipts must be available.",
  ok: true,
  missing: [],
  nextAction: "Read the owner receipt before making a claim.",
} as const;

describe("Global Evidence Projection", () => {
  it("projects structural coverage without choosing a delivery adapter", () => {
    const projection = buildGlobalEvidenceProjection({
      generatedAt: "2026-08-31T00:00:00.000Z",
      sourceOwners: ["mind-model"],
      lanes: [
        {
          id: "context_recovery",
          masterLane: "global_doctrine_and_runbook",
          objective: "Recover the whole agent state from durable evidence.",
          ok: true,
          missing: [],
          evidence: ["head=doctrine", "workflow=owner", "proof=receipt", "boundary=read_only"],
          nextAction: "Keep the owner receipt as the source of truth.",
        },
      ],
      invariants: [baseInvariant],
    });

    expect(projection).toMatchObject({
      contractVersion: GLOBAL_EVIDENCE_PROJECTION_VERSION,
      mode: GLOBAL_EVIDENCE_PROJECTION_MODE,
      generatedAt: "2026-08-31T00:00:00.000Z",
      sourceOwners: ["mind-model"],
      delivery: { adapterId: null, state: "unknown", evidenceRefs: [] },
      boundaries: {
        scope: "projection_only",
        externalSender: "not_touched_by_projection",
        training: "not_touched_by_projection",
        providerConfig: "not_touched_by_projection",
        protectedMemory: "not_touched_by_projection",
      },
    });
    expect(projection.capabilities).toEqual([
      expect.objectContaining({
        id: "context_recovery",
        domain: "global_doctrine_and_runbook",
        coverage: "complete",
        maturity: "structural",
        adaptability: "adapter_neutral",
        evidenceRefs: [
          "context_recovery:head",
          "context_recovery:workflow",
          "context_recovery:proof",
          "context_recovery:boundary",
        ],
      }),
    ]);
    expect(projection.evidence.filter((item) => item.capabilityId === "context_recovery")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "context_recovery:head", status: "present" }),
        expect.objectContaining({ id: "context_recovery:workflow", status: "present" }),
        expect.objectContaining({ id: "context_recovery:proof", status: "present" }),
        expect.objectContaining({ id: "context_recovery:boundary", status: "present" }),
      ]),
    );
    expect(projection.actions).toEqual([
      expect.objectContaining({
        id: "observe:global-evidence-projection",
        kind: "observe",
        status: "recommended",
      }),
    ]);
    expect(hasLegacyArchitectureTerm(projection)).toBe(false);
    expect(
      validateGlobalEvidenceProjection({
        ...projection,
        capabilities: [{ ...projection.capabilities[0], maturity: "observed" as const }],
      }),
    ).toEqual(
      expect.arrayContaining([expect.stringContaining("cannot leave structural maturity")]),
    );
  });

  it("keeps missing owner evidence actionable and rejects impossible delivery proof", () => {
    const params = {
      generatedAt: "2026-08-31T00:00:00.000Z",
      sourceOwners: ["mind-model"],
      lanes: [
        {
          id: "lark_feishu_live_boundary",
          masterLane: "external_channel_boundary",
          objective: "Keep Lark/Feishu as a replaceable message medium.",
          ok: false,
          missing: [{ surface: "boundary" as const, term: "liveTouched" }],
          evidence: [
            "head=adapter",
            "workflow=bind channels status",
            "proof=probe",
            "boundary=missing",
          ],
          nextAction: "Do not claim a live reply without a fresh adapter receipt.",
        },
      ],
      invariants: [baseInvariant],
    };
    const projection = buildGlobalEvidenceProjection(params);
    const capability = projection.capabilities[0];
    expect(capability).toMatchObject({
      id: "external_delivery_boundary",
      coverage: "partial",
      domain: "external_adapter_boundary",
    });
    expect(projection.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "external_delivery_boundary:boundary",
          status: "missing",
        }),
      ]),
    );
    expect(projection.actions).toEqual([
      expect.objectContaining({
        id: "repair:external_delivery_boundary",
        kind: "repair",
        status: "blocked",
        capabilityId: "external_delivery_boundary",
        evidenceRefs: ["external_delivery_boundary:boundary"],
      }),
    ]);
    expect(hasLegacyArchitectureTerm(projection)).toBe(false);

    expect(() =>
      buildGlobalEvidenceProjection({
        ...params,
        lanes: [{ ...params.lanes[0], ok: true }],
      }),
    ).toThrow("inconsistent ok and missing evidence");
    expect(() =>
      buildGlobalEvidenceProjection({
        ...params,
        lanes: [{ ...params.lanes[0], evidence: ["head=adapter"] }],
      }),
    ).toThrow("missing workflow owner evidence");

    expect(() =>
      buildGlobalEvidenceProjection({
        ...params,
        delivery: { adapterId: null, state: "observed", evidenceRefs: ["reply"] },
      } as never),
    ).toThrow("observed delivery state requires adapterId and evidenceRefs");
    expect(() =>
      buildGlobalEvidenceProjection({
        ...params,
        delivery: { adapterId: "adapter-a", state: "unknown", evidenceRefs: [] },
      } as never),
    ).toThrow("unknown delivery state must not carry adapter or evidence proof");
    expect(() =>
      buildGlobalEvidenceProjection({
        ...params,
        delivery: {
          adapterId: "adapter-a",
          state: "future",
          evidenceRefs: ["receipt"],
          proof: {
            owner: "delivery-owner",
            receiptId: "receipt",
            checkedAt: "2026-08-31T00:00:00.000Z",
            visibility: "user_visible",
          },
        },
      } as never),
    ).toThrow("unknown delivery state");
    expect(() =>
      buildGlobalEvidenceProjection({
        ...params,
        delivery: { adapterId: "adapter-a", state: "observed", evidenceRefs: ["receipt"] },
      } as never),
    ).toThrow("independent delivery proof");
    expect(() =>
      buildGlobalEvidenceProjection({
        ...params,
        delivery: {
          adapterId: "adapter-a",
          state: "bound",
          evidenceRefs: ["receipt"],
          proof: {
            owner: "delivery-owner",
            receiptId: "other-receipt",
            checkedAt: "2026-08-31T00:00:00.000Z",
            visibility: "binding",
          },
        },
      }),
    ).toThrow("invalid independent delivery proof");
    expect(() =>
      buildGlobalEvidenceProjection({
        ...params,
        sourceOwners: [],
      }),
    ).toThrow("sourceOwners must contain at least one owner");
  });

  it("keeps a bound adapter opaque while requiring proof references", () => {
    const projection = buildGlobalEvidenceProjection({
      generatedAt: "2026-08-31T00:00:00.000Z",
      sourceOwners: ["delivery-owner"],
      lanes: [],
      invariants: [],
      delivery: {
        adapterId: "lark-v2",
        state: "observed",
        evidenceRefs: ["receipt:lark-v2"],
        proof: {
          owner: "delivery-owner",
          receiptId: "receipt:lark-v2",
          checkedAt: "2026-08-31T00:00:00.000Z",
          visibility: "user_visible",
        },
      },
    });

    expect(projection.delivery).toEqual({
      adapterId: "lark-v2",
      state: "observed",
      evidenceRefs: ["receipt:lark-v2"],
      proof: {
        owner: "delivery-owner",
        receiptId: "receipt:lark-v2",
        checkedAt: "2026-08-31T00:00:00.000Z",
        visibility: "user_visible",
      },
    });
    expect(projection.mode).toBe("read_only_shadow");
    expect(projection.delivery.adapterId).toBe("lark-v2");
  });
});
