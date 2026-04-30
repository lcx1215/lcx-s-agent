import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFinanceFrameworkCoreContractPath,
  buildFinanceLearningCapabilityCandidatesPath,
  FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES,
  FINANCE_FRAMEWORK_CORE_DOMAINS,
  FINANCE_EVIDENCE_CATEGORIES,
  FINANCE_LEARNING_CAPABILITY_TAGS,
  FINANCE_LEARNING_CAPABILITY_TYPES,
  FINANCE_LEARNING_COLLECTION_METHODS,
  FINANCE_LEARNING_EVIDENCE_LEVELS,
  FINANCE_LEARNING_SOURCE_TYPES,
  parseFinanceLearningCapabilityCandidateArtifact,
  renderFinanceLearningCapabilityCandidateArtifact,
  type FinanceLearningCapabilityCandidateArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringArrayParam, readStringParam, ToolInputError } from "./common.js";
import {
  ensureNonGenericEvidenceSummary,
  validateFinanceCapabilityTagEvidenceGate,
  validateFinanceDomainEvidenceGate,
} from "./finance-evidence-gates.js";

const FinanceLearningCapabilityCandidateSchema = Type.Object({
  capabilityName: Type.String(),
  capabilityType: stringEnum(FINANCE_LEARNING_CAPABILITY_TYPES),
  relatedFinanceDomains: Type.Array(stringEnum(FINANCE_FRAMEWORK_CORE_DOMAINS)),
  capabilityTags: Type.Array(stringEnum(FINANCE_LEARNING_CAPABILITY_TAGS)),
  evidenceCategories: Type.Array(stringEnum(FINANCE_EVIDENCE_CATEGORIES)),
  evidenceSummary: Type.String(),
  methodSummary: Type.String(),
  requiredDataSources: Type.Array(Type.String()),
  causalOrMechanisticClaim: Type.String(),
  evidenceLevel: stringEnum(FINANCE_LEARNING_EVIDENCE_LEVELS),
  implementationRequirements: Type.String(),
  riskAndFailureModes: Type.String(),
  overfittingOrSpuriousRisk: Type.String(),
  complianceOrCollectionNotes: Type.String(),
  suggestedAttachmentPoint: Type.String(),
  allowedActionAuthority: stringEnum(FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES),
});

const FinanceLearningCapabilityAttachSchema = Type.Object({
  articlePath: Type.String(),
  title: Type.String(),
  sourceType: stringEnum(FINANCE_LEARNING_SOURCE_TYPES),
  collectionMethod: stringEnum(FINANCE_LEARNING_COLLECTION_METHODS),
  authorSourceName: Type.Optional(Type.String()),
  publishDate: Type.Optional(Type.String()),
  extractionSummary: Type.String(),
  rawNotes: Type.String(),
  capabilityCandidates: Type.Array(FinanceLearningCapabilityCandidateSchema),
  executionRequested: Type.Optional(Type.Boolean()),
  autoPromotionRequested: Type.Optional(Type.Boolean()),
  doctrineMutationRequested: Type.Optional(Type.Boolean()),
});

const GENERIC_FILLER_PATTERNS = [
  /^this article (mainly )?(talks|discusses|covers|shares|introduces)\b/iu,
  /^the article is about\b/iu,
  /^general market commentary\b/iu,
  /^misc(ellaneous)? notes?\b/iu,
  /^summary:?\s*general overview\b/iu,
  /^interesting article\b/iu,
] as const;

const GENERIC_CAPABILITY_PATTERNS = [
  /^use (a )?(simple )?checklist\b/iu,
  /^basic (method|framework|approach)\b/iu,
  /^general (method|framework|approach|risk)\b/iu,
  /^market data$/iu,
  /^can fail$/iu,
  /^needs review$/iu,
  /^do research$/iu,
] as const;

const ILLEGAL_COLLECTION_PATTERNS = [
  /paywall bypass/iu,
  /credential bypass/iu,
  /illegal scraping/iu,
  /unauthorized scraping/iu,
  /bypass login/iu,
  /scrape behind login/iu,
  /stolen cookie/iu,
  /account sharing/iu,
  /captcha bypass/iu,
] as const;

