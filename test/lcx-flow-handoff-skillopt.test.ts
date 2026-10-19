import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPreparedReply } from "../src/auto-reply/reply/get-reply-run.js";
import { resolveSkillOptAutoCue } from "../src/auto-reply/reply/skillopt-autocue.js";
import {
  seedOriginalSkillOpt,
  runOriginalSkillOpt,
  preparedSkillOptParams,
  saveSkillOptProof,
  preserveSkillOptBytes,
  auditSkillOptPartial,
  SKILLOPT_PROBE_BODY,
} from "./fixtures/lcx-waterflow-skillopt-probe.js";
const modelObservation = vi.hoisted(() => ({
  calls: [] as Array<{ prompt: string; workspaceDir: string; decision: string }>,
  cueCalls: [] as Array<{ workspaceDir: string; cue: unknown }>,
}));
vi.mock("../src/auto-reply/reply/skillopt-autocue.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/auto-reply/reply/skillopt-autocue.js")>();
  return {
    ...original,
    resolveSkillOptAutoCue: async (
      params: Parameters<typeof original.resolveSkillOptAutoCue>[0],
    ) => {
      const cue = await original.resolveSkillOptAutoCue(params);
      modelObservation.cueCalls.push({
        workspaceDir: params.workspaceDir,
        cue: structuredClone(cue),
      });
      return cue;
    },
  };
});
vi.mock("../src/agents/model-fallback.js", () => ({
  runWithModelFallback: async ({
    provider,
    model,
    run,
  }: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({ result: await run(provider, model), provider, model, attempts: [] }),
}));
vi.mock("../src/agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthProfileOverride: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/agents/pi-embedded.js", () => ({
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: async (params: { prompt: string; workspaceDir: string }) => {
    const decision = params.prompt.includes("pending_eval_acceptance")
      ? "pending_candidate_was_injected"
      : params.prompt.includes("[SkillOpt-lite preflight gap]")
        ? "candidate_refused_keep_original_question"
        : params.prompt.includes("[best_skill.md excerpt]")
          ? "bootstrap_context_preserved_no_behavior_claim"
          : "no_skillopt_context";
    modelObservation.calls.push({
      prompt: params.prompt,
      workspaceDir: params.workspaceDir,
      decision,
    });
    return { payloads: [{ text: decision }], meta: {} };
  },
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: vi.fn().mockReturnValue("session:session-key"),
}));

vi.mock("../src/config/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/sessions.js")>()),
  resolveGroupSessionKey: vi.fn().mockReturnValue(undefined),
  resolveSessionFilePath: vi.fn().mockReturnValue("/tmp/session.jsonl"),
  resolveSessionFilePathOptions: vi.fn().mockReturnValue({}),
  updateSessionStore: vi.fn(),
}));

vi.mock("../src/globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../src/process/command-queue.js", () => ({
  clearCommandLane: vi.fn().mockReturnValue(0),
  getQueueSize: vi.fn().mockReturnValue(0),
}));

vi.mock("../src/routing/session-key.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/routing/session-key.js")>()),
  normalizeMainKey: vi.fn().mockReturnValue("main"),
}));

vi.mock("../src/utils/provider-utils.js", () => ({
  isReasoningTagProvider: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/auto-reply/command-detection.js", () => ({
  hasControlCommand: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/auto-reply/reply/body.js", () => ({
  applySessionHints: vi.fn().mockImplementation(async ({ baseBody }) => baseBody),
}));

vi.mock("../src/auto-reply/reply/groups.js", () => ({
  buildGroupIntro: vi.fn().mockReturnValue(""),
  buildGroupChatContext: vi.fn().mockReturnValue(""),
}));

vi.mock("../src/auto-reply/reply/inbound-meta.js", () => ({
  buildInboundMetaSystemPrompt: vi.fn().mockReturnValue(""),
  buildInboundUserContextPrefix: vi.fn().mockReturnValue(""),
}));

vi.mock("../src/auto-reply/reply/queue.js", () => ({
  resolveQueueSettings: vi.fn().mockReturnValue({ mode: "followup" }),
  enqueueFollowupRun: vi.fn(),
  scheduleFollowupDrain: vi.fn(),
}));

vi.mock("../src/auto-reply/reply/route-reply.js", () => ({
  routeReply: vi.fn(),
}));

vi.mock("../src/auto-reply/reply/session-updates.js", () => ({
  ensureSkillSnapshot: vi.fn().mockImplementation(async ({ sessionEntry, systemSent }) => ({
    sessionEntry,
    systemSent,
    skillsSnapshot: undefined,
  })),
  buildQueuedSystemPrompt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/auto-reply/reply/typing-mode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auto-reply/reply/typing-mode.js")>()),
  resolveTypingMode: vi.fn().mockReturnValue("off"),
}));

