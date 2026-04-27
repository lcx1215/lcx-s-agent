import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES,
  type FinanceFrameworkAllowedActionAuthority,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";
import { ensureNoForbiddenFinanceArticleSourceSignals } from "./finance-article-source-collection.js";
import { createFinanceResearchSourceWorkbenchTool } from "./finance-research-source-workbench-tool.js";

const FINANCE_EXTERNAL_SOURCE_ADAPTER_TYPES = [
  "rss_atom_json_feed",
  "markdown_article_export",
  "local_text_html_article_export",
  "opml_export",
  "external_tool_export_folder",
  "web_search_export",
  "official_reference_export",
] as const;

const FINANCE_EXTERNAL_SOURCE_ADAPTER_COLLECTION_METHODS = [
  "rss_or_public_feed_if_available",
  "local_file",
  "manual_paste",
  "external_tool_export",
  "browser_assisted_manual_collection",
] as const;

const FINANCE_EXTERNAL_SOURCE_FAMILIES = [
  "official_filing",
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

type FinanceExternalSourceAdapterType = (typeof FINANCE_EXTERNAL_SOURCE_ADAPTER_TYPES)[number];
type FinanceExternalSourceAdapterCollectionMethod =
  (typeof FINANCE_EXTERNAL_SOURCE_ADAPTER_COLLECTION_METHODS)[number];
type FinanceExternalSourceFamily = (typeof FINANCE_EXTERNAL_SOURCE_FAMILIES)[number];

const FinanceExternalSourceAdapterSchema = Type.Object({
  adapterName: Type.String(),
  adapterType: stringEnum(FINANCE_EXTERNAL_SOURCE_ADAPTER_TYPES),
  inputPath: Type.Optional(Type.String()),
  feedUrl: Type.Optional(Type.String()),
  referenceUrl: Type.Optional(Type.String()),
  sourceFamily: stringEnum(FINANCE_EXTERNAL_SOURCE_FAMILIES),
  sourceName: Type.String(),
  collectionMethod: stringEnum(FINANCE_EXTERNAL_SOURCE_ADAPTER_COLLECTION_METHODS),
  retrievalNotes: Type.String(),
  complianceNotes: Type.String(),
  title: Type.Optional(Type.String()),
  publishDate: Type.Optional(Type.String()),
  isPubliclyAccessible: Type.Optional(Type.Boolean()),
  allowedActionAuthority: Type.Optional(stringEnum(FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES)),
  executionRequested: Type.Optional(Type.Boolean()),
  autoPromotionRequested: Type.Optional(Type.Boolean()),
  doctrineMutationRequested: Type.Optional(Type.Boolean()),
});

const GENERIC_FILLER_PATTERNS = [
  /^this (article|item|export) (mainly )?(talks|discusses|covers|shares|introduces)\b/iu,
  /^the (article|item|export) is about\b/iu,
  /^general market commentary\b/iu,
  /^misc(ellaneous)? notes?\b/iu,
  /^summary:?\s*general overview\b/iu,
  /^interesting (article|link|export)\b/iu,
  /^random note\b/iu,
] as const;

const FORBIDDEN_ADAPTER_PATTERNS = [
  /credential bypass/iu,
  /paywall bypass/iu,
  /anti-?bot bypass/iu,
  /hidden api scraping/iu,
  /unauthorized bulk scraping/iu,
  /reverse engineer(?:ing)?/iu,
  /captcha solving/iu,
  /proxy-?pool evasion/iu,
  /proxy pool/iu,
];

function normalizeRequiredText(value: string | undefined, label: string): string {
  const normalized = (value ?? "").trim().replace(/\r\n/gu, "\n");
  if (!normalized) {
    throw new ToolInputError(`${label} must be non-empty`);
  }
  return normalized;
}

function ensureSupportedEnum<T extends string>(
  value: string,
  values: readonly T[],
  label: string,
): T {
  if (!(values as readonly string[]).includes(value)) {
    throw new ToolInputError(`${label} must be one of: ${values.join(", ")}`);
  }
  return value as T;
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

function decodeXmlEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'");
}

function normalizeReferenceOrPath(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function ensureRelativeWorkspacePath(filePath: string, workspaceDir: string): string {
  const normalizedPath = filePath.trim();
  if (!normalizedPath) {
    throw new ToolInputError("inputPath must be non-empty");
  }
  if (path.isAbsolute(normalizedPath)) {
    throw new ToolInputError("inputPath must be workspace-relative");
  }
  const resolvedPath = path.resolve(workspaceDir, normalizedPath);
  const resolvedWorkspace = path.resolve(workspaceDir);
  if (
    resolvedPath !== resolvedWorkspace &&
    !resolvedPath.startsWith(`${resolvedWorkspace}${path.sep}`)
  ) {
    throw new ToolInputError("inputPath must stay inside the workspace");
  }
  return resolvedPath;
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

function inferTitleFromText(text: string, fallback?: string): string {
  const explicit =
    extractLabeledValue(text, ["Title", "标题"]) ??
    text.match(/^\s*#\s+(.+)$/mu)?.[1]?.trim() ??
    fallback;
  if (explicit?.trim()) {
    return explicit.trim();
  }
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => Boolean(line));
  return firstLine?.trim() || fallback || "finance-source";
}

function inferSourceTypeFromFamily(
  sourceFamily: FinanceExternalSourceFamily,
):
  | "wechat_public_account_source"
  | "rss_public_feed_source"
  | "manual_article_source"
  | "public_web_source" {
  switch (sourceFamily) {
    case "wechat_public_account":
      return "wechat_public_account_source";
    case "public_feed":
      return "rss_public_feed_source";
    case "local_artifact":
    case "manual_paste":
      return "manual_article_source";
    default:
      return "public_web_source";
  }
}

function ensureNoForbiddenAdapterSignals(params: {
  texts: string[];
  executionRequested?: boolean;
  autoPromotionRequested?: boolean;
  doctrineMutationRequested?: boolean;
}) {
  const combinedText = params.texts.join("\n");
  if (FORBIDDEN_ADAPTER_PATTERNS.some((pattern) => pattern.test(combinedText))) {
    throw new ToolInputError(
      "external finance source adapters must reject reverse engineering, captcha solving, proxy-pool evasion, credential bypass, anti-bot bypass, hidden API scraping, paywall bypass, and unauthorized bulk scraping",
    );
  }
  ensureNoForbiddenFinanceArticleSourceSignals({
    texts: params.texts,
    executionRequested: params.executionRequested,
    autoPromotionRequested: params.autoPromotionRequested,
    doctrineMutationRequested: params.doctrineMutationRequested,
  });
}

type ParsedExportItem = {
  title: string;
  bodyText?: string;
  articleUrl?: string;
  authorSourceName?: string;
  publishDate?: string;
  retrievalNotesSuffix?: string;
  contentKind: "article" | "reference";
};

function extractXmlValue(block: string, tagNames: string[]): string | undefined {
  for (const tagName of tagNames) {
    const match = block.match(
      new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "iu"),
    );
    if (match?.[1]?.trim()) {
      return decodeXmlEntities(match[1].trim());
    }
  }
  return undefined;
}

function extractAtomHref(block: string): string | undefined {
  const hrefMatch = block.match(/<link\b[^>]*href="([^"]+)"/iu);
  return hrefMatch?.[1]?.trim();
}

function parseFeedItemsFromXml(xml: string): ParsedExportItem[] {
  const blocks = [
    ...xml.matchAll(/<item\b[\s\S]*?<\/item>/giu),
    ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/giu),
  ].map((match) => match[0]);

  return blocks
    .map((block) => {
      const title = extractXmlValue(block, ["title"]);
      const articleUrl =
        extractXmlValue(block, ["link"]) ??
        extractAtomHref(block) ??
        extractXmlValue(block, ["guid", "id"]);
      const bodyText = stripHtml(
        extractXmlValue(block, ["content:encoded", "content", "description", "summary"]) ?? "",
      );
      const authorSourceName =
        extractXmlValue(block, ["dc:creator", "author", "name"]) ??
        block.match(/<author\b[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/iu)?.[1]?.trim();
      const publishDate = extractXmlValue(block, ["pubDate", "published", "updated"]);
      if (!title && !articleUrl && !bodyText) {
        return null;
      }
      return {
        title: title?.trim() || articleUrl || "feed-item",
        bodyText: bodyText || undefined,
        articleUrl: articleUrl?.trim(),
        authorSourceName: authorSourceName?.trim(),
        publishDate: publishDate?.trim(),
        contentKind: bodyText ? ("article" as const) : ("reference" as const),
      };
    })
    .flatMap((item) => (item ? [item] : []));
}

function parseFeedItemsFromJson(content: string): ParsedExportItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ToolInputError("inputPath does not contain valid JSON feed export content");
  }

  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown[] }).items)
      ? (parsed as { items: unknown[] }).items
      : [];

  return items
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const title =
        typeof record.title === "string"
          ? record.title.trim()
          : typeof record.name === "string"
            ? record.name.trim()
            : "";
      const articleUrl =
        typeof record.url === "string"
          ? record.url.trim()
          : typeof record.link === "string"
            ? record.link.trim()
            : typeof record.external_url === "string"
              ? record.external_url.trim()
              : undefined;
      const bodyText = stripHtml(
        [
          typeof record.content_text === "string" ? record.content_text : "",
          typeof record.content_html === "string" ? record.content_html : "",
          typeof record.summary === "string" ? record.summary : "",
          typeof record.description === "string" ? record.description : "",
          typeof record.content === "string" ? record.content : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      const authorSourceName =
        typeof record.author === "string"
          ? record.author.trim()
          : typeof record.source === "string"
            ? record.source.trim()
            : undefined;
      const publishDate =
        typeof record.date_published === "string"
          ? record.date_published.trim()
          : typeof record.published === "string"
            ? record.published.trim()
            : typeof record.pubDate === "string"
              ? record.pubDate.trim()
              : undefined;
      if (!title && !articleUrl && !bodyText) {
        return null;
      }
      return {
        title: title || articleUrl || "feed-item",
        bodyText: bodyText || undefined,
        articleUrl,
        authorSourceName,
        publishDate,
        contentKind: bodyText ? ("article" as const) : ("reference" as const),
      };
    })
    .flatMap((item) => (item ? [item] : []));
}

