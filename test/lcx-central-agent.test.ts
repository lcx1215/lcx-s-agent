import { describe, expect, it } from "vitest";
import { runCentralHarnessCycle } from "../src/agents/central-harness/harness-loop.js";
import {
  createCentralBrain,
  validateCentralActionPlan,
} from "../src/agents/central-harness/model-brain.js";
import {
  createCentralToolRegistry,
  approveOwner,
} from "../src/agents/central-harness/tool-registry.js";
import type { CentralPerception } from "../src/agents/central-harness/types.js";

function perception(overrides: Partial<CentralPerception> = {}): CentralPerception {
  return {
    observedAt: "2026-09-16T00:00:00.000Z",
    ownerTotals: {},
    controlRoom: {},
    backlog: [],
    boundaries: ["research_only", "no_execution_authority", "llm_proposes_ts_gate_approves"],
    ...overrides,
  };
}

function brainWithActions(actions: unknown) {
  const plan = validateCentralActionPlan({ actions, note: "test plan" });
  return {
    propose: async () => ({ kind: "proposed" as const, plan, provider: "test", modelId: "test" }),
  };
}

const registry = createCentralToolRegistry();

describe("central agent harness gate", () => {
  it("blocks proposals for unknown / write-authority owners", async () => {
    const receipt = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions([{ ownerId: "unknownOwner", args: {}, reasoning: "x" }]),
      registry,
    });
    expect(receipt.actionsProposed).toBe(1);
    expect(receipt.actionsApproved).toBe(0);
    expect(receipt.actionsBlockedByGate).toBe(1);
    expect(receipt.steps[0].status).toBe("blocked_by_gate");
    expect(receipt.steps[0].gateReason).toContain("unknown owner");
  });

  it("blocks authority escalation keys even for a known owner", async () => {
    const receipt = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions([
        { ownerId: "problemRadar", args: { provider: "x" }, reasoning: "x" },
      ]),
      registry,
    });
    expect(receipt.actionsBlockedByGate).toBe(1);
    expect(receipt.steps[0].status).toBe("blocked_by_gate");
    expect(receipt.steps[0].gateReason).toContain("escalates authority");
  });

  it("approves read-only owners and runs them, recording ran_ok", async () => {
    const seen: string[] = [];
    const receipt = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions([
        { ownerId: "problemRadar", args: {}, reasoning: "scan" },
        { ownerId: "mindModel", args: {}, reasoning: "supervision" },
      ]),
      registry,
      execute: async (ownerId) => {
        seen.push(ownerId);
        return { output: `{"owner":"${ownerId}"}` };
      },
    });
    expect(receipt.actionsProposed).toBe(2);
    expect(receipt.actionsApproved).toBe(2);
    expect(receipt.actionsBlockedByGate).toBe(0);
    expect(receipt.steps.every((s) => s.status === "ran_ok")).toBe(true);
    expect(seen).toEqual(["problemRadar", "mindModel"]);
    expect(receipt.liveTouched).toBe(false);
    expect(receipt.providerConfigTouched).toBe(false);
    expect(receipt.protectedMemoryTouched).toBe(false);
  });

  it("records escaped authorization and a failed dispatch honestly", async () => {
    const receipt = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions([
        { ownerId: "problemRadar", args: { write: true }, reasoning: "attempt", boundary: [] },
        { ownerId: "flowGraph", args: {}, reasoning: "ok" },
      ]),
      registry,
      execute: async (ownerId) => {
        if (ownerId === "flowGraph") {
          throw new Error("boom");
        }
        return {};
      },
    });
    const blocked = receipt.steps.find((s) => s.status === "blocked_by_gate");
    const failed = receipt.steps.find((s) => s.status === "ran_failed");
    expect(blocked).toBeDefined();
    expect(failed).toBeDefined();
    expect(failed!.finishedAtMs).toBeTypeOf("number");
  });

  it("never fabricates inference when the brain reports blocked_no_provider", async () => {
    const brain = createCentralBrain(null as never, { adapterDisabled: true });
    const receipt = await runCentralHarnessCycle({ perception: perception(), brain, registry });
    expect(receipt.brainCall.outcome).toBe("blocked");
    expect(receipt.actionsProposed).toBe(0);
  });

  it("deterministic result when the brain proposes an empty plan", async () => {
    const receipt = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions([]),
      registry,
    });
    expect(receipt.actionsProposed).toBe(0);
    expect(receipt.steps).toHaveLength(0);
    expect(receipt.brainCall.outcome).toBe("completed");
  });
});

describe("approveOwner deterministic gate", () => {
  it("accepts a known read-only owner with benign args", () => {
    expect(approveOwner("universeIndex", {}).ok).toBe(true);
  });
  it("rejects --write flag smuggling in a string value", () => {
    expect(approveOwner("universeIndex", { extra: "--write --live" }).ok).toBe(false);
  });
  it("rejects unknown owners", () => {
    expect(approveOwner("providerCouncil", {}).ok).toBe(false);
  });
  it("rejects authority keywords", () => {
    for (const key of ["trade", "live", "senders", "execute", "protected"]) {
      expect(approveOwner("problemRadar", { [key]: true }).ok).toBe(false);
    }
  });
});
