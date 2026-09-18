import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectGovernanceDigest } from "../scripts/operator/lcx-central-agent.js";
import {
  runCentralHarnessCycle,
  boundPerception,
  compactReceipts,
  resumableReceipts,
  CENTRAL_BACKLOG_MAX_OUTCOMES,
  CENTRAL_PERCEPTION_BUDGET_BYTES,
  CENTRAL_PERCEPTION_KEY_BUDGET_BYTES,
  CENTRAL_STEP_OUTCOME_BUDGET_BYTES,
} from "../src/agents/central-harness/harness-loop.js";
import {
  buildCentralBrainPrompt,
  createCentralBrain,
  validateCentralActionPlan,
} from "../src/agents/central-harness/model-brain.js";
import { resolveLatestPointer, runSnapshotPath } from "../src/agents/central-harness/run-store.js";
import {
  createCentralToolRegistry,
  approveOwner,
  centralOwnerScriptPaths,
  ownerObservedOk,
  CENTRAL_CAPABILITY_OWNER_IDS,
  CENTRAL_EXCLUDED_WRITE_OWNER_IDS,
  CENTRAL_GOVERNANCE_OWNER_IDS,
} from "../src/agents/central-harness/tool-registry.js";
import type { CentralPerception, CentralRunReceipt } from "../src/agents/central-harness/types.js";

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

  it("names the real adapter error instead of claiming configuration is absent", async () => {
    // A config with no resolvable provider/model: the adapter throws, and that
    // throw is the only evidence of why the cycle decided nothing.
    const brain = createCentralBrain({
      agents: { defaults: { model: "not-a-provider-ref" } },
    } as never);
    const receipt = await runCentralHarnessCycle({ perception: perception(), brain, registry });
    expect(receipt.brainCall.outcome).toBe("blocked");
    expect(receipt.brainCall.reason).toContain("no usable finance model");
    expect(receipt.brainCall.reason).toContain("explicit provider/model");
    // The unverified claim is reserved for the case that actually has no adapter.
    expect(receipt.brainCall.reason).not.toContain("no configurable finance provider/model");
  });

  it("keeps the honest generic reason when the adapter is deliberately disabled", async () => {
    const brain = createCentralBrain(null as never, { adapterDisabled: true });
    const receipt = await runCentralHarnessCycle({ perception: perception(), brain, registry });
    expect(receipt.brainCall.reason).toBe(
      "no configurable finance provider/model available for brain inference",
    );
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
    // The whole-system claim includes the real book: the brain must be able to
    // see what is held (per-asset state), not only counts of what ran.
    expect(CENTRAL_CAPABILITY_OWNER_IDS).toContain("finance_position_ledger_read");
    // The whole-system claim also includes the learning loop: the brain must be
    // able to fold pending review notes into durable cards, not only read them.
    expect(CENTRAL_CAPABILITY_OWNER_IDS).toContain("learning_distill");
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

  it("reads the real per-asset book through the ledger capability, gated as read-only", async () => {
    const spec = registry.get("finance_position_ledger_read")!;
    expect(spec.approve({ asOf: "2026-09-17T00:00:00.000Z" }).ok).toBe(true);
    expect(spec.approve({ order: { symbol: "NVDA" } }).ok).toBe(false);
    expect(spec.approve({ trade: true }).ok).toBe(false);
    expect(spec.approve({ write: true }).ok).toBe(false);

    // Dispatch against an absent ledger directory: the capability must run, hand
    // back a receipt that names the absent book (not an empty portfolio), and the
    // harness must record ran_ok — "it ran and reported" ≠ "it crashed".
    const ledgerDir = path.join(os.tmpdir(), `lcx-central-test-ledger-${process.pid}`);
    const receipt = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions([
        {
          ownerId: "finance_position_ledger_read",
          args: { directory: ledgerDir },
          reasoning: "see what the book holds",
        },
      ]),
      registry,
    });
    expect(receipt.actionsProposed).toBe(1);
    expect(receipt.actionsBlockedByGate).toBe(0);
    const step = receipt.steps[0];
    expect(step.status).toBe("ran_ok");
    // The tool's leading fields survive the digest; the tail (notTouched list,
    // paths) may be budget-dropped by design — the gate above already proves the
    // write surface is unreachable through this capability.
    expect(step.outcome?.status).toBe("absent");
    expect(step.outcome?.reason).toBe("finance_position_ledger_absent");
    expect(receipt.liveTouched).toBe(false);
    expect(receipt.providerConfigTouched).toBe(false);
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

  it("distills pending learning notes through the learning capability, gated as local-only", async () => {
    const spec = registry.get("learning_distill")!;
    const memoryDir = path.join(os.tmpdir(), `lcx-central-test-learning-${process.pid}`);
    const stateDir = path.join(os.tmpdir(), `lcx-central-test-learning-state-${process.pid}`);
    await fsp.mkdir(memoryDir, { recursive: true });
    await fsp.writeFile(
      path.join(memoryDir, "2026-09-10-review-harness.md"),
      [
        "# Learning Review: 2026-09-10 12:00:00 UTC",
        "",
        "- **Session Key**: sk-harness",
        "- **Session ID**: sid-harness",
        "- **Topic**: coding-and-systems",
        "",
        "## Review Note",
        "- mistake_pattern: a mistake",
        "- core_principle: a principle",
        "- micro_drill: a drill",
        "",
      ].join("\n"),
    );

    // The gate treats this as a local-only capability: a write-shaped arg is
    // refused, a plain scan is accepted.
    expect(spec.approve({ memoryDir, stateDir, windowDays: 366 }).ok).toBe(true);
    expect(spec.approve({ write: true }).ok).toBe(false);
    expect(spec.approve({ order: { symbol: "NVDA" } }).ok).toBe(false);

    const receipt = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions([
        {
          ownerId: "learning_distill",
          args: { memoryDir, stateDir, windowDays: 366 },
          reasoning: "fold pending learning notes into cards",
        },
      ]),
      registry,
    });
    expect(receipt.actionsProposed).toBe(1);
    expect(receipt.actionsBlockedByGate).toBe(0);
    const step = receipt.steps[0];
    expect(step.status).toBe("ran_ok");
    // The full cards array and the summary tail are budget-dropped from the
    // 512-byte step digest by design (named in outcomeDroppedKeys); the leading
    // status + pending counts survive, and the card fields themselves are covered
    // by the tool's own unit tests.
    expect(step.outcome?.status).toBe("distilled");
    expect(step.outcome?.pending).toBe(1);
    expect(receipt.liveTouched).toBe(false);
    expect(receipt.providerConfigTouched).toBe(false);
    expect(receipt.protectedMemoryTouched).toBe(false);
  });

  it("dispatches capability steps in plan-only mode but records owners without running them", async () => {
    const memoryDir = path.join(os.tmpdir(), `lcx-central-test-planonly-${process.pid}`);
    const stateDir = path.join(os.tmpdir(), `lcx-central-test-planonly-state-${process.pid}`);
    await fsp.mkdir(memoryDir, { recursive: true });
    await fsp.writeFile(
      path.join(memoryDir, "2026-09-10-review-planonly.md"),
      [
        "# Learning Review: 2026-09-10 12:00:00 UTC",
        "",
        "- **Session Key**: sk-hourly",
        "- **Session ID**: sid-hourly",
        "- **Topic**: coding-and-systems",
        "",
        "## Review Note",
        "- mistake_pattern: a mistake",
        "- core_principle: a principle",
        "- micro_drill: a drill",
        "",
      ].join("\n"),
    );

    const receipt = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions([
        { ownerId: "contextRecovery", args: {}, reasoning: "scheduled governance owner" },
        {
          ownerId: "learning_distill",
          args: { memoryDir, stateDir, windowDays: 366 },
          reasoning: "drain the learning workflow in the hourly pass",
        },
      ]),
      registry,
      planOnly: true,
      capabilityOwnerIds: new Set(CENTRAL_CAPABILITY_OWNER_IDS),
    });
    expect(receipt.actionsProposed).toBe(2);
    expect(receipt.actionsBlockedByGate).toBe(0);

    // The governance owner is recorded but NOT dispatched: the autopilot runs it
    // in parallel, so spawning it here would double-run the pass.
    const ownerStep = receipt.steps.find((step) => step.ownerId === "contextRecovery");
    expect(ownerStep?.status).toBe("approved");

    // The capability has no autopilot equivalent, so the plan-only pass really
    // dispatches it — otherwise its surface would never drain.
    const capabilityStep = receipt.steps.find((step) => step.ownerId === "learning_distill");
    expect(capabilityStep?.status).toBe("ran_ok");
    expect(capabilityStep?.outcome?.status).toBe("distilled");
    expect(capabilityStep?.outcome?.pending).toBe(1);
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
    // The dispatch ternary is formatted multi-line and reads `meta.planOnly` in
    // the writeLatest path, so match on the formatted shape instead of a
    // single-line substring; the contract is that plan-only maps to the
    // capability-draining mode.
    expect(cliSource).toMatch(
      /\n\s*dispatchMode: meta\.planOnly\n\s*\? "gate_record_owners_plus_dispatch_capabilities"\n\s*: "gate_record_and_dispatch",/u,
    );
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

