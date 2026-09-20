/**
 * Finance data connector registry.
 *
 * Single point of declaration for every external finance data interface this system may call.
 * Two rules borrowed from how the large vendors actually ship these surfaces:
 *
 * 1. Connectors are declared once, here, and shared — not re-declared per caller.
 * 2. Connectors are sharded by business domain (A-share quotes vs. index vs. fund vs. futures
 *    vs. options), so one call never has to load every tool of every provider at once.
 *
 * The ontology has no news source family. News connectors are declared as market_data_api
 * rather than extending the controlled vocabulary, which would need a versioned migration.
 *
 * This module is declaration and routing only. It never fetches; see `finance-mcp-client.ts`
 * for transport and the gateway contract in `finance-data-gateway.ts` for evidence rules.
 */

import {
  type LcxOntologyFinanceDataProviderRole,
  type LcxOntologyFinanceDataSourceFamily,
} from "../shared/lcx-ontology.js";

export const FINANCE_DATA_CONNECTOR_SCHEMA_VERSION = "lcx_finance_data_connectors_v1" as const;

/** Business-domain shards. One MCP endpoint per domain, mirroring the vendor-side split. */
export const FINANCE_DATA_CONNECTOR_DOMAINS = [
  "a_share",
  "a_share_index",
  "meta",
  "fund",
  "futures",
  "options",
  "macro",
  "filings",
  "news",
  "global_equity",
  "crypto",
] as const;

export type FinanceDataConnectorDomain = (typeof FINANCE_DATA_CONNECTOR_DOMAINS)[number];

/**
 * Access paths, in the order the router prefers them. `browser` is the last resort for
 * sources that expose no API at all — never the default.
 */
export const FINANCE_DATA_CONNECTOR_TRANSPORTS = ["mcp_remote", "rest", "sdk", "browser"] as const;

export type FinanceDataConnectorTransport = (typeof FINANCE_DATA_CONNECTOR_TRANSPORTS)[number];

/**
 * How reachable a connector is without further procurement. `endpoint_unpublished` means the
 * vendor publicly documents the capability but not a callable URL; those are declared so the
 * gap is visible, and must never be guessed into an `endpoint`.
 */
export const FINANCE_DATA_CONNECTOR_AVAILABILITY = [
  "public_endpoint",
  "subscription_required",
  "endpoint_unpublished",
  "internal_only",
] as const;

export type FinanceDataConnectorAvailability = (typeof FINANCE_DATA_CONNECTOR_AVAILABILITY)[number];

export type FinanceDataConnector = Readonly<{
  id: string;
  provider: string;
  domain: FinanceDataConnectorDomain;
  transport: FinanceDataConnectorTransport;
  /** Absent when the vendor has not published a callable URL. Never synthesize one. */
  endpoint?: string;
  /** Header that carries the credential, when the transport needs one. */
  authHeader?: string;
  /** Credential env key resolved through the single finance credential store. */
  credentialEnv?: string;
  providerRole: LcxOntologyFinanceDataProviderRole;
  sourceFamily: LcxOntologyFinanceDataSourceFamily;
  markets: readonly string[];
  updateFrequency: string;
  availability: FinanceDataConnectorAvailability;
  /** Ordered fallback paths used when the primary path is unavailable. */
  fallbackTransports: readonly FinanceDataConnectorTransport[];
  /** Public sources proving the declaration. At least one is required. */
  evidence: readonly string[];
}>;

/** Credential keys added for connector access; resolved by `finance-credential-env.ts`. */
export const FINANCE_CONNECTOR_CREDENTIAL_KEYS = [
  "HITHINK_FINANCE_API_KEY",
  "WIND_ALICE_API_KEY",
  "EASTMONEY_MIAOXIANG_API_KEY",
  "JINMEN_MCP_API_KEY",
  "FACTSET_MCP_API_KEY",
  "SP_GLOBAL_MCP_API_KEY",
  "LSEG_MCP_API_KEY",
  "PITCHBOOK_MCP_API_KEY",
  "MORNINGSTAR_MCP_API_KEY",
  "MOODYS_MCP_API_KEY",
  "DALOOPA_MCP_API_KEY",
] as const;