const FORBIDDEN_AUTHORITY_PATTERNS = [
  /auto-?trade/iu,
  /execute trades?/iu,
  /place orders?/iu,
  /\bbuy now\b/iu,
  /\bsell now\b/iu,
  /trade now/iu,
  /execution approval/iu,
  /auto-?promot/iu,
  /mutate doctrine/iu,
  /rewrite doctrine card/iu,
] as const;

const NEGATED_GUARDRAIL_PREFIX_PATTERNS = [
  /\bwithout\b[\s\S]{0,48}$/iu,
  /\bno\b[\s\S]{0,24}$/iu,
  /\bnot\b[\s\S]{0,24}$/iu,
  /\bnever\b[\s\S]{0,24}$/iu,
  /\bdo not\b[\s\S]{0,32}$/iu,
  /\bdoes not\b[\s\S]{0,32}$/iu,
  /\bdid not\b[\s\S]{0,32}$/iu,
] as const;

function normalizeRequiredText(params: Record<string, unknown>, key: string, label = key): string {
  const normalized = readStringParam(params, key, { required: true, label, allowEmpty: true })
    .trim()
    .replace(/\r\n/gu, "\n");
  if (!normalized) {
    throw new ToolInputError(`${label} must be non-empty`);
  }
  return normalized;
}

function normalizeRequiredStringList(
  params: Record<string, unknown>,
  key: string,
  label = key,
): string[] {
  const value = readStringArrayParam(params, key, { required: true, label }) ?? [];
  const normalized = value.map((item) => item.trim().replace(/\r\n/gu, "\n")).filter(Boolean);
  if (normalized.length === 0) {
    throw new ToolInputError(`${label} must contain at least one non-empty string`);
  }
  return normalized;
}

function readFlag(params: Record<string, unknown>, key: string): boolean {
  return typeof params[key] === "boolean" ? params[key] : false;
}

function hasUnnegatedPatternMatch(params: { text: string; pattern: RegExp }): boolean {
  const flags = params.pattern.flags.includes("g")
    ? params.pattern.flags
    : `${params.pattern.flags}g`;
  const scanner = new RegExp(params.pattern.source, flags);
  for (const match of params.text.matchAll(scanner)) {
    if (match.index == null) {
      continue;
    }
    const prefix = params.text.slice(Math.max(0, match.index - 64), match.index);
    if (
      !NEGATED_GUARDRAIL_PREFIX_PATTERNS.some((negationPattern) => negationPattern.test(prefix))
    ) {
      return true;
    }
  }
  return false;
}

function ensureNoForbiddenSignals(params: Record<string, unknown>, additionalTexts: string[]) {
  if (readFlag(params, "executionRequested")) {
    throw new ToolInputError(
      "executionRequested must stay false for finance learning capability attachment",
    );
  }
  if (readFlag(params, "autoPromotionRequested")) {
    throw new ToolInputError(
      "autoPromotionRequested must stay false for finance learning capability attachment",
    );
  }
  if (readFlag(params, "doctrineMutationRequested")) {
    throw new ToolInputError(
      "doctrineMutationRequested must stay false for finance learning capability attachment",
    );
  }
  const combinedText = additionalTexts.join("\n");
  if (
    FORBIDDEN_AUTHORITY_PATTERNS.some((pattern) =>
      hasUnnegatedPatternMatch({ text: combinedText, pattern }),
    )
  ) {
    throw new ToolInputError(
      "finance learning capability attachment must stay research-bounded and non-executing",
    );
  }
  if (
    ILLEGAL_COLLECTION_PATTERNS.some((pattern) =>
      hasUnnegatedPatternMatch({ text: combinedText, pattern }),
    )
  ) {
    throw new ToolInputError(
      "illegal collection methods are not allowed in finance learning capability attachment",
    );
  }
}

