import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  LCX_ONTOLOGY_REGISTRY,
  LCX_ONTOLOGY_WORKFLOW_NODE_IDS,
} from "../../shared/lcx-ontology.js";
import { recordAgentArtifact } from "../artifact-result-recording.js";
import { declareFinanceStrategyRule } from "../finance-strategy-rule-ledger.js";
import {
  compactReceipts,
  runCentralHarnessCycle,
  type CompactBacklogEntry,
} from "./harness-loop.js";
import type { CentralBrain } from "./model-brain.js";
import { compactRuleHandoff, diagnoseCentralRuleHandoff } from "./rule-handoff.js";
import { createCentralToolRegistry } from "./tool-registry.js";
import type { CentralActionPlan, CentralPerception, CentralRunReceipt } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const id = `artifact-${"a".repeat(64)}`;
const sourceSha256 = "b".repeat(64);
const field = "/value/rules/0/body/frozenRule/exit";
const evidenceUse = {
  artifactId: id,
  sourceSha256,
  field,
  effect: "retain" as const,
  reason: "Exit at session close; retain this exit condition.",
};
function perception(): CentralPerception {
  return {
    observedAt: "2026-10-10T08:00:00Z",
    controlRoom: {},
    ownerTotals: {},
    boundaries: ["no_execution_authority"],
    backlog: [
      {
        outcomes: [
          {
            ownerId: "artifact_memory_recall",
            status: "ran_ok",
            args: { action: "read", id, field },
            outcome: {
              action: "read",
              artifactId: id,
              field,
              sourceSha256,
              available: true,
              sourceObservedAt: "2026-10-09T00:00:00Z",
              selectedValue: "Exit at session close",
              selectionScope: { accountId: "A" },
            },
          },
        ],
      },
    ],
  };
}
const brain = (plan: CentralActionPlan): CentralBrain => ({
  propose: async () => ({ kind: "proposed", provider: "fixture", modelId: "offline", plan }),
});
async function cycle(p = perception(), plan: CentralActionPlan = { actions: [], note: "done" }) {
  return runCentralHarnessCycle({ perception: p, registry: new Map(), brain: brain(plan) });
}

