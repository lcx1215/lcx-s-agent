import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { ArtifactStore } from "../../memory/artifact-store.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { recordAgentArtifact } from "../artifact-result-recording.js";
import { createOpenClawCodingTools } from "../pi-tools.js";
import {
  boundPerception,
  CENTRAL_READ_PAGE_OUTCOME_BUDGET_BYTES,
  compactReceipts,
  nextCycleContinuation,
  runCentralHarnessCycle,
  type CompactBacklogEntry,
} from "./harness-loop.js";
import { createCentralToolRegistry } from "./tool-registry.js";
import type { CentralPerception, CentralRunReceipt } from "./types.js";

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
    const tools = createOpenClawCodingTools({
      ...host,
      agentId: "main",
      runId: "ordinary-artifact-invocation",
    });
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
    const lineage = await recall.execute("read-lineage", {
      action: "read",
      id: found.latestArtifactId,
      field: "/invocation",
    });
    expect(lineage.details).toMatchObject({
      available: true,
      selectedValue: {
        runId: "ordinary-artifact-invocation",
        workspaceId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
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
      let cycleIndex = 0;
      const cycle = async (ownerId: string, args: Record<string, unknown>) => {
        const receipt = await runCentralHarnessCycle({
          runId: `artifact-invocation-${beta}-${cycleIndex++}`,
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
      const produced = await cycle("quant_math", {
        action: "linear_regression",
        series: [beta, beta * 2, beta * 3],
        benchmark: [1, 2, 3],
        invocationRunId: "model-selected-run",
      });
      // Exercise result recovery independent of the original in-context mathematical digest.
      receipts.splice(0);
      const searched = await cycle("artifact_memory_recall", {
        action: "search",
        query: "linear_regression",
      });
      const id = searched.steps[0].outcome?.latestArtifactId;
      expect(id).toEqual(expect.any(String));
      const lineage = await cycle("artifact_memory_recall", {
        action: "read",
        id,
        field: "/invocation",
      });
      expect(lineage.steps[0].outcome).toMatchObject({
        available: true,
        selectedValue: {
          runId: produced.runId,
          workspaceId: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });
      expect(lineage.runId).not.toBe(produced.runId);
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
      const proofDirectory = process.env.LCX_INVOCATION_LINEAGE_PROOF_DIR;
      if (proofDirectory) {
        await fs.mkdir(proofDirectory, { recursive: true });
        const producerBytes = await fs.readFile(
          path.join(
            host.workspaceDir,
            "state/artifacts",
            `${String(read.steps[0].outcome?.sourceSha256)}.json`,
          ),
        );
        const producerPath = path.join(proofDirectory, `beta-${beta}-original-artifact.json`);
        const consumerPath = path.join(proofDirectory, `beta-${beta}-native-cycles.json`);
        await fs.writeFile(producerPath, producerBytes);
        await fs.writeFile(
          consumerPath,
          JSON.stringify({ produced, searched, lineage, read, decision }, null, 2) + "\n",
        );
        await fs.writeFile(
          path.join(proofDirectory, `beta-${beta}-manifest.json`),
          JSON.stringify(
            {
              producer: {
                path: producerPath,
                sha256: createHash("sha256").update(producerBytes).digest("hex"),
              },
              consumer: {
                path: consumerPath,
                sha256: createHash("sha256")
                  .update(await fs.readFile(consumerPath))
                  .digest("hex"),
              },
              environment: "offline_scripted_original_entries",
              naturalAdoption: "not_proven",
              providerCalled: false,
            },
            null,
            2,
          ) + "\n",
        );
      }
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

describe("bounded artifact evidence and unavailable-result feedback", () => {
  async function readCycle(value: unknown, field?: string) {
    const host = await fixture();
    const artifact = await recordAgentArtifact({
      ...host,
      agentId: "main",
      owner: "fixture_evidence",
      runId: "retained-evidence",
      value,
    });
    const full = createCentralToolRegistry(host);
    const registry = new Map([["artifact_memory_recall", full.get("artifact_memory_recall")!]]);
    const capabilities = new Set(["artifact_memory_recall"]);
    const args = { action: "read", id: artifact.id, ...(field === undefined ? {} : { field }) };
    const perception = {
      observedAt: new Date().toISOString(),
      ownerTotals: {},
      controlRoom: {},
      backlog: [],
      boundaries: ["offline_scripted", "no_execution_authority"],
    };
    const brain = {
      propose: async () => ({
        kind: "proposed" as const,
        provider: "fixture",
        modelId: "scripted",
        plan: {
          actions: [{ ownerId: "artifact_memory_recall", args }],
          note: "read exact evidence",
        },
      }),
    };
    const options = {
      perception,
      registry,
      capabilityOwnerIds: capabilities,
      planOnly: true,
      brain,
    };
    const receipt = await runCentralHarnessCycle(options);
    return { receipt, options, artifact, capabilities };
  }

  it.each(["value.content[0].text", "/value/missing"])(
    "reports unavailable evidence separately from successful dispatch (%s)",
    async (field) => {
      const { receipt, options } = await readCycle({ present: true }, field);
      expect(receipt.steps[0]).toMatchObject({
        status: "ran_ok",
        observedOk: false,
        outcome: { available: false },
      });
      expect(receipt.steps[0].outcome?.gap).toBe(
        field.startsWith("/") ? "artifact_field_missing" : "artifact_field_invalid",
      );
      expect(receipt.nextAction).toBe("follow_up_on_owners_reporting_not_ok");
      const repeated = await runCentralHarnessCycle(options);
      expect(nextCycleContinuation(repeated, 2, 4, receipt)).toEqual({
        run: false,
        because: "unchanged_failure",
      });
    },
  );

  it.each([false, true])(
    "carries the exact evidence into the next decision (ready=%s)",
    async (ready) => {
      const selected = { evidence: "核实证据".repeat(120), ready };
      const { receipt, options, artifact, capabilities } = await readCycle(
        { selected, unrelated: "not decision evidence".repeat(3000) },
        "/value/selected",
      );
      const step = receipt.steps[0];
      expect(step.observedOk).toBe(true);
      expect(step.outcome).toMatchObject({
        selectedValue: selected,
        artifactId: artifact.id,
        sourceSha256: artifact.sha256,
        field: "/value/selected",
      });
      expect(step.outcome).not.toHaveProperty("text");
      expect(Buffer.byteLength(JSON.stringify(step.outcome))).toBeLessThanOrEqual(
        CENTRAL_READ_PAGE_OUTCOME_BUDGET_BYTES,
      );
      const backlog = compactReceipts([receipt], 10, capabilities);
      const nextPerception = { ...options.perception, backlog };
      expect(boundPerception(nextPerception).report.overBudget).toBe(false);
      const next = await runCentralHarnessCycle({
        ...options,
        perception: nextPerception,
        brain: {
          propose: async (perception: CentralPerception) => {
            const outcomes = perception.backlog[0].outcomes as CompactBacklogEntry["outcomes"];
            const recovered = outcomes[0].outcome?.selectedValue;
            expect(recovered).toEqual(selected);
            return {
              kind: "proposed",
              provider: "fixture",
              modelId: "scripted",
              plan: { actions: [], note: ready ? "proceed from evidence" : "stop from evidence" },
            };
          },
        },
      });
      expect(next.brainCall.note).toBe(ready ? "proceed from evidence" : "stop from evidence");
      expect(next.brainCall.modelCall).toBeUndefined();
    },
  );

  it("keeps the original pointer and names an oversized selected-field omission", async () => {
    const { receipt, artifact } = await readCycle(
      { selected: "x".repeat(9000) },
      "/value/selected",
    );
    const step = receipt.steps[0];
    expect(step.outcome).toMatchObject({
      available: true,
      artifactId: artifact.id,
      field: "/value/selected",
      sourceSha256: artifact.sha256,
      selectedPreviewTruncated: true,
    });
    expect(step.outcome).not.toHaveProperty("selectedValue");
    expect(step.outcomeDroppedKeys).toContain("selectedValue");
    expect(Buffer.byteLength(JSON.stringify(step.outcome))).toBeLessThanOrEqual(
      CENTRAL_READ_PAGE_OUTCOME_BUDGET_BYTES,
    );
  });

  it("recovers an omitted rule body by its exact child pointer and binds the following judgment", async () => {
    const body = {
      frozenRule: { exit: "Exit at session close", stopLoss: "ATR based stop" },
      explanation: "rule context ".repeat(150),
    };
    const { receipt, options, artifact, capabilities } = await readCycle(
      {
        accountId: "paper-A",
        venue: "paper",
        rules: Array.from({ length: 4 }, (_, index) => ({
          ruleId: `rule-${index}`,
          instrument: "SPY",
          body,
        })),
      },
      "/value/rules",
    );
    expect(receipt.steps[0].outcomeDroppedKeys).toContain("selectedValue");
    const hints = receipt.steps[0].outcome?.selectionHints as Array<{ field: string }>;
    const pointer = hints.find((hint) => hint.field.endsWith("/body"))!.field;
    const narrow = await runCentralHarnessCycle({
      ...options,
      perception: { ...options.perception, backlog: compactReceipts([receipt], 10, capabilities) },
      brain: {
        propose: async (perception) => {
          expect(
            (perception.backlog[0].outcomes as CompactBacklogEntry["outcomes"])[0].outcome
              ?.selectionGap,
          ).toBe("selected_field_exceeds_step_budget");
          return {
            kind: "proposed",
            provider: "fixture",
            modelId: "scripted",
            plan: {
              actions: [
                {
                  ownerId: "artifact_memory_recall",
                  args: { action: "read", id: artifact.id, field: pointer },
                },
              ],
              note: "Read the omitted rule body",
            },
          };
        },
      },
    });
    expect(narrow.steps[0].outcome?.selectedValue).toEqual(body);
    expect(narrow.steps[0].outcome?.sourceSha256).toBe(artifact.sha256);
    const next = await runCentralHarnessCycle({
      ...options,
      perception: {
        ...options.perception,
        backlog: compactReceipts([receipt, narrow], 10, capabilities),
      },
      brain: {
        propose: async (perception) => {
          const read = perception.backlog
            .flatMap((item) => item.outcomes as CompactBacklogEntry["outcomes"])
            .find((step) => step.outcome?.field === pointer)!;
          expect(read.outcome?.selectedValue).toEqual(body);
          return {
            kind: "proposed",
            provider: "fixture",
            modelId: "scripted",
            plan: {
              actions: [],
              note: "Retain the session-close exit",
              evidenceUse: [
                {
                  artifactId: artifact.id!,
                  sourceSha256: artifact.sha256!,
                  field: pointer,
                  effect: "retain",
                  reason: "The frozen exit requires session close; do not infer an always-on exit.",
                },
              ],
            },
          };
        },
      },
    });
    expect(next.evidenceUse?.[0]).toMatchObject({
      verification: "reference_verified",
      scope: { accountId: "paper-A", venue: "paper", instrument: "SPY" },
      reason: expect.stringContaining("session close"),
    });
    expect(next.ontologyEdges?.some((edge) => edge.object.id === "accountId:paper-A")).toBe(true);
    expect(next.liveTouched).toBe(false);
    expect(next.contextBudget?.overBudget).toBe(false);
  });

  it("does not expand an unselected full-document read", async () => {
    const { receipt } = await readCycle({ detail: "x".repeat(10000) });
    expect(Buffer.byteLength(JSON.stringify(receipt.steps[0].outcome))).toBeLessThanOrEqual(512);
    expect(receipt.steps[0].outcome).not.toHaveProperty("selectedValue");
    expect(receipt.steps[0].outcome?.previewTruncated).toBe(true);
  });

  it("uses a malformed source fragment for a bounded hypothesis without inventing the missing field", async () => {
    const host = await fixture();
    await fs.mkdir(path.join(host.workspaceDir, "state/runs"), { recursive: true });
    await fs.writeFile(
      path.join(host.workspaceDir, "state/runs/fragment.json"),
      '{"price":138.05,"volume":',
    );
    const store = ArtifactStore.open(host);
    try {
      await store.register({
        id: "partial-source",
        owner: "fragment-intake",
        runId: "partial-run",
        observedAt: "2026-10-07T14:00:00Z",
        relativePath: "state/runs/fragment.json",
        mimeType: "application/json",
        summary: "partial price clue; volume is unknown",
      });
    } finally {
      store.close();
    }
    const registry = createCentralToolRegistry(host);
    const capabilities = new Set(["artifact_memory_recall"]);
    const perception = {
      observedAt: "2026-10-07T14:01:00Z",
      ownerTotals: {},
      controlRoom: {},
      backlog: [],
      boundaries: ["offline_scripted", "no_execution_authority"],
    };
    const read = await runCentralHarnessCycle({
      perception,
      registry,
      capabilityOwnerIds: capabilities,
      brain: {
        propose: async () => ({
          kind: "proposed",
          provider: "fixture",
          modelId: "scripted",
          plan: {
            note: "inspect source",
            actions: [
              {
                ownerId: "artifact_memory_recall",
                args: { action: "read", id: "partial-source", field: "/volume" },
              },
            ],
          },
        }),
      },
    });
    expect(read.steps[0]).toMatchObject({
      status: "ran_ok",
      observedOk: false,
      outcome: {
        sourceAvailable: true,
        selectionComplete: false,
        textPreview: '{"price":138.05,"volume":',
      },
    });
    const next = await runCentralHarnessCycle({
      perception: { ...perception, backlog: compactReceipts([read], 10, capabilities) },
      registry,
      capabilityOwnerIds: capabilities,
      brain: {
        propose: async (current) => {
          const outcomes = current.backlog[0].outcomes as CompactBacklogEntry["outcomes"];
          const fragment = outcomes[0].outcome;
          expect(fragment).not.toHaveProperty("selectedValue");
          return {
            kind: "proposed",
            provider: "fixture",
            modelId: "scripted",
            plan: {
              actions: [],
              note:
                fragment?.sourceAvailable === true &&
                String(fragment.textPreview).includes("138.05")
                  ? "retain price clue as hypothesis; volume remains unknown"
                  : "no usable source",
            },
          };
        },
      },
    });
    expect(next.brainCall.note).toBe("retain price clue as hypothesis; volume remains unknown");
    expect(next.brainCall.modelCall).toBeUndefined();
  });
});