export type FinanceConnectorCredentialKey = (typeof FINANCE_CONNECTOR_CREDENTIAL_KEYS)[number];

const HITHINK_EVIDENCE = [
  "https://github.com/HiThink-Tech/Financial-API",
  "https://fuyao.aicubes.cn/docs/",
  "https://fuyao.aicubes.cn/docs/api-reference/overview/",
] as const;

const ANTHROPIC_EVIDENCE = [
  "https://github.com/anthropics/financial-services",
  "https://modelcontextprotocol.io/",
] as const;

const HITHINK_FALLBACK: readonly FinanceDataConnectorTransport[] = ["rest", "browser"];
const NO_FALLBACK: readonly FinanceDataConnectorTransport[] = [];

/**
 * The declared connector surface. Endpoints here are transcribed from vendor documentation;
 * anything the vendor has not published stays `endpoint: undefined` and is reported as a gap
 * rather than invented.
 */
export const FINANCE_DATA_CONNECTORS: readonly FinanceDataConnector[] = [
  // ── 同花顺 Financial-API: hosted MCP sharded by domain + REST + CLI/Skill, one API key.
  {
    id: "hithink_a_share_mcp",
    provider: "hithink",
    domain: "a_share",
    transport: "mcp_remote",
    endpoint: "https://fuyao.aicubes.cn/mcp/a-share",
    authHeader: "X-api-key",
    credentialEnv: "HITHINK_FINANCE_API_KEY",
    providerRole: "primary_market_data",
    sourceFamily: "market_data_api",
    markets: ["cn_a_share"],
    updateFrequency: "intraday_snapshot",
    availability: "public_endpoint",
    fallbackTransports: HITHINK_FALLBACK,
    evidence: HITHINK_EVIDENCE,
  },
  {
    id: "hithink_a_share_index_mcp",
    provider: "hithink",
    domain: "a_share_index",
    transport: "mcp_remote",
    endpoint: "https://fuyao.aicubes.cn/mcp/a-share-index",
    authHeader: "X-api-key",
    credentialEnv: "HITHINK_FINANCE_API_KEY",
    providerRole: "primary_market_data",
    sourceFamily: "market_data_api",
    markets: ["cn_a_share"],
    updateFrequency: "intraday_snapshot",
    availability: "public_endpoint",
    fallbackTransports: HITHINK_FALLBACK,
    evidence: HITHINK_EVIDENCE,
  },
  {
    id: "hithink_meta_mcp",
    provider: "hithink",
    domain: "meta",
    transport: "mcp_remote",
    endpoint: "https://fuyao.aicubes.cn/mcp/meta",
    authHeader: "X-api-key",
    credentialEnv: "HITHINK_FINANCE_API_KEY",
    providerRole: "official_or_issuer_reference",
    sourceFamily: "fundamentals_api",
    markets: ["cn_a_share"],
    updateFrequency: "daily",
    availability: "public_endpoint",
    fallbackTransports: HITHINK_FALLBACK,
    evidence: HITHINK_EVIDENCE,
  },
  {
    id: "hithink_fund_mcp",
    provider: "hithink",
    domain: "fund",
    transport: "mcp_remote",
    endpoint: "https://fuyao.aicubes.cn/mcp/fund",
    authHeader: "X-api-key",
    credentialEnv: "HITHINK_FINANCE_API_KEY",
    providerRole: "primary_market_data",
    sourceFamily: "market_data_api",
    markets: ["cn_mutual_fund"],
    updateFrequency: "daily",
    availability: "public_endpoint",
    fallbackTransports: HITHINK_FALLBACK,
    evidence: HITHINK_EVIDENCE,
  },
  {
    id: "hithink_futures_mcp",
    provider: "hithink",
    domain: "futures",
    transport: "mcp_remote",
    endpoint: "https://fuyao.aicubes.cn/mcp/futures",
    authHeader: "X-api-key",
    credentialEnv: "HITHINK_FINANCE_API_KEY",
    providerRole: "primary_market_data",
    sourceFamily: "market_data_api",
    markets: ["cn_futures"],
    updateFrequency: "intraday_snapshot",
    availability: "public_endpoint",
    fallbackTransports: HITHINK_FALLBACK,
    evidence: HITHINK_EVIDENCE,
  },
  {
    id: "hithink_options_mcp",
    provider: "hithink",
    domain: "options",
    transport: "mcp_remote",
    endpoint: "https://fuyao.aicubes.cn/mcp/options",
    authHeader: "X-api-key",
    credentialEnv: "HITHINK_FINANCE_API_KEY",
    providerRole: "primary_market_data",
    sourceFamily: "market_data_api",
    markets: ["cn_options"],
    updateFrequency: "intraday_snapshot",
    availability: "public_endpoint",
    fallbackTransports: HITHINK_FALLBACK,
    evidence: HITHINK_EVIDENCE,
  },
  {
    id: "hithink_rest_snapshot",
    provider: "hithink",
    domain: "a_share",
    transport: "rest",
    endpoint: "https://fuyao.aicubes.cn/api/a-share/prices/snapshot",
    authHeader: "X-api-key",
    credentialEnv: "HITHINK_FINANCE_API_KEY",
    providerRole: "primary_market_data",
    sourceFamily: "market_data_api",
    markets: ["cn_a_share"],
    updateFrequency: "intraday_snapshot",
    availability: "public_endpoint",
    fallbackTransports: ["browser"],
    evidence: HITHINK_EVIDENCE,
  },
  {
    id: "hithink_skill",
    provider: "hithink",
    domain: "a_share",
    transport: "sdk",
    credentialEnv: "HITHINK_FINANCE_API_KEY",
    providerRole: "primary_market_data",
    sourceFamily: "market_data_api",
    markets: ["cn_a_share"],
    updateFrequency: "intraday_snapshot",
    availability: "public_endpoint",
    fallbackTransports: ["rest", "browser"],
    evidence: [
      "https://github.com/HiThink-Tech/Financial-API",
      "https://www.skillhub.cn/skills/hithink-finance",
    ],
  },

  // ── 万得 AIFin Market: MCP + Skill + API, subscription gated, URL not published.
  {
    id: "wind_alice_mcp",
    provider: "wind",
    domain: "a_share",
    transport: "mcp_remote",
    credentialEnv: "WIND_ALICE_API_KEY",
    providerRole: "primary_market_data",
    sourceFamily: "market_data_api",
    markets: ["cn_a_share", "cn_bond", "cn_fund", "macro_cn"],
    updateFrequency: "intraday_snapshot",
    availability: "endpoint_unpublished",
    fallbackTransports: ["rest", "browser"],
    evidence: ["https://market.windalice.com/"],
  },
  {
    id: "wind_alice_skill",
    provider: "wind",
    domain: "a_share",
    transport: "sdk",
    credentialEnv: "WIND_ALICE_API_KEY",
    providerRole: "primary_market_data",
    sourceFamily: "market_data_api",
    markets: ["cn_a_share"],
    updateFrequency: "daily",
    availability: "subscription_required",
    fallbackTransports: ["browser"],
    evidence: ["https://market.windalice.com/"],
  },

  // ── 东方财富妙想 Skills / 进门 MCP: capability public, callable URL not published.
  {
    id: "eastmoney_miaoxiang_skills",
    provider: "eastmoney",
    domain: "news",
    transport: "sdk",
    credentialEnv: "EASTMONEY_MIAOXIANG_API_KEY",
    providerRole: "cross_check_market_data",
    sourceFamily: "market_data_api",
    markets: ["cn_a_share"],
    updateFrequency: "realtime",
    availability: "endpoint_unpublished",
    fallbackTransports: ["browser"],
    evidence: ["https://marketing.dfcfs.com/views/finskillshub/index"],
  },
  {
    id: "jinmen_mcp_gateway",
    provider: "jinmen",
    domain: "news",
    transport: "mcp_remote",
    credentialEnv: "JINMEN_MCP_API_KEY",
    providerRole: "cross_check_market_data",
    sourceFamily: "market_data_api",
    markets: ["cn_a_share", "hk", "us"],
    updateFrequency: "realtime",
    availability: "endpoint_unpublished",
    fallbackTransports: ["browser"],
    evidence: ["https://www.economicnews.cn/2026/09/10/10992.html"],
  },

  // ── Anthropic financial-services connector surface: each data vendor runs its own MCP.
  {
    id: "factset_mcp",
    provider: "factset",
    domain: "global_equity",
    transport: "mcp_remote",
    endpoint: "https://mcp.factset.com/mcp",
    credentialEnv: "FACTSET_MCP_API_KEY",
    providerRole: "primary_market_data",
    sourceFamily: "market_data_api",
    markets: ["us", "global"],
    updateFrequency: "intraday_snapshot",
    availability: "subscription_required",
    fallbackTransports: NO_FALLBACK,
    evidence: ANTHROPIC_EVIDENCE,
  },
  {
    id: "sp_global_mcp",
    provider: "sp_global",
    domain: "global_equity",
    transport: "mcp_remote",
    endpoint: "https://kfinance.kensho.com/integrations/mcp",
    credentialEnv: "SP_GLOBAL_MCP_API_KEY",
    providerRole: "cross_check_market_data",
    sourceFamily: "fundamentals_api",
    markets: ["us", "global"],
    updateFrequency: "daily",
    availability: "subscription_required",
    fallbackTransports: NO_FALLBACK,
    evidence: ANTHROPIC_EVIDENCE,
  },
  {
    id: "lseg_mcp",
    provider: "lseg",
    domain: "global_equity",
    transport: "mcp_remote",
    endpoint: "https://api.analytics.lseg.com/lfa/mcp",
    credentialEnv: "LSEG_MCP_API_KEY",
    providerRole: "cross_check_market_data",
    sourceFamily: "market_data_api",
    markets: ["global"],
    updateFrequency: "intraday_snapshot",
    availability: "subscription_required",
    fallbackTransports: NO_FALLBACK,
    evidence: ANTHROPIC_EVIDENCE,
  },
  {
    id: "pitchbook_mcp",
    provider: "pitchbook",
    domain: "filings",
    transport: "mcp_remote",
    endpoint: "https://premium.mcp.pitchbook.com/mcp",
    credentialEnv: "PITCHBOOK_MCP_API_KEY",
    providerRole: "official_or_issuer_reference",
    sourceFamily: "fundamentals_api",
    markets: ["private_markets"],
    updateFrequency: "daily",
    availability: "subscription_required",
    fallbackTransports: NO_FALLBACK,
    evidence: ANTHROPIC_EVIDENCE,
  },
  {
    id: "morningstar_mcp",
    provider: "morningstar",
    domain: "fund",
    transport: "mcp_remote",
    endpoint: "https://mcp.morningstar.com/mcp",
    credentialEnv: "MORNINGSTAR_MCP_API_KEY",
    providerRole: "cross_check_market_data",
    sourceFamily: "fundamentals_api",
    markets: ["global_funds"],
    updateFrequency: "daily",
    availability: "subscription_required",
    fallbackTransports: NO_FALLBACK,
    evidence: ANTHROPIC_EVIDENCE,
  },
  {
    id: "moodys_mcp",
    provider: "moodys",
    domain: "macro",
    transport: "mcp_remote",
    endpoint: "https://api.moodys.com/genai-ready-data/m1/mcp",
    credentialEnv: "MOODYS_MCP_API_KEY",
    providerRole: "official_or_issuer_reference",
    sourceFamily: "fundamentals_api",
    markets: ["global"],
    updateFrequency: "daily",
    availability: "subscription_required",
    fallbackTransports: NO_FALLBACK,
    evidence: ANTHROPIC_EVIDENCE,
  },
  {
    id: "daloopa_mcp",
    provider: "daloopa",
    domain: "filings",
    transport: "mcp_remote",
    endpoint: "https://mcp.daloopa.com/server/mcp",
    credentialEnv: "DALOOPA_MCP_API_KEY",
    providerRole: "official_or_issuer_reference",
    sourceFamily: "fundamentals_api",
    markets: ["us"],
    updateFrequency: "daily",
    availability: "subscription_required",
    fallbackTransports: NO_FALLBACK,
    evidence: ANTHROPIC_EVIDENCE,
  },

  // ── Free, no-procurement references. These are the only connectors usable without a contract.
  {
    id: "sec_edgar_rest",
    provider: "sec_edgar",
    domain: "filings",
    transport: "rest",
    endpoint: "https://data.sec.gov/submissions",
    providerRole: "official_or_issuer_reference",
    sourceFamily: "official_filing",
    markets: ["us"],
    updateFrequency: "event_driven",
    availability: "public_endpoint",
    fallbackTransports: ["browser"],
    evidence: ["https://www.sec.gov/edgar/sec-api-documentation"],
  },
  {
    id: "fred_rest",
    provider: "fred",
    domain: "macro",
    transport: "rest",
    endpoint: "https://api.stlouisfed.org/fred/series/observations",
    credentialEnv: "FRED_API_KEY",
    providerRole: "official_or_issuer_reference",
    sourceFamily: "official_macro_data",
    markets: ["us", "global"],
    updateFrequency: "release_driven",
    availability: "public_endpoint",
    fallbackTransports: ["browser"],
    evidence: ["https://fred.stlouisfed.org/docs/api/fred/"],
  },
] as const;

