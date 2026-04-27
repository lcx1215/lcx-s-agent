import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFinanceArticleSourceRegistryPath,
  FINANCE_ARTICLE_SOURCE_TYPES,
  FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES,
  parseFinanceArticleSourceRegistryArtifact,
  type FinanceArticleSourceRegistryArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";
import {
  ensureNoForbiddenFinanceArticleSourceSignals,
  evaluateFinanceArticleSourcePreflight,
  validateFinanceArticleSourceEntry,
} from "./finance-article-source-collection.js";

const FINANCE_RESEARCH_SOURCE_FAMILIES = [
  "official_filing",
  "official_reference",
  "academic_preprint",
  "github_repository",
  "official_macro_data",
  "company_ir",
  "etf_issuer",
  "news",
  "research_blog",
  "public_feed",
  "public_web_reference",
  "wechat_public_account",
  "local_artifact",
  "manual_paste",
] as const;

const FinanceResearchSourceWorkbenchSchema = Type.Object({
  sourceName: Type.String(),
  sourceType: Type.Optional(stringEnum(FINANCE_ARTICLE_SOURCE_TYPES)),
  pastedText: Type.Optional(Type.String()),
  localFilePath: Type.Optional(Type.String()),
  userProvidedUrl: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  publishDate: Type.Optional(Type.String()),
  retrievalNotes: Type.String(),
  allowedActionAuthority: Type.Optional(stringEnum(FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES)),
  isPubliclyAccessible: Type.Optional(Type.Boolean()),
  executionRequested: Type.Optional(Type.Boolean()),
  autoPromotionRequested: Type.Optional(Type.Boolean()),
  doctrineMutationRequested: Type.Optional(Type.Boolean()),
});

const GENERIC_FILLER_PATTERNS = [
  /^this (article|source) (mainly )?(talks|discusses|covers|shares|introduces)\b/iu,
  /^the (article|source) is about\b/iu,
  /^general market commentary\b/iu,
  /^misc(ellaneous)? notes?\b/iu,
  /^summary:?\s*general overview\b/iu,
  /^interesting (article|link)\b/iu,
  /^copied text\b/iu,
  /^random note\b/iu,
] as const;

const TEXT_LIKE_EXTENSIONS = new Set([".txt", ".md", ".html", ".htm"]);

function normalizeRequiredText(value: string | undefined, label: string): string {
  const normalized = (value ?? "").trim().replace(/\r\n/gu, "\n");
  if (!normalized) {
    throw new ToolInputError(`${label} must be non-empty`);
  }
  return normalized;
}

function ensureNonGenericText(value: string, label: string) {
  const normalized = value.trim();
  if (
    normalized.length < 40 ||
    GENERIC_FILLER_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    throw new ToolInputError(`${label} must contain non-generic finance research content`);
  }
}

function ensureRelativeWorkspacePath(filePath: string, workspaceDir: string): string {
  const normalizedPath = filePath.trim();
  if (!normalizedPath) {
    throw new ToolInputError("localFilePath must be non-empty");
  }
  if (path.isAbsolute(normalizedPath)) {
    throw new ToolInputError("localFilePath must be workspace-relative");
  }
  const resolvedPath = path.resolve(workspaceDir, normalizedPath);
  const resolvedWorkspace = path.resolve(workspaceDir);
  if (
    resolvedPath !== resolvedWorkspace &&
    !resolvedPath.startsWith(`${resolvedWorkspace}${path.sep}`)
  ) {
    throw new ToolInputError("localFilePath must stay inside the workspace");
  }
  return resolvedPath;
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/gu, "")
    .replace(/-+$/gu, "");
  return normalized || "research-source";
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

