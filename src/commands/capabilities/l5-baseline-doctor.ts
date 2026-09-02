import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import {
  runLanguageBrainLoopSmoke,
  type LanguageBrainLoopSmokeCommandOptions,
  type LanguageBrainLoopSmokePayload,
} from "./language-brain-loop-smoke.js";

export type L5BaselineDoctorCommandOptions = LanguageBrainLoopSmokeCommandOptions;

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
  loop: {
    ok: boolean;
    workspaceDir: string;
    temporaryWorkspace: boolean;
    receiptPath: string;
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
  boundaries: {
    doctorIsReadOnly: true;
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

function gate(id: string, pass: boolean, evidence: string): L5BaselineGate {
  return { id, status: pass ? "pass" : "fail", evidence };
}

function buildPayload(loop: LanguageBrainLoopSmokePayload): L5BaselineDoctorPayload {
  const primaryModules = stringArray(loop.orchestration.primaryModules);
  const requiredTools = stringArray(loop.orchestration.requiredTools);
  const boundaries = stringArray(loop.orchestration.boundaries);
  const gates = [
    gate(
      "local_language_brain_loop",
      loop.ok && loop.language.backendTool === "finance_learning_pipeline_orchestrator",
      `ok=${String(loop.ok)} backend=${String(loop.language.backendTool)}`,
    ),
    gate(
      "finance_brain_orchestration",
      ["etf_regime", "portfolio_risk_gates", "quant_math", "causal_map"].every((entry) =>
        primaryModules.includes(entry),
      ) &&
        ["finance_learning_capability_apply", "quant_math", "review_panel"].every((entry) =>
          requiredTools.includes(entry),
        ),
      `modules=${primaryModules.join(",")} tools=${requiredTools.join(",")}`,
    ),
    gate(
      "risk_and_math_boundaries",
      ["research_only", "no_execution_authority", "no_model_math_guessing"].every((entry) =>
        boundaries.includes(entry),
      ) && loop.noExecutionAuthority,
      `boundaries=${boundaries.join(",")} noExecutionAuthority=${String(loop.noExecutionAuthority)}`,
    ),
    gate(
      "local_receipt_integrity",
      Boolean(loop.memory.loopReceiptPath) &&
        loop.protectedMemoryUntouched &&
        loop.languageCorpusUntouched,
      `receipt=${loop.memory.loopReceiptPath} protectedMemoryUntouched=${String(loop.protectedMemoryUntouched)} languageCorpusUntouched=${String(loop.languageCorpusUntouched)}`,
    ),
    gate(
      "external_channel_boundary",
      loop.noRemoteFetchOccurred && loop.noExecutionAuthority,
      "External delivery is a separate runtime boundary and was not probed by this local doctor.",
    ),
  ];
  const failed = gates.find((entry) => entry.status === "fail")?.id;
  return {
    ok: failed === undefined,
    level: failed === undefined ? "l5_baseline_ready" : "l5_baseline_blocked",
    generatedAt: new Date().toISOString(),
    gates,
    loop: {
      ok: loop.ok,
      workspaceDir: loop.workspaceDir,
      temporaryWorkspace: loop.temporaryWorkspace,
      receiptPath: loop.memory.loopReceiptPath,
    },
    brain: {
      localLoopOk: loop.ok,
      family: loop.language.family,
      backendTool: loop.language.backendTool,
      analysisStatus: loop.analysis.eventReviewStatus,
      primaryModules,
      requiredTools,
      boundaries,
    },
    nextBlocker: failed ?? "none",
    boundaries: {
      doctorIsReadOnly: true,
      liveProbeNotPerformed: true,
      noRemoteFetchOccurred: true,
      noExecutionAuthority: true,
      protectedMemoryUntouched: true,
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
    `loop receipt: ${payload.loop.receiptPath}`,
    `brain family: ${String(payload.brain.family)}`,
    `brain backend: ${String(payload.brain.backendTool)}`,
    `brain modules: ${payload.brain.primaryModules.join(", ")}`,
    "",
    "Boundaries:",
    "- read-only doctor",
    "- no remote fetch",
    "- no trade or execution approval",
    "- protected memory untouched",
    "- external channel not probed by this command",
  ].join("\n");
}

export async function runL5BaselineDoctor(
  opts: L5BaselineDoctorCommandOptions,
): Promise<L5BaselineDoctorPayload> {
  return buildPayload(await runLanguageBrainLoopSmoke(opts));
}

export async function l5BaselineDoctorCommand(
  opts: L5BaselineDoctorCommandOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const payload = await runL5BaselineDoctor(opts);
  runtime.log(opts.json ? JSON.stringify(payload, null, 2) : formatText(payload));
}
