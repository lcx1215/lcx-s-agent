import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFinanceArticleSourceRegistryPath,
  FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS,
  FINANCE_ARTICLE_SOURCE_TYPES,
  FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES,
  parseFinanceArticleSourceRegistryArtifact,
  type FinanceArticleSourceRegistryArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringArrayParam, readStringParam, ToolInputError } from "./common.js";
import {
  ensureNoForbiddenFinanceArticleSourceSignals,
  evaluateFinanceArticleSourcePreflight,
  validateFinanceArticleSourceEntry,
} from "./finance-article-source-collection.js";

const FinanceArticleSourceCollectionPreflightSchema = Type.Object({
  sourceName: Type.Optional(Type.String()),
  sourceType: Type.Optional(stringEnum(FINANCE_ARTICLE_SOURCE_TYPES)),
  sourceUrlOrIdentifier: Type.Optional(Type.String()),
  allowedCollectionMethods: Type.Optional(
    Type.Array(stringEnum(FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS)),
  ),
  requiresManualInput: Type.Optional(Type.Boolean()),
  complianceNotes: Type.Optional(Type.String()),
  rateLimitNotes: Type.Optional(Type.String()),
  freshnessExpectation: Type.Optional(Type.String()),
  reliabilityNotes: Type.Optional(Type.String()),
  extractionTarget: Type.Optional(Type.String()),
  allowedActionAuthority: Type.Optional(stringEnum(FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES)),
  isPubliclyAccessible: Type.Optional(Type.Boolean()),
  requestedCollectionMethod: optionalStringEnum(FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS),
  executionRequested: Type.Optional(Type.Boolean()),
  autoPromotionRequested: Type.Optional(Type.Boolean()),
  doctrineMutationRequested: Type.Optional(Type.Boolean()),
});

function buildInlineEntry(
  params: Record<string, unknown>,
): FinanceArticleSourceRegistryArtifact["sources"][number] {
  const sourceName = readStringParam(params, "sourceName", {
    required: true,
    allowEmpty: true,
  })
    .trim()
    .replace(/\r\n/gu, "\n");
  const sourceType = readStringParam(params, "sourceType", {
    required: true,
  }) as FinanceArticleSourceRegistryArtifact["sources"][number]["sourceType"];
  const sourceUrlOrIdentifier = readStringParam(params, "sourceUrlOrIdentifier", {
    required: true,
    allowEmpty: true,
  })
    .trim()
    .replace(/\r\n/gu, "\n");
  const allowedCollectionMethods = (readStringArrayParam(params, "allowedCollectionMethods", {
    required: true,
  }) ?? []) as FinanceArticleSourceRegistryArtifact["sources"][number]["allowedCollectionMethods"];
  const requiresManualInput =
    typeof params.requiresManualInput === "boolean"
      ? params.requiresManualInput
      : (() => {
          throw new ToolInputError("requiresManualInput must be a boolean");
        })();
  const complianceNotes = readStringParam(params, "complianceNotes", {
    required: true,
    allowEmpty: true,
  })
    .trim()
    .replace(/\r\n/gu, "\n");
  const rateLimitNotes = readStringParam(params, "rateLimitNotes", {
    required: true,
    allowEmpty: true,
  })
    .trim()
    .replace(/\r\n/gu, "\n");
  const freshnessExpectation = readStringParam(params, "freshnessExpectation", {
    required: true,
    allowEmpty: true,
  })
    .trim()
    .replace(/\r\n/gu, "\n");
  const reliabilityNotes = readStringParam(params, "reliabilityNotes", {
    required: true,
    allowEmpty: true,
  })
    .trim()
    .replace(/\r\n/gu, "\n");
  const extractionTarget = readStringParam(params, "extractionTarget", {
    required: true,
    allowEmpty: true,
  })
    .trim()
    .replace(/\r\n/gu, "\n");
  const allowedActionAuthority = readStringParam(params, "allowedActionAuthority", {
    required: true,
  }) as FinanceArticleSourceRegistryArtifact["sources"][number]["allowedActionAuthority"];
  const isPubliclyAccessible =
    typeof params.isPubliclyAccessible === "boolean" ? params.isPubliclyAccessible : false;

  const entry = {
    sourceName,
    sourceType,
    sourceUrlOrIdentifier,
    allowedCollectionMethods,
    requiresManualInput,
    complianceNotes,
    rateLimitNotes,
    freshnessExpectation,
    reliabilityNotes,
    extractionTarget,
    allowedActionAuthority,
    isPubliclyAccessible,
  };
  validateFinanceArticleSourceEntry(entry);
  ensureNoForbiddenFinanceArticleSourceSignals({
    texts: [
      sourceName,
      sourceUrlOrIdentifier,
      complianceNotes,
      rateLimitNotes,
      reliabilityNotes,
      extractionTarget,
      ...allowedCollectionMethods,
    ],
    executionRequested: params.executionRequested === true,
    autoPromotionRequested: params.autoPromotionRequested === true,
    doctrineMutationRequested: params.doctrineMutationRequested === true,
  });
  return entry;
}

