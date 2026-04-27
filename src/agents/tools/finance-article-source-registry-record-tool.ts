import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFinanceArticleSourceRegistryPath,
  FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS,
  FINANCE_ARTICLE_SOURCE_TYPES,
  FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES,
  parseFinanceArticleSourceRegistryArtifact,
  renderFinanceArticleSourceRegistryArtifact,
  type FinanceArticleSourceRegistryArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringArrayParam, readStringParam, ToolInputError } from "./common.js";
import {
  ensureNoForbiddenFinanceArticleSourceSignals,
  evaluateFinanceArticleSourcePreflight,
  validateFinanceArticleSourceEntry,
} from "./finance-article-source-collection.js";

const FinanceArticleSourceRegistryRecordSchema = Type.Object({
  sourceName: Type.String(),
  sourceType: stringEnum(FINANCE_ARTICLE_SOURCE_TYPES),
  sourceUrlOrIdentifier: Type.String(),
  allowedCollectionMethods: Type.Array(stringEnum(FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS)),
  requiresManualInput: Type.Boolean(),
  complianceNotes: Type.String(),
  rateLimitNotes: Type.String(),
  freshnessExpectation: Type.String(),
  reliabilityNotes: Type.String(),
  extractionTarget: Type.String(),
  allowedActionAuthority: stringEnum(FINANCE_FRAMEWORK_ALLOWED_ACTION_AUTHORITIES),
  isPubliclyAccessible: Type.Optional(Type.Boolean()),
  executionRequested: Type.Optional(Type.Boolean()),
  autoPromotionRequested: Type.Optional(Type.Boolean()),
  doctrineMutationRequested: Type.Optional(Type.Boolean()),
});

function normalizeRequiredText(params: Record<string, unknown>, key: string, label = key): string {
  const normalized = readStringParam(params, key, { required: true, allowEmpty: true, label })
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
  const normalized = value.map((item) => item.trim()).filter(Boolean);
  if (normalized.length === 0) {
    throw new ToolInputError(`${label} must contain at least one non-empty string`);
  }
  return normalized;
}

export function createFinanceArticleSourceRegistryRecordTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Article Source Registry Record",
    name: "finance_article_source_registry_record",
    description:
      "Create or refresh one retained finance article source registry entry using only safe collection methods. This writes compliance-bounded source metadata only and never fetches remote content automatically.",
    parameters: FinanceArticleSourceRegistryRecordSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sourceName = normalizeRequiredText(params, "sourceName", "sourceName");
      const sourceType = normalizeRequiredText(
        params,
        "sourceType",
        "sourceType",
      ) as FinanceArticleSourceRegistryArtifact["sources"][number]["sourceType"];
      const sourceUrlOrIdentifier = normalizeRequiredText(
        params,
        "sourceUrlOrIdentifier",
        "sourceUrlOrIdentifier",
      );
      const allowedCollectionMethods = normalizeRequiredStringList(
        params,
        "allowedCollectionMethods",
        "allowedCollectionMethods",
      ) as FinanceArticleSourceRegistryArtifact["sources"][number]["allowedCollectionMethods"];
      const requiresManualInput =
        typeof params.requiresManualInput === "boolean"
          ? params.requiresManualInput
          : (() => {
              throw new ToolInputError("requiresManualInput must be a boolean");
            })();
      const complianceNotes = normalizeRequiredText(params, "complianceNotes", "complianceNotes");
      const rateLimitNotes = normalizeRequiredText(params, "rateLimitNotes", "rateLimitNotes");
      const freshnessExpectation = normalizeRequiredText(
        params,
        "freshnessExpectation",
        "freshnessExpectation",
      );
      const reliabilityNotes = normalizeRequiredText(
        params,
        "reliabilityNotes",
        "reliabilityNotes",
      );
      const extractionTarget = normalizeRequiredText(
        params,
        "extractionTarget",
        "extractionTarget",
      );
      const allowedActionAuthority = normalizeRequiredText(
        params,
        "allowedActionAuthority",
        "allowedActionAuthority",
      ) as FinanceArticleSourceRegistryArtifact["sources"][number]["allowedActionAuthority"];
      const isPubliclyAccessible =
        typeof params.isPubliclyAccessible === "boolean" ? params.isPubliclyAccessible : false;

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

      const sourceEntry = {
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
      validateFinanceArticleSourceEntry(sourceEntry);

      const artifactRelPath = buildFinanceArticleSourceRegistryPath();
      const artifactAbsPath = path.join(workspaceDir, artifactRelPath);
      let parsedArtifact = undefined as
        | ReturnType<typeof parseFinanceArticleSourceRegistryArtifact>
        | undefined;
      try {
        parsedArtifact = parseFinanceArticleSourceRegistryArtifact(
          await fs.readFile(artifactAbsPath, "utf8"),
        );
        if (!parsedArtifact) {
          return jsonResult({
            ok: false,
            updated: false,
            reason: "finance_article_source_registry_malformed",
            artifactPath: artifactRelPath,
            action:
              "Repair or archive the malformed finance article source registry before retrying finance_article_source_registry_record.",
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      const nextSources = new Map(
        parsedArtifact?.sources.map((source) => [source.sourceName, source]) ?? [],
      );
      nextSources.set(sourceName, sourceEntry);

      await fs.mkdir(path.dirname(artifactAbsPath), { recursive: true });
      await fs.writeFile(
        artifactAbsPath,
        renderFinanceArticleSourceRegistryArtifact({
          updatedAt: new Date().toISOString(),
          sources: [...nextSources.values()].toSorted((left, right) =>
            left.sourceName.localeCompare(right.sourceName),
          ),
        }),
        "utf8",
      );

      const preflight = evaluateFinanceArticleSourcePreflight({ entry: sourceEntry });
      return jsonResult({
        ok: true,
        updated: true,
        artifactPath: artifactRelPath,
        sourceName,
        preflightStatus: preflight.status,
        preflightReason: preflight.reason,
        preflightTool: "finance_article_source_collection_preflight",
        inspectTool: "finance_article_source_registry_inspect",
        extractionToolTarget: preflight.extractionToolTarget,
        action:
          "This records a safe finance article source registry entry only. It does not fetch remote content, does not create trading rules, and does not mutate doctrine cards.",
      });
    },
  };
}