describe("finance rule handoff diagnostics in original receipts", () => {
  it("uses canonical nodes and existing owners without changing relation/state contracts", async () => {
    const contract = LCX_ONTOLOGY_REGISTRY.financeRuleHandoff;
    expect(contract.stages).toHaveLength(5);
    for (const stage of contract.stages) {
      expect(LCX_ONTOLOGY_WORKFLOW_NODE_IDS).toContain(stage.node);
      await expect(
        fs.access(path.resolve(import.meta.dirname, "../../..", stage.owner)),
      ).resolves.toBeUndefined();
    }
    expect(LCX_ONTOLOGY_REGISTRY.relationTypes).toHaveLength(15);
  });
  it("finds an unattributed judgment even when dispatch itself is green", async () => {
    const receipt = await cycle();
    expect(receipt.brainCall.outcome).toBe("completed");
    expect(receipt.ruleHandoff?.observations[0]).toMatchObject({
      status: "judgment_unattributed",
      owner: "src/agents/central-harness/model-brain.ts",
      artifactId: id,
      field,
    });
    expect(receipt.ruleHandoff?.semanticAdoption).toBe("not_proven");
    expect(compactReceipts([receipt], 10)[0].ruleHandoff).toEqual(
      compactRuleHandoff(receipt.ruleHandoff!),
    );
  });
  it.each(["hash", "account", "future", "missing", "dropped"])(
    "points at the %s evidence break instead of claiming adoption",
    async (fault) => {
      let p = perception();
      const read = (p.backlog[0].outcomes as CompactBacklogEntry["outcomes"])[0];
      const use = { ...evidenceUse, ...(fault === "account" ? { scope: { accountId: "B" } } : {}) };
      if (fault === "hash") {
        use.sourceSha256 = "c".repeat(64);
      }
      if (fault === "future") {
        p = { ...p, observedAt: "2026-10-08T00:00:00Z" };
      }
      if (fault === "missing") {
        p = { ...p, backlog: [] };
      }
      if (fault === "dropped") {
        p = { ...p, backlog: [{ outcomes: [{ ...read, outcomeDroppedKeys: ["selectedValue"] }] }] };
      }
      const receipt = await cycle(p, { actions: [], note: "claim", evidenceUse: [use] });
      expect(receipt.ruleHandoff?.observations[0].status).toBe(
        fault === "dropped" ? "unresolved" : "reference_rejected",
      );
      expect(receipt.ruleHandoff?.semanticAdoption).toBe("not_proven");
      expect(receipt.ontologyEdges).toEqual([]);
    },
  );
  it("keeps a legitimate execution block distinct from a broken rule handoff", async () => {
    const receipt = await cycle(perception(), {
      actions: [{ ownerId: "finance_live_execution" }],
      note: "broker unknown; source/quality failed",
      evidenceUse: [
        {
          ...evidenceUse,
          effect: "unresolved",
          reason: "Missing debt_to_penny and broker readback; keep stopped.",
        },
      ],
    });
    expect(receipt.ruleHandoff).toMatchObject({
      gate: "blocked",
      semanticAdoption: "not_proven",
      observations: [{ status: "unresolved" }],
    });
    expect(receipt.steps[0].status).toBe("blocked_by_gate");
    expect(receipt.liveTouched).toBe(false);
  });
  it("does not mistake an earlier reported impact for an unattributed repeat", async () => {
    const p = perception();
    const receipt = await cycle(p, { actions: [], note: "retain", evidenceUse: [evidenceUse] });
    const next = await cycle({ ...p, backlog: [...p.backlog, ...compactReceipts([receipt], 10)] });
    expect(next.ruleHandoff?.observations[0].status).toBe("previously_reported");
  });
  it("does not count legal metadata references as rule-content use", async () => {
    const p = perception();
    const metadataField = "/value/rules/0/state";
    const read = (p.backlog[0].outcomes as CompactBacklogEntry["outcomes"])[0];
    const receipt = await cycle(
      {
        ...p,
        backlog: [
          {
            outcomes: [
              {
                ...read,
                args: { action: "read", id, field: metadataField },
                outcome: { ...read.outcome, field: metadataField, selectedValue: "active" },
              },
            ],
          },
        ],
      },
      {
        actions: [],
        note: "use metadata",
        evidenceUse: [{ ...evidenceUse, field: metadataField }],
      },
    );
    expect(receipt.evidenceUse?.[0].verification).toBe("reference_verified");
    expect(receipt.ruleHandoff?.observations[0].status).toBe("metadata_only");
  });
  it.each(["absent", "budget", "gate", "not_run", "digest_omitted"])(
    "locates the %s read stop at its original owner",
    async (fault) => {
      const p = perception();
      const read = (p.backlog[0].outcomes as CompactBacklogEntry["outcomes"])[0];
      const replacement: CompactBacklogEntry["outcomes"][number] =
        fault === "absent"
          ? {
              ...read,
              outcome: { ...read.outcome, available: false, gap: "artifact_field_missing" },
            }
          : fault === "budget"
            ? {
                ...read,
                outcomeDroppedKeys: ["selectedValue"],
                outcome: {
                  ...read.outcome,
                  selectionGap: "selected_field_exceeds_step_budget",
                  selectionHints: [{ field: `${field}/child` }],
                },
              }
            : {
                ...read,
                status:
                  fault === "gate"
                    ? "blocked_by_gate"
                    : fault === "digest_omitted"
                      ? "ran_ok"
                      : "approved",
                outcome: undefined,
                reason: "host scope block",
              };
      const receipt = await cycle({ ...p, backlog: [{ outcomes: [replacement] }] });
      const observation = receipt.ruleHandoff?.observations[0];
      expect(observation?.status).toBe(
        {
          absent: "read_failed",
          budget: "content_gap",
          gate: "normal_block",
          not_run: "not_observed",
          digest_omitted: "not_observed",
        }[fault],
      );
      if (fault === "absent") {
        expect(observation?.gap).toBe("artifact_field_missing");
      }
      if (fault === "budget") {
        expect(observation?.childFields).toEqual([`${field}/child`]);
      }
      if (fault === "gate") {
        expect(observation?.next).toContain("do not bypass");
      }
    },
  );
  it("preserves failed transport and unconfirmed cleanup as actionable gaps", async () => {
    const receipt = await runCentralHarnessCycle({
      perception: perception(),
      registry: new Map(),
      brain: {
        inspectCall: () => ({
          provider: "fixture",
          modelId: "offline",
          modelCall: {
            adapterInvoked: true,
            providerCallObserved: false,
            transport: {
              requestIdSha256: sourceSha256,
              stage: "cancelled",
              cleanupStatus: "unconfirmed",
            },
          },
        }),
        propose: async () => {
          throw new Error("deadline; cleanup_unconfirmed");
        },
      },
    });
    expect(receipt.ruleHandoff?.observations[0]).toMatchObject({
      stage: "transport",
      status: "transport_failed",
      owner: "src/agents/configured-finance-model-adapter.ts",
      gap: "cleanup_unconfirmed",
    });
    expect(receipt.ruleHandoff?.observations[0].next).toContain(
      `original failure: ${receipt.brainCall.reason}`,
    );
    expect(receipt.steps).toEqual([]);
    expect(receipt.nextAction).toBe("halt_and_report");
  });
  it.each(["http_status", "reason", "payment_and_cleanup"])(
    "diagnoses payment failure without suggesting timeout repair: %s",
    async (kind) => {
      const receipt = await runCentralHarnessCycle({
        perception: perception(),
        registry: new Map(),
        brain: {
          inspectCall: () => ({
            provider: "fixture",
            modelId: "offline",
            modelCall: {
              adapterInvoked: true,
              providerCallObserved: false,
              transport: {
                requestIdSha256: sourceSha256,
                stage: "failed",
                cleanupStatus: kind === "payment_and_cleanup" ? "unconfirmed" : "not_required",
                ...(kind === "http_status" ? { httpStatus: 402 } : {}),
              },
            },
          }),
          propose: async () => {
            throw new Error(
              kind === "http_status" ? "provider_http_error" : "provider_payment_required",
            );
          },
        },
      });
      const observation = receipt.ruleHandoff?.observations[0];
      expect(observation?.next).toContain("provider requires payment");
      expect(observation?.next).toContain("Do not trigger a paid rerun");
      expect(observation?.next).not.toContain("adapter deadline");
      expect(observation?.gap).toBe(
        kind === "payment_and_cleanup" ? "cleanup_unconfirmed" : receipt.brainCall.reason,
      );
      if (kind === "payment_and_cleanup") {
        expect(observation?.next).toContain("Local cleanup remains unconfirmed");
        expect(observation?.next).toContain(`original failure: ${receipt.brainCall.reason}`);
      }
      expect(receipt.steps).toEqual([]);
      expect(receipt.actionsProposed).toBe(0);
      expect(receipt.actionsApproved).toBe(0);
      expect(receipt.nextAction).toBe("halt_and_report");
    },
  );
  it("leaves unrelated legacy receipts compatible", async () => {
    const p = { ...perception(), backlog: [{ note: "legacy" }] };
    expect(await cycle(p)).not.toHaveProperty("ruleHandoff");
  });
  it.each([false, true])(
    "keeps historical read failure dated when this cycle only fails transport: body flag omitted=%s",
    async (bodyFlagOmitted) => {
      const sourceObservedAt = "2026-10-10T17:04:49Z";
      const failedRead = {
        stepId: "fixture-read",
        ownerId: "artifact_memory_recall",
        status: "ran_failed" as const,
        sourceObservedAt,
        args: { action: "read", id, field: "/value/rules/0/body" },
        outcome: { available: false, gap: "artifact_field_missing" },
      };
      const p = {
        ...perception(),
        backlog: [
          {
            outcomes: [
              {
                ownerId: "finance_strategy_rule_ledger_read",
                status: "ran_ok" as const,
                args: { ruleId: "fixture-rule", includeReadiness: true },
                argsDroppedKeys: bodyFlagOmitted ? ["includeBodies"] : [],
                resultArtifact: { id },
              },
              failedRead,
            ],
          },
        ],
      };
      const receipt = await runCentralHarnessCycle({
        perception: p,
        registry: new Map(),
        brain: {
          propose: async () => {
            throw new Error("provider_payment_required");
          },
        },
      });
      expect(receipt.steps).toEqual([]);
      expect(receipt.actionsProposed).toBe(0);
      const observations = receipt.ruleHandoff?.observations ?? [];
      expect(observations[0]).toMatchObject({
        stage: "transport",
        observationOrigin: "current_cycle",
      });
      expect(observations[1]).toMatchObject({
        stage: "read",
        status: "read_failed",
        observationOrigin: "prior_cycle",
        observedAt: sourceObservedAt,
      });
      expect(observations[1].next.includes("did not request rule bodies")).toBe(!bodyFlagOmitted);
      expect(observations[1].next).toContain("includeBodies=true");
      const current = diagnoseCentralRuleHandoff(
        { ...receipt, steps: [failedRead] },
        { ...p, backlog: [] },
      );
      expect(current?.observations[1].observationOrigin).toBe("current_cycle");
    },
  );
  it("reports omitted diagnostic details while keeping feedback bounded", async () => {
    const receipt = await cycle(perception(), {
      actions: [],
      note: "retain",
      evidenceUse: Array.from({ length: 6 }, (_, i) => ({
        ...evidenceUse,
        field: `${field}/${i}${"x".repeat(380)}`,
      })),
    });
    const compact = compactRuleHandoff(receipt.ruleHandoff!);
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThanOrEqual(1500);
    expect(compact.observationsOmitted).toBeGreaterThan(0);
  });
  it("retains the latest judgment when many exact read pages exhaust the backlog budget", async () => {
    const judgment = await cycle(perception(), {
      actions: [],
      note: "retain exact rule",
      evidenceUse: [evidenceUse],
    });
    const reads: CentralRunReceipt[] = Array.from({ length: 12 }, (_, index) => ({
      ...judgment,
      runId: `read-${index}`,
      evidenceUse: undefined,
      ruleHandoff: undefined,
      steps: [
        {
          stepId: `step-${index}`,
          ownerId: "artifact_memory_recall",
          status: "ran_ok",
          args: { action: "read", id, field: `/value/rules/${index}/body` },
          outcome: {
            action: "read",
            artifactId: id,
            field: `/value/rules/${index}/body`,
            available: true,
            sourceSha256,
            selectedValue: { frozenRule: "x".repeat(3500) },
          },
        },
      ],
    }));
    const feedback = compactReceipts([...reads, judgment], 10, new Set(["artifact_memory_recall"]));
    expect(Buffer.byteLength(JSON.stringify(feedback))).toBeLessThanOrEqual(8500);
    expect(feedback.at(-1)?.evidenceUse).toEqual(judgment.evidenceUse);
    expect(feedback.at(-1)?.ruleHandoff?.observations[0].status).toBe("impact_reported");
    expect(feedback[0].backlogEntriesOmitted).toBeGreaterThan(0);
  });
});

