import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeLarkApiReplyForDistillation,
  type LarkApiReplyDistillationSample,
} from "./lark-api-reply-distillation.js";
import {
  LARK_ROUTING_FAMILY_CONTRACTS,
  LARK_ROUTING_GUARD_MATCHERS,
  resolveLarkDeterministicCorpusCase,
  resolveLarkSemanticRouteCandidate,
  scoreLarkRoutingCorpus,
  type LarkRoutingCorpusCase,
  type LarkRoutingFamily,
  type LarkRoutingGuardMatcher,
  type SemanticRouteCandidate,
} from "./lark-routing-corpus.js";
import type { FeishuChatSurfaceName } from "./surfaces.js";
import type { FeishuConfig } from "./types.js";

export type LarkRoutingCandidateSource = "api_reply" | "lark_visible_reply" | "lark_user_utterance";

export type LarkRoutingCandidateStatus =
  | "pending_review"
  | "accepted_language_case"
  | "rejected_language_case"
  | "discarded";

export type LarkPendingRoutingCandidate = {
  id: string;
  source: LarkRoutingCandidateSource;
  status: LarkRoutingCandidateStatus;
  boundary: "language_routing_only";
  createdAt: string;
  sample: LarkApiReplyDistillationSample;
  utterance?: string;
  semantic?: SemanticRouteCandidate;
  discardReason?: string;
};

export type LarkRoutingCandidateEvaluation = {
  candidate: LarkPendingRoutingCandidate;
  acceptedCase?: LarkRoutingCorpusCase;
  score?: ReturnType<typeof scoreLarkRoutingCorpus>;
  reason:
    | "accepted_language_case"
    | "api_route_label_reference"
    | "discarded_by_distillation"
    | "missing_distillable_text"
    | "semantic_family_unknown"
    | "deterministic_route_failed"
    | "routing_eval_failed";
};

export type LarkRoutingCandidateCorpusArtifact = {
  schemaVersion: 1;
  boundary: "language_routing_only";
  generatedAt: string;
  candidates: LarkPendingRoutingCandidate[];
};

export type LarkRoutingCandidateCorpusEvaluation = {
  schemaVersion: 1;
  boundary: "language_routing_only";
  evaluatedAt: string;
  evaluations: LarkRoutingCandidateEvaluation[];
  acceptedCases: LarkRoutingCorpusCase[];
  counts: {
    total: number;
    accepted: number;
    rejected: number;
    discarded: number;
  };
};

export type LarkRoutingCandidatePromotionSourceArtifact = {
  boundary: "language_routing_only";
  source?: string;
  generatedAt?: string;
  messageId?: string;
  noFinanceLearningArtifact?: boolean;
  evaluation: LarkRoutingCandidateCorpusEvaluation;
};

export type LarkRoutingCandidateFamilyPromotionDecision = {
  family: LarkRoutingFamily;
  accepted: number;
  promoted: number;
  status: "eligible_for_review" | "below_threshold" | "duplicate_only";
  reason?: string;
};

export type LarkRoutingCandidatePromotionReview = {
  schemaVersion: 1;
  boundary: "language_routing_only";
  generatedAt: string;
  minAcceptedPerFamily: number;
  promotedCases: LarkRoutingCorpusCase[];
  familyDecisions: LarkRoutingCandidateFamilyPromotionDecision[];
  counts: {
    sourceArtifacts: number;
    acceptedCases: number;
    duplicateCases: number;
    promotedCases: number;
  };
  skippedCounts: Record<string, number>;
  corpusPatch: string;
};

export type LarkRoutingCandidatePromotionArtifactReadResult = {
  artifacts: LarkRoutingCandidatePromotionSourceArtifact[];
  skipped: Array<{
    path: string;
    reason:
      | "not_json"
      | "read_failed"
      | "parse_failed"
      | "invalid_language_boundary"
      | "missing_language_brain_boundary_marker";
  }>;
};

export type LarkRoutingCandidatePromotionReviewWriteResult = {
  review: LarkRoutingCandidatePromotionReview;
  reviewPath: string;
  patchPath: string;
  skipped: LarkRoutingCandidatePromotionArtifactReadResult["skipped"];
};