function inferSourceFamily(params: {
  sourceName: string;
  sourceType: FinanceArticleSourceRegistryArtifact["sources"][number]["sourceType"];
  title: string;
  userProvidedUrl?: string;
  localFilePath?: string;
  pastedText?: string;
  retrievalNotes: string;
}) {
  if (params.sourceType === "wechat_public_account_source") {
    return "wechat_public_account" as const;
  }
  if (params.sourceType === "rss_public_feed_source") {
    return "public_feed" as const;
  }
  if (params.sourceType === "official_reference_source") {
    return "official_reference" as const;
  }
  if (params.sourceType === "academic_preprint_source") {
    return "academic_preprint" as const;
  }
  if (params.sourceType === "github_repository_source") {
    return "github_repository" as const;
  }

  const haystack = [
    params.sourceName,
    params.title,
    params.userProvidedUrl ?? "",
    params.localFilePath ?? "",
    params.retrievalNotes,
  ].join("\n");

  if (/(google\.com\/search|google search|search result)/iu.test(haystack)) {
    return "public_web_reference" as const;
  }
  if (/(edgar|10-k|10q|8-k|form 4|def 14a)/iu.test(haystack)) {
    return "official_filing" as const;
  }
  if (
    /(sec\.gov|investor\.gov|federalreserve\.gov|official reference|official guide)/iu.test(
      haystack,
    )
  ) {
    return "official_reference" as const;
  }
  if (
    /(arxiv\.org|arxiv:|ssrn\.com|openreview\.net|academic preprint|working paper)/iu.test(haystack)
  ) {
    return "academic_preprint" as const;
  }
  if (
    /(github\.com|gitlab\.com|source repo|repository|readme\.md|open source repo)/iu.test(haystack)
  ) {
    return "github_repository" as const;
  }
  if (
    /(fred|bls\.gov|bea\.gov|treasury\.gov|fiscaldata\.treasury|cpi|pce|payroll)/iu.test(haystack)
  ) {
    return "official_macro_data" as const;
  }
  if (
    /(investor relations|\/ir\b|investors\.|shareholder|earnings release|annual report)/iu.test(
      haystack,
    )
  ) {
    return "company_ir" as const;
  }
  if (
    /(ishares|vanguard|invesco|ssga|state street|schwab etf|etf issuer|fund factsheet)/iu.test(
      haystack,
    )
  ) {
    return "etf_issuer" as const;
  }
  if (
    /(reuters|bloomberg|cnbc|ft\.com|wsj|financial news|marketwatch|yahoo finance)/iu.test(haystack)
  ) {
    return "news" as const;
  }
  if (/(substack|newsletter|blog|whitepaper|research note|newsletter)/iu.test(haystack)) {
    return "research_blog" as const;
  }
  if (params.localFilePath) {
    return "local_artifact" as const;
  }
  if (params.userProvidedUrl) {
    return "public_web_reference" as const;
  }
  if (params.pastedText) {
    return "manual_paste" as const;
  }
  return "public_web_reference" as const;
}

function inferInlineSourceEntry(params: {
  sourceName: string;
  sourceType?: string;
  userProvidedUrl?: string;
  localFilePath?: string;
  pastedText?: string;
  allowedActionAuthority: FinanceArticleSourceRegistryArtifact["sources"][number]["allowedActionAuthority"];
  isPubliclyAccessible: boolean;
}): FinanceArticleSourceRegistryArtifact["sources"][number] {
  const sourceType =
    (params.sourceType as
      | FinanceArticleSourceRegistryArtifact["sources"][number]["sourceType"]
      | undefined) ??
    (params.userProvidedUrl?.includes("wechat") ? "wechat_public_account_source" : undefined) ??
    (params.userProvidedUrl ? "public_web_source" : undefined) ??
    (params.localFilePath ? "manual_article_source" : undefined) ??
    (params.pastedText ? "manual_article_source" : undefined);
  if (!sourceType) {
    throw new ToolInputError(
      "sourceType is required when the source is not already in the registry",
    );
  }

  const allowedCollectionMethods =
    params.localFilePath != null
      ? ["local_file"]
      : params.pastedText != null
        ? ["manual_paste"]
        : sourceType === "rss_public_feed_source"
          ? ["rss_or_public_feed_if_available"]
          : ["user_provided_url"];

  const sourceUrlOrIdentifier =
    params.userProvidedUrl?.trim() || params.localFilePath?.trim() || params.sourceName;

  const entry = {
    sourceName: params.sourceName,
    sourceType,
    sourceUrlOrIdentifier,
    allowedCollectionMethods,
    requiresManualInput:
      allowedCollectionMethods.includes("manual_paste") ||
      allowedCollectionMethods.includes("browser_assisted_manual_collection") ||
      allowedCollectionMethods.includes("user_provided_url"),
    complianceNotes:
      "Use only operator-provided local/manual/public paths. Do not bypass login, paywalls, anti-bot controls, hidden APIs, robots restrictions, or platform restrictions.",
    rateLimitNotes:
      "No automated remote collection. Keep any future collection operator-paced and low-frequency.",
    freshnessExpectation: "manual_check_required",
    reliabilityNotes:
      "Treat this source as research input only until the operator validates the captured content and evidence quality.",
    extractionTarget: "finance_article_extract_capability_input",
    allowedActionAuthority: params.allowedActionAuthority,
    isPubliclyAccessible: params.isPubliclyAccessible,
  } satisfies FinanceArticleSourceRegistryArtifact["sources"][number];
  validateFinanceArticleSourceEntry(entry);
  return entry;
}

