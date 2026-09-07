#!/usr/bin/env node

import {
  createGeospatialSourceRegistry,
  runGeospatialRefresh,
  type GeospatialSourceKind,
} from "../../src/agents/geospatial-source-registry.ts";

function parseArgs(args: string[]) {
  const kindFlagIndex = args.indexOf("--kind");
  const queryFlagIndex = args.indexOf("--query");
  const kind =
    kindFlagIndex >= 0 && args[kindFlagIndex + 1]
      ? (args[kindFlagIndex + 1] as GeospatialSourceKind)
      : "geocode";
  const query =
    queryFlagIndex >= 0 && args[queryFlagIndex + 1] ? args[queryFlagIndex + 1] : "Shanghai";
  return { json: args.includes("--json"), live: args.includes("--live"), kind, query };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.live) {
    process.stdout.write(
      [
        "geospatial-source-live-smoke: dry mode (no network fetch).",
        "Pass --live to query Open-Meteo, Nominatim, or USGS public feeds.",
        "Examples:",
        "  node --import tsx scripts/operator/geospatial-source-live-smoke.ts --live --kind geocode --query Shanghai --json",
        "  node --import tsx scripts/operator/geospatial-source-live-smoke.ts --live --kind weather --query 31.23,121.47 --json",
        "  node --import tsx scripts/operator/geospatial-source-live-smoke.ts --live --kind earthquake --query all_day --json",
        "Boundary: research-only; public API rate limits and attribution requirements apply.",
      ].join("\n"),
    );
    process.stdout.write("\n");
    return 0;
  }

  const receipt = await runGeospatialRefresh({
    request: {
      kind: options.kind,
      query: options.query,
      asOf: new Date().toISOString(),
      freshnessMaxMinutes: options.kind === "earthquake" ? 60 * 24 : 60,
    },
    adapters: createGeospatialSourceRegistry(),
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `kind=${receipt.request.kind}`,
        `query=${receipt.request.query}`,
        `status=${receipt.status}`,
        `sourceAttempts=${receipt.sourceAttempts.map((attempt) => `${attempt.adapterId}:${attempt.status}`).join(",") || "none"}`,
        `missingEvidence=${receipt.missingEvidence.join(",") || "none"}`,
      ].join("\n"),
    );
    process.stdout.write("\n");
  }
  return receipt.status === "blocked" ? 2 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`geospatial_live_smoke_error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