function ensureNonGenericSummary(summary: string) {
  if (summary.length < 40 || GENERIC_FILLER_PATTERNS.some((pattern) => pattern.test(summary))) {
    throw new ToolInputError(
      "extractionSummary must contain non-generic finance learning content, not filler",
    );
  }
}

function ensureSpecificCapabilityText(params: { value: string; label: string; minLength: number }) {
  const normalized = params.value.trim();
  if (
    normalized.length < params.minLength ||
    GENERIC_CAPABILITY_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    throw new ToolInputError(`${params.label} must be specific enough for later reuse`);
  }
}

function ensureSpecificRequiredDataSources(values: string[], label: string) {
  if (values.length < 2) {
    throw new ToolInputError(`${label} must include at least two concrete data sources`);
  }
  for (const value of values) {
    ensureSpecificCapabilityText({
      value,
      label,
      minLength: 8,
    });
  }
}

function ensureRelativeWorkspacePath(articlePath: string, workspaceDir: string): string {
  const normalizedPath = articlePath.trim();
  if (!normalizedPath) {
    throw new ToolInputError("articlePath must be non-empty");
  }
  if (path.isAbsolute(normalizedPath)) {
    throw new ToolInputError("articlePath must be workspace-relative");
  }
  const resolvedPath = path.resolve(workspaceDir, normalizedPath);
  const resolvedWorkspace = path.resolve(workspaceDir);
  if (
    resolvedPath !== resolvedWorkspace &&
    !resolvedPath.startsWith(`${resolvedWorkspace}${path.sep}`)
  ) {
    throw new ToolInputError("articlePath must stay inside the workspace");
  }
  return resolvedPath;
}

function normalizeSuggestedAttachmentPoint(params: {
  suggestedAttachmentPoint: string;
  relatedFinanceDomains: string[];
  capabilityTags: string[];
}): string {
  const normalized = params.suggestedAttachmentPoint.trim();
  if (!normalized) {
    throw new ToolInputError("suggestedAttachmentPoint must be non-empty");
  }
  if (normalized === "cross_domain_attachment") {
    if (params.relatedFinanceDomains.length < 2) {
      throw new ToolInputError(
        "cross_domain_attachment requires at least two relatedFinanceDomains",
      );
    }
    return normalized;
  }
  if (normalized.startsWith("finance_framework_domain:")) {
    const domain = normalized.slice("finance_framework_domain:".length);
    if (!params.relatedFinanceDomains.includes(domain)) {
      throw new ToolInputError(
        "suggestedAttachmentPoint finance framework domain must exist in relatedFinanceDomains",
      );
    }
    return normalized;
  }
  if (normalized.startsWith("research_capability:")) {
    const capabilityTag = normalized.slice("research_capability:".length);
    if (!params.capabilityTags.includes(capabilityTag)) {
      throw new ToolInputError(
        "suggestedAttachmentPoint research capability must exist in capabilityTags",
      );
    }
    return normalized;
  }
  throw new ToolInputError(
    "suggestedAttachmentPoint must be finance_framework_domain:<domain>, research_capability:<tag>, or cross_domain_attachment",
  );
}

