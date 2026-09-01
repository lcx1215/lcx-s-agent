#!/usr/bin/env node
import { buildFinanceDataGatewaySnapshot } from "../../src/agents/finance-data-gateway.ts";

function parseArgs(args: string[]) {
  return {
    json: args.includes("--json"),
    caseName: args.includes("--conflict") ? "conflict" : "clean",
  };
}

function buildFixture(caseName: "clean" | "conflict") {
  const crossCheckValue = caseName === "conflict" ? 461.88 : 460.12;
  return {
    instrument: "QQQ",
    assetClass: "etf",
    useCase: "dev_gateway_smoke_portfolio_macro_risk_research",
    asOf: "2026-05-13T20:00:00.000Z",
    freshnessMaxMinutes: 90,
    observations: [
      {
        providerName: "primary-market-api-fixture",
        providerRole: "primary_market_data" as const,
        sourceFamily: "market_data_api" as const,
        observedAt: "2026-05-13T20:00:00.000Z",
        timezone: "America/New_York",
        delayStatus: "delayed" as const,
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
        providerName: "cross-check-market-api-fixture",
        providerRole: "cross_check_market_data" as const,
        sourceFamily: "market_data_api" as const,
        observedAt: "2026-05-13T20:00:00.000Z",
        timezone: "America/New_York",
        delayStatus: "delayed" as const,
        fields: [
          {
            name: "last_price",
            value: crossCheckValue,
            currency: "USD",
            adjusted: true,
            fieldDefinition: "latest delayed ETF quote cross-check",
            sourceTimestamp: "2026-05-13T19:58:00.000Z",
            sourceUrlOrArtifact: "memory/research-sources/qqq-cross-check-snapshot.json",
          },
        ],
      },
      {
        providerName: "issuer-reference-fixture",
        providerRole: "official_or_issuer_reference" as const,
        sourceFamily: "etf_issuer" as const,
        observedAt: "2026-05-13T20:00:00.000Z",
        timezone: "America/New_York",
        delayStatus: "official_lagged" as const,
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

const options = parseArgs(process.argv.slice(2));
const snapshot = buildFinanceDataGatewaySnapshot(buildFixture(options.caseName));

if (options.json) {
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
} else {
  process.stdout.write(
    [
      `ok=${snapshot.ok}`,
      `qualityStatus=${snapshot.qualityStatus}`,
      `providerRoles=${snapshot.providerRolesPresent.join(",")}`,
      `conflicts=${snapshot.conflicts.length}`,
      `missingEvidence=${snapshot.missingEvidence.join(",") || "none"}`,
    ].join("\n"),
  );
  process.stdout.write("\n");
}