it.each(["Exit at session close", "Exit only when monthly return is nonpositive"])(
  "connects ledger → original tools → omitted body → narrow read → changed decision → original feedback (%s)",
  async (exit) => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-rule-sample-"));
    roots.push(workspaceDir);
    const directory = path.join(workspaceDir, "finance");
    vi.stubEnv("LCX_FINANCE_STATE_DIR", directory);
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: { store: { path: path.join(workspaceDir, "memory.sqlite") } },
        },
      },
    };
    for (let i = 0; i < 4; i++) {
      await declareFinanceStrategyRule(directory, {
        kind: "declared",
        ruleId: `offline-${i}`,
        form: "expression",
        instruments: ["SPY"],
        emits: "target_weights",
        schedule: { kind: "daily" },
        body: { frozenRule: { exit }, explanation: "bounded rule context ".repeat(180) },
        observedAt: "2026-09-17T00:00:00Z",
      });
    }
    const capabilities = new Set(["artifact_memory_recall", "finance_strategy_rule_ledger_read"]);
    const registry = new Map(
      [
        ...createCentralToolRegistry({
          workspaceDir,
          config,
        }),
      ].filter(([key]) => capabilities.has(key)),
    );
    const receipts: CentralRunReceipt[] = [];
    const run = async (proposal: CentralBrain) => {
      const receipt = await runCentralHarnessCycle({
        perception: {
          ...perception(),
          observedAt: new Date().toISOString(),
          backlog: compactReceipts(receipts, 10, capabilities),
        },
        registry,
        capabilityOwnerIds: capabilities,
        planOnly: true,
        brain: proposal,
      });
      receipts.push(receipt);
      expect(receipt.liveTouched).toBe(false);
      expect(receipt.brainCall.modelCall).toBeUndefined();
      expect(receipt.contextBudget.overBudget).toBe(false);
      return receipt;
    };
    const source = await run(
      brain({
        actions: [
          {
            ownerId: "finance_strategy_rule_ledger_read",
            args: { includeBodies: true },
          },
        ],
        note: "inspect original ledger",
      }),
    );
    expect(source.ruleHandoff?.observations[0].status).toBe("awaiting_content");
    const artifact = source.steps[0].resultArtifact!;
    expect(artifact.status).toBe("registered");
    const broad = await run(
      brain({
        actions: [
          {
            ownerId: "artifact_memory_recall",
            args: { action: "read", id: artifact.id, field: "/value/rules" },
          },
        ],
        note: "inspect declared rules",
      }),
    );
    expect(broad.ruleHandoff?.observations[0]).toMatchObject({
      status: "content_gap",
      gap: "selected_field_exceeds_step_budget",
      owner: "src/agents/central-harness/harness-loop.ts",
    });
    const pointer = (broad.steps[0].outcome!.selectionHints as { field: string }[]).find((hint) =>
      hint.field.endsWith("/body"),
    )!.field;
    const narrow = await run(
      brain({
        actions: [
          {
            ownerId: "artifact_memory_recall",
            args: { action: "read", id: artifact.id, field: `${pointer}/frozenRule/exit` },
          },
        ],
        note: "resolve the exact exit uncertainty",
      }),
    );
    expect(narrow.steps[0].outcome?.selectedValue).toBe(exit);
    expect(narrow.ruleHandoff?.observations[0].status).toBe("awaiting_judgment");
    const decision = await run({
      propose: async (input) => {
        const read = input.backlog
          .flatMap((item) => item.outcomes as CompactBacklogEntry["outcomes"])
          .find((step) => step.outcome?.selectedValue === exit)!;
        const note =
          read.outcome!.selectedValue === "Exit at session close"
            ? "Retain session-close exit"
            : "Change to monthly-return exit";
        return {
          kind: "proposed",
          provider: "fixture",
          modelId: "scripted",
          plan: {
            actions: [{ ownerId: "finance_live_execution" }],
            note,
            evidenceUse: [
              {
                artifactId: artifact.id!,
                sourceSha256: artifact.sha256!,
                field: `${pointer}/frozenRule/exit`,
                effect: exit === "Exit at session close" ? "retain" : "change",
                reason: `${exit}; ${note}. Broker unknown; execution remains blocked.`,
              },
            ],
          },
        };
      },
    });
    expect(decision.brainCall.note).toBe(
      exit === "Exit at session close"
        ? "Retain session-close exit"
        : "Change to monthly-return exit",
    );
    expect(decision.ruleHandoff?.observations[0].status).toBe("impact_reported");
    expect(decision.ruleHandoff?.gate).toBe("blocked");
    expect(decision.evidenceUse?.[0].verification).toBe("reference_verified");
    expect(decision.ontologyEdges?.some((edge) => edge.object.id === "instrument:SPY")).toBe(true);
    await run({
      propose: async (input) => {
        const feedback = input.backlog.find(
          (entry) => Array.isArray(entry.evidenceUse) && entry.evidenceUse.length,
        )!;
        expect(feedback.evidenceUse).toEqual(decision.evidenceUse);
        expect(feedback.ruleHandoff).toMatchObject({
          semanticAdoption: "not_proven",
          gate: "blocked",
        });
        return {
          kind: "proposed",
          provider: "fixture",
          modelId: "scripted",
          plan: { actions: [], note: "Retain blocked outcome as feedback" },
        };
      },
    });
  },
);

