import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GLOBAL_EVIDENCE_PROJECTION_READER_CONTRACT_VERSION,
  readGlobalEvidenceProjection,
  readGlobalEvidenceProjectionForAdapter,
  resolveGlobalEvidenceProjectionAdapterId,
  summarizeGlobalEvidenceProjectionRead,
} from "./global-evidence-projection-read.js";
import { readCanonicalGlobalEvidenceProjectionCandidate } from "./global-evidence-projection-source.js";
import {
  buildGlobalEvidenceProjection,
  GLOBAL_EVIDENCE_PROJECTION_MODE,
  GLOBAL_EVIDENCE_PROJECTION_VERSION,
  validateGlobalEvidenceProjection,
} from "./global-evidence-projection.js";

function hasLegacyArchitectureTerm(value: unknown): boolean {
  if (typeof value === "string") {
    return /(?<![A-Za-z0-9])(?:dev|live|channels?)(?=[A-Z_-]|\b)/iu.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasLegacyArchitectureTerm(item));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).some(
      ([key, item]) =>
        !["adapterId", "receiptId"].includes(key) &&
        (/(?<![A-Za-z0-9])(?:dev|live|channels?)(?=[A-Z_-]|\b)/iu.test(key) ||
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
      ontologyVersion: "lcx_ontology_v1",
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
        role: "core_architecture",
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
    expect(
      validateGlobalEvidenceProjection({
        ...projection,
        capabilities: [{ ...projection.capabilities[0], role: "future" as never }],
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("invalid role")]));
    expect(
      validateGlobalEvidenceProjection({
        ...projection,
        ontologyVersion: "future_ontology" as never,
      }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("ontologyVersion")]));
  });

  it("keeps missing owner evidence actionable and rejects impossible delivery proof", () => {
    const params = {
      generatedAt: "2026-08-31T00:00:00.000Z",
      sourceOwners: ["mind-model"],
      lanes: [
        {
          id: "external_message_channel_boundary",
          masterLane: "external_channel_boundary",
          objective: "Keep external message as a replaceable message medium.",
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
      id: "external_message_adapter_boundary",
      coverage: "partial",
      domain: "external_adapter_boundary",
    });
    expect(projection.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "external_message_adapter_boundary:boundary",
          status: "missing",
        }),
      ]),
    );
    expect(projection.actions).toEqual([
      expect.objectContaining({
        id: "repair:external_message_adapter_boundary",
        kind: "repair",
        status: "blocked",
        capabilityId: "external_message_adapter_boundary",
        evidenceRefs: ["external_message_adapter_boundary:boundary"],
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
        adapterId: "external-v2",
        state: "observed",
        evidenceRefs: ["receipt:external-v2"],
        proof: {
          owner: "delivery-owner",
          receiptId: "receipt:external-v2",
          checkedAt: "2026-08-31T00:00:00.000Z",
          visibility: "user_visible",
        },
      },
    });

    expect(projection.delivery).toEqual({
      adapterId: "external-v2",
      state: "observed",
      evidenceRefs: ["receipt:external-v2"],
      proof: {
        owner: "delivery-owner",
        receiptId: "receipt:external-v2",
        checkedAt: "2026-08-31T00:00:00.000Z",
        visibility: "user_visible",
      },
    });
    expect(projection.mode).toBe("read_only_shadow");
    expect(projection.delivery.adapterId).toBe("external-v2");
  });

  it("blocks stale, missing, and invalid consumer reads", () => {
    const projection = buildGlobalEvidenceProjection({
      generatedAt: "2026-08-31T00:00:00.000Z",
      sourceOwners: ["mind-model"],
      lanes: [],
      invariants: [],
    });
    expect(
      readGlobalEvidenceProjection(projection, "2026-08-31T00:04:59.000Z", {
        sourceOwner: "governance",
      }),
    ).toMatchObject({ readStatus: "current", blocked: false, sourceOwner: "governance" });
    expect(readGlobalEvidenceProjection(projection, "2026-08-31T00:05:01.000Z")).toMatchObject({
      readStatus: "stale",
      blocked: true,
      reason: "projection_stale",
    });
    expect(readGlobalEvidenceProjection(undefined, "2026-08-31T00:00:00.000Z")).toMatchObject({
      readStatus: "missing",
      blocked: true,
    });
    expect(
      readGlobalEvidenceProjection(
        { ...projection, mode: "future" } as never,
        "2026-08-31T00:00:00.000Z",
      ),
    ).toMatchObject({ readStatus: "invalid", blocked: true, projection: null });
  });

  it("hides blocked payload details from read-only views", () => {
    const projection = buildGlobalEvidenceProjection({
      generatedAt: "2026-08-31T00:00:00.000Z",
      sourceOwners: ["mind-model"],
      lanes: [],
      invariants: [],
    });
    const current = summarizeGlobalEvidenceProjectionRead(
      readGlobalEvidenceProjection(projection, "2026-08-31T00:04:59.000Z"),
    );
    expect(current).toMatchObject({
      readStatus: "current",
      blocked: false,
      capabilityCount: 0,
      evidenceCount: 0,
      actionCount: 1,
      deliveryState: "unknown",
      adapterId: null,
    });

    const stale = summarizeGlobalEvidenceProjectionRead(
      readGlobalEvidenceProjection(projection, "2026-08-31T00:05:01.000Z"),
    );
    expect(stale).toMatchObject({
      readStatus: "stale",
      blocked: true,
      capabilityCount: 0,
      evidenceCount: 0,
      actionCount: 0,
      deliveryState: null,
      adapterId: null,
    });
  });

  it("unwraps and preserves the upstream read envelope", () => {
    const projection = buildGlobalEvidenceProjection({
      generatedAt: "2026-08-31T00:00:00.000Z",
      sourceOwners: ["mind-model"],
      lanes: [],
      invariants: [],
    });
    const currentEnvelope = readGlobalEvidenceProjection(projection, "2026-08-31T00:01:00.000Z", {
      sourceOwner: "governance",
    });
    expect(
      readGlobalEvidenceProjection(currentEnvelope, "2026-08-31T00:02:00.000Z", {
        sourceOwner: "farm-web-server",
      }),
    ).toMatchObject({
      sourceOwner: "farm-web-server",
      readStatus: "current",
      blocked: false,
      reason: "projection_current",
    });

    const staleEnvelope = readGlobalEvidenceProjection(projection, "2026-08-31T00:06:00.000Z", {
      sourceOwner: "governance",
    });
    expect(
      readGlobalEvidenceProjection(staleEnvelope, "2026-08-31T00:06:30.000Z", {
        sourceOwner: "farm-web-server",
      }),
    ).toMatchObject({
      readStatus: "stale",
      blocked: true,
      reason: "upstream_projection_stale",
    });

    expect(
      readGlobalEvidenceProjection(
        { ...currentEnvelope, blocked: true },
        "2026-08-31T00:02:00.000Z",
      ),
    ).toMatchObject({
      readStatus: "invalid",
      blocked: true,
      reason: "projection_read_envelope_inconsistent",
      projection: null,
    });
  });

  it("requires an opaque reader id without changing delivery proof", () => {
    const projection = buildGlobalEvidenceProjection({
      generatedAt: "2026-08-31T00:00:00.000Z",
      sourceOwners: ["mind-model"],
      lanes: [],
      invariants: [],
      delivery: {
        adapterId: "opaque-delivery",
        state: "bound",
        evidenceRefs: ["binding"],
        proof: {
          owner: "delivery-owner",
          receiptId: "binding",
          checkedAt: "2026-08-31T00:00:00.000Z",
          visibility: "binding",
        },
      },
    });
    const reader = readGlobalEvidenceProjectionForAdapter(projection, "2026-08-31T00:01:00.000Z", {
      adapterId: "  future-medium  ",
      sourceOwner: "future-medium-reader",
    });

    expect(reader).toMatchObject({
      contractVersion: GLOBAL_EVIDENCE_PROJECTION_READER_CONTRACT_VERSION,
      adapterId: "future-medium",
      read: {
        sourceOwner: "future-medium-reader",
        readStatus: "current",
        blocked: false,
      },
      view: {
        readStatus: "current",
        blocked: false,
        deliveryState: "bound",
        adapterId: "opaque-delivery",
      },
    });
    expect(reader.read.projection?.delivery.adapterId).toBe("opaque-delivery");
    expect(() =>
      readGlobalEvidenceProjectionForAdapter(projection, "2026-08-31T00:01:00.000Z", {
        adapterId: "  ",
      }),
    ).toThrow("non-empty opaque string");
    expect(() =>
      readGlobalEvidenceProjectionForAdapter(projection, "2026-08-31T00:01:00.000Z"),
    ).toThrow("non-empty opaque string");
    expect(() =>
      readGlobalEvidenceProjectionForAdapter(projection, "2026-08-31T00:01:00.000Z", {
        adapterId: "future\nmedium",
      }),
    ).toThrow("must not contain line breaks");
  });

  it("keeps stale adapter reads blocked and payload-free in the view", () => {
    const projection = buildGlobalEvidenceProjection({
      generatedAt: "2026-08-31T00:00:00.000Z",
      sourceOwners: ["mind-model"],
      lanes: [],
      invariants: [],
    });
    const reader = readGlobalEvidenceProjectionForAdapter(projection, "2026-08-31T00:05:01.000Z", {
      adapterId: "future-medium",
    });

    expect(reader).toMatchObject({
      adapterId: "future-medium",
      read: { readStatus: "stale", blocked: true },
      view: {
        readStatus: "stale",
        blocked: true,
        capabilityCount: 0,
        evidenceCount: 0,
        actionCount: 0,
        deliveryState: null,
        adapterId: null,
      },
    });
  });

  it("derives adapter-neutral reader ids from message context", () => {
    expect(
      resolveGlobalEvidenceProjectionAdapterId({
        surface: "External / External",
        provider: "telegram",
      }),
    ).toBe("message-adapter:external-external");
    expect(
      resolveGlobalEvidenceProjectionAdapterId({ provider: "Telegram", fallback: "unknown" }),
    ).toBe("message-adapter:telegram");
    expect(
      resolveGlobalEvidenceProjectionAdapterId({
        adapterId: "  future-medium  ",
        surface: "external",
      }),
    ).toBe("future-medium");
  });

  it("reads the canonical governance envelope without becoming an owner", async () => {
    const projection = buildGlobalEvidenceProjection({
      generatedAt: "2026-08-31T00:00:00.000Z",
      sourceOwners: ["mind-model"],
      lanes: [],
      invariants: [],
    });
    const envelope = readGlobalEvidenceProjection(projection, "2026-08-31T00:01:00.000Z", {
      sourceOwner: "mind-model",
    });
    const loaded = await readCanonicalGlobalEvidenceProjectionCandidate({
      workspaceDir: "/tmp/lcx-projection-test",
      readFile: async () => JSON.stringify({ globalEvidenceProjection: envelope }),
    });

    expect(loaded).toMatchObject({
      sourceOwner: "governance-autopilot",
      sourcePath: path.join(
        path.resolve("/tmp/lcx-projection-test"),
        "state",
        "lcx-governance-autopilot-latest.json",
      ),
      candidate: envelope,
    });
    expect(loaded?.candidate).not.toBe(projection);
  });
});
