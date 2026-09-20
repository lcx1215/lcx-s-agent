import { describe, expect, it } from "vitest";
import { buildConnectorRestUrl } from "./finance-rest-client.js";

describe("finance rest client url building", () => {
  it("appends a relative path and query params to the declared endpoint", () => {
    const url = buildConnectorRestUrl("https://data.sec.gov/submissions", "CIK0000320193.json", {
      limit: 5,
    });
    expect(url).toBe("https://data.sec.gov/submissions/CIK0000320193.json?limit=5");
  });

  it("leaves the endpoint untouched when no path is given", () => {
    expect(buildConnectorRestUrl("https://api.stlouisfed.org/fred/series/observations")).toBe(
      "https://api.stlouisfed.org/fred/series/observations",
    );
  });

  it("rejects a path carrying a scheme so the registry stays the only endpoint source", () => {
    expect(() =>
      buildConnectorRestUrl("https://data.sec.gov/submissions", "https://evil.example"),
    ).toThrow(/must be relative/);
    expect(() =>
      buildConnectorRestUrl("https://data.sec.gov/submissions", "//evil.example"),
    ).toThrow(/must be relative/);
  });

  it("rejects a malformed declared endpoint", () => {
    expect(() => buildConnectorRestUrl("not-a-url")).toThrow();
  });
});
