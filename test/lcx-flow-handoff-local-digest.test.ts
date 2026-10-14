import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  digestHash,
  originalDigestInput,
  originalTraceCli,
  persistDigest,
  persistTraceAndConsume,
} from "./fixtures/lcx-waterflow-local-digest-probe.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(name: string) {
  const proof = process.env.LCX_LOCAL_DIGEST_PROOF_DIR;
  if (proof) {
    const root = path.join(proof, name);
    await fs.mkdir(root, { recursive: true });
    return root;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `lcx-local-digest-${name}-`));
  roots.push(root);
  return root;
}
async function probe(root: string, input: unknown, hash?: string) {
  const source = await persistDigest(root, "private-autopilot.json", input);
  const result = await originalTraceCli(source.path, hash ?? source.sha256);
  const consumed = await persistTraceAndConsume(root, result.value);
  await persistDigest(root, "result.json", { source, result, consumed });
  return { source, result, consumed };
}

describe("original local digest failure-trace readback (no automation or owner stack)", () => {
  it("retains native business failure with exit zero and empty summary as a concrete owner failure through downstream consumers", async () => {
    const root = await fixture("business-failed-exit-zero");
    const input = { ...originalDigestInput(root, "failed", 0), summary: {} };
    const { result, consumed } = await probe(root, input);
    expect(result.value).toMatchObject({
      ok: true,
      result: "failed",
      firstFailedGate: "owner_failed:commercialAcceptance",
      runReceipt: { status: "failed", nextAction: input.ownerCommands[0].runReceipt.nextAction },
      sourceReadback: { status: "validated", hashValidation: "pinned" },
    });
    expect(consumed.readback).toMatchObject({
      result: "failed",
      runReceipt: { status: "failed" },
      firstFailedGate: "owner_failed:commercialAcceptance",
    });
    expect(consumed.markdown).toContain("结果: failed");
    expect(consumed.markdown).toContain("第一处卡点: owner_failed:commercialAcceptance");
    expect(consumed.markdown).toContain(input.ownerCommands[0].runReceipt.nextAction);
  });

  it.each(["blocked", "failed", "passed"] as const)(
    "derives %s from native child receipt when summary is empty, through original downstream result/status/nextAction consumption",
    async (status) => {
      const root = await fixture(`summary-empty-${status}`);
      const input = {
        ...originalDigestInput(root, status, status === "passed" ? 0 : 1),
        summary: {},
      };
      const { result, consumed } = await probe(root, input);
      expect(result.value.sourceReadback).toMatchObject({
        status: "validated",
        hashValidation: "pinned",
      });
      expect(result.value.ok).toBe(true);
      expect(result.value.result).toBe(status);
      expect(result.value.runReceipt.status).toBe(status);
      expect(consumed.readback.result).toBe(status);
      expect(consumed.readback.runReceipt.status).toBe(status);
      expect(consumed.markdown).toContain(`结果: ${status}`);
      if (status !== "passed") {
        const gate =
          status === "blocked"
            ? "owner_blocked:commercialAcceptance"
            : "owner_exit_failed:commercialAcceptance";
        expect(result.value.firstFailedGate).toBe(gate);
        expect(result.value.nextSafeAction).toBe(input.ownerCommands[0].runReceipt.nextAction);
        expect(result.value.runReceipt.nextAction).toBe(
          input.ownerCommands[0].runReceipt.nextAction,
        );
        expect(consumed.markdown).toContain(`第一处卡点: ${gate}`);
        expect(consumed.markdown).toContain(input.ownerCommands[0].runReceipt.nextAction);
      }
    },
  );

  it("rejects duplicate native owner IDs at JSON read boundary and leaves blocked JSON and original handoff", async () => {
    const root = await fixture("duplicate-owner");
    const input = originalDigestInput(root);
    input.ownerCommands.push(structuredClone(input.ownerCommands[0]));
    const { result, consumed } = await probe(root, input);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("evidence ids must be unique");
    expect(result.value).toMatchObject({
      ok: false,
      result: "blocked",
      runReceipt: { status: "blocked" },
      sourceReadback: {
        status: "blocked",
        hashValidation: "pinned",
        reason: "source_owner_id_duplicate:commercialAcceptance",
      },
    });
    expect(consumed.readback.result).toBe("blocked");
    expect(consumed.readback.runReceipt.status).toBe("blocked");
    expect(consumed.markdown).toContain("结果: blocked");
    expect(consumed.markdown).toContain("source_owner_id_duplicate:commercialAcceptance");
  });

  it("keeps a real schema blocked owner with exit 1 blocked through original CLI, disk writer and governance handoff", async () => {
    const root = await fixture("blocked");
    const input = originalDigestInput(root);
    const { result, consumed, source } = await probe(root, input);
    expect(result.exitCode).toBe(0);
    expect(result.value).toMatchObject({
      ok: true,
      result: "blocked",
      firstFailedGate: "commercial_release_blocked",
      checkedAt: input.checkedAt,
      snapshot: input.snapshot,
      runReceipt: { parentRunId: input.runId, snapshot: input.snapshot },
      sourceReadback: {
        status: "validated",
        hashValidation: "pinned",
        sha256: source.sha256,
        semanticTruth: "not_proven",
      },
    });
    expect(result.value.ownerResults[0].runReceipt).toMatchObject(
      input.ownerCommands[0].runReceipt,
    );
    expect(consumed.readback).toEqual(result.value);
    expect(consumed.io).toContainEqual({
      op: "consumer_read",
      path: consumed.latest.path,
      sha256: consumed.latest.sha256,
    });
    expect(consumed.markdown).toContain("结果: blocked");
    expect(consumed.markdown).toContain("第一处卡点: commercial_release_blocked");
  });

  it("preserves actual owner failure and passed-receipt/nonzero-exit failure", async () => {
    for (const status of ["failed", "passed"] as const) {
      const root = await fixture(`exit-failure-${status}`);
      const { result, consumed } = await probe(root, originalDigestInput(root, status, 1));
      expect(result.value.result).toBe("failed");
      expect(result.value.firstFailedGate).toBe("owner_exit_failed:commercialAcceptance");
      expect(consumed.markdown).toContain("结果: failed");
    }
  });

  it("keeps legacy missing receipt unknown and does not waive its nonzero exit", async () => {
    const root = await fixture("legacy");
    const input = originalDigestInput(root);
    const legacy = {
      ownerCommands: input.ownerCommands.map(({ runReceipt: _receipt, ...owner }) => owner),
      summary: input.summary,
    };
    const source = await persistDigest(root, "private-autopilot.json", legacy);
    const result = await originalTraceCli(source.path);
    expect(result.value).toMatchObject({
      result: "failed",
      firstFailedGate: "owner_exit_failed:commercialAcceptance",
      sourceReadback: {
        status: "legacy_unverified",
        hashValidation: "not_requested",
        identityValidation: "not_verified",
      },
    });
    expect(result.value.ownerResults[0]).not.toHaveProperty("runReceipt");
    await persistDigest(root, "result.json", result);
  });

  it.each([
    "missing_parent",
    "missing_owner",
    "parent",
    "snapshot",
    "owner",
    "schema",
    "forged_status",
  ] as const)("blocks %s receipt evidence instead of trusting its status", async (fault) => {
    const root = await fixture(`fault-${fault}`);
    const input = originalDigestInput(root);
    const row = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    const owners = row.ownerCommands as Array<Record<string, unknown>>;
    const child = owners[0].runReceipt as Record<string, unknown>;
    if (fault === "missing_parent") {
      delete row.runReceipt;
    }
    if (fault === "missing_owner") {
      delete owners[0].runReceipt;
    }
    if (fault === "parent") {
      child.parentRunId = "other-parent";
    }
    if (fault === "snapshot") {
      (child.snapshot as Record<string, unknown>).sourceCommit = "other-source";
    }
    if (fault === "owner") {
      child.owner = "other-owner";
    }
    if (fault === "schema") {
      child.contractVersion = "handwritten";
    }
    if (fault === "forged_status") {
      owners[0].runReceipt = { status: "blocked" };
    }
    const { result, consumed } = await probe(root, row);
    expect(result.exitCode).toBe(1);
    expect(result.value.ok).toBe(false);
    expect(result.value.result).toBe("blocked");
    expect(result.value.ownerResults).toEqual([]);
    expect(result.value.sourceReadback.status).toBe("blocked");
    expect(result.value.firstFailedGate).toMatch(/^source_readback_blocked:/u);
    expect(consumed.markdown).toContain(result.value.firstFailedGate);
    expect(consumed.markdown).toContain("结果: blocked");
  });

  it("blocks a byte hash conflict and retains actual hash in original JSON/handoff", async () => {
    const root = await fixture("hash");
    const input = originalDigestInput(root);
    const { result, consumed } = await probe(root, input, "0".repeat(64));
    expect(result.value.sourceReadback).toMatchObject({
      status: "blocked",
      reason: "source_hash_conflict",
      hashValidation: "pin_failed",
    });
    expect(result.value.sourceReadback.sha256).toBe(
      digestHash(await fs.readFile(path.join(root, "private-autopilot.json"))),
    );
    expect(consumed.markdown).toContain("source_hash_conflict");
  });

  it.each(["missing", "malformed"])(
    "returns an explicit blocked JSON for %s source",
    async (fault) => {
      const root = await fixture(fault);
      const file = path.join(root, "private-source.json");
      if (fault === "malformed") {
        await fs.writeFile(file, "{invalid");
      }
      const result = await originalTraceCli(file);
      const consumed = await persistTraceAndConsume(root, result.value);
      expect(result.exitCode).toBe(1);
      expect(result.value).toMatchObject({
        ok: false,
        result: "blocked",
        sourceReadback: { status: "blocked" },
      });
      expect(consumed.markdown).toContain(result.value.firstFailedGate);
      await persistDigest(root, "result.json", { result, consumed });
    },
  );
});