function parseSearchResultItemsFromJson(content: string): ParsedExportItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ToolInputError("inputPath does not contain valid search export JSON content");
  }

  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { items?: unknown[] }).items)
      ? (parsed as { items: unknown[] }).items
      : [];

  return items
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const title =
        typeof record.title === "string"
          ? record.title.trim()
          : typeof record.name === "string"
            ? record.name.trim()
            : "";
      const articleUrl =
        typeof record.url === "string"
          ? record.url.trim()
          : typeof record.link === "string"
            ? record.link.trim()
            : undefined;
      const snippet =
        typeof record.snippet === "string"
          ? record.snippet.trim()
          : typeof record.summary === "string"
            ? record.summary.trim()
            : undefined;
      if (!title && !articleUrl) {
        return null;
      }
      return {
        title: title || articleUrl || "search-result",
        articleUrl,
        retrievalNotesSuffix: snippet ? `Search snippet: ${snippet}` : undefined,
        contentKind: "reference" as const,
      };
    })
    .flatMap((item) => (item ? [item] : []));
}

function parseOpmlEntries(content: string): ParsedExportItem[] {
  return [...content.matchAll(/<outline\b([^>]*)\/?>/giu)]
    .map((match) => {
      const attrs = match[1] ?? "";
      const xmlUrl = attrs.match(/\bxmlUrl="([^"]+)"/iu)?.[1]?.trim();
      const htmlUrl = attrs.match(/\bhtmlUrl="([^"]+)"/iu)?.[1]?.trim();
      const title =
        attrs.match(/\btitle="([^"]+)"/iu)?.[1]?.trim() ??
        attrs.match(/\btext="([^"]+)"/iu)?.[1]?.trim() ??
        htmlUrl ??
        xmlUrl;
      if (!title || (!xmlUrl && !htmlUrl)) {
        return null;
      }
      return {
        title,
        articleUrl: htmlUrl ?? xmlUrl,
        contentKind: "reference" as const,
        retrievalNotesSuffix: xmlUrl ? `OPML feed: ${xmlUrl}` : undefined,
      };
    })
    .flatMap((item) => (item ? [item] : []));
}

