/** Original central owners with a loopback response fixture and a private state/artifact root. */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildPerception,
  readCentralGovernanceInput,
} from "../../scripts/operator/lcx-central-agent.js";
import type {
  WorkflowFieldRef,
  WorkflowHandoffEvidence,
} from "../../scripts/operator/lcx-flow-graph.js";
import {
  classifyShadowLatestReceipt,
  type ShadowExperimentReceipt,
} from "../../scripts/operator/lcx-multi-agent-pattern-shadow.js";
import { buildCentralGovernanceInput } from "../../src/agents/central-harness/governance-input.js";
import {
  compactReceipts,
  runCentralHarnessCycle,
} from "../../src/agents/central-harness/harness-loop.js";
import {
  createCentralBrain,
  type CentralBrainOutcome,
} from "../../src/agents/central-harness/model-brain.js";
import {
  resolveLatestPointer,
  writeJsonAtomic,
  writeRunSnapshot,
} from "../../src/agents/central-harness/run-store.js";
import { createCentralToolRegistry } from "../../src/agents/central-harness/tool-registry.js";
import type {
  CentralPerception,
  CentralRunReceipt,
  CentralToolSpec,
} from "../../src/agents/central-harness/types.js";
import type { OpenClawConfig } from "../../src/config/config.js";
import { requireNodeSqlite } from "../../src/memory/sqlite.js";
import {
  buildLcxRunReceipt,
  boundaryFromFlags,
  createLcxRunSnapshot,
} from "../../src/shared/lcx-run-receipt.js";