export type FinanceDataConnectorFilter = Readonly<{
  domain?: FinanceDataConnectorDomain;
  transport?: FinanceDataConnectorTransport;
  provider?: string;
  availability?: FinanceDataConnectorAvailability;
}>;

export function listFinanceDataConnectors(
  filter: FinanceDataConnectorFilter = {},
): FinanceDataConnector[] {
  return FINANCE_DATA_CONNECTORS.filter((connector) => {
    if (filter.domain && connector.domain !== filter.domain) {
      return false;
    }
    if (filter.transport && connector.transport !== filter.transport) {
      return false;
    }
    if (filter.provider && connector.provider !== filter.provider) {
      return false;
    }
    if (filter.availability && connector.availability !== filter.availability) {
      return false;
    }
    return true;
  });
}

export function findFinanceDataConnector(id: string): FinanceDataConnector | undefined {
  const wanted = id.trim();
  return FINANCE_DATA_CONNECTORS.find((connector) => connector.id === wanted);
}

export type FinanceCredentialStatus = "present" | "missing" | "not_required";

function readCredential(
  connector: FinanceDataConnector,
  env: NodeJS.ProcessEnv,
): FinanceCredentialStatus {
  if (!connector.credentialEnv) {
    return "not_required";
  }
  const raw = env[connector.credentialEnv];
  // Mirrors the finance credential store: an explicitly empty value disables the credential.
  return typeof raw === "string" && raw.trim().length > 0 ? "present" : "missing";
}

