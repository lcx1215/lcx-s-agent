import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";
import { isKnownCoreToolId } from "./tool-catalog.js";

describe("tool catalog parity", () => {
  it("declares every tool the assembly registers", () => {
    const registered = (createOpenClawTools() as Array<{ name?: string }>)
      .map((tool) => String(tool.name ?? ""))
      .filter(Boolean);

    // `isKnownCoreToolId` is what the profile allowlists are built from, and it is the trust
    // predicate the ACP path consults. A registered tool missing from the catalog is therefore
    // absent from every allowlist the catalog generates: `full` has no allowlist and lets it
    // through, while `minimal`, `coding` and `messaging` drop it — registered, never callable,
    // and nothing says so. Direction two (declared but not registered) is deliberately not
    // asserted here: those entries register conditionally on config, sandbox and provider, so
    // "declared and not assembled with no options" is a superset, not drift.
    const undeclared = registered.filter((name) => !isKnownCoreToolId(name));
    expect(undeclared).toEqual([]);
  });
});
