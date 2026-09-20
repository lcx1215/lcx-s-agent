import { describe, expect, it } from "vitest";
import { createFinanceDataConnectorTool } from "./finance-data-connector-inspect-tool.js";

type ToolResult = { content?: Array<{ type?: string; text?: string }> };

async function payload(result: unknown): Promise<Record<string, unknown>> {
  const first = (result as ToolResult).content?.[0];
  return JSON.parse(first?.text ?? "{}") as Record<string, unknown>;
}

describe("finance_data_connector tool", () => {
  it("inspects the declared connector surface without touching the network", async () => {
    const tool = createFinanceDataConnectorTool();
    const result = await tool.execute("call-1", { action: "inspect" });
    const body = await payload(result);
    expect(body.boundary).toBe("finance_data_connectors_declaration_only");
    expect(Array.isArray(body.domains)).toBe(true);
    expect(body.connectorCount).toBeGreaterThan(0);
  });

  it("rejects an unknown connector id", async () => {
    const tool = createFinanceDataConnectorTool();
    await expect(
      tool.execute("call-2", { action: "list_tools", connectorId: "nope" }),
    ).rejects.toThrow(/unknown connectorId/);
  });

  it("refuses to treat a non-MCP connector as a remote endpoint", async () => {
    const tool = createFinanceDataConnectorTool();
    await expect(
      tool.execute("call-3", { action: "list_tools", connectorId: "hithink_rest_snapshot" }),
    ).rejects.toThrow(/not a remote MCP endpoint/);
  });

  it("requires a tool name when calling a tool", async () => {
    const tool = createFinanceDataConnectorTool();
    await expect(
      tool.execute("call-4", { action: "call_tool", connectorId: "hithink_a_share_mcp" }),
    ).rejects.toThrow(/toolName is required/);
  });

  it("reports a missing credential instead of calling out with an empty header", async () => {
    const tool = createFinanceDataConnectorTool();
    await expect(
      tool.execute("call-5", { action: "list_tools", connectorId: "hithink_a_share_mcp" }),
    ).rejects.toThrow(/HITHINK_FINANCE_API_KEY/);
  });
});
