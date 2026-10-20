import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backfillOwnerArtifacts } from "../memory/artifact-owner-backfill.js";
import { ArtifactStore } from "../memory/artifact-store.js";
import type { FinanceIntradayDecisionRecord } from "./finance-intraday-control-ledger.js";
import { runFinanceResearchRun } from "./finance-research-runner.js";
import {
  recordFinanceIntradayResult,
  recordFinanceResearchResult,
} from "./finance-result-recording.js";
import { createFinanceTradeResultRecallCapability } from "./finance-trade-result-recall.js";

vi.mock("../config/config.js", () => ({
  loadConfig: () => {
    throw new Error("isolated missing configuration");
  },
}));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-result-recording-"));
  roots.push(workspaceDir);
  const dbPath = path.join(workspaceDir, "memory.sqlite");
  return {
    workspaceDir,
    dbPath,
    host: {
      workspaceDir,
      config: {
        agents: { defaults: { memorySearch: { enabled: true, store: { path: dbPath } } } },
      },
    },
  };
}
const decision: FinanceIntradayDecisionRecord = {
  schemaVersion: "lcx_finance_intraday_decision_v1",
  sequence: 1,
  previousRef: null,
  recordedAt: "2026-10-01T14:00:00.000Z",
  ref: "a".repeat(64),
  input: {
    signalId: "signal-a",
    instrument: "SPY",
    sessionDate: "2026-10-01",
    action: "buy",
    reason: "opening_range_breakout",
    referencePrice: 500,
    referencePriceAt: "2026-10-01T14:00:00.000Z",
    datasetHeadRef: "b".repeat(64),
    strategyRule: "opening_range_breakout_long_next_bar_v1",
  },
};

