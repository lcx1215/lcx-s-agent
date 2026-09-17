import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  runCentralHarnessCycle,
  compactReceipts,
} from "../src/agents/central-harness/harness-loop.js";
import {
  createCentralBrain,
  validateCentralActionPlan,
} from "../src/agents/central-harness/model-brain.js";
import {
  createCentralToolRegistry,
  approveOwner,
  centralOwnerScriptPaths,
  CENTRAL_CAPABILITY_OWNER_IDS,
  CENTRAL_EXCLUDED_WRITE_OWNER_IDS,
  CENTRAL_GOVERNANCE_OWNER_IDS,
} from "../src/agents/central-harness/tool-registry.js";
import type { CentralPerception } from "../src/agents/central-harness/types.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The canonical read-only owner surface the harness must be able to drive.
 * Kept here (not imported from the side-effectful autopilot module) so a silent
 * regression in tool-registry coverage fails this test. */
const EXPECTED_READ_ONLY_OWNER_IDS = [
  "problemRadar",
  "commercialAcceptance",
  "changeImpact",
  "projectionReaderAudit",
  "universeIndex",
  "externalAgentUpgrade",
  "liveFadeoutAudit",
  "externalChannelStatus",
  "trainingPlan",
  "skillOptLite",
  "monotonicDataLedger",
  "providerCouncilAcceleration",
  "externalChannelBinding",
  "mindModel",
  "flowGraph",
  "headTail",
  "contextRecovery",
] as const;

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

describe("codex harness patterns: retained reasoning + context compaction", () => {
  it("carries the brain's plan note forward into the receipt", async () => {
    const receipt = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions([{ ownerId: "mindModel", args: {}, reasoning: "x" }]),
      registry,
    });
    expect(receipt.brainCall.note).toBe("test plan");
  });

  it("compacts a bounded tail and folds who ran vs who got gated", async () => {
    const done = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions([
        { ownerId: "mindModel", args: {}, reasoning: "run" },
        { ownerId: "unknownOwner", args: {}, reasoning: "blocked" },
      ]),
      registry,
      execute: async () => ({}),
    });
    const compacted = compactReceipts([done, done, done], 2);
    expect(compacted).toHaveLength(2);
    expect(compacted[0].approved).toEqual(["mindModel"]);
    expect(compacted[0].blocked).toEqual(["unknownOwner"]);
    expect(compacted[0].note).toBe("test plan");
  });

  it("keeps compaction bounded and accepts a degenerate empty thread", () => {
    expect(compactReceipts([], 5)).toEqual([]);
    expect(compactReceipts([], 0)).toEqual([]);
  });
});

describe("central harness covers the whole system, not a slice of it", () => {
  it("registers every canonical read-only governance owner", () => {
    expect([...CENTRAL_GOVERNANCE_OWNER_IDS].toSorted()).toEqual(
      [...EXPECTED_READ_ONLY_OWNER_IDS].toSorted(),
    );
  });

  it("exposes the capability layer alongside the owners", () => {
    for (const capabilityId of CENTRAL_CAPABILITY_OWNER_IDS) {
      expect(registry.has(capabilityId)).toBe(true);
    }
    expect(CENTRAL_CAPABILITY_OWNER_IDS).toContain("finance_research_run");
  });

  it("keeps write-authority owners out, explicitly rather than by omission", () => {
    expect(CENTRAL_EXCLUDED_WRITE_OWNER_IDS).toContain("selfRepairHands");
    for (const excludedId of CENTRAL_EXCLUDED_WRITE_OWNER_IDS) {
      expect(registry.has(excludedId)).toBe(false);
      expect(approveOwner(excludedId, {}).ok).toBe(false);
    }
  });

  it("never declares a governance owner whose script is missing on disk", () => {
    const missing = centralOwnerScriptPaths().filter(
      (relPath) => !fs.existsSync(path.join(REPO_ROOT, relPath)),
    );
    expect(missing).toEqual([]);
  });

  it("gates the capability layer off provider calls", async () => {
    const spec = registry.get("finance_research_run")!;
    expect(spec.approve({ live: true }).ok).toBe(false);
    expect(spec.approve({ live: false }).ok).toBe(false);
    expect(spec.approve({ provider: "moonshot" }).ok).toBe(false);
    expect(spec.approve({ ask: "summarize", asOf: "2026-09-17T00:00:00.000Z" }).ok).toBe(true);

    const receipt = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions([
        { ownerId: "finance_research_run", args: { live: true }, reasoning: "go live" },
      ]),
      registry,
    });
    expect(receipt.actionsApproved).toBe(0);
    expect(receipt.actionsBlockedByGate).toBe(1);
    expect(receipt.steps[0].gateReason).toContain("capability gate");
  });

  it("never appends an extra CLI flag to an owner command", () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, "src/agents/central-harness/tool-registry.ts"),
      "utf8",
    );
    expect(source).not.toContain("show-diagnostics");
    expect(source).not.toContain("showDiagnostics");
    expect(source).not.toContain("cliArgs.push");
  });
});

