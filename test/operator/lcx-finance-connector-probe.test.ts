/**
 * Tests for the connector probe.
 *
 * The probe's whole value is its verdict: "the host is dead" and "the host is real but gated" are
 * opposite facts about a vendor, and a probe that reported them the same way would make the
 * registry no more trustworthy than the documentation it replaces. These tests pin that distinction
 * without touching the network.
 */
import { describe, expect, it } from "vitest";
import {
  buildProbeSummary,
  classifyProbeResult,
  probeConnector,
  PROBE_VERDICTS,
  type ProbeResult,
} from "../../scripts/operator/lcx-finance-connector-probe.ts";

describe("classifyProbeResult", () => {
  it("treats 401 and 403 as a real-but-gated endpoint, not a dead one", () => {
    expect(classifyProbeResult({ status: 401 })).toBe("auth_required");
    expect(classifyProbeResult({ status: 403 })).toBe("auth_required");
  });

  it("reads a vendor business envelope hidden inside HTTP 200 as gated", () => {
    // Observed live from the Hithink REST endpoint: HTTP 200, body `code:2003 Missing X-api-key`.
    expect(
      classifyProbeResult({
        status: 200,
        businessError: { code: 2003, message: "Missing X-api-key" },
      }),
    ).toBe("auth_required");
  });

  it("separates DNS/connection failure from an endpoint that answered", () => {
    expect(
      classifyProbeResult({ error: "fetch failed: getaddrinfo ENOTFOUND example.invalid" }),
    ).toBe("unreachable");
    expect(classifyProbeResult({ error: "operation timed out" })).toBe("unreachable");
    expect(classifyProbeResult({ status: 200 })).toBe("reachable");
  });

  it("does not silently upgrade an unexplained failure to a verdict of success", () => {
    expect(classifyProbeResult({ error: "unexpected payload shape" })).toBe("error");
  });
});

function makeResult(verdict: ProbeResult["verdict"]): ProbeResult {
  return {
    connectorId: `c-${verdict}`,
    provider: "p",
    domain: "d",
    transport: "rest",
    verdict,
  };
}

describe("buildProbeSummary", () => {
  it("counts every verdict, including the zeroes, so a gap is visible", () => {
    const summary = buildProbeSummary(
      [makeResult("reachable"), makeResult("auth_required")],
      "2026-09-20T00:00:00.000Z",
    );
    expect(summary.total).toBe(2);
    expect(summary.byVerdict.reachable).toBe(1);
    expect(summary.byVerdict.auth_required).toBe(1);
    expect(summary.byVerdict.unreachable).toBe(0);
    expect(Object.keys(summary.byVerdict).toSorted()).toEqual([...PROBE_VERDICTS].toSorted());
  });

  it("states that a reachable or gated endpoint is not proof of data", () => {
    const summary = buildProbeSummary([], "2026-09-20T00:00:00.000Z");
    expect(summary.boundary).toBe("finance_connector_probe_read_only");
    expect(summary.note).toMatch(/None of these imply data was retrieved/);
  });
});

describe("probeConnector", () => {
  it("reports a connector with no published endpoint as missing rather than probing it", async () => {
    const result = await probeConnector(
      {
        id: "wind_alice",
        provider: "wind",
        domain: "a_share",
        transport: "mcp_remote",
      } as never,
      1_000,
    );
    expect(result.verdict).toBe("endpoint_missing");
    expect(result.detail).toMatch(/no published endpoint/);
  });

  it("refuses to probe an undeclared transport instead of guessing one", async () => {
    const result = await probeConnector(
      {
        id: "browser_fallback",
        provider: "vendor",
        domain: "research",
        transport: "browser",
        endpoint: "https://example.com",
      } as never,
      1_000,
    );
    expect(result.verdict).toBe("endpoint_missing");
    expect(result.detail).toMatch(/no live probe/);
  });
});
