import { Type } from "@sinclair/typebox";
import { mapConnectorPayloadToObservation } from "../finance-connector-evidence.js";
import { resolveFinanceCredentialEnv } from "../finance-credential-env.js";
import {
  FINANCE_DATA_CONNECTOR_DOMAINS,
  findFinanceDataConnector,
  inspectFinanceDataConnectors,
  resolveFinanceDataConnectorRoute,
  type FinanceDataConnector,
} from "../finance-data-connectors.js";
import {
  detectVendorBusinessError,
  mcpCallTool,
  mcpListTools,
  openMcpSession,
} from "../finance-mcp-client.js";
import { callConnectorRest } from "../finance-rest-client.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

const FinanceDataConnectorSchema = Type.Object({
  action: stringEnum(["inspect", "list_tools", "call_tool", "call_rest", "observation"]),
  domain: Type.Optional(stringEnum(FINANCE_DATA_CONNECTOR_DOMAINS)),
  connectorId: Type.Optional(Type.String()),
  toolName: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  params: Type.Optional(
    Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
  ),
  arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  timeoutMs: Type.Optional(Type.Number()),
});

const DEFAULT_TIMEOUT_MS = 20_000;

function resolveConnector(params: {
  connectorId?: string;
  domain?: string;
  env: NodeJS.ProcessEnv;
}): FinanceDataConnector {
  if (params.connectorId?.trim()) {
    const connector = findFinanceDataConnector(params.connectorId.trim());
    if (!connector) {
      throw new ToolInputError(`unknown connectorId: ${params.connectorId.trim()}`);
    }
    return connector;
  }
  if (params.domain?.trim()) {
    const route = resolveFinanceDataConnectorRoute(
      params.domain.trim() as FinanceDataConnector["domain"],
      params.env,
    );
    if (!route) {
      throw new ToolInputError(`no connector declared for domain: ${params.domain.trim()}`);
    }
    if (!route.callable) {
      throw new ToolInputError(
        `connector ${route.connectorId} is not callable (${route.blockedReason}); fallback paths: ${route.fallbackTransports.join(", ") || "none"}`,
      );
    }
    const connector = findFinanceDataConnector(route.connectorId);
    if (!connector) {
      throw new ToolInputError(`unknown connectorId: ${route.connectorId}`);
    }
    return connector;
  }
  throw new ToolInputError("connectorId or domain is required for this action");
}

function buildHeaders(
  connector: FinanceDataConnector,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  if (!connector.authHeader || !connector.credentialEnv) {
    return {};
  }
  const value = env[connector.credentialEnv];
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError(`missing credential ${connector.credentialEnv} for ${connector.id}`);
  }
  return { [connector.authHeader]: value.trim() };
}