function normalizeCapabilityCandidates(rawCandidates: unknown, sharedText: string[]) {
  if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) {
    throw new ToolInputError("capabilityCandidates must contain at least one candidate");
  }
  return rawCandidates.map((rawCandidate, index) => {
    if (!rawCandidate || typeof rawCandidate !== "object") {
      throw new ToolInputError(`capabilityCandidates[${index}] must be an object`);
    }
    const params = rawCandidate as Record<string, unknown>;
    const capabilityName = normalizeRequiredText(
      params,
      "capabilityName",
      `capabilityCandidates[${index}].capabilityName`,
    );
    const capabilityType = normalizeRequiredText(
      params,
      "capabilityType",
      `capabilityCandidates[${index}].capabilityType`,
    ) as FinanceLearningCapabilityCandidateArtifact["candidates"][number]["capabilityType"];
    if (!(FINANCE_LEARNING_CAPABILITY_TYPES as readonly string[]).includes(capabilityType)) {
      throw new ToolInputError(
        `capabilityCandidates[${index}].capabilityType must be one of: ${FINANCE_LEARNING_CAPABILITY_TYPES.join(", ")}`,
      );
    }
    const relatedFinanceDomains = normalizeRequiredStringList(
      params,
      "relatedFinanceDomains",
      `capabilityCandidates[${index}].relatedFinanceDomains`,
    ) as FinanceLearningCapabilityCandidateArtifact["candidates"][number]["relatedFinanceDomains"];
    if (
      !relatedFinanceDomains.every((domain) =>
        (FINANCE_FRAMEWORK_CORE_DOMAINS as readonly string[]).includes(domain),
      )
    ) {
      throw new ToolInputError(
        `capabilityCandidates[${index}].relatedFinanceDomains must stay inside the finance framework domain contract`,
      );
    }
    const capabilityTags = normalizeRequiredStringList(
      params,
      "capabilityTags",
      `capabilityCandidates[${index}].capabilityTags`,
    ) as FinanceLearningCapabilityCandidateArtifact["candidates"][number]["capabilityTags"];
    if (
      !capabilityTags.every((tag) =>
        (FINANCE_LEARNING_CAPABILITY_TAGS as readonly string[]).includes(tag),
      )
    ) {
      throw new ToolInputError(
        `capabilityCandidates[${index}].capabilityTags must be supported research capability tags`,
      );
    }
    const methodSummary = normalizeRequiredText(
      params,
      "methodSummary",
      `capabilityCandidates[${index}].methodSummary`,
    );
    ensureSpecificCapabilityText({
      value: methodSummary,
      label: `capabilityCandidates[${index}].methodSummary`,
      minLength: 40,
    });
    const evidenceCategories = normalizeRequiredStringList(
      params,
      "evidenceCategories",
      `capabilityCandidates[${index}].evidenceCategories`,
    ) as FinanceLearningCapabilityCandidateArtifact["candidates"][number]["evidenceCategories"];
    const evidenceSummary = normalizeRequiredText(
      params,
      "evidenceSummary",
      `capabilityCandidates[${index}].evidenceSummary`,
    );
    ensureNonGenericEvidenceSummary(
      evidenceSummary,
      `capabilityCandidates[${index}].evidenceSummary`,
    );
    const requiredDataSources = normalizeRequiredStringList(
      params,
      "requiredDataSources",
      `capabilityCandidates[${index}].requiredDataSources`,
    );
    ensureSpecificRequiredDataSources(
      requiredDataSources,
      `capabilityCandidates[${index}].requiredDataSources`,
    );
    const causalOrMechanisticClaim = normalizeRequiredText(
      params,
      "causalOrMechanisticClaim",
      `capabilityCandidates[${index}].causalOrMechanisticClaim`,
    );
    ensureSpecificCapabilityText({
      value: causalOrMechanisticClaim,
      label: `capabilityCandidates[${index}].causalOrMechanisticClaim`,
      minLength: 55,
    });
    const evidenceLevel = normalizeRequiredText(
      params,
      "evidenceLevel",
      `capabilityCandidates[${index}].evidenceLevel`,
    ) as FinanceLearningCapabilityCandidateArtifact["candidates"][number]["evidenceLevel"];
    if (!(FINANCE_LEARNING_EVIDENCE_LEVELS as readonly string[]).includes(evidenceLevel)) {
      throw new ToolInputError(
        `capabilityCandidates[${index}].evidenceLevel must be one of: ${FINANCE_LEARNING_EVIDENCE_LEVELS.join(", ")}`,
      );
    }
    const implementationRequirements = normalizeRequiredText(
      params,
      "implementationRequirements",
      `capabilityCandidates[${index}].implementationRequirements`,
    );
    ensureSpecificCapabilityText({
      value: implementationRequirements,
      label: `capabilityCandidates[${index}].implementationRequirements`,
      minLength: 30,
    });
    const riskAndFailureModes = normalizeRequiredText(
      params,
      "riskAndFailureModes",
      `capabilityCandidates[${index}].riskAndFailureModes`,
    );
    ensureSpecificCapabilityText({
      value: riskAndFailureModes,
      label: `capabilityCandidates[${index}].riskAndFailureModes`,
      minLength: 45,
    });
    const overfittingOrSpuriousRisk = normalizeRequiredText(
      params,
      "overfittingOrSpuriousRisk",
      `capabilityCandidates[${index}].overfittingOrSpuriousRisk`,
    );
    ensureSpecificCapabilityText({
      value: overfittingOrSpuriousRisk,
      label: `capabilityCandidates[${index}].overfittingOrSpuriousRisk`,
      minLength: 45,
    });
    const complianceOrCollectionNotes = normalizeRequiredText(
      params,
      "complianceOrCollectionNotes",
      `capabilityCandidates[${index}].complianceOrCollectionNotes`,
    );
    const allowedActionAuthority = normalizeRequiredText(
      params,
      "allowedActionAuthority",
      `capabilityCandidates[${index}].allowedActionAuthority`,
    ) as FinanceLearningCapabilityCandidateArtifact["candidates"][number]["allowedActionAuthority"];
    if (
      !(FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES as readonly string[]).includes(
        allowedActionAuthority,
      )
    ) {
      throw new ToolInputError(
        `capabilityCandidates[${index}].allowedActionAuthority must be one of: ${FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES.join(", ")}`,
      );
    }
    const suggestedAttachmentPoint = normalizeSuggestedAttachmentPoint({
      suggestedAttachmentPoint: normalizeRequiredText(
        params,
        "suggestedAttachmentPoint",
        `capabilityCandidates[${index}].suggestedAttachmentPoint`,
      ),
      relatedFinanceDomains,
      capabilityTags,
    });
    ensureNoForbiddenSignals(params, [
      ...sharedText,
      capabilityName,
      evidenceSummary,
      methodSummary,
      causalOrMechanisticClaim,
      implementationRequirements,
      riskAndFailureModes,
      complianceOrCollectionNotes,
      suggestedAttachmentPoint,
    ]);
    for (const relatedDomain of relatedFinanceDomains) {
      validateFinanceDomainEvidenceGate({
        domain: relatedDomain,
        evidenceCategories,
        evidenceSummary,
        causalSupportText: causalOrMechanisticClaim,
      });
    }
    validateFinanceCapabilityTagEvidenceGate({
      capabilityTags,
      evidenceCategories,
      sourceArtifactCount: 1,
      riskAndFailureModes,
      overfittingOrSpuriousRisk,
    });
    return {
      capabilityName,
      capabilityType,
      relatedFinanceDomains,
      capabilityTags,
      evidenceCategories,
      evidenceSummary,
      methodSummary,
      requiredDataSources,
      causalOrMechanisticClaim,
      evidenceLevel,
      implementationRequirements,
      riskAndFailureModes,
      overfittingOrSpuriousRisk,
      complianceOrCollectionNotes,
      suggestedAttachmentPoint,
      allowedActionAuthority,
    } satisfies Omit<
      FinanceLearningCapabilityCandidateArtifact["candidates"][number],
      | "candidateId"
      | "sourceArticlePath"
      | "title"
      | "sourceType"
      | "collectionMethod"
      | "authorSourceName"
      | "publishDate"
      | "extractionSummary"
      | "rawNotes"
    >;
  });
}