export type FinanceConnectorRoute = Readonly<{
  connectorId: string;
  provider: string;
  domain: FinanceDataConnectorDomain;
  transport: FinanceDataConnectorTransport;
  endpoint?: string;
  authHeader?: string;
  credentialEnv?: string;
  credentialStatus: FinanceCredentialStatus;
  callable: boolean;
  blockedReason?: string;
  fallbackTransports: readonly FinanceDataConnectorTransport[];
}>;

/**
 * Route one domain to the best usable connector. Preference order follows the transport list:
 * MCP first, then REST, then SDK, and `browser` only as a declared fallback — never as a default.
 */
export function resolveFinanceDataConnectorRoute(
  domain: FinanceDataConnectorDomain,
  env: NodeJS.ProcessEnv = process.env,
): FinanceConnectorRoute | undefined {
  const candidates = listFinanceDataConnectors({ domain })
    .slice()
    .toSorted((a, b) => {
      const rank = (c: FinanceDataConnector) =>
        FINANCE_DATA_CONNECTOR_TRANSPORTS.indexOf(c.transport);
      return rank(a) - rank(b);
    });
  for (const connector of candidates) {
    const credentialStatus = readCredential(connector, env);
    const hasEndpoint = typeof connector.endpoint === "string" && connector.endpoint.length > 0;
    const blockedReason = !hasEndpoint
      ? "endpoint_not_published"
      : credentialStatus === "missing"
        ? "credential_missing"
        : undefined;
    const route: FinanceConnectorRoute = {
      connectorId: connector.id,
      provider: connector.provider,
      domain: connector.domain,
      transport: connector.transport,
      endpoint: connector.endpoint,
      authHeader: connector.authHeader,
      credentialEnv: connector.credentialEnv,
      credentialStatus,
      callable: blockedReason === undefined,
      blockedReason,
      fallbackTransports: connector.fallbackTransports,
    };
    if (route.callable) {
      return route;
    }
  }
  const first = candidates[0];
  if (!first) {
    return undefined;
  }
  return {
    connectorId: first.id,
    provider: first.provider,
    domain: first.domain,
    transport: first.transport,
    endpoint: first.endpoint,
    authHeader: first.authHeader,
    credentialEnv: first.credentialEnv,
    credentialStatus: readCredential(first, env),
    callable: false,
    blockedReason:
      typeof first.endpoint === "string" && first.endpoint.length > 0
        ? "credential_missing"
        : "endpoint_not_published",
    fallbackTransports: first.fallbackTransports,
  };
}

