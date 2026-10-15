import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  LCX_ONTOLOGY_FINANCE_DATA_DELAY_STATUSES,
  LCX_ONTOLOGY_FINANCE_DATA_PROVIDER_ROLES,
  LCX_ONTOLOGY_FINANCE_DATA_SOURCE_FAMILIES,
} from "../../shared/lcx-ontology.js";
import {
  buildFinanceDataGatewaySnapshot,
  type FinanceDataGatewayInput,
  type FinanceDataGatewaySnapshot,
} from "../finance-data-gateway.js";
import { stringEnum } from "../schema/typebox.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

const FinanceDataGatewayFieldSchema = Type.Object({
  name: Type.String(),
  value: Type.Union([Type.String(), Type.Number()]),
  unit: Type.Optional(Type.String()),
  currency: Type.Optional(Type.String()),
  adjusted: Type.Optional(Type.Boolean()),
  fieldDefinition: Type.String(),
  sourceTimestamp: Type.String(),
  sourceUrlOrArtifact: Type.String(),
  upstreamSourceUrlOrArtifact: Type.Optional(Type.String()),
});

const FinanceDataGatewayObservationSchema = Type.Object({
  providerName: Type.String(),
  providerRole: stringEnum(LCX_ONTOLOGY_FINANCE_DATA_PROVIDER_ROLES),
  sourceFamily: stringEnum(LCX_ONTOLOGY_FINANCE_DATA_SOURCE_FAMILIES),
  observedAt: Type.String(),
  timezone: Type.String(),
  delayStatus: stringEnum(LCX_ONTOLOGY_FINANCE_DATA_DELAY_STATUSES),
  fields: Type.Array(FinanceDataGatewayFieldSchema),
});

const FinanceDataGatewaySnapshotSchema = Type.Object({
  instrument: Type.String(),
  assetClass: Type.String(),
  useCase: Type.String(),
  asOf: Type.String(),
  asOfMode: Type.Optional(stringEnum(["historical", "live_now"])),
  freshnessMaxMinutes: Type.Optional(Type.Number()),
  crossSourceSkewMaxMinutes: Type.Optional(Type.Number({ minimum: 0 })),
  requireOfficialReference: Type.Optional(Type.Boolean()),
  observations: Type.Array(FinanceDataGatewayObservationSchema),
  writeReceipt: Type.Optional(Type.Boolean()),
});

function safeReceiptStem(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/-+/gu, "-")
      .replace(/^-|-$/gu, "") || "finance-data"
  );
}

async function writeReceipt(params: {
  workspaceDir: string;
  instrument: string;
  payload: Record<string, unknown>;
}) {
  const now = new Date().toISOString();
  const dateKey = now.slice(0, 10);
  const relPath = path.join(
    "memory",
    "finance-data-gateway",
    `${dateKey}-${safeReceiptStem(params.instrument)}-${now.replace(/[:.]/gu, "-")}.json`,
  );
  const absPath = path.join(params.workspaceDir, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, `${JSON.stringify(params.payload, null, 2)}\n`, "utf8");
  return relPath;
}

/** Review targets name module inputs; only nextTool names a callable tool. */
export function financeDataGatewayFollowUp(
  qualityStatus: FinanceDataGatewaySnapshot["qualityStatus"],
  availableTools?: readonly string[],
) {
  const ready = qualityStatus === "ready";
  const nextTool = ready ? "finance_framework_core_inspect" : "finance_data_gateway_snapshot";
  return {
    ...(availableTools === undefined || availableTools.includes(nextTool) ? { nextTool } : {}),
    nextReviewTarget: ready ? "finance_framework_core" : "data_provenance_quality_review_input",
    ...(ready ? {} : { retryOnlyAfter: "new_or_corrected_source_observations" }),
  };
}

export function createFinanceDataGatewaySnapshotTool(options?: {
  workspaceDir?: string;
  /** Host-supplied callable inventory; omitted preserves the ordinary agent inventory. */
  availableTools?: readonly string[];
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Data Gateway Snapshot",
    name: "finance_data_gateway_snapshot",
    description:
      "Normalize one research-only finance data snapshot from primary, cross-check, and official/issuer sources. It requires timestamps, field definitions, provider roles, and conflict visibility before sourced numbers are used. Each primary field needs a different declared provider and source address for its cross-check. Declared shared upstream documents and tracking-only URL differences cannot qualify as cross-checks. Undeclared upstream provenance and paraphrased copies cannot be detected; sourceIndependence.upstreamLineage remains not_assessed. nextReviewTarget is a module input, not a callable tool. For a quality gap, use nextTool only after supplying new or corrected source observations; repeating identical input cannot resolve it.",
    parameters: FinanceDataGatewaySnapshotSchema,
    execute: async (_toolCallId, args) => {
      const params = args as FinanceDataGatewayInput & { writeReceipt?: boolean };
      try {
        const snapshot = buildFinanceDataGatewaySnapshot(params);
        const receiptPath =
          params.writeReceipt === true
            ? await writeReceipt({
                workspaceDir,
                instrument: snapshot.instrument,
                payload: snapshot,
              })
            : undefined;
        return jsonResult({
          ...snapshot,
          receiptPath,
          ...financeDataGatewayFollowUp(snapshot.qualityStatus, options?.availableTools),
        });
      } catch (error) {
        throw new ToolInputError((error as Error).message);
      }
    },
  };
}