export type LarkLanguageRoutingCandidateCaptureArtifact = {
  schemaVersion: 1;
  boundary: "language_routing_only";
  source: "feishu_final_reply_capture";
  generatedAt: string;
  agentId: string;
  targetSurface?: FeishuChatSurfaceName;
  effectiveSurface?: FeishuChatSurfaceName;
  chatId: string;
  sessionKey: string;
  messageId: string;
  noFinanceLearningArtifact: true;
  candidates: LarkPendingRoutingCandidate[];
  evaluation: LarkRoutingCandidateCorpusEvaluation;
};

export type LarkLanguageRoutingCandidateCaptureResult = {
  relativePath: string;
  dateKey: string;
  workspaceDir: string;
  artifact: LarkLanguageRoutingCandidateCaptureArtifact;
};

function countPromotionSkippedReasons(
  skipped: readonly LarkRoutingCandidatePromotionArtifactReadResult["skipped"][number][],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of skipped) {
    counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
  }
  return counts;
}

export const LARK_LANGUAGE_CANDIDATE_DIR = path.join("memory", "lark-language-routing-candidates");
export const LARK_LANGUAGE_REVIEW_DIR = path.join("memory", "lark-language-routing-reviews");

function normalizeCandidateText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizePromotionKey(value: string): string {
  return normalizeCandidateText(value).toLowerCase();
}

function buildPromotionCaseId(params: { family: LarkRoutingFamily; utterance: string }): string {
  const hash = createHash("sha256").update(params.utterance).digest("hex").slice(0, 12);
  return `promoted-language-${params.family}-${hash}`;
}

function buildCandidateId(params: {
  source: LarkRoutingCandidateSource;
  contentHash: string;
}): string {
  return `pending-language-${params.source}-${params.contentHash}`;
}

function sanitizeLanguageCandidateFileSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function buildLarkLanguageCandidateCaptureFileName(messageId: string): string {
  const stem = sanitizeLanguageCandidateFileSegment(messageId) || "message";
  return `${stem}.json`;
}

function expectedGuardMatchersForUtterance(
  utterance: string,
): LarkRoutingCorpusCase["expectedGuardMatchers"] {
  const matchers: LarkRoutingGuardMatcher[] = [];
  if (LARK_ROUTING_GUARD_MATCHERS.sourceCoverage(utterance)) {
    matchers.push("sourceCoverage");
  }
  if (LARK_ROUTING_GUARD_MATCHERS.apiReplyArtifact(utterance)) {
    matchers.push("apiReplyArtifact");
  }
  return matchers.length > 0 ? matchers : undefined;
}

function parseApiRouteFamilyHint(payload: unknown): SemanticRouteCandidate | undefined {
  const parsed =
    typeof payload === "string"
      ? (() => {
          try {
            return JSON.parse(payload) as unknown;
          } catch {
            return undefined;
          }
        })()
      : payload;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const family = typeof record.family === "string" ? record.family.trim() : "";
  if (!(family in LARK_ROUTING_FAMILY_CONTRACTS)) {
    return undefined;
  }
  const confidence =
    typeof record.confidence === "number" && Number.isFinite(record.confidence)
      ? Math.max(0, Math.min(1, record.confidence))
      : 0.75;
  return {
    family: family as LarkRoutingFamily,
    score: confidence,
    matchedUtterance:
      typeof record.rationale === "string" && record.rationale.trim()
        ? record.rationale.trim().slice(0, 240)
        : "api_route_family_label",
  };
}

function looksLikeApiRouteJsonLabelArtifact(candidate: LarkPendingRoutingCandidate): boolean {
  if (candidate.source !== "api_reply" || candidate.sample.outputKind !== "json") {
    return false;
  }
  const parsed =
    typeof candidate.sample.distillableText === "string"
      ? (() => {
          try {
            return JSON.parse(candidate.sample.distillableText) as unknown;
          } catch {
            return undefined;
          }
        })()
      : undefined;
  return (
    parsed != null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    typeof (parsed as Record<string, unknown>).family === "string"
  );
}

function looksLikeApiRouteProviderFailureArtifact(text: string): boolean {
  return /api route provider failed|gateway timeout|failovererror|llm request timed out|request timed out|provider failed|model timeout|upstream timeout/iu.test(
    text,
  );
}