export function createFinanceArticleSourceCollectionPreflightTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Article Source Collection Preflight",
    name: "finance_article_source_collection_preflight",
    description:
      "Preflight one finance article source entry or collection request and classify it as allowed, blocked, or manual_only under the safe collection contract. This never fetches remote content automatically.",
    parameters: FinanceArticleSourceCollectionPreflightSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sourceName = readStringParam(params, "sourceName");
      const requestedCollectionMethod = readStringParam(params, "requestedCollectionMethod");

      let entry: FinanceArticleSourceRegistryArtifact["sources"][number];
      let artifactPath: string | null = null;
      const hasInlineEntryFields =
        readStringParam(params, "sourceType") != null ||
        readStringParam(params, "sourceUrlOrIdentifier") != null ||
        readStringParam(params, "complianceNotes") != null;

      if (hasInlineEntryFields) {
        entry = buildInlineEntry(params);
      } else {
        if (!sourceName) {
          throw new ToolInputError(
            "sourceName or a full inline source entry is required for finance article source preflight",
          );
        }
        artifactPath = buildFinanceArticleSourceRegistryPath();
        const artifactAbsPath = path.join(workspaceDir, artifactPath);
        let artifactContent: string;
        try {
          artifactContent = await fs.readFile(artifactAbsPath, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return jsonResult({
              ok: false,
              reason: "finance_article_source_registry_missing",
              artifactPath,
              action:
                "Record at least one finance article source before running registry-backed collection preflight.",
            });
          }
          throw error;
        }
        const parsedArtifact = parseFinanceArticleSourceRegistryArtifact(artifactContent);
        if (!parsedArtifact) {
          return jsonResult({
            ok: false,
            reason: "finance_article_source_registry_malformed",
            artifactPath,
            action:
              "Repair or archive the malformed finance article source registry before retrying finance_article_source_collection_preflight.",
          });
        }
        const matchedEntry = parsedArtifact.sources.find(
          (source) => source.sourceName === sourceName,
        );
        if (!matchedEntry) {
          return jsonResult({
            ok: false,
            reason: "finance_article_source_not_found",
            artifactPath,
            sourceName,
            action:
              "Record the missing finance article source entry before retrying finance_article_source_collection_preflight.",
          });
        }
        entry = matchedEntry;
      }

      const evaluation = evaluateFinanceArticleSourcePreflight({
        entry,
        requestedCollectionMethod: requestedCollectionMethod ?? undefined,
      });
      return jsonResult({
        ok: true,
        sourceName: entry.sourceName,
        sourceType: entry.sourceType,
        requestedCollectionMethod: requestedCollectionMethod ?? null,
        preflightStatus: evaluation.status,
        reason: evaluation.reason,
        artifactPath,
        requiresManualInput: entry.requiresManualInput,
        allowedCollectionMethods: entry.allowedCollectionMethods,
        extractionToolTarget: evaluation.extractionToolTarget,
        action:
          evaluation.extractionToolTarget == null
            ? "This preflight result does not fetch remote content automatically. Continue only with safe manual collection or wait for a future compliant collector."
            : `Safe local/manual collection can continue by preparing the article artifact, then using ${evaluation.extractionToolTarget}.`,
      });
    },
  };
}