it("recovers a missing account id via real sibling pointers instead of accepting the guessed field", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "finance-account-gap-"));
  roots.push(workspaceDir);
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: { store: { path: path.join(workspaceDir, "memory.sqlite") } },
      },
    },
  };
  const artifact = await recordAgentArtifact({
    workspaceDir,
    config,
    agentId: "main",
    owner: "finance_position_ledger_read",
    runId: "offline-account",
    value: { brokerSnapshot: { accounts: [{ accountId: "paper-A", holdings: [] }] } },
  });
  const registry = createCentralToolRegistry({ workspaceDir, config });
  const missing = await runCentralHarnessCycle({
    perception: { ...perception(), backlog: [] },
    registry,
    brain: brain({
      actions: [
        {
          ownerId: "artifact_memory_recall",
          args: { action: "read", id: artifact.id, field: "/value/brokerSnapshot/accounts/0/id" },
        },
      ],
      note: "locate exact account",
    }),
  });
  expect(missing.steps[0].outcome).toMatchObject({
    available: false,
    gap: "artifact_field_missing",
    sourceSha256: artifact.sha256,
  });
  expect(missing.steps[0].outcome).not.toHaveProperty("selectedValue");
  const hints = missing.steps[0].outcome!.selectionHints as { field: string }[];
  const accountField = hints.find((hint) => hint.field.endsWith("/accountId"))!.field;
  const next = await runCentralHarnessCycle({
    perception: {
      ...perception(),
      backlog: compactReceipts([missing], 10, new Set(["artifact_memory_recall"])),
    },
    registry,
    brain: {
      propose: async (input) => {
        expect(
          (input.backlog[0].outcomes as CompactBacklogEntry["outcomes"])[0].outcome?.selectionHints,
        ).toEqual(hints);
        return {
          kind: "proposed",
          provider: "fixture",
          modelId: "scripted",
          plan: {
            actions: [
              {
                ownerId: "artifact_memory_recall",
                args: { action: "read", id: artifact.id, field: accountField },
              },
            ],
            note: "read actual account field",
          },
        };
      },
    },
  });
  expect(next.steps[0].outcome).toMatchObject({
    selectedValue: "paper-A",
    sourceSha256: artifact.sha256,
    selectionScope: { accountId: "paper-A" },
  });
});
