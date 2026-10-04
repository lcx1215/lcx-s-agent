import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  markCentralArtifactOutcome,
  nextCycleContinuation,
  runCentralHarnessCycle,
} from "./harness-loop.js";
import { createCentralToolRegistry } from "./tool-registry.js";
import type { CentralRunReceipt, CentralToolSpec } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-continuation-"));
  roots.push(workspaceDir);
  const config: OpenClawConfig = {
    agents: {
      defaults: { memorySearch: { store: { path: path.join(workspaceDir, "private.sqlite") } } },
    },
  };
  return { workspaceDir, config };
}
async function cycle(
  registry: ReadonlyMap<string, CentralToolSpec>,
  ownerId: string,
  args: Record<string, unknown> = {},
): Promise<CentralRunReceipt> {
  return runCentralHarnessCycle({
    perception: {
      observedAt: "2026-10-04T14:00:00.000Z",
      ownerTotals: {},
      controlRoom: {},
      backlog: [],
      boundaries: ["offline_scripted_replay", "no_execution_authority"],
    },
    registry,
    capabilityOwnerIds: new Set([ownerId]),
    planOnly: true,
    brain: {
      propose: async () => ({
        kind: "proposed",
        provider: "fixture",
        modelId: "scripted",
        plan: { actions: [{ ownerId, args }], note: "offline continuation regression" },
      }),
    },
  });
}
function customRegistry(execute: CentralToolSpec["execute"]) {
  return new Map<string, CentralToolSpec>([
    [
      "fixture",
      {
        ownerId: "fixture",
        name: "fixture",
        label: "fixture",
        description: "fixture",
        allowedSideEffects: [],
        boundary: [],
        approve: () => ({ ok: true }),
        execute,
      },
    ],
  ]);
}

describe("host archive provenance in the original continuation guard (offline scripted)", () => {
  it("stops identical real quant results despite different archived run identities", async () => {
    const registry = createCentralToolRegistry(await fixture());
    const args = { action: "linear_regression", series: [2, 4, 6], benchmark: [1, 2, 3] };
    const first = await cycle(registry, "quant_math", args);
    const second = await cycle(registry, "quant_math", args);
    expect(first.steps[0].outcome).toMatchObject({ beta: 2 });
    expect(second.steps[0].outcome).toMatchObject({ beta: 2 });
    expect(first.steps[0].outcome?.artifactEvidence).not.toEqual(
      second.steps[0].outcome?.artifactEvidence,
    );
    expect(first.steps[0].semanticOutcomeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.steps[0].semanticOutcomeSha256).toBe(first.steps[0].semanticOutcomeSha256);
    expect(nextCycleContinuation(second, 2, 5, first)).toEqual({
      run: false,
      because: "unchanged_result",
    });
    expect(first.brainCall.modelCall).toBeUndefined();
    // Durable host receipts retain their identity across JSON replay; model prose cannot supply it.
    const restored = JSON.parse(JSON.stringify(first)) as CentralRunReceipt;
    expect(nextCycleContinuation(second, 2, 5, restored)).toEqual({
      run: false,
      because: "unchanged_result",
    });
  });

  it.each([
    { value: 2 },
    { sourceSha256: "b".repeat(64) },
    { cutoff: "2026-10-04T12:01:00Z" },
    { nested: { artifactEvidence: { id: "business-changed" } } },
  ])("continues when original business evidence changes: %j", async (change) => {
    let business: Record<string, unknown> = {
      value: 1,
      sourceSha256: "a".repeat(64),
      cutoff: "2026-10-04T12:00:00Z",
      nested: { artifactEvidence: { id: "business-original" } },
    };
    let archive = 0;
    const registry = customRegistry(async () =>
      markCentralArtifactOutcome(
        { ...business, artifactEvidence: { id: `host-${++archive}`, status: "registered" } },
        business,
      ),
    );
    const first = await cycle(registry, "fixture");
    business = { ...business, ...change };
    const second = await cycle(registry, "fixture");
    expect(second.steps[0].semanticOutcomeSha256).not.toBe(first.steps[0].semanticOutcomeSha256);
    expect(nextCycleContinuation(second, 2, 5, first)).toEqual({
      run: true,
      because: "capability_results",
    });
  });

  it("never trusts original JSON metadata names, including an archive-field conflict", async () => {
    const host = await fixture();
    let evidence = "business-a";
    const registry = createCentralToolRegistry({
      ...host,
      execute: async () => ({
        status: "ready",
        artifactEvidence: { id: evidence },
        semanticOutcomeSha256: "0".repeat(64),
      }),
    });
    const first = await cycle(registry, "problemRadar");
    evidence = "business-b";
    const second = await cycle(registry, "problemRadar");
    // An original archive-field conflict remains business evidence, without host provenance.
    expect(first.steps[0].status).toBe("ran_ok");
    expect(first.steps[0].semanticOutcomeSha256).toBeUndefined();
    expect(second.steps[0].semanticOutcomeSha256).toBeUndefined();
    expect(nextCycleContinuation(second, 2, 5, first)).toEqual({
      run: true,
      because: "capability_results",
    });
    const plain = customRegistry(async () => ({
      status: "ready",
      artifactEvidence: { id: evidence },
      semanticOutcomeSha256: "0".repeat(64),
    }));
    const before = await cycle(plain, "fixture");
    evidence = "business-c";
    const after = await cycle(plain, "fixture");
    expect(after.steps[0].semanticOutcomeSha256).toBeUndefined();
    expect(nextCycleContinuation(after, 2, 5, before)).toEqual({
      run: true,
      because: "capability_results",
    });
  });

  it("preserves legacy outcome comparison when only one receipt has host provenance", async () => {
    const registry = customRegistry(async () =>
      markCentralArtifactOutcome({ value: 1, artifactEvidence: { id: "host-a" } }, { value: 1 }),
    );
    const first = await cycle(registry, "fixture");
    const legacy = {
      ...first,
      steps: first.steps.map(({ semanticOutcomeSha256: _ignored, ...step }) => step),
    };
    expect(nextCycleContinuation(first, 2, 5, legacy)).toEqual({
      run: false,
      because: "unchanged_result",
    });
    const different = {
      ...legacy,
      steps: legacy.steps.map((step) => ({
        ...step,
        outcome: { value: 1, artifactEvidence: { id: "host-b" } },
      })),
    };
    expect(nextCycleContinuation(first, 2, 5, different)).toEqual({
      run: true,
      because: "capability_results",
    });
  });

  it("retains diagnostic omissions and the existing maximum cycle boundary", async () => {
    const registry = customRegistry(async () =>
      markCentralArtifactOutcome({ value: 1, artifactEvidence: { id: "host-a" } }, { value: 1 }),
    );
    const first = await cycle(registry, "fixture");
    const changed = {
      ...first,
      steps: first.steps.map((step) => ({ ...step, outcomeDroppedKeys: ["missing-evidence"] })),
    };
    expect(nextCycleContinuation(changed, 2, 5, first)).toEqual({
      run: true,
      because: "capability_results",
    });
    expect(nextCycleContinuation(changed, 5, 5, first)).toEqual({
      run: false,
      because: "max_cycles_reached",
    });
  });
});
