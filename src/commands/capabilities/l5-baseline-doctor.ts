import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import {
  runLarkLoopDiagnose,
  type LarkLoopDiagnoseCommandOptions,
  type LarkLoopDiagnosePayload,
} from "./lark-loop-diagnose.js";

export type L5BaselineDoctorCommandOptions = LarkLoopDiagnoseCommandOptions;

type L5BaselineGateStatus = "pass" | "fail";

type L5BaselineGate = {
  id: string;
  status: L5BaselineGateStatus;
  evidence: string;
};

export type L5BaselineDoctorPayload = {
  ok: boolean;
  level: "l5_baseline_ready" | "l5_baseline_blocked";
  generatedAt: string;
  gates: L5BaselineGate[];
  lark: {
    liveReceiptCount: number;
    latestReceiptPath: string | null;
    currentReplayCandidateCount: number;
    currentReplayRejectedCount: number;
    autodataStatus: string;
  };
  brain: {
    localLoopOk: boolean;
    family: unknown;
    backendTool: unknown;
    analysisStatus: unknown;
    primaryModules: string[];
    requiredTools: string[];
    boundaries: string[];
  };
  nextBlocker: string;
  boundaries: LarkLoopDiagnosePayload["boundaries"] & {
    doctorIsReadOnly: true;
    liveProbeNotPerformed: true;
  };
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function hasAll(values: string[], required: string[]): boolean {
  return required.every((entry) => values.includes(entry));
}

function gate(id: string, pass: boolean, evidence: string): L5BaselineGate {
  return {
    id,
    status: pass ? "pass" : "fail",
    evidence,
  };
}

function firstFailedGate(gates: L5BaselineGate[]): string | null {
  return gates.find((entry) => entry.status === "fail")?.id ?? null;
}

function buildPayload(diagnosis: LarkLoopDiagnosePayload): L5BaselineDoctorPayload {
  const orchestration = diagnosis.localLoop.orchestration;
  const primaryModules = stringArray(orchestration.primaryModules);
  const requiredTools = stringArray(orchestration.requiredTools);
  const boundaries = stringArray(orchestration.boundaries);
  const replay = diagnosis.languageCandidates.currentReplay;
  const liveReceipts = diagnosis.liveHandoffReceipts;
  const requiredModules = ["etf_regime", "portfolio_risk_gates", "quant_math", "causal_map"];
  const requiredToolsForBaseline = [
    "finance_learning_capability_apply",
    "quant_math",
    "review_tier",
    "review_panel",
  ];
  const gates = [
    gate(
      "local_language_brain_loop",
      diagnosis.localLoop.ok &&
        diagnosis.localLoop.backendTool === "finance_learning_pipeline_orchestrator" &&
        diagnosis.localLoop.analysisStatus === "research_review_ready",
      `backend=${String(diagnosis.localLoop.backendTool)} analysis=${String(diagnosis.localLoop.analysisStatus)}`,
    ),
    gate(
      "finance_brain_orchestration",
      hasAll(primaryModules, requiredModules) && hasAll(requiredTools, requiredToolsForBaseline),
      `modules=${primaryModules.join(",")} tools=${requiredTools.join(",")}`,
    ),
    gate(
      "risk_and_math_boundaries",
      hasAll(boundaries, ["research_only", "no_execution_authority", "no_model_math_guessing"]) &&
        diagnosis.localLoop.noActionBoundary === true,
      `boundaries=${boundaries.join(",")} noActionBoundary=${String(diagnosis.localLoop.noActionBoundary)}`,
    ),
    gate(
      "language_candidate_replay",
      replay.candidateCount > 0 && replay.rejectedCount === 0,
      `candidateCount=${replay.candidateCount} rejected=${replay.rejectedCount}`,
    ),
    gate(
      "language_family_known",
      (replay.rejectedSemanticFamilyCounts.unknown ?? 0) === 0,
      `unknownRejected=${replay.rejectedSemanticFamilyCounts.unknown ?? 0}`,
    ),
    gate(
      "live_lark_handoff_receipts",
      liveReceipts.count > 0,
      `receiptCount=${liveReceipts.count} latest=${liveReceipts.latestPath ?? "none"}`,
    ),
    gate(
      "gateway_schema_acceptance",
      diagnosis.gatewayAgentModelParamSchema.ok,
      diagnosis.gatewayAgentModelParamSchema.error ?? "ok",
    ),
    gate(
      "read_only_safety",
      diagnosis.boundaries.noRemoteFetchOccurred &&
        diagnosis.boundaries.noExecutionAuthority &&
        diagnosis.boundaries.protectedMemoryUntouched,
      `remoteFetch=${String(!diagnosis.boundaries.noRemoteFetchOccurred)} execution=${String(!diagnosis.boundaries.noExecutionAuthority)} protectedMemoryUntouched=${String(diagnosis.boundaries.protectedMemoryUntouched)}`,
    ),
  ];
  const failed = firstFailedGate(gates);
  return {
    ok: failed === null,
    level: failed === null ? "l5_baseline_ready" : "l5_baseline_blocked",
    generatedAt: new Date().toISOString(),
    gates,
    lark: {
      liveReceiptCount: liveReceipts.count,
      latestReceiptPath: liveReceipts.latestPath,
      currentReplayCandidateCount: replay.candidateCount,
      currentReplayRejectedCount: replay.rejectedCount,
      autodataStatus: diagnosis.languageCandidates.autodataLoop.status,
    },
    brain: {
      localLoopOk: diagnosis.localLoop.ok,
      family: diagnosis.localLoop.family,
      backendTool: diagnosis.localLoop.backendTool,
      analysisStatus: diagnosis.localLoop.analysisStatus,
      primaryModules,
      requiredTools,
      boundaries,
    },
    nextBlocker: failed ?? diagnosis.nextBlocker,
    boundaries: {
      ...diagnosis.boundaries,
      doctorIsReadOnly: true,
      liveProbeNotPerformed: true,
    },
  };
}

function formatText(payload: L5BaselineDoctorPayload): string {
  return [
    "LCX Agent L5 baseline doctor",
    "",
    `level: ${payload.level}`,
    `ok: ${String(payload.ok)}`,
    `nextBlocker: ${payload.nextBlocker}`,
    "",
    "Gates:",
    ...payload.gates.map((entry) => `- ${entry.status} ${entry.id}: ${entry.evidence}`),
    "",
    `lark receipts: ${payload.lark.liveReceiptCount}`,
    `lark current replay: candidates=${payload.lark.currentReplayCandidateCount} rejected=${payload.lark.currentReplayRejectedCount}`,
    `language autodata: ${payload.lark.autodataStatus}`,
    `brain family: ${String(payload.brain.family)}`,
    `brain backend: ${String(payload.brain.backendTool)}`,
    `brain modules: ${payload.brain.primaryModules.join(", ")}`,
    "",
    "Boundaries:",
    "- read-only doctor",
    "- no remote fetch",
    "- no trade or execution approval",
    "- protected memory untouched",
    "- live probe not performed by this command",
  ].join("\n");
}

export async function runL5BaselineDoctor(
  opts: L5BaselineDoctorCommandOptions,
): Promise<L5BaselineDoctorPayload> {
  return buildPayload(await runLarkLoopDiagnose(opts));
}

export async function l5BaselineDoctorCommand(
  opts: L5BaselineDoctorCommandOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const payload = await runL5BaselineDoctor(opts);
  runtime.log(opts.json ? JSON.stringify(payload, null, 2) : formatText(payload));
}