function buildCandidateId(
  articlePath: string,
  capabilityName: string,
  capabilityType: string,
): string {
  return createHash("sha256")
    .update(`${articlePath}\n${capabilityName}\n${capabilityType}`)
    .digest("hex")
    .slice(0, 16);
}

export function createFinanceLearningCapabilityAttachTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Learning Capability Attach",
    name: "finance_learning_capability_attach",
    description:
      "Record bounded finance learning capability candidates from article-style learning artifacts. This attaches structured learning only, without granting execution authority, auto-promoting anything, or mutating doctrine cards.",
    parameters: FinanceLearningCapabilityAttachSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const articlePath = normalizeRequiredText(params, "articlePath", "articlePath");
      const articleAbsPath = ensureRelativeWorkspacePath(articlePath, workspaceDir);
      let articleContent: string;
      try {
        articleContent = (await fs.readFile(articleAbsPath, "utf8")).trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ToolInputError("source article artifact is missing");
        }
        throw error;
      }
      if (!articleContent) {
        throw new ToolInputError("source article artifact content must be non-empty");
      }

      const title = normalizeRequiredText(params, "title", "title");
      const sourceType = normalizeRequiredText(params, "sourceType", "sourceType");
      const collectionMethod = normalizeRequiredText(
        params,
        "collectionMethod",
        "collectionMethod",
      );
      const extractionSummary = normalizeRequiredText(
        params,
        "extractionSummary",
        "extractionSummary",
      );
      ensureNonGenericSummary(extractionSummary);
      const rawNotes = normalizeRequiredText(params, "rawNotes", "rawNotes");
      const authorSourceName = readStringParam(params, "authorSourceName", { allowEmpty: false });
      const publishDate = readStringParam(params, "publishDate", { allowEmpty: false });
      ensureNoForbiddenSignals(params, [
        title,
        sourceType,
        collectionMethod,
        extractionSummary,
        rawNotes,
        authorSourceName ?? "",
      ]);

      const candidates = normalizeCapabilityCandidates(params.capabilityCandidates, [
        title,
        extractionSummary,
        rawNotes,
        collectionMethod,
      ]);

      const artifactRelPath = buildFinanceLearningCapabilityCandidatesPath();
      const artifactAbsPath = path.join(workspaceDir, artifactRelPath);
      let parsedArtifact = undefined as
        | ReturnType<typeof parseFinanceLearningCapabilityCandidateArtifact>
        | undefined;
      try {
        parsedArtifact = parseFinanceLearningCapabilityCandidateArtifact(
          await fs.readFile(artifactAbsPath, "utf8"),
        );
        if (!parsedArtifact) {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "finance_learning_capability_candidates_malformed",
            artifactPath: artifactRelPath,
            action:
              "Repair or archive the malformed finance learning capability artifact before retrying finance_learning_capability_attach.",
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      const nextCandidates = new Map(
        parsedArtifact?.candidates.map((candidate) => [candidate.candidateId, candidate]) ?? [],
      );
      for (const candidate of candidates) {
        const candidateId = buildCandidateId(
          articlePath,
          candidate.capabilityName,
          candidate.capabilityType,
        );
        nextCandidates.set(candidateId, {
          candidateId,
          sourceArticlePath: articlePath,
          title,
          sourceType:
            sourceType as FinanceLearningCapabilityCandidateArtifact["candidates"][number]["sourceType"],
          collectionMethod:
            collectionMethod as FinanceLearningCapabilityCandidateArtifact["candidates"][number]["collectionMethod"],
          authorSourceName: authorSourceName || undefined,
          publishDate: publishDate || undefined,
          extractionSummary,
          rawNotes,
          ...candidate,
        });
      }

      await fs.mkdir(path.dirname(artifactAbsPath), { recursive: true });
      await fs.writeFile(
        artifactAbsPath,
        renderFinanceLearningCapabilityCandidateArtifact({
          updatedAt: new Date().toISOString(),
          frameworkContractPath: buildFinanceFrameworkCoreContractPath(),
          candidates: [...nextCandidates.values()].toSorted((left, right) =>
            left.candidateId.localeCompare(right.candidateId),
          ),
        }),
        "utf8",
      );

      return jsonResult({
        ok: true,
        updated: true,
        artifactPath: artifactRelPath,
        frameworkContractPath: buildFinanceFrameworkCoreContractPath(),
        sourceArticlePath: articlePath,
        candidateIds: candidates.map((candidate) =>
          buildCandidateId(articlePath, candidate.capabilityName, candidate.capabilityType),
        ),
        inspectTool: "finance_learning_capability_inspect",
        action:
          "This records bounded finance learning capability candidates only. It does not create trading rules, execution approval, doctrine mutation, or auto-promotion.",
      });
    },
  };
}
