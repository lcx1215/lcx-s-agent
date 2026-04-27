import {
  FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS,
  FINANCE_ARTICLE_SOURCE_TYPES,
  FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES,
  type FinanceArticleSourceRegistryArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { ToolInputError } from "./common.js";

export const FINANCE_ARTICLE_SOURCE_PREFLIGHT_STATUSES = [
  "allowed",
  "blocked",
  "manual_only",
] as const;

export type FinanceArticleSourcePreflightStatus =
  (typeof FINANCE_ARTICLE_SOURCE_PREFLIGHT_STATUSES)[number];

const FORBIDDEN_COLLECTION_PATTERNS = [
  /credential bypass/iu,
  /paywall bypass/iu,
  /anti-?bot bypass/iu,
  /hidden api scraping/iu,
  /unauthorized bulk scraping/iu,
  /illegal collection method/iu,
  /bypass login/iu,
  /scrape behind login/iu,
  /stolen cookie/iu,
  /captcha bypass/iu,
  /bulk scrape/iu,
  /hidden api/iu,
];

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
];

type FinanceArticleSourceEntry = FinanceArticleSourceRegistryArtifact["sources"][number];

export function ensureNoForbiddenFinanceArticleSourceSignals(params: {
  texts: string[];
  executionRequested?: boolean;
  autoPromotionRequested?: boolean;
  doctrineMutationRequested?: boolean;
}) {
  if (params.executionRequested) {
    throw new ToolInputError("executionRequested must stay false for finance article sources");
  }
  if (params.autoPromotionRequested) {
    throw new ToolInputError("autoPromotionRequested must stay false for finance article sources");
  }
  if (params.doctrineMutationRequested) {
    throw new ToolInputError(
      "doctrineMutationRequested must stay false for finance article sources",
    );
  }
  const combinedText = params.texts.join("\n");
  if (FORBIDDEN_COLLECTION_PATTERNS.some((pattern) => pattern.test(combinedText))) {
    throw new ToolInputError(
      "finance article source registration must reject credential bypass, paywall bypass, anti-bot bypass, hidden API scraping, and unauthorized bulk scraping",
    );
  }
  if (FORBIDDEN_AUTHORITY_PATTERNS.some((pattern) => pattern.test(combinedText))) {
    throw new ToolInputError(
      "finance article source registration must stay non-executing, non-promoting, and non-doctrinal",
    );
  }
}

export function validateFinanceArticleSourceEntry(entry: FinanceArticleSourceEntry) {
  if (!(FINANCE_ARTICLE_SOURCE_TYPES as readonly string[]).includes(entry.sourceType)) {
    throw new ToolInputError(
      `sourceType must be one of: ${FINANCE_ARTICLE_SOURCE_TYPES.join(", ")}`,
    );
  }
  if (
    !(FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES as readonly string[]).includes(
      entry.allowedActionAuthority,
    )
  ) {
    throw new ToolInputError(
      `allowedActionAuthority must be one of: ${FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES.join(", ")}`,
    );
  }
  if (entry.allowedCollectionMethods.length === 0) {
    throw new ToolInputError("allowedCollectionMethods must contain at least one safe method");
  }
  if (
    !entry.allowedCollectionMethods.every((method) =>
      (FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS as readonly string[]).includes(method),
    )
  ) {
    throw new ToolInputError(
      `allowedCollectionMethods must stay inside the safe collection contract: ${FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS.join(", ")}`,
    );
  }
}

export function evaluateFinanceArticleSourcePreflight(params: {
  entry: FinanceArticleSourceEntry;
  requestedCollectionMethod?: string;
}) {
  const requestedMethod = params.requestedCollectionMethod?.trim();
  if (
    requestedMethod &&
    !(FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS as readonly string[]).includes(requestedMethod)
  ) {
    return {
      status: "blocked" as const,
      reason: "requested_collection_method_not_allowed",
      extractionToolTarget: null,
    };
  }

  const methods = requestedMethod ? [requestedMethod] : params.entry.allowedCollectionMethods;

  if (
    params.entry.sourceType === "wechat_public_account_source" &&
    methods.includes("rss_or_public_feed_if_available")
  ) {
    if (params.entry.isPubliclyAccessible) {
      return {
        status: "allowed" as const,
        reason: "safe_public_feed_available_for_wechat_source",
        extractionToolTarget: null,
      };
    }
    return {
      status: "manual_only" as const,
      reason: "wechat_public_account_sources_remain_manual_only_without_a_safe_public_feed",
      extractionToolTarget:
        methods.includes("manual_paste") || methods.includes("local_file")
          ? params.entry.extractionTarget
          : null,
    };
  }

  if (params.entry.sourceType === "rss_public_feed_source") {
    if (!params.entry.isPubliclyAccessible) {
      return {
        status: "blocked" as const,
        reason: "rss_or_public_feed_sources_must_be_marked_public",
        extractionToolTarget: null,
      };
    }
    return {
      status: "allowed" as const,
      reason: "public_feed_collection_is_allowed",
      extractionToolTarget: null,
    };
  }

  if (methods.includes("local_file")) {
    return {
      status: "allowed" as const,
      reason: "local_file_collection_is_allowed",
      extractionToolTarget: params.entry.extractionTarget,
    };
  }

  if (methods.includes("manual_paste")) {
    return {
      status: "manual_only" as const,
      reason: "manual_paste_is_required_before_article_extraction",
      extractionToolTarget: params.entry.extractionTarget,
    };
  }

  if (methods.includes("browser_assisted_manual_collection")) {
    return {
      status: "manual_only" as const,
      reason: "browser_assisted_manual_collection_is_required",
      extractionToolTarget: null,
    };
  }

  if (methods.includes("user_provided_url")) {
    return {
      status: "manual_only" as const,
      reason: "user_provided_url_requires_manual_save_before_extraction",
      extractionToolTarget: null,
    };
  }

  if (methods.includes("rss_or_public_feed_if_available")) {
    return {
      status: params.entry.isPubliclyAccessible ? ("allowed" as const) : ("blocked" as const),
      reason: params.entry.isPubliclyAccessible
        ? "public_feed_collection_is_allowed"
        : "rss_or_public_feed_sources_must_be_marked_public",
      extractionToolTarget: null,
    };
  }

  return {
    status: "blocked" as const,
    reason: "no_safe_collection_method_is_available",
    extractionToolTarget: null,
  };
}