let workspace: string;
beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "lcx-native-skillopt-"));
  vi.clearAllMocks();
  modelObservation.calls = [];
  modelObservation.cueCalls = [];
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  vi.stubEnv("OPENCLAW_WORKSPACE_DIR", workspace);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network forbidden");
    }),
  );
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("original SkillOpt worker input handoff", () => {
  it.each([
    "pending",
    "changed_best",
    "missing_best",
    "changed_candidate",
    "missing_candidate",
    "missing_receipt",
    "stale_source",
    "cross_scope",
  ] as const)(
    "refuses the original %s candidate in actual worker input and next scripted judgment",
    async (fault) => {
      const receipt = await seedOriginalSkillOpt(workspace, "candidate-edit");
      const directory = process.env.LCX_WATERFLOW_PROOF_DIR
        ? path.join(process.env.LCX_WATERFLOW_PROOF_DIR, fault)
        : path.join(workspace, "proof", fault);
      const bytes = await preserveSkillOptBytes(workspace, directory, receipt);
      const best = path.join(workspace, String(receipt.bestSkillPath));
      const candidate = path.join(workspace, String(receipt.candidatePath));
      const latest = path.join(workspace, String(receipt.latestReceiptPath));
      if (fault === "changed_best") {
        await fs.appendFile(best, "\nUnreviewed changed rule.");
      }
      if (fault === "missing_best") {
        await fs.rm(best);
      }
      if (fault === "changed_candidate") {
        await fs.appendFile(candidate, "\nChanged candidate bytes.");
      }
      if (fault === "missing_candidate") {
        await fs.rm(candidate);
      }
      if (fault === "missing_receipt") {
        await fs.rm(latest);
      }
      if (fault === "stale_source") {
        const file = String(receipt.sourceAutopilotPath);
        const source = JSON.parse(await fs.readFile(file, "utf8"));
        source.checkedAt = "2100-01-01T00:00:00.000Z";
        await fs.writeFile(file, JSON.stringify(source));
      }
      if (fault === "cross_scope") {
        const source = JSON.parse(await fs.readFile(latest, "utf8"));
        source.skillId = "another-skill";
        await fs.writeFile(latest, JSON.stringify(source));
      }
      const cue = await resolveSkillOptAutoCue({
        body: SKILLOPT_PROBE_BODY,
        workspaceDir: workspace,
        includeDefaultWorkspace: false,
      });
      const reply = await runPreparedReply(preparedSkillOptParams(workspace));
      expect(modelObservation.calls).toHaveLength(1);
      const modelInput = modelObservation.calls[0];
      expect(modelInput.prompt).not.toContain("[best_skill.md excerpt]");
      expect(modelInput.prompt).toContain("[SkillOpt-lite preflight gap]");
      expect(modelInput.prompt).toContain(SKILLOPT_PROBE_BODY);
      expect(modelInput.prompt).toContain(cue?.promptInjection);
      expect(modelInput.decision).toBe("candidate_refused_keep_original_question");
      expect(cue?.readback[0]).toMatchObject({ bodyIncluded: false, behaviorAccepted: false });
      const expectedGap = {
        pending: "candidate_behavior_eval_not_supported",
        changed_best: "best_skill_identity_hash_conflict",
        missing_best: "best_skill_body_missing",
        changed_candidate: "candidate_file_hash_conflict",
        missing_candidate: "candidate_file_unavailable",
        missing_receipt: "candidate_receipt_unavailable",
        stale_source: "skill_source_snapshot_stale_or_time_conflict",
        cross_scope: "skill_receipt_scope_conflict",
      }[fault];
      expect(cue?.readback[0].gaps).toContain(expectedGap);
      await saveSkillOptProof(directory, "owner-chain", {
        receipt,
        cue,
        modelInput,
        reply,
        bytes,
        scope: { workspaceDir: workspace, runId: `offline-skillopt-${fault}` },
        boundary:
          "Original get-reply-run -> original runReplyAgent -> original runAgentTurnWithFallback; only model/fallback and IO adapters substituted. A scripted rejection is not semantic/natural adoption.",
      });
      if (fault === "pending") {
        const audit = await auditSkillOptPartial(
          directory,
          workspace,
          receipt,
          modelObservation.cueCalls,
          modelInput,
        );
        expect(audit).toMatchObject({
          status: "handoff_gap",
          blocked: ["skillopt_runtime_preflight"],
          gaps: [
            {
              node: "failure_curriculum",
              reason: "consumer_did_not_receive_output:skillopt_candidate_edit",
            },
          ],
        });
      }
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
    60000,
  );
  it("consumes the prior native candidate in the next CLI curriculum decision and keeps unsupported behavior blocked in actual worker input", async () => {
    const first = await seedOriginalSkillOpt(workspace, "candidate-edit");
    const directory = process.env.LCX_WATERFLOW_PROOF_DIR
      ? path.join(process.env.LCX_WATERFLOW_PROOF_DIR, "continuous-feedback")
      : path.join(workspace, "proof", "continuous-feedback");
    const firstBytes = await preserveSkillOptBytes(workspace, path.join(directory, "first"), first);
    const second = await runOriginalSkillOpt(workspace, "candidate-edit");
    const secondBytes = await preserveSkillOptBytes(
      workspace,
      path.join(directory, "second"),
      second,
    );
    expect(second).toMatchObject({
      accepted: false,
      trainCases: [],
      staticGateOk: true,
      candidatePath: first.candidatePath,
      candidateFeedback: {
        status: "paired_eval_required",
        candidateEditPaused: true,
        deferredTrainCases: first.trainCases,
      },
    });
    const cue = await resolveSkillOptAutoCue({
      body: SKILLOPT_PROBE_BODY,
      workspaceDir: workspace,
      includeDefaultWorkspace: false,
    });
    const reply = await runPreparedReply(preparedSkillOptParams(workspace));
    expect(cue?.readback[0]).toMatchObject({ bodyIncluded: false, behaviorAccepted: false });
    expect(modelObservation.calls).toHaveLength(1);
    const modelInput = modelObservation.calls[0];
    expect(modelInput.prompt).toContain(cue?.promptInjection);
    expect(modelInput.prompt).not.toContain("[best_skill.md excerpt]");
    expect(modelInput.decision).toBe("candidate_refused_keep_original_question");
    const audit = await auditSkillOptPartial(
      directory,
      workspace,
      first,
      modelObservation.cueCalls,
      modelInput,
      second,
    );
    expect(audit).toMatchObject({
      status: "normal_block",
      blocked: ["skillopt_runtime_preflight"],
      gaps: [],
    });
    await saveSkillOptProof(directory, "owner-chain", {
      first,
      second,
      cue,
      reply,
      modelInput,
      firstBytes,
      secondBytes,
      scope: { workspaceDir: workspace, runId: "offline-skillopt-continuous-feedback" },
      boundary:
        "Native CLI receipt consumed by next native CLI changes trainCases selection and prevents repeated artifact writes; actual original worker receives explicit unsupported candidate gap. Private governance fixture and scripted model are not hardened evaluation, behavioral acceptance, training or natural use.",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  }, 60000);

  it("preserves hash-bound bootstrap SOP context in the original next worker input without claiming behavioral acceptance", async () => {
    const receipt = await seedOriginalSkillOpt(workspace, "bootstrap");
    const cue = await resolveSkillOptAutoCue({
      body: SKILLOPT_PROBE_BODY,
      workspaceDir: workspace,
      includeDefaultWorkspace: false,
    });
    const reply = await runPreparedReply(preparedSkillOptParams(workspace));
    expect(cue?.readback[0]).toMatchObject({
      sourceKind: "bootstrap_context",
      bodyIncluded: true,
      behaviorAccepted: false,
      gaps: [],
    });
    expect(modelObservation.calls).toHaveLength(1);
    expect(modelObservation.calls[0].prompt).toContain("[best_skill.md excerpt]");
    expect(modelObservation.calls[0].prompt).toContain(
      "bootstrap_best_skill_not_model_weight_absorbed",
    );
    expect(modelObservation.calls[0].prompt).toContain("portfolio_risk_gates");
    expect(modelObservation.calls[0].prompt).toContain(cue?.promptInjection);
    expect(cue?.readback[0].excerptSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(modelObservation.calls[0].decision).toBe(
      "bootstrap_context_preserved_no_behavior_claim",
    );
    const directory = process.env.LCX_WATERFLOW_PROOF_DIR
      ? path.join(process.env.LCX_WATERFLOW_PROOF_DIR, "bootstrap")
      : path.join(workspace, "proof");
    const bytes = await preserveSkillOptBytes(workspace, directory, receipt);
    await saveSkillOptProof(directory, "owner-chain", {
      receipt,
      cue,
      modelInput: modelObservation.calls[0],
      reply,
      bytes,
      scope: { workspaceDir: workspace, runId: "offline-skillopt-bootstrap" },
      boundary:
        "Native bootstrap SOP enters original worker model input; only context use, no paired candidate evaluation or model learning claim",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  }, 60000);
});
