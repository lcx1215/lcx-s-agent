import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFinanceLearningCapabilityCandidatesPath,
  FINANCE_FRAMEWORK_CORE_DOMAINS,
  FINANCE_LEARNING_CAPABILITY_TAGS,
  FINANCE_LEARNING_CAPABILITY_TYPES,
  parseFinanceLearningCapabilityCandidateArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringOrNumberParam, readStringParam } from "./common.js";

const FinanceLearningCapabilityInspectSchema = Type.Object({
  domain: Type.Optional(stringEnum(FINANCE_FRAMEWORK_CORE_DOMAINS)),
  capabilityType: Type.Optional(stringEnum(FINANCE_LEARNING_CAPABILITY_TYPES)),
  capabilityTag: Type.Optional(stringEnum(FINANCE_LEARNING_CAPABILITY_TAGS)),
  sourceArticlePath: Type.Optional(Type.String()),
  queryText: Type.Optional(
    Type.String({
      description:
        "Optional natural-language retrieval query, e.g. factor timing with walk-forward and drawdown risk",
    }),
  ),
  maxCandidates: Type.Optional(
    Type.Number({ description: "Maximum ranked candidates to return when queryText is provided" }),
  ),
});

const MIN_QUERY_RETRIEVAL_SCORE = 0.2;

type FinanceLearningCapabilityCandidate = NonNullable<
  ReturnType<typeof parseFinanceLearningCapabilityCandidateArtifact>
>["candidates"][number];

function normalizeSearchText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[，。！？、；：,.!?;:()[\]{}"'`~\-_/\\|]+/gu, " ")
    .replace(/\s+/gu, " ");
}

function searchTokens(value: string): Set<string> {
  const normalized = normalizeSearchText(value);
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9]+|[\p{Script=Han}]/gu)) {
    tokens.add(match[0]);
  }
  const hanOnly = Array.from(normalized.matchAll(/[\p{Script=Han}]+/gu))
    .map((match) => match[0])
    .join("");
  for (let index = 0; index < hanOnly.length - 1; index += 1) {
    tokens.add(hanOnly.slice(index, index + 2));
  }
  return tokens;
}

function buildCandidateSearchBlob(candidate: FinanceLearningCapabilityCandidate): string {
  return [
    candidate.capabilityName,
    candidate.capabilityType,
    candidate.title,
    candidate.extractionSummary,
    candidate.methodSummary,
    candidate.evidenceSummary,
    candidate.causalOrMechanisticClaim,
    candidate.implementationRequirements,
    candidate.riskAndFailureModes,
    candidate.overfittingOrSpuriousRisk,
    candidate.suggestedAttachmentPoint,
    ...candidate.relatedFinanceDomains,
    ...candidate.capabilityTags,
    ...candidate.evidenceCategories,
    ...candidate.requiredDataSources,
  ].join("\n");
}

function scoreCandidateForQuery(params: {
  candidate: FinanceLearningCapabilityCandidate;
  queryText: string;
}): { score: number; matchedSignals: string[] } {
  const queryTokens = searchTokens(params.queryText);
  if (queryTokens.size === 0) {
    return { score: 0, matchedSignals: [] };
  }
  const candidateBlob = buildCandidateSearchBlob(params.candidate);
  const candidateTokens = searchTokens(candidateBlob);
  let tokenHits = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) {
      tokenHits += 1;
    }
  }

  const normalizedQuery = normalizeSearchText(params.queryText);
  const exactSignals = [
    ...params.candidate.relatedFinanceDomains,
    ...params.candidate.capabilityTags,
    params.candidate.capabilityType,
  ].filter((signal) => normalizeSearchText(signal).includes(normalizedQuery));

  const directFieldBonus = exactSignals.length > 0 ? 0.25 : 0;
  const denominator = Math.min(queryTokens.size, 12);
  const score = Math.min(1, tokenHits / denominator + directFieldBonus);
  return {
    score,
    matchedSignals: [...new Set(exactSignals)].slice(0, 8),
  };
}

function buildCandidateReuseGuidance(candidate: FinanceLearningCapabilityCandidate) {
  return {
    applicationBoundary: candidate.allowedActionAuthority,
    attachmentPoint: candidate.suggestedAttachmentPoint,
    useFor: `Use this as a ${candidate.capabilityType} for ${candidate.relatedFinanceDomains.join(
      ", ",
    )} research when the task needs ${candidate.capabilityTags.join(", ")}.`,
    requiredInputs: candidate.requiredDataSources,
    requiredEvidenceCategories: candidate.evidenceCategories,
    causalCheck: candidate.causalOrMechanisticClaim,
    riskChecks: [candidate.riskAndFailureModes, candidate.overfittingOrSpuriousRisk],
    implementationCheck: candidate.implementationRequirements,
    doNotUseFor:
      "Do not use this capability as trading execution approval, doctrine mutation, or a standalone prediction without fresh evidence and risk review.",
  };
}

