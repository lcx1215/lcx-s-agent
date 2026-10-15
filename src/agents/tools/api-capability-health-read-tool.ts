import { Type } from "@sinclair/typebox";
import { inspectEchoApiCliHealth } from "../echoapi-cli-runner.js";
import { inspectFinanceSourceHealth } from "../finance-source-health.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

export const API_CAPABILITY_HEALTH_READ_SCHEMA_VERSION =
  "lcx_api_capability_health_read_v1" as const;

const COINGECKO_ADAPTER_ID = "coingecko_public_crypto_price";

const ApiCapabilityHealthReadSchema = Type.Object({
  workspaceDir: Type.Optional(
    Type.String({
      description:
        "Workspace root used to inspect stored CoinGecko call evidence. Defaults to the process workspace.",
    }),
  ),
  asOf: Type.Optional(
    Type.String({
      description: "ISO timestamp at which both local health snapshots are evaluated.",
    }),
  ),
});

/** Aggregate the requested integrations while preserving their different health meanings. */
export function createApiCapabilityHealthReadTool(
  options: { workspaceDir?: string } = {},
): AnyAgentTool {
  return {
    label: "API Capability Health Read",
    name: "api_capability_health_read",
    description:
      "Read one combined, no-network snapshot for the local EchoAPI CLI and the CoinGecko finance source route. It reports installation, latest invocation, route configuration, stored call evidence, and provider heartbeat separately; it does not claim continuous uptime. Use echoapi_cli_health for an explicit bounded EchoAPI CLI smoke, or finance_realtime_source_refresh with liveFetch=true for an explicit CoinGecko fetch.",
    parameters: ApiCapabilityHealthReadSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspaceDir = resolveWorkspaceRoot(
        readStringParam(params, "workspaceDir") ?? options.workspaceDir,
      );
      const asOf = readStringParam(params, "asOf") ?? new Date().toISOString();
      const [sourceHealth, echoApiHealth] = await Promise.all([
        inspectFinanceSourceHealth({ workspaceDir, asOf }),
        inspectEchoApiCliHealth({ asOf }),
      ]);
      const coinGecko = sourceHealth.routes.find((route) => route.id === COINGECKO_ADAPTER_ID);
      const providerHeartbeat = coinGecko?.providerHeartbeat;

      return jsonResult({
        ok: true,
        schemaVersion: API_CAPABILITY_HEALTH_READ_SCHEMA_VERSION,
        asOf,
        inspectedFrom: { workspaceDir },
        noNetworkCalled: true,
        boundary: "two_integration_snapshots_not_live_connectivity_or_continuous_uptime",
        integrations: {
          echoapi: {
            kind: "local_api_test_harness",
            health: echoApiHealth,
          },
          coingecko: {
            kind: "finance_market_data_source",
            adapterId: COINGECKO_ADAPTER_ID,
            route: coinGecko
              ? {
                  configured: coinGecko.configured,
                  callState: coinGecko.callState,
                  lastObservation: coinGecko.lastObservation
                    ? {
                        asOf: coinGecko.lastObservation.asOf,
                        dispatchedAt: coinGecko.lastObservation.dispatchedAt,
                        status: coinGecko.lastObservation.status,
                        packetStatus: coinGecko.lastObservation.packetStatus,
                      }
                    : null,
                  providerHeartbeat: {
                    stateStatus: sourceHealth.heartbeat.stateStatus,
                    updatedAt: sourceHealth.heartbeat.updatedAt,
                    record: providerHeartbeat
                      ? {
                          status: providerHeartbeat.status,
                          checkedAt: providerHeartbeat.checkedAt,
                          reason: providerHeartbeat.reason,
                          latencyMs: providerHeartbeat.latencyMs,
                          attempts: providerHeartbeat.attempts,
                          httpStatus: providerHeartbeat.httpStatus ?? null,
                          consecutiveFailures: providerHeartbeat.consecutiveFailures ?? null,
                        }
                      : null,
                  },
                }
              : {
                  configured: false,
                  callState: "route_not_declared",
                  lastObservation: null,
                  providerHeartbeat: {
                    stateStatus: sourceHealth.heartbeat.stateStatus,
                    updatedAt: sourceHealth.heartbeat.updatedAt,
                    record: null,
                  },
                },
          },
        },
      });
    },
  };
}