async function resolveSourceEntry(params: {
  workspaceDir: string;
  sourceName: string;
  sourceType?: string;
  userProvidedUrl?: string;
  localFilePath?: string;
  pastedText?: string;
  allowedActionAuthority: FinanceArticleSourceRegistryArtifact["sources"][number]["allowedActionAuthority"];
  isPubliclyAccessible: boolean;
}) {
  if (!params.sourceType) {
    const artifactPath = buildFinanceArticleSourceRegistryPath();
    const artifactAbsPath = path.join(params.workspaceDir, artifactPath);
    try {
      const parsed = parseFinanceArticleSourceRegistryArtifact(
        await fs.readFile(artifactAbsPath, "utf8"),
      );
      const matched = parsed?.sources.find((source) => source.sourceName === params.sourceName);
      if (matched) {
        return matched;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return inferInlineSourceEntry(params);
}

async function normalizeLocalContent(params: {
  workspaceDir: string;
  localFilePath?: string;
  pastedText?: string;
}) {
  if (params.pastedText != null) {
    const normalized = params.pastedText.trim().replace(/\r\n/gu, "\n");
    if (!normalized) {
      throw new ToolInputError("pastedText must be non-empty");
    }
    ensureNonGenericText(normalized, "pastedText");
    return {
      retrievalMethod: "manual_paste",
      localContent: normalized,
      contentKind: "normalized_local_content",
      sourceIdentifierForAudit: "manual_paste_input",
    } as const;
  }

  if (params.localFilePath != null) {
    const localFileAbsPath = ensureRelativeWorkspacePath(params.localFilePath, params.workspaceDir);
    let content: string;
    try {
      content = await fs.readFile(localFileAbsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ToolInputError("localFilePath is missing");
      }
      throw error;
    }
    const ext = path.extname(params.localFilePath).toLowerCase();
    if (TEXT_LIKE_EXTENSIONS.has(ext)) {
      const normalized =
        ext === ".html" || ext === ".htm"
          ? stripHtml(content)
          : content.trim().replace(/\r\n/gu, "\n");
      if (!normalized) {
        throw new ToolInputError("localFilePath content must be non-empty");
      }
      ensureNonGenericText(normalized, "localFilePath content");
      return {
        retrievalMethod: "local_file",
        localContent: normalized,
        contentKind: "normalized_local_content",
        sourceIdentifierForAudit: params.localFilePath,
      } as const;
    }
    return {
      retrievalMethod: "local_file",
      localContent:
        "Binary or non-text local artifact reference only. No remote fetch occurred. Manual text extraction is still required before finance_article_extract_capability_input.",
      contentKind: "metadata_only_reference",
      sourceIdentifierForAudit: params.localFilePath,
    } as const;
  }

  return {
    retrievalMethod: "user_provided_url",
    localContent:
      "Metadata-only reference. No remote content was fetched. Prepare a local/manual article artifact before running finance_article_extract_capability_input.",
    contentKind: "metadata_only_reference",
    sourceIdentifierForAudit: "user_provided_url",
  } as const;
}

function buildResearchArtifactRelPath(params: {
  sourceFamily: (typeof FINANCE_RESEARCH_SOURCE_FAMILIES)[number];
  sourceName: string;
  title: string;
}) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const slug = slugify(`${params.sourceName}-${params.title}`);
  return path.join("memory", "research-sources", `${dateKey}-${params.sourceFamily}-${slug}.md`);
}

function renderResearchSourceArtifact(params: {
  createdAt: string;
  sourceName: string;
  sourceType: string;
  sourceFamily: (typeof FINANCE_RESEARCH_SOURCE_FAMILIES)[number];
  sourceUrlOrIdentifier: string;
  retrievalMethod: string;
  collectionPosture: string;
  complianceNotes: string;
  freshnessNotes: string;
  reliabilityNotes: string;
  title: string;
  publishDate?: string;
  retrievalNotes: string;
  extractionTarget: string | null;
  contentKind: string;
  sourceContent: string;
}) {
  return [
    "# Finance Research Source Artifact",
    "",
    `- **Created At**: ${params.createdAt}`,
    `- **Source Name**: ${params.sourceName}`,
    `- **Source Type**: ${params.sourceType}`,
    `- **Source Family**: ${params.sourceFamily}`,
    `- **Source Url Or Identifier**: ${params.sourceUrlOrIdentifier}`,
    `- **Retrieval Method**: ${params.retrievalMethod}`,
    `- **Collection Posture**: ${params.collectionPosture}`,
    `- **Compliance Notes**: ${params.complianceNotes}`,
    `- **Freshness Notes**: ${params.freshnessNotes}`,
    `- **Reliability Notes**: ${params.reliabilityNotes}`,
    `- **Title**: ${params.title}`,
    `- **Publish Date**: ${params.publishDate ?? ""}`,
    `- **Retrieval Notes**: ${params.retrievalNotes}`,
    `- **Extraction Target**: ${params.extractionTarget ?? ""}`,
    `- **Content Kind**: ${params.contentKind}`,
    "",
    "## Source Content",
    params.sourceContent,
    "",
  ].join("\n");
}

export function createFinanceResearchSourceWorkbenchTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Research Source Workbench",
    name: "finance_research_source_workbench",
    description:
      "Normalize operator-provided finance research sources from manual paste, local files, or safe URL references into local audit artifacts. This tool runs collection preflight, never fetches remote content automatically, and returns the next extraction target when safe.",
    parameters: FinanceResearchSourceWorkbenchSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sourceName = normalizeRequiredText(
        readStringParam(params, "sourceName", { required: true, allowEmpty: true }),
        "sourceName",
      );
      const retrievalNotes = normalizeRequiredText(
        readStringParam(params, "retrievalNotes", { required: true, allowEmpty: true }),
        "retrievalNotes",
      );
      ensureNonGenericText(retrievalNotes, "retrievalNotes");

      const pastedText = readStringParam(params, "pastedText", { allowEmpty: true });
      const localFilePath = readStringParam(params, "localFilePath", { allowEmpty: true });
      const userProvidedUrl = readStringParam(params, "userProvidedUrl", { allowEmpty: true });
      if ("pastedText" in params && typeof params.pastedText === "string" && !pastedText) {
        throw new ToolInputError("pastedText must be non-empty");
      }
      if (!pastedText && !localFilePath && !userProvidedUrl) {
        throw new ToolInputError(
          "One of pastedText, localFilePath, or userProvidedUrl is required for the finance research source workbench",
        );
      }

      const allowedActionAuthority =
        (readStringParam(params, "allowedActionAuthority") as
          | FinanceArticleSourceRegistryArtifact["sources"][number]["allowedActionAuthority"]
          | undefined) ?? "research_only";
      const isPubliclyAccessible =
        typeof params.isPubliclyAccessible === "boolean" ? params.isPubliclyAccessible : false;
      const title =
        readStringParam(params, "title", { allowEmpty: true })?.trim() ??
        (localFilePath ? path.basename(localFilePath) : undefined) ??
        (userProvidedUrl ? userProvidedUrl : undefined) ??
        sourceName;
      const publishDate = readStringParam(params, "publishDate", { allowEmpty: false });

      const sourceEntry = await resolveSourceEntry({
        workspaceDir,
        sourceName,
        sourceType: readStringParam(params, "sourceType"),
        userProvidedUrl: userProvidedUrl ?? undefined,
        localFilePath: localFilePath ?? undefined,
        pastedText: pastedText ?? undefined,
        allowedActionAuthority,
        isPubliclyAccessible,
      });

      ensureNoForbiddenFinanceArticleSourceSignals({
        texts: [
          sourceName,
          title,
          retrievalNotes,
          userProvidedUrl ?? "",
          localFilePath ?? "",
          pastedText ?? "",
        ],
        executionRequested: params.executionRequested === true,
        autoPromotionRequested: params.autoPromotionRequested === true,
        doctrineMutationRequested: params.doctrineMutationRequested === true,
      });

      const preflight = evaluateFinanceArticleSourcePreflight({
        entry: sourceEntry,
      });
      if (preflight.status === "blocked") {
        return jsonResult({
          ok: false,
          reason: "finance_research_source_blocked_by_preflight",
          sourceName,
          sourceType: sourceEntry.sourceType,
          preflightStatus: preflight.status,
          preflightReason: preflight.reason,
          action:
            "This source is blocked under the safe collection contract. Do not create a local research artifact until the source posture becomes compliant.",
        });
      }

      const normalizedContent = await normalizeLocalContent({
        workspaceDir,
        localFilePath: localFilePath ?? undefined,
        pastedText: pastedText ?? undefined,
      });
      const extractionReadyNow = normalizedContent.contentKind === "normalized_local_content";
      const extractionToolTarget = extractionReadyNow
        ? "finance_article_extract_capability_input"
        : null;

      const sourceFamily = inferSourceFamily({
        sourceName,
        sourceType: sourceEntry.sourceType,
        title,
        userProvidedUrl: userProvidedUrl ?? undefined,
        localFilePath: localFilePath ?? undefined,
        pastedText: pastedText ?? undefined,
        retrievalNotes,
      });

      const artifactRelPath = buildResearchArtifactRelPath({
        sourceFamily,
        sourceName,
        title,
      });
      const artifactAbsPath = path.join(workspaceDir, artifactRelPath);
      const sourceUrlOrIdentifier =
        userProvidedUrl ?? localFilePath ?? sourceEntry.sourceUrlOrIdentifier;
      await fs.mkdir(path.dirname(artifactAbsPath), { recursive: true });
      await fs.writeFile(
        artifactAbsPath,
        renderResearchSourceArtifact({
          createdAt: new Date().toISOString(),
          sourceName,
          sourceType: sourceEntry.sourceType,
          sourceFamily,
          sourceUrlOrIdentifier,
          retrievalMethod: normalizedContent.retrievalMethod,
          collectionPosture: preflight.status,
          complianceNotes: sourceEntry.complianceNotes,
          freshnessNotes: sourceEntry.freshnessExpectation,
          reliabilityNotes: sourceEntry.reliabilityNotes,
          title,
          publishDate: publishDate ?? undefined,
          retrievalNotes,
          extractionTarget: extractionToolTarget,
          contentKind: normalizedContent.contentKind,
          sourceContent: normalizedContent.localContent,
        }),
        "utf8",
      );

      return jsonResult({
        ok: true,
        artifactPath: artifactRelPath,
        sourceName,
        sourceType: sourceEntry.sourceType,
        sourceFamily,
        retrievalMethod: normalizedContent.retrievalMethod,
        collectionPosture: preflight.status,
        complianceNotes: sourceEntry.complianceNotes,
        freshnessNotes: sourceEntry.freshnessExpectation,
        reliabilityNotes: sourceEntry.reliabilityNotes,
        sourceUrlOrIdentifier,
        metadataPreservedForAudit: true,
        extractionReadyNow,
        requiresManualCaptureBeforeExtraction: !extractionReadyNow,
        extractionToolTarget,
        extractionToolTargetAfterManualCapture: "finance_article_extract_capability_input",
        noRemoteFetchOccurred: true,
        action: extractionReadyNow
          ? "This workbench created a local finance research source artifact from local/manual content only. It did not fetch remote content automatically, did not create trading rules, and did not mutate doctrine cards."
          : "This workbench created a metadata-only finance research source artifact. It did not fetch remote content automatically; capture local/manual article content before extraction, capability attachment, or doctrine review.",
      });
    },
  };
}
