import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: vi.fn(async () => {
      throw new Error("external HTTP forbidden in synthetic handoff fixture");
    }),
  };
});
import {
  executeDirectedDailyResearchTask,
  readDirectedDailyCases,
} from "../scripts/operator/lcx-directed-daily-research-brief.js";
import {
  auditWorkflowHandoffs,
  type WorkflowHandoffEvidence,
} from "../scripts/operator/lcx-flow-graph.js";
import {
  briefSnapshot,
  directedSha,
  nativeAcceptance,
  produceNativeBrief,
  prepareNativeDirectedTask,
  nativeDirectedTaskCli,
  unrelatedGateInputs,
} from "./fixtures/lcx-waterflow-directed-brief-probe.js";

function requireFailedExecution(
  output: Awaited<ReturnType<typeof executeDirectedDailyResearchTask>>,
) {
  const execution = output.taskExecution;
  if (execution.status !== "failed") {
    throw new Error("expected original failed task receipt");
  }
  return execution;
}

function expectUnselectedTasksNotObserved(output: unknown) {
  expect(output).toMatchObject({
    packetCandidateSections: expect.arrayContaining(
      ["semiconductor_leader_board", "timely_stock_candidates", "risk_gate_and_learning_loop"].map(
        (taskId) => ({
          taskId,
          status: "held",
          contentAcceptance: "not_observed",
          gaps: ["task_case_not_observed"],
        }),
      ),
    ),
  });
}

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-directed-brief-"));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network forbidden")));
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
async function save(name: string, result: unknown) {
  const evidence = process.env.LCX_DIRECTED_BRIEF_PROOF_DIR;
  if (!evidence) {
    return;
  }
  const dir = path.join(evidence, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.cp(workspace, path.join(dir, "private-bytes"), { recursive: true });
  await fs.writeFile(path.join(dir, "native-result.json"), JSON.stringify(result, null, 2) + "\n");
}
describe("native directed brief to commercial readiness", () => {
  it.skipIf(!process.env.LCX_DIRECTED_BRIEF_BEFORE_SOURCE)(
    "preserves original release passing although the native packet is not produced",
    async () => {
      const brief = await produceNativeBrief(workspace);
      const inputs = await unrelatedGateInputs();
      inputs.directedDailyResearchBrief = briefSnapshot(brief.payload);
      const result = await nativeAcceptance(inputs, process.env.LCX_DIRECTED_BRIEF_BEFORE_SOURCE);
      expect(brief.payload.executionStatus).toBe("planning_contract_only");
      expect(brief.payload.researchPacketStatus).toBe("not_produced");
      expect(
        result.gates.find((gate) => gate.id === "directed_daily_research_brief_clean")?.status,
      ).toBe("passed");
      expect(result.readyForCommercialRelease).toBe(true);
      await save("before-static-contract-false-release", { brief, result });
    },
  );
  it("consumes the original not-produced status and gaps in the actual readiness decision", async () => {
    const brief = await produceNativeBrief(workspace);
    const inputs = await unrelatedGateInputs();
    inputs.directedDailyResearchBrief = briefSnapshot(brief.payload);
    const result = await nativeAcceptance(inputs);
    expect(result.readyForCommercialRelease).toBe(false);
    const gate = result.gates.find(
      (entry) => entry.id === "directed_daily_research_packet_pending",
    );
    expect(gate).toMatchObject({
      status: "blocked",
      evidence: {
        staticContractValid: true,
        executionStatus: "planning_contract_only",
        researchPacketStatus: "not_produced",
        missingForPacket: brief.payload.missingForPacket,
      },
    });
    expect(fetch).not.toHaveBeenCalled();
    await save("after-original-gap-blocks-readiness", { brief, result });
  });
  it.each(["missing", "unrecognized", "contradictory"])(
    "does not infer a researched packet from %s production status",
    async (kind) => {
      const brief = await produceNativeBrief(workspace);
      const payload = { ...brief.payload };
      if (kind === "missing") {
        delete payload.executionStatus;
        delete payload.researchPacketStatus;
        delete payload.missingForPacket;
      } else {
        payload.executionStatus = "claimed_complete";
        payload.researchPacketStatus = "claimed_produced";
        if (kind === "unrecognized") {
          payload.missingForPacket = [];
        }
      }
      const inputs = await unrelatedGateInputs();
      inputs.directedDailyResearchBrief = briefSnapshot(payload);
      const result = await nativeAcceptance(inputs);
      expect(result.readyForCommercialRelease).toBe(false);
      expect(
        result.gates.find(
          (gate) => gate.owner === "scripts/operator/lcx-directed-daily-research-brief.ts",
        )?.status,
      ).toBe("blocked");
      await save(`after-${kind}-status`, { payload, result });
    },
  );
  it("preserves a missing source contract failure and original owner identity conflict", async () => {
    const brief = await produceNativeBrief(workspace);
    const inputs = await unrelatedGateInputs();
    inputs.directedDailyResearchBrief = {
      ...briefSnapshot(brief.payload),
      sourceFingerprint: directedSha(JSON.stringify(brief.payload)),
    };
    inputs.directedDailyResearchBrief.payload = { ...brief.payload, outputContract: {} };
    const result = await nativeAcceptance(inputs);
    expect(result.failedGates).toContain("directed_daily_research_brief_regression");
    expect(result.failedGates).toContain("acceptance_owner_collection_identity_conflict");
    expect(result.readyForCommercialRelease).toBe(false);
    await save("after-source-conflict", result);
  });
  it("keeps absent native research consumers visible to the original scene auditor", async () => {
    const brief = await produceNativeBrief(workspace);
    const ref = (pointer: string) => ({ path: brief.receiptPath, sha256: brief.sha256, pointer });
    const evidence: WorkflowHandoffEvidence[] = [
      {
        scenarioId: "directed_daily_research_brief_waterflow",
        environment: "offline_fixture",
        nodes: [
          { nodeId: "directed_daily_research_brief", scope: ref("/date"), output: ref("/tasks") },
        ],
      },
    ];
    const audit = await auditWorkflowHandoffs(evidence);
    const scene = audit.find(
      (entry) => entry.scenarioId === "directed_daily_research_brief_waterflow",
    );
    expect(scene?.status).toBe("handoff_gap");
    expect(scene?.gaps.some((gap) => gap.node === "finance_research_modules")).toBe(true);
    expect(scene?.semanticAdoption).toBe("not_proven");
    await save("after-native-partial-audit", { brief, evidence, audit });
  });
});

describe("explicit native directed one-task caller", () => {
  it.each([1, 2])(
    "enforces host API budget %s in actual native source dispatch and preserves original budget blocking",
    async (maxApiCalls) => {
      const probe = await prepareNativeDirectedTask(workspace, undefined, undefined, maxApiCalls);
      const output = await probe.run();
      await save(`single-task-host-api-budget-${maxApiCalls}`, {
        host: probe.host,
        output,
        sourceCalls: probe.prepared.sourceCalls,
        committeeRequests: probe.prepared.committeeRequests,
        qualityRequests: probe.prepared.qualityRequests,
      });
      const native = output.taskExecution.researchReceipt;
      if (!native?.batch) {
        throw new Error("native batch receipt missing");
      }
      expect(native.batch.budget.maxApiCalls).toBe(maxApiCalls);
      expect(probe.prepared.sourceCalls.length).toBeLessThanOrEqual(maxApiCalls);
      expect(
        native.batch.jobs.some((job) => job.missingEvidence.includes("api_call_budget_exhausted")),
      ).toBe(true);
      if (maxApiCalls === 1) {
        expect(probe.prepared.sourceCalls).toHaveLength(0);
        expect(native.gates.find((gate) => gate.id === "source")?.passed).toBe(false);
        expect(requireFailedExecution(output).gaps.length).toBeGreaterThan(0);
        expect(output.packetCandidateSections[0].gaps).toEqual(requireFailedExecution(output).gaps);
        expectUnselectedTasksNotObserved(output);
        expect(output.taskExecution.savedCase).toBeUndefined();
      } else {
        expect(probe.prepared.sourceCalls).toHaveLength(1);
        // Sufficient EOD history passes its source gate, while unfunded mandatory
        // producers still prevent a candidate. Retain the native failure without
        // fabricating a Caseflow receipt for the blocked optional job.
        expect(native.batch.budget.blockedJobs).toBe(1);
        expect(native.gates.find((gate) => gate.id === "source")?.passed).toBe(true);
        expect(native.gates.find((gate) => gate.id === "committee")?.passed).toBe(false);
        expect(output.researchPacketStatus).toBe("held");
        expect(requireFailedExecution(output).gaps).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^directed_research_not_candidate:needs_review:/u),
          ]),
        );
        expect(output.packetCandidateSections[0].gaps).toEqual(requireFailedExecution(output).gaps);
        expect(output.taskExecution.savedCase).toBeUndefined();
      }
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("runs same-task original source, modules, quality and immutable Caseflow into the original reader", async () => {
    const probe = await prepareNativeDirectedTask(workspace);
    const output = await probe.run();
    await save("single-task-native-result", {
      output,
      sourceCalls: probe.prepared.sourceCalls,
      committeeRequests: probe.prepared.committeeRequests,
      qualityRequests: probe.prepared.qualityRequests,
    });
    expect(output.taskExecution.status).toBe("executed");
    const native = output.taskExecution.researchReceipt!;
    expect(native.batch?.budget.maxApiCalls).toBe(probe.host.maxApiCalls);
    expect(native.plan.ask).toBe(
      output.tasks[0].title +
        "\n" +
        output.tasks[0].purpose +
        "\n" +
        output.tasks[0].requiredFreshInputs.join("\n") +
        "\n" +
        output.tasks[0].output +
        "\n" +
        output.tasks[0].invalidation.join("\n"),
    );
    expect(native.plan.decisionMode).toBe("research_only");
    if (!native.moduleExecution) {
      throw new Error("native module receipt missing");
    }
    expect(native.moduleExecution.requested).toBe(true);
    expect(native.moduleExecution.nodes.length).toBeGreaterThan(0);
    expect(probe.prepared.sourceCalls.length).toBeGreaterThan(0);
    expect(
      probe.prepared.qualityRequests.some(
        (request) => request.sharedContext?.financeModuleExecution,
      ),
    ).toBe(true);
    expect(output.researchPacketStatus).toBe("partial_sections");
    expect(output.packetCandidateSections[0].status).toBe("read_ready");
    expect(output.packetCandidateSections[0].gaps).toEqual([]);
    expect(
      native.moduleExecution.nodes.find((node) => node.nodeId === "finance_learning_memory")
        ?.missingEvidence,
    ).toContain("retrievable_finance_capability_card");
    expect(output.packetCandidateSections[0].packet?.analysis).toBe(
      native.quarterlyOutput.candidateAnalysis,
    );
    expect(output.packetCandidateSections[0].source?.ref).toBe(output.taskExecution.savedCase?.ref);
    expect(
      output.packetCandidateSections.slice(1).every((section) => section.status === "held"),
    ).toBe(true);
    expect(output.contentAcceptance).toBe("review_required");
    expect(output.taskExecution.notObserved).toContain("learning_application");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("explicit task scope, source and cancellation failures", () => {
  it.each(["missing_source", "quality_failure"] as const)(
    "preserves original %s gates and never saves a candidate",
    async (fault) => {
      const probe = await prepareNativeDirectedTask(workspace, fault);
      const output = await probe.run();
      expect(output.taskExecution.status).toBe("failed");
      expect(output.taskExecution.researchReceipt?.status).not.toBe("candidate");
      expect(output.taskExecution.savedCase).toBeUndefined();
      expect(output.researchPacketStatus).toBe("held");
      expect(output.packetCandidateSections[0].gaps.length).toBeGreaterThan(0);
      expect(probe.prepared.sourceCalls.length).toBeGreaterThan(0);
      expect(fetch).not.toHaveBeenCalled();
      await save(`single-task-${fault}`, {
        output,
        sourceCalls: probe.prepared.sourceCalls,
        qualityRequests: probe.prepared.qualityRequests,
      });
    },
  );
  it.each(["hash", "scope", "task", "targets", "missing_host"] as const)(
    "rejects %s before dispatch",
    async (fault) => {
      const probe = await prepareNativeDirectedTask(workspace);
      const request = { ...probe.request };
      if (fault === "scope") {
        request.accountId = "foreign-account";
      }
      if (fault === "task") {
        request.taskId = "semiconductor_leader_board";
      }
      if (fault === "targets") {
        request.targets = [{ id: "outside", instrument: "BTCUSDT", assetClass: "crypto" }];
      }
      const bytes = JSON.stringify(request, null, 2) + "\n";
      await fs.writeFile(probe.requestPath, bytes);
      const output = await probe.run({
        requestSha256: fault === "hash" ? "0".repeat(64) : directedSha(bytes),
        ...(fault === "missing_host" ? { host: undefined } : {}),
      });
      expect(output.taskExecution.status).toBe("failed");
      expect(probe.prepared.sourceCalls).toHaveLength(0);
      expect(output.taskExecution.savedCase).toBeUndefined();
      expect(requireFailedExecution(output).gaps?.join(" ")).toMatch(
        /hash_conflict|scope_conflict|task_date_conflict|target_outside_task|host_scope_unavailable/,
      );
      await save(`single-task-${fault}`, output);
    },
  );
  it("repins a changed declaration after real research before candidate persistence", async () => {
    const probe = await prepareNativeDirectedTask(workspace);
    const invoke = probe.nativeOptions.researchOptions.modelInvoker;
    let changed = false;
    const output = await probe.run({
      researchOptions: {
        ...probe.nativeOptions.researchOptions,
        modelInvoker: async (request, signal) => {
          const response = await invoke(request, signal);
          if (!changed) {
            changed = true;
            await fs.writeFile(
              probe.requestPath,
              JSON.stringify({ ...probe.request, caseId: "changed-late" }) + "\n",
            );
          }
          return response;
        },
      },
    });
    expect(probe.prepared.sourceCalls.length).toBeGreaterThan(0);
    expect(output.taskExecution.status).toBe("failed");
    expect(requireFailedExecution(output).gaps).toContain(
      "directed_research_manifest_hash_conflict",
    );
    expect(output.taskExecution.savedCase).toBeUndefined();
    await save("single-task-declaration-changed", output);
  });
  it("preserves deadline failure when an uncooperative model returns late", async () => {
    const probe = await prepareNativeDirectedTask(workspace);
    let release: () => void = () => {};
    const late = new Promise<void>((resolve) => {
      release = resolve;
    });
    let invoked = 0;
    let observedAbort = false;
    const output = await probe.run({
      timeoutMs: 250,
      researchOptions: {
        ...probe.nativeOptions.researchOptions,
        modelInvoker: async (request, signal) => {
          invoked += 1;
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
            },
            { once: true },
          );
          await late;
          return probe.prepared.scriptedOutput(
            request as Parameters<typeof probe.prepared.scriptedOutput>[0],
            new AbortController().signal,
          );
        },
      },
    });
    const failedBytes = JSON.stringify(output);
    expect(invoked).toBeGreaterThan(0);
    expect(observedAbort).toBe(true);
    expect(output.taskExecution.status).toBe("failed");
    expect(output.taskExecution.savedCase).toBeUndefined();
    expect(requireFailedExecution(output).gaps?.join(" ")).toMatch(/deadline|cancelled/);
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(JSON.stringify(output)).toBe(failedBytes);
    const runs = path.join(workspace, "state/directed-daily-research-runs");
    const leaves = await fs.readdir(runs, { recursive: true });
    expect(
      leaves.some(
        (leaf) => String(leaf).endsWith("bindings.json") || String(leaf).endsWith("cases"),
      ),
    ).toBe(false);
    expect(probe.prepared.qualityRequests).toHaveLength(0);
    expect(output.taskExecution.cleanup).toContain("unconfirmed");
    await save("single-task-deadline-late", { output, invoked, observedAbort, leaves });
  });
  it("uses changed original quantitative content in the next quality output without granting daily acceptance", async () => {
    const first = await prepareNativeDirectedTask(workspace);
    const a = await first.run();
    const other = path.join(workspace, "second-attempt");
    await fs.mkdir(other);
    const second = await prepareNativeDirectedTask(other, undefined, [100, 90, 97]);
    const b = await second.run();
    await save("single-task-content-consumption-observation", {
      a,
      b,
      firstSourceCalls: first.prepared.sourceCalls,
      secondSourceCalls: second.prepared.sourceCalls,
    });
    expect(a.taskExecution.status).toBe("executed");
    expect(b.taskExecution.status).toBe("executed");
    expect(
      a.taskExecution.researchReceipt?.quality?.finalArtifact?.supportingAnalysis,
    ).toMatchObject({
      originalQuantResult: { maxDrawdown: -0.05, evidenceId: "finance-module:quant_math" },
    });
    expect(
      b.taskExecution.researchReceipt?.quality?.finalArtifact?.supportingAnalysis,
    ).toMatchObject({
      originalQuantResult: { maxDrawdown: -0.1, evidenceId: "finance-module:quant_math" },
    });
    expect(a.packetCandidateSections[0].packet?.supportingAnalysis).toMatchObject({
      originalQuantResult: { maxDrawdown: -0.05 },
    });
    expect(b.packetCandidateSections[0].packet?.supportingAnalysis).toMatchObject({
      originalQuantResult: { maxDrawdown: -0.1 },
    });
    expect(a.contentAcceptance).toBe("review_required");
    expect(b.researchPacketStatus).toBe("partial_sections");
    expect(b.packetCandidateSections[0].status).toBe("read_ready");
    expect(b.contentAcceptance).toBe("review_required");
    await save("single-task-content-consumption-variant", {
      a,
      b,
      firstSourceCalls: first.prepared.sourceCalls,
      secondSourceCalls: second.prepared.sourceCalls,
      limit:
        "Scripted quality transport reads actual original quant result; this does not prove natural model judgment.",
    });
  });
  it("audits actual quality output into the original Caseflow snapshot while retaining unimplemented tails", async () => {
    const probe = await prepareNativeDirectedTask(workspace);
    const output = await probe.run();
    const execution = output.taskExecution;
    if (execution.status !== "executed") {
      throw new Error("native task did not execute");
    }
    const receiptPath = path.join(workspace, "native-directed-execution-return.json");
    const bytes = JSON.stringify(output, null, 2) + "\n";
    await fs.writeFile(receiptPath, bytes);
    const nativeCaseBytes = await fs.readFile(execution.savedCase.path);
    const source = (pointer: string) => ({
      path: receiptPath,
      sha256: directedSha(bytes),
      pointer,
    });
    const consumed = (pointer: string) => ({
      path: execution.savedCase.path,
      sha256: directedSha(nativeCaseBytes),
      pointer,
    });
    const evidence: WorkflowHandoffEvidence[] = [
      {
        scenarioId: "directed_daily_research_brief_waterflow",
        environment: "offline_fixture",
        nodes: [
          {
            nodeId: "review_panel",
            scope: source("/taskExecution/researchReceipt/quality/runId"),
            output: source("/taskExecution/researchReceipt/quality/finalArtifact"),
          },
          {
            nodeId: "daily_research_packet",
            scope: consumed("/run/snapshot/quality/runId"),
            inputs: [
              { from: "review_panel", value: consumed("/run/snapshot/quality/finalArtifact") },
            ],
            output: consumed("/packet"),
          },
        ],
      },
    ];
    const audit = await auditWorkflowHandoffs(evidence);
    const scene = audit.find(
      (entry) => entry.scenarioId === "directed_daily_research_brief_waterflow",
    );
    expect(scene?.status).toBe("handoff_gap");
    expect(
      scene?.gaps.some(
        (gap) =>
          gap.reason === "consumer_did_not_receive_output:review_panel" ||
          gap.reason === "producer_field_cannot_serve_as_consumer_readback:review_panel",
      ),
    ).toBe(false);
    expect(scene?.gaps.some((gap) => gap.node === "finance_learning_memory")).toBe(true);
    expect(scene?.semanticAdoption).toBe("not_proven");
    await save("single-task-native-partial-audit", {
      output,
      evidence,
      audit,
      limit:
        "One executed task Caseflow candidate, not the complete daily packet or schedule/feedback acceptance.",
    });
  });
  it("rejects changed Caseflow bytes at the original next reader", async () => {
    const probe = await prepareNativeDirectedTask(workspace);
    const output = await probe.run();
    const execution = output.taskExecution;
    if (execution.status !== "executed") {
      throw new Error("native task did not execute");
    }
    const again = await readDirectedDailyCases({
      date: probe.request.date,
      bindingsFile: execution.bindingsFile,
      workspaceDir: workspace,
    });
    expect(again.packetCandidateSections[0].packet?.analysis).toBe(
      execution.researchReceipt.quarterlyOutput.candidateAnalysis,
    );
    const before = await fs.readFile(execution.savedCase.path, "utf8");
    await fs.writeFile(
      execution.savedCase.path,
      before.replace("controller-budget", "foreign-budget"),
    );
    const refused = await readDirectedDailyCases({
      date: probe.request.date,
      bindingsFile: execution.bindingsFile,
      workspaceDir: workspace,
    });
    expect(refused.packetCandidateSections[0].gaps).toContain("case_source_hash_conflict");
    expect(refused.packetCandidateSections[0].packet).toBeUndefined();
    await save("single-task-next-reader-hash", { output, again, refused });
  });
  it("returns native CLI unavailable evidence with no configured model and no candidate", async () => {
    const probe = await prepareNativeDirectedTask(workspace);
    const cli = await nativeDirectedTaskCli(workspace, {
      requestPath: probe.requestPath,
      requestSha256: probe.nativeOptions.requestSha256,
      hostPath: probe.hostPath,
      hostSha256: probe.hostSha256,
      date: probe.request.date,
    });
    expect(cli.exitCode).toBe(0);
    expect(cli.payload).toMatchObject({
      ok: false,
      researchPacketStatus: "held",
      taskExecution: { status: "failed", researchReceipt: { status: "planned" } },
    });
    expect(probe.prepared.sourceCalls).toHaveLength(0);
    expect(cli.stdout).toContain("directed_research_not_candidate:planned");
    await save("single-task-cli-unavailable", cli);
    expect(cli.payload).toMatchObject({
      packetCandidateSections: expect.arrayContaining([
        expect.objectContaining({
          taskId: "index_options_regime",
          gaps: [expect.stringContaining("directed_research_not_candidate:planned")],
        }),
      ]),
    });
    expectUnselectedTasksNotObserved(cli.payload);
  });
  it.each(["missing", "malformed", "foreign_host", "bad_host_pin"] as const)(
    "returns complete CLI %s manifest failure",
    async (fault) => {
      const probe = await prepareNativeDirectedTask(workspace);
      let requestPath = probe.requestPath;
      let requestSha256 = probe.nativeOptions.requestSha256;
      let hostSha256 = probe.hostSha256;
      if (fault === "missing") {
        requestPath = path.join(workspace, "absent-request.json");
      }
      if (fault === "malformed") {
        await fs.writeFile(requestPath, "{private-invalid-body");
        requestSha256 = directedSha("{private-invalid-body");
      }
      if (fault === "foreign_host") {
        const bytes = JSON.stringify({ ...probe.host, runId: "foreign-run" });
        await fs.writeFile(probe.hostPath, bytes);
        hostSha256 = directedSha(bytes);
      }
      if (fault === "bad_host_pin") {
        hostSha256 = "0".repeat(64);
      }
      const cli = await nativeDirectedTaskCli(workspace, {
        requestPath,
        requestSha256,
        hostPath: probe.hostPath,
        hostSha256,
        date: probe.request.date,
      });
      expect(cli.exitCode).toBe(0);
      expect(cli.payload).toMatchObject({
        ok: false,
        researchPacketStatus: "held",
        taskExecution: { status: "failed", modelAvailability: "not_observed" },
      });
      expect(cli.stdout).not.toContain("private-invalid-body");
      expect(probe.prepared.sourceCalls).toHaveLength(0);
      await save(`single-task-cli-${fault}`, cli);
      expectUnselectedTasksNotObserved(cli.payload);
    },
  );
  it("keeps caller cancellation terminal before any source call", async () => {
    const probe = await prepareNativeDirectedTask(workspace);
    const controller = new AbortController();
    controller.abort(new Error("private-caller-cancelled"));
    const output = await probe.run({ signal: controller.signal });
    expect(output.taskExecution.status).toBe("failed");
    expect(requireFailedExecution(output).gaps).toContain("private-caller-cancelled");
    expect(probe.prepared.sourceCalls).toHaveLength(0);
    await save("single-task-caller-cancelled", output);
  });
  it.skipIf(!process.env.LCX_DIRECTED_TASK_BEFORE_SOURCE)(
    "freezes original CLI missing explicit research caller",
    async () => {
      const probe = await prepareNativeDirectedTask(workspace);
      const cli = await nativeDirectedTaskCli(workspace, {
        requestPath: probe.requestPath,
        requestSha256: probe.nativeOptions.requestSha256,
        hostPath: probe.hostPath,
        hostSha256: probe.hostSha256,
        date: probe.request.date,
        source: process.env.LCX_DIRECTED_TASK_BEFORE_SOURCE,
      });
      expect(cli.exitCode).not.toBe(0);
      expect(cli.stdout).toBe("");
      expect(cli.stderr).toContain("Usage:");
      await save("before-original-no-task-caller", cli);
    },
  );
});