export function createFinanceDataConnectorTool(): AnyAgentTool {
  return {
    label: "Finance Data Connector",
    name: "finance_data_connector",
    description:
      "Inspect the declared finance data connector surface by business domain, list the MCP tools a connector exposes, or call one MCP tool. Declaration is single-sourced, domains are sharded, and connectors with no published endpoint are reported as gaps instead of being invented.",
    parameters: FinanceDataConnectorSchema,
    execute: async (_toolCallId, args) => {
      const params = args as {
        action: "inspect" | "list_tools" | "call_tool" | "call_rest" | "observation";
        domain?: string;
        connectorId?: string;
        toolName?: string;
        path?: string;
        params?: Record<string, string | number | boolean>;
        arguments?: Record<string, unknown>;
        timeoutMs?: number;
      };
      const env = resolveFinanceCredentialEnv(process.env);

      if (params.action === "inspect") {
        return jsonResult(inspectFinanceDataConnectors(env));
      }

      const connector = resolveConnector({
        ...(params.connectorId ? { connectorId: params.connectorId } : {}),
        ...(params.domain ? { domain: params.domain } : {}),
        env,
      });
      // Validate caller input before touching credentials or the network.
      const toolName = params.toolName?.trim() ?? "";
      if (params.action === "call_rest") {
        if (!connector.endpoint) {
          throw new ToolInputError(`connector ${connector.id} has no published endpoint`);
        }
        if (connector.transport !== "rest") {
          throw new ToolInputError(
            `connector ${connector.id} is ${connector.transport}; call_rest needs a rest connector (declared fallbacks: ${connector.fallbackTransports.join(", ") || "none"})`,
          );
        }
        const proxyUrl = env.LCX_FINANCE_HTTP_PROXY?.trim() || undefined;
        const response = await callConnectorRest({
          endpoint: connector.endpoint,
          ...(params.path ? { path: params.path } : {}),
          ...(params.params ? { params: params.params } : {}),
          headers: buildHeaders(connector, env),
          ...(proxyUrl ? { proxyUrl } : {}),
          timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        const businessError = detectVendorBusinessError([{ type: "text", text: response.body }]);
        return jsonResult({
          connectorId: connector.id,
          provider: connector.provider,
          domain: connector.domain,
          action: "call_rest",
          url: response.url,
          status: response.status,
          ...(businessError
            ? {
                businessError,
                warning:
                  "The endpoint answered with a vendor business error. Treat this as no data; do not quote any number from it.",
              }
            : {}),
          body:
            response.body.length > 2000
              ? `${response.body.slice(0, 2000)}...[truncated]`
              : response.body,
          evidenceContract: {
            requirement:
              "REST output is raw vendor payload. Before any number reaches a visible answer, wrap it through finance_data_gateway_snapshot with sourceTimestamp, fieldDefinition, and sourceUrlOrArtifact.",
            sourceFamily: connector.sourceFamily,
            providerRole: connector.providerRole,
          },
          boundary: "finance_data_connector_research_only",
          riskBoundaries: ["research_only", "no_trade_advice", "no_execution_authority"],
        });
      }

      if (params.action === "observation") {
        if (!connector.endpoint) {
          throw new ToolInputError(`connector ${connector.id} has no published endpoint`);
        }
        const proxyUrl = env.LCX_FINANCE_HTTP_PROXY?.trim() || undefined;
        let rawBody: string;
        let sourceUrl: string;

        if (connector.transport === "rest") {
          const response = await callConnectorRest({
            endpoint: connector.endpoint,
            ...(params.path ? { path: params.path } : {}),
            ...(params.params ? { params: params.params } : {}),
            headers: buildHeaders(connector, env),
            ...(proxyUrl ? { proxyUrl } : {}),
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          });
          rawBody = response.body;
          sourceUrl = response.url;
        } else if (connector.transport === "mcp_remote") {
          if (!toolName) {
            throw new ToolInputError("toolName is required to build an observation from MCP");
          }
          const session = await openMcpSession({
            endpoint: connector.endpoint,
            headers: buildHeaders(connector, env),
            ...(proxyUrl ? { proxyUrl } : {}),
            timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          });
          const called = await mcpCallTool(session, toolName, params.arguments ?? {});
          rawBody =
            called.content
              .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
              .join("\n") ?? "";
          sourceUrl = connector.endpoint;
        } else {
          throw new ToolInputError(
            `connector ${connector.id} is ${connector.transport}; observation needs rest or mcp_remote`,
          );
        }

        const businessError = detectVendorBusinessError([{ type: "text", text: rawBody }]);
        if (businessError) {
          return jsonResult({
            connectorId: connector.id,
            action: "observation",
            businessError,
            warning:
              "The connector answered with a vendor business error, so no evidence was mapped. Do not quote any number from this call.",
            boundary: "finance_data_connector_research_only",
          });
        }

        let payload: unknown;
        try {
          payload = JSON.parse(rawBody);
        } catch {
          throw new ToolInputError(`connector ${connector.id} returned a non-JSON payload`);
        }
        const mapped = mapConnectorPayloadToObservation({
          connectorId: connector.id,
          payload,
          sourceUrlOrArtifact: sourceUrl,
        });
        return jsonResult({
          connectorId: connector.id,
          provider: connector.provider,
          domain: connector.domain,
          action: "observation",
          sourceUrl,
          ...(mapped.observation ? { observation: mapped.observation } : {}),
          ...(mapped.unmappedReason ? { unmappedReason: mapped.unmappedReason } : {}),
          nextTool: mapped.observation
            ? "finance_data_gateway_snapshot"
            : "declare_a_field_mapping_for_this_connector",
          boundary: "finance_data_connector_research_only",
          riskBoundaries: ["research_only", "no_trade_advice", "no_execution_authority"],
        });
      }

      if (!connector.endpoint || connector.transport !== "mcp_remote") {
        throw new ToolInputError(
          `connector ${connector.id} is ${connector.transport}, not a remote MCP endpoint; use its declared fallback: ${connector.fallbackTransports.join(", ") || "none"}`,
        );
      }

      if (params.action === "call_tool" && !toolName) {
        throw new ToolInputError("toolName is required for call_tool");
      }

      const proxyUrl = env.LCX_FINANCE_HTTP_PROXY?.trim() || undefined;
      const session = await openMcpSession({
        endpoint: connector.endpoint,
        headers: buildHeaders(connector, env),
        ...(proxyUrl ? { proxyUrl } : {}),
        timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });

      if (params.action === "list_tools") {
        const tools = await mcpListTools(session);
        return jsonResult({
          connectorId: connector.id,
          provider: connector.provider,
          domain: connector.domain,
          endpoint: connector.endpoint,
          toolCount: tools.length,
          tools,
          boundary: "finance_data_connector_read_only",
        });
      }

      const result = await mcpCallTool(session, toolName, params.arguments ?? {});
      // Vendors routinely answer HTTP 200 with a business error envelope and `isError: false`
      // (observed: `{"code":2003,"message":"Missing X-api-key","data":null}`). Surfacing that is
      // mandatory here — a swallowed error would otherwise reach an answer as if it were data.
      const businessError = detectVendorBusinessError(result.content);
      return jsonResult({
        connectorId: connector.id,
        provider: connector.provider,
        domain: connector.domain,
        toolName,
        isError: result.isError,
        ...(businessError ? { businessError } : {}),
        ...(businessError
          ? {
              warning:
                "The transport reported success but the payload is a vendor business error. Treat this call as no data; do not quote any number from it.",
            }
          : {}),
        content: result.content,
        evidenceContract: {
          requirement:
            "MCP output is raw vendor payload. Before any number reaches a visible answer, wrap it through finance_data_gateway_snapshot with sourceTimestamp, fieldDefinition, and sourceUrlOrArtifact.",
          sourceFamily: connector.sourceFamily,
          providerRole: connector.providerRole,
        },
        boundary: "finance_data_connector_research_only",
        riskBoundaries: ["research_only", "no_trade_advice", "no_execution_authority"],
      });
    },
  };
}