async function collectFilesRecursively(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const nextPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        return collectFilesRecursively(nextPath);
      }
      return [nextPath];
    }),
  );
  return files.flat();
}

function relativeWorkspacePath(workspaceDir: string, absolutePath: string): string {
  return path.relative(workspaceDir, absolutePath).split(path.sep).join("/");
}

function annotateResearchArtifact(
  artifactContent: string,
  metadata: {
    adapterName: string;
    adapterType: FinanceExternalSourceAdapterType;
    adapterCollectionMethod: FinanceExternalSourceAdapterCollectionMethod;
    originalSource: string;
    articleUrl?: string;
    authorSourceName?: string;
    publishDate?: string;
    retrievalTimestamp: string;
    adapterComplianceNotes: string;
  },
) {
  const extraLines = [
    `- **Retrieval Timestamp**: ${metadata.retrievalTimestamp}`,
    `- **Adapter Name**: ${metadata.adapterName}`,
    `- **Adapter Type**: ${metadata.adapterType}`,
    `- **Adapter Collection Method**: ${metadata.adapterCollectionMethod}`,
    `- **Original Source**: ${metadata.originalSource}`,
    `- **Article Url**: ${metadata.articleUrl ?? ""}`,
    `- **Author Or Source Name**: ${metadata.authorSourceName ?? ""}`,
    `- **Adapter Compliance Notes**: ${metadata.adapterComplianceNotes}`,
  ];
  return artifactContent.replace(
    /- \*\*Source Name\*\*:/u,
    `${extraLines.join("\n")}\n- **Source Name**:`,
  );
}

