import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { resolveMinimaxDefaultTextModelId } from "../../../src/agents/minimax-model-catalog.js";
import { installSkill } from "../../../src/agents/skills-install.js";
import { buildWorkspaceSkillStatus } from "../../../src/agents/skills-status.js";
import { serializeByKey } from "../../../src/agents/skills/serialize.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { randomIdempotencyKey, callGateway } from "../../../src/gateway/call.js";
import {
  buildMarketIntelligenceArtifactJsonRelativePath,
  buildMarketIntelligenceArtifactMarkdownRelativePath,
  buildMarketIntelligenceMemoryNoteFilename,
  extractIsoDateKey,
  parseCurrentResearchLineArtifact,
  parseMarketIntelligenceRuntimeArtifact,
  renderMarketIntelligenceMemoryNote,
  renderMarketIntelligenceRuntimeArtifact,
  type MarketIntelligenceChallengeFinding,
  type MarketIntelligenceConfidenceBand,
  type MarketIntelligenceHypothesis,
  type MarketIntelligenceMaterialChangeFlag,
  type MarketIntelligenceRuntimeArtifact,
  type MarketIntelligenceSkillReceipt,
  type MarketIntelligenceSurvivorThesis,
  type ParsedCurrentResearchLineArtifact,
  type ParsedMarketIntelligenceRuntimeArtifact,
} from "../../../src/hooks/bundled/lobster-brain-registry.js";
import { writeFileWithinRoot } from "../../../src/infra/fs-safe.js";
import { recordOperationalAnomaly } from "../../../src/infra/operational-anomalies.js";
import { runCommandWithTimeout } from "../../../src/process/exec.js";

const MARKET_INTELLIGENCE_TOPIC_KEY = "same-day-etf-index-macro-packet";
const MARKET_INTELLIGENCE_RECENT_WINDOW_HOURS = 72;
const MARKET_INTELLIGENCE_APPROVED_SKILLS = {
  summarize: {
    skillName: "summarize",
    reason: "explicit URL ingestion for bounded source digestion",
  },
} as const;

type GatewayAgentPayload = {
  text?: string;
};

type GatewayAgentResponse = {
  summary?: string;
  result?: {
    payloads?: GatewayAgentPayload[];
  };
};

type MarketRole = "scout" | "synthesizer" | "challenger" | "arbiter";

type ScoutOutput = {
  hypothesisSet: MarketIntelligenceHypothesis[];
  evidenceGaps: string[];
  materialChangeFlag: MarketIntelligenceMaterialChangeFlag;
  materialChangeReasons: string[];
  followUpCandidates: string[];
  doNotContinueReason?: string;
  confidenceBand: MarketIntelligenceConfidenceBand;
};

type SynthesisOutput = {
  hypothesisSet: MarketIntelligenceHypothesis[];
  evidenceGaps: string[];
  followUpCandidates: string[];
  confidenceBand: MarketIntelligenceConfidenceBand;
};

type ChallengeOutput = {
  challengeFindings: MarketIntelligenceChallengeFinding[];
  survivingThesisIds: string[];
  rejectedThesisIds: string[];
};

type ArbiterOutput = {
  survivorTheses: MarketIntelligenceSurvivorThesis[];
  followUpCandidates: string[];
  doNotContinueReason?: string;
  confidenceBand: MarketIntelligenceConfidenceBand;
};

type MarketRoleRun<T> = {
  role: MarketRole;
  model: string;
  success: boolean;
  parsed?: T;
  rawText: string;
  error?: string;
};

type SkillPreparation =
  | { state: "not_needed"; reason: string }
  | { state: "denied"; reason: string; message?: string }
  | { state: "install_failed"; reason: string; message?: string; warnings?: string[] }
  | {
      state: "ready";
      installState: "activated_existing" | "ready_after_install";
      reason: string;
      installId?: string;
      message?: string;
      warnings?: string[];
    };

function pickGatewayText(response: GatewayAgentResponse): string {
  const texts =
    response.result?.payloads
      ?.map((payload) => payload.text?.trim())
      .filter((value): value is string => Boolean(value)) ?? [];
  if (texts.length > 0) {
    return texts.join("\n\n").trim();
  }
  return response.summary?.trim() ?? "";
}