export type FinanceDataConnectorDomainReport = Readonly<{
  domain: FinanceDataConnectorDomain;
  connectorCount: number;
  route?: FinanceConnectorRoute;
  transportsAvailable: readonly FinanceDataConnectorTransport[];
  gaps: readonly string[];
}>;

export type FinanceDataConnectorInspection = Readonly<{
  schemaVersion: string;
  boundary: "finance_data_connectors_declaration_only";
  connectorCount: number;
  domains: readonly FinanceDataConnectorDomainReport[];
  domainsWithoutCallableRoute: readonly FinanceDataConnectorDomain[];
  transportsInUse: readonly FinanceDataConnectorTransport[];
  credentialKeys: readonly string[];
  routingPolicy: string;
  riskBoundaries: readonly string[];
  notTouched: readonly string[];
}>;

export function inspectFinanceDataConnectors(
  env: NodeJS.ProcessEnv = process.env,
): FinanceDataConnectorInspection {
  const domains = FINANCE_DATA_CONNECTOR_DOMAINS.map<FinanceDataConnectorDomainReport>((domain) => {
    const connectors = listFinanceDataConnectors({ domain });
    const route = resolveFinanceDataConnectorRoute(domain, env);
    const gaps: string[] = [];
    if (connectors.length === 0) {
      gaps.push("no_connector_declared");
    }
    if (!route) {
      gaps.push("no_route");
    } else if (!route.callable) {
      gaps.push(route.blockedReason ?? "route_blocked");
    }
    const published = connectors.some(
      (connector) => typeof connector.endpoint === "string" && connector.endpoint.length > 0,
    );
    if (!published) {
      gaps.push("no_published_endpoint");
    }
    return {
      domain,
      connectorCount: connectors.length,
      route,
      transportsAvailable: [
        ...new Set(connectors.map((connector) => connector.transport)),
      ].toSorted(),
      gaps: [...new Set(gaps)].toSorted(),
    };
  });

  return {
    schemaVersion: FINANCE_DATA_CONNECTOR_SCHEMA_VERSION,
    boundary: "finance_data_connectors_declaration_only",
    connectorCount: FINANCE_DATA_CONNECTORS.length,
    domains,
    domainsWithoutCallableRoute: domains
      .filter((entry) => !entry.route || !entry.route.callable)
      .map((entry) => entry.domain),
    transportsInUse: [
      ...new Set(FINANCE_DATA_CONNECTORS.map((connector) => connector.transport)),
    ].toSorted(),
    credentialKeys: [...FINANCE_CONNECTOR_CREDENTIAL_KEYS].toSorted(),
    routingPolicy:
      "Prefer mcp_remote, then rest, then sdk; use browser only as a declared fallback for sources with no API. A connector without a published endpoint is reported as a gap, never guessed.",
    riskBoundaries: [
      "declaration_only",
      "research_only",
      "no_trade_advice",
      "no_execution_authority",
      "no_endpoint_invention",
      "cite_every_number_or_mark_unsourced",
    ],
    notTouched: [
      "provider_config",
      "external_channel_sender",
      "protected_memory",
      "trading_execution",
    ],
  };
}