function clampMaxCandidates(value: string | undefined): number {
  const parsed = value ? Number(value) : 10;
  if (!Number.isFinite(parsed)) {
    return 10;
  }
  return Math.max(1, Math.min(50, Math.floor(parsed)));
}

export function createFinanceLearningCapabilityInspectTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Learning Capability Inspect",
    name: "finance_learning_capability_inspect",
    description:
      "Inspect retained finance learning capability candidates across all sources, by domain, by capability type, by capability tag, or by source article. This is read-only.",
    parameters: FinanceLearningCapabilityInspectSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const domain = readStringParam(params, "domain");
      const capabilityType = readStringParam(params, "capabilityType");
      const capabilityTag = readStringParam(params, "capabilityTag");
      const sourceArticlePath = readStringParam(params, "sourceArticlePath");
      const queryText = readStringParam(params, "queryText");
      const maxCandidates = clampMaxCandidates(readStringOrNumberParam(params, "maxCandidates"));

      const artifactRelPath = buildFinanceLearningCapabilityCandidatesPath();
      const artifactAbsPath = path.join(workspaceDir, artifactRelPath);
      let artifactContent: string;
      try {
        artifactContent = await fs.readFile(artifactAbsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return jsonResult({
            ok: false,
            reason: "finance_learning_capability_candidates_missing",
            artifactPath: artifactRelPath,
            action:
              "Record at least one finance learning capability candidate before inspecting this attachment layer.",
          });
        }
        throw error;
      }

      const parsedArtifact = parseFinanceLearningCapabilityCandidateArtifact(artifactContent);
      if (!parsedArtifact) {
        return jsonResult({
          ok: false,
          reason: "finance_learning_capability_candidates_malformed",
          artifactPath: artifactRelPath,
          action:
            "Repair or archive the malformed finance learning capability artifact before retrying finance_learning_capability_inspect.",
        });
      }

      const filteredCandidates = parsedArtifact.candidates.filter((candidate) => {
        if (domain && !candidate.relatedFinanceDomains.includes(domain as never)) {
          return false;
        }
        if (capabilityType && candidate.capabilityType !== capabilityType) {
          return false;
        }
        if (capabilityTag && !candidate.capabilityTags.includes(capabilityTag as never)) {
          return false;
        }
        if (sourceArticlePath && candidate.sourceArticlePath !== sourceArticlePath) {
          return false;
        }
        return true;
      });
      const rankedCandidates = queryText
        ? filteredCandidates
            .map((candidate) => ({
              candidate,
              retrieval: scoreCandidateForQuery({ candidate, queryText }),
            }))
            .filter((entry) => entry.retrieval.score >= MIN_QUERY_RETRIEVAL_SCORE)
            .toSorted((left, right) => right.retrieval.score - left.retrieval.score)
            .slice(0, maxCandidates)
        : filteredCandidates.map((candidate) => ({
            candidate,
            retrieval: undefined,
          }));

      return jsonResult({
        ok: true,
        artifactPath: artifactRelPath,
        frameworkContractPath: parsedArtifact.frameworkContractPath,
        updatedAt: parsedArtifact.updatedAt,
        candidateCount: rankedCandidates.length,
        filters: {
          domain: domain ?? null,
          capabilityType: capabilityType ?? null,
          capabilityTag: capabilityTag ?? null,
          sourceArticlePath: sourceArticlePath ?? null,
          queryText: queryText ?? null,
          maxCandidates: queryText ? maxCandidates : null,
        },
        retrievalMode: queryText ? "query_ranked" : "filtered",
        applicationMode: queryText ? "retrieval_first_reuse_review" : "inventory_review",
        candidates: rankedCandidates.map((entry) =>
          entry.retrieval
            ? {
                ...entry.candidate,
                retrievalScore: entry.retrieval.score,
                matchedSignals: entry.retrieval.matchedSignals,
                reuseGuidance: buildCandidateReuseGuidance(entry.candidate),
              }
            : {
                ...entry.candidate,
                reuseGuidance: buildCandidateReuseGuidance(entry.candidate),
              },
        ),
      });
    },
  };
}