function sanitizeStem(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function trimLine(value: string, maxChars = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 13).trimEnd()} [truncated]`;
}

function normalizeDigestText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseConfidenceBand(value: unknown): MarketIntelligenceConfidenceBand | undefined {
  switch (value) {
    case "low":
    case "medium":
    case "guarded_high":
      return value;
    default:
      return undefined;
  }
}

function parseMaterialChangeFlag(value: unknown): MarketIntelligenceMaterialChangeFlag | undefined {
  switch (value) {
    case "material":
    case "no_material_change":
    case "unclear":
      return value;
    default:
      return undefined;
  }
}

function parseStringArray(value: unknown, maxItems = 6): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function parseHypothesisSet(value: unknown, maxItems = 3): MarketIntelligenceHypothesis[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const hypothesis = item as {
        id?: unknown;
        label?: unknown;
        stance?: unknown;
        thesis?: unknown;
        key_drivers?: unknown;
        keyDrivers?: unknown;
      };
      const id = typeof hypothesis.id === "string" ? hypothesis.id.trim() : "";
      const label = typeof hypothesis.label === "string" ? hypothesis.label.trim() : "";
      const thesis = typeof hypothesis.thesis === "string" ? hypothesis.thesis.trim() : "";
      const stance =
        hypothesis.stance === "bullish" ||
        hypothesis.stance === "bearish" ||
        hypothesis.stance === "mixed"
          ? hypothesis.stance
          : undefined;
      if (!id || !label || !thesis || !stance) {
        return undefined;
      }
      return {
        id,
        label,
        stance,
        thesis,
        keyDrivers: parseStringArray(hypothesis.keyDrivers ?? hypothesis.key_drivers, 5),
      } satisfies MarketIntelligenceHypothesis;
    })
    .filter((item): item is MarketIntelligenceHypothesis => Boolean(item))
    .slice(0, maxItems);
}

function parseChallengeFindings(
  value: unknown,
  maxItems = 6,
): MarketIntelligenceChallengeFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const finding = item as {
        thesis_id?: unknown;
        thesisId?: unknown;
        finding?: unknown;
        severity?: unknown;
        evidence_needed?: unknown;
        evidenceNeeded?: unknown;
      };
      const thesisId =
        typeof (finding.thesisId ?? finding.thesis_id) === "string"
          ? String(finding.thesisId ?? finding.thesis_id).trim()
          : "";
      const findingText = typeof finding.finding === "string" ? finding.finding.trim() : "";
      const evidenceNeeded =
        typeof (finding.evidenceNeeded ?? finding.evidence_needed) === "string"
          ? String(finding.evidenceNeeded ?? finding.evidence_needed).trim()
          : "";
      const severity =
        finding.severity === "low" || finding.severity === "medium" || finding.severity === "high"
          ? finding.severity
          : undefined;
      if (!thesisId || !findingText || !evidenceNeeded || !severity) {
        return undefined;
      }
      return {
        thesisId,
        finding: findingText,
        severity,
        evidenceNeeded,
      } satisfies MarketIntelligenceChallengeFinding;
    })
    .filter((item): item is MarketIntelligenceChallengeFinding => Boolean(item))
    .slice(0, maxItems);
}

function parseSurvivorTheses(value: unknown, maxItems = 3): MarketIntelligenceSurvivorThesis[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const thesis = item as {
        thesis_id?: unknown;
        thesisId?: unknown;
        label?: unknown;
        why_survived?: unknown;
        whySurvived?: unknown;
      };
      const thesisId =
        typeof (thesis.thesisId ?? thesis.thesis_id) === "string"
          ? String(thesis.thesisId ?? thesis.thesis_id).trim()
          : "";
      const label = typeof thesis.label === "string" ? thesis.label.trim() : "";
      const whySurvived =
        typeof (thesis.whySurvived ?? thesis.why_survived) === "string"
          ? String(thesis.whySurvived ?? thesis.why_survived).trim()
          : "";
      if (!thesisId || !label || !whySurvived) {
        return undefined;
      }
      return { thesisId, label, whySurvived } satisfies MarketIntelligenceSurvivorThesis;
    })
    .filter((item): item is MarketIntelligenceSurvivorThesis => Boolean(item))
    .slice(0, maxItems);
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("empty JSON response");
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("no JSON object found");
    }
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  }
}

function parseScoutOutput(text: string): ScoutOutput {
  const parsed = parseJsonObject(text) as {
    hypothesis_set?: unknown;
    hypothesisSet?: unknown;
    evidence_gaps?: unknown;
    evidenceGaps?: unknown;
    material_change_flag?: unknown;
    materialChangeFlag?: unknown;
    material_change_reasons?: unknown;
    materialChangeReasons?: unknown;
    follow_up_candidates?: unknown;
    followUpCandidates?: unknown;
    do_not_continue_reason?: unknown;
    doNotContinueReason?: unknown;
    confidence_band?: unknown;
    confidenceBand?: unknown;
  };
  const hypothesisSet = parseHypothesisSet(parsed.hypothesisSet ?? parsed.hypothesis_set);
  const materialChangeFlag = parseMaterialChangeFlag(
    parsed.materialChangeFlag ?? parsed.material_change_flag,
  );
  const confidenceBand = parseConfidenceBand(parsed.confidenceBand ?? parsed.confidence_band);
  if (hypothesisSet.length < 2 || !materialChangeFlag || !confidenceBand) {
    throw new Error("invalid scout output");
  }
  return {
    hypothesisSet,
    evidenceGaps: parseStringArray(parsed.evidenceGaps ?? parsed.evidence_gaps, 8),
    materialChangeFlag,
    materialChangeReasons: parseStringArray(
      parsed.materialChangeReasons ?? parsed.material_change_reasons,
      6,
    ),
    followUpCandidates: parseStringArray(
      parsed.followUpCandidates ?? parsed.follow_up_candidates,
      6,
    ),
    doNotContinueReason:
      typeof (parsed.doNotContinueReason ?? parsed.do_not_continue_reason) === "string"
        ? String(parsed.doNotContinueReason ?? parsed.do_not_continue_reason).trim() || undefined
        : undefined,
    confidenceBand,
  };
}

function parseSynthesisOutput(text: string): SynthesisOutput {
  const parsed = parseJsonObject(text) as {
    hypothesis_set?: unknown;
    hypothesisSet?: unknown;
    evidence_gaps?: unknown;
    evidenceGaps?: unknown;
    follow_up_candidates?: unknown;
    followUpCandidates?: unknown;
    confidence_band?: unknown;
    confidenceBand?: unknown;
  };
  const hypothesisSet = parseHypothesisSet(parsed.hypothesisSet ?? parsed.hypothesis_set);
  const confidenceBand = parseConfidenceBand(parsed.confidenceBand ?? parsed.confidence_band);
  if (hypothesisSet.length < 2 || !confidenceBand) {
    throw new Error("invalid synthesis output");
  }
  return {
    hypothesisSet,
    evidenceGaps: parseStringArray(parsed.evidenceGaps ?? parsed.evidence_gaps, 8),
    followUpCandidates: parseStringArray(
      parsed.followUpCandidates ?? parsed.follow_up_candidates,
      6,
    ),
    confidenceBand,
  };
}

function parseChallengeOutput(text: string): ChallengeOutput {
  const parsed = parseJsonObject(text) as {
    challenge_findings?: unknown;
    challengeFindings?: unknown;
    surviving_thesis_ids?: unknown;
    survivingThesisIds?: unknown;
    rejected_thesis_ids?: unknown;
    rejectedThesisIds?: unknown;
  };
  return {
    challengeFindings: parseChallengeFindings(
      parsed.challengeFindings ?? parsed.challenge_findings,
      8,
    ),
    survivingThesisIds: parseStringArray(
      parsed.survivingThesisIds ?? parsed.surviving_thesis_ids,
      4,
    ),
    rejectedThesisIds: parseStringArray(parsed.rejectedThesisIds ?? parsed.rejected_thesis_ids, 4),
  };
}

function parseArbiterOutput(text: string): ArbiterOutput {
  const parsed = parseJsonObject(text) as {
    survivor_theses?: unknown;
    survivorTheses?: unknown;
    follow_up_candidates?: unknown;
    followUpCandidates?: unknown;
    do_not_continue_reason?: unknown;
    doNotContinueReason?: unknown;
    confidence_band?: unknown;
    confidenceBand?: unknown;
  };
  const survivorTheses = parseSurvivorTheses(parsed.survivorTheses ?? parsed.survivor_theses);
  const confidenceBand = parseConfidenceBand(parsed.confidenceBand ?? parsed.confidence_band);
  if (survivorTheses.length === 0 || !confidenceBand) {
    throw new Error("invalid arbiter output");
  }
  return {
    survivorTheses,
    followUpCandidates: parseStringArray(
      parsed.followUpCandidates ?? parsed.follow_up_candidates,
      6,
    ),
    doNotContinueReason:
      typeof (parsed.doNotContinueReason ?? parsed.do_not_continue_reason) === "string"
        ? String(parsed.doNotContinueReason ?? parsed.do_not_continue_reason).trim() || undefined
        : undefined,
    confidenceBand,
  };
}

function resolveMarketRoleModel(role: MarketRole): string {
  switch (role) {
    case "scout":
      return (
        process.env.OPENCLAW_MARKET_INTELLIGENCE_SCOUT_MODEL?.trim() || "qianfan/deepseek-v3.2"
      );
    case "synthesizer":
      return (
        process.env.OPENCLAW_MARKET_INTELLIGENCE_SYNTHESIZER_MODEL?.trim() || "moonshot/kimi-k2.5"
      );
    case "challenger":
      return (
        process.env.OPENCLAW_MARKET_INTELLIGENCE_CHALLENGER_MODEL?.trim() ||
        `minimax/${resolveMinimaxDefaultTextModelId()}`
      );
    case "arbiter":
      return process.env.OPENCLAW_MARKET_INTELLIGENCE_ARBITER_MODEL?.trim() || "openai/gpt-5.2";
  }
}

function dedupeLines(lines: string[], maxItems = 8): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const line of lines) {
    const normalized = normalizeDigestText(line).toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(trimLine(line));
    if (output.length >= maxItems) {
      break;
    }
  }
  return output;
}

function extractSourceRefs(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)>\]]+/giu) ?? [];
  return dedupeLines(
    matches.map((item) => item.replace(/[.,，。!?！？]+$/u, "")),
    2,
  );
}

async function loadCurrentResearchAnchor(
  workspaceDir: string,
): Promise<ParsedCurrentResearchLineArtifact | undefined> {
  try {
    const content = await fs.readFile(
      path.join(workspaceDir, "memory", "current-research-line.md"),
      "utf-8",
    );
    return parseCurrentResearchLineArtifact(content);
  } catch {
    return undefined;
  }
}

function buildAnchorSummary(anchor: ParsedCurrentResearchLineArtifact | undefined): string {
  if (!anchor) {
    return [
      "## Current research anchor",
      "- current-research-line unavailable or malformed; keep this packet provisional and do not pretend a stronger working-memory anchor exists.",
    ].join("\n");
  }
  return [
    "## Current research anchor",
    `- line_status: ${anchor.lineStatus}`,
    `- current_focus: ${trimLine(anchor.currentFocus)}`,
    `- top_decision: ${trimLine(anchor.topDecision)}`,
    anchor.currentSessionSummary
      ? `- current_session_summary: ${trimLine(anchor.currentSessionSummary)}`
      : "- current_session_summary: none",
    `- next_step: ${trimLine(anchor.nextStep)}`,
    `- research_guardrail: ${trimLine(anchor.researchGuardrail)}`,
  ].join("\n");
}

function buildSourceDigestSummary(sourceRefs: string[], sourceDigests: string[]): string {
  if (sourceRefs.length === 0) {
    return [
      "## Source ingestion",
      "- no explicit source URL was provided, so the packet stays on direct model reasoning plus the current anchor.",
    ].join("\n");
  }
  return [
    "## Source ingestion",
    `- explicit source refs: ${sourceRefs.join(", ")}`,
    ...(sourceDigests.length > 0
      ? sourceDigests.map(
          (digest, index) => `- source_digest_${index + 1}: ${trimLine(digest, 320)}`,
        )
      : ["- source digests unavailable; keep freshness and coverage discipline explicit."]),
  ].join("\n");
}

function buildScoutPrompt(params: {
  anchor: ParsedCurrentResearchLineArtifact | undefined;
  sourceRefs: string[];
  sourceDigests: string[];
}): string {
  return [
    "You are the scout/discover lane for a bounded same-day ETF / index / macro market-intelligence packet.",
    "Your job is to frame contrasting hypotheses cheaply, not to deliver a final verdict.",
    buildAnchorSummary(params.anchor),
    buildSourceDigestSummary(params.sourceRefs, params.sourceDigests),
    "Return JSON only. No markdown. Schema:",
    `{
  "hypothesis_set": [
    {"id":"h1","label":"short label","stance":"bullish|bearish|mixed","thesis":"one-sentence thesis","key_drivers":["driver 1","driver 2"]},
    {"id":"h2","label":"short label","stance":"bullish|bearish|mixed","thesis":"one-sentence thesis","key_drivers":["driver 1","driver 2"]}
  ],
  "evidence_gaps": ["gap"],
  "material_change_flag": "material|no_material_change|unclear",
  "material_change_reasons": ["reason"],
  "follow_up_candidates": ["follow-up"],
  "do_not_continue_reason": "optional string",
  "confidence_band": "low|medium|guarded_high"
}`,
    "Rules:",
    "- always return two or three contrasting hypotheses",
    "- focus on ETF/index/macro transmission, rates, dollar, duration, breadth, volatility, and risk appetite",
    "- if freshness is weak, say it through evidence_gaps and lower confidence",
    "- no execution advice, no position sizing, no fake certainty",
  ].join("\n");
}

function buildSynthesisPrompt(params: {
  scout: ScoutOutput;
  anchor: ParsedCurrentResearchLineArtifact | undefined;
  sourceDigests: string[];
}): string {
  return [
    "You are the synthesizer/thesis-builder lane for the same bounded ETF / index / macro packet.",
    "Your job is to sharpen the competing hypotheses into a causally cleaner packet.",
    buildAnchorSummary(params.anchor),
    buildSourceDigestSummary([], params.sourceDigests),
    "Scout object:",
    JSON.stringify(
      {
        hypothesis_set: params.scout.hypothesisSet,
        evidence_gaps: params.scout.evidenceGaps,
        material_change_flag: params.scout.materialChangeFlag,
        material_change_reasons: params.scout.materialChangeReasons,
        follow_up_candidates: params.scout.followUpCandidates,
        confidence_band: params.scout.confidenceBand,
      },
      null,
      2,
    ),
    "Return JSON only. No markdown. Schema:",
    `{
  "hypothesis_set": [
    {"id":"h1","label":"short label","stance":"bullish|bearish|mixed","thesis":"one-sentence thesis","key_drivers":["driver 1","driver 2"]},
    {"id":"h2","label":"short label","stance":"bullish|bearish|mixed","thesis":"one-sentence thesis","key_drivers":["driver 1","driver 2"]}
  ],
  "evidence_gaps": ["gap"],
  "follow_up_candidates": ["follow-up"],
  "confidence_band": "low|medium|guarded_high"
}`,
    "Rules:",
    "- keep two or three competing theses only",
    "- make the differences causal, not just stylistic",
    "- do not collapse to one false-precise winner yet",
  ].join("\n");
}

function buildChallengePrompt(params: { synthesis: SynthesisOutput }): string {
  return [
    "You are the challenger/auditor lane for the same bounded ETF / index / macro packet.",
    "Attack overconfidence, hidden assumptions, stale causality, and weak evidence.",
    "Synthesis object:",
    JSON.stringify(
      {
        hypothesis_set: params.synthesis.hypothesisSet,
        evidence_gaps: params.synthesis.evidenceGaps,
        follow_up_candidates: params.synthesis.followUpCandidates,
        confidence_band: params.synthesis.confidenceBand,
      },
      null,
      2,
    ),
    "Return JSON only. No markdown. Schema:",
    `{
  "challenge_findings": [
    {"thesis_id":"h1","finding":"what looks weak","severity":"low|medium|high","evidence_needed":"what evidence would settle it"}
  ],
  "surviving_thesis_ids": ["h1"],
  "rejected_thesis_ids": ["h2"]
}`,
    "Rules:",
    "- findings should be concrete and evidence-gated",
    "- reject only when the thesis is materially weaker than its rival",
    "- no execution advice",
  ].join("\n");
}

function buildArbiterPrompt(params: {
  scout: ScoutOutput;
  synthesis: SynthesisOutput;
  challenge?: ChallengeOutput;
}): string {
  return [
    "You are the arbiter/evidence gate for the same bounded ETF / index / macro packet.",
    "Select only the hypotheses that should survive this turn.",
    "Scout object:",
    JSON.stringify(params.scout, null, 2),
    "Synthesis object:",
    JSON.stringify(params.synthesis, null, 2),
    "Challenge object:",
    JSON.stringify(
      params.challenge ?? { challenge_findings: [], surviving_thesis_ids: [] },
      null,
      2,
    ),
    "Return JSON only. No markdown. Schema:",
    `{
  "survivor_theses": [
    {"thesis_id":"h1","label":"short label","why_survived":"short evidence-gated reason"}
  ],
  "follow_up_candidates": ["follow-up"],
  "do_not_continue_reason": "optional string",
  "confidence_band": "low|medium|guarded_high"
}`,
    "Rules:",
    "- at least one survivor unless the do_not_continue_reason is genuinely stronger",
    "- survivors must be explicitly evidence-gated",
    "- if uncertainty remains wide, keep confidence_band low or medium",
  ].join("\n");
}

async function runMarketRole<T>(params: {
  cfg: ClawdbotConfig;
  role: MarketRole;
  routeAgentId: string;
  baseSessionKey: string;
  userMessage: string;
  extraSystemPrompt: string;
  timeoutSeconds: number;
  thinking: "off" | "medium" | "high";
  parser: (text: string) => T;
}): Promise<MarketRoleRun<T>> {
  const model = resolveMarketRoleModel(params.role);
  try {
    const response = await callGateway<GatewayAgentResponse>({
      method: "agent",
      params: {
        message: params.userMessage,
        agentId: params.routeAgentId,
        sessionKey: `${params.baseSessionKey}:${params.role}`,
        model,
        thinking: params.thinking,
        timeout: params.timeoutSeconds,
        lane: "market-intelligence",
        extraSystemPrompt: params.extraSystemPrompt,
        idempotencyKey: randomIdempotencyKey(),
        label: `Market Intelligence: ${params.role}`,
      },
      expectFinal: true,
      timeoutMs: (params.timeoutSeconds + 45) * 1000,
    });
    const rawText = pickGatewayText(response);
    if (!rawText) {
      return { role: params.role, model, success: false, rawText: "", error: "empty response" };
    }
    return {
      role: params.role,
      model,
      success: true,
      parsed: params.parser(rawText),
      rawText,
    };
  } catch (error) {
    return {
      role: params.role,
      model,
      success: false,
      rawText: "",
      error: String(error),
    };
  }
}

function summarizeJsonOutput(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      summary?: unknown;
      text?: unknown;
      content?: unknown;
      markdown?: unknown;
      transcript?: unknown;
      title?: unknown;
      items?: unknown;
    };
    const candidates = [
      parsed.summary,
      parsed.text,
      parsed.content,
      parsed.markdown,
      parsed.transcript,
      parsed.title,
    ]
      .filter((item): item is string => typeof item === "string")
      .map((item) => normalizeDigestText(item));
    if (candidates.length > 0) {
      return candidates[0];
    }
  } catch {
    // fallback below
  }
  return normalizeDigestText(trimmed);
}

async function prepareSummarizeSkill(params: {
  cfg: ClawdbotConfig;
  workspaceDir: string;
  sourceRefs: string[];
}): Promise<SkillPreparation> {
  if (params.sourceRefs.length === 0) {
    return {
      state: "not_needed",
      reason: "no explicit URL source was provided for bounded skill ingestion",
    };
  }

  const resolveStatus = () =>
    buildWorkspaceSkillStatus(params.workspaceDir, {
      config: params.cfg as OpenClawConfig,
    }).skills.find(
      (skill) => skill.skillKey === MARKET_INTELLIGENCE_APPROVED_SKILLS.summarize.skillName,
    );

  const skill = resolveStatus();
  if (!skill) {
    return {
      state: "denied",
      reason: "approved skill is not present in the bounded registry",
    };
  }
  if (skill.disabled || skill.blockedByAllowlist) {
    return {
      state: "denied",
      reason: "approved skill is blocked by local skill policy",
    };
  }
  if (skill.eligible) {
    return {
      state: "ready",
      installState: "activated_existing",
      reason: "approved summarize skill is already available",
    };
  }
  const installOption = skill.install[0];
  if (!installOption) {
    return {
      state: "install_failed",
      reason: "approved summarize skill is missing and has no bounded install path",
    };
  }

  return serializeByKey(`market-intelligence-skill:${params.workspaceDir}:summarize`, async () => {
    const refreshed = resolveStatus();
    if (!refreshed) {
      return {
        state: "denied",
        reason: "approved skill disappeared from the bounded registry before install",
      } satisfies SkillPreparation;
    }
    if (refreshed.eligible) {
      return {
        state: "ready",
        installState: "activated_existing",
        reason: "approved summarize skill became available before install",
      } satisfies SkillPreparation;
    }
    const result = await installSkill({
      workspaceDir: params.workspaceDir,
      skillName: refreshed.name,
      installId: installOption.id,
      config: params.cfg as OpenClawConfig,
    });
    const postInstall = resolveStatus();
    if (!result.ok || !postInstall?.eligible) {
      return {
        state: "install_failed",
        reason: "approved summarize skill install did not yield a usable bounded capability",
        message: result.message,
        warnings: result.warnings,
      } satisfies SkillPreparation;
    }
    return {
      state: "ready",
      installState: "ready_after_install",
      reason: "approved summarize skill was installed inside the bounded registry",
      installId: installOption.id,
      message: result.message,
      warnings: result.warnings,
    } satisfies SkillPreparation;
  });
}

async function collectSourceDigests(params: {
  cfg: ClawdbotConfig;
  workspaceDir: string;
  sourceRefs: string[];
}): Promise<{
  sourceDigests: string[];
  skillReceipt: MarketIntelligenceSkillReceipt;
}> {
  const prep = await prepareSummarizeSkill(params);
  if (prep.state === "not_needed") {
    return {
      sourceDigests: [],
      skillReceipt: {
        skillName: MARKET_INTELLIGENCE_APPROVED_SKILLS.summarize.skillName,
        status: "not_needed",
        reason: prep.reason,
      },
    };
  }
  if (prep.state === "denied") {
    return {
      sourceDigests: [],
      skillReceipt: {
        skillName: MARKET_INTELLIGENCE_APPROVED_SKILLS.summarize.skillName,
        status: "denied",
        reason: prep.reason,
        message: prep.message,
      },
    };
  }
  if (prep.state === "install_failed") {
    return {
      sourceDigests: [],
      skillReceipt: {
        skillName: MARKET_INTELLIGENCE_APPROVED_SKILLS.summarize.skillName,
        status: "install_failed",
        reason: prep.reason,
        message: prep.message,
        warnings: prep.warnings,
      },
    };
  }

  const digests: string[] = [];
  try {
    for (const ref of params.sourceRefs) {
      const result = await runCommandWithTimeout(
        ["summarize", ref, "--length", "short", "--max-output-tokens", "600", "--json"],
        {
          cwd: params.workspaceDir,
          timeoutMs: 90_000,
        },
      );
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `summarize exited with code ${result.code}`);
      }
      const digest = summarizeJsonOutput(result.stdout);
      if (digest) {
        digests.push(`${ref}: ${trimLine(digest, 280)}`);
      }
    }
    return {
      sourceDigests: dedupeLines(digests, 4),
      skillReceipt: {
        skillName: MARKET_INTELLIGENCE_APPROVED_SKILLS.summarize.skillName,
        status:
          prep.installState === "ready_after_install" ? "installed_and_used" : "activated_existing",
        reason: prep.reason,
        installId: prep.installId,
        message: prep.message,
        warnings: prep.warnings,
      },
    };
  } catch (error) {
    return {
      sourceDigests: [],
      skillReceipt: {
        skillName: MARKET_INTELLIGENCE_APPROVED_SKILLS.summarize.skillName,
        status: "use_failed",
        reason: "approved summarize skill was available but source digestion failed",
        installId: prep.installId,
        message: String(error),
        warnings: prep.warnings,
      },
    };
  }
}

function buildFingerprint(params: {
  anchor: ParsedCurrentResearchLineArtifact | undefined;
  scout: ScoutOutput;
  sourceDigests: string[];
}): string {
  const payload = JSON.stringify({
    topicKey: MARKET_INTELLIGENCE_TOPIC_KEY,
    currentFocus: params.anchor?.currentFocus ?? "",
    topDecision: params.anchor?.topDecision ?? "",
    sourceDigests: params.sourceDigests.map((item) => normalizeDigestText(item)),
    materialChangeFlag: params.scout.materialChangeFlag,
    materialChangeReasons: params.scout.materialChangeReasons.map((item) =>
      normalizeDigestText(item),
    ),
    hypothesisSet: params.scout.hypothesisSet.map((item) => ({
      id: item.id,
      label: normalizeDigestText(item.label),
      stance: item.stance,
      thesis: normalizeDigestText(item.thesis),
      keyDrivers: item.keyDrivers.map((driver) => normalizeDigestText(driver)),
    })),
    evidenceGaps: params.scout.evidenceGaps.map((item) => normalizeDigestText(item)),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

async function loadRecentPacket(params: {
  workspaceDir: string;
  topicKey: string;
  generatedAt: string;
}): Promise<(ParsedMarketIntelligenceRuntimeArtifact & { relativePath: string }) | undefined> {
  const dir = path.join(params.workspaceDir, "bank", "knowledge", "market-intelligence");
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return undefined;
  }
  const nowMs = Date.parse(params.generatedAt);
  const packets = await Promise.all(
    files.map(async (name) => {
      try {
        const relativePath = `bank/knowledge/market-intelligence/${name}`;
        const content = await fs.readFile(path.join(dir, name), "utf-8");
        const parsed = parseMarketIntelligenceRuntimeArtifact(content);
        if (!parsed || parsed.topicKey !== params.topicKey) {
          return undefined;
        }
        const ageMs = nowMs - Date.parse(parsed.generatedAt);
        if (!(ageMs >= 0 && ageMs <= MARKET_INTELLIGENCE_RECENT_WINDOW_HOURS * 60 * 60 * 1000)) {
          return undefined;
        }
        return { ...parsed, relativePath };
      } catch {
        return undefined;
      }
    }),
  );
  return packets
    .filter(
      (
        packet,
      ): packet is ParsedMarketIntelligenceRuntimeArtifact & {
        relativePath: string;
      } => Boolean(packet),
    )
    .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))[0];
}

function buildFallbackSurvivors(params: {
  hypotheses: MarketIntelligenceHypothesis[];
  challenge?: ChallengeOutput;
}): MarketIntelligenceSurvivorThesis[] {
  const rejected = new Set(params.challenge?.rejectedThesisIds ?? []);
  const challengedHigh = new Set(
    (params.challenge?.challengeFindings ?? [])
      .filter((finding) => finding.severity === "high")
      .map((finding) => finding.thesisId),
  );
  return params.hypotheses
    .filter((item) => !rejected.has(item.id) && !challengedHigh.has(item.id))
    .slice(0, 2)
    .map((item) => ({
      thesisId: item.id,
      label: item.label,
      whySurvived:
        params.challenge && params.challenge.survivingThesisIds.includes(item.id)
          ? "survived the bounded challenge pass."
          : "survived the deterministic fallback gate because no decisive challenge removed it.",
    }));
}

function buildOperatorSummaryLines(params: {
  noMaterialChange: boolean;
  survivorTheses: MarketIntelligenceSurvivorThesis[];
  evidenceGaps: string[];
  followUpCandidates: string[];
  skillReceipt: MarketIntelligenceSkillReceipt;
}): string[] {
  return dedupeLines(
    [
      params.noMaterialChange
        ? "No material change survived the bounded recent-run gate."
        : "Material change survived the bounded research gate.",
      ...params.survivorTheses.map((item) => `${item.label}: ${item.whySurvived}`),
      ...params.evidenceGaps.slice(0, 2).map((item) => `gap: ${item}`),
      ...params.followUpCandidates.slice(0, 2).map((item) => `follow-up: ${item}`),
      `skill: ${params.skillReceipt.skillName} / ${params.skillReceipt.status}`,
    ],
    6,
  );
}

function renderFinalReply(artifact: MarketIntelligenceRuntimeArtifact): string {
  return [
    "## Market Intelligence Packet",
    `- task: same-day ETF / index / macro intelligence packet`,
    `- material change: ${artifact.materialChangeFlag}`,
    `- confidence band: ${artifact.confidenceBand}`,
    ...(artifact.comparedAgainst
      ? [
          `- compared against: ${artifact.comparedAgainst.artifactPath}`,
          `- prior fingerprint matched: ${artifact.comparedAgainst.fingerprintMatched ? "yes" : "no"}`,
        ]
      : []),
    "",
    "### Competing theses",
    ...artifact.hypothesisSet.map(
      (item) =>
        `- ${item.label} [${item.stance}]: ${item.thesis}${item.keyDrivers.length > 0 ? ` | drivers: ${item.keyDrivers.join("; ")}` : ""}`,
    ),
    "",
    "### Evidence gaps",
    ...(artifact.evidenceGaps.length > 0
      ? artifact.evidenceGaps.map((item) => `- ${item}`)
      : ["- no explicit evidence gap survived this bounded pass."]),
    ...(artifact.challengeFindings.length > 0
      ? [
          "",
          "### Challenge findings",
          ...artifact.challengeFindings.map(
            (item) =>
              `- ${item.thesisId} [${item.severity}]: ${item.finding} | evidence needed: ${item.evidenceNeeded}`,
          ),
        ]
      : []),
    "",
    "### Survivor theses",
    ...(artifact.survivorTheses.length > 0
      ? artifact.survivorTheses.map(
          (item) => `- ${item.label}: ${item.whySurvived} [${item.thesisId}]`,
        )
      : ["- no thesis survived strongly enough; keep the packet provisional."]),
    "",
    "### Follow-up candidates",
    ...(artifact.followUpCandidates.length > 0
      ? artifact.followUpCandidates.map((item) => `- ${item}`)
      : ["- no follow-up candidate survived this pass."]),
    ...(artifact.doNotContinueReason
      ? ["", "### Do not continue", `- ${artifact.doNotContinueReason}`]
      : []),
    "",
    "### Skill receipt",
    `- ${artifact.sourceContext.skillReceipt.skillName}: ${artifact.sourceContext.skillReceipt.status}`,
    `- why selected: ${artifact.sourceContext.skillReceipt.reason}`,
    ...(artifact.sourceContext.skillReceipt.message
      ? [`- receipt: ${trimLine(artifact.sourceContext.skillReceipt.message)}`]
      : []),
    ...(artifact.sourceContext.sourceDigests.length > 0
      ? artifact.sourceContext.sourceDigests.map((item) => `- used digest: ${trimLine(item, 280)}`)
      : ["- no source digest was used in this run."]),
    "",
    "### Distilled residue",
    ...(artifact.distillation.retainedResidueLines.length > 0
      ? artifact.distillation.retainedResidueLines.map((item) => `- ${item}`)
      : ["- no residue line survived strongly enough yet."]),
  ].join("\n");
}

async function persistMarketIntelligenceArtifact(params: {
  workspaceDir: string;
  stem: string;
  artifact: MarketIntelligenceRuntimeArtifact;
}): Promise<void> {
  await writeFileWithinRoot({
    rootDir: params.workspaceDir,
    relativePath: buildMarketIntelligenceArtifactJsonRelativePath(params.stem),
    data: renderMarketIntelligenceRuntimeArtifact(params.artifact),
    encoding: "utf-8",
    mkdir: true,
  });
  await writeFileWithinRoot({
    rootDir: params.workspaceDir,
    relativePath: buildMarketIntelligenceArtifactMarkdownRelativePath(params.stem),
    data: params.artifact.finalReply,
    encoding: "utf-8",
    mkdir: true,
  });
  await writeFileWithinRoot({
    rootDir: params.workspaceDir,
    relativePath: params.artifact.distillation.memoryNotePath,
    data: renderMarketIntelligenceMemoryNote(params.artifact),
    encoding: "utf-8",
    mkdir: true,
  });
}

export async function runFeishuMarketIntelligencePacket(params: {
  cfg: ClawdbotConfig;
  userMessage: string;
  routeAgentId: string;
  sessionKey: string;
  messageId: string;
  workspaceDir: string;
}): Promise<string> {
  const generatedAt = new Date().toISOString();
  const dateStr = extractIsoDateKey(generatedAt) || "1970-01-01";
  const stem = sanitizeStem(`${dateStr}-${MARKET_INTELLIGENCE_TOPIC_KEY}-${params.messageId}`);
  const memoryNotePath = `memory/${buildMarketIntelligenceMemoryNoteFilename({
    dateStr,
    noteSlug: stem,
  })}`;
  const anchor = await loadCurrentResearchAnchor(params.workspaceDir);
  const sourceRefs = extractSourceRefs(params.userMessage);
  const { sourceDigests, skillReceipt } = await collectSourceDigests({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    sourceRefs,
  });
  const baseSessionKey = `${params.sessionKey}:market-intelligence:${params.messageId}`;

  const scoutRun = await runMarketRole({
    cfg: params.cfg,
    role: "scout",
    routeAgentId: params.routeAgentId,
    baseSessionKey,
    userMessage: params.userMessage,
    extraSystemPrompt: buildScoutPrompt({ anchor, sourceRefs, sourceDigests }),
    timeoutSeconds: 180,
    thinking: "off",
    parser: parseScoutOutput,
  });

  if (!scoutRun.success || !scoutRun.parsed) {
    return [
      "## Market Intelligence Packet",
      "- status: failed_closed",
      `- scout failure: ${scoutRun.error ?? "unable to extract bounded scout object"}`,
      "- current judgment: do not pretend a same-day ETF / index / macro packet was completed.",
      `- skill receipt: ${skillReceipt.skillName} / ${skillReceipt.status}`,
    ].join("\n");
  }

  const fingerprint = buildFingerprint({
    anchor,
    scout: scoutRun.parsed,
    sourceDigests,
  });
  const recentPacket = await loadRecentPacket({
    workspaceDir: params.workspaceDir,
    topicKey: MARKET_INTELLIGENCE_TOPIC_KEY,
    generatedAt,
  });
  const recentFingerprintMatched = recentPacket?.fingerprint === fingerprint;
  const noMaterialChange =
    recentFingerprintMatched ||
    (Boolean(recentPacket) && scoutRun.parsed.materialChangeFlag === "no_material_change");

  if (noMaterialChange && recentPacket) {
    const survivorTheses = recentPacket.survivorTheses;
    const artifact: MarketIntelligenceRuntimeArtifact = {
      version: 1,
      generatedAt,
      messageId: params.messageId,
      userMessage: params.userMessage,
      topicKey: MARKET_INTELLIGENCE_TOPIC_KEY,
      fingerprint,
      materialChangeFlag: "no_material_change",
      materialChangeReasons: dedupeLines(
        [
          recentFingerprintMatched
            ? `same fingerprint as ${recentPacket.relativePath}`
            : "scout lane found no material change against the recent packet window",
          ...scoutRun.parsed.materialChangeReasons,
        ],
        4,
      ),
      noMaterialChange: true,
      confidenceBand: recentPacket.confidenceBand,
      anchor: {
        lineStatus: anchor?.lineStatus,
        currentFocus: anchor?.currentFocus,
        topDecision: anchor?.topDecision,
        currentSessionSummary: anchor?.currentSessionSummary,
        nextStep: anchor?.nextStep,
        researchGuardrail: anchor?.researchGuardrail,
      },
      sourceContext: {
        sourceRefs,
        sourceDigests,
        skillReceipt,
      },
      routing: {
        scout: { model: scoutRun.model, ran: true },
        synthesizer: {
          model: resolveMarketRoleModel("synthesizer"),
          ran: false,
          skippedReason: "recent fingerprint matched or scout flagged no material change",
        },
        challenger: {
          model: resolveMarketRoleModel("challenger"),
          ran: false,
          skippedReason: "recent packet was sufficient; challenge lane skipped",
        },
        arbiter: {
          model: resolveMarketRoleModel("arbiter"),
          ran: false,
          skippedReason: "recent survivor set reused",
        },
        distiller: { mode: "deterministic" },
      },
      hypothesisSet: recentPacket.hypothesisSet,
      evidenceGaps: recentPacket.evidenceGaps,
      challengeFindings: recentPacket.challengeFindings,
      survivorTheses,
      followUpCandidates: recentPacket.followUpCandidates,
      doNotContinueReason:
        scoutRun.parsed.doNotContinueReason ??
        `no material change versus ${recentPacket.relativePath}`,
      comparedAgainst: {
        generatedAt: recentPacket.generatedAt,
        artifactPath: recentPacket.relativePath,
        fingerprint: recentPacket.fingerprint,
        fingerprintMatched: recentFingerprintMatched,
      },
      distillation: {
        retainedResidueLines: dedupeLines(
          [
            ...recentPacket.retainedResidueLines,
            `No material change versus ${recentPacket.generatedAt}; keep prior survivor set instead of rewriting the packet.`,
          ],
          5,
        ),
        downrankedLines: [],
        operatorSummaryLines: buildOperatorSummaryLines({
          noMaterialChange: true,
          survivorTheses,
          evidenceGaps: recentPacket.evidenceGaps,
          followUpCandidates: recentPacket.followUpCandidates,
          skillReceipt,
        }),
        memoryNotePath,
      },
      finalReply: "",
    };
    artifact.finalReply = renderFinalReply(artifact);
    try {
      await persistMarketIntelligenceArtifact({
        workspaceDir: params.workspaceDir,
        stem,
        artifact,
      });
    } catch (error) {
      await recordOperationalAnomaly({
        cfg: params.cfg,
        category: "market_intelligence_persist_failure",
        severity: "medium",
        source: "feishu.market_intelligence",
        problem: "failed to persist market-intelligence artifact",
        impact:
          "The bounded market-intelligence packet completed, but its structured audit artifact was not retained for later comparison.",
        suggestedScope:
          "Inspect market-intelligence artifact persistence without widening learning-command routing or finance governance surfaces.",
        evidence: [`error: ${String(error)}`],
      });
      return [
        artifact.finalReply,
        "",
        "## Persistence",
        "- structured packet persistence failed; keep this run provisional.",
      ].join("\n");
    }
    return artifact.finalReply;
  }

  const synthRun = await runMarketRole({
    cfg: params.cfg,
    role: "synthesizer",
    routeAgentId: params.routeAgentId,
    baseSessionKey,
    userMessage: params.userMessage,
    extraSystemPrompt: buildSynthesisPrompt({
      scout: scoutRun.parsed,
      anchor,
      sourceDigests,
    }),
    timeoutSeconds: 300,
    thinking: "medium",
    parser: parseSynthesisOutput,
  });

  const synthesis =
    synthRun.success && synthRun.parsed
      ? synthRun.parsed
      : ({
          hypothesisSet: scoutRun.parsed.hypothesisSet,
          evidenceGaps: scoutRun.parsed.evidenceGaps,
          followUpCandidates: scoutRun.parsed.followUpCandidates,
          confidenceBand: scoutRun.parsed.confidenceBand,
        } satisfies SynthesisOutput);

  const challengeShouldRun = synthesis.hypothesisSet.length >= 2;
  const challengeRun = challengeShouldRun
    ? await runMarketRole({
        cfg: params.cfg,
        role: "challenger",
        routeAgentId: params.routeAgentId,
        baseSessionKey,
        userMessage: params.userMessage,
        extraSystemPrompt: buildChallengePrompt({ synthesis }),
        timeoutSeconds: 240,
        thinking: "high",
        parser: parseChallengeOutput,
      })
    : undefined;

  const challenge = challengeRun?.success ? challengeRun.parsed : undefined;
  const arbiterShouldRun =
    synthesis.hypothesisSet.length >= 2 &&
    (challenge?.challengeFindings.length ?? 0) > 0 &&
    scoutRun.parsed.materialChangeFlag !== "no_material_change";
  const arbiterRun = arbiterShouldRun
    ? await runMarketRole({
        cfg: params.cfg,
        role: "arbiter",
        routeAgentId: params.routeAgentId,
        baseSessionKey,
        userMessage: params.userMessage,
        extraSystemPrompt: buildArbiterPrompt({
          scout: scoutRun.parsed,
          synthesis,
          challenge,
        }),
        timeoutSeconds: 240,
        thinking: "high",
        parser: parseArbiterOutput,
      })
    : undefined;

  const survivorTheses =
    arbiterRun?.success && arbiterRun.parsed
      ? arbiterRun.parsed.survivorTheses
      : buildFallbackSurvivors({ hypotheses: synthesis.hypothesisSet, challenge });
  const evidenceGaps = dedupeLines(
    [
      ...scoutRun.parsed.evidenceGaps,
      ...synthesis.evidenceGaps,
      ...(challenge?.challengeFindings.map((item) => item.evidenceNeeded) ?? []),
    ],
    8,
  );
  const followUpCandidates = dedupeLines(
    [
      ...scoutRun.parsed.followUpCandidates,
      ...synthesis.followUpCandidates,
      ...(arbiterRun?.parsed?.followUpCandidates ?? []),
    ],
    8,
  );
  const doNotContinueReason =
    arbiterRun?.parsed?.doNotContinueReason ?? scoutRun.parsed.doNotContinueReason;
  const downrankedLines = dedupeLines(
    [
      ...(challenge?.challengeFindings
        .filter((item) => item.severity !== "low")
        .map((item) => `${item.thesisId}: ${item.finding}`) ?? []),
      ...(challenge?.rejectedThesisIds.map((id) => `${id}: rejected by challenge lane`) ?? []),
    ],
    6,
  );
  const artifact: MarketIntelligenceRuntimeArtifact = {
    version: 1,
    generatedAt,
    messageId: params.messageId,
    userMessage: params.userMessage,
    topicKey: MARKET_INTELLIGENCE_TOPIC_KEY,
    fingerprint,
    materialChangeFlag: scoutRun.parsed.materialChangeFlag,
    materialChangeReasons: scoutRun.parsed.materialChangeReasons,
    noMaterialChange: false,
    confidenceBand:
      arbiterRun?.parsed?.confidenceBand ??
      synthesis.confidenceBand ??
      scoutRun.parsed.confidenceBand,
    anchor: {
      lineStatus: anchor?.lineStatus,
      currentFocus: anchor?.currentFocus,
      topDecision: anchor?.topDecision,
      currentSessionSummary: anchor?.currentSessionSummary,
      nextStep: anchor?.nextStep,
      researchGuardrail: anchor?.researchGuardrail,
    },
    sourceContext: {
      sourceRefs,
      sourceDigests,
      skillReceipt,
    },
    routing: {
      scout: { model: scoutRun.model, ran: true },
      synthesizer: {
        model: synthRun.model,
        ran: true,
        degraded: !synthRun.success,
        skippedReason: synthRun.success ? undefined : synthRun.error,
      },
      challenger: challengeShouldRun
        ? {
            model: challengeRun?.model ?? resolveMarketRoleModel("challenger"),
            ran: true,
            degraded: challengeShouldRun && !challengeRun?.success,
            skippedReason: challengeRun?.success ? undefined : challengeRun?.error,
          }
        : {
            model: resolveMarketRoleModel("challenger"),
            ran: false,
            skippedReason: "not enough competing theses to justify challenge",
          },
      arbiter: arbiterShouldRun
        ? {
            model: arbiterRun?.model ?? resolveMarketRoleModel("arbiter"),
            ran: true,
            degraded: arbiterShouldRun && !arbiterRun?.success,
            skippedReason: arbiterRun?.success ? undefined : arbiterRun?.error,
          }
        : {
            model: resolveMarketRoleModel("arbiter"),
            ran: false,
            skippedReason:
              scoutRun.parsed.materialChangeFlag === "no_material_change"
                ? "scout marked the packet as no-material-change"
                : "challenge did not create a contested case that justified expensive arbitration",
          },
      distiller: { mode: "deterministic" },
    },
    hypothesisSet: synthesis.hypothesisSet,
    evidenceGaps,
    challengeFindings: challenge?.challengeFindings ?? [],
    survivorTheses,
    followUpCandidates,
    doNotContinueReason,
    comparedAgainst: recentPacket
      ? {
          generatedAt: recentPacket.generatedAt,
          artifactPath: recentPacket.relativePath,
          fingerprint: recentPacket.fingerprint,
          fingerprintMatched: false,
        }
      : undefined,
    distillation: {
      retainedResidueLines: dedupeLines(
        [
          ...survivorTheses.map((item) => `${item.label}: ${item.whySurvived}`),
          ...followUpCandidates.slice(0, 2).map((item) => `follow-up: ${item}`),
        ],
        5,
      ),
      downrankedLines,
      operatorSummaryLines: buildOperatorSummaryLines({
        noMaterialChange: false,
        survivorTheses,
        evidenceGaps,
        followUpCandidates,
        skillReceipt,
      }),
      memoryNotePath,
    },
    finalReply: "",
  };
  artifact.finalReply = renderFinalReply(artifact);

  try {
    await persistMarketIntelligenceArtifact({
      workspaceDir: params.workspaceDir,
      stem,
      artifact,
    });
  } catch (error) {
    await recordOperationalAnomaly({
      cfg: params.cfg,
      category: "market_intelligence_persist_failure",
      severity: "medium",
      source: "feishu.market_intelligence",
      problem: "failed to persist market-intelligence artifact",
      impact:
        "The bounded market-intelligence packet completed, but its structured artifact was not retained for later challenge and comparison.",
      suggestedScope:
        "Inspect market-intelligence artifact persistence without changing the scope of the market-intelligence runner or learning_command routing.",
      evidence: [`error: ${String(error)}`],
    });
    return [
      artifact.finalReply,
      "",
      "## Persistence",
      "- structured packet persistence failed; keep this run provisional.",
    ].join("\n");
  }

  return artifact.finalReply;
}