function resolveCandidateSemantic(
  candidate: LarkPendingRoutingCandidate,
): SemanticRouteCandidate | undefined {
  if (candidate.source === "api_reply") {
    return (
      parseApiRouteFamilyHint(candidate.sample?.distillableText) ??
      candidate.semantic ??
      (candidate.utterance ? resolveLarkSemanticRouteCandidate(candidate.utterance) : undefined)
    );
  }
  return (
    candidate.semantic ??
    (candidate.utterance ? resolveLarkSemanticRouteCandidate(candidate.utterance) : undefined)
  );
}

export function createLarkPendingRoutingCandidate(params: {
  source: LarkRoutingCandidateSource;
  payload: unknown;
  createdAt?: string;
}): LarkPendingRoutingCandidate {
  const sample = normalizeLarkApiReplyForDistillation(params.payload);
  const id = buildCandidateId({ source: params.source, contentHash: sample.contentHash });
  if (
    sample.disposition === "discard_empty" ||
    sample.disposition === "discard_secret" ||
    sample.disposition === "discard_binary"
  ) {
    return {
      id,
      source: params.source,
      status: "discarded",
      boundary: "language_routing_only",
      createdAt: params.createdAt ?? new Date().toISOString(),
      sample,
      discardReason: sample.discardReason,
    };
  }
  const utterance = sample.distillableText
    ? normalizeCandidateText(sample.distillableText)
    : undefined;
  return {
    id,
    source: params.source,
    status: "pending_review",
    boundary: "language_routing_only",
    createdAt: params.createdAt ?? new Date().toISOString(),
    sample,
    utterance,
    semantic:
      params.source === "api_reply"
        ? (parseApiRouteFamilyHint(params.payload) ??
          (utterance ? resolveLarkSemanticRouteCandidate(utterance) : undefined))
        : utterance
          ? resolveLarkSemanticRouteCandidate(utterance)
          : undefined,
  };
}

export function buildLarkPendingRoutingCandidateCorpus(params: {
  source: LarkRoutingCandidateSource;
  payloads: readonly unknown[];
  generatedAt?: string;
}): LarkRoutingCandidateCorpusArtifact {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    boundary: "language_routing_only",
    generatedAt,
    candidates: params.payloads.map((payload) =>
      createLarkPendingRoutingCandidate({
        source: params.source,
        payload,
        createdAt: generatedAt,
      }),
    ),
  };
}