function receipt(overrides: Partial<CentralRunReceipt> = {}): CentralRunReceipt {
  return {
    schemaVersion: "lcx_central_agent_v1",
    runId: "central-0-1",
    observedAt: "2026-09-17T00:00:00.000Z",
    actionsProposed: 0,
    actionsApproved: 0,
    actionsBlockedByGate: 0,
    steps: [],
    boundaries: ["research_only"],
    brainCall: { provider: "test", modelId: "test", outcome: "completed" },
    nextAction: "continue",
    contextBudget: {
      budgetBytes: CENTRAL_PERCEPTION_BUDGET_BYTES,
      injectedBytes: 120,
      overBudget: false,
      droppedSections: [],
    },
    liveTouched: false,
    providerConfigTouched: false,
    protectedMemoryTouched: false,
    ...overrides,
  };
}

describe("terminal cycles are evidence, not resumable context", () => {
  it("resumes only cycles whose brain call completed", () => {
    const completed = receipt({ runId: "a" });
    const failed = receipt({
      runId: "b",
      brainCall: { provider: "", modelId: "", outcome: "failed", reason: "provider unreachable" },
      nextAction: "halt_and_report",
    });
    const blocked = receipt({
      runId: "c",
      brainCall: { provider: "", modelId: "", outcome: "blocked", reason: "no_provider" },
      nextAction: "restore_brain_provider_then_retry",
    });
    const skipped = receipt({
      runId: "d",
      brainCall: { provider: "", modelId: "", outcome: "skipped", reason: "brain_disabled" },
    });
    expect(resumableReceipts([completed, failed, blocked, skipped]).map((r) => r.runId)).toEqual([
      "a",
    ]);
  });

  it("does not turn a failed cycle into a compacted backlog entry for the next turn", () => {
    const failed = receipt({
      runId: "b",
      brainCall: { provider: "", modelId: "", outcome: "failed", reason: "provider unreachable" },
      nextAction: "halt_and_report",
    });
    expect(compactReceipts(resumableReceipts([failed]), 10)).toEqual([]);
    // The same cycle stays visible as evidence: dropping it from context is not deleting it.
    expect(compactReceipts([failed], 10)[0].brainOutcome).toBe("failed");
  });
});

