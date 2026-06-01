import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFinanceDataGatewaySnapshotTool } from "./finance-data-gateway-tool.js";

async function makeWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "finance-data-gateway-"));
}

function cleanSnapshotArgs() {
  return {
    instrument: "QQQ",
    assetClass: "etf",
    useCase: "portfolio_macro_risk_research",
    asOf: "2026-05-13T20:00:00.000Z",
    freshnessMaxMinutes: 90,
    observations: [
      {
        providerName: "primary-market-api",
        providerRole: "primary_market_data",
        sourceFamily: "market_data_api",
        observedAt: "2026-05-13T20:00:00.000Z",
        timezone: "America/New_York",
        delayStatus: "delayed",
        fields: [
          {
            name: "last_price",
            value: 460.12,
            currency: "USD",
            adjusted: true,
            fieldDefinition: "latest delayed consolidated ETF last trade price",
            sourceTimestamp: "2026-05-13T19:58:00.000Z",
            sourceUrlOrArtifact: "memory/research-sources/qqq-primary-snapshot.json",
          },
        ],
      },
      {
        providerName: "cross-check-market-api",
        providerRole: "cross_check_market_data",
        sourceFamily: "market_data_api",
        observedAt: "2026-05-13T20:00:00.000Z",
        timezone: "America/New_York",
        delayStatus: "delayed",
        fields: [
          {
            name: "last_price",
            value: 460.12,
            currency: "USD",
            adjusted: true,
            fieldDefinition: "latest delayed ETF quote cross-check",
            sourceTimestamp: "2026-05-13T19:58:00.000Z",
            sourceUrlOrArtifact: "memory/research-sources/qqq-cross-check-snapshot.json",
          },
        ],
      },
      {
        providerName: "issuer-reference",
        providerRole: "official_or_issuer_reference",
        sourceFamily: "etf_issuer",
        observedAt: "2026-05-13T20:00:00.000Z",
        timezone: "America/New_York",
        delayStatus: "official_lagged",
        fields: [
          {
            name: "last_price",
            value: 460.12,
            currency: "USD",
            adjusted: true,
            fieldDefinition: "issuer or official reference price field used only as slow check",
            sourceTimestamp: "2026-05-13T19:58:00.000Z",
            sourceUrlOrArtifact: "memory/research-sources/qqq-issuer-reference.json",
          },
        ],
      },
    ],
  };
}

describe("finance_data_gateway_snapshot tool", () => {
  it("normalizes a three-source snapshot and writes a receipt", async () => {
    const workspaceDir = await makeWorkspace();
    const tool = createFinanceDataGatewaySnapshotTool({ workspaceDir });

    const result = await tool.execute("call-1", { ...cleanSnapshotArgs(), writeReceipt: true });

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        boundary: "finance_data_gateway_research_only",
        qualityStatus: "ready",
        receiptPath: expect.stringContaining("memory/finance-data-gateway/"),
        nextTool: "finance_framework_core_inspect",
        notTouched: expect.arrayContaining([
          "provider_config",
          "external_channel_sender",
          "protected_memory",
        ]),
      }),
    );
    expect(result.details).toEqual(
      expect.objectContaining({
        providerRolesPresent: expect.arrayContaining([
          "primary_market_data",
          "cross_check_market_data",
          "official_or_issuer_reference",
        ]),
        normalizedFields: [
          expect.objectContaining({
            name: "last_price",
            value: 460.12,
            currency: "USD",
            sourceTimestamp: "2026-05-13T19:58:00.000Z",
          }),
        ],
        evidenceContract: expect.objectContaining({
          requiredFieldMetadata: expect.arrayContaining([
            "sourceTimestamp",
            "fieldDefinition",
            "unit_or_currency_when_applicable",
            "adjusted_status_when_applicable",
            "sourceUrlOrArtifact",
          ]),
          conflictPolicy: expect.stringContaining("data_provenance_quality_review"),
          asyncReceiptPolicy: expect.stringContaining("queued/completion/failure"),
        }),
        conflicts: [],
      }),
    );

    const receiptPath = (result.details as { receiptPath: string }).receiptPath;
    await expect(fs.stat(path.join(workspaceDir, receiptPath))).resolves.toBeDefined();
  });

  it("routes conflicted provider values to data provenance review", async () => {
    const tool = createFinanceDataGatewaySnapshotTool({ workspaceDir: await makeWorkspace() });
    const args = cleanSnapshotArgs();
    args.observations[1].fields[0].value = 461.88;

    const result = await tool.execute("call-2", args);

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: true,
        qualityStatus: "needs_review",
        nextTool: "data_provenance_quality_review_input",
        requiredNextSteps: expect.arrayContaining(["run_data_provenance_quality_review"]),
        conflicts: [
          expect.objectContaining({
            fieldName: "last_price",
            providerValues: expect.arrayContaining([
              expect.objectContaining({ providerName: "primary-market-api", value: 460.12 }),
              expect.objectContaining({ providerName: "cross-check-market-api", value: 461.88 }),
            ]),
          }),
        ],
      }),
    );
  });

  it("blocks snapshots without a cross-check provider", async () => {
    const tool = createFinanceDataGatewaySnapshotTool({ workspaceDir: await makeWorkspace() });
    const args = cleanSnapshotArgs();
    args.observations = args.observations.filter(
      (observation) => observation.providerRole !== "cross_check_market_data",
    );

    const result = await tool.execute("call-3", args);

    expect(result.details).toEqual(
      expect.objectContaining({
        ok: false,
        qualityStatus: "blocked",
        missingEvidence: expect.arrayContaining(["cross_check_market_data_provider"]),
        requiredNextSteps: expect.arrayContaining(["collect_missing_provider_evidence"]),
      }),
    );
  });
});