export function evaluateLarkPendingRoutingCandidate(params: {
  cfg: FeishuConfig;
  candidate: LarkPendingRoutingCandidate;
  familyHint?: SemanticRouteCandidate;
}): LarkRoutingCandidateEvaluation {
  const candidate = params.candidate;
  if (candidate.status === "discarded") {
    return { candidate, reason: "discarded_by_distillation" };
  }
  if (!candidate.utterance) {
    return { candidate, reason: "missing_distillable_text" };
  }
  if (
    candidate.source === "api_reply" &&
    looksLikeApiRouteProviderFailureArtifact(candidate.utterance)
  ) {
    return {
      candidate: {
        ...candidate,
        status: "discarded",
        discardReason: "api_route_provider_failure",
      },
      reason: "discarded_by_distillation",
    };
  }
  const candidateSemantic = resolveCandidateSemantic(candidate);
  if (
    candidate.source === "api_reply" &&
    candidate.sample.outputKind === "json" &&
    looksLikeApiRouteJsonLabelArtifact(candidate)
  ) {
    return {
      candidate: {
        ...candidate,
        status: "discarded",
        semantic: candidateSemantic ?? { family: "unknown", score: 0 },
      },
      reason: "api_route_label_reference",
    };
  }
  const directSemantic = resolveLarkSemanticRouteCandidate(candidate.utterance);
  const semantic =
    candidate.source === "lark_user_utterance" &&
    params.familyHint?.family &&
    params.familyHint.family !== "unknown" &&
    directSemantic.score < 0.8
      ? params.familyHint
      : directSemantic;
  if (semantic.family === "unknown") {
    return {
      candidate: { ...candidate, status: "rejected_language_case", semantic },
      reason: "semantic_family_unknown",
    };
  }

  const acceptedCase: LarkRoutingCorpusCase = {
    id: candidate.id,
    utterance: candidate.utterance,
    family: semantic.family as LarkRoutingFamily,
    expectedSurface: (() => {
      const target = LARK_ROUTING_FAMILY_CONTRACTS[semantic.family as LarkRoutingFamily].target;
      return target === "protocol_truth_surface" ? undefined : target;
    })(),
    expectedGuardMatchers: expectedGuardMatchersForUtterance(candidate.utterance),
    truthBoundary: "evidence_required",
    notes: "Auto-normalized language-routing candidate; not a finance learning artifact.",
  };
  const deterministic = resolveLarkDeterministicCorpusCase({
    cfg: params.cfg,
    entry: acceptedCase,
  });
  if (!deterministic.passed) {
    return {
      candidate: { ...candidate, status: "rejected_language_case", semantic },
      acceptedCase,
      reason: "deterministic_route_failed",
    };
  }
  if (
    candidate.source === "lark_user_utterance" &&
    params.familyHint?.family &&
    params.familyHint.family !== "unknown"
  ) {
    return {
      candidate: { ...candidate, status: "accepted_language_case", semantic },
      acceptedCase,
      reason: "accepted_language_case",
    };
  }
  const score = scoreLarkRoutingCorpus({ cfg: params.cfg, corpus: [acceptedCase] });
  if (score.deterministicPassed !== 1 || score.semanticCandidatePassed !== 1) {
    return {
      candidate: { ...candidate, status: "rejected_language_case", semantic },
      acceptedCase,
      score,
      reason: "routing_eval_failed",
    };
  }
  return {
    candidate: { ...candidate, status: "accepted_language_case", semantic },
    acceptedCase,
    score,
    reason: "accepted_language_case",
  };
}

export function evaluateLarkPendingRoutingCandidates(params: {
  cfg: FeishuConfig;
  candidates: readonly LarkPendingRoutingCandidate[];
}): LarkRoutingCandidateEvaluation[] {
  let pendingFamilyHint: SemanticRouteCandidate | undefined;
  return params.candidates.map((candidate) => {
    const familyHint = candidate.source === "lark_user_utterance" ? pendingFamilyHint : undefined;
    const evaluation = evaluateLarkPendingRoutingCandidate({
      cfg: params.cfg,
      candidate,
      familyHint,
    });
    if (
      candidate.source === "api_reply" &&
      candidate.sample.outputKind === "json" &&
      evaluation.reason === "api_route_label_reference"
    ) {
      const semantic = resolveCandidateSemantic(candidate);
      if (semantic?.family && semantic.family !== "unknown") {
        pendingFamilyHint = semantic;
      }
    } else if (candidate.source === "lark_user_utterance" && familyHint) {
      pendingFamilyHint = undefined;
    }
    return evaluation;
  });
}

export function evaluateLarkRoutingCandidateCorpus(params: {
  cfg: FeishuConfig;
  corpus: LarkRoutingCandidateCorpusArtifact;
  evaluatedAt?: string;
}): LarkRoutingCandidateCorpusEvaluation {
  const evaluations = evaluateLarkPendingRoutingCandidates({
    cfg: params.cfg,
    candidates: params.corpus.candidates,
  });
  const acceptedCases = evaluations
    .filter((evaluation) => evaluation.reason === "accepted_language_case")
    .map((evaluation) => evaluation.acceptedCase)
    .filter((entry): entry is LarkRoutingCorpusCase => entry != null);
  const discarded = evaluations.filter(
    (evaluation) =>
      evaluation.reason === "discarded_by_distillation" ||
      evaluation.reason === "api_route_label_reference",
  ).length;
  return {
    schemaVersion: 1,
    boundary: "language_routing_only",
    evaluatedAt: params.evaluatedAt ?? new Date().toISOString(),
    evaluations,
    acceptedCases,
    counts: {
      total: evaluations.length,
      accepted: acceptedCases.length,
      rejected: evaluations.length - acceptedCases.length - discarded,
      discarded,
    },
  };
}