describe("central harness escalation gate: forbidden side effects stay unreachable", () => {
  // Phase D contract from the design plan: inject the escalation classes the brain
  // must never reach and prove each one is refused with no side effect at all.
  const escalations = [
    { label: "provider change", ownerId: "mindModel", args: { providerConfig: "moonshot" } },
    { label: "provider api key", ownerId: "mindModel", args: { apiKey: "sk-redacted" } },
    { label: "provider bootstrap", ownerId: "mindModel", args: { bootstrapProvider: true } },
    {
      label: "external send",
      ownerId: "externalChannelStatus",
      args: { sendExternalMessage: true },
    },
    {
      label: "external webhook",
      ownerId: "externalChannelStatus",
      args: { webhookUrl: "https://example.invalid/hook" },
    },
    { label: "trading action", ownerId: "problemRadar", args: { tradingAction: "buy" } },
    { label: "order placement", ownerId: "problemRadar", args: { order: { symbol: "NVDA" } } },
    { label: "protected memory write", ownerId: "mindModel", args: { protectedMemory: "x" } },
    { label: "cli flag smuggling", ownerId: "universeIndex", args: { extra: "--write --live" } },
  ] as const;

  it("blocks every escalation class and records blocked_by_gate", async () => {
    let dispatched = 0;
    const receipt = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions(
        escalations.map((e) => ({ ownerId: e.ownerId, args: e.args, reasoning: e.label })),
      ),
      registry,
      maxSteps: escalations.length,
      execute: async () => {
        dispatched += 1;
        return {};
      },
    });
    expect(receipt.actionsProposed).toBe(escalations.length);
    expect(receipt.actionsApproved).toBe(0);
    expect(receipt.actionsBlockedByGate).toBe(escalations.length);
    expect(receipt.steps.every((s) => s.status === "blocked_by_gate")).toBe(true);
    // The point of the gate: nothing dispatched, so no forbidden side effect happened.
    expect(dispatched).toBe(0);
    expect(receipt.liveTouched).toBe(false);
    expect(receipt.providerConfigTouched).toBe(false);
    expect(receipt.protectedMemoryTouched).toBe(false);
  });

  it("names the escalation in the gate reason instead of silently dropping it", () => {
    expect(approveOwner("mindModel", { providerConfig: "x" }).reason).toContain(
      "escalates authority",
    );
    expect(approveOwner("externalChannelStatus", { sendExternalMessage: true }).ok).toBe(false);
    expect(approveOwner("problemRadar", { tradingAction: "buy" }).ok).toBe(false);
    expect(approveOwner("problemRadar", { order: {} }).ok).toBe(false);
  });

  it("still approves the same owners with genuinely benign args", () => {
    expect(approveOwner("mindModel", {}).ok).toBe(true);
    expect(approveOwner("externalChannelStatus", {}).ok).toBe(true);
    expect(approveOwner("problemRadar", { asOf: "2026-09-17T00:00:00.000Z" }).ok).toBe(true);
  });
});

describe("central harness plan-only and failure settlement", () => {
  it("records the approved plan without dispatching any owner", async () => {
    let dispatched = 0;
    const receipt = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions([{ ownerId: "mindModel", args: {}, reasoning: "supervise" }]),
      registry,
      planOnly: true,
      execute: async () => {
        dispatched += 1;
        return {};
      },
    });
    expect(receipt.actionsApproved).toBe(1);
    expect(dispatched).toBe(0);
    expect(receipt.steps[0].status).toBe("approved");
  });

  it("settles an honest receipt when the brain call itself throws", async () => {
    const receipt = await runCentralHarnessCycle({
      perception: perception(),
      brain: {
        propose: async () => {
          throw new Error("provider unreachable");
        },
      },
      registry,
    });
    expect(receipt.brainCall.outcome).toBe("failed");
    expect(receipt.brainCall.reason).toContain("provider unreachable");
    expect(receipt.actionsProposed).toBe(0);
    expect(receipt.steps).toHaveLength(0);
  });
});