async function runWorkbenchWrite(params: {
  workbenchTool: AnyAgentTool;
  workspaceDir: string;
  toolCallId: string;
  sourceName: string;
  sourceFamily: FinanceExternalSourceFamily;
  sourceType: string;
  title: string;
  publishDate?: string;
  retrievalNotes: string;
  allowedActionAuthority: FinanceFrameworkAllowedActionAuthority;
  isPubliclyAccessible: boolean;
  localFilePath?: string;
  pastedText?: string;
  userProvidedUrl?: string;
  adapterMetadata: {
    adapterName: string;
    adapterType: FinanceExternalSourceAdapterType;
    collectionMethod: FinanceExternalSourceAdapterCollectionMethod;
    originalSource: string;
    articleUrl?: string;
    authorSourceName?: string;
    publishDate?: string;
    complianceNotes: string;
  };
}) {
  const workbenchResult = await params.workbenchTool.execute(params.toolCallId, {
    sourceName: params.sourceName,
    sourceType: params.sourceType,
    localFilePath: params.localFilePath,
    pastedText: params.pastedText,
    userProvidedUrl: params.userProvidedUrl,
    title: params.title,
    publishDate: params.publishDate,
    retrievalNotes: params.retrievalNotes,
    allowedActionAuthority: params.allowedActionAuthority,
    isPubliclyAccessible: params.isPubliclyAccessible,
  });

  const details = workbenchResult.details as Record<string, unknown>;
  if (details.ok !== true || typeof details.artifactPath !== "string") {
    throw new ToolInputError("finance research source workbench failed to create a local artifact");
  }

  const artifactPath = details.artifactPath;
  const absoluteArtifactPath = path.join(params.workspaceDir, artifactPath);
  const existing = await fs.readFile(absoluteArtifactPath, "utf8");
  await fs.writeFile(
    absoluteArtifactPath,
    annotateResearchArtifact(existing, {
      adapterName: params.adapterMetadata.adapterName,
      adapterType: params.adapterMetadata.adapterType,
      adapterCollectionMethod: params.adapterMetadata.collectionMethod,
      originalSource: params.adapterMetadata.originalSource,
      articleUrl: params.adapterMetadata.articleUrl,
      authorSourceName: params.adapterMetadata.authorSourceName,
      publishDate: params.adapterMetadata.publishDate,
      retrievalTimestamp: new Date().toISOString(),
      adapterComplianceNotes: params.adapterMetadata.complianceNotes,
    }),
    "utf8",
  );

  return details;
}

export function createFinanceExternalSourceAdapterTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  const workbenchTool = createFinanceResearchSourceWorkbenchTool({ workspaceDir });

  return {
    label: "Finance External Source Adapter",
    name: "finance_external_source_adapter",
    description:
      "Normalize safe external finance source tool outputs, public-feed exports, and official references into local research artifacts without fetching remote content automatically.",
    parameters: FinanceExternalSourceAdapterSchema,
    execute: async (toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const adapterName = normalizeRequiredText(
        readStringParam(params, "adapterName", { required: true, allowEmpty: true }),
        "adapterName",
      );
      const adapterType = ensureSupportedEnum(
        normalizeRequiredText(
          readStringParam(params, "adapterType", { required: true, allowEmpty: true }),
          "adapterType",
        ),
        FINANCE_EXTERNAL_SOURCE_ADAPTER_TYPES,
        "adapterType",
      );
      const sourceFamily = ensureSupportedEnum(
        normalizeRequiredText(
          readStringParam(params, "sourceFamily", { required: true, allowEmpty: true }),
          "sourceFamily",
        ),
        FINANCE_EXTERNAL_SOURCE_FAMILIES,
        "sourceFamily",
      );
      const sourceName = normalizeRequiredText(
        readStringParam(params, "sourceName", { required: true, allowEmpty: true }),
        "sourceName",
      );
      const collectionMethod = ensureSupportedEnum(
        normalizeRequiredText(
          readStringParam(params, "collectionMethod", { required: true, allowEmpty: true }),
          "collectionMethod",
        ),
        FINANCE_EXTERNAL_SOURCE_ADAPTER_COLLECTION_METHODS,
        "collectionMethod",
      );
      const retrievalNotes = normalizeRequiredText(
        readStringParam(params, "retrievalNotes", { required: true, allowEmpty: true }),
        "retrievalNotes",
      );
      const complianceNotes = normalizeRequiredText(
        readStringParam(params, "complianceNotes", { required: true, allowEmpty: true }),
        "complianceNotes",
      );
      const inputPath = normalizeReferenceOrPath(
        readStringParam(params, "inputPath", { allowEmpty: true }),
      );
      const feedUrl = normalizeReferenceOrPath(
        readStringParam(params, "feedUrl", { allowEmpty: true }),
      );
      const referenceUrl = normalizeReferenceOrPath(
        readStringParam(params, "referenceUrl", { allowEmpty: true }),
      );
      if (!inputPath && !feedUrl && !referenceUrl) {
        throw new ToolInputError(
          "One of inputPath, feedUrl, or referenceUrl is required for the external source adapter",
        );
      }

      const allowedActionAuthority =
        (readStringParam(params, "allowedActionAuthority") as
          | FinanceFrameworkAllowedActionAuthority
          | undefined) ?? "research_only";
      ensureSupportedEnum(
        allowedActionAuthority,
        FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES,
        "allowedActionAuthority",
      );
      const titleOverride = normalizeReferenceOrPath(
        readStringParam(params, "title", { allowEmpty: true }),
      );
      const publishDateOverride = normalizeReferenceOrPath(
        readStringParam(params, "publishDate", { allowEmpty: true }),
      );
      const isPubliclyAccessible =
        typeof params.isPubliclyAccessible === "boolean" ? params.isPubliclyAccessible : false;

      ensureNoForbiddenAdapterSignals({
        texts: [
          adapterName,
          adapterType,
          sourceName,
          sourceFamily,
          collectionMethod,
          retrievalNotes,
          inputPath ?? "",
          feedUrl ?? "",
          referenceUrl ?? "",
        ],
        executionRequested: params.executionRequested === true,
        autoPromotionRequested: params.autoPromotionRequested === true,
        doctrineMutationRequested: params.doctrineMutationRequested === true,
      });
      ensureNonGenericText(retrievalNotes, "retrievalNotes");

      const sourceType = inferSourceTypeFromFamily(sourceFamily);
      const normalizedSource = referenceUrl ?? feedUrl ?? inputPath ?? sourceName;

      const normalizedArticleArtifactPaths: string[] = [];
      const normalizedReferenceArtifactPaths: string[] = [];

      const processItem = async (
        item: ParsedExportItem,
        index: number,
        options?: { localFilePath?: string; originalSource?: string },
      ) => {
        const effectiveTitle = item.title || titleOverride || sourceName;
        const effectiveRetrievalNotes = [
          retrievalNotes,
          item.retrievalNotesSuffix,
          options?.localFilePath ? `Imported from ${options.localFilePath}.` : undefined,
        ]
          .filter(Boolean)
          .join(" ");
        const details = await runWorkbenchWrite({
          workbenchTool,
          workspaceDir,
          toolCallId: `${toolCallId}-${index}`,
          sourceName,
          sourceFamily,
          sourceType,
          title: effectiveTitle,
          publishDate: item.publishDate ?? publishDateOverride,
          retrievalNotes: effectiveRetrievalNotes,
          allowedActionAuthority,
          isPubliclyAccessible,
          localFilePath: options?.localFilePath,
          pastedText: options?.localFilePath ? undefined : item.bodyText,
          userProvidedUrl: item.articleUrl ?? referenceUrl ?? feedUrl,
          adapterMetadata: {
            adapterName,
            adapterType,
            collectionMethod,
            originalSource: options?.originalSource ?? normalizedSource,
            articleUrl: item.articleUrl ?? referenceUrl ?? feedUrl,
            authorSourceName: item.authorSourceName,
            publishDate: item.publishDate ?? publishDateOverride,
            complianceNotes,
          },
        });

        const artifactPath = details.artifactPath as string;
        if (item.contentKind === "article") {
          normalizedArticleArtifactPaths.push(artifactPath);
        } else {
          normalizedReferenceArtifactPaths.push(artifactPath);
        }
      };

      if (adapterType === "official_reference_export") {
        await processItem(
          {
            title: titleOverride ?? sourceName,
            articleUrl: referenceUrl ?? feedUrl,
            publishDate: publishDateOverride,
            contentKind: "reference",
          },
          0,
          { originalSource: normalizedSource },
        );
      } else if (adapterType === "web_search_export") {
        if (inputPath) {
          const absoluteInputPath = ensureRelativeWorkspacePath(inputPath, workspaceDir);
          const content = await fs
            .readFile(absoluteInputPath, "utf8")
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") {
                throw new ToolInputError("inputPath is missing");
              }
              throw error;
            });
          if (!content.trim()) {
            throw new ToolInputError("inputPath contains an empty export");
          }
          const items = parseSearchResultItemsFromJson(content);
          if (items.length === 0) {
            throw new ToolInputError("inputPath contains an empty export");
          }
          for (const [index, item] of items.entries()) {
            await processItem(item, index, { originalSource: inputPath });
          }
        } else {
          await processItem(
            {
              title: titleOverride ?? sourceName,
              articleUrl: referenceUrl ?? feedUrl,
              publishDate: publishDateOverride,
              contentKind: "reference",
            },
            0,
            { originalSource: normalizedSource },
          );
        }
      } else if (
        adapterType === "markdown_article_export" ||
        adapterType === "local_text_html_article_export"
      ) {
        if (!inputPath) {
          throw new ToolInputError("inputPath is required for local article adapter types");
        }
        const absoluteInputPath = ensureRelativeWorkspacePath(inputPath, workspaceDir);
        const content = await fs
          .readFile(absoluteInputPath, "utf8")
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") {
              throw new ToolInputError("inputPath is missing");
            }
            throw error;
          });
        const normalizedText =
          path.extname(inputPath).toLowerCase() === ".html" ||
          path.extname(inputPath).toLowerCase() === ".htm"
            ? stripHtml(content)
            : content.trim().replace(/\r\n/gu, "\n");
        if (!normalizedText) {
          throw new ToolInputError("inputPath contains an empty export");
        }
        ensureNonGenericText(normalizedText, "inputPath content");
        const inferredTitle = inferTitleFromText(
          normalizedText,
          titleOverride ?? path.basename(inputPath),
        );
        const inferredAuthor =
          extractLabeledValue(normalizedText, ["Source", "Author", "来源", "作者"]) ?? sourceName;
        const inferredPublishDate =
          extractLabeledValue(normalizedText, ["Publish Date", "Date", "发布日期"]) ??
          publishDateOverride;
        await processItem(
          {
            title: inferredTitle,
            articleUrl: referenceUrl ?? feedUrl,
            authorSourceName: inferredAuthor,
            publishDate: inferredPublishDate ?? undefined,
            contentKind: "article",
          },
          0,
          { localFilePath: inputPath, originalSource: inputPath },
        );
      } else if (adapterType === "rss_atom_json_feed") {
        if (!inputPath) {
          throw new ToolInputError("inputPath is required for rss_atom_json_feed adapter type");
        }
        const absoluteInputPath = ensureRelativeWorkspacePath(inputPath, workspaceDir);
        const content = await fs
          .readFile(absoluteInputPath, "utf8")
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") {
              throw new ToolInputError("inputPath is missing");
            }
            throw error;
          });
        if (!content.trim()) {
          throw new ToolInputError("inputPath contains an empty export");
        }
        const ext = path.extname(inputPath).toLowerCase();
        const items =
          ext === ".json" ? parseFeedItemsFromJson(content) : parseFeedItemsFromXml(content);
        if (items.length === 0) {
          throw new ToolInputError("inputPath contains an empty export");
        }
        for (const [index, item] of items.entries()) {
          if (item.contentKind === "article") {
            ensureNonGenericText(item.bodyText ?? "", `feed item ${index + 1}`);
          }
          await processItem(item, index, { originalSource: inputPath });
        }
      } else if (adapterType === "opml_export") {
        if (!inputPath) {
          throw new ToolInputError("inputPath is required for opml_export adapter type");
        }
        const absoluteInputPath = ensureRelativeWorkspacePath(inputPath, workspaceDir);
        const content = await fs
          .readFile(absoluteInputPath, "utf8")
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") {
              throw new ToolInputError("inputPath is missing");
            }
            throw error;
          });
        if (!content.trim()) {
          throw new ToolInputError("inputPath contains an empty export");
        }
        const entries = parseOpmlEntries(content);
        if (entries.length === 0) {
          throw new ToolInputError("inputPath contains an empty export");
        }
        for (const [index, item] of entries.entries()) {
          await processItem(item, index, { originalSource: inputPath });
        }
      } else if (adapterType === "external_tool_export_folder") {
        if (!inputPath) {
          throw new ToolInputError(
            "inputPath is required for external_tool_export_folder adapter type",
          );
        }
        const absoluteInputPath = ensureRelativeWorkspacePath(inputPath, workspaceDir);
        const stat = await fs.stat(absoluteInputPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") {
            throw new ToolInputError("inputPath is missing");
          }
          throw error;
        });
        if (!stat.isDirectory()) {
          throw new ToolInputError("inputPath must be a directory for external_tool_export_folder");
        }
        const files = await collectFilesRecursively(absoluteInputPath);
        let processedAny = false;
        let batchIndex = 0;
        for (const filePath of files) {
          const relativePath = relativeWorkspacePath(workspaceDir, filePath);
          const ext = path.extname(filePath).toLowerCase();
          if ([".md", ".txt", ".html", ".htm"].includes(ext)) {
            const content = await fs.readFile(filePath, "utf8");
            const normalizedText =
              ext === ".html" || ext === ".htm"
                ? stripHtml(content)
                : content.trim().replace(/\r\n/gu, "\n");
            if (!normalizedText) {
              continue;
            }
            ensureNonGenericText(normalizedText, `external export file ${relativePath}`);
            const inferredTitle = inferTitleFromText(normalizedText, path.basename(relativePath));
            const inferredAuthor =
              extractLabeledValue(normalizedText, ["Source", "Author", "来源", "作者"]) ??
              sourceName;
            const inferredPublishDate =
              extractLabeledValue(normalizedText, ["Publish Date", "Date", "发布日期"]) ??
              publishDateOverride;
            await processItem(
              {
                title: inferredTitle,
                authorSourceName: inferredAuthor,
                publishDate: inferredPublishDate ?? undefined,
                contentKind: "article",
              },
              batchIndex++,
              { localFilePath: relativePath, originalSource: inputPath },
            );
            processedAny = true;
            continue;
          }

          if (ext === ".opml") {
            const content = await fs.readFile(filePath, "utf8");
            const entries = parseOpmlEntries(content);
            for (const entry of entries) {
              await processItem(entry, batchIndex++, {
                originalSource: inputPath,
              });
              processedAny = true;
            }
            continue;
          }

          if ([".xml", ".json", ".rss", ".atom"].includes(ext)) {
            const content = await fs.readFile(filePath, "utf8");
            const items =
              ext === ".json" ? parseFeedItemsFromJson(content) : parseFeedItemsFromXml(content);
            for (const item of items) {
              if (item.contentKind === "article") {
                ensureNonGenericText(item.bodyText ?? "", `external export file ${relativePath}`);
              }
              await processItem(item, batchIndex++, { originalSource: inputPath });
              processedAny = true;
            }
          }
        }
        if (!processedAny) {
          throw new ToolInputError("inputPath contains an empty export");
        }
      } else {
        throw new ToolInputError(`Unsupported adapterType: ${String(adapterType)}`);
      }

      return jsonResult({
        ok: true,
        adapterName,
        adapterType,
        sourceFamily,
        sourceName,
        collectionMethod,
        normalizedArticleArtifactPaths,
        normalizedReferenceArtifactPaths,
        importedCount:
          normalizedArticleArtifactPaths.length + normalizedReferenceArtifactPaths.length,
        extractionToolTarget: "finance_article_extract_capability_input",
        noRemoteUnauthorizedFetchOccurred: true,
        action:
          "This adapter normalized safe external-tool outputs or public references into local research artifacts only. It did not fetch unauthorized remote content, did not create trading rules, and did not mutate doctrine cards.",
      });
    },
  };
}
