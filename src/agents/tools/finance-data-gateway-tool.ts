import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import {
  buildFinanceDataGatewaySnapshot,
  FINANCE_DATA_DELAY_STATUSES,
  FINANCE_DATA_PROVIDER_ROLES,
  FINANCE_DATA_SOURCE_FAMILIES,
  type FinanceDataGatewayInput,
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
});

const FinanceDataGatewayObservationSchema = Type.Object({
  providerName: Type.String(),
  providerRole: stringEnum(FINANCE_DATA_PROVIDER_ROLES),
  sourceFamily: stringEnum(FINANCE_DATA_SOURCE_FAMILIES),
  legId: Type.Optional(Type.String()),
  observedAt: Type.String(),
  timezone: Type.String(),
  delayStatus: stringEnum(FINANCE_DATA_DELAY_STATUSES),
  fields: Type.Array(FinanceDataGatewayFieldSchema),
});

const FinanceDataGatewaySnapshotSchema = Type.Object({
  instrument: Type.String(),
  assetClass: Type.String(),
  useCase: Type.String(),
  asOf: Type.String(),
  freshnessMaxMinutes: Type.Optional(Type.Number()),
  requireOfficialReference: Type.Optional(Type.Boolean()),
  legs: Type.Optional(
    Type.Array(
      Type.Object({
        legId: Type.String(),
        instrument: Type.String(),
        venue: Type.String(),
        currency: Type.String(),
      }),
    ),
  ),
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
  executionId: string;
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
  await fs.writeFile(
    absPath,
    `${JSON.stringify(
      {
        receiptSchemaVersion: 1,
        receiptCreatedAt: now,
        executionId: params.executionId,
        ...params.payload,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return relPath;
}

export function createFinanceDataGatewaySnapshotTool(options?: {
  workspaceDir?: string;
}): AnyAgentTool {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  return {
    label: "Finance Data Gateway Snapshot",
    name: "finance_data_gateway_snapshot",
    description:
      "Normalize one research-only finance data snapshot from primary, cross-check, and official/issuer sources. It requires timestamps, field definitions, provider roles, and conflict visibility before sourced numbers are used.",
    parameters: FinanceDataGatewaySnapshotSchema,
    execute: async (_toolCallId, args) => {
      const params = args as FinanceDataGatewayInput & { writeReceipt?: boolean };
      const executionId = randomUUID();
      try {
        const snapshot = buildFinanceDataGatewaySnapshot(params);
        const receiptPath =
          params.writeReceipt === true
            ? await writeReceipt({
                workspaceDir,
                instrument: snapshot.instrument,
                executionId,
                payload: snapshot,
              })
            : undefined;
        return jsonResult({
          ...snapshot,
          executionId,
          receiptPath,
          nextTool:
            snapshot.qualityStatus === "ready"
              ? "finance_framework_core_inspect"
              : "data_provenance_quality_review_input",
        });
      } catch (error) {
        throw new ToolInputError((error as Error).message);
      }
    },
  };
}
