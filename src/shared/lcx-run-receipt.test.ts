import { describe, expect, it } from "vitest";
import {
  boundaryFromFlags,
  buildLcxRunReceipt,
  createLcxRunId,
  createLcxRunSnapshot,
  LCX_RUN_RECEIPT_CONTRACT_VERSION,
} from "./lcx-run-receipt.js";

describe("LCX run receipt", () => {
  it("joins a run to evidence and preserves authority boundaries", () => {
    const receipt = buildLcxRunReceipt({
      runId: createLcxRunId({
        checkedAt: "2026-09-07T07:00:00.000Z",
        owner: "governance",
        key: "test",
      }),
      parentRunId: "parent-run",
      owner: "governance",
      phase: "observe",
      status: "blocked",
      checkedAt: "2026-09-07T07:00:00.000Z",
      snapshot: createLcxRunSnapshot({
        observedAt: "2026-09-07T07:00:00.000Z",
        sourceCommit: "abc123",
        sourceBranch: "main",
        authorityOwner: "governance",
      }),
      boundary: boundaryFromFlags({
        scope: "local_governance_only",
        externalSenderTouched: false,
        trainingTouched: false,
      }),
      evidence: [
        {
          id: "owner-output",
          kind: "proof",
          status: "present",
          owner: "governance",
          locator: "governance.json",
        },
      ],
      nextAction: "review blocked owner",
    });

    expect(receipt).toEqual(
      expect.objectContaining({
        contractVersion: LCX_RUN_RECEIPT_CONTRACT_VERSION,
        parentRunId: "parent-run",
        phase: "observe",
        status: "blocked",
        snapshot: expect.objectContaining({
          observedAt: "2026-09-07T07:00:00.000Z",
          sourceCommit: "abc123",
        }),
        boundary: expect.objectContaining({
          scope: "local_governance_only",
          externalSender: "not_touched_by_projection",
          training: "not_touched_by_projection",
        }),
        ontologyEdges: expect.arrayContaining([
          {
            relation: "produces",
            subject: { type: "module", id: "governance" },
            object: { type: "receipt", id: receipt.runId },
          },
        ]),
      }),
    );
  });

  it("rejects duplicate evidence and incomplete action state", () => {
    const params = {
      runId: "run",
      owner: "owner",
      phase: "verify" as const,
      status: "passed" as const,
      checkedAt: "2026-09-07T07:00:00.000Z",
      boundary: boundaryFromFlags({ scope: "local_only" }),
      evidence: [
        {
          id: "same",
          kind: "proof" as const,
          status: "present" as const,
          owner: "owner",
          locator: "one",
        },
        {
          id: "same",
          kind: "proof" as const,
          status: "present" as const,
          owner: "owner",
          locator: "two",
        },
      ],
      nextAction: "continue",
    };
    expect(() => buildLcxRunReceipt(params)).toThrow("evidence ids must be unique");
    expect(() => buildLcxRunReceipt({ ...params, evidence: [], nextAction: " " })).toThrow(
      "nextAction must not be empty",
    );
  });

  it("rejects a receipt whose visible time diverges from its snapshot", () => {
    expect(() =>
      buildLcxRunReceipt({
        runId: "run",
        owner: "owner",
        phase: "observe",
        status: "passed",
        checkedAt: "2026-09-07T07:00:00.000Z",
        snapshot: createLcxRunSnapshot({
          observedAt: "2026-09-07T07:01:00.000Z",
          sourceCommit: "abc123",
          sourceBranch: "main",
          authorityOwner: "owner",
        }),
        boundary: boundaryFromFlags({ scope: "local_only" }),
        nextAction: "continue",
      }),
    ).toThrow("checkedAt must match snapshot.observedAt");
  });

  it("rejects an invalid semantic edge before emitting the receipt", () => {
    expect(() =>
      buildLcxRunReceipt({
        runId: "run",
        owner: "owner",
        phase: "observe",
        status: "passed",
        checkedAt: "2026-09-07T07:00:00.000Z",
        boundary: boundaryFromFlags({ scope: "local_only" }),
        ontologyEdges: [
          {
            relation: "requires",
            subject: { type: "workflow", id: "workflow-1" },
            object: { type: "actor", id: "actor-1" },
          },
        ],
        nextAction: "continue",
      }),
    ).toThrow("violates relation contract");
  });
});
