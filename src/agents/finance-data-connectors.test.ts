import { describe, expect, it } from "vitest";
import {
  FINANCE_DATA_CONNECTORS,
  FINANCE_DATA_CONNECTOR_DOMAINS,
  type FinanceDataConnector,
  findFinanceDataConnector,
  inspectFinanceDataConnectors,
  listFinanceDataConnectors,
  resolveFinanceDataConnectorRoute,
} from "./finance-data-connectors.js";

const HITHINK_KEY = "HITHINK_FINANCE_API_KEY";

describe("finance data connector registry", () => {
  it("declares every connector with a provider, domain, and at least one public source", () => {
    for (const connector of FINANCE_DATA_CONNECTORS) {
      expect(connector.provider.trim(), connector.id).not.toBe("");
      expect(FINANCE_DATA_CONNECTOR_DOMAINS).toContain(connector.domain);
      expect(connector.evidence.length, connector.id).toBeGreaterThan(0);
      for (const url of connector.evidence) {
        expect(url, connector.id).toMatch(/^https:\/\//);
      }
    }
  });

  it("never pairs an unpublished availability with a synthesized endpoint", () => {
    for (const connector of FINANCE_DATA_CONNECTORS) {
      if (connector.availability === "endpoint_unpublished") {
        expect(connector.endpoint, connector.id).toBeUndefined();
      }
      if (typeof connector.endpoint === "string") {
        expect(connector.endpoint, connector.id).toMatch(/^https:\/\//);
      }
    }
  });

  it("shards the hithink surface one endpoint per business domain", () => {
    const hithink = listFinanceDataConnectors({ provider: "hithink", transport: "mcp_remote" });
    expect(hithink.map((connector) => connector.domain).toSorted()).toEqual([
      "a_share",
      "a_share_index",
      "fund",
      "futures",
      "meta",
      "options",
    ]);
    expect(new Set(hithink.map((connector) => connector.endpoint)).size).toBe(6);
  });

  it("blocks a route when its credential is missing and opens it when present", () => {
    const blocked = resolveFinanceDataConnectorRoute("a_share", {});
    expect(blocked?.connectorId).toBe("hithink_a_share_mcp");
    expect(blocked?.callable).toBe(false);
    expect(blocked?.blockedReason).toBe("credential_missing");

    const ready = resolveFinanceDataConnectorRoute("a_share", { [HITHINK_KEY]: "k" });
    expect(ready?.connectorId).toBe("hithink_a_share_mcp");
    expect(ready?.transport).toBe("mcp_remote");
    expect(ready?.endpoint).toBe("https://fuyao.aicubes.cn/mcp/a-share");
    expect(ready?.callable).toBe(true);
  });

  it("treats an explicitly empty credential as disabled, not as configured", () => {
    const route = resolveFinanceDataConnectorRoute("a_share", { [HITHINK_KEY]: "  " });
    expect(route?.credentialStatus).toBe("missing");
    expect(route?.callable).toBe(false);
  });

  it("prefers mcp over rest for the same domain when both are usable", () => {
    const route = resolveFinanceDataConnectorRoute("a_share", { [HITHINK_KEY]: "k" });
    expect(route?.transport).toBe("mcp_remote");
    const rest: FinanceDataConnector | undefined =
      findFinanceDataConnector("hithink_rest_snapshot");
    expect(rest?.transport).toBe("rest");
    expect(route?.fallbackTransports).toContain("rest");
  });

  it("reports domains that still have no callable route instead of hiding them", () => {
    const inspection = inspectFinanceDataConnectors({});
    expect(inspection.domains).toHaveLength(FINANCE_DATA_CONNECTOR_DOMAINS.length);
    expect(inspection.domainsWithoutCallableRoute).toContain("global_equity");
    // SEC EDGAR needs no credential, so filings stays routable out of the box.
    expect(inspection.domainsWithoutCallableRoute).not.toContain("filings");
    expect(inspection.boundary).toBe("finance_data_connectors_declaration_only");
  });

  it("clears a domain once its credential is supplied", () => {
    const before = inspectFinanceDataConnectors({});
    const after = inspectFinanceDataConnectors({ [HITHINK_KEY]: "k" });
    expect(before.domainsWithoutCallableRoute).toContain("a_share");
    expect(after.domainsWithoutCallableRoute).not.toContain("a_share");
  });

  it("marks news providers without published endpoints as a visible gap", () => {
    const route = resolveFinanceDataConnectorRoute("news", {
      EASTMONEY_MIAOXIANG_API_KEY: "k",
      JINMEN_MCP_API_KEY: "k",
    });
    expect(route?.callable).toBe(false);
    expect(route?.blockedReason).toBe("endpoint_not_published");
  });
});
