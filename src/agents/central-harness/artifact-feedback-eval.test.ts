import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { recordAgentArtifact } from "../artifact-result-recording.js";
import { createOpenClawCodingTools } from "../pi-tools.js";
import { compactReceipts, runCentralHarnessCycle } from "./harness-loop.js";
import { createCentralToolRegistry } from "./tool-registry.js";
import type { CentralRunReceipt } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-feedback-"));
  roots.push(workspaceDir);
  const dbPath = path.join(workspaceDir, "memory.sqlite");
  const config: OpenClawConfig = {
    agents: { defaults: { workspace: workspaceDir, memorySearch: { store: { path: dbPath } } } },
  };
  return { workspaceDir, config, dbPath };
}

describe("database artifact feedback through existing production entries (offline scripted)", () => {
  it("records a normal agent tool once, finds its result, and reads a selected mathematical fact", async () => {
    const host = await fixture();
    const tools = createOpenClawCodingTools({ ...host, agentId: "main" });
    const quant = tools.find((tool) => tool.name === "quant_math")!;
    const recall = tools.find((tool) => tool.name === "artifact_memory_recall")!;
    const result = await quant.execute("quant-result", {
      action: "linear_regression",
      series: [7, 14, 21],
      benchmark: [1, 2, 3],
    });
    expect(result.details).toMatchObject({ action: "linear_regression", beta: 7 });
    expect(result.content.filter((block) => block.type === "text")).toHaveLength(2);
    const search = await recall.execute("search", { action: "search", query: "linear_regression" });
    const found = search.details as { latestArtifactId: string; count: number };
    expect(found.count).toBe(1);
    const read = await recall.execute("read", {
      action: "read",
      id: found.latestArtifactId,
      field: "/value/details/beta",
    });
    expect(read.details).toMatchObject({ available: true, selectedValue: 7 });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(host.dbPath, { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM owner_artifacts").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it.each([2, 7])(
    "uses discovered database evidence after original receipt digests omit the result (beta=%s)",
    async (beta) => {
      const host = await fixture();
      const fullRegistry = createCentralToolRegistry(host);
      const capabilities = new Set(["quant_math", "artifact_memory_recall"]);
      const registry = new Map([...fullRegistry].filter(([id]) => capabilities.has(id)));
      const receipts: CentralRunReceipt[] = [];
      const cycle = async (ownerId: string, args: Record<string, unknown>) => {
        const receipt = await runCentralHarnessCycle({
          perception: {
            observedAt: new Date().toISOString(),
            ownerTotals: {},
            controlRoom: {},
            backlog: compactReceipts(receipts, 10, capabilities),
            boundaries: ["offline_scripted_replay", "no_execution_authority"],
          },
          registry,
          capabilityOwnerIds: capabilities,
          planOnly: true,
          brain: {
            propose: async () => ({
              kind: "proposed",
              provider: "fixture",
              modelId: "scripted",
              plan: { actions: [{ ownerId, args }], note: "offline scripted database feedback" },
            }),
          },
        });
        receipts.push(receipt);
        expect(receipt.brainCall.modelCall).toBeUndefined();
        return receipt;
      };
      await cycle("quant_math", {
        action: "linear_regression",
        series: [beta, beta * 2, beta * 3],
        benchmark: [1, 2, 3],
      });
      // Exercise result recovery independent of the original in-context mathematical digest.
      receipts.splice(0);
      const searched = await cycle("artifact_memory_recall", {
        action: "search",
        query: "linear_regression",
      });
      const id = searched.steps[0].outcome?.latestArtifactId;
      expect(id).toEqual(expect.any(String));
      const read = await cycle("artifact_memory_recall", {
        action: "read",
        id,
        field: "/value/beta",
      });
      expect(read.steps[0].outcome?.selectedValue).toBe(beta);
      expect(read.steps[0].outcome?.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(read.steps[0].outcome?.sourceObservedAt).toEqual(expect.any(String));
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(host.dbPath, { readOnly: true });
      try {
        const row = db
          .prepare("SELECT record_json FROM owner_artifacts WHERE id=?")
          .get(String(id)) as { record_json: string };
        const original = JSON.parse(row.record_json) as { sha256: string; observedAt: string };
        expect(read.steps[0].outcome?.sourceSha256).toBe(original.sha256);
        expect(read.steps[0].outcome?.sourceObservedAt).toBe(original.observedAt);
      } finally {
        db.close();
      }
      const decision =
        Number(read.steps[0].outcome?.selectedValue) > 3
          ? "measure scaling bottleneck"
          : "retain baseline";
      expect(decision).toBe(beta === 7 ? "measure scaling bottleneck" : "retain baseline");
    },
  );
});

describe("original owner artifact read changes the next bounded decision (offline scripted)", () => {
  it.each([false, true])(
    "consumes the exact current result even after context loss (ready=%s)",
    async (ready) => {
      const host = await fixture();
      const owner = "commercialAcceptance";
      const observedAt = "2026-10-07T03:00:00.000Z";
      const full = {
        ok: ready,
        summary: { readyForCommercialRelease: ready },
        details: "retained-original".repeat(10000),
      };
      const artifact = await recordAgentArtifact({
        ...host,
        agentId: "main",
        owner,
        runId: `owner-${ready}`,
        observedAt,
        value: full,
      });
      expect(artifact.status).toBe("registered");
      // A generic older hit with the opposite result must not substitute for the exact owner result.
      await recordAgentArtifact({
        ...host,
        agentId: "main",
        owner: "unrelated",
        runId: "old",
        observedAt: "2026-09-01T00:00:00.000Z",
        value: { summary: { readyForCommercialRelease: !ready } },
      });
      const fullRegistry = createCentralToolRegistry(host);
      const allowed = new Set(["artifact_memory_recall"]);
      const registry = new Map([...fullRegistry].filter(([id]) => allowed.has(id)));
      const read = await runCentralHarnessCycle({
        perception: {
          observedAt,
          ownerTotals: {},
          controlRoom: {
            governanceDigest: {
              ownerResults: [
                { ownerId: owner, artifactId: artifact.id, sourceObservedAt: observedAt },
              ],
            },
          },
          backlog: [],
          boundaries: ["offline_scripted", "no_execution_authority"],
        },
        registry,
        capabilityOwnerIds: allowed,
        planOnly: true,
        brain: {
          propose: async () => ({
            kind: "proposed",
            provider: "fixture",
            modelId: "scripted",
            plan: {
              note: "offline exact owner result read",
              actions: [
                {
                  ownerId: "artifact_memory_recall",
                  args: {
                    action: "read",
                    id: artifact.id,
                    field: "/value/summary/readyForCommercialRelease",
                    asOf: observedAt,
                  },
                },
              ],
            },
          }),
        },
      });
      expect(read.steps[0].status).toBe("ran_ok");
      expect(read.steps[0].outcome?.selectedValue).toBe(ready);
      expect(read.steps[0].outcome?.sourceSha256).toBe(artifact.sha256);
      const next = await runCentralHarnessCycle({
        perception: {
          observedAt,
          ownerTotals: {},
          controlRoom: {},
          backlog: compactReceipts([read], 10, allowed),
          boundaries: ["offline_scripted", "no_execution_authority"],
        },
        registry,
        capabilityOwnerIds: allowed,
        planOnly: true,
        brain: {
          propose: async (perception) => {
            const value = (
              perception.backlog[0].outcomes as Array<{ outcome?: Record<string, unknown> }>
            )[0].outcome?.selectedValue;
            return {
              kind: "proposed",
              provider: "fixture",
              modelId: "scripted",
              plan: {
                actions: [],
                note:
                  value === true
                    ? "ready outcome consumed; no owner rerun"
                    : "blocked outcome consumed; retain exact unmet release condition",
              },
            };
          },
        },
      });
      expect(next.actionsProposed).toBe(0);
      expect(next.brainCall.note).toContain(
        ready ? "ready outcome consumed" : "blocked outcome consumed",
      );
      expect(next.brainCall.modelCall).toBeUndefined();
    },
  );
});