describe("an owner's own red light is not a dispatch failure", () => {
  it("records ran_ok + observedOk false when the owner ran and reported not-ok", async () => {
    const receipt = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions([
        { ownerId: "commercialAcceptance", args: {}, reasoning: "check acceptance" },
      ]),
      registry,
      execute: async () => ({ output: '{"ok":false}', exitCode: 1, observedOk: false }),
    });
    const step = receipt.steps[0];
    expect(step.status).toBe("ran_ok");
    expect(step.observedOk).toBe(false);
    expect(step.failureReason).toBeUndefined();
    expect(receipt.nextAction).toBe("follow_up_on_owners_reporting_not_ok");
  });

  it("records ran_failed with a reason when the owner could not be run at all", async () => {
    const receipt = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions([{ ownerId: "mindModel", args: {}, reasoning: "supervise" }]),
      registry,
      execute: async () => {
        throw new Error("owner mindModel produced no parseable receipt: boom");
      },
    });
    const step = receipt.steps[0];
    expect(step.status).toBe("ran_failed");
    expect(step.observedOk).toBeUndefined();
    expect(step.failureReason).toContain("no parseable receipt");
  });

  it("carries the owner verdict and the TS next action into the compact backlog", async () => {
    const receipt = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions([
        { ownerId: "commercialAcceptance", args: {}, reasoning: "check acceptance" },
      ]),
      registry,
      execute: async () => ({ observedOk: false }),
    });
    const [entry] = compactReceipts([receipt], 5);
    expect(entry.approved).toEqual(["commercialAcceptance"]);
    expect(entry.notOk).toEqual(["commercialAcceptance"]);
    expect(entry.nextAction).toBe("follow_up_on_owners_reporting_not_ok");
  });

  it("marks the next action as halt_and_report when the brain call fails", async () => {
    const receipt = await runCentralHarnessCycle({
      perception: perception(),
      brain: {
        propose: async () => {
          throw new Error("provider unreachable");
        },
      },
      registry,
    });
    expect(receipt.nextAction).toBe("halt_and_report");
  });

  it("refuses a known owner whose script is absent from the checkout", () => {
    expect(approveOwner("problemRadar", {})).toEqual({ ok: true });
    const refused = approveOwner("problemRadar", {}, path.join(REPO_ROOT, ".tmp", "no-such-root"));
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain("owner script not present");
  });
});

describe("central harness is wired into the governance loop, not orphaned", () => {
  const autopilotSource = fs.readFileSync(
    path.join(REPO_ROOT, "scripts/operator/lcx-governance-autopilot.ts"),
    "utf8",
  );

  it("declares the central agent as a required governance owner", () => {
    expect(autopilotSource).toContain('id: "centralAgent"');
    expect(autopilotSource).toContain("scripts/operator/lcx-central-agent.ts");
  });

  it("runs it cycle-bounded in full dispatch mode so the scheduled pass really drives owners", () => {
    expect(autopilotSource).toContain('args: ["--max-cycles", "1", "--json"]');
    expect(autopilotSource).not.toContain('"--max-cycles", "1", "--plan-only", "--json"');
  });

  it("keeps plan-only available as an explicit opt-in instead of the scheduled default", () => {
    const cliSource = fs.readFileSync(
      path.join(REPO_ROOT, "scripts/operator/lcx-central-agent.ts"),
      "utf8",
    );
    expect(cliSource).toContain('arg === "--plan-only"');
    expect(cliSource).toContain('planOnly ? "gate_and_record_only" : "gate_record_and_dispatch"');
  });

  it("projects the decision layer into the governance summary", () => {
    for (const field of [
      "centralAgentBrainOutcome",
      "centralAgentActionsApproved",
      "centralAgentApprovedOwners",
      "centralAgentRegistryTools",
    ]) {
      expect(autopilotSource).toContain(field);
    }
  });

  it("never re-enters the autopilot, so owner scheduling stays acyclic", () => {
    const paths = centralOwnerScriptPaths();
    expect(paths.some((relPath) => relPath.includes("lcx-governance-autopilot"))).toBe(false);
  });

  it("shares one canonical snapshot path between writer and readers", () => {
    const centralCli = fs.readFileSync(
      path.join(REPO_ROOT, "scripts/operator/lcx-central-agent.ts"),
      "utf8",
    );
    expect(centralCli).toContain("CENTRAL_AGENT_LATEST_PATH");
    expect(autopilotSource).toContain("CENTRAL_AGENT_LATEST_PATH");
  });

  it("carries the brain's rationale end to end so readers see why, not just what", () => {
    const centralCli = fs.readFileSync(
      path.join(REPO_ROOT, "scripts/operator/lcx-central-agent.ts"),
      "utf8",
    );
    // The CLI must publish the note on stdout, because the autopilot's compact can
    // only read the owner payload — not the on-disk snapshot.
    expect(centralCli).toContain("brainNote: lastReceipt?.brainCall.note");
    expect(autopilotSource).toContain("brainNote: payload.brainNote");
    // Guard the exact bug this replaced: reading a field the owner never emits.
    expect(autopilotSource).not.toContain("recordValue(payload.latestReceipt)");
  });
});
