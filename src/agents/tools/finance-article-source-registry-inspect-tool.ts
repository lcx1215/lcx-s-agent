import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFinanceArticleSourceRegistryPath,
  FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS,
  FINANCE_ARTICLE_SOURCE_TYPES,
  parseFinanceArticleSourceRegistryArtifact,
} from "../../hooks/bundled/lobster-brain-registry.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  evaluateFinanceArticleSourcePreflight,
  FINANCE_ARTICLE_SOURCE_PREFLIGHT_STATUSES,
} from "./finance-article-source-collection.js";

const FinanceArticleSourceRegistryInspectSchema = Type.Object({
  sourceType: Type.Optional(stringEnum(FINANCE_ARTICLE_SOURCE_TYPES)),
  collectionMethod: Type.Optional(stringEnum(FINANCE_ARTICLE_SOURCE_COLLECTION_METHODS)),
  preflightStatus: Type.Optional(stringEnum(FINANCE_ARTICLE_SOURCE_PREFLIGHT_STATUSES)),
});

export function createFinanceArticleSourceRegistryInspectTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Article Source Registry Inspect",
    name: "finance_article_source_registry_inspect",
    description:
      "Inspect retained finance article sources across all entries, by source type, by collection method, or by preflight status. This is read-only and never fetches remote content automatically.",
    parameters: FinanceArticleSourceRegistryInspectSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sourceType = readStringParam(params, "sourceType");
      const collectionMethod = readStringParam(params, "collectionMethod");
      const preflightStatus = readStringParam(params, "preflightStatus");

      const artifactPath = buildFinanceArticleSourceRegistryPath();
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
              "Record at least one finance article source before inspecting the source registry.",
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
            "Repair or archive the malformed finance article source registry before retrying finance_article_source_registry_inspect.",
        });
      }

      const sources = parsedArtifact.sources
        .map((source) => {
          const evaluation = evaluateFinanceArticleSourcePreflight({ entry: source });
          return {
            ...source,
            preflightStatus: evaluation.status,
            preflightReason: evaluation.reason,
            extractionToolTarget: evaluation.extractionToolTarget,
          };
        })
        .filter((source) => {
          if (sourceType && source.sourceType !== sourceType) {
            return false;
          }
          if (
            collectionMethod &&
            !source.allowedCollectionMethods.includes(collectionMethod as never)
          ) {
            return false;
          }
          if (preflightStatus && source.preflightStatus !== preflightStatus) {
            return false;
          }
          return true;
        });

      return jsonResult({
        ok: true,
        artifactPath,
        updatedAt: parsedArtifact.updatedAt,
        sourceCount: sources.length,
        filters: {
          sourceType: sourceType ?? null,
          collectionMethod: collectionMethod ?? null,
          preflightStatus: preflightStatus ?? null,
        },
        sources,
      });
    },
  };
}
