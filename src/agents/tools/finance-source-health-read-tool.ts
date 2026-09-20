import { Type } from "@sinclair/typebox";
import { inspectFinanceSourceHealth } from "../finance-source-health.js";
import { resolveWorkspaceRoot } from "../workspace-dir.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

export const FINANCE_SOURCE_HEALTH_READ_SCHEMA_VERSION =
  "lcx_finance_source_health_read_v1" as const;

const DEFAULT_ROUTE_LIMIT = 40;
const MAX_ROUTE_LIMIT = 500;

const CALL_STATES = [
  "recent_success",
  "recent_failure",
  "verification_expired",
  "unverified",
  "not_configured_or_disabled",
] as const;

const FinanceSourceHealthReadSchema = Type.Object({
  workspaceDir: Type.Optional(
    Type.String({
      description:
        "Workspace root whose stored collection receipts are read as call evidence. Defaults to the process working directory.",
    }),
  ),
  asOf: Type.Optional(
    Type.String({
      description:
        "ISO timestamp the health is evaluated at. A call older than 24h before this instant counts as verification_expired rather than recent success.",
    }),
  ),
  provider: Type.Optional(
    Type.String({ description: "Only report routes belonging to this provider." }),
  ),
  callState: Type.Optional(
    Type.Union(
      CALL_STATES.map((state) => Type.Literal(state)),
      {
        description:
          "Only report routes in this state. The states are: recent_success, recent_failure, verification_expired, unverified, not_configured_or_disabled.",
      },
    ),
  ),
  onlyConfigured: Type.Optional(
    Type.Boolean({ description: "Only report routes whose credentials are present." }),
  ),
  includeQuotas: Type.Optional(
    Type.Boolean({ description: "Include the per-quota-group cooldown state." }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Maximum routes to report (default ${DEFAULT_ROUTE_LIMIT}).`,
    }),
  ),
});

type Route = {
  id: string;
  provider: string;
  configured: boolean;
  quotaGroups: readonly { id: string; state: string; nextAllowedAt?: string }[];
  callState: string;
  lastObservation:
    | {
        asOf: string;
        dispatchedAt: string;
        status: string;
        packetStatus: string;
        receiptPath: string;
      }
    | undefined;
};

function countBy(routes: readonly Route[], key: (route: Route) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const route of routes) {
    const value = key(route);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/**
 * Read-only view of which finance data sources are declared, which are actually credentialed, and
 * what the most recent stored call to each one did.
 *
 * Before this, `inspectFinanceSourceHealth` existed but nothing on the agent side could call it: the
 * model could not ask which sources it may rely on, so every answer about market data rested on an
 * unstated assumption. For a research system the source inventory is load-bearing evidence, not
 * configuration trivia, so it needs a read surface like any other ledger.
 *
 * Three facts this tool exists to state precisely, because collapsing them is what makes a source
 * inventory misleading:
 *   - `not_configured_or_disabled` and `unverified` look equally "empty" but demand opposite
 *     actions: the first needs credentials, the second has them and simply has never been called.
 *   - `recent_failure` is evidence the source was reached and refused, which is a different fact
 *     from `unverified` (never reached at all).
 *   - This is an inventory plus the most recent stored call. It performs **no network probe** and
 *     makes no uptime promise, so `noNetworkCalled` is always true and is reported as such.
 */
export function createFinanceSourceHealthReadTool(
  options: {
    workspaceDir?: string;
  } = {},
): AnyAgentTool {
  return {
    label: "Finance Source Health Read",
    name: "finance_source_health_read",
    description:
      "Read which finance data sources are declared, which of them actually have credentials, and what the most recent stored call to each one did (recent success, recent failure, expired verification, never called, or not configured). Use this before relying on a market data source or before explaining why evidence is missing. It performs no network call and reports stored evidence only.",
    parameters: FinanceSourceHealthReadSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const workspaceDir = readStringParam(params, "workspaceDir") ?? options.workspaceDir;
      const asOf = readStringParam(params, "asOf");
      const providerFilter = readStringParam(params, "provider");
      const callStateFilter = readStringParam(params, "callState");
      const onlyConfigured = params.onlyConfigured === true;
      const includeQuotas = params.includeQuotas === true;
      const requestedLimit = readNumberParam(params, "limit");
      const limit =
        requestedLimit === undefined
          ? DEFAULT_ROUTE_LIMIT
          : Math.max(1, Math.min(Math.trunc(requestedLimit), MAX_ROUTE_LIMIT));

      const notTouched = [
        "trading_execution",
        "order_placement",
        "provider_config",
        "external_channel_sender",
        "protected_memory",
      ] as const;

      const root = resolveWorkspaceRoot(workspaceDir);

      const health = await inspectFinanceSourceHealth({
        workspaceDir: root,
        ...(asOf === undefined ? {} : { asOf }),
      });

      const allRoutes = health.routes as readonly Route[];
      const filtered = allRoutes.filter((route) => {
        if (providerFilter !== undefined && route.provider !== providerFilter) {
          return false;
        }
        if (callStateFilter !== undefined && route.callState !== callStateFilter) {
          return false;
        }
        if (onlyConfigured && !route.configured) {
          return false;
        }
        return true;
      });
      const routes = filtered.slice(0, limit);

      const providerRollup = [...new Set(allRoutes.map((route) => route.provider))]
        .toSorted()
        .map((provider) => {
          const owned = allRoutes.filter((route) => route.provider === provider);
          return {
            provider,
            routeCount: owned.length,
            configuredRouteCount: owned.filter((route) => route.configured).length,
            recentSuccessCount: owned.filter((route) => route.callState === "recent_success")
              .length,
            states: countBy(owned, (route) => route.callState),
          };
        });

      const stateCounts = countBy(allRoutes, (route) => route.callState);
      const configuredButNeverCalled = allRoutes.filter(
        (route) => route.configured && route.callState === "unverified",
      ).length;

      return jsonResult({
        ok: true,
        schemaVersion: FINANCE_SOURCE_HEALTH_READ_SCHEMA_VERSION,
        // Stated rather than implied: an agent that reads "health" and hears "uptime" will treat
        // "no recent success" as "the source is down", which is not what this evidence says.
        boundary: "inventory_and_recent_call_evidence_not_continuous_uptime",
        asOf: health.asOf,
        inspectedFrom: { workspaceDir: root },
        noNetworkCalled: health.noNetworkCalled,
        counts: {
          routes: allRoutes.length,
          configured: allRoutes.filter((route) => route.configured).length,
          byCallState: stateCounts,
        },
        // The distinction that decides the next action, so it is surfaced as its own number rather
        // than left to be subtracted from the state counts.
        configuredButNeverCalled,
        providerCount: health.providerCount,
        routeCount: health.routeCount,
        configuredRouteCount: health.configuredRouteCount,
        recentSuccessCount: health.recentSuccessCount,
        reported: routes.length,
        filtered: filtered.length !== allRoutes.length,
        providers: providerRollup,
        routes: routes.map((route) => ({
          id: route.id,
          provider: route.provider,
          configured: route.configured,
          callState: route.callState,
          lastObservation: route.lastObservation ?? null,
          ...(includeQuotas ? { quotaGroups: route.quotaGroups } : {}),
        })),
        ...(includeQuotas ? { quotas: health.quotas } : {}),
        ...(health.recentSuccessCount === 0
          ? {
              action:
                "No route has a recent successful call in the stored evidence. Read byCallState " +
                "before concluding anything: not_configured_or_disabled needs credentials, " +
                "unverified has credentials and has simply never been called, and only " +
                "recent_failure is evidence a source was reached and refused.",
            }
          : {}),
        notTouched,
      });
    },
  };
}
