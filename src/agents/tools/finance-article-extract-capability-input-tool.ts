import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES,
  FINANCE_FRAMEWORK_CORE_DOMAINS,
  FINANCE_EVIDENCE_CATEGORIES,
  FINANCE_LEARNING_CAPABILITY_TAGS,
  FINANCE_LEARNING_CAPABILITY_TYPES,
  FINANCE_LEARNING_COLLECTION_METHODS,
  FINANCE_LEARNING_EVIDENCE_LEVELS,
  FINANCE_LEARNING_SOURCE_TYPES,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const FinanceArticleExtractCapabilityInputSchema = Type.Object({
  articlePath: Type.String(),
  sourceType: Type.Optional(stringEnum(FINANCE_LEARNING_SOURCE_TYPES)),
  collectionMethod: Type.Optional(stringEnum(FINANCE_LEARNING_COLLECTION_METHODS)),
  authorSourceName: Type.Optional(Type.String()),
  publishDate: Type.Optional(Type.String()),
  allowedActionAuthority: Type.Optional(stringEnum(FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES)),
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

const FORBIDDEN_SIGNAL_PATTERNS = [
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

const NEGATED_GUARDRAIL_PREFIX_PATTERNS = [
  /\bwithout\b[\s\S]{0,48}$/iu,
  /\bno\b[\s\S]{0,24}$/iu,
  /\bnot\b[\s\S]{0,24}$/iu,
  /\bnever\b[\s\S]{0,24}$/iu,
  /\bdo not\b[\s\S]{0,32}$/iu,
  /\bdoes not\b[\s\S]{0,32}$/iu,
  /\bdid not\b[\s\S]{0,32}$/iu,
] as const;

function normalizeRequiredText(value: string | undefined, label: string): string {
  const normalized = (value ?? "").trim().replace(/\r\n/gu, "\n");
  if (!normalized) {
    throw new ToolInputError(`${label} missing`);
  }
  return normalized;
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

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/h\d)>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/\r\n/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function extractTitleFromHtml(html: string): string | undefined {
  return html.match(/<title[^>]*>([^<]+)<\/title>/iu)?.[1]?.trim();
}

function normalizeArticleText(params: { content: string; ext: string }) {
  if (params.ext === ".html" || params.ext === ".htm") {
    return {
      plainText: stripHtml(params.content),
      htmlTitle: extractTitleFromHtml(params.content),
    };
  }
  return {
    plainText: params.content.replace(/\r\n/gu, "\n").trim(),
    htmlTitle: undefined,
  };
}

function escapeLabel(label: string): string {
  return label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function extractLabeledValue(text: string, labels: string[]): string | undefined {
  for (const label of labels) {
    const match = text.match(
      new RegExp(`^\\s*(?:[#>*-]+\\s*)?${escapeLabel(label)}\\s*[:：]\\s*(.+)$`, "imu"),
    );
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return undefined;
}

function extractListValue(text: string, labels: string[]): string[] {
  const rawValue = extractLabeledValue(text, labels);
  if (!rawValue) {
    return [];
  }
  return rawValue
    .split(/[;,]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractTitle(text: string, htmlTitle?: string): string | undefined {
  const explicit =
    extractLabeledValue(text, ["Title", "标题"]) ??
    text.match(/^\s*#\s+(.+)$/mu)?.[1]?.trim() ??
    htmlTitle;
  if (explicit?.trim()) {
    return explicit.trim();
  }
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => Boolean(line));
  return firstLine?.trim();
}

function extractPrimaryArticleBody(text: string): string {
  const match = text.match(/(?:^|\n)## Source Content\s*\n([\s\S]+)$/u);
  if (match?.[1]?.trim()) {
    return match[1].trim();
  }
  return text;
}

function normalizeLabeledSourceType(sourceType?: string): string | undefined {
  const normalized = sourceType?.trim();
  if (!normalized) {
    return undefined;
  }
  if ((FINANCE_LEARNING_SOURCE_TYPES as readonly string[]).includes(normalized)) {
    return normalized;
  }
  switch (normalized) {
    case "wechat_public_account_source":
      return "wechat_public_account_article";
    case "public_web_source":
    case "rss_public_feed_source":
      return "public_web_article";
    case "manual_article_source":
      return "manual_learning_note";
    default:
      return undefined;
  }
}

function inferSourceType(params: {
  text: string;
  ext: string;
  explicitSourceType?: string;
}): string {
  if (params.explicitSourceType?.trim()) {
    return params.explicitSourceType.trim();
  }
  const labeled = normalizeLabeledSourceType(
    extractLabeledValue(params.text, ["Source Type", "来源类型"]) ??
      extractLabeledValue(params.text, ["来源平台", "Source Platform"]),
  );
  if (labeled?.trim()) {
    return labeled.trim();
  }
  if (/wechat|public account|公众号/iu.test(params.text)) {
    return "wechat_public_account_article";
  }
  if (params.ext === ".html" || params.ext === ".htm") {
    return "public_web_article";
  }
  return "manual_learning_note";
}

function inferCollectionMethod(params: {
  explicitCollectionMethod?: string;
  sourceType: string;
}): string {
  if (params.explicitCollectionMethod?.trim()) {
    return params.explicitCollectionMethod.trim();
  }
  switch (params.sourceType) {
    case "wechat_public_account_article":
      return "public_wechat_capture";
    case "public_web_article":
      return "public_article_capture";
    case "licensed_research_excerpt":
      return "licensed_excerpt_capture";
    case "internal_research_note":
      return "internal_note_capture";
    default:
      return "manual_review";
  }
}

function ensureNoForbiddenSignals(articleText: string, params: Record<string, unknown>) {
  if (typeof params.executionRequested === "boolean" && params.executionRequested) {
    throw new ToolInputError("executionRequested must stay false for finance article extraction");
  }
  if (typeof params.autoPromotionRequested === "boolean" && params.autoPromotionRequested) {
    throw new ToolInputError(
      "autoPromotionRequested must stay false for finance article extraction",
    );
  }
  if (typeof params.doctrineMutationRequested === "boolean" && params.doctrineMutationRequested) {
    throw new ToolInputError(
      "doctrineMutationRequested must stay false for finance article extraction",
    );
  }
  if (
    FORBIDDEN_SIGNAL_PATTERNS.some((pattern) => {
      const match = articleText.match(pattern);
      if (!match || match.index == null) {
        return false;
      }
      const prefix = articleText.slice(Math.max(0, match.index - 64), match.index);
      return !NEGATED_GUARDRAIL_PREFIX_PATTERNS.some((negationPattern) =>
        negationPattern.test(prefix),
      );
    })
  ) {
    throw new ToolInputError(
      "finance article extraction must stay non-executing, non-promoting, and non-invasive",
    );
  }
}

function ensureNonGenericText(value: string, label: string) {
  const normalized = value.trim();
  if (
    normalized.length < 40 ||
    GENERIC_FILLER_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    throw new ToolInputError(`${label} missing or generic`);
  }
}

function ensureSupportedEnum(value: string, options: readonly string[], label: string) {
  if (!options.includes(value)) {
    throw new ToolInputError(`${label} must be one of: ${options.join(", ")}`);
  }
  return value;
}

type ExtractionBasisEntry = {
  basis: "labeled" | "inferred";
  confidence: "high" | "medium" | "low";
  snippets: string[];
};

type MarkdownSection = {
  heading: string;
  normalizedHeading: string;
  content: string;
};

type ExtractionGapResult = {
  ok: false;
  reason: "finance_article_extraction_gap";
  errorMessage: string;
  extractionGap: {
    extractionMode: "semantic_fallback" | "hybrid";
    missingFields: string[];
    fieldSources: Record<string, ExtractionBasisEntry>;
    action: string;
  };
};

type SuccessfulExtractionResult = {
  ok: true;
  extractedTitle: string;
  sourceType: string;
  collectionMethod: string;
  extractedCandidateCount: number;
  attachTool: "finance_learning_capability_attach";
  attachPayload: {
    articlePath: string;
    title: string;
    sourceType: string;
    collectionMethod: string;
    authorSourceName?: string;
    publishDate?: string;
    extractionSummary: string;
    rawNotes: string;
    capabilityCandidates: Array<{
      capabilityName: string;
      capabilityType: string;
      relatedFinanceDomains: string[];
      capabilityTags: string[];
      evidenceCategories: string[];
      evidenceSummary: string;
      methodSummary: string;
      requiredDataSources: string[];
      causalOrMechanisticClaim: string;
      evidenceLevel: string;
      implementationRequirements: string;
      riskAndFailureModes: string;
      overfittingOrSpuriousRisk: string;
      complianceOrCollectionNotes: string;
      suggestedAttachmentPoint: string;
      allowedActionAuthority: string;
    }>;
  };
  extractionMode: "structured" | "semantic_fallback" | "hybrid";
  extractionBasis: {
    fieldSources: Record<string, ExtractionBasisEntry>;
  };
};

function normalizeHeading(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ");
}

function parseMarkdownSections(text: string): MarkdownSection[] {
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  const sections: MarkdownSection[] = [];
  let currentHeading = "root";
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join("\n").trim();
    if (content) {
      sections.push({
        heading: currentHeading,
        normalizedHeading: normalizeHeading(currentHeading),
        content,
      });
    }
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const headingMatch = line.match(/^##\s+(.+)$/u);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[1].trim();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

function collectTextUnits(text: string): string[] {
  const units: string[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    const value = paragraph.join(" ").replace(/\s+/gu, " ").trim();
    if (value) {
      units.push(value);
    }
    paragraph = [];
  };

  for (const rawLine of text.replace(/\r\n/gu, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      continue;
    }
    if (/^#{1,6}\s+/u.test(line)) {
      flushParagraph();
      continue;
    }
    if (/^[-*]\s+/u.test(line)) {
      flushParagraph();
      units.push(line.replace(/^[-*]\s+/u, "").trim());
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return [...new Set(units)];
}

function collectUnitsFromSections(
  sections: MarkdownSection[],
  headingPatterns: RegExp[],
): string[] {
  return sections
    .filter((section) => headingPatterns.some((pattern) => pattern.test(section.heading)))
    .flatMap((section) => collectTextUnits(section.content));
}

function findMatchingUnits(units: string[], patterns: readonly RegExp[], limit = 3): string[] {
  const matches = units.filter((unit) => patterns.some((pattern) => pattern.test(unit)));
  return [...new Set(matches)].slice(0, limit);
}

function createBasisEntry(params: {
  basis: "labeled" | "inferred";
  confidence: "high" | "medium" | "low";
  snippets: string[];
}): ExtractionBasisEntry {
  return {
    basis: params.basis,
    confidence: params.confidence,
    snippets: [...new Set(params.snippets.map((snippet) => snippet.trim()).filter(Boolean))],
  };
}

function isPotentiallyStructuredArticle(text: string): boolean {
  return [
    "Extraction Summary",
    "Capability Name",
    "Capability Type",
    "Evidence Categories",
    "Method Summary",
    "Risk and Failure Modes",
  ].some((label) =>
    new RegExp(`^\\s*(?:[#>*-]+\\s*)?${escapeLabel(label)}\\s*[:：]`, "imu").test(text),
  );
}

function synthesizeSentence(snippets: string[], fallback: string): string {
  const normalized = snippets
    .map((snippet) => snippet.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");
  return normalized || fallback;
}

function inferSemanticExtraction(params: {
  articlePath: string;
  title: string;
  sourceType: string;
  collectionMethod: string;
  authorSourceName?: string;
  publishDate?: string;
  extractionText: string;
  allowedActionAuthority?: string;
}): SuccessfulExtractionResult | ExtractionGapResult {
  const sections = parseMarkdownSections(params.extractionText);
  const allUnits = collectTextUnits(params.extractionText);
  const durableUnits = collectUnitsFromSections(sections, [/durable lesson/iu]);
  const applyUnits = collectUnitsFromSections(sections, [/apply to/iu, /smallest safe patch/iu]);
  const riskUnits = collectUnitsFromSections(sections, [/red team/iu, /do not apply/iu]);
  const valueUnits = collectUnitsFromSections(sections, [/expected user value/iu, /action/iu]);
  const basis: Record<string, ExtractionBasisEntry> = {};
  const missingFields: string[] = [];

  const labeledAllowedActionAuthority =
    extractLabeledValue(params.extractionText, ["Allowed Action Authority", "允许动作权限"]) ??
    undefined;

  const portfolioRiskUnits = findMatchingUnits(
    [...durableUnits, ...applyUnits, ...riskUnits, ...valueUnits, ...allUnits],
    [
      /\bportfolio construction\b/iu,
      /\ballocation\b/iu,
      /\bsizing\b/iu,
      /\bweights?\b/iu,
      /\brisk gates?\b/iu,
      /\bconstraints?\b/iu,
      /\branking is not sizing\b/iu,
    ],
    4,
  );
  const implementationUnits = findMatchingUnits(
    [...applyUnits, ...valueUnits, ...allUnits],
    [
      /\bexplicit constraints?\b/iu,
      /\bsmallest safe patch\b/iu,
      /\bshould distinguish\b/iu,
      /\bqualitative first\b/iu,
      /\battach a .* sizing lens\b/iu,
      /\ballocation_implication\b/iu,
      /\bbounded portfolio suggestions\b/iu,
      /\bseparating ranking from sizing\b/iu,
    ],
    4,
  );
  const causalUnits = findMatchingUnits(
    [...durableUnits, ...applyUnits, ...riskUnits, ...allUnits],
    [
      /\bbecause\b/iu,
      /\bmatters because\b/iu,
      /\bworks better when\b/iu,
      /\bjump straight into weights\b/iu,
      /\bcreate extreme weight outputs\b/iu,
      /\bbridge between\b/iu,
      /\btranslat(?:e|ing)\b.*\binto\b/iu,
      /\bif .* evidence quality\b/iu,
      /\bonly survives if\b/iu,
      /\bdownstream of evidence quality\b/iu,
    ],
    3,
  );
  const overfittingUnits = findMatchingUnits(
    [...riskUnits, ...durableUnits, ...allUnits],
    [
      /\bfragile\b/iu,
      /\bfalse precision\b/iu,
      /\bunstable weights?\b/iu,
      /\bsophistication mask\b/iu,
      /\bhistorical covariance matrices?\b/iu,
      /\bweak inputs\b/iu,
    ],
    3,
  );

  const relatedFinanceDomains =
    portfolioRiskUnits.length >= 2 && implementationUnits.length >= 1
      ? ["portfolio_risk_gates"]
      : [];
  if (relatedFinanceDomains.length > 0) {
    basis.relatedFinanceDomains = createBasisEntry({
      basis: "inferred",
      confidence: "medium",
      snippets: [...portfolioRiskUnits.slice(0, 2), ...implementationUnits.slice(0, 1)],
    });
  } else {
    missingFields.push("relatedFinanceDomains");
  }

  const capabilityTags =
    relatedFinanceDomains.includes("portfolio_risk_gates") &&
    implementationUnits.length >= 1 &&
    portfolioRiskUnits.length >= 2
      ? ["risk_gate_design"]
      : [];
  if (capabilityTags.length > 0) {
    basis.capabilityTags = createBasisEntry({
      basis: "inferred",
      confidence: "medium",
      snippets: implementationUnits.slice(0, 2),
    });
  } else {
    missingFields.push("capabilityTags");
  }

  const evidenceCategories = [
    ...(portfolioRiskUnits.length >= 2 ? ["portfolio_risk_evidence"] : []),
    ...(implementationUnits.length >= 1 ? ["implementation_evidence"] : []),
  ];
  if (evidenceCategories.length > 0) {
    for (const evidenceCategory of evidenceCategories) {
      ensureSupportedEnum(evidenceCategory, FINANCE_EVIDENCE_CATEGORIES, "evidence_categories");
    }
    basis.evidenceCategories = createBasisEntry({
      basis: "inferred",
      confidence: evidenceCategories.length >= 2 ? "medium" : "low",
      snippets: [...portfolioRiskUnits.slice(0, 2), ...implementationUnits.slice(0, 2)],
    });
  } else {
    missingFields.push("evidenceCategories");
  }

  const methodSummary = synthesizeSentence(
    [...applyUnits, ...durableUnits].filter((unit) =>
      /\b(model|translate|separating ranking from sizing|explicit constraints|allocation language|qualitative first)\b/iu.test(
        unit,
      ),
    ),
    "",
  );
  if (methodSummary) {
    basis.methodSummary = createBasisEntry({
      basis: "inferred",
      confidence: "medium",
      snippets: findMatchingUnits(
        [...applyUnits, ...durableUnits],
        [
          /\bmodel\b/iu,
          /\btranslate\b/iu,
          /\bseparating ranking from sizing\b/iu,
          /\bexplicit constraints?\b/iu,
          /\bqualitative first\b/iu,
        ],
        3,
      ),
    });
  } else {
    missingFields.push("methodSummary");
  }

  const causalOrMechanisticClaim = synthesizeSentence(causalUnits, "");
  if (causalOrMechanisticClaim) {
    basis.causalOrMechanisticClaim = createBasisEntry({
      basis: "inferred",
      confidence: "medium",
      snippets: causalUnits,
    });
  } else {
    missingFields.push("causalOrMechanisticClaim");
  }

  const riskAndFailureModes = synthesizeSentence(
    [...riskUnits, ...allUnits].filter((unit) =>
      /\b(do not|failure mode|misapplied|fragile|fake-precision|unstable weights|weak inputs)\b/iu.test(
        unit,
      ),
    ),
    "",
  );
  if (riskAndFailureModes) {
    basis.riskAndFailureModes = createBasisEntry({
      basis: "inferred",
      confidence: "high",
      snippets: findMatchingUnits(
        [...riskUnits, ...allUnits],
        [
          /\bfailure mode\b/iu,
          /\bmisapplied\b/iu,
          /\bfragile\b/iu,
          /\bfake-precision\b/iu,
          /\bunstable weights?\b/iu,
        ],
        3,
      ),
    });
  } else {
    missingFields.push("riskAndFailureModes");
  }

  const overfittingOrSpuriousRisk = synthesizeSentence(overfittingUnits, "");
  if (overfittingOrSpuriousRisk) {
    basis.overfittingOrSpuriousRisk = createBasisEntry({
      basis: "inferred",
      confidence: "medium",
      snippets: overfittingUnits,
    });
  } else {
    missingFields.push("overfittingOrSpuriousRisk");
  }

  const requiredDataSources = [
    ...(params.extractionText.match(/\bmacro(?:\/| or )fundamental views?\b/iu)
      ? ["qualitative macro or fundamental views"]
      : []),
    ...(params.extractionText.match(
      /\bETF(?:\s*\/\s*major-asset analysis|\sand major-asset research)\b/iu,
    )
      ? ["ETF and major-asset research notes"]
      : []),
    ...(params.extractionText.match(/\bhistorical covariance matrices?\b/iu)
      ? ["historical covariance estimates"]
      : []),
  ];
  if (requiredDataSources.length > 0) {
    basis.requiredDataSources = createBasisEntry({
      basis: "inferred",
      confidence: "medium",
      snippets: findMatchingUnits(
        allUnits,
        [
          /\bmacro(?:\/| or )fundamental views?\b/iu,
          /\bETF(?:\s*\/\s*major-asset analysis|\sand major-asset research)\b/iu,
          /\bhistorical covariance matrices?\b/iu,
        ],
        3,
      ),
    });
  } else {
    missingFields.push("requiredDataSources");
  }

  const evidenceSummary = synthesizeSentence(
    [...portfolioRiskUnits, ...implementationUnits, ...causalUnits].slice(0, 3),
    "",
  );
  if (evidenceSummary) {
    basis.evidenceSummary = createBasisEntry({
      basis: "inferred",
      confidence: "medium",
      snippets: [...portfolioRiskUnits.slice(0, 2), ...implementationUnits.slice(0, 1)],
    });
  } else {
    missingFields.push("evidenceSummary");
  }

  const implementationRequirements = synthesizeSentence(implementationUnits, "");
  if (implementationRequirements) {
    basis.implementationRequirements = createBasisEntry({
      basis: "inferred",
      confidence: "medium",
      snippets: implementationUnits,
    });
  } else {
    missingFields.push("implementationRequirements");
  }

  const capabilityType =
    relatedFinanceDomains.includes("portfolio_risk_gates") ||
    capabilityTags.includes("risk_gate_design")
      ? "risk_method"
      : "";
  if (capabilityType) {
    basis.capabilityType = createBasisEntry({
      basis: "inferred",
      confidence: "medium",
      snippets: [...portfolioRiskUnits.slice(0, 1), ...implementationUnits.slice(0, 1)],
    });
  } else {
    missingFields.push("capabilityType");
  }

  const capabilityName =
    relatedFinanceDomains.includes("portfolio_risk_gates") && /pyportfolioopt/iu.test(params.title)
      ? "PyPortfolioOpt constrained allocation and sizing discipline"
      : relatedFinanceDomains.includes("portfolio_risk_gates")
        ? `${params.title.replace(/^Night Lesson:\s*/iu, "").trim()} allocation discipline`
        : "";
  if (capabilityName) {
    basis.capabilityName = createBasisEntry({
      basis: "inferred",
      confidence: "medium",
      snippets: [params.title, ...portfolioRiskUnits.slice(0, 1)],
    });
  } else {
    missingFields.push("capabilityName");
  }

  const allowedActionAuthority = (() => {
    const explicit = params.allowedActionAuthority?.trim() ?? labeledAllowedActionAuthority?.trim();
    if (explicit) {
      return ensureSupportedEnum(
        explicit,
        FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES,
        "allowed_action_authority",
      );
    }
    if (/\bkeep[_ -]?watching\b/iu.test(params.extractionText)) {
      return "watch_only";
    }
    return "research_only";
  })();
  basis.allowedActionAuthority = createBasisEntry({
    basis: labeledAllowedActionAuthority ? "labeled" : "inferred",
    confidence: labeledAllowedActionAuthority ? "high" : "medium",
    snippets: labeledAllowedActionAuthority
      ? [labeledAllowedActionAuthority]
      : findMatchingUnits(allUnits, [/\bkeep[_ -]?watching\b/iu], 1),
  });

  const extractionSummary = synthesizeSentence(
    [
      `This note extracts a bounded ${capabilityName.toLowerCase()} from ${params.title}.`,
      methodSummary,
      "It remains research-bounded and does not claim a trading edge.",
    ],
    "",
  );
  if (extractionSummary) {
    ensureNonGenericText(extractionSummary, "extractionSummary");
    basis.extractionSummary = createBasisEntry({
      basis: "inferred",
      confidence: "medium",
      snippets: [params.title, ...(basis.methodSummary?.snippets ?? [])],
    });
  } else {
    missingFields.push("extractionSummary");
  }

  const complianceOrCollectionNotes = (() => {
    switch (params.collectionMethod) {
      case "manual_review":
      case "internal_note_capture":
        return "Local operator-provided note captured through bounded manual review under normal access conditions and retained as research-only material.";
      case "public_article_capture":
      case "public_wechat_capture":
      case "licensed_excerpt_capture":
        return "Use normal source access and bounded manual review only under standard publisher or operator-visible conditions.";
      default:
        return "";
    }
  })();
  if (complianceOrCollectionNotes) {
    basis.complianceOrCollectionNotes = createBasisEntry({
      basis: "inferred",
      confidence: "high",
      snippets: [`sourceType=${params.sourceType}`, `collectionMethod=${params.collectionMethod}`],
    });
  } else {
    missingFields.push("complianceOrCollectionNotes");
  }

  const suggestedAttachmentPoint =
    relatedFinanceDomains.length === 1
      ? `finance_framework_domain:${relatedFinanceDomains[0]}`
      : capabilityTags.length === 1
        ? `research_capability:${capabilityTags[0]}`
        : "";
  if (suggestedAttachmentPoint) {
    basis.suggestedAttachmentPoint = createBasisEntry({
      basis: "inferred",
      confidence: "medium",
      snippets: [
        ...(basis.relatedFinanceDomains?.snippets ?? []),
        ...(basis.capabilityTags?.snippets ?? []),
      ],
    });
  } else {
    missingFields.push("suggestedAttachmentPoint");
  }

  const uniqueMissingFields = [...new Set(missingFields)];
  if (uniqueMissingFields.length > 0) {
    return {
      ok: false,
      reason: "finance_article_extraction_gap",
      errorMessage: `semantic extraction could not justify: ${uniqueMissingFields.join(", ")}`,
      extractionGap: {
        extractionMode: isPotentiallyStructuredArticle(params.extractionText)
          ? "hybrid"
          : "semantic_fallback",
        missingFields: uniqueMissingFields,
        fieldSources: basis,
        action:
          "Keep this source as reference material or add clearer method, evidence, mechanism, and risk language before retrying attachment.",
      },
    };
  }

  const evidenceLevel = /source_url:/iu.test(params.extractionText) ? "case_study" : "anecdotal";
  basis.evidenceLevel = createBasisEntry({
    basis: "inferred",
    confidence: "medium",
    snippets: /source_url:/iu.test(params.extractionText)
      ? ["source_url present in note metadata"]
      : [params.title],
  });

  return {
    ok: true,
    extractedTitle: params.title,
    sourceType: params.sourceType,
    collectionMethod: params.collectionMethod,
    extractedCandidateCount: 1,
    attachTool: "finance_learning_capability_attach",
    attachPayload: {
      articlePath: params.articlePath,
      title: params.title,
      sourceType: params.sourceType,
      collectionMethod: params.collectionMethod,
      authorSourceName: params.authorSourceName,
      publishDate: params.publishDate,
      extractionSummary,
      rawNotes: params.extractionText,
      capabilityCandidates: [
        {
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
        },
      ],
    },
    extractionMode: isPotentiallyStructuredArticle(params.extractionText)
      ? "hybrid"
      : "semantic_fallback",
    extractionBasis: {
      fieldSources: basis,
    },
  };
}

function extractStructuredPayload(params: {
  articlePath: string;
  title: string;
  sourceType: string;
  collectionMethod: string;
  authorSourceName?: string;
  publishDate?: string;
  extractionText: string;
  allowedActionAuthority?: string;
}): SuccessfulExtractionResult {
  const extractionSummary = normalizeRequiredText(
    extractLabeledValue(params.extractionText, [
      "Extraction Summary",
      "Summary",
      "摘要",
      "提炼总结",
    ]),
    "extractionSummary",
  );
  ensureNonGenericText(extractionSummary, "extractionSummary");
  const capabilityName = normalizeRequiredText(
    extractLabeledValue(params.extractionText, ["Capability Name", "能力名称"]),
    "capability_name",
  );
  const capabilityType = ensureSupportedEnum(
    normalizeRequiredText(
      extractLabeledValue(params.extractionText, ["Capability Type", "能力类型"]),
      "capability_type",
    ),
    FINANCE_LEARNING_CAPABILITY_TYPES,
    "capability_type",
  );
  const relatedFinanceDomains = extractListValue(params.extractionText, [
    "Related Finance Domains",
    "Related Domains",
    "关联领域",
  ]);
  if (relatedFinanceDomains.length === 0) {
    throw new ToolInputError("related_finance_domains missing");
  }
  for (const domain of relatedFinanceDomains) {
    ensureSupportedEnum(domain, FINANCE_FRAMEWORK_CORE_DOMAINS, "related_finance_domains");
  }
  const capabilityTags = extractListValue(params.extractionText, [
    "Capability Tags",
    "Research Capability Tags",
    "能力标签",
  ]);
  if (capabilityTags.length === 0) {
    throw new ToolInputError("capability_tags missing");
  }
  for (const tag of capabilityTags) {
    ensureSupportedEnum(tag, FINANCE_LEARNING_CAPABILITY_TAGS, "capability_tags");
  }
  const methodSummary = normalizeRequiredText(
    extractLabeledValue(params.extractionText, ["Method Summary", "方法总结"]),
    "method_summary",
  );
  const evidenceCategories = extractListValue(params.extractionText, [
    "Evidence Categories",
    "证据类别",
  ]);
  if (evidenceCategories.length === 0) {
    throw new ToolInputError("evidence_categories missing");
  }
  for (const evidenceCategory of evidenceCategories) {
    ensureSupportedEnum(evidenceCategory, FINANCE_EVIDENCE_CATEGORIES, "evidence_categories");
  }
  const evidenceSummary = normalizeRequiredText(
    extractLabeledValue(params.extractionText, ["Evidence Summary", "证据总结"]),
    "evidence_summary",
  );
  ensureNonGenericText(evidenceSummary, "evidence_summary");
  const requiredDataSources = extractListValue(params.extractionText, [
    "Required Data Sources",
    "Data Sources",
    "所需数据源",
  ]);
  if (requiredDataSources.length === 0) {
    throw new ToolInputError("required_data_sources missing");
  }
  const causalOrMechanisticClaim = normalizeRequiredText(
    extractLabeledValue(params.extractionText, ["Causal Claim", "Mechanistic Claim", "因果机制"]),
    "causal_or_mechanistic_claim",
  );
  const evidenceLevel = ensureSupportedEnum(
    normalizeRequiredText(
      extractLabeledValue(params.extractionText, ["Evidence Level", "证据级别"]),
      "evidence_level",
    ),
    FINANCE_LEARNING_EVIDENCE_LEVELS,
    "evidence_level",
  );
  const implementationRequirements = normalizeRequiredText(
    extractLabeledValue(params.extractionText, ["Implementation Requirements", "实现要求"]),
    "implementation_requirements",
  );
  const riskAndFailureModes = normalizeRequiredText(
    extractLabeledValue(params.extractionText, [
      "Risk and Failure Modes",
      "Failure Modes",
      "风险与失败模式",
    ]),
    "risk_and_failure_modes",
  );
  const overfittingOrSpuriousRisk = normalizeRequiredText(
    extractLabeledValue(params.extractionText, [
      "Overfitting or Spurious Risk",
      "Overfitting Risk",
      "过拟合风险",
    ]),
    "overfitting_or_spurious_risk",
  );
  const complianceOrCollectionNotes = normalizeRequiredText(
    extractLabeledValue(params.extractionText, [
      "Compliance or Collection Notes",
      "Collection Notes",
      "合规与采集说明",
    ]),
    "compliance_or_collection_notes",
  );
  const suggestedAttachmentPoint = normalizeRequiredText(
    extractLabeledValue(params.extractionText, ["Suggested Attachment Point", "挂接点"]),
    "suggested_attachment_point",
  );
  const allowedActionAuthority = ensureSupportedEnum(
    params.allowedActionAuthority ??
      extractLabeledValue(params.extractionText, ["Allowed Action Authority", "允许动作权限"]) ??
      "research_only",
    FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES,
    "allowed_action_authority",
  );

  return {
    ok: true,
    extractedTitle: params.title,
    sourceType: params.sourceType,
    collectionMethod: params.collectionMethod,
    extractedCandidateCount: 1,
    attachTool: "finance_learning_capability_attach",
    attachPayload: {
      articlePath: params.articlePath,
      title: params.title,
      sourceType: params.sourceType,
      collectionMethod: params.collectionMethod,
      authorSourceName: params.authorSourceName,
      publishDate: params.publishDate,
      extractionSummary,
      rawNotes: params.extractionText,
      capabilityCandidates: [
        {
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
        },
      ],
    },
    extractionMode: "structured",
    extractionBasis: {
      fieldSources: {
        extractionSummary: createBasisEntry({
          basis: "labeled",
          confidence: "high",
          snippets: [extractionSummary],
        }),
      },
    },
  };
}

export function createFinanceArticleExtractCapabilityInputTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Article Extract Capability Input",
    name: "finance_article_extract_capability_input",
    description:
      "Extract one attach-ready finance learning capability payload from a local txt, markdown, or simple html article artifact. This is read-only and never creates trading rules, auto-promotion, or doctrine mutation.",
    parameters: FinanceArticleExtractCapabilityInputSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const articlePath = readStringParam(params, "articlePath", {
        required: true,
        allowEmpty: true,
      });
      const articleAbsPath = ensureRelativeWorkspacePath(articlePath, workspaceDir);
      let articleContent: string;
      try {
        articleContent = await fs.readFile(articleAbsPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new ToolInputError("source article artifact is missing");
        }
        throw error;
      }
      if (!articleContent.trim()) {
        throw new ToolInputError("source article artifact content must be non-empty");
      }

      const { plainText, htmlTitle } = normalizeArticleText({
        content: articleContent,
        ext: path.extname(articlePath).toLowerCase(),
      });
      if (!plainText.trim()) {
        throw new ToolInputError("source article artifact content must be non-empty");
      }
      const extractionText = extractPrimaryArticleBody(plainText);
      ensureNoForbiddenSignals(extractionText, params);

      const title = normalizeRequiredText(extractTitle(extractionText, htmlTitle), "title");
      const sourceType = ensureSupportedEnum(
        inferSourceType({
          text: plainText,
          ext: path.extname(articlePath).toLowerCase(),
          explicitSourceType: readStringParam(params, "sourceType", { allowEmpty: false }),
        }),
        FINANCE_LEARNING_SOURCE_TYPES,
        "sourceType",
      );
      const collectionMethod = ensureSupportedEnum(
        inferCollectionMethod({
          explicitCollectionMethod: readStringParam(params, "collectionMethod", {
            allowEmpty: false,
          }),
          sourceType,
        }),
        FINANCE_LEARNING_COLLECTION_METHODS,
        "collectionMethod",
      );
      const authorSourceName =
        readStringParam(params, "authorSourceName", { allowEmpty: false }) ??
        extractLabeledValue(extractionText, ["Source", "Source Name", "来源", "作者"]);
      const publishDate =
        readStringParam(params, "publishDate", { allowEmpty: false }) ??
        extractLabeledValue(extractionText, ["Publish Date", "Date", "发布日期", "日期"]);
      const allowedActionAuthority =
        readStringParam(params, "allowedActionAuthority", { allowEmpty: false }) ?? undefined;

      let extractionResult: SuccessfulExtractionResult | ExtractionGapResult;
      try {
        extractionResult = extractStructuredPayload({
          articlePath,
          title,
          sourceType,
          collectionMethod,
          authorSourceName: authorSourceName ?? undefined,
          publishDate: publishDate ?? undefined,
          extractionText,
          allowedActionAuthority,
        });
      } catch (error) {
        if (error instanceof ToolInputError && /(missing|generic)/iu.test(error.message)) {
          extractionResult = inferSemanticExtraction({
            articlePath,
            title,
            sourceType,
            collectionMethod,
            authorSourceName: authorSourceName ?? undefined,
            publishDate: publishDate ?? undefined,
            extractionText,
            allowedActionAuthority,
          });
        } else {
          throw error;
        }
      }

      if (!extractionResult.ok) {
        return jsonResult({
          ok: false,
          articlePath,
          extractedTitle: title,
          sourceType,
          collectionMethod,
          reason: extractionResult.reason,
          errorMessage: extractionResult.errorMessage,
          extractionGap: extractionResult.extractionGap,
          action:
            "The extractor found real prose but could not justify all required learning fields. No attach-ready candidate was produced.",
        });
      }

      return jsonResult({
        ok: true,
        articlePath,
        extractedTitle: extractionResult.extractedTitle,
        sourceType: extractionResult.sourceType,
        collectionMethod: extractionResult.collectionMethod,
        extractedCandidateCount: extractionResult.extractedCandidateCount,
        attachTool: extractionResult.attachTool,
        attachPayload: extractionResult.attachPayload,
        extractionMode: extractionResult.extractionMode,
        extractionBasis: extractionResult.extractionBasis,
        action:
          "This extraction output is formatted for finance_learning_capability_attach. It does not claim the method works, does not create trading rules, and does not mutate doctrine cards.",
      });
    },
  };
}
