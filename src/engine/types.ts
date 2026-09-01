import type {
  FinanceBrainOrchestrationInput,
  FinanceBrainOrchestrationPlan,
} from "../agents/finance-brain-orchestration.js";
import type { SkillAutoCue } from "../auto-reply/reply/skill-autocue.js";

/** Stable boundary between LCX product control and any execution host. */
export const LCX_ENGINE_CONTRACT_VERSION = "lcx_engine_v1" as const;

export type LcxEngineRoute = "general" | "finance";
export type LcxEngineRiskTier = "standard" | "high";
export type LcxEngineOutcome = "completed";

export type LcxEngineRequest = Omit<FinanceBrainOrchestrationInput, "text"> & {
  prompt: string;
  requestId?: string;
  trigger?: string;
  /** Neutral adapter identity; it is metadata, not delivery authority. */
  adapterId?: string;
  /** A session-bound skill snapshot, if the ingress owner already has one. */
  availableSkillNames?: readonly string[];
};

export type LcxEnginePlan = {
  contractVersion: typeof LCX_ENGINE_CONTRACT_VERSION;
  requestId?: string;
  route: LcxEngineRoute;
  riskTier: LcxEngineRiskTier;
  financePlan?: FinanceBrainOrchestrationPlan;
  skillCue?: SkillAutoCue;
  requiredCapabilities: readonly string[];
  boundaries: readonly string[];
  /** Deterministic context safe to pass to a host as instructions. */
  systemContext?: string;
};

export type LcxEngineHostContext = {
  request: LcxEngineRequest;
  plan: LcxEnginePlan;
  /** This is routing context, never a tool-execution or learning receipt. */
  systemContext?: string;
};

export type LcxEngineHost<HostResult> = {
  /** Replaceable host identity, e.g. current OpenClaw embedded runner. */
  id: string;
  run: (context: LcxEngineHostContext) => Promise<HostResult>;
};

export type LcxEngineReceipt = {
  contractVersion: typeof LCX_ENGINE_CONTRACT_VERSION;
  requestId?: string;
  hostId: string;
  route: LcxEngineRoute;
  riskTier: LcxEngineRiskTier;
  outcome: LcxEngineOutcome;
  startedAt: string;
  completedAt: string;
  boundaries: readonly string[];
};

export type LcxEngineRunResult<HostResult> = {
  hostResult: HostResult;
  plan: LcxEnginePlan;
  receipt: LcxEngineReceipt;
};

export type LcxEngine<HostResult> = {
  plan: (request: LcxEngineRequest) => LcxEnginePlan;
  run: (request: LcxEngineRequest) => Promise<LcxEngineRunResult<HostResult>>;
};
