/**
 * Probe every declared finance data connector against its live endpoint.
 *
 * This exists because a declared endpoint is a claim, not a fact: vendors move URLs, expire
 * hosts, and change auth. The probe turns "documented" into "observed" without needing any
 * credential — a connector that answers with a business error still proves the endpoint is real.
 *
 * Read-only and side-effect free: it performs an MCP handshake or one GET per connector and never
 * places an order, writes a ledger, or moves a credential.
 */

import { FINANCE_DATA_CONNECTORS } from "../../src/agents/finance-data-connectors.js";
import { detectVendorBusinessError, openMcpSession } from "../../src/agents/finance-mcp-client.js";
import { callConnectorRest } from "../../src/agents/finance-rest-client.js";

export const PROBE_VERDICTS = [
  "reachable",
  "auth_required",
  "endpoint_missing",
  "unreachable",
  "error",
] as const;

export type ProbeVerdict = (typeof PROBE_VERDICTS)[number];

export type ProbeResult = {
  connectorId: string;
  provider: string;
  domain: string;
  transport: string;
  endpoint?: string;
  verdict: ProbeVerdict;
  detail?: string;
  serverInfo?: string;
};

/**
 * A credential complaint in any payload shape.
 *
 * Vendors disagree about how to say "you have no key": Hithink returns `Missing X-api-key` inside
 * a JSON envelope, FRED returns `Variable api_key is not set` inside XML. A probe that only
 * understood one of them would report a live, gated endpoint as a failure.
 */
const CREDENTIAL_COMPLAINT =
  /(?:missing|not\s+set|no|invalid|unset|required|unauthorized)[^a-z0-9]*\S*(?:api[_-]?key|apikey|access[_-]?token|token|credential)|(?:api[_-]?key|apikey|access[_-]?token|token|credential)[^a-z0-9]*\S*(?:is\s+)?(?:not\s+set|missing|invalid|unset|required)|unauthorized/u;

/**
 * Classify one probe outcome. A 401 or a vendor "missing key" envelope both mean the endpoint is
 * real and gated — which is the opposite of a dead host, and must not be reported the same way.
 *
 * An HTTP 4xx that is *not* a credential complaint is not success: it means this request never
 * reached a valid resource, so it is reported as an error rather than smuggled in as "reachable".
 */
export function classifyProbeResult(params: {
  status?: number;
  error?: string;
  businessError?: { code?: string | number; message?: string };
  bodyHint?: string;
}): ProbeVerdict {
  if (params.status === 401 || params.status === 403) {
    return "auth_required";
  }
  const message =
    `${params.error ?? ""} ${params.businessError?.message ?? ""} ${params.bodyHint ?? ""}`.toLowerCase();
  if (message.includes("401") || message.includes("403") || CREDENTIAL_COMPLAINT.test(message)) {
    return "auth_required";
  }
  if (
    message.includes("enotfound") ||
    message.includes("econnrefused") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("aborted") ||
    message.includes("fetch failed")
  ) {
    return "unreachable";
  }
  if (params.error || params.businessError) {
    return "error";
  }
  if (params.status !== undefined && params.status >= 400) {
    return "error";
  }
  return "reachable";
}

/**
 * Probe-only request paths, for connectors whose declared endpoint is a *base* rather than a
 * complete resource URL.
 *
 * This lives in the probe, not the registry: which path proves liveness is a fact about probing,
 * not about the connector. `CIK0000320193.json` is a stable, well-known issuer used here purely as
 * a liveness fixture — it is not a claim that this issuer is under research.
 */
const PROBE_PATHS: Record<string, string> = {
  sec_edgar_rest: "CIK0000320193.json",
};

export async function probeConnector(
  connector: (typeof FINANCE_DATA_CONNECTORS)[number],
  timeoutMs: number,
): Promise<ProbeResult> {
  const base = {
    connectorId: connector.id,
    provider: connector.provider,
    domain: connector.domain,
    transport: connector.transport,
    ...(connector.endpoint ? { endpoint: connector.endpoint } : {}),
  };

  if (!connector.endpoint) {
    return { ...base, verdict: "endpoint_missing", detail: "no published endpoint; not probed" };
  }

  if (connector.transport === "mcp_remote") {
    try {
      const session = await openMcpSession({
        endpoint: connector.endpoint,
        timeoutMs,
      });
      return {
        ...base,
        verdict: "reachable",
        ...(typeof session.serverInfo?.name === "string"
          ? { serverInfo: session.serverInfo.name }
          : {}),
        detail: `handshake ok (${session.protocolVersion})`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...base, verdict: classifyProbeResult({ error: message }), detail: message };
    }
  }

  if (connector.transport === "rest") {
    try {
      const response = await callConnectorRest({
        endpoint: connector.endpoint,
        ...(PROBE_PATHS[connector.id] ? { path: PROBE_PATHS[connector.id] } : {}),
        timeoutMs,
      });
      const businessError = detectVendorBusinessError([{ type: "text", text: response.body }]);
      const verdict = classifyProbeResult({
        status: response.status,
        businessError,
        bodyHint: response.body.slice(0, 500),
      });
      return {
        ...base,
        verdict,
        detail: businessError
          ? `HTTP ${response.status} with business error ${businessError.code ?? ""} ${businessError.message ?? ""}`.trim()
          : `HTTP ${response.status}${PROBE_PATHS[connector.id] ? ` (probed ${PROBE_PATHS[connector.id]})` : ""}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...base, verdict: classifyProbeResult({ error: message }), detail: message };
    }
  }

  return { ...base, verdict: "endpoint_missing", detail: "no live probe for this transport" };
}

export type ProbeSummary = {
  boundary: "finance_connector_probe_read_only";
  probedAt: string;
  total: number;
  byVerdict: Record<ProbeVerdict, number>;
  results: ProbeResult[];
  note: string;
};

export function buildProbeSummary(results: ProbeResult[], probedAt: string): ProbeSummary {
  return {
    boundary: "finance_connector_probe_read_only",
    probedAt,
    total: results.length,
    byVerdict: Object.fromEntries(
      PROBE_VERDICTS.map((verdict) => [
        verdict,
        results.filter((r) => r.verdict === verdict).length,
      ]),
    ) as Record<ProbeVerdict, number>,
    results,
    note: "reachable = the endpoint answered a well-formed request; auth_required = the endpoint is real but needs a credential; error = it answered, yet this request never reached a valid resource. None of these imply data was retrieved.",
  };
}

export async function probeAllConnectors(
  connectors: ReadonlyArray<(typeof FINANCE_DATA_CONNECTORS)[number]>,
  timeoutMs: number,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const connector of connectors) {
    results.push(await probeConnector(connector, timeoutMs));
  }
  return results;
}

export async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const results = await probeAllConnectors(FINANCE_DATA_CONNECTORS, 15_000);
  const summary = buildProbeSummary(results, new Date().toISOString());

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`connector probe @ ${summary.probedAt}`);
  for (const result of results) {
    console.log(
      `${result.verdict.padEnd(16)} ${result.connectorId.padEnd(30)} ${result.detail ?? ""}`,
    );
  }
  console.log(`\n${JSON.stringify(summary.byVerdict)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main().catch((error: unknown) => {
    console.error("probe failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