describe("one snapshot per cycle, and a pointer that never moves backwards", () => {
  it("keeps the pointer on the snapshot that observed last, not the one that finished last", () => {
    const manual = receipt({ runId: "manual", observedAt: "2026-09-17T00:00:00.000Z" });
    const hourly = receipt({ runId: "hourly", observedAt: "2026-09-17T01:00:00.000Z" });

    const superseded = resolveLatestPointer(
      { latestReceipt: hourly, latestRunPath: "/runs/hourly.json" },
      manual,
      "/runs/manual.json",
    );
    expect(superseded.superseded).toBe(true);
    expect(superseded.heldReceipt?.runId).toBe("hourly");
    expect(superseded.heldRunPath).toBe("/runs/hourly.json");
    expect(superseded.heldRunId).toBe("hourly");

    const taken = resolveLatestPointer(
      { latestReceipt: manual, latestRunPath: "/runs/manual.json" },
      hourly,
      "/runs/hourly.json",
    );
    expect(taken.superseded).toBe(false);
    expect(taken.heldReceipt?.runId).toBe("hourly");
    expect(taken.heldRunPath).toBe("/runs/hourly.json");
  });

  it("refreshes the snapshot on a zero-cycle run without erasing the last real receipt", () => {
    const pointer = resolveLatestPointer(
      { latestReceipt: receipt({ runId: "keep" }), latestRunPath: "/runs/keep.json" },
      undefined,
      undefined,
    );
    expect(pointer.superseded).toBe(false);
    expect(pointer.heldReceipt?.runId).toBe("keep");
    expect(pointer.heldRunPath).toBe("/runs/keep.json");
  });

  it("names exactly one snapshot file per runId", () => {
    expect(runSnapshotPath("/state/lcx-central-agent-runs", "central-0-1")).toBe(
      "/state/lcx-central-agent-runs/central-0-1.json",
    );
  });
});

