import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { runPreparedReply } from "../../src/auto-reply/reply/get-reply-run.js";
import { createMockTypingController } from "../../src/auto-reply/reply/test-helpers.js";

const executeFile = promisify(execFile);
export const SKILLOPT_PROBE_ID = "single_stock_curve_technical_timing_preflight";
export const SKILLOPT_PROBE_BODY = "个股曲线 NVDA，核对技术入场和失效条件来源";
export const SKILLOPT_REPO_ROOT = path.resolve(import.meta.dirname, "../..");
export function skillOptRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
export async function skillOptHash(file: string) {
  return createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
}
export async function seedOriginalSkillOpt(
  workspace: string,
  phase: "bootstrap" | "candidate-edit",
) {
  const sourcePath = path.join(workspace, "state/lcx-governance-autopilot-latest.json");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(
    sourcePath,
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      owners: {
        trainingPlan: {
          activeProcessCount: 0,
          latestCandidateEval: {
            promotionReady: false,
            failedCaseIds: [SKILLOPT_PROBE_ID],
            parseErrorCaseIds: [],
            parseRecoveredCaseIds: [],
          },
        },
      },
    }),
  );
  return runOriginalSkillOpt(workspace, phase);
}
export async function runOriginalSkillOpt(
  workspace: string,
  phase: "bootstrap" | "candidate-edit",
) {
  const result = await executeFile(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/operator/lcx-skillopt-lite.ts",
      "--workspace",
      workspace,
      "--skill",
      SKILLOPT_PROBE_ID,
      "--phase",
      phase,
      "--json",
    ],
    { cwd: SKILLOPT_REPO_ROOT },
  );
  return skillOptRecord(JSON.parse(result.stdout));
}
export function preparedSkillOptParams(
  workspace: string,
  body = SKILLOPT_PROBE_BODY,
): Parameters<typeof runPreparedReply>[0] {
  return {
    ctx: { Body: body, RawBody: body, CommandBody: body, Provider: "webchat", ChatType: "direct" },
    sessionCtx: {
      Body: body,
      BodyStripped: body,
      Provider: "webchat",
      ChatType: "direct",
      MessageSid: "offline-skillopt-inbound",
    },
    cfg: { session: {}, channels: {}, agents: { defaults: {} } },
    agentId: "default",
    agentDir: path.join(workspace, "agent"),
    agentCfg: {},
    sessionCfg: {},
    commandAuthorized: true,
    command: {
      isAuthorizedSender: true,
      abortKey: "offline-skillopt",
      ownerList: [],
      senderIsOwner: false,
    } as never,
    commandSource: "",
    allowTextCommands: true,
    directives: { hasThinkDirective: false, thinkLevel: undefined } as never,
    defaultActivation: "always",
    resolvedThinkLevel: "low",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    elevatedEnabled: false,
    elevatedAllowed: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    modelState: { resolveDefaultThinkingLevel: async () => "low" } as never,
    provider: "offline-test",
    model: "scripted-local",
    typing: createMockTypingController(),
    defaultProvider: "offline-test",
    defaultModel: "scripted-local",
    timeoutMs: 1000,
    isNewSession: true,
    resetTriggered: false,
    systemSent: true,
    sessionKey: "offline-skillopt",
    workspaceDir: workspace,
    abortedLastRun: false,
  };
}
export async function saveSkillOptProof(directory: string, name: string, value: unknown) {
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${name}.json`);
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
  return { path: file, sha256: await skillOptHash(file) };
}
export async function preserveSkillOptBytes(
  workspace: string,
  directory: string,
  receipt: Record<string, unknown>,
) {
  const fields = [
    "bestSkillPath",
    "candidatePath",
    "receiptPath",
    "latestReceiptPath",
    "sourceAutopilotPath",
  ];
  const records = [];
  for (const field of fields) {
    const value = receipt[field];
    if (typeof value !== "string") {
      continue;
    }
    const absolute = path.resolve(workspace, value);
    try {
      const relative = path.relative(workspace, absolute);
      const output = path.join(directory, "native-bytes", relative);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.copyFile(absolute, output);
      records.push({
        field,
        relativePath: relative,
        path: output,
        sha256: await skillOptHash(output),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return records;
}

export async function auditSkillOptPartial(
  directory: string,
  workspace: string,
  receipt: Record<string, unknown>,
  calls: Array<{ workspaceDir: string; cue: unknown }>,
  modelInput: unknown,
  feedbackReceipt?: Record<string, unknown>,
) {
  const { auditWorkflowHandoffs } = await import("../../scripts/operator/lcx-flow-graph.js");
  const scope = {
    workspaceId: createHash("sha256").update(workspace).digest("hex"),
    runId: "offline-skillopt-pending",
  };
  if (calls.length !== 2 || calls.some((call) => call.workspaceDir !== workspace)) {
    throw new Error("Original autocue calls do not share private workspace scope");
  }
  const governance = JSON.parse(
    await fs.readFile(String(receipt.sourceAutopilotPath), "utf8"),
  ) as Record<string, unknown>;
  const files = {
    source: await saveSkillOptProof(directory, "auditor-source", {
      scope,
      originalSnapshot: governance,
    }),
    preparation: await saveSkillOptProof(directory, "auditor-preparation", {
      scope,
      originalReceipt: receipt,
      feedbackReceipt: feedbackReceipt ?? null,
    }),
    best: await saveSkillOptProof(directory, "auditor-best", { scope, originalRead: calls[0] }),
    runtime: await saveSkillOptProof(directory, "auditor-runtime", {
      scope,
      originalRead: calls[1],
      modelInput,
    }),
  };
  const ref = (key: keyof typeof files, pointer: string) => ({ ...files[key], pointer });
  const evidence: import("../../scripts/operator/lcx-flow-graph.js").WorkflowHandoffEvidence = {
    scenarioId: "skillopt_runtime_self_use_waterflow",
    environment: "offline_fixture",
    nodes: [
      {
        nodeId: "hardened_eval",
        scope: ref("source", "/scope"),
        output: ref(
          "source",
          "/originalSnapshot/owners/trainingPlan/latestCandidateEval/failedCaseIds",
        ),
      },
      {
        nodeId: "failure_curriculum",
        scope: ref("preparation", "/scope"),
        output: ref("preparation", "/originalReceipt/trainCases"),
        inputs: [
          {
            from: "hardened_eval",
            value: ref("preparation", "/originalReceipt/proofChain/targetedEval/caseGroups/train"),
          },
          ...(feedbackReceipt
            ? [
                {
                  from: "skillopt_candidate_edit" as const,
                  value: ref("preparation", "/feedbackReceipt/candidateFeedback/candidateSha256"),
                },
              ]
            : []),
        ],
      },
      {
        nodeId: "skillopt_candidate_edit",
        scope: ref("preparation", "/scope"),
        output: ref(
          "preparation",
          "/originalReceipt/proofChain/targetedEval/candidateIdentities/0/sha256",
        ),
        inputs: [
          {
            from: "failure_curriculum",
            value: ref("preparation", "/originalReceipt/skillPackets/0/trainCases"),
          },
        ],
      },
      {
        nodeId: "skillopt_best_skill",
        scope: ref("best", "/scope"),
        output: ref("best", "/originalRead/cue/readback/0/bestSkillSha256"),
        inputs: [
          {
            from: "skillopt_candidate_edit",
            value: ref("best", "/originalRead/cue/readback/0/candidateSha256"),
          },
        ],
      },
      {
        nodeId: "skillopt_runtime_preflight",
        scope: ref("runtime", "/scope"),
        output: ref("runtime", "/originalRead/cue/promptInjection"),
        inputs: [
          {
            from: "skillopt_best_skill",
            value: ref("runtime", "/originalRead/cue/readback/0/bestSkillSha256"),
          },
        ],
        block: {
          filter: "skillopt_best_skill_required",
          status: ref("runtime", "/originalRead/cue/readback/0/evaluationStatus"),
          reason: ref("runtime", "/originalRead/cue/readback/0/gaps/0"),
        },
      },
    ],
  };
  await saveSkillOptProof(directory, "handoff-input", [evidence]);
  const audit = (await auditWorkflowHandoffs([evidence])).find(
    (row) => row.scenarioId === evidence.scenarioId,
  );
  await saveSkillOptProof(directory, "handoff-audit", audit);
  return audit;
}