export async function probeOriginalCentral(params: {
  directory: string;
  seed: number;
  fault?: "missing_evidence" | "body_timeout" | "missing_snapshot";
  shadowReceipt?: ShadowExperimentReceipt;
}) {
  const workspaceDir = path.join(params.directory, "workspace");
  const stateDirectory = path.join(workspaceDir, "state");
  const databasePath = path.join(workspaceDir, "memory.sqlite");
  await fs.mkdir(stateDirectory, { recursive: true });
  const observedAt = new Date().toISOString();
  const parentRunId = `offline-central-${params.seed}-${params.fault ?? "positive"}`;
  const snapshot = createLcxRunSnapshot({
    observedAt,
    sourceCommit: "offline-source",
    sourceBranch: "offline-fixture",
    authorityOwner: "lcx-governance-autopilot",
  });
  const sourceReceipt = buildLcxRunReceipt({
    runId: `${parentRunId}-owner`,
    parentRunId,
    owner: "mindModel",
    phase: "observe",
    status: "passed",
    checkedAt: observedAt,
    snapshot,
    boundary: boundaryFromFlags({ scope: "offline_fixture" }),
    evidence: [],
    nextAction: "retain original source",
  });
  const governance = buildCentralGovernanceInput(
    [{ id: "mindModel", ok: true, compact: { ok: true }, runReceipt: sourceReceipt }],
    {
      parentRunId,
      snapshot,
      ...(params.shadowReceipt
        ? { multiAgentPatternShadow: classifyShadowLatestReceipt(params.shadowReceipt, observedAt) }
        : {}),
    },
  );
  const governancePath = path.join(params.directory, "native-governance-handoff.json");
  await fs.writeFile(governancePath, JSON.stringify(governance, null, 2));
  if (params.fault !== "missing_snapshot") {
    await fs.writeFile(
      path.join(stateDirectory, "lcx-control-room-latest.json"),
      JSON.stringify({ checkedAt: observedAt, localInput: "offline_fixture" }),
    );
  }
  await fs.writeFile(
    path.join(stateDirectory, "lcx-learning-workflow-latest.json"),
    JSON.stringify({ checkedAt: observedAt, summary: {} }),
  );
  const trace: {
    perceptionCalls: {
      governance: Readonly<Record<string, unknown>>;
      returned: CentralPerception;
    }[];
    brainCalls: { perception: CentralPerception; outcome: CentralBrainOutcome }[];
    gateCalls: {
      ownerId: string;
      args: Readonly<Record<string, unknown>>;
      result: ReturnType<CentralToolSpec["approve"]>;
    }[];
    settleArguments: CentralRunReceipt[];
    httpRequests: {
      prompt: string;
      responsePlan?: Record<string, unknown>;
      responseEnded: boolean;
    }[];
    sourceFault?: { deletedArtifactId: string; changes: number };
  } = { perceptionCalls: [], brainCalls: [], gateCalls: [], settleArguments: [], httpRequests: [] };
  const timers: ReturnType<typeof setTimeout>[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) {
      raw += String(chunk);
    }
    const prompt = (JSON.parse(raw) as { messages: { content: string }[] }).messages[0].content;
    const request: (typeof trace.httpRequests)[number] = { prompt, responseEnded: false };
    trace.httpRequests.push(request);
    const backlogLine = /^backlog: (.+)$/m.exec(prompt)?.[1];
    const backlog =
      backlogLine && backlogLine !== "none"
        ? (JSON.parse(backlogLine) as {
            outcomes: {
              ownerId: string;
              resultArtifact?: { id?: string };
              outcome?: Record<string, unknown>;
            }[];
          }[])
        : [];
    let plan: Record<string, unknown>;
    if (params.shadowReceipt) {
      const control = /^control_room_summary: (.+)$/m.exec(prompt)?.[1];
      const shadow = control
        ? (
            JSON.parse(control) as {
              governanceDigest?: {
                shadow?: {
                  status?: string;
                  trialDecision?: string;
                  trialDecisionReason?: string;
                };
              };
            }
          ).governanceDigest?.shadow
        : undefined;
      plan = {
        actions: [],
        note:
          shadow?.status && shadow.trialDecision
            ? `hold shadow expansion: ${shadow.status}/${shadow.trialDecision}; ${shadow.trialDecisionReason}`
            : "unresolved: original shadow comparison was not delivered",
      };
    } else if (params.fault === "missing_snapshot") {
      plan = {
        actions: [],
        note: prompt.includes('"controlRoom":"missing"')
          ? "unresolved: original controlRoom snapshot missing"
          : "fixture expected missing source",
      };
    } else if (trace.httpRequests.length === 1) {
      plan = {
        actions: [
          {
            ownerId: "quant_math",
            args: {
              action: "linear_regression",
              series: [params.seed, 2 * params.seed, 3 * params.seed],
              benchmark: [1, 2, 3],
            },
          },
        ],
        note: "Measure exact scaling through the original registered tool",
      };
    } else if (trace.httpRequests.length === 2) {
      const quant = backlog
        .flatMap((entry) => entry.outcomes)
        .find((step) => step.ownerId === "quant_math");
      plan = {
        actions: [
          {
            ownerId: "artifact_memory_recall",
            args: { action: "read", id: quant?.resultArtifact?.id, field: "/value/beta" },
          },
        ],
        note: "Read the exact original result to resolve scaling doubt",
      };
    } else {
      const read = backlog
        .flatMap((entry) => entry.outcomes)
        .find((step) => step.ownerId === "artifact_memory_recall")?.outcome;
      const available = read?.available === true && typeof read.selectedValue === "number";
      const beta = Number(read?.selectedValue);
      plan = {
        actions: [],
        note: available
          ? `beta=${beta}: ${beta > 3 ? "change: measure scaling bottleneck" : "retain baseline"}`
          : "unresolved: original artifact evidence unavailable",
        ...(available
          ? {
              evidenceUse: [
                {
                  artifactId: read.artifactId,
                  sourceSha256: read.sourceSha256,
                  field: read.field,
                  effect: beta > 3 ? "change" : "retain",
                  reason: `Exact original beta=${beta} ${beta > 3 ? "requires bottleneck review" : "supports baseline"}`,
                },
              ],
            }
          : {}),
      };
    }
    request.responsePlan = plan;
    res.writeHead(200, { "content-type": "application/json" });
    const body = JSON.stringify({
      choices: [{ message: { content: JSON.stringify(plan) }, finish_reason: "stop" }],
    });
    if (params.fault === "body_timeout") {
      res.flushHeaders();
      res.write('{"choices":');
      timers.push(
        setTimeout(() => {
          res.end(body.slice(11));
          request.responseEnded = true;
        }, 300),
      );
    } else {
      res.end(body);
      request.responseEnded = true;
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("offline response server has no address");
  }
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: { primary: "fixture/selected" },
        memorySearch: { store: { path: databasePath } },
      },
    },
    models: {
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "offline-fixture-credential",
          models: [
            {
              id: "selected",
              name: "Offline response",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32000,
              maxTokens: 8192,
            },
          ],
        },
      },
    },
  };
  const capabilities = new Set(["quant_math", "artifact_memory_recall"]);
  const original = createCentralToolRegistry({ config, workspaceDir, agentId: "main" });
  const registry = new Map(
    [...original]
      .filter(([id]) => capabilities.has(id))
      .map(([id, spec]) => [
        id,
        {
          ...spec,
          approve: (args: Readonly<Record<string, unknown>>) => {
            const result = spec.approve(args);
            trace.gateCalls.push({ ownerId: id, args, result });
            return result;
          },
        },
      ]),
  );
  const nativeBrain = createCentralBrain(config, {
    tools: [...registry.values()],
    timeoutMs: params.fault === "body_timeout" ? 120 : 2000,
  });
  const receipts: CentralRunReceipt[] = [];
  const cyclePaths: string[] = [];
  try {
    for (
      let index = 0;
      index <
      (params.shadowReceipt ||
      params.fault === "body_timeout" ||
      params.fault === "missing_snapshot"
        ? 1
        : 3);
      index++
    ) {
      const currentGovernance = await readCentralGovernanceInput(governancePath);
      const backlog = compactReceipts(receipts, 10, capabilities);
      const perception = await buildPerception(
        backlog,
        {
          objective: "Use source-bound scaling evidence to retain or review the baseline",
          focus: "general",
        },
        currentGovernance,
        undefined,
        { stateDirectory },
      );
      trace.perceptionCalls.push({ governance: currentGovernance, returned: perception });
      const receipt = await runCentralHarnessCycle({
        perception,
        registry,
        capabilityOwnerIds: capabilities,
        planOnly: true,
        runId: `${parentRunId}-cycle-${index}`,
        brain: {
          inspectCall: nativeBrain.inspectCall,
          propose: async (input, signal) => {
            const outcome = await nativeBrain.propose(input, signal);
            trace.brainCalls.push({ perception: input, outcome });
            return outcome;
          },
        },
        settle: async (value) => {
          trace.settleArguments.push(value);
          const runPath = await writeRunSnapshot(path.join(stateDirectory, "runs"), value);
          cyclePaths.push(runPath);
          const latest = resolveLatestPointer(undefined, value, runPath);
          await writeJsonAtomic(path.join(stateDirectory, "lcx-central-agent-latest.json"), {
            latestReceipt: latest.heldReceipt,
            latestRunPath: latest.heldRunPath,
          });
          await fs.appendFile(
            path.join(stateDirectory, "lcx-central-agent-log-latest.jsonl"),
            JSON.stringify(value) + "\n",
          );
          return { runId: value.runId, observedAt: value.observedAt, approved: [], blocked: [] };
        },
      });
      receipts.push(receipt);
      if (index === 0 && params.fault === "missing_evidence") {
        const artifactId = receipt.steps[0]?.resultArtifact?.id;
        if (!artifactId) {
          throw new Error("original quant result was not archived");
        }
        const { DatabaseSync } = requireNodeSqlite();
        const db = new DatabaseSync(databasePath);
        try {
          const result = db.prepare("DELETE FROM owner_artifacts WHERE id=?").run(artifactId);
          trace.sourceFault = { deletedArtifactId: artifactId, changes: Number(result.changes) };
        } finally {
          db.close();
        }
      }
    }
    const beforeLate = await fs.readFile(cyclePaths[0], "utf8");
    if (params.fault === "body_timeout") {
      await delay(350);
    }
    const latePreserved = beforeLate === (await fs.readFile(cyclePaths[0], "utf8"));
    const tracePath = path.join(params.directory, "actual-original-central-calls.json");
    await fs.writeFile(tracePath, JSON.stringify(trace, null, 2) + "\n");
    const ref = async (file: string, pointer: string): Promise<WorkflowFieldRef> => ({
      path: file,
      pointer,
      sha256: createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex"),
    });
    let evidence: WorkflowHandoffEvidence | undefined;
    if (!params.fault && !params.shadowReceipt) {
      const scope = await ref(tracePath, "/perceptionCalls/0/governance/parentRunId");
      evidence = {
        scenarioId: "central_agent_decision_waterflow",
        environment: "offline_fixture",
        nodes: [
          {
            nodeId: "governance_autopilot",
            scope: await ref(governancePath, "/parentRunId"),
            output: await ref(governancePath, "/byOwner"),
          },
          {
            nodeId: "central_agent_perception",
            scope,
            inputs: [
              {
                from: "governance_autopilot",
                value: await ref(tracePath, "/perceptionCalls/0/governance/byOwner"),
              },
            ],
            output: await ref(tracePath, "/perceptionCalls/0/returned/ownerTotals"),
          },
          {
            nodeId: "central_agent_brain_proposal",
            scope,
            inputs: [
              {
                from: "central_agent_perception",
                value: await ref(tracePath, "/brainCalls/0/perception/ownerTotals"),
              },
            ],
            output: await ref(tracePath, "/brainCalls/0/outcome/plan/actions/0/args"),
          },
          {
            nodeId: "central_agent_gate",
            scope,
            inputs: [
              {
                from: "central_agent_brain_proposal",
                value: await ref(tracePath, "/gateCalls/0/args"),
              },
            ],
            output: await ref(tracePath, "/settleArguments/0/steps/0"),
          },
          {
            nodeId: "central_agent_latest_receipt",
            scope: await ref(cyclePaths[0], "/runtimeFreshness/governanceInput/parentRunId"),
            inputs: [{ from: "central_agent_gate", value: await ref(cyclePaths[0], "/steps/0") }],
            output: await ref(cyclePaths[0], "/nextAction"),
          },
        ],
      };
    }
    return {
      receipts,
      trace,
      evidence,
      cyclePaths,
      latePreserved,
      serverAddress: "loopback_fixture",
      originalToolAndGateUsed: true,
    };
  } finally {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