describe("injected context is bounded by bytes, not by entry count", () => {
  /** A control-room snapshot the size of the live one: the bulky keys dominate. */
  function bulkyControlRoom(): Record<string, unknown> {
    return {
      schemaVersion: "lcx_control_room_v1",
      kind: "control_room",
      governance: { raw: "g".repeat(185_000) },
      localFailureTrace: { raw: "f".repeat(34_000) },
      ownerControlMap: { raw: "m".repeat(24_000) },
      ownerBrief: { raw: "b".repeat(9_800) },
      views: { ok: 3 },
    };
  }

  it("drops the oversized keys and names each one with the bytes it cost", () => {
    const { perception: bounded, report } = boundPerception(
      perception({ controlRoom: bulkyControlRoom() }),
    );
    expect(Buffer.byteLength(JSON.stringify(bounded.controlRoom))).toBeLessThanOrEqual(
      CENTRAL_PERCEPTION_BUDGET_BYTES,
    );
    // Small keys survive, so the brain still sees that a control room exists.
    expect(bounded.controlRoom.views).toEqual({ ok: 3 });
    expect(bounded.controlRoom.schemaVersion).toBe("lcx_control_room_v1");
    const [dropped] = report.droppedSections;
    expect(dropped.section).toBe("controlRoom");
    expect(dropped.droppedKeys.map((entry) => entry.key)).toEqual([
      "governance",
      "localFailureTrace",
      "ownerControlMap",
      "ownerBrief",
    ]);
    expect(dropped.droppedKeys[0].bytes).toBeGreaterThan(180_000);
    expect(dropped.originalBytes).toBeGreaterThan(250_000);
    expect(report.injectedBytes).toBeLessThanOrEqual(CENTRAL_PERCEPTION_BUDGET_BYTES);
    expect(report.overBudget).toBe(false);
  });

  it("never truncates the state the decision needs to fit the budget", () => {
    const ownerTotals = { problemRadar: { ok: true, status: "ran_ok" } };
    const backlog = [
      { atMs: 1, approved: ["mindModel"], blocked: [], notOk: [], nextAction: "continue" },
    ];
    const { perception: bounded } = boundPerception(
      perception({ controlRoom: bulkyControlRoom(), ownerTotals, backlog }),
    );
    expect(bounded.ownerTotals).toEqual(ownerTotals);
    expect(bounded.backlog).toEqual(backlog);
    expect(bounded.boundaries).toEqual(perception().boundaries);
    expect(bounded.observedAt).toBe(perception().observedAt);
  });

  it("bounds the prompt actually built for the model, not just a copy", () => {
    const unbounded = buildCentralBrainPrompt(perception({ controlRoom: bulkyControlRoom() }));
    const { perception: bounded } = boundPerception(
      perception({ controlRoom: bulkyControlRoom() }),
    );
    const boundedPrompt = buildCentralBrainPrompt(bounded);
    expect(Buffer.byteLength(unbounded)).toBeGreaterThan(250_000);
    expect(Buffer.byteLength(boundedPrompt)).toBeLessThanOrEqual(
      CENTRAL_PERCEPTION_BUDGET_BYTES + 1_500, // + the fixed instruction block
    );
    // The reduction has to be real, not a rounding artefact.
    expect(Buffer.byteLength(boundedPrompt) * 50).toBeLessThan(Buffer.byteLength(unbounded));
  });

  it("hands the brain the bounded perception and records the report on the receipt", async () => {
    let seenControlRoom: Readonly<Record<string, unknown>> = {};
    const receiptFromCycle = await runCentralHarnessCycle({
      perception: perception({ controlRoom: bulkyControlRoom() }),
      brain: {
        propose: async (given) => {
          seenControlRoom = given.controlRoom;
          return { kind: "blocked_no_provider", reason: "test" };
        },
      },
      registry,
    });
    expect(seenControlRoom.governance).toBeUndefined();
    expect(receiptFromCycle.contextBudget.injectedBytes).toBeLessThanOrEqual(
      CENTRAL_PERCEPTION_BUDGET_BYTES,
    );
    expect(receiptFromCycle.contextBudget.droppedSections[0].droppedKeys[0].key).toBe("governance");
  });

  it("is idempotent, so re-bounding an already bounded perception changes nothing", () => {
    const once = boundPerception(perception({ controlRoom: bulkyControlRoom() }));
    const twice = boundPerception(once.perception);
    expect(twice.perception).toEqual(once.perception);
    expect(twice.report.droppedSections).toEqual([]);
  });

  it("reports overBudget honestly instead of cutting the decision state", () => {
    const hugeBacklog = Array.from({ length: 4 }, () => ({ note: "n".repeat(4_000) }));
    const { perception: bounded, report } = boundPerception(
      perception({ backlog: hugeBacklog, controlRoom: bulkyControlRoom() }),
      CENTRAL_PERCEPTION_KEY_BUDGET_BYTES,
    );
    expect(report.overBudget).toBe(true);
    expect(bounded.backlog).toHaveLength(4);
    expect(bounded.controlRoom).toEqual({});
  });

  it("keeps a degenerate empty control room free of a dropped-section report", () => {
    const { report } = boundPerception(perception());
    expect(report.droppedSections).toEqual([]);
    expect(report.overBudget).toBe(false);
  });
});

