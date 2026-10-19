import { describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";

// Exercise fallback semantics without depending on whether this checkout resolves package.json.
vi.mock("../version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../version.js")>();
  return {
    ...actual,
    resolveRuntimeServiceVersion: () =>
      actual.resolveRuntimeServiceVersion(process.env, undefined, "0.0.0"),
  };
});

async function withPresenceModule<T>(
  env: Record<string, string | undefined>,
  run: (module: typeof import("./system-presence.js")) => Promise<T> | T,
): Promise<T> {
  return withEnvAsync(env, async () => {
    vi.resetModules();
    const module = await import("./system-presence.js");
    return await run(module);
  });
}

describe("system-presence version fallback", () => {
  it("uses the service marker when runtime VERSION is the unusable fallback", async () => {
    await withPresenceModule(
      {
        OPENCLAW_SERVICE_VERSION: "2.4.6-service",
        npm_package_version: "1.0.0-package",
      },
      async ({ listSystemPresence }) => {
        const selfEntry = listSystemPresence().find((entry) => entry.reason === "self");
        expect(selfEntry?.version).toBe("2.4.6-service");
      },
    );
  });

  it("prefers OPENCLAW_VERSION over runtime VERSION", async () => {
    await withPresenceModule(
      {
        OPENCLAW_VERSION: "9.9.9-cli",
        OPENCLAW_SERVICE_VERSION: "2.4.6-service",
        npm_package_version: "1.0.0-package",
      },
      ({ listSystemPresence }) => {
        const selfEntry = listSystemPresence().find((entry) => entry.reason === "self");
        expect(selfEntry?.version).toBe("9.9.9-cli");
      },
    );
  });

  it("uses the package marker when runtime and service versions are unavailable", async () => {
    await withPresenceModule(
      {
        OPENCLAW_VERSION: " ",
        OPENCLAW_SERVICE_VERSION: "\t",
        npm_package_version: "1.0.0-package",
      },
      async ({ listSystemPresence }) => {
        const selfEntry = listSystemPresence().find((entry) => entry.reason === "self");
        expect(selfEntry?.version).toBe("1.0.0-package");
      },
    );
  });
});
