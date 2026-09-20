import { describe, expect, it } from "vitest";
import { resolveCoreToolProfilePolicy } from "./tool-catalog.js";

describe("core tool profiles", () => {
  it("keeps web + browser tools reachable under a named profile", () => {
    // These used to declare `profiles: []`. An empty profile list is not
    // "available everywhere" — every profile policy is an allowlist, so the
    // moment a profile was set, web_search/web_fetch/browser silently vanished.
    for (const profile of ["minimal", "coding"]) {
      const allow = resolveCoreToolProfilePolicy(profile)?.allow ?? [];
      expect(allow).toContain("web_search");
      expect(allow).toContain("web_fetch");
    }
    expect(resolveCoreToolProfilePolicy("coding")?.allow ?? []).toContain("browser");
  });

  it("still keeps system-admin tools out of every named profile", () => {
    // Control group: widening the profiles above must not leak the tools that
    // let a model administer the gateway it is running inside.
    for (const profile of ["minimal", "coding", "messaging"]) {
      const allow = resolveCoreToolProfilePolicy(profile)?.allow ?? [];
      expect(allow).not.toContain("gateway");
      expect(allow).not.toContain("agents_list");
    }
  });

  it("treats `full` as unrestricted", () => {
    // `full` declares neither allow nor deny, which resolves to "no policy".
    expect(resolveCoreToolProfilePolicy("full")).toBeUndefined();
  });
});