describe("trusted finance result recording", () => {
  it("recovers a failed index registration from the original immutable output", async () => {
    const host = await fixture();
    const registration = vi
      .spyOn(ArtifactStore.prototype, "register")
      .mockRejectedValueOnce(new Error("fixture transient index failure"));
    const first = await recordFinanceIntradayResult({
      ...host,
      directory: host.workspaceDir,
      accountId: "paper-a",
      venue: "alpaca:paper",
      decision,
      outcome: {
        signalId: decision.input.signalId,
        status: "refused",
        reasons: ["original reason"],
      },
    });
    registration.mockRestore();
    expect(first.status).toBe("unavailable");
    const original = await fs.readFile(path.join(host.workspaceDir, first.relativePath!));
    const recovered = await backfillOwnerArtifacts({
      config: host.host.config,
      agentId: "main",
      workspaceDir: host.workspaceDir,
      limit: 10,
      deadlineMs: Date.now() + 5000,
    });
    expect(recovered.registered).toBe(1);
    expect(await fs.readFile(path.join(host.workspaceDir, first.relativePath!))).toEqual(original);
    const store = ArtifactStore.open({
      dbPath: host.dbPath,
      workspaceDir: host.workspaceDir,
      readOnly: true,
    });
    try {
      const found = store.search({ query: "SPY buy", owner: "finance_intraday_execution" });
      expect(found.artifacts).toHaveLength(1);
      expect(found.artifacts[0]).toMatchObject({ id: first.id, sha256: first.sha256 });
    } finally {
      store.close();
    }
  });

  it.each(["refused", "uncertain", "placed"] as const)(
    "preserves %s outcome, exact source SHA and terminal retry idempotency",
    async (status) => {
      const host = await fixture();
      const outcome = {
        signalId: decision.input.signalId,
        status,
        reasons: ["original reason"],
        ...(status === "placed" ? { receiptId: "receipt-a" } : {}),
      };
      const input = {
        ...host,
        directory: host.workspaceDir,
        accountId: "paper-a",
        venue: "alpaca:paper",
        decision,
        outcome,
      };
      const first = await recordFinanceIntradayResult(input);
      const second = await recordFinanceIntradayResult(input);
      expect(first.status).toBe("registered");
      expect(second).toEqual({ ...first, status: "unchanged" });
      const raw = await fs.readFile(path.join(host.workspaceDir, first.relativePath!));
      expect(first.sha256).toBe(createHash("sha256").update(raw).digest("hex"));
      expect(JSON.parse(raw.toString()).value.details).toEqual({
        accountId: "paper-a",
        venue: "alpaca:paper",
        decision,
        outcome,
      });
      const recall = createFinanceTradeResultRecallCapability({
        config: host.host.config,
        workspaceDir: host.workspaceDir,
      });
      expect(
        await recall.execute(
          {
            moduleId: "portfolio_risk_gates",
            accountId: "paper-a",
            venue: "alpaca:paper",
            asOf: new Date(Date.now() + 1000).toISOString(),
            question: "What happened to the prior order?",
            candidate: {
              candidateId: "next-signal",
              instrument: "SPY",
              side: "buy",
              strategyRule: decision.input.strategyRule,
              signalReason: "opening_range_breakout",
              signalReferencePrice: 500,
              signalReferencePriceAt: decision.input.referencePriceAt,
              datasetHeadRef: decision.input.datasetHeadRef,
              intradayOwnedQuantity: 0,
              brokerPositionQuantity: 0,
              executionQuote: {
                referencePrice: 500,
                referencePriceAt: decision.input.referencePriceAt,
                sourceUrlOrArtifact: "fixture",
                ageMs: 0,
                maxAgeMs: 30000,
              },
            },
          },
          new AbortController().signal,
        ),
      ).toMatchObject({
        ok: true,
        sourceArtifactId: first.id,
        sourceSha256: first.sha256,
        recordedResult: { outcome: status, reasons: ["original reason"] },
      });
      const store = ArtifactStore.open({
        dbPath: host.dbPath,
        workspaceDir: host.workspaceDir,
        readOnly: true,
      });
      try {
        const result = store.search({ query: "SPY", owner: "finance_intraday_execution" });
        expect(result.artifacts.map((item) => item.id)).toEqual([first.id]);
        expect(result.artifacts[0].observedAt).not.toBe(decision.recordedAt);
        expect(JSON.parse((await store.read(first.id!)).text!).value.details.outcome).toEqual(
          outcome,
        );
      } finally {
        store.close();
      }
    },
  );

  it.each([
    { accountId: " ", venue: "alpaca:paper", signalId: decision.input.signalId },
    { accountId: "paper-a", venue: "alpaca:live", signalId: decision.input.signalId },
    { accountId: "paper-a", venue: "alpaca:paper", signalId: "wrong-signal" },
  ])("refuses mismatched or missing account/venue/signal scope before writing", async (scope) => {
    const host = await fixture();
    const result = await recordFinanceIntradayResult({
      ...host,
      directory: host.workspaceDir,
      accountId: scope.accountId,
      venue: scope.venue,
      decision,
      outcome: { signalId: scope.signalId, status: "refused", reasons: ["preserved"] },
    });
    expect(result).toEqual({ status: "unavailable", reason: "finance_artifact_scope_invalid" });
    expect(await fs.readdir(host.workspaceDir)).toEqual([]);
  });

  it("keeps complete research receipt and separate original raw SHA provenance", async () => {
    const host = await fixture();
    const receipt = await runFinanceResearchRun({
      input: { ask: "Risk diagnostics", asOf: "2026-10-01T00:00:00.000Z" },
    });
    const sourceSha256 = "c".repeat(64);
    const first = await recordFinanceResearchResult({
      ...host,
      receipt,
      datedPath: "state/finance-research-runs/fixture.json",
      sourceSha256,
    });
    expect(first.status).toBe("registered");
    const envelope = JSON.parse(
      await fs.readFile(path.join(host.workspaceDir, first.relativePath!), "utf8"),
    );
    expect(envelope.value.details.receipt).toEqual(receipt);
    expect(envelope.sourceReceiptRefs).toContain(`sha256:${sourceSha256}`);
    expect(first.sha256).not.toBe(sourceSha256);
    expect(
      (
        await recordFinanceResearchResult({
          ...host,
          receipt,
          datedPath: "state/finance-research-runs/fixture.json",
          sourceSha256,
        })
      ).status,
    ).toBe("unchanged");
  });

  it("contains missing config, disabled memory and cancellation without changing result", async () => {
    const host = await fixture();
    const input = {
      workspaceDir: host.workspaceDir,
      directory: host.workspaceDir,
      accountId: "paper-a",
      venue: "alpaca:paper",
      decision,
      outcome: {
        signalId: decision.input.signalId,
        status: "refused" as const,
        reasons: ["unaltered"],
      },
    };
    expect(await recordFinanceIntradayResult(input)).toEqual({
      status: "unavailable",
      reason: "finance_artifact_host_unavailable",
    });
    expect(
      await recordFinanceIntradayResult({
        ...input,
        host: {
          workspaceDir: host.workspaceDir,
          config: { agents: { defaults: { memorySearch: { enabled: false } } } },
        },
      }),
    ).toMatchObject({ status: "unavailable", reason: "artifact_recording_disabled" });
    const abort = new AbortController();
    abort.abort();
    expect(
      await recordFinanceIntradayResult({ ...input, host: host.host, signal: abort.signal }),
    ).toMatchObject({ status: "unavailable", reason: "artifact_recording_cancelled" });
    expect(input.outcome.reasons).toEqual(["unaltered"]);
  });
});
