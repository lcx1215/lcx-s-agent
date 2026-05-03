import fs from "node:fs/promises";
import path from "node:path";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import {
  runL4SystemDoctor,
  type L4SystemDoctorCommandOptions,
  type L4SystemDoctorPayload,
} from "./l4-system-doctor.js";
import {
  runLanguageBrainLoopSmoke,
  type LanguageBrainLoopSmokePayload,
} from "./language-brain-loop-smoke.js";

export type L5SystemEvalCommandOptions = L4SystemDoctorCommandOptions;

type L5GateStatus = "pass" | "blocked";

type L5Gate = {
  id: string;
  status: L5GateStatus;
  evidence: string;
  nextPatch: string;
};

export type L5SystemEvalPayload = {
  ok: boolean;
  level: "l5_ready" | "l4_hardened_l5_blocked" | "below_l4";
  score: {
    passed: number;
    total: number;
  };
  generatedAt: string;
  gates: L5Gate[];
  l4: {
    ok: boolean;
    level: L4SystemDoctorPayload["level"];
    nextBlocker: string;
  };
  loop: {
    ok: boolean;
    temporaryWorkspace: boolean;
    receiptPath: string;
  };
  nextBlocker: string;
  boundaries: {
    evalUsesTempLoopWorkspace: true;
    liveProbeNotPerformed: true;
    noRemoteFetchOccurred: true;
    noExecutionAuthority: true;
    protectedMemoryUntouched: true;
  };
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function gate(id: string, pass: boolean, evidence: string, nextPatch: string): L5Gate {
  return {
    id,
    status: pass ? "pass" : "blocked",
    evidence,
    nextPatch,
  };
}

function firstBlockedGate(gates: L5Gate[]): string | null {
  return gates.find((entry) => entry.status === "blocked")?.id ?? null;
}

async function receiptExists(payload: LanguageBrainLoopSmokePayload): Promise<boolean> {
  try {
    await fs.access(path.join(payload.workspaceDir, payload.memory.loopReceiptPath));
    return true;
  } catch {
    return false;
  }
}

async function buildPayload(params: {
  l4: L4SystemDoctorPayload;
  loop: LanguageBrainLoopSmokePayload;
}): Promise<L5SystemEvalPayload> {
  const l4Failed = params.l4.gates
    .filter((entry) => entry.status === "fail")
    .map((entry) => entry.id);
  const orchestrationModules = stringArray(params.loop.orchestration.primaryModules);
  const requiredTools = stringArray(params.loop.orchestration.requiredTools);
  const boundaries = stringArray(params.loop.orchestration.boundaries);
  const mathChecks = stringArray(params.loop.math.checks);
  const candidateCount = numberValue(params.loop.brain.candidateCount) ?? 0;
  const receiptPresent = await receiptExists(params.loop);
  const reviewPanelStatus = stringValue(params.loop.reviewPanel.status);
  const reviewerTasks = Array.isArray(params.loop.reviewPanel.reviewerTasks)
    ? params.loop.reviewPanel.reviewerTasks
    : [];
  const localArbitration =
    params.loop.reviewPanel.localArbitration &&
    typeof params.loop.reviewPanel.localArbitration === "object" &&
    !Array.isArray(params.loop.reviewPanel.localArbitration)
      ? (params.loop.reviewPanel.localArbitration as Record<string, unknown>)
      : null;
  const localArbitrationStatus = stringValue(localArbitration?.status);
  const arbitrationReceiptPath = stringValue(params.loop.reviewPanel.receiptPath);

  const gates = [
    gate(
      "l4_baseline_clean",
      params.l4.ok,
      `l4=${params.l4.level} failed=${l4Failed.join(",") || "none"}`,
      "Keep l4-system-doctor green before promoting any L5 claim.",
    ),
    gate(
      "natural_language_to_work_order",
      params.loop.language.family === "market_capability_learning_intake" &&
        params.loop.language.backendTool === "finance_learning_pipeline_orchestrator",
      `family=${String(params.loop.language.family)} backend=${String(params.loop.language.backendTool)}`,
      "Expand only by semantic family and keep language corpus separate from learning artifacts.",
    ),
    gate(
      "autonomous_learning_application_loop",
      candidateCount >= 6 &&
        params.loop.brain.synthesisMode === "multi_capability_synthesis" &&
        params.loop.analysis.eventReviewStatus === "research_review_ready",
      `candidates=${candidateCount} synthesis=${String(params.loop.brain.synthesisMode)} analysis=${String(params.loop.analysis.eventReviewStatus)}`,
      "Add regression cases where learning must return application_ready or an explicit failedReason.",
    ),
    gate(
      "finance_module_orchestration",
      ["etf_regime", "technical_timing", "portfolio_risk_gates", "quant_math", "causal_map"].every(
        (entry) => orchestrationModules.includes(entry),
      ) &&
        ["finance_framework_core_inspect", "finance_learning_capability_apply", "quant_math"].every(
          (entry) => requiredTools.includes(entry),
        ),
      `modules=${orchestrationModules.join(",")} tools=${requiredTools.join(",")}`,
      "Keep adding finance-domain modules only when they are selected by task evidence, not as permanent noise.",
    ),
    gate(
      "deterministic_finance_math",
      ["risk_budget_deviation", "rolling_beta", "drawdown_duration", "calmar_ratio"].every(
        (entry) => mathChecks.includes(entry),
      ) && params.loop.math.noModelMathGuessing === true,
      `checks=${mathChecks.join(",")} noModelMathGuessing=${String(params.loop.math.noModelMathGuessing)}`,
      "Add fresh adjacent math tasks that require local calculation before model review.",
    ),
    gate(
      "memory_artifact_trace",
      receiptPresent && params.loop.protectedMemoryUntouched && params.loop.languageCorpusUntouched,
      `receipt=${params.loop.memory.loopReceiptPath} protectedMemoryUntouched=${String(params.loop.protectedMemoryUntouched)} languageCorpusUntouched=${String(params.loop.languageCorpusUntouched)}`,
      "Promote only reviewed receipts into durable memory; keep language corpus and learning memory separate.",
    ),
    gate(
      "lark_operability_receipts",
      params.l4.lark.liveReceiptCount > 0 &&
        params.l4.lark.currentReplayCandidateCount > 0 &&
        params.l4.lark.currentReplayRejectedCount === 0,
      `receipts=${params.l4.lark.liveReceiptCount} replay=${params.l4.lark.currentReplayCandidateCount}/${params.l4.lark.currentReplayRejectedCount}`,
      "A true live-fixed claim still needs build, restart, probe, and a real Lark entry.",
    ),
    gate(
      "safety_boundaries",
      ["research_only", "no_execution_authority", "no_model_math_guessing"].every((entry) =>
        boundaries.includes(entry),
      ) &&
        params.loop.noRemoteFetchOccurred &&
        params.loop.noExecutionAuthority,
      `boundaries=${boundaries.join(",")} remoteFetch=${String(!params.loop.noRemoteFetchOccurred)} execution=${String(!params.loop.noExecutionAuthority)}`,
      "Never allow L5 promotion to imply trading, remote crawling, or hidden provider expansion.",
    ),
    gate(
      "multi_reviewer_arbitration",
      reviewerTasks.length >= 3 &&
        reviewPanelStatus === "three_model_panel_arbitrated" &&
        localArbitrationStatus === "passed" &&
        arbitrationReceiptPath.length > 0,
      `reviewPanel=${reviewPanelStatus} localArbitration=${localArbitrationStatus} reviewerTasks=${reviewerTasks.length} receipt=${arbitrationReceiptPath || "none"}`,
      "Keep this as local deterministic arbitration unless real provider review findings are actually attached.",
    ),
  ];
  const blocked = firstBlockedGate(gates);
  const passed = gates.filter((entry) => entry.status === "pass").length;
  const level =
    blocked === null ? "l5_ready" : params.l4.ok ? "l4_hardened_l5_blocked" : "below_l4";
  return {
    ok: blocked === null,
    level,
    score: {
      passed,
      total: gates.length,
    },
    generatedAt: new Date().toISOString(),
    gates,
    l4: {
      ok: params.l4.ok,
      level: params.l4.level,
      nextBlocker: params.l4.nextBlocker,
    },
    loop: {
      ok: params.loop.ok,
      temporaryWorkspace: params.loop.temporaryWorkspace,
      receiptPath: params.loop.memory.loopReceiptPath,
    },
    nextBlocker: blocked ?? "none",
    boundaries: {
      evalUsesTempLoopWorkspace: true,
      liveProbeNotPerformed: true,
      noRemoteFetchOccurred: true,
      noExecutionAuthority: true,
      protectedMemoryUntouched: true,
    },
  };
}

function formatText(payload: L5SystemEvalPayload): string {
  return [
    "LCX Agent L5 system eval",
    "",
    `level: ${payload.level}`,
    `ok: ${String(payload.ok)}`,
    `score: ${payload.score.passed}/${payload.score.total}`,
    `nextBlocker: ${payload.nextBlocker}`,
    "",
    "Gates:",
    ...payload.gates.map(
      (entry) => `- ${entry.status} ${entry.id}: ${entry.evidence}; next=${entry.nextPatch}`,
    ),
    "",
    `l4: ${payload.l4.level} ok=${String(payload.l4.ok)}`,
    `loop receipt: ${payload.loop.receiptPath}`,
    "",
    "Boundaries:",
    "- temp loop workspace only",
    "- no remote fetch",
    "- no trade or execution approval",
    "- protected memory untouched",
    "- live probe not performed by this command",
  ].join("\n");
}

export async function runL5SystemEval(
  opts: L5SystemEvalCommandOptions,
): Promise<L5SystemEvalPayload> {
  const l4 = await runL4SystemDoctor(opts);
  const loop = await runLanguageBrainLoopSmoke({
    fixtureDir: opts.fixtureDir,
    json: true,
  });
  return buildPayload({ l4, loop });
}

export async function l5SystemEvalCommand(
  opts: L5SystemEvalCommandOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const payload = await runL5SystemEval(opts);
  runtime.log(opts.json ? JSON.stringify(payload, null, 2) : formatText(payload));
}