export async function writeLarkLanguageRoutingCandidateCapture(params: {
  workspaceDir: string;
  cfg: FeishuConfig;
  agentId: string;
  targetSurface?: FeishuChatSurfaceName;
  effectiveSurface?: FeishuChatSurfaceName;
  chatId: string;
  sessionKey: string;
  messageId: string;
  userMessage: string;
  finalReplyText: string;
  apiReplyPayloads?: readonly unknown[];
  generatedAt?: string;
}): Promise<LarkLanguageRoutingCandidateCaptureResult | undefined> {
  const userMessage = params.userMessage.trim();
  const finalReplyText = params.finalReplyText.trim();
  if (!userMessage && !finalReplyText && !params.apiReplyPayloads?.length) {
    return undefined;
  }

  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const userCorpus = userMessage
    ? buildLarkPendingRoutingCandidateCorpus({
        source: "lark_user_utterance",
        payloads: [userMessage],
        generatedAt,
      })
    : undefined;
  const replyCorpus = finalReplyText
    ? buildLarkPendingRoutingCandidateCorpus({
        source: "lark_visible_reply",
        payloads: [finalReplyText],
        generatedAt,
      })
    : undefined;
  const apiCorpus =
    params.apiReplyPayloads && params.apiReplyPayloads.length > 0
      ? buildLarkPendingRoutingCandidateCorpus({
          source: "api_reply",
          payloads: params.apiReplyPayloads,
          generatedAt,
        })
      : undefined;
  const candidates = [
    ...(apiCorpus?.candidates ?? []),
    ...(userCorpus?.candidates ?? []),
    ...(replyCorpus?.candidates ?? []),
  ];
  const evaluation = evaluateLarkRoutingCandidateCorpus({
    cfg: params.cfg,
    corpus: {
      schemaVersion: 1,
      boundary: "language_routing_only",
      generatedAt,
      candidates,
    },
    evaluatedAt: generatedAt,
  });
  const artifact: LarkLanguageRoutingCandidateCaptureArtifact = {
    schemaVersion: 1,
    boundary: "language_routing_only",
    source: "feishu_final_reply_capture",
    generatedAt,
    agentId: params.agentId,
    targetSurface: params.targetSurface,
    effectiveSurface: params.effectiveSurface,
    chatId: params.chatId,
    sessionKey: params.sessionKey,
    messageId: params.messageId,
    noFinanceLearningArtifact: true,
    candidates,
    evaluation,
  };

  const dateStem = generatedAt.slice(0, 10);
  const memoryDir = path.join(params.workspaceDir, LARK_LANGUAGE_CANDIDATE_DIR, dateStem);
  const fileName = buildLarkLanguageCandidateCaptureFileName(params.messageId);
  const filePath = path.join(memoryDir, fileName);
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
  return {
    relativePath: normalizeArtifactPath(path.join(LARK_LANGUAGE_CANDIDATE_DIR, dateStem, fileName)),
    dateKey: dateStem,
    workspaceDir: params.workspaceDir,
    artifact,
  };
}

function renderRoutingCorpusCaseForPatch(entry: LarkRoutingCorpusCase): string {
  const lines = [
    "  {",
    `    id: ${JSON.stringify(entry.id)},`,
    `    utterance: ${JSON.stringify(entry.utterance)},`,
    `    family: ${JSON.stringify(entry.family)},`,
  ];
  if (entry.expectedSurface) {
    lines.push(`    expectedSurface: ${JSON.stringify(entry.expectedSurface)},`);
  }
  if (entry.expectedProtocolKind) {
    lines.push(`    expectedProtocolKind: ${JSON.stringify(entry.expectedProtocolKind)},`);
  }
  if (entry.expectedGuardMatchers?.length) {
    lines.push(
      `    expectedGuardMatchers: ${JSON.stringify(entry.expectedGuardMatchers)} as const,`,
    );
  }
  if (entry.mustNotRouteTo?.length) {
    lines.push(`    mustNotRouteTo: ${JSON.stringify(entry.mustNotRouteTo)} as const,`);
  }
  lines.push(`    truthBoundary: ${JSON.stringify(entry.truthBoundary)},`);
  if (entry.notes) {
    lines.push(`    notes: ${JSON.stringify(entry.notes)},`);
  }
  lines.push("  },");
  return lines.join("\n");
}