describe("central agent CLI persists evidence a reader can walk back to", () => {
  function runCli(userHome: string) {
    return spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(REPO_ROOT, "scripts/operator/lcx-central-agent.ts"),
        "--dry-run",
        "--max-cycles",
        "1",
        "--json",
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, LCX_USER_HOME: userHome },
        timeout: 60_000,
        input: "",
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  }

  it("writes one immutable snapshot per cycle and points latest at it", async () => {
    const userHome = await fsp.mkdtemp(path.join(os.tmpdir(), "lcx-central-home-"));
    const stateDir = path.join(userHome, ".openclaw", "workspace", "state");
    const runsDir = path.join(stateDir, "lcx-central-agent-runs");
    try {
      const first = runCli(userHome);
      expect(first.status).toBe(0);
      const firstSummary = JSON.parse(first.stdout.trim()) as {
        runs: number;
        latestRunPath: string | null;
      };
      expect(firstSummary.runs).toBe(1);
      expect(await fsp.readdir(runsDir)).toHaveLength(1);

      const latest = JSON.parse(
        await fsp.readFile(path.join(stateDir, "lcx-central-agent-latest.json"), "utf8"),
      ) as { runsDir: string; latestRunId: string | null; latestRunPath: string | null };
      expect(latest.runsDir).toBe(runsDir);
      expect(latest.latestRunPath).toBe(firstSummary.latestRunPath);
      expect(path.basename(latest.latestRunPath ?? "")).toBe(latest.latestRunId + ".json");

      // Second pass: the dry-run brain never completes, so the first cycle is now in
      // the resume window but must not be inherited as context.
      const second = runCli(userHome);
      expect(second.status).toBe(0);
      const secondSummary = JSON.parse(second.stdout.trim()) as {
        resumeDroppedNonDecisionCycles: number;
      };
      expect(secondSummary.resumeDroppedNonDecisionCycles).toBe(1);
      expect(await fsp.readdir(runsDir)).toHaveLength(2);
    } finally {
      await fsp.rm(userHome, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps the summary and the per-cycle snapshot when the jsonl cannot be written", async () => {
    // Fault injection, not a hypothetical: before the write was made fail-open, an
    // unwritable jsonl path exited 1 with 0 bytes on stdout and destroyed the whole
    // cycle's evidence. A completed cycle must not become unparseable because one
    // copy of its record could not be persisted.
    const userHome = await fsp.mkdtemp(path.join(os.tmpdir(), "lcx-central-home-"));
    const stateDir = path.join(userHome, ".openclaw", "workspace", "state");
    const runsDir = path.join(stateDir, "lcx-central-agent-runs");
    const logPath = path.join(
      userHome,
      ".openclaw",
      "workspace",
      "logs",
      "lcx-central-agent-log-latest.jsonl",
    );
    try {
      await fsp.mkdir(logPath, { recursive: true }); // a directory: open(.., "a") is EISDIR
      const result = runCli(userHome);
      expect(result.status).toBe(0);
      const summary = JSON.parse(result.stdout.trim()) as {
        runs: number;
        evidenceComplete: boolean;
        evidenceWriteFailures: { target: string; reason: string }[];
        latestRunPath: string | null;
      };
      expect(summary.runs).toBe(1);
      expect(summary.evidenceComplete).toBe(false);
      expect(summary.evidenceWriteFailures.map((failure) => failure.target)).toEqual(["jsonl"]);
      expect(summary.evidenceWriteFailures[0].reason).toContain("EISDIR");
      // The cycle's evidence survives through the copy that did land.
      expect(summary.latestRunPath).not.toBeNull();
      expect(await fsp.readdir(runsDir)).toHaveLength(1);
      const latest = JSON.parse(
        await fsp.readFile(path.join(stateDir, "lcx-central-agent-latest.json"), "utf8"),
      ) as { evidenceComplete: boolean; contextBudget: { injectedBytes: number } | null };
      expect(latest.evidenceComplete).toBe(false);
      expect(latest.contextBudget?.injectedBytes).toBeLessThanOrEqual(
        CENTRAL_PERCEPTION_BUDGET_BYTES,
      );
    } finally {
      await fsp.rm(userHome, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("governance digest folds the hour's verdict into the budgeted brain view", () => {
  const governanceState = {
    ok: false,
    checkedAt: "2026-09-18T08:05:27.701Z",
    runReceipt: {
      status: "blocked",
      nextAction:
        "training_eval_runtime_cluster: Hold promotion and repair eval runtime before judging the candidate.",
    },
    summary: {
      releaseBlocked: true,
      structuralOwnerFailures: ["commercialAcceptance", "externalChannelStatus"],
      failedGates: ["lcx-external-channel-status_owner_unavailable"],
      blockedGates: ["external_channel_not_bound"],
    },
    multiAgentPatternShadow: {
      experimentId: "multi-agent-pattern-shadow-replay",
      trialDecision: "unverified",
      completedAt: "2026-09-16T05:34:25.988Z",
    },
    globalEvidenceProjectionReader: {
      adapterId: "governance-autopilot",
      readStatus: "stale",
      blocked: true,
    },
  };

  it("projects the verdict the raw 190KB section would have drowned, under the key budget", () => {
    const digest = projectGovernanceDigest(governanceState);
    expect(digest.status).toBe("present");
    expect(digest.cycleStatus).toBe("blocked");
    expect(digest.nextAction).toContain("training_eval_runtime_cluster");
    expect(digest.releaseBlocked).toBe(true);
    expect(digest.ownerFailures).toEqual(["commercialAcceptance", "externalChannelStatus"]);
    expect(digest.blockedGates).toEqual(["external_channel_not_bound"]);
    expect(digest.shadow.trialDecision).toBe("unverified");
    expect(digest.projectionReader).toEqual({
      adapterId: "governance-autopilot",
      readStatus: "stale",
      blocked: true,
    });
    expect(Buffer.byteLength(JSON.stringify(digest))).toBeLessThan(
      CENTRAL_PERCEPTION_KEY_BUDGET_BYTES,
    );
  });

  it("names a missing governance surface instead of pretending the pass ran", () => {
    expect(projectGovernanceDigest({})).toEqual({
      status: "unavailable",
      reason: "governance_state_missing",
    });
  });

  it("survives the budget while the raw section is still named as dropped", () => {
    const { perception: bounded, report } = boundPerception(
      perception({
        controlRoom: {
          schemaVersion: "lcx_control_room_v1",
          governance: { raw: "g".repeat(185_000) },
          governanceDigest: projectGovernanceDigest(governanceState),
        },
      }),
    );
    const digest = bounded.controlRoom.governanceDigest as Readonly<Record<string, unknown>>;
    expect(digest.status).toBe("present");
    expect(bounded.controlRoom.governance).toBeUndefined();
    const [dropped] = report.droppedSections;
    expect(dropped.droppedKeys.map((entry) => entry.key)).toEqual(["governance"]);
  });
});

describe("the loop feeds the owner's own output back to the next decision", () => {
  it("carries the owner's receipt into the backlog instead of only its name", async () => {
    const cycle = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions([
        { ownerId: "commercialAcceptance", args: {}, reasoning: "check acceptance" },
      ]),
      registry,
      execute: async () => ({
        output: '{"ok":false,"summary":{"failed":2}}',
        exitCode: 1,
        observedOk: false,
        receipt: { ok: false, summary: { failed: 2 } },
      }),
    });
    const [entry] = compactReceipts([cycle], 5);
    expect(entry.notOk).toEqual(["commercialAcceptance"]);
    expect(entry.outcomes).toHaveLength(1);
    expect(entry.outcomes[0].outcome).toEqual({ ok: false, summary: { failed: 2 } });
    // The envelope's raw stdout is what a byte budget drops first, so digesting
    // the envelope instead of the receipt would hand the brain nothing at all.
    expect(entry.outcomes[0].outcome).not.toHaveProperty("output");
  });

  it("spends no digest on owners that came back cleanly green", async () => {
    const cycle = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions([{ ownerId: "problemRadar", args: {}, reasoning: "scan" }]),
      registry,
      execute: async () => ({
        output: "{}",
        exitCode: 0,
        observedOk: true,
        receipt: { ok: true },
      }),
    });
    const [entry] = compactReceipts([cycle], 5);
    expect(entry.approved).toEqual(["problemRadar"]);
    expect(entry.outcomes).toEqual([]);
  });

  it("carries the gate's reason, not only the blocked id", async () => {
    const cycle = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions([{ ownerId: "unknownOwner", args: {}, reasoning: "x" }]),
      registry,
    });
    const [entry] = compactReceipts([cycle], 5);
    expect(entry.blocked).toEqual(["unknownOwner"]);
    expect(entry.outcomes[0]).toMatchObject({
      ownerId: "unknownOwner",
      status: "blocked_by_gate",
    });
    expect(entry.outcomes[0].reason).toContain("unknown owner");
  });

  it("bounds the digest per step and names the keys it left out", async () => {
    const cycle = await runCentralHarnessCycle({
      perception: perception(),
      brain: brainWithActions([{ ownerId: "mindModel", args: {}, reasoning: "supervise" }]),
      registry,
      execute: async () => ({
        observedOk: false,
        receipt: { ok: false, small: 1, huge: "x".repeat(4_000) },
      }),
    });
    const step = cycle.steps[0];
    expect(Buffer.byteLength(JSON.stringify(step.outcome))).toBeLessThanOrEqual(
      CENTRAL_STEP_OUTCOME_BUDGET_BYTES,
    );
    expect(step.outcome).toEqual({ ok: false, small: 1 });
    expect(step.outcomeDroppedKeys).toEqual(["huge"]);
  });

  it("keeps the digest on the newest cycle and the reason on older ones", async () => {
    const run = (runId: string, detail: string) =>
      runCentralHarnessCycle({
        perception: perception(),
        runId,
        brain: brainWithActions([{ ownerId: "mindModel", args: {}, reasoning: "supervise" }]),
        registry,
        execute: async () => ({ observedOk: false, receipt: { ok: false, detail } }),
      });
    const older = await run("older", "first");
    const newer = await run("newer", "second");
    const entries = compactReceipts([older, newer], 5);
    expect(entries[0].outcomes[0].status).toBe("ran_ok");
    expect(entries[0].outcomes[0].outcome).toBeUndefined();
    expect(entries[1].outcomes[0].outcome).toEqual({ ok: false, detail: "second" });
  });

  it("names how many reasons did not fit the per-entry cap", () => {
    const steps = Array.from({ length: CENTRAL_BACKLOG_MAX_OUTCOMES + 2 }, (_, index) => ({
      stepId: `s${index}`,
      ownerId: `owner${index}`,
      args: {},
      status: "ran_failed" as const,
      failureReason: `boom ${index}`,
    }));
    const [entry] = compactReceipts([receipt({ steps })], 5);
    expect(entry.outcomes).toHaveLength(CENTRAL_BACKLOG_MAX_OUTCOMES);
    expect(entry.outcomesOmitted).toBe(2);
  });
});

describe("the owner's own verdict outranks the exit status", () => {
  it("prefers a stated verdict over the exit status, in both directions", () => {
    expect(ownerObservedOk({ ok: false }, true)).toBe(false);
    expect(ownerObservedOk({ ok: true }, false)).toBe(true);
  });

  it("falls back to the exit status only when the receipt states no verdict", () => {
    expect(ownerObservedOk({ summary: {} }, true)).toBe(true);
    expect(ownerObservedOk({ summary: {} }, false)).toBe(false);
    expect(ownerObservedOk(undefined, true)).toBe(true);
    expect(ownerObservedOk(undefined, false)).toBe(false);
  });
});