function renderLarkRoutingCandidatePromotionPatch(cases: readonly LarkRoutingCorpusCase[]): string {
  if (cases.length === 0) {
    return "// No language-routing candidates met promotion thresholds.\n";
  }
  return [
    "// Review patch: append these cases to LARK_ROUTING_CORPUS after human review.",
    ...cases.map(renderRoutingCorpusCaseForPatch),
    "",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLarkRoutingCandidatePromotionSourceArtifact(
  value: unknown,
): value is LarkRoutingCandidatePromotionSourceArtifact {
  if (!isRecord(value) || value.boundary !== "language_routing_only") {
    return false;
  }
  const evaluation = value.evaluation;
  if (!isRecord(evaluation) || evaluation.boundary !== "language_routing_only") {
    return false;
  }
  return Array.isArray(evaluation.acceptedCases);
}

async function collectJsonFiles(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }
  return files.toSorted();
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export async function readLarkRoutingCandidatePromotionArtifacts(params: {
  rootDir: string;
  maxFiles?: number;
}): Promise<LarkRoutingCandidatePromotionArtifactReadResult> {
  let files: string[];
  try {
    files = await collectJsonFiles(params.rootDir);
  } catch (error) {
    if (isMissingPathError(error)) {
      return { artifacts: [], skipped: [] };
    }
    return {
      artifacts: [],
      skipped: [{ path: params.rootDir, reason: "read_failed" }],
    };
  }

  const artifacts: LarkRoutingCandidatePromotionSourceArtifact[] = [];
  const skipped: LarkRoutingCandidatePromotionArtifactReadResult["skipped"] = [];
  for (const filePath of files.slice(0, params.maxFiles ?? files.length)) {
    if (!filePath.endsWith(".json")) {
      skipped.push({ path: filePath, reason: "not_json" });
      continue;
    }
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      skipped.push({ path: filePath, reason: "read_failed" });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      skipped.push({ path: filePath, reason: "parse_failed" });
      continue;
    }
    if (!isRecord(parsed) || parsed.boundary !== "language_routing_only") {
      skipped.push({ path: filePath, reason: "invalid_language_boundary" });
      continue;
    }
    if (parsed.noFinanceLearningArtifact !== true) {
      skipped.push({ path: filePath, reason: "missing_language_brain_boundary_marker" });
      continue;
    }
    if (!isLarkRoutingCandidatePromotionSourceArtifact(parsed)) {
      skipped.push({ path: filePath, reason: "invalid_language_boundary" });
      continue;
    }
    artifacts.push(parsed);
  }

  return { artifacts, skipped };
}

export function buildLarkRoutingCandidatePromotionReview(params: {
  artifacts: readonly LarkRoutingCandidatePromotionSourceArtifact[];
  existingCorpus?: readonly LarkRoutingCorpusCase[];
  minAcceptedPerFamily?: number;
  generatedAt?: string;
  skipped?: readonly LarkRoutingCandidatePromotionArtifactReadResult["skipped"][number][];
}): LarkRoutingCandidatePromotionReview {
  const minAcceptedPerFamily = params.minAcceptedPerFamily ?? 2;
  const existingKeys = new Set(
    (params.existingCorpus ?? []).map((entry) => normalizePromotionKey(entry.utterance)),
  );
  const duplicateKeys = new Set<string>();
  const acceptedByFamily = new Map<LarkRoutingFamily, LarkRoutingCorpusCase[]>();

  for (const artifact of params.artifacts) {
    if (artifact.boundary !== "language_routing_only") {
      continue;
    }
    for (const acceptedCase of artifact.evaluation.acceptedCases) {
      const key = normalizePromotionKey(acceptedCase.utterance);
      if (existingKeys.has(key) || duplicateKeys.has(key)) {
        duplicateKeys.add(key);
        continue;
      }
      duplicateKeys.add(key);
      const familyCases = acceptedByFamily.get(acceptedCase.family) ?? [];
      familyCases.push({
        ...acceptedCase,
        id: buildPromotionCaseId({
          family: acceptedCase.family,
          utterance: acceptedCase.utterance,
        }),
        notes:
          "Promoted from pending Lark language-routing candidate review; not a finance learning artifact.",
      });
      acceptedByFamily.set(acceptedCase.family, familyCases);
    }
  }

  const promotedCases: LarkRoutingCorpusCase[] = [];
  const familyDecisions: LarkRoutingCandidateFamilyPromotionDecision[] = [];
  for (const family of [...acceptedByFamily.keys()].toSorted()) {
    const familyCases = acceptedByFamily.get(family) ?? [];
    if (familyCases.length >= minAcceptedPerFamily) {
      promotedCases.push(...familyCases);
      familyDecisions.push({
        family,
        accepted: familyCases.length,
        promoted: familyCases.length,
        status: "eligible_for_review",
      });
    } else {
      familyDecisions.push({
        family,
        accepted: familyCases.length,
        promoted: 0,
        status: "below_threshold",
        reason: `needs at least ${minAcceptedPerFamily} accepted cases for this family`,
      });
    }
  }

  const acceptedCases = params.artifacts.reduce(
    (sum, artifact) =>
      artifact.boundary === "language_routing_only"
        ? sum + artifact.evaluation.acceptedCases.length
        : sum,
    0,
  );
  const duplicateCases = Math.max(
    0,
    acceptedCases -
      [...acceptedByFamily.values()].reduce((sum, familyCases) => sum + familyCases.length, 0),
  );

  return {
    schemaVersion: 1,
    boundary: "language_routing_only",
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    minAcceptedPerFamily,
    promotedCases,
    familyDecisions:
      familyDecisions.length > 0
        ? familyDecisions
        : [
            {
              family: "api_reply_distillation",
              accepted: 0,
              promoted: 0,
              status: "duplicate_only",
              reason: "no non-duplicate accepted language-routing cases found",
            },
          ],
    counts: {
      sourceArtifacts: params.artifacts.length,
      acceptedCases,
      duplicateCases,
      promotedCases: promotedCases.length,
    },
    skippedCounts: countPromotionSkippedReasons(params.skipped ?? []),
    corpusPatch: renderLarkRoutingCandidatePromotionPatch(promotedCases),
  };
}

function normalizeArtifactPath(value: string): string {
  return value.split(path.sep).join("/");
}

export async function writeLarkRoutingCandidatePromotionReview(params: {
  workspaceDir: string;
  dateKey: string;
  rootDir?: string;
  existingCorpus?: readonly LarkRoutingCorpusCase[];
  minAcceptedPerFamily?: number;
  maxFiles?: number;
  generatedAt?: string;
}): Promise<LarkRoutingCandidatePromotionReviewWriteResult> {
  const rootDir =
    params.rootDir ?? path.join(params.workspaceDir, LARK_LANGUAGE_CANDIDATE_DIR, params.dateKey);
  const readResult = await readLarkRoutingCandidatePromotionArtifacts({
    rootDir,
    ...(params.maxFiles && params.maxFiles > 0 ? { maxFiles: params.maxFiles } : {}),
  });
  const review = buildLarkRoutingCandidatePromotionReview({
    artifacts: readResult.artifacts,
    existingCorpus: params.existingCorpus,
    minAcceptedPerFamily: params.minAcceptedPerFamily,
    generatedAt: params.generatedAt,
    skipped: readResult.skipped,
  });
  const reviewRelPath = path.join(LARK_LANGUAGE_REVIEW_DIR, `${params.dateKey}.json`);
  const patchRelPath = path.join(LARK_LANGUAGE_REVIEW_DIR, `${params.dateKey}.patch.ts`);
  await fs.mkdir(path.join(params.workspaceDir, LARK_LANGUAGE_REVIEW_DIR), { recursive: true });
  await fs.writeFile(
    path.join(params.workspaceDir, reviewRelPath),
    `${JSON.stringify(review, null, 2)}\n`,
    "utf-8",
  );
  await fs.writeFile(path.join(params.workspaceDir, patchRelPath), review.corpusPatch, "utf-8");
  return {
    review,
    reviewPath: normalizeArtifactPath(reviewRelPath),
    patchPath: normalizeArtifactPath(patchRelPath),
    skipped: readResult.skipped,
  };
}
